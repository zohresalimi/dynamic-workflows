/**
 * KAR-16.3 — `cost.ts`, the F9.1 projection.
 *
 * Verifies: EPIC-16-S20 · AC8
 */
import { parseEvent } from '@DeFlow/core';
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

/**
 * KAR-17.3 — what the node inspector needs of this projection, and could not
 * get from it before.
 *
 * Two additions, and each exists because the alternative was for the inspector
 * to fabricate a number:
 *
 * - **`byAttempt`.** *"Every attempt shows its outcome, its typed NodeFailure
 *   reason and class where it failed, its duration, its cost"* (EPIC-17-S13).
 *   A per-*node* total cannot answer "what did attempt 2 cost", and the
 *   plausible-looking alternative — dividing the node total by the attempt
 *   count — would produce three equal figures for three attempts that consumed
 *   different amounts.
 * - **`lastSeq`.** AC7: *"clicking a cost figure selects the producing event in
 *   the debug ring"*. A total is produced by the last event that moved it, so a
 *   bucket that did not record a `seq` had no link to offer and the inspector
 *   would have had to scan the ring — which is bounded at 2,000 envelopes and
 *   silently loses the answer on a long run.
 */
suite('KAR-17.3 — cost per attempt, and the seq behind every figure', () => {
  const REPAIR = 'repair-attempts';
  const repair = (): CostProjection => fold(REPAIR, emptyCost, applyCost);

  it('buckets a retried node by attempt, not only by node', () => {
    const state = repair();

    // The three attempts of `impl-oauth` billed 0.084, 0.091 and 0.096 — three
    // different figures, which is exactly why one divided total is not one of
    // them.
    expect(state.byAttempt.get('impl-oauth#0')?.costUsd.vendorReported).toBeCloseTo(0.084, 6);
    expect(state.byAttempt.get('impl-oauth#1')?.costUsd.vendorReported).toBeCloseTo(0.091, 6);
    expect(state.byAttempt.get('impl-oauth#2')?.costUsd.vendorReported).toBeCloseTo(0.096, 6);
  });

  it('still rolls the same three up into the node they belong to', () => {
    // The per-attempt split is an index, never a second accounting: if these
    // two disagreed the inspector's header and its attempt table would show
    // different money for the same node.
    expect(repair().byNode.get('impl-oauth')?.costUsd.vendorReported).toBeCloseTo(0.271, 6);
  });

  it('separates the token usage per attempt as well as the money', () => {
    const state = repair();

    expect(state.byAttempt.get('impl-oauth#1')?.usage.vendorReported?.outputTokens).toBe(910);
    expect(state.byAttempt.get('impl-oauth#2')?.usage.vendorReported?.outputTokens).toBe(880);
  });

  it('records the seq of the event that last moved each bucket', () => {
    const state = repair();

    // `budget.consumed` for the three attempts sits at 11, 18 and 25.
    expect(state.byAttempt.get('impl-oauth#0')?.lastSeq).toBe(11);
    expect(state.byAttempt.get('impl-oauth#2')?.lastSeq).toBe(25);
    expect(state.byNode.get('impl-oauth')?.lastSeq).toBe(25);
    expect(state.run.lastSeq).toBe(25);
  });

  it('leaves lastSeq at zero on a bucket nothing has been folded into', () => {
    // Not `null` and not the run's seq: a fresh bucket has no producing event,
    // and 0 is the one `seq` the ledger never mints (docs/11 §4.2).
    expect(emptyCost().run.lastSeq).toBe(0);
  });

  it('keeps a node that never spent out of byAttempt entirely', () => {
    // `probe-oauth-tokens` failed at spawn, so nothing was ever consumed on its
    // behalf. An empty bucket for it would read as "attempt 0 cost nothing",
    // which is a measurement, and there was none.
    expect(repair().byAttempt.has('probe-oauth-tokens#0')).toBe(false);
  });

  /**
   * `BudgetConsumedSchema` says `attempt` is *"absent exactly when `node` is"*
   * — but it says it in a comment, and declares the two `.optional()`
   * independently, so a node-scoped payload carrying no `attempt` parses.
   *
   * The daemon never emits one. What matters is what this projection does if
   * one ever arrives: the tempting reading is "no attempt means attempt 0", and
   * that silently merges an unattributed spend into attempt 0's bucket, where
   * the inspector's attempt table would show it as a measurement of the first
   * attempt. The node total is still the truth, so the spend is kept there and
   * only the attribution it does not have is withheld.
   */
  it('does not fabricate an attempt for a node-scoped spend that names none', () => {
    const parsed = parseEvent({
      seq: 31,
      runId: 'run_20260811T140000Z_c4d5e6',
      ts: 1_786_464_000_000,
      epoch: 1,
      kind: 'budget.consumed',
      v: 3,
      payload: {
        node: 'impl-oauth',
        provider: 'claude-code',
        usage: { inputTokens: 100, outputTokens: 10, source: 'vendor-reported' },
        costUsd: 0.002,
        authMode: 'subscription',
      },
    });
    if (parsed.status !== 'ok') throw new Error(`unparseable: ${JSON.stringify(parsed)}`);

    const state = repair();
    applyCost(state, parsed.event);

    // Neither under a fabricated attempt number nor under the string
    // "undefined", which is what a template literal over a missing field mints.
    expect([...state.byAttempt.keys()].filter((key) => key.startsWith('impl-oauth'))).toEqual([
      'impl-oauth#0',
      'impl-oauth#1',
      'impl-oauth#2',
    ]);
    expect(state.byAttempt.get('impl-oauth#0')?.costUsd.vendorReported).toBeCloseTo(0.084, 6);
    // Still counted where it is attributable.
    expect(state.byNode.get('impl-oauth')?.costUsd.vendorReported).toBeCloseTo(0.273, 6);
  });
});
