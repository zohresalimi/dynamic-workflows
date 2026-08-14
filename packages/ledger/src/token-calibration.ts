/**
 * KAR-09.7 — reading and writing the learned `tokenEstimateFactor`
 * (docs/08-context-and-memory.md §7).
 *
 * The EWMA itself lives in `@DeFlow/core` because it is arithmetic and NF9's
 * deterministic core is where arithmetic belongs; this module is the durable
 * half, and it exists for one reason: a factor held in the daemon's heap
 * resets to its seed on every restart, and that failure is *silent*. Nothing
 * errors. The pre-flight budget simply goes back to overfilling Anthropic
 * contexts by 15–20%, twenty nodes at a time, for ever.
 *
 * **A read never invents a row.** `readTokenCalibration` answers with the
 * family seed and `samples: 0` for a (provider, model) nobody has run yet, so
 * a caller budgeting its first node gets a usable number without a write
 * happening on a read path. The row appears the first time a sample is folded
 * in, which is also the first moment there is anything to store.
 *
 * **`appliedFactor` is computed here, not stored.** It is a function of
 * `samples` and `family`, and storing it would let the two disagree — the row
 * would then be a fourth place the switchover threshold lives.
 */
import type { Calibration, Db, DbStatement } from '@DeFlow/core';
import { appliedFactor, seedFactor, updateCalibration } from '@DeFlow/core';

/** One (provider, model)'s calibration, as a caller reads it. */
export interface TokenCalibrationRow {
  readonly provider: string;
  readonly model: string;
  /** Which seed applies while `samples` is below the switchover. */
  readonly family: string;
  readonly samples: number;
  /** The EWMA of `actual / estimated`. Equal to the family seed for a row
   * that has never been sampled. */
  readonly tokenEstimateFactor: number;
  /** What a budget should actually multiply by right now: the seed until five
   * samples exist, the learned factor from the fifth on. */
  readonly appliedFactor: number;
  /** ms epoch of the last sample, or `null` when there has never been one. */
  readonly updatedAt: number | null;
}

export interface TokenSample {
  readonly provider: string;
  readonly model: string;
  readonly family: string;
  /** DeFlow's own Tier-2 count of the rendered prompt. */
  readonly estimated: number;
  /** Tier 1's `modelUsage[model].inputTokens` for the same turn. */
  readonly actual: number;
  /** ms epoch, from the injected `Clock`. */
  readonly now: number;
}

const READ_ONE_SQL = `
  SELECT provider, model, family, samples, token_estimate_factor, updated_at
    FROM token_calibration
   WHERE provider = ? AND model = ?
`;

const READ_ALL_SQL = `
  SELECT provider, model, family, samples, token_estimate_factor, updated_at
    FROM token_calibration
   ORDER BY provider, model
`;

const UPSERT_SQL = `
  INSERT INTO token_calibration
    (provider, model, family, samples, token_estimate_factor, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (provider, model) DO UPDATE SET
    family                = excluded.family,
    samples               = excluded.samples,
    token_estimate_factor = excluded.token_estimate_factor,
    updated_at            = excluded.updated_at
`;

interface CalibrationDbRow {
  readonly provider: string;
  readonly model: string;
  readonly family: string;
  readonly samples: number;
  readonly token_estimate_factor: number;
  readonly updated_at: number;
}

function toRow(stored: CalibrationDbRow): TokenCalibrationRow {
  const calibration: Calibration = { n: stored.samples, ratio: stored.token_estimate_factor };
  return {
    provider: stored.provider,
    model: stored.model,
    family: stored.family,
    samples: stored.samples,
    tokenEstimateFactor: stored.token_estimate_factor,
    appliedFactor: appliedFactor(calibration, stored.family),
    updatedAt: stored.updated_at,
  };
}

/** An unsampled (provider, model): the family seed, and nothing learned. */
function unsampled(provider: string, model: string, family: string): TokenCalibrationRow {
  return {
    provider,
    model,
    family,
    samples: 0,
    tokenEstimateFactor: seedFactor(family),
    appliedFactor: seedFactor(family),
    updatedAt: null,
  };
}

/**
 * The calibration for one (provider, model), or the family seed when nothing
 * has been sampled yet.
 *
 * `family` is only consulted on the seed path — a stored row carries the family
 * it was written with, so a caller that passes a different one does not
 * retroactively change what an existing row means.
 */
export function readTokenCalibration(
  db: Db,
  provider: string,
  model: string,
  family = 'default',
): TokenCalibrationRow {
  const statement: DbStatement<CalibrationDbRow> = db.prepare(READ_ONE_SQL);
  const stored = statement.get(provider, model);
  return stored === undefined ? unsampled(provider, model, family) : toRow(stored);
}

/** Every calibration this installation has learned, oldest key first. What
 * `deflow doctor` prints (AC10). */
export function readTokenCalibrations(db: Db): readonly TokenCalibrationRow[] {
  const statement: DbStatement<CalibrationDbRow> = db.prepare(READ_ALL_SQL);
  return statement.all().map(toRow);
}

/**
 * Folds one completed node's (estimate, actual) pair into the stored factor
 * and returns the row as it now stands.
 *
 * A sample with `estimated <= 0` changes nothing and writes nothing — there is
 * no ratio to observe, and advancing `samples` for it would move the
 * switchover closer on the strength of a node that taught DeFlow nothing.
 */
export function recordTokenSample(db: Db, sample: TokenSample): TokenCalibrationRow {
  const upsert = db.prepare(UPSERT_SQL);

  return db.transaction(() => {
    const before = readTokenCalibration(db, sample.provider, sample.model, sample.family);
    const after = updateCalibration(
      { n: before.samples, ratio: before.tokenEstimateFactor },
      sample.estimated,
      sample.actual,
    );
    if (after.n === before.samples) return before;

    upsert.run(
      sample.provider,
      sample.model,
      // A row's family is whatever the most recent sample said it was: the
      // provider registry is the one place that mapping lives, and a stale
      // family in a row nobody has sampled since is not worth preserving.
      sample.family,
      after.n,
      after.ratio,
      sample.now,
    );
    return {
      provider: sample.provider,
      model: sample.model,
      family: sample.family,
      samples: after.n,
      tokenEstimateFactor: after.ratio,
      appliedFactor: appliedFactor(after, sample.family),
      updatedAt: sample.now,
    };
  });
}
