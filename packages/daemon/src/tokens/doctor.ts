/**
 * KAR-09.7 AC10 — the calibration section of `deflow doctor`.
 *
 * The command itself is EPIC-18 (KAR-18.4); this module holds the policy ahead
 * of it existing, the same split `../git/version.ts` and `../proc/auth-shadow.ts`
 * already use for the git version floor and the auth-shadowing check.
 *
 * **Both numbers, always.** A report that printed only the factor would let an
 * operator read a learned 1.31 and conclude the estimator is running when in
 * fact three samples exist and the 1.2 seed is what every budget is still
 * multiplying by. The sample count is what distinguishes "calibrated" from
 * "seeded", and the two lines below say which one is in force in words rather
 * than leaving it to be inferred from a threshold nobody remembers.
 */

import type { Db } from '@DeFlow/core';
import { CALIBRATION_MIN_SAMPLES } from '@DeFlow/core';
import { readTokenCalibrations, type TokenCalibrationRow } from '@DeFlow/ledger';

/** Four significant-ish digits: a ratio is a correction, and printing it to
 * fifteen places makes the interesting digits harder to find. */
const formatFactor = (factor: number): string =>
  factor.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0');

/** One printable line per calibrated (provider, model). */
export function tokenCalibrationLines(rows: readonly TokenCalibrationRow[]): readonly string[] {
  return rows.map((row) => {
    const learned = `${formatFactor(row.tokenEstimateFactor)} from ${row.samples} samples`;
    const applied =
      row.samples >= CALIBRATION_MIN_SAMPLES
        ? `applying ${formatFactor(row.appliedFactor)}`
        : `applying the ${row.family} seed ${formatFactor(row.appliedFactor)} until ` +
          `${CALIBRATION_MIN_SAMPLES} samples exist`;
    return `${row.provider}/${row.model}: tokenEstimateFactor ${learned}, ${applied}`;
  });
}

/** The whole section, as `deflow doctor` will print it. */
export function renderTokenCalibrationReport(rows: readonly TokenCalibrationRow[]): string {
  const lines = tokenCalibrationLines(rows);
  if (lines.length === 0) {
    return (
      'token estimate calibration: no (provider, model) has been calibrated yet — ' +
      'every pre-flight budget is using its family seed.'
    );
  }
  return ['token estimate calibration:', ...lines.map((line) => `  ${line}`)].join('\n');
}

/** The same report, read from a ledger. */
export function tokenCalibrationReport(db: Db): string {
  return renderTokenCalibrationReport(readTokenCalibrations(db));
}
