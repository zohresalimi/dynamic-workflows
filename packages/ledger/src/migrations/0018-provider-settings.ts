/**
 * Migration 0018 — `provider_setting`, KAR-25.3's record that a runtime is
 * disabled.
 *
 * A **table, not an event stream**, for the exact reason 0016 and 0017 give:
 * enabling and disabling a runtime is CRUD with an add and a remove — "this
 * provider is currently disabled" — not a fact whose history a run ever reads.
 * Expressing it as `provider.disabled` / `provider.enabled` events would mean
 * a projection over two kinds to answer one boolean, for state nothing but
 * this machine's own settings screen ever asks about.
 *
 * It is **not** a column on `provider_capabilities` (0004): that table is one
 * row per successful probe — a fact about a binary this machine found — and a
 * provider can be disabled whether or not it has ever been probed (or ever
 * will be, since disabling it is precisely what stops the picker and admission
 * from offering it). Folding a policy flag onto a capability row would make
 * "disabled" disappear the moment a re-probe inserted a new row.
 *
 * It is also **not** `.DeFlow/config.yaml`: that document is workspace-scoped
 * (`GET/PATCH /api/config?cwd=`), and enable/disable is machine-wide —
 * `/settings` never reads a `projectId` (KAR-25.2 AC1), and a policy stored
 * per repository would answer differently for the same provider in two
 * checkouts of the same machine.
 *
 * The primary key is the provider id alone: one row per registry entry, at
 * most, and inserting the same provider twice moves the existing row rather
 * than duplicating it (`setProviderDisabled`'s `ON CONFLICT`). There is no
 * foreign key to anything — `provider` is a `PROVIDER_SPECS` key, not a row
 * from another table this ledger owns, and a provider dropped from a future
 * build should not orphan-delete a row it has no way to reach.
 */
import type { Migration } from '../migrate.ts';

export const migration0018ProviderSettings: Migration = {
  id: 18,
  name: 'provider-settings',
  up(db) {
    db.exec(`
      CREATE TABLE provider_setting (
        provider   TEXT    NOT NULL PRIMARY KEY,
        disabled   INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT
    `);
  },
};
