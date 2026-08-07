/**
 * KAR-14.1 — the one accounting record, judged against the manifest.
 *
 * Both execution paths build their `budget.consumed` payload here, so this is
 * where the three measurement tiers of docs/08-context-and-memory.md §7 are
 * chosen between at the point of record. Three rules, and each one is a way of
 * not lying:
 *
 * - **The manifest wins over the envelope.** A provider whose probed row says
 *   `tokenAccounting: 'none'` may still emit something usage-shaped; believing
 *   it turns a number nobody has verified into a cost.
 * - **A blank cost is `null`, never `0`.** A zero says the turn was free, which
 *   is false, and it makes an F4.6 ceiling silently unenforceable.
 * - **A blank cost is not a blank row.** DeFlow rendered the prompt itself, so
 *   it always has its own Tier-2 count — and reporting that, labelled
 *   `estimated`, is strictly more honest than reporting zero tokens, which
 *   claims the turn read and wrote nothing.
 *
 * Verifies: EPIC-14-S1, EPIC-14-S2, EPIC-14-S3 · KAR-14.1 AC1, AC2, AC4, AC5
 */
import { NodeIdSchema, ProviderIdSchema, type TokenUsage } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { budgetConsumed, type SpendInput } from './budget-consumed.ts';

// A provider id that names no real vendor, used for every case.
// `test/no-capability-table.test.ts` refuses a vendor name anywhere in this
// tree but the spawn registry, and it is right to: nothing here branches on
// who the vendor is. What varies between the cases is the *manifest field*,
// which is the only thing the function actually reads.
const NODE = NodeIdSchema.parse('n-impl-1');
const PROVIDER = ProviderIdSchema.parse('vendor-a');

/** What the vendor's own envelope said, when it said anything. */
const REPORTED: TokenUsage = {
  inputTokens: 18_420,
  outputTokens: 2310,
  source: 'vendor-reported',
};

/** DeFlow's own count of text it rendered itself. Always available. */
const ESTIMATE: TokenUsage = { inputTokens: 900, outputTokens: 40, source: 'estimated' };

const spend = (overrides: Partial<SpendInput> = {}): SpendInput => ({
  node: NODE,
  attempt: 0,
  provider: PROVIDER,
  accounting: 'exact',
  authMode: 'subscription',
  reported: { usage: REPORTED, costUsd: 0.42 },
  estimate: ESTIMATE,
  ...overrides,
});

suite('a vendor that counts is believed, and labelled as the vendor (AC2)', () => {
  it('carries the reported usage, its source and its price', () => {
    expect(budgetConsumed(spend())).toEqual({
      node: NODE,
      attempt: 0,
      provider: PROVIDER,
      usage: REPORTED,
      costUsd: 0.42,
      authMode: 'subscription',
    });
  });

  it('files the attempt it was told, so a retry does not overwrite the one it replaced (AC5)', () => {
    expect(budgetConsumed(spend({ attempt: 2 })).attempt).toBe(2);
  });

  it('carries the auth mode it was given, because the two are never summed (AC3)', () => {
    expect(budgetConsumed(spend({ authMode: 'api_key' })).authMode).toBe('api_key');
  });
});

suite('a turn nobody can price falls back to DeFlow’s own count (AC4)', () => {
  it('reports the estimate rather than zero tokens when the vendor said nothing', () => {
    const payload = budgetConsumed(spend({ reported: null }));

    // Zero would be a claim that the turn read and wrote nothing, which is
    // false for any turn that ran at all.
    expect(payload.usage).toEqual(ESTIMATE);
    expect(payload.usage.source).toBe('estimated');
  });

  it('leaves the cost blank rather than zero, so the provider lands in `unaccounted`', () => {
    expect(budgetConsumed(spend({ reported: null })).costUsd).toBeNull();
  });

  it('lets the manifest overrule an envelope from a provider nobody has measured', () => {
    const payload = budgetConsumed(
      spend({ accounting: 'none', reported: { usage: REPORTED, costUsd: 9.99 } }),
    );

    expect(payload.costUsd).toBeNull();
    expect(payload.usage).toEqual(ESTIMATE);
  });

  it('refuses to price an `estimated` manifest either, and keeps its tokens', () => {
    const payload = budgetConsumed(
      spend({ accounting: 'estimated', reported: { usage: REPORTED, costUsd: 1.5 } }),
    );

    expect(payload.costUsd).toBeNull();
    expect(payload.usage).toEqual(ESTIMATE);
  });

  it('keeps a real zero a zero: a priced turn that cost nothing is not unknown', () => {
    expect(budgetConsumed(spend({ reported: { usage: REPORTED, costUsd: 0 } })).costUsd).toBe(0);
  });
});

/**
 * KAR-14.3 AC8 — the figure the attempt was admitted on, riding back out on the
 * record of what it actually cost.
 *
 * Echoed rather than recomputed, and that is the point: the estimate the
 * accuracy figure is measured against has to be the one the *admission decision*
 * used, not a fresh count of the same prompt taken afterwards. A recount would
 * converge on 1.0 and prove nothing.
 */
suite('the pre-flight estimate travels with the actual (KAR-14.3 AC8)', () => {
  const PREFLIGHT = {
    costUsd: 0.35,
    inputTokens: 15_600,
    method: 'gpt-tokenizer/o200k_base',
    tokenEstimateFactor: 1.2,
    samples: 0,
    seedBased: true,
  } as const;

  it('carries it verbatim beside the vendor-reported figures', () => {
    expect(budgetConsumed(spend({ preflight: PREFLIGHT }))).toMatchObject({
      costUsd: 0.42,
      usage: REPORTED,
      estimate: PREFLIGHT,
    });
  });

  it('carries it on an unpriceable turn too, where it is the only figure there is', () => {
    const payload = budgetConsumed(
      spend({ accounting: 'none', preflight: { ...PREFLIGHT, costUsd: null } }),
    );
    expect(payload.costUsd).toBeNull();
    expect(payload.estimate?.costUsd).toBeNull();
    expect(payload.estimate?.inputTokens).toBe(15_600);
  });

  it('omits the field entirely when nobody estimated the attempt', () => {
    expect(budgetConsumed(spend())).not.toHaveProperty('estimate');
  });
});
