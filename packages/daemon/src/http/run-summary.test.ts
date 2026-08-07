/**
 * KAR-14.1 AC8 — the run summary `GET /api/runs/:id` serialises.
 *
 * The rollup reaches an operator through the ordinary run summary and through
 * the ordinary event stream, and through nothing else. AC8 says so in its last
 * clause — *"no separate polling endpoint exists"* — and the reason is the one
 * the rest of the story is built on: the accounting figures are a **reducer
 * projection**, so anything that serves them from a second source is serving a
 * number that a `kill -9` can disagree with.
 *
 * This file is the pure half: `RunState` in, the response body out. The route
 * that calls it, the 404, and the SSE frames that keep a client's copy current
 * are `test/integration/run-rollup-api.test.ts`.
 *
 * The negative assertions are the load-bearing ones. A summary is exactly where
 * somebody eventually adds `costUsd: number` "for the header", and that field
 * would be the mixed figure `cost-rollup.ts` exists to make unrepresentable:
 * subscription quota added to real currency, vendor truth added to a Tier-2
 * estimate, and an unmeasurable provider's `null` silently read as zero.
 *
 * Verifies: EPIC-14-S1 · KAR-14.1 AC3, AC4, AC8
 */
import {
  type EstimatorInputs,
  EVENT_SCHEMAS,
  type Event,
  type EventKind,
  initialRunState,
  parseEvent,
  type RunId,
  RunIdSchema,
  type RunState,
  reduce,
} from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { runSummary } from './run-summary.ts';

const RUN: RunId = RunIdSchema.parse('run_20260802T141133Z_9f2a1c');
const TS = 1_754_313_093_000;

function event(kind: EventKind, payload: unknown, seq: number): Event {
  const parsed = parseEvent({
    seq,
    runId: RUN,
    ts: TS,
    kind,
    v: EVENT_SCHEMAS[kind].v,
    epoch: 1,
    payload,
  });
  if (parsed.status !== 'ok') {
    throw new Error(`fixture for ${kind} is not a valid event: ${JSON.stringify(parsed)}`);
  }
  return parsed.event;
}

function fold(events: readonly Event[]): RunState {
  return events.reduce(reduce, initialRunState());
}

/** One node on the subscription path, one on the API-key path, one unmeasurable. */
const MIXED = fold([
  event(
    'budget.consumed',
    {
      node: 'n-impl',
      attempt: 0,
      provider: 'claude',
      usage: { inputTokens: 18_420, outputTokens: 2310, source: 'vendor-reported' },
      costUsd: 0.42,
      authMode: 'subscription',
    },
    2,
  ),
  event(
    'budget.consumed',
    {
      node: 'n-review',
      attempt: 0,
      provider: 'codex',
      usage: { inputTokens: 4000, outputTokens: 200, source: 'estimated' },
      costUsd: 0.11,
      authMode: 'api_key',
    },
    3,
  ),
  event(
    'budget.consumed',
    {
      node: 'n-docs',
      attempt: 0,
      provider: 'gemini',
      usage: { inputTokens: 900, outputTokens: 30, source: 'estimated' },
      costUsd: null,
      authMode: 'subscription',
    },
    4,
  ),
]);

/**
 * KAR-14.2 AC8's second input: what the capability manifest says each provider
 * reports. A stub here rather than the registry, because these specs are about
 * the rollup and a registry lookup would tie them to a vendor table.
 */
const EXACT = (): 'exact' => 'exact';

suite('the run summary carries the rollup the reducer produced (AC8)', () => {
  it('reports the run-level cost figures without collapsing them', () => {
    const summary = runSummary(RUN, MIXED, 4, EXACT);

    expect(summary.runId).toBe(RUN);
    expect(summary.budget.run.costUsd.subscription).toBeCloseTo(0.42, 6);
    expect(summary.budget.run.costUsd.apiKey).toBeCloseTo(0.11, 6);
    expect(summary.budget.run.costUsd.vendorReported).toBeCloseTo(0.42, 6);
    expect(summary.budget.run.costUsd.estimated).toBeCloseTo(0.11, 6);
  });

  it('names the unmeasurable provider rather than counting it as zero (AC4)', () => {
    const summary = runSummary(RUN, MIXED, 4, EXACT);
    expect(summary.budget.run.unaccounted).toEqual(['gemini']);
  });

  it('keys the same spend by node and by provider', () => {
    const summary = runSummary(RUN, MIXED, 4, EXACT);
    expect(Object.keys(summary.budget.nodes).sort()).toEqual(['n-docs', 'n-impl', 'n-review']);
    expect(Object.keys(summary.budget.providers).sort()).toEqual(['claude', 'codex', 'gemini']);
    expect(summary.budget.nodes['n-impl']?.attempts).toHaveLength(1);
  });

  it('adds no summed cost field anywhere in the serialised body (AC3)', () => {
    const body = JSON.parse(JSON.stringify(runSummary(RUN, MIXED, 4, EXACT))) as unknown;

    const totals: string[] = [];
    const walk = (value: unknown, path: string): void => {
      if (value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const [index, item] of value.entries()) walk(item, `${path}[${index}]`);
        return;
      }
      for (const [key, item] of Object.entries(value)) {
        if (/^(total|totalCost|costUsdTotal|sum|grandTotal)$/i.test(key)) {
          totals.push(`${path}.${key}`);
        }
        walk(item, `${path}.${key}`);
      }
    };
    walk(body, '$');

    expect(totals).toEqual([]);
    // …and the one figure a header would be tempted to print is not a number.
    expect((body as { budget: { run: { costUsd: unknown } } }).budget.run.costUsd).not.toBe(
      expect.any(Number),
    );
  });

  it('reports the run status, plan version, node counts and head seq', () => {
    const summary = runSummary(RUN, MIXED, 4, EXACT);
    expect(summary.status).toBe(MIXED.status);
    expect(summary.planVersion).toBe(MIXED.planVersion);
    expect(summary.headSeq).toBe(4);
    expect(summary.watermarkSeq).toBe(MIXED.watermarkSeq);
    // Counts, not the node bodies: the summary is a summary, and the inspector
    // bundle (§7) is where a node's own state is served from.
    expect(summary.nodeCounts).toEqual({});
  });

  it('counts nodes by status once they exist', () => {
    const withNodes = fold([
      event('node.scheduled', { node: 'n-a', provider: 'claude', permission: 'read' }, 2),
      event('node.scheduled', { node: 'n-b', provider: 'claude', permission: 'read' }, 3),
    ]);
    const summary = runSummary(RUN, withNodes, 3, EXACT);
    expect(summary.nodeCounts).toEqual({ scheduled: 2 });
  });
});

/**
 * KAR-14.3 AC3, AC9 — the pre-flight estimate travels beside the rollup, and
 * never inside it.
 *
 * The two figures answer different questions with different authority: the
 * rollup is what a vendor billed, the estimate is what DeFlow thinks a plan
 * nobody has run will cost. AC9 forbids rendering them in the same channel, and
 * the projection is where that is either kept or lost — a summary that folded an
 * estimate into `budget.run.costUsd.estimated` would make every downstream
 * surface render a guess as a measurement, correctly, for ever.
 */
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;

const proposedNode = (id: string): Record<string, unknown> => ({
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
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `brief for ${id}`,
  provider: { prefer: ['claude'], requires: [] },
  model: 'claude-sonnet-4-5',
  resume: 'always-replay',
});

/** A run with a proposal and no `run.started`: the spec-approval surface. */
const PROPOSED = fold([
  event(
    'plan.proposed',
    {
      version: 1,
      planHash: PLAN_HASH,
      graph: {
        schemaId: 'DeFlow.plangraph.v1',
        runId: RUN,
        version: 1,
        planHash: PLAN_HASH,
        parent: null,
        taskSpecHash: SPEC_HASH,
        createdBy: 'planner',
        createdAt: '2026-08-07T09:00:00.000Z',
        nodes: [proposedNode('n-a'), proposedNode('n-b')],
        edges: [],
      },
      by: 'planner',
    },
    2,
  ),
]);

const ESTIMATOR: EstimatorInputs = {
  tokenizer: {
    method: 'heuristic',
    count: (text) => ({ estimated: text.length, method: 'heuristic' }),
  },
  accounting: () => 'exact',
  family: () => 'anthropic',
  calibration: () => ({ n: 24, ratio: 1.18 }),
};

suite('the pre-flight estimate on the approval surface (KAR-14.3 AC3, AC9)', () => {
  it('is present before run.started, over the plan that is only proposed', () => {
    const summary = runSummary(RUN, PROPOSED, 2, EXACT, ESTIMATOR);
    expect(summary.status).toBe('created');
    expect(summary.estimate?.nodes).toHaveLength(2);
    expect(summary.estimate?.costUsd).toBeGreaterThan(0);
  });

  it('labels every figure with its method, factor and sample count', () => {
    const summary = runSummary(RUN, PROPOSED, 2, EXACT, ESTIMATOR);
    expect(summary.estimate?.nodes ?? []).not.toHaveLength(0);
    for (const node of summary.estimate?.nodes ?? []) {
      expect(node.method).toBe('heuristic');
      expect(node.calibration).toMatchObject({ tokenEstimateFactor: 1.18, samples: 24 });
    }
  });

  it('keeps the estimate out of the rollup entirely', () => {
    const summary = runSummary(RUN, PROPOSED, 2, EXACT, ESTIMATOR);
    // Nothing has run, so nothing has been spent — and the estimate did not
    // quietly become a cost cell on the way through.
    expect(summary.budget.run.costUsd).toEqual({
      subscription: null,
      apiKey: null,
      vendorReported: null,
      estimated: null,
    });
    expect(Object.keys(summary)).toContain('estimate');
  });

  it('is null when no estimator was supplied, rather than an invented zero', () => {
    expect(runSummary(RUN, PROPOSED, 2, EXACT).estimate).toBeNull();
  });

  it('serves the per-run estimate-accuracy figure the reducer folded (AC8)', () => {
    const reconciled = fold([
      event(
        'budget.consumed',
        {
          node: 'n-impl',
          attempt: 0,
          provider: 'claude',
          usage: { inputTokens: 18_420, outputTokens: 2310, source: 'vendor-reported' },
          costUsd: 0.42,
          authMode: 'subscription',
          estimate: {
            costUsd: 0.35,
            inputTokens: 15_600,
            method: 'gpt-tokenizer/o200k_base',
            tokenEstimateFactor: 1.2,
            samples: 0,
            seedBased: true,
          },
        },
        2,
      ),
    ]);

    const accuracy = runSummary(RUN, reconciled, 2, EXACT).budget.estimateAccuracy;
    expect(accuracy).toMatchObject({
      samples: 1,
      estimatedCostUsd: 0.35,
      actualCostUsd: 0.42,
    });
    // Both figures, separately named. Never one number that has silently
    // chosen between a guess and a bill (AC9).
    expect(accuracy?.estimatedCostUsd).not.toBe(accuracy?.actualCostUsd);
  });
});
