/**
 * KAR-02.10 — `TokenUsage.source` is mandatory and vendor-reported figures are
 * never silently added to estimated ones.
 *
 * docs/04-domain-model.md §8: vendor-reported counts come from the CLI's
 * result envelope and are the billing truth; estimated counts come from
 * `gpt-tokenizer` and undercount Claude prose by 15–20%. A budget ceiling
 * (F4.6) computed from a mixed number fires at the wrong time — either past
 * the ceiling or on a healthy run — so `sumUsage` returns a pair and refuses
 * to collapse it.
 *
 * Verifies: EPIC-02-S18 · AC7
 */
import { expect, it, describe as suite } from 'vitest';
import type { TokenUsage } from './token-usage.ts';
import { sumUsage, TokenUsageSchema } from './token-usage.ts';

const vendor = (inputTokens: number, outputTokens: number): TokenUsage =>
  TokenUsageSchema.parse({ inputTokens, outputTokens, source: 'vendor-reported' });

const estimated = (inputTokens: number, outputTokens: number): TokenUsage =>
  TokenUsageSchema.parse({ inputTokens, outputTokens, source: 'estimated' });

suite('TokenUsageSchema (AC7)', () => {
  it('requires source, with no default', () => {
    const result = TokenUsageSchema.safeParse({ inputTokens: 100, outputTokens: 20 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['source']);
  });

  it('accepts the two sources and nothing else', () => {
    expect(
      TokenUsageSchema.safeParse({ inputTokens: 1, outputTokens: 1, source: 'guess' }).success,
    ).toBe(false);
    expect(vendor(1, 1).source).toBe('vendor-reported');
    expect(estimated(1, 1).source).toBe('estimated');
  });

  it('carries the optional cache and reasoning counters', () => {
    const parsed = TokenUsageSchema.parse({
      inputTokens: 10,
      outputTokens: 2,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 6,
      reasoningOutputTokens: 8,
      source: 'vendor-reported',
    });
    expect(parsed.cacheReadInputTokens).toBe(4);
    expect(parsed.cacheCreationInputTokens).toBe(6);
    expect(parsed.reasoningOutputTokens).toBe(8);
  });

  it('rejects fractional and negative counts', () => {
    expect(
      TokenUsageSchema.safeParse({ inputTokens: 1.5, outputTokens: 1, source: 'estimated' })
        .success,
    ).toBe(false);
    expect(
      TokenUsageSchema.safeParse({ inputTokens: -1, outputTokens: 1, source: 'estimated' }).success,
    ).toBe(false);
  });
});

suite('sumUsage keeps the sources apart (AC7, EPIC-02-S18)', () => {
  it('refuses to add across sources, returning a pair', () => {
    const total = sumUsage([vendor(100, 20), estimated(90, 18)]);

    expect(typeof total).not.toBe('number');
    expect(total.vendorReported).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      source: 'vendor-reported',
    });
    expect(total.estimated).toMatchObject({
      inputTokens: 90,
      outputTokens: 18,
      source: 'estimated',
    });
  });

  it('sums plainly within one source, and reports the absent one as null', () => {
    const total = sumUsage([vendor(100, 20), vendor(1, 2), vendor(9, 8)]);

    expect(total.vendorReported).toMatchObject({ inputTokens: 110, outputTokens: 30 });
    expect(total.estimated).toBeNull();
  });

  it('reports both as null for no usage at all', () => {
    expect(sumUsage([])).toEqual({ vendorReported: null, estimated: null });
  });

  it('sums the optional counters only when at least one input declared them', () => {
    const withCache = TokenUsageSchema.parse({
      inputTokens: 10,
      outputTokens: 1,
      cacheReadInputTokens: 5,
      source: 'vendor-reported',
    });
    const total = sumUsage([withCache, vendor(1, 1)]);

    expect(total.vendorReported?.cacheReadInputTokens).toBe(5);
    // Never invented: an unreported reasoning count stays unreported rather
    // than becoming a confident zero.
    expect(Object.hasOwn(total.vendorReported ?? {}, 'reasoningOutputTokens')).toBe(false);
  });

  it('is pure: the inputs are not mutated and two calls agree', () => {
    const inputs = [vendor(100, 20), estimated(90, 18)];
    const snapshot = structuredClone(inputs);
    expect(sumUsage(inputs)).toEqual(sumUsage(inputs));
    expect(inputs).toEqual(snapshot);
  });

  it('produces a value that parses as a TokenUsage in its own right', () => {
    const total = sumUsage([vendor(100, 20), vendor(5, 5)]);
    expect(TokenUsageSchema.safeParse(total.vendorReported).success).toBe(true);
  });
});
