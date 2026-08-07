/**
 * KAR-09.7 Tier 1, jsonl dialect — `turn.completed`, normalised into the same
 * report the `stream-json` dialect produces.
 *
 * The dialect that speaks this one reports its counts under a key spelled the
 * same way as the trap `./shim-frames.ts` refuses to read, and that collision
 * is the only reason this is a separate file. The two are not the same field:
 * this is a different line type, from a different vendor, with a shape that was
 * read off the documented output rather than off a `z.unknown()` passthrough.
 * `test/no-result-envelope-usage.test.ts` names this file as its single
 * exemption and, in exchange, asserts that nothing here knows anything about
 * the other dialect's envelope.
 *
 * What this dialect does **not** report is as important as what it does: no
 * window, no per-model breakdown, no cost. All three come back `null` rather
 * than as a default, because a default would be a window-size table with one
 * entry, and honest degradation is the whole design (§7).
 *
 * Verifies: EPIC-09-S36 · KAR-09.7 AC2 · test plan #3
 */
import type { ShimLine, VendorUsageReport } from './shim-frames.ts';

/** The line type this dialect ends a turn with. */
export const TURN_COMPLETED_TYPE = 'turn.completed';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;

/**
 * The turn's Tier-1 report, or `null` for every other line type.
 *
 * `cached_input_tokens` becomes `cacheReadInputTokens`: it is the same quantity
 * under a different vendor's spelling, and normalising it here is what lets the
 * calibration and the cost projection stay dialect-blind.
 */
export function turnCompletedReport(line: ShimLine): VendorUsageReport | null {
  if (line.type !== TURN_COMPLETED_TYPE) return null;
  const counts = asRecord(line.raw.usage);
  if (counts === null) return null;

  const cacheRead = asCount(counts.cached_input_tokens);
  return {
    model: null,
    usage: {
      inputTokens: asCount(counts.input_tokens) ?? 0,
      outputTokens: asCount(counts.output_tokens) ?? 0,
      ...(cacheRead === undefined ? {} : { cacheReadInputTokens: cacheRead }),
      source: 'vendor-reported',
    },
    costUsd: null,
    contextWindow: null,
    maxOutputTokens: null,
  };
}
