/**
 * KAR-14.1 — `budget.consumed` as reduced state.
 *
 * `reduce()` is the only thing that produces an accounting figure anywhere in
 * DeFlow: there is no second mutable table, no running total in the daemon,
 * and nothing a crash can lose. That is what makes EPIC-14-S6 — "replay after
 * `kill -9` reproduces the rollups" — a property rather than a feature, and it
 * is why these specs drive the real reducer over real parsed events rather
 * than calling the fold in ../src/cost-rollup.ts directly.
 *
 * Verifies: EPIC-14-S2, EPIC-14-S3, EPIC-14-S4, EPIC-14-S7 ·
 * KAR-14.1 AC1, AC3, AC4, AC5, AC7 · test plan #1, #2
 */
import { expect, it, describe as suite } from 'vitest';
import type { EventKind } from '../src/event-payloads.ts';
import { EVENT_SCHEMAS } from '../src/event-payloads.ts';
import { type Event, parseEvent } from '../src/events.ts';
import { reduce } from '../src/reduce.ts';
import { initialRunState, type RunState } from '../src/run-state.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c';
const TS = 1_754_313_093_000;

function event(kind: EventKind, payload: unknown, seq = 1): Event {
  const result = parseEvent({
    seq,
    runId: RUN_ID,
    ts: TS,
    kind,
    v: EVENT_SCHEMAS[kind].v,
    epoch: 1,
    payload,
  });
  if (result.status !== 'ok') {
    throw new Error(`fixture for ${kind} is not a valid event: ${JSON.stringify(result)}`);
  }
  return result.event;
}

const vendor = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
  source: 'vendor-reported' as const,
});

const estimated = (input: number, output: number) => ({
  inputTokens: input,
  outputTokens: output,
  source: 'estimated' as const,
});

/** One `budget.consumed`, at the version the current build writes. */
function consumed(payload: Record<string, unknown>, seq: number): Event {
  return event('budget.consumed', payload, seq);
}

function fold(events: readonly Event[]): RunState {
  return events.reduce(reduce, initialRunState());
}

suite('reduce() projects the three keyings (test plan #1)', () => {
  const state = fold([
    consumed(
      {
        node: 'n-impl',
        attempt: 0,
        provider: 'claude',
        usage: vendor(18_420, 2310),
        costUsd: 0.42,
        authMode: 'subscription',
      },
      1,
    ),
    consumed(
      {
        node: 'n-impl',
        attempt: 1,
        provider: 'claude',
        usage: vendor(1000, 100),
        costUsd: 0.08,
        authMode: 'subscription',
      },
      2,
    ),
    consumed(
      {
        node: 'n-review',
        attempt: 0,
        provider: 'opencode',
        usage: estimated(4000, 200),
        costUsd: 0.65,
        authMode: 'api_key',
      },
      3,
    ),
  ]);

  it('rolls up per run', () => {
    expect(state.budget.run.costUsd.subscription).toBeCloseTo(0.5, 6);
    expect(state.budget.run.costUsd.apiKey).toBeCloseTo(0.65, 6);
    expect(state.budget.run.usage.vendorReported?.inputTokens).toBe(19_420);
    expect(state.budget.run.usage.estimated?.inputTokens).toBe(4000);
  });

  it('rolls up per node, with per-attempt figures beside the cumulative one (AC5)', () => {
    const node = state.budget.nodes['n-impl'];
    expect(node?.costUsd.subscription).toBeCloseTo(0.5, 6);
    expect(node?.attempts.map((entry) => [entry.attempt, entry.costUsd.subscription])).toEqual([
      [0, 0.42],
      [1, 0.08],
    ]);
    // Spend on the attempt that failed is never discounted.
    expect(node?.costUsd.subscription).toBeGreaterThan(
      node?.attempts[1]?.costUsd.subscription ?? 0,
    );
  });

  it('rolls up per provider', () => {
    expect(Object.keys(state.budget.providers)).toEqual(['claude', 'opencode']);
    expect(state.budget.providers.claude?.costUsd.subscription).toBeCloseTo(0.5, 6);
    expect(state.budget.providers.opencode?.costUsd.apiKey).toBeCloseTo(0.65, 6);
  });

  it('advances the progress watermark, because a spend is a real transition', () => {
    expect(state.watermarkSeq).toBe(3);
  });
});

suite('usage.source is mandatory (test plan #2)', () => {
  it('refuses a budget.consumed whose usage carries no source', () => {
    const result = parseEvent({
      seq: 1,
      runId: RUN_ID,
      ts: TS,
      kind: 'budget.consumed',
      v: EVENT_SCHEMAS['budget.consumed'].v,
      epoch: 1,
      payload: {
        node: 'n-impl',
        attempt: 0,
        provider: 'claude',
        usage: { inputTokens: 10, outputTokens: 1 },
        costUsd: 0.1,
        authMode: 'subscription',
      },
    });

    expect(result.status).toBe('invalid-payload');
    if (result.status === 'invalid-payload') {
      expect(result.issues.join(' ')).toContain('usage.source');
    }
  });

  it('refuses an unknown source rather than defaulting to the cheaper claim', () => {
    const result = parseEvent({
      seq: 1,
      runId: RUN_ID,
      ts: TS,
      kind: 'budget.consumed',
      v: EVENT_SCHEMAS['budget.consumed'].v,
      epoch: 1,
      payload: {
        node: 'n-impl',
        attempt: 0,
        provider: 'claude',
        usage: { inputTokens: 10, outputTokens: 1, source: 'guessed' },
        costUsd: 0.1,
        authMode: 'subscription',
      },
    });

    expect(result.status).toBe('invalid-payload');
  });
});

suite('EPIC-14-S3 — a provider that reports nothing contributes a blank (AC4)', () => {
  const state = fold([
    consumed(
      {
        node: 'n-impl',
        attempt: 0,
        provider: 'claude',
        usage: vendor(1000, 100),
        costUsd: 4.1,
        authMode: 'subscription',
      },
      1,
    ),
    consumed(
      {
        node: 'n-c',
        attempt: 0,
        provider: 'gemini',
        usage: estimated(900, 80),
        costUsd: null,
        authMode: 'subscription',
      },
      2,
    ),
  ]);

  it('leaves the unmeasurable node null and names its provider', () => {
    expect(state.budget.nodes['n-c']?.costUsd.subscription).toBeNull();
    expect(state.budget.run.unaccounted).toEqual(['gemini']);
  });

  it('keeps the run total a figure plus a named list, never one number', () => {
    expect(state.budget.run.costUsd.subscription).toBeCloseTo(4.1, 6);
    expect(state.budget.run.unaccounted).toEqual(['gemini']);
  });
});

suite('EPIC-14-S7 — the data plane moves no accounting figure (AC7)', () => {
  it('leaves every figure untouched across node.progress', () => {
    const before = fold([
      consumed(
        {
          node: 'n-noisy',
          attempt: 0,
          provider: 'claude',
          usage: vendor(1000, 100),
          costUsd: 0.5,
          authMode: 'subscription',
        },
        1,
      ),
    ]);
    const after = reduce(
      before,
      event('node.progress', { node: 'n-noisy', attempt: 0, phase: 'thinking' }, 2),
    );

    expect(after.budget).toEqual(before.budget);
  });
});

suite('the ceiling breach still lands beside the figures', () => {
  it('records a breach without touching a cost cell', () => {
    const state = fold([
      event(
        'budget.exceeded',
        {
          scope: 'run',
          dimension: 'cost',
          limit: 20,
          actual: 21.4,
          failureClass: 'gate',
          firedBy: 'deflow',
        },
        1,
      ),
    ]);

    expect(state.budget.breaches).toEqual([
      { scope: 'run', dimension: 'cost', limit: 20, actual: 21.4, firedBy: 'deflow', seq: 1 },
    ]);
    expect(state.budget.run.costUsd.subscription).toBeNull();
  });
});
