/**
 * KAR-09.7 — the self-calibrating estimate correction
 * (docs/08-context-and-memory.md §7, Tier 2).
 *
 * There is no public exact tokenizer for Claude 3+. `gpt-tokenizer`'s
 * `o200k_base` is the best pre-flight estimator available, and Anthropic's own
 * documentation warns that tiktoken-family tokenizers **undercount Claude
 * tokens by roughly 15–20% on prose, and considerably more on code and
 * non-English text**. An uncalibrated pre-flight budget therefore
 * systematically *overfills* the context, which is the dangerous direction:
 * the run does not get a smaller answer, it gets a compaction nobody asked for
 * or a refusal three hours in.
 *
 * The fix is an EWMA of `actual / estimated` per **(provider, model)** and it
 * costs nothing: every completed node already has both numbers — the Tier-2
 * estimate of the rendered prompt, and Tier-1's `modelUsage[m].inputTokens`.
 *
 * Three decisions in here are load-bearing.
 *
 * **The first sample seeds rather than blends.** Blending sample one into the
 * family seed at `ALPHA` would leave 80% of a guess in the number after the
 * first real measurement, and the whole point of the seed is that it is a
 * stand-in for a measurement that has not happened yet.
 *
 * **The seed is applied until `n >= 5`, not until `n >= 1`.** A single node's
 * ratio is dominated by whatever that node's prompt happened to contain — a
 * code-heavy first node would swing an anthropic factor from 1.2 to 1.5 and
 * budget every later node against it. Five is where the average starts meaning
 * something; the architecture names it, so it is a constant here rather than a
 * judgement call at the call site.
 *
 * **The key is (provider, model), not provider.** F3.9 reroutes a node onto a
 * different model when a provider hits its quota, and a cheap model's ratio
 * corrupting an expensive one's budget is exactly the kind of failure nobody
 * would think to look for.
 *
 * Verifies: EPIC-09-S38, EPIC-09-S39 · KAR-09.7 AC4, AC5, AC7
 */

/** `ratio` is `actual / estimated`; `n` is how many samples produced it. */
export interface Calibration {
  readonly n: number;
  readonly ratio: number;
}

/** The EWMA weight the architecture names. Converges in roughly 20 samples. */
export const CALIBRATION_ALPHA = 0.2;

/** Below this many samples the family seed is applied instead of the learned
 * ratio (AC5). */
export const CALIBRATION_MIN_SAMPLES = 5;

/**
 * The per-family seeds, verbatim from §7.
 *
 * A *family* rather than a provider id: `claude` and a hypothetical second
 * Anthropic-model CLI share a tokenizer bias, and `codex` shares OpenAI's
 * (where `o200k_base` is the real tokenizer, hence 1.0). Everything else gets
 * `default`, which is a deliberately small correction — guessing large in
 * either direction is worse than guessing small, because the factor only has
 * to survive five nodes before it is replaced by measurement.
 */
export const CALIBRATION_SEEDS: Readonly<Record<string, number>> = {
  anthropic: 1.2,
  openai: 1.0,
  default: 1.05,
};

const DEFAULT_SEED_KEY = 'default';

/** The seed for `family`, or the default for a family with no entry. */
export function seedFactor(family: string): number {
  return CALIBRATION_SEEDS[family] ?? (CALIBRATION_SEEDS[DEFAULT_SEED_KEY] as number);
}

/** A calibration that has learned nothing yet: zero samples, the family seed
 * as its ratio, so a store that reads it back before the fifth sample still
 * reads a usable number. */
export function seededCalibration(family: string): Calibration {
  return { n: 0, ratio: seedFactor(family) };
}

/**
 * One sample, folded in (AC4).
 *
 * `estimated <= 0` returns the *same object*, not a copy: there was no sample,
 * so `n` must not advance, and identity makes "nothing happened" observable to
 * a caller that wants to skip a write.
 */
export function updateCalibration(
  calibration: Calibration,
  estimated: number,
  actual: number,
): Calibration {
  if (estimated <= 0) return calibration;
  const observed = actual / estimated;
  return {
    n: calibration.n + 1,
    ratio:
      calibration.n === 0
        ? observed
        : calibration.ratio * (1 - CALIBRATION_ALPHA) + observed * CALIBRATION_ALPHA,
  };
}

/** The factor a budget should actually multiply by: the family seed until five
 * samples exist, the learned ratio from the fifth on (AC5). */
export function appliedFactor(calibration: Calibration, family: string): number {
  return calibration.n >= CALIBRATION_MIN_SAMPLES ? calibration.ratio : seedFactor(family);
}

/**
 * A raw Tier-2 count, corrected.
 *
 * Rounded **up**, and that is the whole reason this is a function rather than a
 * multiplication at the call site: rounding a budget down is the same
 * systematic overfill the factor exists to remove, one token at a time.
 */
export function calibratedEstimate(tokens: number, factor: number): number {
  return Math.ceil(tokens * factor);
}
