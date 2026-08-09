/**
 * KAR-08.6 — one control that stops every child process in a run, and proves it.
 *
 * Everything here needs processes that genuinely exist, because every claim is
 * about what the operating system did rather than about what the code intended.
 * Four of them, and each was expensive to learn:
 *
 * **The ladder does not stop at a polite exit.** An agent that answers
 * `session/cancel` flushes its tail and exits *itself*, leaving whatever it
 * backgrounded running and reparented to init. So the kill switch always goes
 * on to verify the group, which is the difference between "the process I knew
 * about exited" and "stopped" (§9.4, EPIC-08-S26).
 *
 * **A successful group SIGKILL still lists its members.** In state `Z`, already
 * dead, waiting for init to reap them. The first run of this fixture concluded
 * the kill had failed; it had not. The spec asserts *both* halves at the same
 * instant — the naive count is non-zero, the filtered one is zero — so the
 * filter cannot pass vacuously (EPIC-08-S27).
 *
 * **A positive pid is not a simplification.** `process.kill(pid, …)` kills the
 * shell and leaves both grandchildren running with `ppid = 1`, still holding the
 * original pgid. Only the negative form empties the group (EPIC-08-S28).
 *
 * **A kill that did not take is an event.** `run.kill_failed` carries the
 * surviving pids *and their states*, because "pid 4244 survived in state `D`"
 * tells an operator why SIGKILL did not land and "pid 4244 survived" invites a
 * bug report (EPIC-08-S29).
 *
 * No fake timers: real children are alive throughout, and `vi.useFakeTimers()`
 * would stop their I/O ever arriving (docs/14-testing-strategy.md §8). Time
 * moves through the injected `Clock` (AC7).
 *
 * Verifies: EPIC-08-S26, EPIC-08-S27, EPIC-08-S28, EPIC-08-S29 · AC2, AC3, AC4,
 * AC5, AC6, AC7 · test plan #1–#6
 */
import { processStartTime } from '@DeFlow/adapters';
import { openLedger, readProcesses, recordProcess } from '@DeFlow/ledger';
import { FAKE_AGENT_BIN, it, sleep, TestClock, waitFor } from '@DeFlow/testkit';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { KILL_VERIFY_MS, TERM_GRACE_MS } from '../../src/cancel.ts';
import { killRun } from '../../src/kill-switch.ts';
import { AUTH, CANCEL_RUN, seedRunningRun, T0 } from './support/cancel-run.ts';
import { groupRows, killGroup, liveRows, rowOf, waitForSigtermProof } from './support/ps.ts';

const groups: number[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const strays: number[] = [];

afterEach(async () => {
  for (const pgid of groups.splice(0)) killGroup(pgid);
  for (const pid of strays.splice(0)) killGroup(pid);
  children.splice(0);
  await sleep(50);
});

/** The fixture of EPIC-08-S26: a shell and three sleeps, one process group. */
const BACKGROUNDS_TWO = ['-c', 'sleep 300 & sleep 300 & sleep 300; wait'];

async function spawnDetached(
  command: string,
  args: readonly string[],
  env: Record<string, string>,
  members: number,
): Promise<number> {
  const child = spawn(command, [...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Mandatory. Without it the grandchildren join DeFlowd's own process group,
    // where the only group to signal is the daemon's.
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

const startTree = (): Promise<number> => spawnDetached('/bin/sh', BACKGROUNDS_TWO, {}, 4);

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
  await waitForSigtermProof(pgid);
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

const stagesIn = (db: Parameters<typeof readProcesses>[0]): Record<string, unknown>[] =>
  eventsOf(db, 'node.cancel.stage');

suite('EPIC-08-S26 — the kill switch stops a whole process tree', () => {
  it('spawns four processes into one group, then empties it (test plan #1, #2)', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const pgid = await startTree();
      journalProcess(db, pgid);

      // Test plan #1: `pgid === child.pid` for all four, which is what
      // `detached: true` buys and what makes one signal enough.
      const before = liveRows(pgid);
      expect(before).toHaveLength(4);
      for (const row of before) expect(row.pgid).toBe(pgid);

      const clock = new TestClock(T0);
      const running = killRun(CANCEL_RUN, { db, clock, epoch: 1 });

      // Test plan #2: the group goes on the group SIGTERM, grandchildren
      // included — no escalation needed, and none recorded.
      await waitFor(() => liveRows(pgid).length === 0, {
        describe: 'the whole tree, grandchildren included, to go on SIGTERM',
      });
      await clock.advance(TERM_GRACE_MS + KILL_VERIFY_MS);
      const report = await running;

      expect(report.outcome).toBe('stopped');
      expect(report.survivors).toEqual([]);
      expect(liveRows(pgid)).toEqual([]);
      expect(eventsOf(db, 'run.kill_failed')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('records every rung as an event with its elapsed time (AC2, AC7)', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const pgid = await startSigtermIgnoringTree();
      journalProcess(db, pgid);

      const clock = new TestClock(T0);
      const flushed: string[] = [];
      const running = killRun(CANCEL_RUN, {
        db,
        clock,
        epoch: 1,
        // Rung 1: the agent is given its chance to flush before anything is
        // signalled, and answers.
        protocolCancel: async (key) => {
          flushed.push(`${key.nodeId}/${key.attempt}`);
          return true;
        },
      });

      await waitFor(() => stagesIn(db).some((stage) => stage.stage === 'sigterm'), {
        describe: 'the SIGTERM rung',
      });
      // The fixture ignores SIGTERM, so the group is untouched by rung 2.
      await sleep(300);
      expect(liveRows(pgid).length).toBeGreaterThanOrEqual(3);

      // Rung 3, released by the injected clock rather than five real seconds.
      await clock.advance(TERM_GRACE_MS);
      await waitFor(() => liveRows(pgid).length === 0, { describe: 'the group to go on SIGKILL' });
      await clock.advance(KILL_VERIFY_MS);
      const report = await running;

      expect(flushed).toEqual([`${AUTH}/0`]);
      expect(report.outcome).toBe('stopped');

      // AC2 and EPIC-08-S26 scenario 2: the four rungs, in order, each with the
      // milliseconds the Clock says it took to get there.
      const stages = stagesIn(db);
      expect(stages.map((stage) => stage.stage)).toEqual([
        'protocol',
        'sigterm',
        'sigkill',
        'verified',
      ]);
      for (const stage of stages) expect(stage).toMatchObject({ pid: pgid, pgid });
      const elapsed = stages.map((stage) => stage.elapsedMs as number);
      expect(elapsed[0]).toBe(0);
      expect(elapsed[1]).toBe(0);
      // The SIGKILL rung is only reached after the full grace has elapsed on
      // the clock, and the verification after it.
      expect(elapsed[2]).toBe(TERM_GRACE_MS);
      expect(elapsed[3]).toBeGreaterThanOrEqual(TERM_GRACE_MS);
      expect(elapsed).toEqual([...elapsed].sort((a, b) => a - b));
    } finally {
      db.close();
    }
  });

  it('AC3: an agent that ignores SIGTERM is killed by the SIGKILL rung', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const pgid = await startSigtermIgnoringTree();
      journalProcess(db, pgid);

      const clock = new TestClock(T0);
      const running = killRun(CANCEL_RUN, { db, clock, epoch: 1 });

      await waitFor(() => stagesIn(db).some((stage) => stage.stage === 'sigterm'), {
        describe: 'the SIGTERM rung',
      });
      await sleep(300);
      // It survived rung 2 — the escalation is real, not decoration.
      expect(liveRows(pgid).length).toBeGreaterThanOrEqual(3);

      await clock.advance(TERM_GRACE_MS);
      await waitFor(() => liveRows(pgid).length === 0, { describe: 'the group to go on SIGKILL' });
      await clock.advance(KILL_VERIFY_MS);

      expect((await running).outcome).toBe('stopped');
      // The ledger shows the escalation rather than a clean cancel.
      expect(stagesIn(db).map((stage) => stage.stage)).toEqual(['sigterm', 'sigkill', 'verified']);
      expect(liveRows(pgid)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('sweeps the group even when rung 1 succeeded and the agent exited politely', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const pgid = await startTree();
      journalProcess(db, pgid);
      const grandchildren = liveRows(pgid).filter((row) => row.pid !== pgid);
      expect(grandchildren.length).toBe(3);

      const clock = new TestClock(T0);
      const running = killRun(CANCEL_RUN, {
        db,
        clock,
        epoch: 1,
        // A well-behaved agent answers, flushes and exits *itself*. Its
        // grandchildren are still there — this is the whole reason rungs 2 and
        // 3 run after a successful rung 1 (§9.4).
        protocolCancel: async () => true,
      });

      await waitFor(() => liveRows(pgid).length === 0, {
        describe: 'the group the polite exit left behind to be swept',
      });
      await clock.advance(TERM_GRACE_MS + KILL_VERIFY_MS);
      const report = await running;

      expect(report.outcome).toBe('stopped');
      expect(stagesIn(db).map((stage) => stage.stage)).toContain('protocol');
      expect(stagesIn(db).map((stage) => stage.stage)).toContain('sigterm');
      expect(liveRows(pgid)).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('the SIGTERM-ignoring fixture is ready when its gate says it is', () => {
  it('loses nothing to a group SIGTERM sent the instant the tree is reported up', async () => {
    const pgid = await startSigtermIgnoringTree();

    // Every escalation spec below is built on one promise: this tree ignores
    // SIGTERM, so a group that is still whole after rung 2 proves rung 3 did
    // the work. That promise is not "three processes exist". The two children
    // are `sh -c 'trap "" TERM; exec sleep 300'`, and a shell that has not yet
    // reached its `exec` still has the *default* disposition — measured at
    // 6-27 ms from spawn on this machine, wider the busier the box. A gate that
    // counted rows handed back a tree whose children died on rung 2, and the
    // specs then read as "the escalation is decoration" under load only.
    process.kill(-pgid, 'SIGTERM');
    await sleep(300);

    expect(
      liveRows(pgid),
      'a member died on SIGTERM, so the fixture was handed over before it was SIGTERM-proof',
    ).toHaveLength(3);
  });
});

suite('EPIC-08-S27 — the zombie false-negative (AC4, test plan #4)', () => {
  it('the naive check reports survivors at the instant the filtered one is empty', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const pgid = await startTree();
      journalProcess(db, pgid);
      expect(liveRows(pgid)).toHaveLength(4);

      // A *successful* group SIGKILL, sent by hand so the table can be read at
      // the exact instant the naive assertion would have read it.
      killGroup(pgid);
      const unfiltered = groupRows(pgid);
      const filtered = unfiltered.filter((row) => !row.stat.includes('Z'));

      // Both halves, at the same instant. The naive check — `$2 == g` with no
      // `$3 !~ /Z/` — DOES report survivors, and concluding failure from it is
      // the trap this scenario exists to document rather than discover.
      expect(
        unfiltered.length,
        'no Z-state row survived the kill, so this run proves nothing about the filter',
      ).toBeGreaterThan(0);
      for (const row of unfiltered) expect(row.stat).toContain('Z');
      expect(filtered).toEqual([]);

      // And the production reader agrees with the filtered view, not the naive
      // one: the kill switch reports success over a group `ps` is still listing.
      const clock = new TestClock(T0);
      const running = killRun(CANCEL_RUN, { db, clock, epoch: 1 });
      await clock.advance(TERM_GRACE_MS + KILL_VERIFY_MS);
      const report = await running;

      expect(report.survivors).toEqual([]);
      expect(report.outcome).toBe('stopped');
      expect(eventsOf(db, 'run.kill_failed')).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-08-S28 — the positive-pid regression (AC5, test plan #3)', () => {
  it('kills only the shell and leaves both grandchildren with ppid 1', async () => {
    const pgid = await startTree();
    const descendants = liveRows(pgid).filter((row) => row.pid !== pgid);
    expect(descendants).toHaveLength(3);
    for (const row of descendants) strays.push(row.pid);

    // A POSITIVE pid: one character from the correct call, and the entire
    // difference between a kill switch and a leak. This is the test that stops
    // anyone "simplifying" killTree.
    process.kill(pgid, 'SIGKILL');
    await waitFor(() => liveRows(pgid).every((row) => row.pid !== pgid), {
      describe: 'the direct child to die',
    });

    const survivors = descendants.map((row) => rowOf(row.pid));
    for (const [index, row] of survivors.entries()) {
      expect(row, `grandchild ${descendants[index]?.pid} should have survived`).toBeDefined();
      expect(row?.stat).toContain('S');
      // Adopted by init, and still holding the dead shell's pgid — which is
      // why the `process` row records the pgid and not only the pid.
      expect(row?.ppid).toBe(1);
      expect(row?.pgid).toBe(pgid);
    }

    // Only the negative form clears the group.
    process.kill(-pgid, 'SIGKILL');
    await waitFor(() => liveRows(pgid).length === 0, {
      describe: 'the group to go on the negative form',
    });
    expect(liveRows(pgid)).toEqual([]);
  });
});

suite('EPIC-08-S29 — a kill that did not take is an event (AC6, test plan #6)', () => {
  it('appends run.kill_failed with the surviving pids and their states', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const pgid = await startTree();
      journalProcess(db, pgid);

      const clock = new TestClock(T0);
      const signalled: string[] = [];
      const running = killRun(CANCEL_RUN, {
        db,
        clock,
        epoch: 1,
        // Injected so the group genuinely survives every rung. Nothing real
        // survives SIGKILL, and the reporting path still has to work.
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
      // It does NOT report success, and success was never assumed from the
      // mere fact that the signal call did not throw.
      expect(report.outcome).toBe('survived');
      expect(report.survivors.length).toBeGreaterThanOrEqual(4);

      const [failure] = eventsOf(db, 'run.kill_failed');
      expect(failure).toBeDefined();
      const survivors = failure?.survivors as {
        node: string;
        attempt: number;
        pid: number;
        pgid: number;
        stat: string;
      }[];
      expect(survivors.length).toBe(report.survivors.length);
      expect(survivors.map((one) => one.pid)).toContain(pgid);
      for (const one of survivors) {
        expect(one).toMatchObject({ node: AUTH, attempt: 0, pgid });
        // The state is what tells an operator why SIGKILL did not land.
        expect(one.stat).toMatch(/^[A-Za-z]/);
        expect(one.stat).not.toContain('Z');
      }
      // No 'verified' rung was claimed for a group that is still there.
      expect(stagesIn(db).map((stage) => stage.stage)).toEqual(['sigterm', 'sigkill']);
    } finally {
      db.close();
    }
  });

  it('is idempotent, and the second press signals nothing (S29 scenario 3)', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const pgid = await startTree();
      journalProcess(db, pgid);

      const clock = new TestClock(T0);
      const first = killRun(CANCEL_RUN, { db, clock, epoch: 1 });
      await waitFor(() => liveRows(pgid).length === 0, { describe: 'the group to go' });
      await clock.advance(TERM_GRACE_MS + KILL_VERIFY_MS);
      expect((await first).outcome).toBe('stopped');
      expect(readProcesses(db).filter((row) => row.state === 'live')).toEqual([]);

      // The pgid may by now belong to somebody else entirely, so the second
      // press must not reach for it: there is no live row, and nothing is
      // signalled.
      const signalled: number[] = [];
      const second = await killRun(CANCEL_RUN, {
        db,
        clock,
        epoch: 1,
        killTree: (pid: number) => {
          signalled.push(pid);
        },
      });

      expect(second.outcome).toBe('nothing-running');
      expect(second.survivors).toEqual([]);
      expect(signalled).toEqual([]);
      expect(eventsOf(db, 'run.kill_failed')).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('refuses to signal a pgid whose recorded start time no longer matches', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const pgid = await startTree();
      journalProcess(db, pgid);

      const clock = new TestClock(T0);
      const signalled: number[] = [];
      const report = await killRun(CANCEL_RUN, {
        db,
        clock,
        epoch: 1,
        // By the time a second kill runs, the pid may belong to somebody else.
        startTime: () => 'a start time from a different process',
        killTree: (pid: number) => {
          signalled.push(pid);
        },
      });

      // Its own outcome, not "stopped": the agent may well still be running
      // under a pid nobody recorded, and an operator told "stopped" would stop
      // looking.
      expect(report.outcome).toBe('refused');
      expect(signalled).toEqual([]);
      // Still alive, and deliberately so: signalling it is the unrecoverable
      // bug, and refusing is the answer.
      expect(liveRows(pgid).length).toBeGreaterThanOrEqual(4);
      expect(readProcesses(db).map((row) => row.state)).toEqual(['discarded']);
    } finally {
      db.close();
    }
  });
});
