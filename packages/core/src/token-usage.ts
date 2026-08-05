/**
 * KAR-02.10 — `TokenUsage` and the one function allowed to add two of them.
 *
 * Implements docs/04-domain-model.md §8. `source` is mandatory and has no
 * default because the two sources are not interchangeable: vendor-reported
 * figures come from the CLI's result envelope (Claude Code's
 * `modelUsage[model]`, Codex's `turn.completed.usage` — **Verified
 * 2026-08-02**) and are the billing truth, while estimated figures come from
 * `gpt-tokenizer`'s `o200k_base` encoding and carry a known 15–20% undercount
 * on Claude prose and worse on code.
 *
 * That is why `sumUsage` returns a `{ vendorReported, estimated }` pair rather
 * than a number. A single mixed total is not a slightly-wrong total, it is a
 * number with no meaning: a budget ceiling (F4.6) computed from it fires at
 * the wrong time in both directions — burning quota past the ceiling when the
 * estimate undercounts, pausing a healthy run when it does not. Keeping the
 * two apart all the way to the chart is a product requirement, not tidiness.
 *
 * Verifies: EPIC-02-S18 · AC7
 */
import { z } from 'zod';

const count = z.number().int().nonnegative();

export const TokenUsageSourceSchema = z.enum(['vendor-reported', 'estimated']);

export const TokenUsageSchema = z.strictObject({
  inputTokens: count,
  outputTokens: count,
  cacheReadInputTokens: count.optional(),
  cacheCreationInputTokens: count.optional(),
  reasoningOutputTokens: count.optional(),
  source: TokenUsageSourceSchema,
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type TokenUsageSource = z.infer<typeof TokenUsageSourceSchema>;

/** The result of `sumUsage`: one total per source, `null` where a source
 * contributed nothing. Never a single number — see the module note. */
export interface UsageTotals {
  readonly vendorReported: TokenUsage | null;
  readonly estimated: TokenUsage | null;
}

/**
 * The same pair as a schema, because `UsageTotals` is part of `RunState` and
 * `RunState` is decoded from a checkpoint row written by some earlier binary
 * (KAR-03.6). `null` is spelled out on both arms for the reason the whole file
 * exists: a missing `estimated` and an `estimated` of zero are different
 * claims, and only one of them is true.
 */
export const UsageTotalsSchema: z.ZodType<UsageTotals, unknown> = z.strictObject({
  vendorReported: TokenUsageSchema.nullable(),
  estimated: TokenUsageSchema.nullable(),
});

/** The three counters §8 marks optional. They are summed only when at least
 * one contributing usage reported them, so "not reported" survives the sum
 * instead of becoming a confident zero. */
const OPTIONAL_COUNTERS = [
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'reasoningOutputTokens',
] as const;

function total(usages: readonly TokenUsage[], source: TokenUsageSource): TokenUsage | null {
  const group = usages.filter((usage) => usage.source === source);
  if (group.length === 0) return null;

  const sum: TokenUsage = {
    inputTokens: group.reduce((acc, usage) => acc + usage.inputTokens, 0),
    outputTokens: group.reduce((acc, usage) => acc + usage.outputTokens, 0),
    source,
  };

  for (const counter of OPTIONAL_COUNTERS) {
    const reported = group.filter((usage) => usage[counter] !== undefined);
    if (reported.length === 0) continue;
    sum[counter] = reported.reduce((acc, usage) => acc + (usage[counter] ?? 0), 0);
  }

  return sum;
}

/**
 * Adds token counts within each source and refuses to add across them.
 * Pure: the inputs are read, never mutated.
 */
export function sumUsage(usages: readonly TokenUsage[]): UsageTotals {
  return {
    vendorReported: total(usages, 'vendor-reported'),
    estimated: total(usages, 'estimated'),
  };
}
