/**
 * KAR-27.6 — a cooperative cancel stops parking silently.
 *
 * **The incident.** Twice on 2026-08-25, `POST /api/runs/:id/cancel` answered
 * `cancelling` and the run sat there indefinitely while the agent child kept
 * working. The request carried no `mode`, so it took the default —
 * `cooperative` — whose first rung is `ports.protocolCancel`, and production
 * wired that port nowhere. So the cancel asked nobody anything, `finishCancels`
 * reached `if (live.length > 0) continue`, and the run parked with no bound, no
 * report, and nothing anywhere naming `--force` as the way out.
 *
 * **Still true after KAR-27.9.** The rung exists now, and this file's driver is
 * deliberately built without a `liveTurns` port — which is the state of every
 * attempt this daemon holds no connection for: one left by a previous daemon
 * life, or one whose agent simply ignores `session/cancel`. Both still park, so
 * everything below is still the behaviour, not a description of a state that has
 * gone away.
 *
 * **What this file pins, and what it deliberately does not.** It does not
 * exercise the rung — that is `./cancel-protocol-rung.test.ts` — and it must not
 * let anybody "fix" the park by escalating: EPIC-19-S38's decision is that a cooperative cancel is
 * never promoted, because an automatic escalation makes `--force` decorative
 * and truncates the transcript the operator cancelled the run in order to read.
 * So the kill runner is injected and the assertion is that **cooperative never
 * calls it**, however many ticks pass.
 *
 * Integration rather than unit because every claim is about the *loop*: what
 * one tick of the real driver appends over a real file-backed ledger, and what
 * the HTTP surface then serves off it. A unit test over the projection —
 * `../../../core/src/cooperative-cancel.test.ts` — cannot see a loop that never
 * appends the fact, which is precisely the defect.
 *
 * The forceful ladder's own rungs are pinned by `./cancel-ladder.test.ts` and
 * `./cancel-recovery.test.ts` against real signals and real children; what is
 * pinned here is the seam this story touches — that `finishCancels` still runs
 * the ladder for `forceful`, still ends the run when the group is empty, and
 * still refuses to claim a stop that did not happen.
 *
 * Verifies: EPIC-27-S28, EPIC-27-S29, EPIC-27-S30, EPIC-27-S31, EPIC-27-S32 ·
 * KAR-27.6 AC1, AC2, AC3, AC4, AC5, AC6
 */
import type { Db, RunId } from '@DeFlow/core';
import {
  COOPERATIVE_CANCEL_UNANSWERED_MS,
  cancelWaiting,
  forcefulCancelCommand,
  runStatusLabel,
} from '@DeFlow/core';
import { appendEvents, openLedger, readProcesses, recordProcess, replayRun } from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN, TestClock } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { expect, describe as suite } from 'vitest';
import type { KillRunner } from '../../src/drive.ts';
import { createRunDriver } from '../../src/drive.ts';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';
import type { KillRunOutcome } from '../../src/kill-switch.ts';
import { AUTH, CANCEL_RUN, draft, ROUTER, seedRunningRun, T0 } from './support/cancel-run.ts';

const fetch = authorizedFetch();

const RUN = CANCEL_RUN as RunId;
/** When the operator asked. Every window in this file is measured from it. */
const REQUESTED_AT = T0 + 1_000;
const AUTH_PID = 48_215;
const ROUTER_PID = 48_216;

/** A kill runner that records every call. For a cooperative cancel it must
 * never be called at all — that is EPIC-19-S38, and this is how it is pinned. */
function recordingKill(outcome: KillRunOutcome = 'stopped'): {
  readonly calls: { runId: string; mode: string }[];
  readonly kill: KillRunner;
} {
  const calls: { runId: string; mode: string }[] = [];
  return {
    calls,
    kill: (runId, mode) => {
      calls.push({ runId, mode });
      return Promise.resolve({ outcome });
    },
  };
}

/** A live `process` row for one of the run's nodes, exactly as a spawn writes it. */
function live(db: Db, nodeId: string, pid: number): void {
  recordProcess(db, {
    runId: RUN,
    nodeId,
    attempt: 0,
    pid,
    pgid: pid,
    startedAt: 'Tue Aug 25 14:00:00 2026',
    binarySha256: 'd'.repeat(64),
    worktree: '/tmp/wt',
    spawnedAt: T0,
  });
}

/**
 * A run the operator cancelled `mode` at `REQUESTED_AT`, with `nodes` still
 * live under it. The ledger is real and on disk: the whole claim is that the
 * next daemon reads this and reaches the same conclusion.
 */
function seedCancelled(
  db: Db,
  mode: 'cooperative' | 'forceful',
  nodes: readonly [string, number][],
): void {
  seedRunningRun(db);
  for (const [nodeId, pid] of nodes) live(db, nodeId, pid);
  appendEvents(db, [draft('run.cancel.requested', { mode }, { ts: REQUESTED_AT })]);
}

const kindsOf = (db: Db): string[] =>
  db
    .prepare<{ kind: string }>('SELECT kind FROM event WHERE run_id = ? ORDER BY seq')
    .all(RUN)
    .map((row) => row.kind);

const countOf = (db: Db, kind: string): number => kindsOf(db).filter((one) => one === kind).length;

const unansweredPayloads = (db: Db): { live?: { node: string; pid: number }[] }[] =>
  db
    .prepare<{ payload: string }>(
      "SELECT payload FROM event WHERE run_id = ? AND kind = 'run.cancel.unanswered' ORDER BY seq",
    )
    .all(RUN)
    .map((row) => JSON.parse(row.payload) as { live?: { node: string; pid: number }[] });

const liveRowCount = (db: Db): number =>
  readProcesses(db).filter((row) => row.runId === RUN && row.state === 'live').length;

suite('EPIC-27-S28 — an unanswered cooperative cancel says so (AC1)', () => {
  it('says nothing before the window, and names the instant after it', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCancelled(db, 'cooperative', [[AUTH, AUTH_PID]]);
      const runner = recordingKill();
      const driver = createRunDriver({
        db,
        clock: new TestClock(REQUESTED_AT),
        epoch: 1,
        startedAt: T0,
        killRun: runner.kill,
      });

      // One tick a millisecond short of the window: the wait is real, and it is
      // not yet news.
      await driver.tick(REQUESTED_AT + COOPERATIVE_CANCEL_UNANSWERED_MS - 1);
      expect(countOf(db, 'run.cancel.unanswered')).toBe(0);
      expect(runStatusLabel(replayRun(db, RUN).state)).toBe('cancelling');

      await driver.tick(REQUESTED_AT + COOPERATIVE_CANCEL_UNANSWERED_MS);
      expect(countOf(db, 'run.cancel.unanswered')).toBe(1);
      expect(runStatusLabel(replayRun(db, RUN).state)).toBe(
        `cancelling · the agent has not answered since ${new Date(REQUESTED_AT).toISOString()}`,
      );
    } finally {
      db.close();
    }
  });

  it('reports once rather than on every tick, and never ends the run itself', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCancelled(db, 'cooperative', [[AUTH, AUTH_PID]]);
      const runner = recordingKill();
      const driver = createRunDriver({
        db,
        clock: new TestClock(REQUESTED_AT),
        epoch: 1,
        startedAt: T0,
        killRun: runner.kill,
      });

      for (let tick = 0; tick < 12; tick += 1) {
        await driver.tick(REQUESTED_AT + COOPERATIVE_CANCEL_UNANSWERED_MS + tick * 1_000);
      }

      expect(countOf(db, 'run.cancel.unanswered')).toBe(1);
      expect(countOf(db, 'run.aborted')).toBe(0);
      expect(countOf(db, 'run.completed')).toBe(0);
      expect(replayRun(db, RUN).state.status).toBe('cancelling');
    } finally {
      db.close();
    }
  });
});

suite('EPIC-27-S30 — nothing is escalated behind the operator’s back (AC3)', () => {
  it('signals nothing, however much time passes, and stays cooperative', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCancelled(db, 'cooperative', [
        [AUTH, AUTH_PID],
        [ROUTER, ROUTER_PID],
      ]);
      const runner = recordingKill();
      const driver = createRunDriver({
        db,
        clock: new TestClock(REQUESTED_AT),
        epoch: 1,
        startedAt: T0,
        killRun: runner.kill,
      });

      for (let tick = 0; tick < 20; tick += 1) {
        await driver.tick(REQUESTED_AT + COOPERATIVE_CANCEL_UNANSWERED_MS * (tick + 1));
      }

      // The whole of EPIC-19-S38, pinned: the ladder is never entered, so no
      // signal reaches the group and no `node.cancel.stage` is written.
      expect(runner.calls).toEqual([]);
      expect(kindsOf(db)).not.toContain('node.cancel.stage');
      // The mode on the record is still the one the operator asked for.
      expect(replayRun(db, RUN).state.cancel?.mode).toBe('cooperative');
      // And the processes are exactly as alive as they were.
      expect(liveRowCount(db)).toBe(2);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-27-S31 — what is still running is named (AC4)', () => {
  it('names both survivors by pid and node, in the ledger', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCancelled(db, 'cooperative', [
        [AUTH, AUTH_PID],
        [ROUTER, ROUTER_PID],
      ]);
      const runner = recordingKill();
      const driver = createRunDriver({
        db,
        clock: new TestClock(REQUESTED_AT),
        epoch: 1,
        startedAt: T0,
        killRun: runner.kill,
      });

      await driver.tick(REQUESTED_AT + COOPERATIVE_CANCEL_UNANSWERED_MS);

      const [payload] = unansweredPayloads(db);
      expect(payload?.live?.map((one) => [one.node, one.pid])).toEqual([
        [AUTH, AUTH_PID],
        [ROUTER, ROUTER_PID],
      ]);

      // And the same two, off the projection, which is what every surface reads.
      const waiting = cancelWaiting(replayRun(db, RUN).state, RUN);
      expect(waiting?.stillRunning).toBe(
        `pid ${AUTH_PID} (${AUTH}), pid ${ROUTER_PID} (${ROUTER})`,
      );
    } finally {
      db.close();
    }
  });
});

suite('EPIC-27-S29, S28 — the API reports the wait, and names the way out (AC2, AC6)', () => {
  it('serves the same sentence on the run list and on the run itself', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedCancelled(db, 'cooperative', [[AUTH, AUTH_PID]]);
    const runner = recordingKill();
    const driver = createRunDriver({
      db,
      clock: new TestClock(REQUESTED_AT),
      epoch: 1,
      startedAt: T0,
      killRun: runner.kill,
    });
    await driver.tick(REQUESTED_AT + COOPERATIVE_CANCEL_UNANSWERED_MS);

    // The label `deflow status` composes, from its own replay of the same
    // ledger. AC6's "the same words" is this equality, not two copies of a
    // sentence that happen to match today.
    const expected = runStatusLabel(replayRun(db, RUN).state);
    const remedy = forcefulCancelCommand(RUN);

    const view = openLedgerView(tmp);
    setLedgerView(view);
    const started = await startHttp({
      port: 0,
      hostname: '127.0.0.1',
      dev: false,
      token: TEST_DAEMON_TOKEN,
    });
    const origin = `http://127.0.0.1:${(started.server.address() as AddressInfo).port}`;

    try {
      const list = (await (await fetch(`${origin}/api/runs?limit=10`)).json()) as {
        runs: readonly {
          runId: string;
          label: string;
          cancelWaiting: { remedy: string; stillRunning: string } | null;
        }[];
      };
      const row = list.runs.find((one) => one.runId === RUN);
      expect(row?.label).toBe(expected);
      expect(row?.cancelWaiting?.remedy).toContain(remedy);
      expect(row?.cancelWaiting?.stillRunning).toBe(`pid ${AUTH_PID} (${AUTH})`);

      const one = (await (await fetch(`${origin}/api/runs/${RUN}`)).json()) as {
        status: string;
        cancelWaiting?: { remedy: string; since: string; stillRunning: string };
      };
      expect(one.status).toBe('cancelling');
      expect(one.cancelWaiting?.remedy).toContain(remedy);
      expect(one.cancelWaiting?.since).toBe(new Date(REQUESTED_AT).toISOString());
      expect(one.cancelWaiting?.stillRunning).toBe(`pid ${AUTH_PID} (${AUTH})`);
    } finally {
      await started.close();
      clearLedgerView();
      db.close();
    }
  });
});

suite('EPIC-27-S33 — a run that was never cancelled says nothing new', () => {
  it('appends nothing and reports its ordinary label', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      live(db, AUTH, AUTH_PID);
      const runner = recordingKill();
      const driver = createRunDriver({
        db,
        clock: new TestClock(T0),
        epoch: 1,
        startedAt: T0,
        killRun: runner.kill,
      });

      await driver.tick(T0 + COOPERATIVE_CANCEL_UNANSWERED_MS * 10);

      expect(countOf(db, 'run.cancel.unanswered')).toBe(0);
      expect(cancelWaiting(replayRun(db, RUN).state, RUN)).toBeNull();
      expect(runner.calls).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-27-S32 — the forceful ladder is untouched (AC5)', () => {
  it('runs the ladder, ends the run and leaves no live row behind', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCancelled(db, 'forceful', [[AUTH, AUTH_PID]]);
      const runner = recordingKill('stopped');
      const driver = createRunDriver({
        db,
        clock: new TestClock(REQUESTED_AT),
        epoch: 1,
        // The kill runner is injected, so the `process` rows it would have
        // emptied are emptied here instead — the ladder's own signalling is
        // `./cancel-ladder.test.ts`'s claim, not this file's.
        startedAt: T0,
        killRun: async (runId, mode) => {
          const report = await runner.kill(runId, mode);
          db.prepare("UPDATE process SET state = 'reaped' WHERE run_id = ?").run(RUN);
          return report;
        },
      });

      await driver.tick(REQUESTED_AT + 10);

      expect(runner.calls).toEqual([{ runId: RUN, mode: 'forceful' }]);
      expect(countOf(db, 'run.aborted')).toBe(1);
      expect(liveRowCount(db)).toBe(0);
      // A forceful cancel that ended cleanly never wears the waiting copy.
      expect(cancelWaiting(replayRun(db, RUN).state, RUN)).toBeNull();
    } finally {
      db.close();
    }
  });

  it('reports a survivor rather than claiming the run dead', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedCancelled(db, 'forceful', [[AUTH, AUTH_PID]]);
      const runner = recordingKill('survived');
      const driver = createRunDriver({
        db,
        clock: new TestClock(REQUESTED_AT),
        epoch: 1,
        startedAt: T0,
        killRun: runner.kill,
      });

      await driver.tick(REQUESTED_AT + 10);

      expect(countOf(db, 'run.aborted')).toBe(0);
      expect(replayRun(db, RUN).state.status).toBe('cancelling');
      expect(liveRowCount(db)).toBe(1);
    } finally {
      db.close();
    }
  });
});
