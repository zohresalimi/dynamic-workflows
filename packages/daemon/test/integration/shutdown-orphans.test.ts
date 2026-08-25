/**
 * KAR-27.10 — a daemon that exits does not orphan the processes it spawned.
 *
 * Observed 2026-08-25: killing the daemon left its agent child alive and
 * reparented to PID 1, still writing to a repository nobody was watching. The
 * mechanism to stop it already existed (`stopChildren`, over `sweepGroup`'s
 * ladder and the pid-reuse guard); what was missing was the three things this
 * file pins.
 *
 * **The ladder has to be allowed to finish.** Rung 2 is SIGTERM and rung 3 is
 * SIGKILL five seconds later, so a child that ignores SIGTERM only dies on the
 * far side of `TERM_GRACE_MS`. Any deadline the entrypoint puts on its own exit
 * has to be longer than that or the escalation never runs — which is exactly
 * how a child survives a shutdown that reported success. The arithmetic is
 * `../shutdown-deadline.test.ts`; what is here is the ladder actually emptying
 * a SIGTERM-proof group, and doing it for every child at once rather than one
 * ladder after another (`n` children must not cost `n` ladders of wall clock).
 *
 * **What could not be terminated is a ledger record, not a log line.** The
 * vocabulary is `run.kill_failed`, the one the kill switch already writes for
 * the same fact — a second spelling of "these pids outlived us" would be a
 * second thing every reader has to know about. The row is left `live` so the
 * next boot's reaper sees it too: a `discarded` row is invisible to the next
 * daemon, which is the opposite of AC2's whole point.
 *
 * **Nothing unattributable is signalled.** The pid-reuse guard is the reaper's
 * and the kill switch's, unchanged, and a row it cannot verify is dropped
 * rather than signalled.
 *
 * No fake timers: real children are alive throughout, and time moves through
 * the injected `Clock` (docs/14-testing-strategy.md §8).
 *
 * Verifies: EPIC-27-S45, EPIC-27-S46, EPIC-27-S47, EPIC-27-S48 · AC1–AC4
 */
import { processStartTime } from '@DeFlow/adapters';
import type { CancelStage, Db } from '@DeFlow/core';
import { openLedger, readProcesses, recordProcess } from '@DeFlow/ledger';
import { FAKE_AGENT_BIN, it, sleep, TestClock, waitFor } from '@DeFlow/testkit';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';
import { KILL_VERIFY_MS, TERM_GRACE_MS } from '../../src/cancel.ts';
import { stopChildren } from '../../src/shutdown.ts';
import { AUTH, CANCEL_RUN, ROUTER, seedRunningRun, T0 } from './support/cancel-run.ts';
import { groupRows, killGroup, liveRows, rowOf, waitForSigtermProof } from './support/ps.ts';

const groups: number[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
let booted: Booted | undefined;

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
  for (const pgid of groups.splice(0)) killGroup(pgid);
  children.splice(0);
  await sleep(50);
});

/** A `Random` that draws the middle of every backoff window. */
const steady = { next: (): number => 0.5 };

function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not read the bound port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

async function spawnDetached(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  members: number,
): Promise<number> {
  const child = spawn(command, [...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Mandatory: without it the grandchildren join this process's own group,
    // and the only group to signal would be the test runner's.
    detached: true,
    env: { ...process.env, ...env },
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const pgid = child.pid as number;
  groups.push(pgid);
  child.stdout.resume();
  child.stderr.resume();
  await waitFor(() => liveRows(pgid).length >= members, {
    describe: `the tree in pgid ${pgid} to have ${members} live members`,
  });
  return pgid;
}

/** A detached shell that backgrounds two children: four processes, one group. */
const startTree = (): Promise<number> =>
  spawnDetached('/bin/sh', ['-c', 'sleep 300 & sleep 300 & sleep 300; wait'], {}, 4);

/**
 * The KAR-04.6 fixture that installs a real `SIG_IGN` on SIGTERM, in the agent
 * *and* in the two children it backgrounds. Only SIGKILL ends this group — so
 * it is the only fixture that can tell a shutdown which ran the whole ladder
 * from one that exited during the grace and reported success.
 */
async function startSigtermIgnoringTree(): Promise<number> {
  const pgid = await spawnDetached(
    process.execPath,
    [FAKE_AGENT_BIN, '-p', 'hang', '--output-format', 'stream-json', '--verbose'],
    {
      DeFlow_FAKE_DIALECT: 'claude-stream-json',
      DeFlow_FAKE_SCENARIO: 'ignore-sigterm',
      DeFlow_FAKE_SEED: '42',
    },
    3,
  );
  await waitForSigtermProof(pgid);
  return pgid;
}

/** The `process` row the daemon writes beside `node.started` (KAR-05.9 AC6). */
function journalProcess(db: Db, pgid: number, nodeId: string = AUTH, startedAt?: string): void {
  recordProcess(db, {
    runId: CANCEL_RUN,
    nodeId,
    attempt: 0,
    pid: pgid,
    pgid,
    startedAt: startedAt ?? processStartTime(pgid),
    binarySha256: 'd'.repeat(64),
    worktree: null,
    spawnedAt: T0,
  });
}

const eventsOf = (db: Db, kind: string): Record<string, unknown>[] =>
  db
    .prepare<{ payload: string }>(
      `SELECT payload FROM event WHERE run_id = ? AND kind = ? ORDER BY seq`,
    )
    .all(CANCEL_RUN, kind)
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);

suite('EPIC-27-S45 — stopping the daemon stops its children (AC1)', () => {
  it('runs the whole ladder over a SIGTERM-proof tree and leaves nothing reparented', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const pgid = await startSigtermIgnoringTree();
      journalProcess(db, pgid);
      const before = liveRows(pgid).map((row) => row.pid);
      expect(before.length).toBeGreaterThanOrEqual(3);

      const clock = new TestClock(T0);
      const rungs: CancelStage[] = [];
      const running = stopChildren(db, {
        clock,
        epoch: 2,
        random: steady,
        onRung: (stage) => rungs.push(stage),
      });

      // Rung 2 lands and is ignored — this is the fixture earning its keep.
      await waitFor(() => rungs.includes('sigterm'), { describe: 'the SIGTERM rung' });
      await sleep(200);
      expect(liveRows(pgid).length).toBeGreaterThanOrEqual(3);

      // Only past the grace does the escalation run. A shutdown that exited
      // before this instant would have reported success over a live tree.
      await clock.advance(TERM_GRACE_MS);
      await waitFor(() => rungs.includes('sigkill'), { describe: 'the SIGKILL rung' });
      await waitFor(() => liveRows(pgid).length === 0, { describe: 'the group to empty' });
      await clock.advance(KILL_VERIFY_MS);

      const stopped = await running;
      expect(stopped.map((one) => one.outcome)).toEqual(['stopped']);
      expect(stopped[0]?.survivors).toEqual([]);

      // Nothing non-zombie is left, and no descendant was adopted by init and
      // carried on: every pid the tree had is gone or awaiting reaping.
      expect(liveRows(pgid)).toEqual([]);
      for (const row of groupRows(pgid)) expect(row.stat).toContain('Z');
      for (const pid of before) {
        const row = rowOf(pid);
        if (row !== undefined) expect(row.stat).toContain('Z');
      }
    } finally {
      db.close();
    }
  });

  it('sweeps every child at once, so two children cost one ladder and not two', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const first = await startTree();
      const second = await startTree();
      journalProcess(db, first, AUTH);
      journalProcess(db, second, ROUTER);

      const clock = new TestClock(T0);
      const rungs: CancelStage[] = [];
      const running = stopChildren(db, {
        clock,
        epoch: 2,
        random: steady,
        onRung: (stage) => rungs.push(stage),
      });

      // Both groups are on rung 2 **before** the grace elapses. Swept one
      // after the other, the second SIGTERM could not be sent until the first
      // ladder had finished sleeping, and this never becomes true.
      await waitFor(() => rungs.filter((stage) => stage === 'sigterm').length === 2, {
        describe: 'both groups to reach the SIGTERM rung before any grace elapses',
      });

      await waitFor(() => liveRows(first).length === 0 && liveRows(second).length === 0, {
        describe: 'both trees to go on SIGTERM',
      });
      await clock.advance(TERM_GRACE_MS + KILL_VERIFY_MS);

      const stopped = await running;
      expect(stopped).toHaveLength(2);
      expect(stopped.every((one) => one.outcome === 'stopped')).toBe(true);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-27-S46 — what could not be terminated is recorded before exit (AC2)', () => {
  it('names the survivors by pid, node and state in run.kill_failed', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const pgid = await startTree();
      journalProcess(db, pgid);

      const clock = new TestClock(T0);
      const signalled: NodeJS.Signals[] = [];
      const rungs: CancelStage[] = [];
      const running = stopChildren(db, {
        clock,
        epoch: 2,
        random: steady,
        // Injected so the group genuinely survives every rung. Nothing real
        // survives SIGKILL, and the reporting path still has to work.
        killTree: (_pid: number, signal: NodeJS.Signals) => {
          signalled.push(signal);
        },
        onRung: (stage) => rungs.push(stage),
      });

      await waitFor(() => rungs.includes('sigterm'), { describe: 'the SIGTERM rung' });
      await clock.advance(TERM_GRACE_MS);
      await waitFor(() => rungs.includes('sigkill'), { describe: 'the SIGKILL rung' });
      await clock.advance(KILL_VERIFY_MS);
      const stopped = await running;

      expect(signalled).toEqual(['SIGTERM', 'SIGKILL']);
      expect(stopped.map((one) => one.outcome)).toEqual(['survived']);

      // The record is the kill switch's own vocabulary, not a second spelling.
      const [failure] = eventsOf(db, 'run.kill_failed');
      expect(failure).toBeDefined();
      const survivors = failure?.survivors as {
        node: string;
        attempt: number;
        pid: number;
        pgid: number;
        stat: string;
      }[];
      expect(survivors.length).toBeGreaterThanOrEqual(4);
      expect(survivors.map((one) => one.pid)).toContain(pgid);
      for (const one of survivors) {
        expect(one).toMatchObject({ node: AUTH, attempt: 0, pgid });
        // The state is the reason: `D` says why SIGKILL did not land.
        expect(one.stat).toMatch(/^[A-Za-z]/);
        expect(one.stat).not.toContain('Z');
      }

      // And the row stays live, so the *next* daemon inherits the problem
      // rather than a silence. A `discarded` row is invisible to the reaper.
      expect(readProcesses(db).map((row) => row.state)).toEqual(['live']);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-27-S47 — a daemon that is SIGKILLed is covered by the next boot (AC3)', () => {
  it('attributes the survivor on the way in and reports what it did', async ({ tmp }) => {
    // A daemon that was SIGKILLed never ran a shutdown at all: its `process`
    // row is still `live` and its child is still running. That is the state
    // this seeds, without a first daemon, because the claim is about the
    // second one.
    const seed = openLedger(tmp);
    const pgid = await startTree();
    try {
      seedRunningRun(seed);
      journalProcess(seed, pgid);
    } finally {
      seed.close();
    }
    expect(liveRows(pgid)).toHaveLength(4);

    booted = await boot({ dataDir: tmp, port: await freePort(), dev: false });

    // Positively attributed — the recorded start time matched — and killed.
    expect(booted.reaped.map((one) => one.outcome)).toEqual(['reaped']);
    expect(booted.reaped[0]?.row.pid).toBe(pgid);
    await waitFor(() => liveRows(pgid).length === 0, {
      describe: 'the previous daemon’s tree to go on the way in',
    });

    // And reported: the run's own history says its node was still running when
    // this daemon started, rather than simply stopping.
    const reported = eventsOf(booted.db, 'node.progress').filter(
      (payload) => payload.phase === 'process.orphan-reaped',
    );
    expect(reported).toHaveLength(1);
    expect(reported[0]?.node).toBe(AUTH);
    expect(String(reported[0]?.message)).toContain(String(pgid));
  });
});

suite('EPIC-27-S48 — nothing unattributable is killed (AC4)', () => {
  it('leaves a recycled pid and an unjournalled tree alone, and signals neither', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      // Recorded, but the start time disagrees: the pid is ours, the process
      // is somebody else's.
      const recycled = await startTree();
      journalProcess(db, recycled, AUTH, 'a start time this process never had');
      // Never recorded at all, and it looks exactly like the other one.
      const stranger = await startTree();

      const clock = new TestClock(T0);
      const signalled: number[] = [];
      const stopped = await stopChildren(db, {
        clock,
        epoch: 2,
        random: steady,
        killTree: (pid: number) => {
          signalled.push(pid);
        },
      });

      expect(signalled).toEqual([]);
      expect(stopped.map((one) => one.outcome)).toEqual(['pid-reused']);
      expect(liveRows(recycled)).toHaveLength(4);
      expect(liveRows(stranger)).toHaveLength(4);
      expect(eventsOf(db, 'run.kill_failed')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
