/**
 * KAR-06.9 — crash recovery and resume from the last completed boundary
 * (docs/05-durable-execution.md §12, §14 · EPIC-06-S6, S11, S25, S29, S30).
 *
 * Startup is a **fixed sequence**, and its order is the acceptance criterion:
 * take the lock, bump the epoch, rebuild `RunState`, reconcile every `effect`
 * row a previous daemon life left `pending`, reclaim what the dead attempts
 * were holding, reap the children that outlived their parent, load the wakes
 * that came due while nothing was running — and only then start the ticker. A
 * `StartNode` issued before the reconciliation has finished is a node re-run
 * against a world nobody has looked at yet, which is the one failure the whole
 * durability layer exists to prevent.
 *
 * Everything here runs against a real file-backed ledger, and every side effect
 * is a real invocation of the real fake agent binary, which appends one line
 * per invocation to a text file of its own. That file — not the effect journal
 * — is what "executed twice" is checked against: the journal is the mechanism
 * that is supposed to prevent the second execution, so reading it back to ask
 * whether one happened proves only that it agrees with itself.
 *
 * Verifies: EPIC-06-S6, EPIC-06-S11, EPIC-06-S25, EPIC-06-S29, EPIC-06-S30 ·
 * AC1–AC6
 */

import { processStartTime } from '@DeFlow/adapters';
import { type EffectRow, type NodeId, NodeIdSchema, seededRandom } from '@DeFlow/core';
import {
  journalEffect,
  markEffectDone,
  openLedger,
  readEffect,
  readEffects,
  readProcesses,
  readRange,
  recordProcess,
  replayAll,
  scheduleWake,
} from '@DeFlow/ledger';
import {
  duplicateIdempotencyKeys,
  it,
  readSideEffectLog,
  sleep,
  TestClock,
  waitFor,
} from '@DeFlow/testkit';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { RECOVERED_STEPS, RECOVERY_STEPS, type RecoveryStep, recover } from '../../src/recovery.ts';
import { runUntilSettled } from '../support/run-loop.ts';
import {
  DONE_NODES,
  INTERRUPTED,
  RECOVERY_RUN,
  REMAINING_NODES,
  REPO_LOCK,
  seedInterruptedAttempt,
  seedRecoveryRun,
  T0,
} from './support/recovery-run.ts';

/** The instant this daemon life started. Everything the previous life wrote is
 * stamped before it, which is what makes its rows *inherited*. */
const DAEMON_STARTED_AT = T0 + 60_000;

const HASH = `sha256-${'e'.repeat(64)}`;

const strays: number[] = [];

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone, which is what most of these specs are asserting.
    }
  }
});

const ports = (db: ReturnType<typeof openLedger>, over: Record<string, unknown> = {}) => ({
  db,
  clock: new TestClock(DAEMON_STARTED_AT + 1_000),
  epoch: 2,
  daemonStartedAt: DAEMON_STARTED_AT,
  random: seededRandom(7),
  ...over,
});

/** A `pending` effect row written by a daemon life that is gone. */
function inheritedEffect(
  db: ReturnType<typeof openLedger>,
  node: NodeId,
  attempt: number,
  startedAt: number,
): string {
  const key = `${RECOVERY_RUN}/${node}/${attempt}/0`;
  journalEffect(
    db,
    {
      ikey: key,
      runId: RECOVERY_RUN,
      nodeId: node,
      attempt,
      ordinal: 0,
      kind: 'agent',
      requestHash: HASH,
      startedAt,
    },
    {
      runId: RECOVERY_RUN,
      ts: startedAt,
      kind: 'effect.started',
      v: 1,
      epoch: 1,
      nodeId: node,
      attempt,
      ikey: key,
      payload: { ikey: key, kind: 'agent', requestHash: HASH },
    },
  );
  return key;
}

suite('the startup sequence, in the order the order matters (AC1, EPIC-06-S29)', () => {
  it('reconciles every prior-epoch pending effect before it reports a later step', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRecoveryRun(db);
      seedInterruptedAttempt(db);
      inheritedEffect(db, INTERRUPTED, 0, T0);

      const trace: string[] = [];
      const recovered = await recover({
        ...ports(db),
        onStep: (step: RecoveryStep) => trace.push(`step:${step}`),
        reconcile: (row: EffectRow) => {
          trace.push(`reconcile:${row.ikey}`);
          return Promise.resolve({ status: 'not-started' as const });
        },
      });

      // The five steps `recover()` owns, in the documented order, with the
      // probe running inside the fourth of them.
      expect(trace).toEqual([
        'step:rebuild-state',
        `reconcile:${RECOVERY_RUN}/${INTERRUPTED}/0/0`,
        'step:reconcile-effects',
        'step:reclaim-locks',
        'step:reap-orphans',
        'step:load-wakes',
      ]);
      expect(recovered.reconciled).toHaveLength(1);
      // And the steps it reported are exactly the ones it claims to own, in
      // the order the constant declares — so the constant is the contract
      // rather than a comment beside one.
      expect(trace.filter((entry) => entry.startsWith('step:'))).toEqual(
        RECOVERED_STEPS.map((step) => `step:${step}`),
      );
    } finally {
      db.close();
    }
  });

  it('names the whole sequence, including the steps around it', () => {
    expect(RECOVERY_STEPS).toEqual([
      'flock',
      'bump-epoch',
      'rebuild-state',
      'reconcile-effects',
      'reclaim-locks',
      'reap-orphans',
      'load-wakes',
      'start-ticker',
    ]);
    // The five in the middle, contiguous: `flock` and `bump-epoch` happen
    // before `recover()` is called and `start-ticker` after, so the steps it
    // owns are the sequence minus its two ends.
    expect(RECOVERED_STEPS).toEqual(RECOVERY_STEPS.slice(2, -1));
  });

  it('issues no StartNode until reconciliation has finished', async ({ tmp, agentPath }) => {
    const db = openLedger(tmp);
    try {
      seedRecoveryRun(db);
      seedInterruptedAttempt(db);
      inheritedEffect(db, INTERRUPTED, 0, T0);

      const trace: string[] = [];
      const clock = new TestClock(DAEMON_STARTED_AT + 1_000);

      await recover({
        ...ports(db, { clock }),
        reconcile: (row: EffectRow) => {
          trace.push(`reconcile:${row.ikey}`);
          return Promise.resolve({ status: 'not-started' as const });
        },
      });

      await runUntilSettled(
        {
          db,
          runId: RECOVERY_RUN,
          clock,
          epoch: 2,
          daemonStartedAt: DAEMON_STARTED_AT,
          random: seededRandom(7),
          agent: agentPath.binary,
          sideEffects: join(tmp, 'side-effects.ndjson'),
          onCommand: (command) => {
            if (command.kind === 'StartNode') trace.push(`start:${command.node}`);
          },
          budgetMs: 60_000,
        },
        () => false,
      );

      const firstStart = trace.findIndex((entry) => entry.startsWith('start:'));
      expect(firstStart, 'the run never started anything').toBeGreaterThan(-1);
      expect(
        trace.slice(0, firstStart).filter((entry) => entry.startsWith('reconcile:')),
      ).toHaveLength(1);
      expect(trace.slice(firstStart).some((entry) => entry.startsWith('reconcile:'))).toBe(false);
    } finally {
      db.close();
    }
  });
});

suite('every inherited pending row is reconciled exactly once (AC2, EPIC-06-S11)', () => {
  it('reconciles the rows a dead daemon left and leaves this life’s alone', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRecoveryRun(db);
      seedInterruptedAttempt(db);
      const inherited = inheritedEffect(db, INTERRUPTED, 0, T0);
      // A row stamped by *this* life: ordinary concurrency, not a crash.
      const concurrent = inheritedEffect(
        db,
        NodeIdSchema.parse(REMAINING_NODES[0]),
        0,
        DAEMON_STARTED_AT + 5,
      );

      const seen: string[] = [];
      const recovered = await recover({
        ...ports(db),
        reconcile: (row: EffectRow) => {
          seen.push(row.ikey);
          return Promise.resolve({ status: 'done' as const, result: { ikey: row.ikey } });
        },
      });

      expect(seen).toEqual([inherited]);
      expect(recovered.reconciled).toEqual([expect.objectContaining({ verdict: 'done' })]);
      expect(readEffect(db, inherited)?.state).toBe('done');
      expect(readEffect(db, concurrent)?.state).toBe('pending');
    } finally {
      db.close();
    }
  });

  it('records each outcome as an event', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRecoveryRun(db);
      seedInterruptedAttempt(db);
      const key = inheritedEffect(db, INTERRUPTED, 0, T0);

      await recover({
        ...ports(db),
        reconcile: () => Promise.resolve({ status: 'done' as const, result: { ok: true } }),
      });

      const completed = readRange(db, RECOVERY_RUN, 0, 200).events.filter(
        (event) => event.kind === 'effect.completed',
      );
      expect(completed).toHaveLength(1);
      expect(completed[0]?.payload).toMatchObject({ ikey: key, reconciled: true });
      // This daemon life's epoch, not the dead one's.
      expect(completed[0]?.epoch).toBe(2);
    } finally {
      db.close();
    }
  });

  it('closes a row the probe proves never happened, and says so', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRecoveryRun(db);
      seedInterruptedAttempt(db);
      const key = inheritedEffect(db, INTERRUPTED, 0, T0);

      const recovered = await recover({
        ...ports(db),
        reconcile: () => Promise.resolve({ status: 'not-started' as const }),
      });

      expect(recovered.reconciled).toEqual([expect.objectContaining({ verdict: 'not-started' })]);
      // Terminal, so a later restart does not probe the world about it again.
      expect(readEffect(db, key)?.state).toBe('failed');
      const failed = readRange(db, RECOVERY_RUN, 0, 200).events.filter(
        (event) => event.kind === 'effect.failed',
      );
      expect(failed).toHaveLength(1);
      expect(failed[0]?.payload).toMatchObject({
        ikey: key,
        failure: { class: 'transient' },
      });
    } finally {
      db.close();
    }
  });

  it('escalates to a human when nothing can tell whether it landed', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRecoveryRun(db);
      seedInterruptedAttempt(db);
      inheritedEffect(db, INTERRUPTED, 0, T0);

      const recovered = await recover({
        ...ports(db),
        reconcile: () =>
          Promise.resolve({ status: 'unknown' as const, detail: 'the worktree moved' }),
      });

      expect(recovered.reconciled).toEqual([expect.objectContaining({ verdict: 'unknown' })]);
      const kinds = readRange(db, RECOVERY_RUN, 0, 200).events.map((event) => event.kind);
      expect(kinds).toContain('run.needs_human');
      // The run is halted, so nothing else is admitted after it.
      const state = replayAll(db).runs.get(RECOVERY_RUN);
      expect(state?.needsHuman).not.toBeNull();
    } finally {
      db.close();
    }
  });
});

suite('completed nodes are never re-executed (AC3, EPIC-06-S11)', () => {
  it('starts exactly the two that had not finished, and no ikey runs twice', async ({
    tmp,
    agentPath,
  }) => {
    const db = openLedger(tmp);
    const sideEffects = join(tmp, 'side-effects.ndjson');
    try {
      seedRecoveryRun(db);
      const clock = new TestClock(DAEMON_STARTED_AT + 1_000);

      await recover({ ...ports(db, { clock }) });
      const result = await runUntilSettled(
        {
          db,
          runId: RECOVERY_RUN,
          clock,
          epoch: 2,
          daemonStartedAt: DAEMON_STARTED_AT,
          random: seededRandom(7),
          agent: agentPath.binary,
          sideEffects,
          budgetMs: 60_000,
        },
        () => false,
      );

      expect(result.state.status).toBe('completed');
      // Exactly the nodes that had not finished, and nothing else: the three
      // completed ones get no command of any kind.
      expect(result.started.map((entry) => entry.node).sort()).toEqual(
        [INTERRUPTED, ...REMAINING_NODES].sort(),
      );
      for (const done of DONE_NODES) {
        expect(result.started.some((entry) => entry.node === done)).toBe(false);
      }

      const log = readSideEffectLog(sideEffects);
      expect(log.malformed).toBe(0);
      expect(duplicateIdempotencyKeys(log.entries)).toEqual([]);
      expect(log.entries.map((entry) => entry.nodeId).sort()).toEqual(
        [INTERRUPTED, ...REMAINING_NODES].sort(),
      );
    } finally {
      db.close();
    }
  });
});

suite('an interrupted attempt is concluded, so the run cannot wedge (AC6, EPIC-06-S6)', () => {
  it('fails the in-flight attempt with a typed transient failure and reclaims its lock', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRecoveryRun(db);
      seedInterruptedAttempt(db);

      const recovered = await recover({ ...ports(db) });

      expect(recovered.concluded).toEqual([
        expect.objectContaining({ nodeId: INTERRUPTED, attempt: 0, action: 'retry' }),
      ]);

      const state = replayAll(db).runs.get(RECOVERY_RUN);
      expect(state?.nodes[INTERRUPTED]?.status).toBe('awaiting-retry');
      expect(state?.nodes[INTERRUPTED]?.failure?.class).toBe('transient');
      // The lock the dead attempt was holding is given back *before* the first
      // decide(), with the reason a reader of the timeline can act on.
      expect(state?.locks).toEqual({});
      const released = readRange(db, RECOVERY_RUN, 0, 200).events.filter(
        (event) => event.kind === 'node.lock.released',
      );
      expect(released).toHaveLength(1);
      expect(released[0]?.payload).toMatchObject({
        node: INTERRUPTED,
        lock: 'repo',
        key: REPO_LOCK,
        reason: 'reclaimed',
      });
    } finally {
      db.close();
    }
  });

  it('halts with a typed NodeFailure when the attempts are exhausted', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRecoveryRun(db, { maxAttempts: 1 });
      seedInterruptedAttempt(db);

      const recovered = await recover({ ...ports(db) });

      expect(recovered.concluded).toEqual([
        expect.objectContaining({ nodeId: INTERRUPTED, action: 'fail' }),
      ]);
      const state = replayAll(db).runs.get(RECOVERY_RUN);
      expect(state?.nodes[INTERRUPTED]?.status).toBe('failed');
      expect(state?.nodes[INTERRUPTED]?.failure).toMatchObject({ reason: 'internal' });
      expect(state?.locks).toEqual({});
    } finally {
      db.close();
    }
  });

  it('leaves a run with nothing in flight untouched', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRecoveryRun(db);

      const recovered = await recover({ ...ports(db) });

      expect(recovered.concluded).toEqual([]);
      expect(recovered.released).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('the wakes that came due while nothing was running (AC1)', () => {
  it('loads them, and does not consume them', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRecoveryRun(db);
      scheduleWake(db, {
        runId: RECOVERY_RUN,
        nodeId: REMAINING_NODES[0],
        wakeAt: DAEMON_STARTED_AT - 5_000,
        reason: 'backoff',
      });
      scheduleWake(db, {
        runId: RECOVERY_RUN,
        nodeId: REMAINING_NODES[1],
        wakeAt: DAEMON_STARTED_AT + 5_000_000,
        reason: 'human_gate',
      });

      const recovered = await recover({ ...ports(db) });

      expect(recovered.due.map((row) => row.nodeId)).toEqual([REMAINING_NODES[0]]);
    } finally {
      db.close();
    }
  });
});

suite('the pid-reuse guard (AC4, EPIC-06-S25)', () => {
  /** A real, detached, group-leading process — an orphan of the kind a dead
   * daemon leaves behind. */
  async function startOrphan(): Promise<number> {
    const child = spawn('/bin/sh', ['-c', 'sleep 300'], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    const pid = child.pid as number;
    child.unref();
    strays.push(pid);
    return pid;
  }

  it('leaves a recycled pid alone, logs the skip, and never signals it', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRecoveryRun(db);

      // The process the previous daemon really spawned, and its real start
      // time as the OS reported it.
      const dead = await startOrphan();
      const deadStartedAt = processStartTime(dead);
      process.kill(-dead, 'SIGKILL');
      await waitFor(
        () => {
          try {
            process.kill(dead, 0);
            return false;
          } catch {
            return true;
          }
        },
        { describe: 'the first process to exit' },
      );

      // A different process, which the OS has since handed the same pid. Both
      // start times below are real values read out of the OS — the row is
      // exactly what a genuine pid recycle leaves behind.
      //
      // The wait is load-bearing rather than politeness: `ps -o lstart=` on
      // darwin has one-second resolution, so two processes started inside the
      // same second are indistinguishable to the guard. That is a real
      // property of the evidence the reaper has, and a spec that spawned both
      // immediately would be asserting that the guard fails.
      await sleep(1_100);
      const reused = await startOrphan();
      recordProcess(db, {
        runId: RECOVERY_RUN,
        nodeId: INTERRUPTED,
        attempt: 0,
        pid: reused,
        pgid: reused,
        startedAt: deadStartedAt,
        binarySha256: 'a'.repeat(64),
        worktree: null,
        spawnedAt: T0,
      });

      const logged: Record<string, unknown>[] = [];
      const recovered = await recover({
        ...ports(db),
        onReapDecision: (fields: Record<string, unknown>) => logged.push(fields),
      });

      expect(recovered.reaped).toEqual([expect.objectContaining({ outcome: 'pid-recycled' })]);
      expect(() => process.kill(reused, 0)).not.toThrow();
      expect(readProcesses(db).map((row) => row.state)).toEqual(['discarded']);
      expect(logged.some((fields) => fields.outcome === 'pid-recycled')).toBe(true);
    } finally {
      db.close();
    }
  });
});

suite('a done row short-circuits the effect after a restart (AC3, EPIC-06-S11)', () => {
  it('spawns nothing at all on a second daemon life over a finished run', async ({
    tmp,
    agentPath,
  }) => {
    const sideEffects = join(tmp, 'side-effects.ndjson');
    const life = async (epoch: number): Promise<number> => {
      const db = openLedger(tmp);
      try {
        const clock = new TestClock(DAEMON_STARTED_AT + epoch * 100_000);
        await recover({ ...ports(db, { clock, epoch }) });
        const result = await runUntilSettled(
          {
            db,
            runId: RECOVERY_RUN,
            clock,
            epoch,
            daemonStartedAt: DAEMON_STARTED_AT + epoch * 100_000 - 1,
            random: seededRandom(7),
            agent: agentPath.binary,
            sideEffects,
            budgetMs: 60_000,
          },
          () => false,
        );
        expect(result.state.status).toBe('completed');
        return result.started.length;
      } finally {
        db.close();
      }
    };

    const seeded = openLedger(tmp);
    seedRecoveryRun(seeded);
    seeded.close();

    expect(await life(2)).toBe(3);
    // The run is over. A daemon that starts over the same directory has
    // nothing to do — every node's terminal state is on disk, and F4.2 means
    // *no* agent is spawned, not that a spawned one is discarded.
    expect(await life(3)).toBe(0);

    const log = readSideEffectLog(sideEffects);
    expect(log.malformed).toBe(0);
    expect(log.entries).toHaveLength(3);
    expect(duplicateIdempotencyKeys(log.entries)).toEqual([]);

    const db = openLedger(tmp);
    try {
      expect(readEffects(db, RECOVERY_RUN).filter((row) => row.state !== 'done')).toEqual([]);
    } finally {
      db.close();
    }
  });
});
