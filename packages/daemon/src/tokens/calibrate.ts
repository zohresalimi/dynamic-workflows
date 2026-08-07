/**
 * KAR-09.7 — the two ends of the loop, joined
 * (docs/08-context-and-memory.md §7).
 *
 * `preflightBudget` is what a packet builder asks *before* a node runs:
 * DeFlow's own Tier-2 count of the text it is about to send, multiplied by the
 * correction this (provider, model) has earned. `foldCalibrationSample` is what
 * the node runner calls *after*: the same estimate, now paired with Tier 1's
 * `modelUsage[m].inputTokens`, folded into the stored factor.
 *
 * The pairing is the whole point, and it is why these are two functions in one
 * module rather than two conveniences in two. §7 asks for a comparison between
 * *the Tier-2 estimate of the rendered prompt* and *the vendor's own input
 * count for that same turn*; anything else converges on a ratio between two
 * numbers that were never about the same text, and does so without ever
 * failing.
 *
 * **A turn that reports no input tokens teaches nothing.** `inputTokens: 0` is
 * what an envelope carries when the provider's accounting is absent or the turn
 * never reached a model. Folding it in would drag the factor toward zero and
 * make every later budget under-reserve — the direction that overfills. So it
 * writes nothing and says so by returning `null`.
 *
 * Verifies: EPIC-09-S38 · KAR-09.7 AC6, AC7
 */
import type { VendorUsageReport } from '@DeFlow/adapters';
import type { Db, TokenCountMethod, Tokenizer } from '@DeFlow/core';
import { calibratedEstimate } from '@DeFlow/core';
import { readTokenCalibration, recordTokenSample, type TokenCalibrationRow } from '@DeFlow/ledger';

/** Which (provider, model) a figure is about, and which seed applies to it. */
export interface CalibrationTarget {
  readonly provider: string;
  readonly model: string;
  /** From `providerFamily()` in @DeFlow/adapters — the one place the mapping
   * from a vendor's CLI to a model family lives. */
  readonly family: string;
}

export interface PreflightBudget {
  /** The raw Tier-2 count, before correction. Kept because it is the figure
   * the next `foldCalibrationSample` has to be measured against — correcting
   * it first and comparing that would make the loop converge on 1.0. */
  readonly raw: number;
  /** What to actually reserve. */
  readonly calibrated: number;
  /** The factor applied: the family seed below five samples, the learned ratio
   * from the fifth on. */
  readonly factor: number;
  readonly method: TokenCountMethod;
}

/** What a node's packet should reserve, and what it was measured with. */
export function preflightBudget(
  db: Db,
  tokenizer: Tokenizer,
  input: CalibrationTarget & { readonly text: string },
): PreflightBudget {
  const counted = tokenizer.count(input.text);
  const calibration = readTokenCalibration(db, input.provider, input.model, input.family);
  return {
    raw: counted.estimated,
    calibrated: calibratedEstimate(counted.estimated, calibration.appliedFactor),
    factor: calibration.appliedFactor,
    method: counted.method,
  };
}

export interface CalibrationSample extends CalibrationTarget {
  /** The **raw** Tier-2 count from this node's own `preflightBudget`. */
  readonly estimated: number;
  /** Tier 1, as the result envelope reported it. */
  readonly report: VendorUsageReport;
  /** ms epoch, from the injected `Clock`. */
  readonly now: number;
}

/**
 * Folds one completed node into the stored factor, or returns `null` when the
 * turn carried nothing to learn from.
 */
export function foldCalibrationSample(
  db: Db,
  sample: CalibrationSample,
): TokenCalibrationRow | null {
  const actual = sample.report.usage.inputTokens;
  if (sample.estimated <= 0 || actual <= 0) return null;

  return recordTokenSample(db, {
    provider: sample.provider,
    model: sample.model,
    family: sample.family,
    estimated: sample.estimated,
    actual,
    now: sample.now,
  });
}
