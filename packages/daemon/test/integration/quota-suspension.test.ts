/**
 * KAR-14.4 — a rate limit costs one SQLite row and zero CPU.
 *
 * A real ledger file, a real `kill -9`, a `TestClock` and no fake timers. What
 * is under test is the transaction: `node.failed`, `node.suspended` and the
 * `node_wake` row at the vendor's own `resetsAt` land together, or the
 * suspension is a lie. Split them and a restart inside the window either loses
 * the deadline — an immediate retry against a vendor that has just said no —
 * or double-counts the attempt and burns the node's budget on a failure that
 * never happened.
 *
 * Verifies: EPIC-14-S21, EPIC-14-S23, EPIC-14-S25, EPIC-14-S26 ·
 * AC2, AC3, AC5, AC6, AC8
 */
import type {
  Db,
  Handle,
  NodeFailure,
  NodeId,
  ProviderId,
  RunId,
  RunState,
  StartNode,
} from '@DeFlow/core';
import { decide, initialRunState, rateLimitedFailure, seededRandom } from '@DeFlow/core';
import {
  appendEvents,
  openLedger,
  readRange,
  readWakes,
  replayAll,
  scheduleWakeIfChanged,
} from '@DeFlow/ledger';
import { type Crashable, it, startCrashable, waitFor } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { recordNodeFailure } from '../../src/retry.ts';
import { recordingDb } from './support/recording-db.ts';
import {
  COMPLETED_NODES,
  IMPLEMENT,
  IMPLEMENT_NODE,
  PENDING_NODES,
  RETRY_RUN,
  seedRetryRun,
  T0,
} from './support/retry-run.ts';

const CRASH_SCRIPT = fileURLToPath(new URL('./support/hang-in-quota.ts', import.meta.url));

const alive: Crashable[] = [];

afterEach(async () => {
  await Promise.all(alive.splice(0).map((child) => child.sigkill()));
});

const RETRY = IMPLEMENT_NODE.retry;
const CLAUDE = 'claude-code' as ProviderId;
const hours = (count: number): number => count * 3_600_000;
const RESETS_AT = T0 + hours(4);

/** The vendor frame, verbatim, exactly as docs/07 §8.1 records it. */
const FRAME = {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', resetsAt: RESETS_AT / 1000 },
};

const limited = (resetsAt: number | null, raw: unknown = FRAME, attempt = 0): NodeFailure =>
  rateLimitedFailure(
    { provider: CLAUDE, resetsAt, raw },
    {
      occurredAtEvent: 1 as never,
      attempt,
      captureEvidence: (): Handle => `artifact://${'0'.repeat(64)}` as Handle,
    },
  );

const stateOf = (db: Db): RunState => replayAll(db).runs.get(RETRY_RUN) ?? initialRunState();

const events = (db: Db) => readRange(db, RETRY_RUN, 0, 500).events;

const kinds = (db: Db): string[] => events(db).map((event) => event.kind);

const payloadOf = (db: Db, kind: string): Record<string, unknown> | undefined =>
  events(db).find((event) => event.kind === kind)?.payload as Record<string, unknown> | undefined;

const startsOf = (state: RunState, now: number): StartNode[] =>
  decide(state, now).filter((command): command is StartNode => command.kind === 'StartNode');

// ── the NF7 fixture: two branches that share nothing ─────────────────────────

const NF7_RUN = 'run_20260805T090000Z_5c1d28' as RunId;
const DOCS = 'docs' as NodeId;
const NF7_PLAN_HASH = `sha256-${'b'.repeat(64)}`;

const nf7Node = (id: string): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2_000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `brief for ${id}`,
  provider: { prefer: ['claude-code'], requires: [] },
  resume: 'always-replay',
});

/**
 * A run of exactly two independent nodes, one of which is about to be
 * rate-limited. Nothing depends on anything, so "the other branch kept going"
 * is a claim about admission rather than about the graph's shape.
 */
function seedIndependentRun(db: Db): void {
  appendEvents(db, [
    {
      runId: NF7_RUN,
      ts: T0,
      kind: 'plan.proposed',
      v: 1,
      epoch: 1,
      payload: {
        version: 1,
        planHash: NF7_PLAN_HASH,
        graph: {
          schemaId: 'DeFlow.plangraph.v1',
          runId: NF7_RUN,
          version: 1,
          planHash: NF7_PLAN_HASH,
          parent: null,
          taskSpecHash: `sha256-${'c'.repeat(64)}`,
          createdBy: 'planner',
          createdAt: '2026-08-05T09:00:00.000Z',
          nodes: [nf7Node(IMPLEMENT), nf7Node(DOCS)],
          edges: [],
        },
        by: 'planner',
      },
    },
    {
      runId: NF7_RUN,
      ts: T0,
      kind: 'run.started',
      v: 1,
      epoch: 1,
      payload: { planHash: NF7_PLAN_HASH },
    },
    {
      runId: NF7_RUN,
      ts: T0,
      kind: 'node.started',
      v: 1,
      epoch: 1,
      nodeId: IMPLEMENT,
      attempt: 0,
      payload: { node: IMPLEMENT, attempt: 0, ikey: `${NF7_RUN}/${IMPLEMENT}/0/0` },
    },
  ]);
}

// ── EPIC-14-S21 — resetsAt becomes a row, in the same transaction ────────────

suite('EPIC-14-S21 — resetsAt becomes a node_wake row and the run sleeps for free', () => {
  it('AC2, AC3: the failure, the suspension and the quota row commit together', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      const recorded = recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: limited(RESETS_AT),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
      });

      expect(recorded.wakeAt).toBe(RESETS_AT);
      expect(kinds(db).slice(-3)).toEqual([
        'node.failed',
        'node.suspended',
        'node.retry.scheduled',
      ]);

      // AC2: the suspension names the instant it is waiting for.
      expect(payloadOf(db, 'node.suspended')).toEqual({
        node: IMPLEMENT,
        until: { kind: 'quota', wakeAt: new Date(RESETS_AT).toISOString() },
      });

      // AC2: one row, reason `quota`, wake_at exactly the vendor's own instant.
      expect(readWakes(db, RETRY_RUN)).toEqual([
        { runId: RETRY_RUN, nodeId: IMPLEMENT, wakeAt: RESETS_AT, reason: 'quota' },
      ]);

      // AC9: the class on the log is transient, never a gate and never permanent.
      const failed = payloadOf(db, 'node.failed') as { failure: NodeFailure };
      expect(failed.failure.class).toBe('transient');
    } finally {
      db.close();
    }
  });

  it('AC2: the node holds no slot while it sleeps, and its siblings keep running', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: limited(RESETS_AT),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
      });

      const state = stateOf(db);
      expect(state.nodes[IMPLEMENT]?.wakeAt).toBe(RESETS_AT);
      expect(startsOf(state, T0).map((command) => command.node)).not.toContain(IMPLEMENT);
      // The run is neither paused nor failed — NF7 in one assertion.
      expect(state.status).toBe('running');
    } finally {
      db.close();
    }
  });

  it('AC2: advancing the clock to the reset admits the node again, once', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: limited(RESETS_AT),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
      });

      const state = stateOf(db);
      expect(startsOf(state, RESETS_AT - 1).map((command) => command.node)).not.toContain(
        IMPLEMENT,
      );
      const admitted = startsOf(state, RESETS_AT).filter((one) => one.node === IMPLEMENT);
      expect(admitted).toHaveLength(1);
      expect(admitted[0]?.attempt).toBe(1);
    } finally {
      db.close();
    }
  });

  it('AC2: a suspended node costs no writes at all between ticks', async ({ tmp }) => {
    const inner = openLedger(tmp);
    const db = recordingDb(inner);
    try {
      seedRetryRun(db);
      recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: limited(RESETS_AT),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
      });

      const state = stateOf(db);
      db.forget();
      // Four hours of ticking, at ten-minute strides. Every tick restates the
      // wake; the upsert is skipped because the row already says exactly this.
      for (let elapsed = 0; elapsed < hours(4); elapsed += 600_000) {
        for (const command of decide(state, T0 + elapsed)) {
          if (command.kind !== 'ScheduleWake') continue;
          expect(command.wakeAt).toBe(RESETS_AT);
          expect(command.reason).toBe('quota');
          scheduleWakeIfChanged(db, {
            runId: command.runId,
            nodeId: command.node,
            wakeAt: command.wakeAt,
            reason: command.reason,
          });
        }
      }
      expect(db.writes).toEqual([]);
    } finally {
      db.close();
    }
  });
});

// ── EPIC-14-S24 — the reroute, when the plan asks for one ───────────────────

suite('EPIC-14-S24 — a quota reroute is proposed with its cause on the record', () => {
  /** F4.5: "retry with a different provider" is policy on the node, so the
   * reroute is what the plan asked for rather than something the scheduler
   * decided by itself. */
  const REROUTING = {
    ...RETRY,
    onFailure: [{ when: 'provider.rate-limited', action: 'reroute' }],
  } as const;

  it('AC7: the proposal names cause quota, and the reason is rendered verbatim', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      const recorded = recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: limited(RESETS_AT),
        retry: REROUTING,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
        providers: { current: CLAUDE, prefer: [CLAUDE, 'codex' as ProviderId] },
      });

      expect(recorded.plan.action).toBe('reroute');
      const proposed = payloadOf(db, 'plan.patch.proposed') as {
        cause?: string;
        patch: { reason: string; ops: readonly { op: string; provider?: string }[] };
      };

      expect(proposed.cause).toBe('quota');
      expect(proposed.patch.ops).toEqual([
        { op: 'replace-provider', node: IMPLEMENT, provider: 'codex' },
      ]);
      expect(proposed.patch.reason).toContain('cause: quota');
      // Still a suspension at the vendor's own instant: proposing a swap is not
      // applying one, and until somebody rules on the patch the node waits
      // exactly as long as the vendor said.
      expect(readWakes(db, RETRY_RUN)).toEqual([
        { runId: RETRY_RUN, nodeId: IMPLEMENT, wakeAt: RESETS_AT, reason: 'quota' },
      ]);
    } finally {
      db.close();
    }
  });

  it('AC7: a reroute for any other reason states no cause rather than claiming quota', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: {
          reason: 'timeout',
          class: 'transient',
          message: 'the agent stopped answering',
          evidence: [],
          occurredAtEvent: 1 as never,
          attempt: 0,
        },
        retry: { ...RETRY, onFailure: [{ when: 'timeout', action: 'reroute' }] },
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
        providers: { current: CLAUDE, prefer: [CLAUDE, 'codex' as ProviderId] },
      });

      const proposed = payloadOf(db, 'plan.patch.proposed') as { cause?: string };
      expect(proposed.cause).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('AC8: with no alternative provider, nothing is proposed and the node still sleeps', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: limited(RESETS_AT),
        retry: REROUTING,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
        // The caller filters `prefer` to providers that actually satisfy the
        // node — the probe cache lives on its side of the boundary — so an
        // empty alternative set *is* "no capable healthy provider".
        providers: { current: CLAUDE, prefer: [CLAUDE] },
      });

      expect(kinds(db)).not.toContain('plan.patch.proposed');
      expect(readWakes(db, RETRY_RUN)).toEqual([
        { runId: RETRY_RUN, nodeId: IMPLEMENT, wakeAt: RESETS_AT, reason: 'quota' },
      ]);
    } finally {
      db.close();
    }
  });
});

// ── EPIC-14-S23 — the suspension survives kill -9 and a laptop sleep ─────────

suite('EPIC-14-S23 — the suspension survives kill -9 and a laptop sleep (AC5)', () => {
  it('keeps the row unchanged and wakes at resetsAt, not at restart time', async ({ tmp }) => {
    const readyFile = join(tmp, 'suspended.json');
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
      { describe: 'the child to suspend the node on the vendor reset', timeoutMs: 20_000 },
    );
    const recorded = JSON.parse(readFileSync(readyFile, 'utf8')) as { wakeAt: number };

    await child.sigkill();
    alive.splice(alive.indexOf(child), 1);

    const db = openLedger(tmp);
    try {
      // The wait is the row, and the row survived untouched.
      expect(readWakes(db, RETRY_RUN)).toEqual([
        { runId: RETRY_RUN, nodeId: IMPLEMENT, wakeAt: recorded.wakeAt, reason: 'quota' },
      ]);

      const state = stateOf(db);
      // The attempt counter did not move: a restart is not an attempt.
      expect(state.nodes[IMPLEMENT]?.attempt).toBe(0);
      expect(state.nodes[IMPLEMENT]?.attempts).toBe(1);
      expect(state.nodes[IMPLEMENT]?.wakeAt).toBe(recorded.wakeAt);

      // Two hours of wall clock passed while the daemon was down — the laptop
      // was asleep, and a timer would have simply not fired. The row does not
      // care: it is an instant, so the first tick after the restart still
      // refuses, and the tick at `resetsAt` admits.
      expect(startsOf(state, T0 + hours(2)).map((one) => one.node)).not.toContain(IMPLEMENT);
      expect(startsOf(state, recorded.wakeAt).map((one) => one.node)).toContain(IMPLEMENT);
    } finally {
      db.close();
    }
  });
});

// ── EPIC-14-S25 — no capable provider: suspend, do not kill the run ──────────

suite('EPIC-14-S25 — one provider unavailable degrades the plan (AC8, NF7)', () => {
  it('suspends the node, proposes no reroute, and keeps an independent branch alive', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      const resetsAt = T0 + hours(6);
      recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: limited(resetsAt),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
        // No alternative is offered, because none is capable. The scheduler must
        // not invent one, and must not treat "nowhere to go" as a reason to fail.
        providers: { current: CLAUDE, prefer: [CLAUDE] },
      });

      expect(kinds(db)).not.toContain('plan.patch.proposed');
      expect(kinds(db)).not.toContain('run.paused');
      expect(kinds(db)).not.toContain('run.needs_human');
      expect(readWakes(db, RETRY_RUN)).toEqual([
        { runId: RETRY_RUN, nodeId: IMPLEMENT, wakeAt: resetsAt, reason: 'quota' },
      ]);

      const state = stateOf(db);
      // NF7 in one assertion: the run is not paused, not failed and not aborted.
      expect(state.status).toBe('running');
      // The two nodes that do not start are held by their *dependency* on the
      // suspended one, not by the run having stopped. Both are still `scheduled`
      // and both become admissible the moment `implement` completes — which is
      // the difference between a degraded plan and a dead run.
      for (const pending of PENDING_NODES) {
        expect(state.nodes[pending]?.status ?? 'scheduled').toBe('scheduled');
      }
      expect(decide(state, T0).some((command) => command.kind === 'CancelNode')).toBe(false);
    } finally {
      db.close();
    }
  });

  /**
   * The half the nine-node fixture cannot show: a branch with no dependency on
   * the limited node keeps going. `seedRetryRun`'s graph fans everything
   * downstream of `implement` on purpose (it exists to prove a *pause* leaves
   * work intact), so the independent branch is seeded here, as its own run in
   * the same real ledger file.
   */
  it('admits an independent branch while the limited node sleeps', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedIndependentRun(db);
      const resetsAt = T0 + hours(6);
      recordNodeFailure(db, {
        runId: NF7_RUN,
        nodeId: IMPLEMENT,
        failure: limited(resetsAt),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
        providers: { current: CLAUDE, prefer: [CLAUDE] },
      });

      const state = replayAll(db).runs.get(NF7_RUN) ?? initialRunState();
      const admitted = startsOf(state, T0).map((command) => command.node);

      expect(admitted).not.toContain(IMPLEMENT);
      expect(admitted).toContain(DOCS);
      expect(state.status).toBe('running');
      expect(readWakes(db, NF7_RUN)).toEqual([
        { runId: NF7_RUN, nodeId: IMPLEMENT, wakeAt: resetsAt, reason: 'quota' },
      ]);
    } finally {
      db.close();
    }
  });
});

// ── EPIC-14-S26 — correlated limits, three distinct jittered wakes ───────────

suite('EPIC-14-S26 — three nodes trip the same limit in one tick (AC6)', () => {
  it('gives each a distinct wake_at, each in its own transaction', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      const random = seededRandom(42);
      const nodes = COMPLETED_NODES.slice(0, 3);

      const wakes = nodes.map(
        (node) =>
          recordNodeFailure(db, {
            runId: RETRY_RUN,
            nodeId: node,
            // No resetsAt: the vendor said it was limited and not when it lifts.
            failure: limited(null, { exitCode: 77 }),
            retry: RETRY,
            epoch: 1,
            ts: T0,
            random,
          }).wakeAt,
      );

      expect(new Set(wakes).size).toBe(3);
      for (const wakeAt of wakes) {
        expect(wakeAt).toBeGreaterThanOrEqual(T0);
        expect(wakeAt).toBeLessThan(T0 + 2_000);
      }

      // Blind backoff, honestly labelled: reason `backoff`, not `quota`. A
      // `quota` row would claim DeFlow knows when the vendor lifts the limit.
      const rows = readWakes(db, RETRY_RUN).filter((row) => nodes.includes(row.nodeId as never));
      expect(rows.map((row) => row.reason)).toEqual(['backoff', 'backoff', 'backoff']);

      // AC3: each ledger entry pairs node.failed with node.retry.scheduled.
      const paired = events(db).filter(
        (event) => event.kind === 'node.failed' || event.kind === 'node.retry.scheduled',
      );
      expect(paired).toHaveLength(6);
    } finally {
      db.close();
    }
  });

  it('AC6: and no node.suspended is written when there is no instant to name', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRetryRun(db);
      recordNodeFailure(db, {
        runId: RETRY_RUN,
        nodeId: IMPLEMENT,
        failure: limited(null, { exitCode: 77 }),
        retry: RETRY,
        epoch: 1,
        ts: T0,
        random: seededRandom(42),
      });

      expect(kinds(db)).not.toContain('node.suspended');
      expect(kinds(db).slice(-2)).toEqual(['node.failed', 'node.retry.scheduled']);
    } finally {
      db.close();
    }
  });
});
