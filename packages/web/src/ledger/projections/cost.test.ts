/**
 * KAR-16.3 — `cost.ts`, the F9.1 projection.
 *
 * Verifies: EPIC-16-S20 · AC8
 */
import { expect, it, describe as suite } from 'vitest';
import { fold, ledger, unknownKind } from '../../../test/run-fixtures.ts';
import { applyCost, type CostProjection, emptyCost } from './cost.ts';

const HAPPY = 'happy-path-12';
const cost = (): CostProjection => fold(HAPPY, emptyCost, applyCost);

suite('EPIC-16-S20 — two sources, two accumulators (AC8)', () => {
  it('keeps the run total separable by source', () => {
    const run = cost().run;

    // claude-code reported 0.062 + 0.147; codex's figure is DeFlow's own
    // estimate. A single mixed total is not a slightly-wrong total — it is a
    // number with no meaning, and an F4.6 ceiling computed from it fires at the
    // wrong time in both directions.
    expect(run.costUsd.vendorReported).toBeCloseTo(0.209, 6);
    expect(run.costUsd.estimated).toBeCloseTo(0.081, 6);
    expect(run).not.toHaveProperty('total');
  });

  it('keeps the per-node and per-provider totals separable too', () => {
    const state = cost();

    expect(state.byNode.get('recon-auth-surface')?.costUsd.vendorReported).toBeCloseTo(0.062, 6);
    expect(state.byNode.get('review-security')?.costUsd.vendorReported).toBeNull();
    expect(state.byNode.get('review-security')?.costUsd.estimated).toBeCloseTo(0.081, 6);
    expect(state.byProvider.get('claude-code')?.costUsd.vendorReported).toBeCloseTo(0.209, 6);
    expect(state.byProvider.get('codex')?.costUsd.estimated).toBeCloseTo(0.081, 6);
  });

  it('states which source every displayed total came from', () => {
    const state = cost();

    expect(state.run.sources.toSorted()).toEqual(['estimated', 'vendor-reported']);
    expect(state.byProvider.get('codex')?.sources).toEqual(['estimated']);
    expect(state.byProvider.get('claude-code')?.sources).toEqual(['vendor-reported']);
  });

  it('sums token usage within each source and never across them', () => {
    const usage = cost().run.usage;

    expect(usage.vendorReported?.inputTokens).toBe(4_200 + 9_800);
    expect(usage.estimated?.inputTokens).toBe(1_200 + 6_400);
    expect(usage.vendorReported?.source).toBe('vendor-reported');
    expect(usage.estimated?.source).toBe('estimated');
  });
});

suite('EPIC-16-S20 — an adapter that reports nothing at all', () => {
  it('exposes the absence explicitly rather than displaying a fabricated zero', () => {
    const state = cost();

    expect(state.run.unaccounted).toEqual(['gemini-cli']);
    expect(state.byProvider.get('gemini-cli')?.costUsd.estimated).toBeNull();
    expect(state.byProvider.get('gemini-cli')?.costUsd.vendorReported).toBeNull();
  });

  it('still counts the tokens it did report, because those are not missing', () => {
    expect(cost().byProvider.get('gemini-cli')?.usage.estimated?.inputTokens).toBe(1_200);
  });
});

suite('EPIC-16-S20 — ceilings and rate limits are events too', () => {
  it('records that the run PAUSED on a ceiling — it did not fail', () => {
    const state = cost();
    const [ceiling] = state.ceilings;

    expect(state.paused).toBe(true);
    expect(ceiling?.scope).toBe('run');
    expect(ceiling?.dimension).toBe('cost');
    expect(ceiling?.limit).toBe(25);
    expect(ceiling?.actual).toBe(25.4);
    // A pause driven wholly by DeFlow's own estimate is a different
    // conversation from one driven by a figure the vendor billed.
    expect(ceiling?.estimateDriven).toBe(false);
    expect(ceiling?.unaccounted).toEqual(['gemini-cli']);
  });

  it('exposes a rate limit with its resetsAt, for the timeline overlay', () => {
    const [limit] = cost().rateLimits;

    expect(limit?.provider).toBe('claude-code');
    expect(typeof limit?.resetsAt).toBe('number');
  });
});

suite('EPIC-16-S23 — the same event applied twice changes nothing', () => {
  it('is wrong by exactly one event’s cost under a naive `total +=`', () => {
    const state = cost();
    const before = state.run.costUsd.vendorReported;
    const last = ledger(HAPPY).findLast((event) => event.kind === 'budget.consumed');
    if (last === undefined) throw new Error('the fixture must consume a budget');

    applyCost(state, last);

    expect(state.run.costUsd.vendorReported).toBe(before);
  });
});

suite('AC11 — an unknown kind is ignored, without throwing and without mutating', () => {
  it('leaves the projection byte-identical', () => {
    const state = cost();
    const before = structuredClone(state);

    expect(() => {
      applyCost(state, unknownKind(9_100, ledger(HAPPY)[0]?.runId ?? ''));
    }).not.toThrow();

    expect({ ...state, appliedSeq: before.appliedSeq }).toEqual(before);
  });
});
