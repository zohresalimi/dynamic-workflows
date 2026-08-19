/**
 * KAR-25.3 AC3 — the `provider_setting` table's one read and one write
 * (migration 0018).
 *
 * Storage only, shaped like `./connectors.ts`: a provider's disabled bit and
 * when it last changed, nothing else. Every fact about *whether a binary is
 * on this machine* still comes from `resolveProviderStates` (`@DeFlow/adapters`)
 * or a probed `provider_capabilities` row — this table holds one fact and one
 * fact only, *does the operator want DeFlow to use it*, which is why it has no
 * column this file's own callers could confuse with either of those.
 *
 * Time arrives as a plain millisecond epoch (NF9). There is no `Date.now()` in
 * this file and there must not be.
 */
import type { Db } from '@DeFlow/core';

export interface ProviderSettingRecord {
  /** A `PROVIDER_SPECS` key. Not a foreign key — see the migration's own
   *  header comment for why. */
  readonly provider: string;
  readonly disabled: boolean;
  /** ms epoch, from the caller's `Clock`. */
  readonly updatedAt: number;
}

interface ProviderSettingRow {
  readonly provider: string;
  readonly disabled: number;
  readonly updated_at: number;
}

const toRecord = (row: ProviderSettingRow): ProviderSettingRecord => ({
  provider: row.provider,
  disabled: row.disabled !== 0,
  updatedAt: row.updated_at,
});

/** Every provider this machine has an explicit setting for. A provider with
 *  no row here has never been toggled, which reads as "enabled" everywhere
 *  this is consulted — the table only ever has to hold the exceptions. */
export function listProviderSettings(db: Db): readonly ProviderSettingRecord[] {
  return db
    .prepare<ProviderSettingRow>(
      'SELECT provider, disabled, updated_at FROM provider_setting ORDER BY provider ASC',
    )
    .all()
    .map(toRecord);
}

/**
 * Sets whether `provider` is disabled, upserting the one row it owns.
 *
 * `updatedAt` always moves to the caller's clock, including when the value is
 * unchanged: this is a policy the operator just set, on the settings screen,
 * a moment ago, and a row that quietly kept an old timestamp because the new
 * value happened to match the old one would be lying about when the operator
 * last confirmed it.
 */
export function setProviderDisabled(
  db: Db,
  provider: string,
  disabled: boolean,
  updatedAt: number,
): void {
  db.prepare(
    `INSERT INTO provider_setting (provider, disabled, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT (provider) DO UPDATE SET disabled = excluded.disabled, updated_at = excluded.updated_at`,
  ).run(provider, disabled ? 1 : 0, updatedAt);
}
