/**
 * KAR-06.5 — `node.failed`, `node.retry.scheduled` and the `node_wake` upsert
 * are one transaction, or the backoff is a lie (EPIC-06-S20, EPIC-06-S31).
 *
 * A real ledger file, a real `kill -9`, a `TestClock` and no fake timers. The
 * three writes are the whole point: split them and a restart inside the backoff
 * window either loses the delay — an immediate retry storm against the vendor
 * that just rate-limited you — or double-counts the attempt and burns the
 * node's budget on a failure that never happened.
 *
 * Verifies: EPIC-06-S20 (all three scenarios), EPIC-06-S31 (scenarios 1 and 3),
 * EPIC-06-S18 (scenarios 1 and 4) · AC3, AC6, AC7, AC8, AC9
 */

import type { Db, DbStatement, DbValue } from '@DeFlow/core';
import {
  decide,
  initialRunState,
  type PlanPatch,
  type RunState,
  type StartNode,
  seededRandom,
} from '@DeFlow/core';
import { openLedger, readRange, readWakes, replayAll, scheduleWakeIfChanged } from '@DeFlow/ledger';
import { type Crashable, it, startCrashable, waitFor } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { recordNodeFailure } from '../../src/retry.ts';
import { recordingDb } from './support/recording-db.ts';
import {
  COMPLETED_NODES,
  classified,
  IMPLEMENT,
  IMPLEMENT_NODE,
  PENDING_NODES,
  RETRY_RUN,
  seedRetryRun,
  T0,
} from './support/retry-run.ts';

const CRASH_SCRIPT = fileURLToPath(new URL('./support/hang-in-backoff.ts', import.meta.url));

const alive: Crashable[] = [];

afterEach(async () => {
  await Promise.all(alive.splice(0).map((child) => child.sigkill()));
});

const RETRY = IMPLEMENT_NODE.retry;
const PREFER = IMPLEMENT_NODE.provider.prefer;

/** The first draw of seed 42 over a 2,000 ms window: `floor(0.6013… * 2000)`. */
const FIRST_BACKOFF_MS = 1202;

const stateOf = (db: Db): RunState => replayAll(db).runs.get(RETRY_RUN) ?? initialRunState();

/** Every event of the run. Bounded by a limit the fixture cannot exceed. */
const events = (db: Db) => readRange(db, RETRY_RUN, 0, 500).events;

const kinds = (db: Db): string[] => events(db).map((event) => event.kind);

const payloadOf = (db: Db, kind: string): Record<string, unknown> | undefined =>
  events(db).find((event) => event.kind === kind)?.payload as Record<string, unknown> | undefined;

const startsOf = (state: RunState, now: number): StartNode[] =>
  decide(state, now).filter((command): command is StartNode => command.kind === 'StartNode');

// ── scenario 1: the three writes are atomic ──────────────────────────────────

suite('EPIC-06-S20 scenario 1 — one transaction holds all three writes (AC6)', () => {
  it('appends node.failed, node.retry.scheduled and the backoff row together', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      const recorded = recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: classified('provider.rate-limited', 'transient'),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
      });

      expect(recorded.plan).toEqual({
        action: 'retry',
        nextAttempt: 1,
        delayMs: FIRST_BACKOFF_MS,
        wakeAt: T0 + FIRST_BACKOFF_MS,
      });
      expect(kinds(db).slice(-2)).toEqual(['node.failed', 'node.retry.scheduled']);
      expect(payloadOf(db, 'node.retry.scheduled')).toEqual({
        node: IMPLEMENT,
        nextAttempt: 1,
        wakeAt: T0 + FIRST_BACKOFF_MS,
      });
      expect(readWakes(db, RETRY_RUN)).toEqual([
        {
          runId: RETRY_RUN,
          nodeId: IMPLEMENT,
          wakeAt: T0 + FIRST_BACKOFF_MS,
          reason: 'backoff',
        },
      ]);
    } finally {
      db.close();
    }
  });

  it('draws the delay from the injected generator, so two nodes do not collide', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      const random = seededRandom(42);
      const first = recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: classified('provider.rate-limited', 'transient'),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random,
      });
      const second = recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: COMPLETED_NODES[0],
        failure: classified('provider.rate-limited', 'transient'),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random,
      });
      expect(second.wakeAt).not.toBe(first.wakeAt);
    } finally {
      db.close();
    }
  });
});

// ── scenario 2: a rollback leaves nothing behind ─────────────────────────────

/**
 * A `Db` that refuses one statement, so the transaction around it rolls back.
 *
 * The rollback has to happen *between* the `node.failed` insert and the wake
 * upsert — anywhere else and the spec would be testing that SQLite works. The
 * refusal is keyed on the SQL text of the upsert, which is the last of the
 * three writes.
 */
function refusingWakeUpsert(inner: Db): Db {
  const refuse: DbStatement<never> = {
    run: () => {
      throw new Error('disk full while writing node_wake');
    },
    get: () => undefined,
    all: () => [],
  };
  return {
    get open(): boolean {
      return inner.open;
    },
    prepare: <Row = Record<string, DbValue>>(sql: string): DbStatement<Row> =>
      /INSERT INTO node_wake/i.test(sql)
        ? (refuse as unknown as DbStatement<Row>)
        : inner.prepare<Row>(sql),
    exec: (sql: string) => {
      inner.exec(sql);
    },
    transaction: <T>(fn: () => T): T => inner.transaction(fn),
    pragma: (source: string) => inner.pragma(source),
    close: () => {
      inner.close();
    },
  };
}

suite('EPIC-06-S20 scenario 2 — a rollback leaves nothing behind (AC6)', () => {
  it('loses the node.failed and the retry event along with the wake row', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      const before = kinds(db).length;

      expect(() =>
        recordNodeFailure(refusingWakeUpsert(db), {
          runId: RETRY_RUN,
          nodeId: IMPLEMENT,
          failure: classified('provider.rate-limited', 'transient'),
          retry: RETRY,
          epoch: 1,
          ts: T0,
          random: seededRandom(42),
        }),
      ).toThrow(/disk full/);

      expect(kinds(db).length).toBe(before);
      expect(kinds(db)).not.toContain('node.failed');
      expect(kinds(db)).not.toContain('node.retry.scheduled');
      expect(readWakes(db, RETRY_RUN)).toEqual([]);
    } finally {
      db.close();
    }
  });

  /**
   * EPIC-06-S20's second scenario ends "and the AUTOINCREMENT values it
   * consumed are burned — the next event's seq has a gap".
   *
   * **They are not**, and that was already established rather than discovered
   * here: `packages/ledger/test/integration/sequence-gaps.test.ts` probed it on
   * better-sqlite3@13.0.2 / SQLite 3.53.4 under this package's own pragmas and
   * corrected the architecture doc. `sqlite_sequence` is an ordinary table, its
   * high-water update is part of the transaction, and `ROLLBACK` — full or to a
   * `SAVEPOINT` — restores it.
   *
   * The contract the scenario draws from it is still right, and this asserts
   * the true reason it is right: the seq after a rolled-back retry is the one
   * the rollback gave back, so a consumer that resumed from `cursor + 1` on the
   * strength of an expected gap would skip a real event. Gaps come from pruning
   * and from one global sequence shared across runs — never from a rollback.
   */
  it('gives its sequence numbers back, so a cursor must resume from > and not + 1', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      const lastBefore = events(db).at(-1)?.seq ?? 0;

      expect(() =>
        recordNodeFailure(refusingWakeUpsert(db), {
          runId: RETRY_RUN,
          nodeId: IMPLEMENT,
          failure: classified('provider.rate-limited', 'transient'),
          retry: RETRY,
          epoch: 1,
          ts: T0,
          random: seededRandom(42),
        }),
      ).toThrow();

      recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: classified('provider.rate-limited', 'transient'),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
      });

      const nextSeq = events(db).find((event) => event.kind === 'node.failed')?.seq;
      expect(nextSeq).toBe(lastBefore + 1);
      // And the rolled-back attempt really did consume numbers that came back:
      // the successful retry occupies the two the failed one would have.
      expect(events(db).at(-1)?.seq).toBe(lastBefore + 2);
    } finally {
      db.close();
    }
  });
});

// ── scenario 3: restarting inside the backoff window ─────────────────────────

suite(
  'EPIC-06-S20 scenario 3 — a restart mid-backoff neither storms nor double-counts (AC7)',
  () => {
    it('reads wakeAt off the row, leaves attempt alone, and starts once at the deadline', async ({
      tmp,
    }) => {
      const readyFile = join(tmp, 'recorded.json');
      const child = startCrashable({ script: CRASH_SCRIPT, args: [tmp, readyFile] });
      alive.push(child);

      await waitFor(
        () => {
          try {
            return typeof JSON.parse(readFileSync(readyFile, 'utf8')).wakeAt === 'number';
          } catch {
            return false;
          }
        },
        { describe: 'the child to record the failure and schedule the backoff', timeoutMs: 20_000 },
      );
      const recorded = JSON.parse(readFileSync(readyFile, 'utf8')) as {
        wakeAt: number;
        nextAttempt: number;
      };

      // Five seconds into a four-minute backoff, the daemon dies.
      await child.sigkill();
      alive.splice(alive.indexOf(child), 1);

      const inner = openLedger(tmp);
      const db = recordingDb(inner);
      try {
        // The wait is the row, and the row survived untouched.
        expect(readWakes(db, RETRY_RUN)).toEqual([
          { runId: RETRY_RUN, nodeId: IMPLEMENT, wakeAt: recorded.wakeAt, reason: 'backoff' },
        ]);

        const state = stateOf(db);
        // Attempt did not move: one failure, one retry scheduled, and nothing
        // about a restart counts as an attempt.
        expect(state.nodes[IMPLEMENT]?.attempt).toBe(0);
        expect(state.nodes[IMPLEMENT]?.attempts).toBe(1);
        expect(state.nodes[IMPLEMENT]?.status).toBe('awaiting-retry');
        expect(state.nodes[IMPLEMENT]?.wakeAt).toBe(recorded.wakeAt);

        db.forget();
        // A real tick of the restarted loop, for the whole window: `decide()`
        // restates the pending wake on every tick, and the upsert is skipped
        // because the row already says exactly this. That is what "re-derives the
        // same wakeAt from the row rather than recomputing it" means in writes.
        for (let elapsed = 0; elapsed < recorded.wakeAt - T0; elapsed += 5_000) {
          const commands = decide(state, T0 + elapsed);
          expect(commands.filter((command) => command.kind === 'StartNode')).toEqual([]);
          for (const command of commands) {
            if (command.kind !== 'ScheduleWake') continue;
            expect(command.wakeAt).toBe(recorded.wakeAt);
            scheduleWakeIfChanged(db, {
              runId: command.runId,
              nodeId: command.node,
              wakeAt: command.wakeAt,
              reason: command.reason,
            });
          }
        }
        // No new draw, no new row: a restart inside the window is free.
        expect(db.writes).toEqual([]);

        const admitted = startsOf(state, recorded.wakeAt);
        expect(admitted.map((command) => command.node)).toEqual([IMPLEMENT]);
        expect(admitted[0]?.attempt).toBe(recorded.nextAttempt);
      } finally {
        db.close();
      }
    });
  },
);

// ── permanent ────────────────────────────────────────────────────────────────

suite('AC3 — a permanent failure writes no wake row at all', () => {
  it('records node.failed and nothing else', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      const recorded = recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: classified('adapter.spawn-failed', 'permanent'),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
      });

      expect(recorded.plan).toEqual({ action: 'fail', exhausted: false });
      expect(recorded.wakeAt).toBeNull();
      expect(kinds(db).at(-1)).toBe('node.failed');
      expect(kinds(db)).not.toContain('node.retry.scheduled');
      expect(readWakes(db, RETRY_RUN)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('and decide() then fails every node downstream of it', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: classified('adapter.spawn-failed', 'permanent'),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
      });

      const emitted = decide(stateOf(db), T0).filter((command) => command.kind === 'EmitEvent');
      expect(emitted.map((command) => command.node).sort()).toEqual([...PENDING_NODES].sort());
    } finally {
      db.close();
    }
  });

  it('preserves the last failure when the attempt budget is spent', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      const recorded = recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        // Attempt index 2 is the third and last of maxAttempts: 3.
        failure: classified('provider.rate-limited', 'transient', 2),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
      });

      expect(recorded.plan).toEqual({ action: 'fail', exhausted: true });
      expect(readWakes(db, RETRY_RUN)).toEqual([]);
      const failed = stateOf(db).nodes[IMPLEMENT]?.failure;
      expect(failed?.reason).toBe('provider.rate-limited');
      expect(failed?.class).toBe('transient');
    } finally {
      db.close();
    }
  });
});

// ── gate ─────────────────────────────────────────────────────────────────────

suite('AC4 — a gate suspends the node and asks a human', () => {
  it('appends node.failed, node.suspended and run.needs_human, and no wake row', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      const recorded = recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: classified('effect.reconcile-unknown', 'gate'),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
      });

      expect(recorded.plan).toEqual({ action: 'gate' });
      expect(kinds(db).slice(-3)).toEqual(['node.failed', 'node.suspended', 'run.needs_human']);
      expect(payloadOf(db, 'run.needs_human')).toMatchObject({ reason: 'reconcile-unknown' });
      expect(String(payloadOf(db, 'run.needs_human')?.detail)).toContain(
        'effect.reconcile-unknown',
      );
      expect(readWakes(db, RETRY_RUN)).toEqual([]);

      const state = stateOf(db);
      expect(state.nodes[IMPLEMENT]?.status).toBe('suspended');
      expect(state.status).toBe('needs-human');
      for (let tick = 0; tick < 1_000; tick += 1) {
        expect(startsOf(state, T0 + tick * 1_000)).toEqual([]);
      }
    } finally {
      db.close();
    }
  });
});

// ── the budget ceiling ───────────────────────────────────────────────────────

suite('EPIC-06-S31 — a budget ceiling pauses the run instead of failing it (AC9)', () => {
  const breach = { scope: 'run', dimension: 'cost', limit: 20, actual: 21.4 } as const;

  it('pauses the run with budget.exceeded, never a permanent node.failed', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      const before = events(db).filter((event) => event.kind === 'node.completed').length;

      const recorded = recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: classified('budget.cost-exceeded', 'gate', 0, { ...breach }),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
      });

      expect(recorded.plan).toEqual({ action: 'gate' });
      // KAR-14.2 AC2 — the trip appends all three, in this order: the pause is
      // what a resume reverses, and the ask is what puts the run in front of a
      // human. A pause with no ask never reaches the approval queue.
      expect(kinds(db).slice(-5)).toEqual([
        'node.failed',
        'node.suspended',
        'budget.exceeded',
        'run.paused',
        'run.needs_human',
      ]);
      expect(payloadOf(db, 'budget.exceeded')).toEqual({
        ...breach,
        // A breach that arrives through a *failure* came from an adapter
        // reporting a vendor's own refusal; DeFlow's own ceiling is checked in
        // `decide()` and never becomes a node failure (KAR-14.2 AC9).
        firedBy: 'vendor',
        failureClass: 'gate',
      });
      expect(payloadOf(db, 'run.needs_human')).toMatchObject({ reason: 'budget' });
      expect(payloadOf(db, 'run.paused')).toMatchObject({ by: 'policy' });

      const failed = payloadOf(db, 'node.failed')?.failure as { class: string };
      expect(failed.class).toBe('gate');
      expect(failed.class).not.toBe('permanent');

      const state = stateOf(db);
      expect(state.status).toBe('paused');
      expect(state.budget.breaches).toEqual([{ ...breach, firedBy: 'vendor' }]);
      expect(startsOf(state, T0)).toEqual([]);

      // Six completed nodes, their results untouched by the pause.
      expect(events(db).filter((event) => event.kind === 'node.completed').length).toBe(before);
      for (const node of COMPLETED_NODES) {
        expect(state.nodes[node]?.status).toBe('completed');
        expect(state.nodes[node]?.result).not.toBeNull();
      }
    } finally {
      db.close();
    }
  });

  it('behaves identically for a wall-clock ceiling', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: classified('budget.wallclock-exceeded', 'gate', 0, {
          scope: 'node',
          dimension: 'wallclock',
          limit: 600_000,
          actual: 601_000,
        }),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
      });

      expect(payloadOf(db, 'budget.exceeded')).toMatchObject({ dimension: 'wallclock' });
      expect(kinds(db)).toContain('run.paused');
      expect(stateOf(db).status).toBe('paused');
    } finally {
      db.close();
    }
  });
});

// ── reroute ──────────────────────────────────────────────────────────────────

suite('EPIC-06-S18 scenario 4 — a reroute is proposed, never silent (AC8)', () => {
  it('emits a plan.patch.proposed replacing the provider, beside the backoff', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      const recorded = recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: classified('provider.rate-limited', 'transient'),
        retry: { ...RETRY, onFailure: [{ when: 'provider.rate-limited', action: 'reroute' }] },
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
        providers: { current: 'claude-code', prefer: PREFER },
      });

      expect(recorded.plan).toMatchObject({ action: 'reroute', provider: 'codex' });
      expect(kinds(db).slice(-3)).toEqual([
        'node.failed',
        'node.retry.scheduled',
        'plan.patch.proposed',
      ]);

      const patch = payloadOf(db, 'plan.patch.proposed')?.patch as PlanPatch;
      expect(patch.proposedBy).toBe('scheduler');
      expect(patch.ops).toEqual([{ op: 'replace-provider', node: IMPLEMENT, provider: 'codex' }]);
      // The proposal does not change the executing plan — that is what makes it
      // visible in the scrubber rather than a silent swap.
      expect(stateOf(db).planVersion).toBe(1);
      expect(readWakes(db, RETRY_RUN)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
