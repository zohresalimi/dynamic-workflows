/**
 * Migration 0004 — `provider_capabilities`, the probed manifest
 * (docs/07-provider-adapter-layer.md §6, KAR-05.2).
 *
 * Every routing decision reads a row of this table: can this agent resume?
 * can it fork? does it take `mcpCapabilities.acp`? The alternative — a
 * per-vendor constant in the source — is the project's highest-value *silent*
 * risk (A0-9), because a stale table does not produce an error, it produces a
 * wrong routing decision hours into a run. Two of the five versions in the
 * measured matrix were published the same day they were measured.
 *
 * Three things about the shape are deliberate:
 *
 * - **The primary key is three-part.** A version bump or a rebuilt binary
 *   writes a *new row*, so the history of what an installed agent could do is
 *   preserved and a diff is visible. Updating in place would destroy exactly
 *   what the resume poisoning guard (§6.1) needs to compare a running node
 *   against.
 * - **`caps_json` is TEXT holding the entire `initialize` response,
 *   unmodified.** Not a set of extracted columns: persisting the response
 *   verbatim is what lets a future DeFlow answer a question nobody thought to
 *   ask today, and what stops this table from becoming the hardcoded matrix in
 *   a different costume.
 * - **`binary_path` is absolute.** DeFlowd's `PATH` is not the user's
 *   login-shell `PATH` (§4.3), so a bare name resolved again at spawn time is
 *   a machine-specific "works for me" failure.
 *
 * There is no `run_id` column and no foreign key to one: what an installed
 * binary can do is a fact about the machine, not about a run, and it outlives
 * every run that read it.
 */
import type { Migration } from '../migrate.ts';

export const migration0004ProviderCapabilities: Migration = {
  id: 4,
  name: 'provider-capabilities',
  up(db) {
    db.exec(`
      CREATE TABLE provider_capabilities (
        provider       TEXT    NOT NULL,
        version        TEXT    NOT NULL,
        binary_sha256  TEXT    NOT NULL,
        binary_path    TEXT    NOT NULL,
        caps_json      TEXT    NOT NULL,
        probed_at      INTEGER NOT NULL,
        PRIMARY KEY (provider, version, binary_sha256)
      ) STRICT
    `);
  },
};
