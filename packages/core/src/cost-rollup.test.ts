/**
 * KAR-14.1 — the accounting projection, as a pure fold.
 *
 * Every assertion here is about the *shape* money is allowed to be reported
 * in. The shape is the feature: docs/08-context-and-memory.md §7 forbids
 * silently mixing the measurement tiers, and
 * docs/07-provider-adapter-layer.md §12 forbids summing subscription quota
 * with real currency. Both prohibitions are only enforceable if there is no
 * field for the forbidden number to live in, which is why "no field equals
 * their sum" is written as an absence rather than as a comparison against a
 * total nobody should compute.
 *
 * Verifies: EPIC-14-S2, EPIC-14-S3, EPIC-14-S4 · KAR-14.1 AC3, AC4 ·
 * test plan #1, #3, #4, #5
 */
import { expect, it, describe as suite } from 'vitest';
import {
  addConsumption,
  type Consumption,
  type CostRollup,
  initialBudgetRollup,
} from './cost-rollup.ts';
import { NodeIdSchema, ProviderIdSchema } from './ids.ts';
import type { TokenUsage } from './token-usage.ts';

const CLAUDE = ProviderIdSchema.parse('claude');
const OPENCODE = ProviderIdSchema.parse('opencode');
const GEMINI = ProviderIdSchema.parse('gemini');
const NODE_A = NodeIdSchema.parse('n-a');
const NODE_B = NodeIdSchema.parse('n-b');

const vendor = (input: number, output: number): TokenUsage => ({
  inputTokens: input,
  outputTokens: output,
  source: 'vendor-reported',
});

const estimated = (input: number, output: number): TokenUsage => ({
  inputTokens: input,
  outputTokens: output,
  source: 'estimated',
});

const spend = (overrides: Partial<Consumption> = {}): Consumption => ({
  node: NODE_A,
  attempt: 0,
  provider: CLAUDE,
  usage: vendor(100, 10),
  costUsd: 1,
  authMode: 'subscription',
  ...overrides,
});

/** Every number reachable in `value`, at any depth. */
function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(numbersIn);
  }
  return [];
}

suite('the fold keeps per-node, per-provider and per-run figures (test plan #1)', () => {
  it('projects three contributions into all three keyings', () => {
    const rollup = [
      spend({ node: NODE_A, provider: CLAUDE, costUsd: 1.1 }),
      spend({ node: NODE_B, provider: OPENCODE, costUsd: 0.25 }),
      spend({ node: NODE_B, attempt: 1, provider: OPENCODE, costUsd: 0.15 }),
    ].reduce(addConsumption, initialBudgetRollup());

    expect(rollup.run.costUsd.subscription).toBeCloseTo(1.5, 6);
    expect(Object.keys(rollup.nodes)).toEqual([NODE_A, NODE_B]);
    expect(rollup.nodes[NODE_A]?.costUsd.subscription).toBeCloseTo(1.1, 6);
    expect(rollup.nodes[NODE_B]?.costUsd.subscription).toBeCloseTo(0.4, 6);
    expect(Object.keys(rollup.providers)).toEqual([CLAUDE, OPENCODE]);
    expect(rollup.providers[OPENCODE]?.costUsd.subscription).toBeCloseTo(0.4, 6);
  });

  it('reports per-attempt figures beside the cumulative one (AC5)', () => {
    const rollup = [
      spend({ node: NODE_B, attempt: 0, costUsd: 0.25 }),
      spend({ node: NODE_B, attempt: 1, costUsd: 0.15 }),
    ].reduce(addConsumption, initialBudgetRollup());

    const node = rollup.nodes[NODE_B];
    expect(node?.attempts.map((entry) => entry.attempt)).toEqual([0, 1]);
    expect(node?.attempts[0]?.costUsd.subscription).toBeCloseTo(0.25, 6);
    expect(node?.attempts[1]?.costUsd.subscription).toBeCloseTo(0.15, 6);
    // The cumulative figure is their sum, and is strictly greater than the
    // attempt that succeeded: a failed attempt's spend is never refunded.
    expect(node?.costUsd.subscription).toBeCloseTo(0.4, 6);
  });

  it('files a run-level contribution that no node owns without inventing a node', () => {
    const rollup = addConsumption(initialBudgetRollup(), spend({ node: null, attempt: null }));

    expect(rollup.nodes).toEqual({});
    expect(rollup.run.costUsd.subscription).toBe(1);
  });

  it('is pure: the input rollup is not mutated', () => {
    const before = initialBudgetRollup();
    const snapshot = structuredClone(before);
    addConsumption(before, spend());

    expect(before).toEqual(snapshot);
  });
});

suite('EPIC-14-S2 — vendor-reported and estimated are side by side, never summed', () => {
  it('exposes both and no field holding 1.75', () => {
    const rollup = [
      // The two auth modes differ so that the two *partitions* of the same
      // money cannot themselves produce 1.75 — this assertion is about the
      // absence of a `total`, not about the absence of a partition.
      spend({ node: NODE_A, provider: CLAUDE, usage: vendor(1000, 100), costUsd: 1.1 }),
      spend({
        node: NODE_B,
        provider: OPENCODE,
        usage: estimated(800, 90),
        costUsd: 0.65,
        authMode: 'api_key',
      }),
    ].reduce(addConsumption, initialBudgetRollup());

    expect(rollup.run.costUsd.vendorReported).toBeCloseTo(1.1, 6);
    expect(rollup.run.costUsd.estimated).toBeCloseTo(0.65, 6);
    expect(numbersIn(rollup)).not.toContain(1.75);
  });

  it('carries the source with every token total it reports', () => {
    const rollup = [
      spend({ usage: vendor(1000, 100) }),
      spend({ node: NODE_B, usage: estimated(800, 90) }),
    ].reduce(addConsumption, initialBudgetRollup());

    expect(rollup.run.usage.vendorReported?.source).toBe('vendor-reported');
    expect(rollup.run.usage.estimated?.source).toBe('estimated');
    expect(rollup.run.usage.vendorReported?.inputTokens).toBe(1000);
    expect(rollup.run.usage.estimated?.inputTokens).toBe(800);
  });
});

suite("EPIC-14-S3 — tokenAccounting 'none' is a blank cost, not a zero", () => {
  it('contributes null and names the provider in unaccounted', () => {
    const rollup = addConsumption(
      initialBudgetRollup(),
      spend({ node: NODE_A, provider: GEMINI, costUsd: null, usage: estimated(500, 40) }),
    );

    expect(rollup.nodes[NODE_A]?.costUsd.subscription).toBeNull();
    expect(rollup.nodes[NODE_A]?.unaccounted).toEqual([GEMINI]);
    expect(rollup.run.unaccounted).toEqual([GEMINI]);
    expect(rollup.providers[GEMINI]?.costUsd.subscription).toBeNull();
  });

  it('still reports the tokens it does know, so a blank cost is not a blank row', () => {
    const rollup = addConsumption(
      initialBudgetRollup(),
      spend({ provider: GEMINI, costUsd: null, usage: estimated(500, 40) }),
    );

    expect(rollup.run.usage.estimated?.inputTokens).toBe(500);
  });

  it('names an unmeasurable provider once, however many nodes ran on it', () => {
    const rollup = [
      spend({ node: NODE_A, provider: GEMINI, costUsd: null }),
      spend({ node: NODE_B, provider: GEMINI, costUsd: null }),
    ].reduce(addConsumption, initialBudgetRollup());

    expect(rollup.run.unaccounted).toEqual([GEMINI]);
  });

  it('leaves a run total as a figure plus a named list, never one number', () => {
    const rollup = [
      spend({ node: NODE_A, provider: CLAUDE, costUsd: 4.1 }),
      spend({ node: NODE_B, provider: GEMINI, costUsd: null }),
    ].reduce(addConsumption, initialBudgetRollup());

    expect(rollup.run.costUsd.subscription).toBeCloseTo(4.1, 6);
    expect(rollup.run.unaccounted).toEqual([GEMINI]);
  });

  it('makes 0 unrepresentable as unknown: an unspent cell is null, not zero', () => {
    const empty = initialBudgetRollup();

    expect(empty.run.costUsd).toEqual({
      subscription: null,
      apiKey: null,
      vendorReported: null,
      estimated: null,
    });
    // A *real* zero is still representable, and it means zero.
    const free = addConsumption(empty, spend({ costUsd: 0 }));
    expect(free.run.costUsd.subscription).toBe(0);
    expect(free.run.unaccounted).toEqual([]);
  });

  it('types every cell as number | null so a consumer must handle the blank', () => {
    // A compile-time claim, asserted at runtime so it cannot be deleted
    // silently: `null` has to be assignable to a cost cell.
    const cell: CostRollup['costUsd']['subscription'] = null;
    expect(cell).toBeNull();
  });
});

suite('EPIC-14-S4 — subscription quota and API-key currency are two totals', () => {
  it('keeps them in separate fields with no summed field anywhere', () => {
    // The two contributions differ in *both* partitions, so that a 5 appearing
    // anywhere can only be a `total` — the field this assertion exists to
    // forbid — rather than the other legitimate cut of the same money.
    const rollup = [
      spend({ node: NODE_A, costUsd: 2, authMode: 'subscription', usage: vendor(10, 1) }),
      spend({ node: NODE_B, costUsd: 3, authMode: 'api_key', usage: estimated(10, 1) }),
    ].reduce(addConsumption, initialBudgetRollup());

    expect(rollup.run.costUsd.subscription).toBe(2);
    expect(rollup.run.costUsd.apiKey).toBe(3);
    expect(numbersIn(rollup.run.costUsd)).not.toContain(5);
  });

  it('files each node under the auth mode it actually ran with', () => {
    const rollup = [
      spend({ node: NODE_A, costUsd: 2, authMode: 'subscription' }),
      spend({ node: NODE_B, costUsd: 3, authMode: 'api_key' }),
    ].reduce(addConsumption, initialBudgetRollup());

    expect(rollup.nodes[NODE_A]?.costUsd.apiKey).toBeNull();
    expect(rollup.nodes[NODE_B]?.costUsd.subscription).toBeNull();
  });

  it('exposes all four AC3 figures at once without collapsing any pair (AC3)', () => {
    const rollup = [
      spend({ node: NODE_A, costUsd: 2, authMode: 'subscription', usage: vendor(1000, 100) }),
      spend({ node: NODE_B, costUsd: 3, authMode: 'api_key', usage: estimated(800, 90) }),
    ].reduce(addConsumption, initialBudgetRollup());

    expect(rollup.run.costUsd.subscription).toBe(2);
    expect(rollup.run.costUsd.apiKey).toBe(3);
    expect(rollup.run.usage.vendorReported?.inputTokens).toBe(1000);
    expect(rollup.run.usage.estimated?.inputTokens).toBe(800);
    // Neither pair may be added: not the two costs, not the two token totals.
    const numbers = numbersIn(rollup);
    expect(numbers).not.toContain(5);
    expect(numbers).not.toContain(1800);
    expect(numbers).not.toContain(1990);
  });
});
