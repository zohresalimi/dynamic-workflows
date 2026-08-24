/**
 * KAR-23.12 — a run is never concluded while one of its nodes is running, and
 * the wedge budget never abandons a live child.
 *
 * The invariant on its own, at the `executeRun` level. `./run-budget-orphan.test.ts`
 * is the same defect seen from `drive.ts`, which is where the incident happened;
 * this file is the two claims underneath it, stated where they can be read.
 *
 * On `run_20260824T143505Z_3a7365` the executor's whole-run deadline expired
 * while a node was working, `executeOneRun` abandoned the promise it was
 * holding, the orphan kept appending `node.progress`, the head moved, the next
 * tick re-entered `executeRun` with a **fresh empty** in-flight set — and there
 * `commands.length === 0 && inflight.size === 0` read as *"nothing is
 * running"*. It appended `run.aborted { failed }` at 15:22:33; the node it was
 * abandoning appended `node.completed` at 15:22:48.
 *
 * Two independent defects, so two independent claims:
 *
 *  1. **The in-memory set is this process's opinion; the ledger is the run's
 *     own record.** A conclusion is guarded on the projection, so a loop that
 *     is not holding a promise for a `running` node still knows it is running.
 *  2. **A live child is not a wedge.** The budget measures *no progress*, and
 *     it never fires while something is in flight — because the only thing the
 *     loop can do about a live child is abandon it, which is the mechanism
 *     above.
 *
 * The third case is the one that stops (2) being "fixed by deleting the
 * budget": a loop spinning on commands that change nothing, with nothing in
 * flight, still wedges.
 *
 * Verifies: KAR-23.12
 */
import type { Db, NodeId, RunId, StartNode } from '@DeFlow/core';
import { NodeFailureError, NodeIdSchema, RunIdSchema, seededRandom } from '@DeFlow/core';
import { appendEvents, type EventDraft, openLedger, readRange } from '@DeFlow/ledger';
import { it, TestClock } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { systemClock } from '../../src/clock.ts';
import { createEffectRunner } from '../../src/effects/durable.ts';
import { executeRun } from '../../src/exec/run-executor.ts';

const RUN: RunId = RunIdSchema.parse('run_20260824T143505Z_3a7365');
const ALPHA: NodeId = NodeIdSchema.parse('alpha');
const BETA: NodeId = NodeIdSchema.parse('beta');

const T0 = 1_756_045_505_000;
const EPOCH = 7;
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const RANDOM = seededRandom(1109);

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

/** A `tool` node the performer stands in for: what is under test is the loop. */
const node = (
  id: NodeId,
  deps: readonly NodeId[] = [],
  maxAttempts = 1,
): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  type: 'tool',
  tool: { kind: 'script', run: 'true' },
  effectClass: 'pure',
  deps: [...deps],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  // An hour of backoff, so a scheduled retry never comes due inside a spec.
  retry: { maxAttempts, backoff: { base: 3_600_000, cap: 7_200_000, jitter: 'full' } },
  budget: {},
});

function plan(nodes: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version: 1,
    planHash: PLAN_HASH,
    parent: null,
    taskSpecHash: SPEC_HASH,
    createdBy: 'planner',
    createdAt: '2026-08-24T14:35:05.000Z',
    nodes: [...nodes],
    edges: nodes.length === 2 ? [{ from: ALPHA, to: BETA, kind: 'control' }] : [],
  };
}

function seed(db: Db, graph: Record<string, unknown>): void {
  appendEvents(db, [
    {
      runId: RUN,
      ts: T0,
      kind: 'run.created',
      v: 1,
      epoch: EPOCH,
      payload: { spec: taskSpec, cwd: '/home/u/proj', repo: { head: 'e83c516', branch: 'main' } },
    },
    {
      runId: RUN,
      ts: T0,
      kind: 'run.spec.approved',
      v: 1,
      epoch: EPOCH,
      payload: { specHash: SPEC_HASH, by: 'ui' },
    },
    {
      runId: RUN,
      ts: T0,
      kind: 'plan.proposed',
      v: 2,
      epoch: EPOCH,
      payload: { version: 1, planHash: PLAN_HASH, graph, by: 'planner' },
    },
    {
      runId: RUN,
      ts: T0,
      kind: 'run.started',
      v: 1,
      epoch: EPOCH,
      payload: { planHash: PLAN_HASH },
    },
  ]);
}

const started = (id: NodeId, attempt = 0): EventDraft => ({
  runId: RUN,
  ts: T0,
  kind: 'node.started',
  v: 2,
  epoch: EPOCH,
  nodeId: id,
  attempt,
  payload: {
    node: id,
    attempt,
    ikey: `${RUN}/${id}/${String(attempt)}/0`,
    binary: { path: '/bin/true', version: '0.0.0', sha256: 'f'.repeat(64) },
  },
});

const completed = (id: NodeId, attempt = 0): EventDraft => ({
  runId: RUN,
  ts: T0,
  kind: 'node.completed',
  v: 1,
  epoch: EPOCH,
  nodeId: id,
  attempt,
  payload: {
    node: id,
    attempt,
    result: {
      status: 'completed',
      output: { summary: `${id} done` },
      outputSchemaId: 'DeFlow.finding.v1',
      usage: { inputTokens: 0, outputTokens: 0, source: 'vendor-reported' },
      costUsd: 0,
      producedFacts: [],
      artifacts: [],
    },
  },
});

const kinds = (db: Db): string[] => readRange(db, RUN, 0, 2_000).events.map((event) => event.kind);

/** Real milliseconds: there is no child here, but the budget is wall-clock. */
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// ── (1) a node this loop is not holding a promise for is still running ───────

suite('KAR-23.12 — a run with a running node is not concluded', () => {
  it('returns without a verdict when the ledger says a node is live', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seed(db, plan([node(ALPHA), node(BETA, [ALPHA])]));
      // The orphan's own record: `alpha` started and never ended. This is
      // exactly the state a re-entered `executeRun` finds after the abandoned
      // promise moved the head.
      appendEvents(db, [started(ALPHA)]);

      const clock = new TestClock(T0);
      const result = await executeRun({
        db,
        runId: RUN,
        clock,
        epoch: EPOCH,
        daemonStartedAt: T0,
        random: RANDOM,
        tickStepMs: 0,
        tickMs: 1,
        budgetMs: 30,
        wallClock: systemClock,
        sleep,
        effects: createEffectRunner({ db, clock, daemonStartedAt: T0, epoch: EPOCH }),
        perform: (command: StartNode) => {
          throw new Error(`nothing may be performed here, and ${command.node} was`);
        },
      });

      // The whole of the defect: `run.aborted { failed }` over a healthy node.
      expect(kinds(db)).not.toContain('run.aborted');
      expect(kinds(db)).not.toContain('run.completed');
      expect(result.state.nodes[ALPHA]?.status).toBe('running');
      expect(result.state.status).toBe('running');
    } finally {
      db.close();
    }
  });
});

// ── (2) the budget never abandons a promise this loop is holding ─────────────

suite('KAR-23.12 — a node that outruns the budget is not abandoned', () => {
  it('waits for the in-flight node and then concludes the run itself', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seed(db, plan([node(ALPHA), node(BETA, [ALPHA])]));

      const clock = new TestClock(T0);
      let resolvedAt = 0;
      const result = await executeRun({
        db,
        runId: RUN,
        clock,
        epoch: EPOCH,
        daemonStartedAt: T0,
        random: RANDOM,
        tickStepMs: 0,
        tickMs: 1,
        // Twenty milliseconds against a node that takes ten times that: on
        // `master` this is the throw that orphaned the incident's fifth node.
        budgetMs: 20,
        wallClock: systemClock,
        sleep,
        effects: createEffectRunner({ db, clock, daemonStartedAt: T0, epoch: EPOCH }),
        perform: async (command: StartNode) => {
          appendEvents(db, [started(command.node, command.attempt)]);
          await sleep(200);
          appendEvents(db, [completed(command.node, command.attempt)]);
          resolvedAt = Date.now();
        },
      });

      expect(result.state.status).toBe('completed');
      expect(kinds(db)).toContain('run.completed');
      expect(kinds(db)).not.toContain('run.aborted');
      // The promise was not abandoned: the loop outlived the performer.
      expect(resolvedAt).toBeGreaterThan(0);
      expect(Date.now()).toBeGreaterThanOrEqual(resolvedAt);
      // Both nodes ran, in order — the second could not have started if the
      // first had been concluded over.
      expect(result.started.map((one) => one.node)).toEqual([ALPHA, BETA]);
    } finally {
      db.close();
    }
  });
});

// ── (3) the wedge detector still detects a wedge ─────────────────────────────

suite('KAR-23.12 — a loop that is genuinely going nowhere still wedges', () => {
  it('throws when nothing is in flight and the log has stopped moving', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seed(db, plan([node(ALPHA, [], 3)]));

      const clock = new TestClock(T0);
      const running = executeRun({
        db,
        runId: RUN,
        clock,
        epoch: EPOCH,
        daemonStartedAt: T0,
        random: RANDOM,
        // The injected clock never moves, so the hour of backoff the failure
        // scheduled never comes due: `decide()` re-issues the same
        // `ScheduleWake` for ever, nothing is in flight, and the log stands
        // still. That is a wedge, and it is the one this budget is for.
        tickStepMs: 0,
        tickMs: 1,
        budgetMs: 60,
        wallClock: systemClock,
        sleep,
        effects: createEffectRunner({ db, clock, daemonStartedAt: T0, epoch: EPOCH }),
        perform: (command: StartNode) => {
          appendEvents(db, [started(command.node, command.attempt)]);
          return Promise.reject(
            new NodeFailureError('the tool did not answer', {
              reason: 'timeout',
              class: 'transient',
            }),
          );
        },
      });

      await expect(running).rejects.toThrow(/wedged/);
    } finally {
      db.close();
    }
  });
});
