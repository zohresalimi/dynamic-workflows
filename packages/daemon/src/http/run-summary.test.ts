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
