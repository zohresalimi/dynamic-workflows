/**
 * EPIC-06-S24 — the kill switch's scheduling contract, against real process
 * trees (KAR-06.7).
 *
 * Everything here needs processes that genuinely exist. The three claims are:
 *
 * **The ladder is climbed on the injected clock and each rung is an event.**
 * SIGTERM now, SIGKILL once the configurable grace has elapsed, verification
 * after a further two seconds — and `node.cancel.stage` rows carrying the pid
 * *and the pgid*, because the group is what was signalled and a timeline with
 * only the pid says nothing about what the signal reached.
 *
 * **A successful group kill leaves zombies, and zombies are not survivors.**
 * The verification filters `Z`, and the specs assert the unfiltered view is
 * non-empty at the same instant the filtered one is empty, so the filter cannot
 * pass vacuously. `test/integration/support/ps.ts` is a second implementation of
 * the query for exactly that reason.
 *
 * **A kill that did not take is an event.** With `killTree` injected to signal
 * nothing, the group survives all three rungs and the run says so with the
 * surviving pids — and still concludes the node, so nothing wedges.
 *
 * No fake timers: real children are alive throughout, and `vi.useFakeTimers()`
 * would stop their I/O ever arriving (docs/14-testing-strategy.md §8).
 *
 * Verifies: EPIC-06-S24 · AC1, AC6, AC7, AC8, AC9
 */

import { processStartTime } from '@DeFlow/adapters';
import {
  appendEvents,
  journalEffect,
  openLedger,
  readEffects,
  readProcesses,
  recordProcess,
} from '@DeFlow/ledger';
import { FAKE_AGENT_BIN, it, sleep, TestClock, waitFor } from '@DeFlow/testkit';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { cancelNode, KILL_VERIFY_MS, TERM_GRACE_MS } from '../../src/cancel.ts';
import {
  AUTH,
  CANCEL_RUN,
  draft,
  makeLoop,
  REPO_LOCK,
  seedRunningRun,
  T0,
} from './support/cancel-run.ts';
import { groupRows, killGroup, liveRows, waitForSigtermProof } from './support/ps.ts';

const groups: number[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  for (const pgid of groups.splice(0)) killGroup(pgid);
  children.splice(0);
  await sleep(50);
});

/** A detached shell that backgrounds two children: four processes, one group. */
async function startTree(): Promise<number> {
  return spawnDetached('/bin/sh', ['-c', 'sleep 300 & sleep 300 & sleep 300; wait'], {}, 4);
}

/** The KAR-04.6 fixture that installs a real `SIG_IGN` on SIGTERM, in the agent
 * *and* in the two children it backgrounds. Only SIGKILL ends this group. */
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
  // Three live rows is not three SIGTERM-proof rows; @see waitForSigtermProof.
  await waitForSigtermProof(pgid);
  return pgid;
}

async function spawnDetached(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  members: number,
): Promise<number> {
  const child = spawn(command, [...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
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

/** The `process` row the daemon writes beside `node.started` (KAR-05.9 AC6). */
function journalProcess(db: Parameters<typeof recordProcess>[0], pgid: number): void {
  recordProcess(db, {
    runId: CANCEL_RUN,
    nodeId: AUTH,
    attempt: 0,
    pid: pgid,
    pgid,
    startedAt: processStartTime(pgid),
    binarySha256: 'd'.repeat(64),
    worktree: null,
    spawnedAt: T0,
  });
}

/** The command the scheduler returns once `run.cancel.requested` is folded. */
function cancelCommandFor(db: Parameters<typeof makeLoop>[0], mode: 'cooperative' | 'forceful') {
  appendEvents(db, [draft('run.cancel.requested', { mode })]);
  const commands = makeLoop(db).tick(T0 + 1_000);
  const command = commands.find((one) => one.kind === 'CancelNode');
  if (command === undefined)
    throw new Error('decide() returned no CancelNode for a cancelling run');
  return command;
}

const stagesIn = (db: Parameters<typeof readProcesses>[0]): Record<string, unknown>[] =>
  db
    .prepare<{ payload: string }>(
      `SELECT payload FROM event WHERE run_id = ? AND kind = 'node.cancel.stage' ORDER BY seq`,
    )
    .all(CANCEL_RUN)
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);

const eventsOf = (
  db: Parameters<typeof readProcesses>[0],
  kind: string,
): Record<string, unknown>[] =>
  db
    .prepare<{ payload: string }>(
      `SELECT payload FROM event WHERE run_id = ? AND kind = ? ORDER BY seq`,
    )
    .all(CANCEL_RUN, kind)
    .map((row) => JSON.parse(row.payload) as Record<string, unknown>);

suite('EPIC-06-S24 scenario 2 — forceful cancel escalates and records every stage', () => {
  it('SIGTERMs the group, SIGKILLs it after the grace, and names pid and pgid (AC6)', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const pgid = await startSigtermIgnoringTree();
      journalProcess(db, pgid);

      const clock = new TestClock(T0);
      const command = cancelCommandFor(db, 'forceful');
      expect(command.mode).toBe('forceful');

      const running = cancelNode(command, { db, clock, epoch: 1 });

      // Rung 2 lands immediately, and is ignored — the group is untouched.
      await waitFor(() => stagesIn(db).some((stage) => stage.stage === 'sigterm'), {
        describe: 'the SIGTERM stage to be recorded',
      });
      await sleep(300);
      expect(liveRows(pgid).length).toBeGreaterThanOrEqual(3);

      // Rung 3, released by the injected clock rather than by five real seconds.
      await clock.advance(TERM_GRACE_MS);
      await waitFor(() => stagesIn(db).some((stage) => stage.stage === 'sigkill'), {
        describe: 'the SIGKILL stage to be recorded',
      });
      // The OS has done its part before the verification window is released;
      // the two-second wait is what production spends here.
      await waitFor(() => liveRows(pgid).length === 0, { describe: 'the group to go on SIGKILL' });
      await clock.advance(KILL_VERIFY_MS);

      const report = await running;

      expect(report.outcome).toBe('signalled');
      expect(report.survivors).toEqual([]);
      const rung = (stage: string, elapsedMs: unknown) => ({
        node: AUTH,
        attempt: 0,
        stage,
        mode: 'forceful',
        pid: pgid,
        pgid,
        elapsedMs,
      });
      // KAR-08.6 AC2: each rung carries the milliseconds the injected clock
      // says it took to reach it. Rungs 2 and 3 are exact — the grace *is* the
      // gap between them. Rung 4 is bounded rather than pinned: the group's
      // last member goes when the OS says so, and the verification returns on
      // whichever poll of the two-second window observes it, so an exact value
      // would be asserting on the reaper's timing rather than on the ladder's.
      expect(stagesIn(db)).toEqual([
        rung('sigterm', 0),
        rung('sigkill', TERM_GRACE_MS),
        rung('verified', expect.any(Number)),
      ]);
      const verified = stagesIn(db)[2]?.elapsedMs as number;
      expect(verified).toBeGreaterThanOrEqual(TERM_GRACE_MS);
      expect(verified).toBeLessThanOrEqual(TERM_GRACE_MS + KILL_VERIFY_MS);
      // Verified the way §11.2 says it must be: nothing non-`Z` is left. Any
      // row `ps` is still listing for this group is a zombie awaiting reaping,
      // and a `verified` rung was only claimed because those were excluded.
      // (That the exclusion is real is proved deterministically in
      // packages/adapters/src/kill-tree.test.ts — asserting a zombie is *still*
      // listed here would be a race against init, not a claim about the code.)
      expect(liveRows(pgid)).toEqual([]);
      expect(groupRows(pgid).every((row) => row.stat.includes('Z'))).toBe(true);
      expect(eventsOf(db, 'node.cancel.failed')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('AC7: the negative pid takes the grandchildren with it', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const pgid = await startTree();
      journalProcess(db, pgid);
      const before = liveRows(pgid);
      expect(before.length).toBeGreaterThanOrEqual(4);

      const clock = new TestClock(T0);
      const running = cancelNode(cancelCommandFor(db, 'forceful'), { db, clock, epoch: 1 });

      await waitFor(() => liveRows(pgid).length === 0, {
        describe: 'the whole tree, grandchildren included, to go on SIGTERM',
      });
      await clock.advance(TERM_GRACE_MS);
      await clock.advance(KILL_VERIFY_MS);
      const report = await running;

      // The regression guard: `process.kill(pid, …)` with a POSITIVE pid leaves
      // both grandchildren alive and reparented to init — measured in
      // packages/adapters/test/integration/process-group.test.ts. Only the
      // group form empties the group, which is what this asserts.
      expect(report.survivors).toEqual([]);
      expect(liveRows(pgid)).toEqual([]);
      // The SIGTERM was enough, so rung 3 was never climbed.
      expect(stagesIn(db).map((stage) => stage.stage)).toEqual(['sigterm', 'verified']);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-06-S24 scenario 5 — a kill that did not take is an event (AC8)', () => {
  it('names the surviving pids, concludes the node anyway, and does not wedge', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const pgid = await startTree();
      journalProcess(db, pgid);

      const clock = new TestClock(T0);
      const signalled: string[] = [];
      const running = cancelNode(cancelCommandFor(db, 'forceful'), {
        db,
        clock,
        epoch: 1,
        // Injected so the group genuinely survives all three rungs. Nothing
        // real survives SIGKILL, and the reporting path still has to work.
        killTree: (_pid: number, signal: NodeJS.Signals) => {
          signalled.push(signal);
        },
      });

      await waitFor(() => stagesIn(db).length >= 1, { describe: 'the first rung' });
      await clock.advance(TERM_GRACE_MS);
      await waitFor(() => stagesIn(db).length >= 2, { describe: 'the second rung' });
      await clock.advance(KILL_VERIFY_MS);
      const report = await running;

      expect(signalled).toEqual(['SIGTERM', 'SIGKILL']);
      expect(report.outcome).toBe('survived');
      expect(report.survivors.length).toBeGreaterThanOrEqual(4);

      const [failure] = eventsOf(db, 'node.cancel.failed');
      expect(failure).toMatchObject({ node: AUTH, attempt: 0, pid: pgid, pgid });
      expect((failure?.survivors as number[]).length).toBe(report.survivors.length);
      expect(failure?.survivors).toContain(pgid);
      // No 'verified' rung was claimed for a group that is still there.
      expect(stagesIn(db).map((stage) => stage.stage)).toEqual(['sigterm', 'sigkill']);

      // The run does not wedge: the node is terminal, so the next tick reclaims
      // its lock instead of leaving the repository locked for ever.
      const loop = makeLoop(db);
      loop.tick(T0 + 2_000);
      expect(loop.state().nodes[AUTH]?.status).toBe('cancelled');
      expect(loop.state().locks).toEqual({});
      // And it does not silently continue: the run is still cancelling, so
      // nothing is admitted in the freed slot.
      expect(loop.started()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-06-S24 scenario 6 — a cancelled node leaves no ambiguity behind (AC9)', () => {
  it('releases the lock and moves its in-flight effect rows to failed', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const pgid = await startTree();
      journalProcess(db, pgid);

      // An effect this attempt journalled and never finished — the row a later
      // daemon would otherwise inherit `pending` from a prior epoch and ask a
      // human to reconcile.
      const ikey = `${CANCEL_RUN}/${AUTH}/0/0`;
      journalEffect(
        db,
        {
          ikey,
          runId: CANCEL_RUN,
          nodeId: AUTH,
          attempt: 0,
          ordinal: 0,
          kind: 'agent',
          requestHash: `sha256-${'b'.repeat(64)}`,
          startedAt: T0,
        },
        draft(
          'effect.started',
          { ikey, kind: 'agent', requestHash: `sha256-${'b'.repeat(64)}` },
          { nodeId: AUTH, attempt: 0, ikey },
        ),
      );
      expect(readEffects(db, CANCEL_RUN).map((row) => row.state)).toEqual(['pending']);

      const clock = new TestClock(T0);
      const running = cancelNode(cancelCommandFor(db, 'forceful'), { db, clock, epoch: 1 });
      await waitFor(() => liveRows(pgid).length === 0, { describe: 'the tree to go' });
      await clock.advance(TERM_GRACE_MS);
      await clock.advance(KILL_VERIFY_MS);
      await running;

      // The row is terminal — no longer `pending`, so no future daemon inherits
      // it and asks a human to reconcile an effect nobody is confused about —
      // and what it carries is the NodeResult, not an invented failure reason.
      const [row] = readEffects(db, CANCEL_RUN);
      expect(row?.state).toBe('failed');
      expect(JSON.parse(row?.resultJson ?? 'null')).toEqual({ status: 'cancelled', by: 'user' });
      expect(eventsOf(db, 'effect.cancelled')).toEqual([
        { ikey, result: { status: 'cancelled', by: 'user' } },
      ]);
      expect(eventsOf(db, 'effect.failed')).toEqual([]);

      // The terminal record says who stopped it, which is what a board reads.
      expect(eventsOf(db, 'node.cancelled')).toEqual([
        { node: AUTH, attempt: 0, result: { status: 'cancelled', by: 'user' } },
      ]);

      // And the `process` row stops claiming a live process, so no future
      // reaper signals a pid that by then may belong to somebody else.
      expect(readProcesses(db).map((one) => one.state)).toEqual(['reaped']);

      const loop = makeLoop(db);
      loop.tick(T0 + 2_000);
      expect(loop.state().locks).toEqual({});
      expect(
        eventsOf(db, 'node.lock.released').filter((payload) => payload.key === REPO_LOCK),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-06-S25 — the pid-reuse guard applies to the kill switch too', () => {
  it('signals nothing when the recorded start time disagrees with the OS', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const pgid = await startTree();
      // The row says this pid started at a different instant: the OS has since
      // handed the number to somebody else's process.
      recordProcess(db, {
        runId: CANCEL_RUN,
        nodeId: AUTH,
        attempt: 0,
        pid: pgid,
        pgid,
        startedAt: 'Tue Jan  6 09:00:00 2026',
        binarySha256: 'd'.repeat(64),
        worktree: null,
        spawnedAt: T0,
      });

      const clock = new TestClock(T0);
      const signalled: string[] = [];
      const report = await cancelNode(cancelCommandFor(db, 'forceful'), {
        db,
        clock,
        epoch: 1,
        killTree: (_pid: number, signal: NodeJS.Signals) => {
          signalled.push(signal);
        },
      });

      expect(report.outcome).toBe('pid-reused');
      expect(signalled).toEqual([]);
      expect(stagesIn(db)).toEqual([]);
      // The unrelated process is still alive afterwards.
      expect(liveRows(pgid).length).toBeGreaterThanOrEqual(4);
      // The row is discarded rather than left for the next reaper to retry.
      expect(readProcesses(db).map((one) => one.state)).toEqual(['discarded']);
      // The node is still concluded, so the run does not wait for a process
      // nobody is allowed to signal.
      expect(eventsOf(db, 'node.cancelled')).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
