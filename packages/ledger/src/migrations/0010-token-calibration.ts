/**
 * Migration 0010 — `token_calibration`, the learned half of the capability
 * manifest (docs/08-context-and-memory.md §7, KAR-09.7).
 *
 * `provider_capabilities` records what a probe *found*; this records what
 * running nodes have *taught* DeFlow about the same provider. They are two
 * tables rather than two column groups because their lifecycles are opposites:
 * a probed row is written once and never overwritten (a version bump is a new
 * row), while a calibration row is overwritten after every node. Putting a
 * mutable factor inside an append-only manifest would destroy the record the
 * resume-poisoning guard compares against.
 *
 * - **`(provider, model)` is the primary key**, not `provider`. F3.9 reroutes
 *   a node onto a different model when a provider hits its quota, and a cheap
 *   model's ratio corrupting an expensive one's pre-flight budget is a failure
 *   nobody would think to look for.
 * - **`samples` sits beside `token_estimate_factor`.** The seed is applied
 *   until five samples exist, so a reader that has the ratio and not the count
 *   cannot tell a learned 1.2 from an unlearned one — and `DeFlow doctor`
 *   prints both for exactly that reason (AC10).
 * - **`family` is stored, not derived.** It decides which seed applies while
 *   `samples < 5`, and deriving it at read time would mean a row written by
 *   one build could be read against a different mapping by the next.
 * - **`token_estimate_factor` is REAL**, because it is a ratio and rounding it
 *   to an integer would discard the entire correction.
 *
 * No index besides the primary key: every read is either one (provider, model)
 * or the whole table for the doctor report, and the table holds one row per
 * model an installation has ever run.
 *
 * Append-only and never edited once shipped — see
 * `test/migrations-content-hash.test.ts`.
 */
import type { Migration } from '../migrate.ts';

export const migration0010TokenCalibration: Migration = {
  id: 10,
  name: 'token-calibration',
  up(db) {
    db.exec(`
      CREATE TABLE token_calibration (
        provider              TEXT    NOT NULL,
        model                 TEXT    NOT NULL,
        family                TEXT    NOT NULL,
        samples               INTEGER NOT NULL,
        token_estimate_factor REAL    NOT NULL,
        updated_at            INTEGER NOT NULL,
        PRIMARY KEY (provider, model)
      ) STRICT
    `);
  },
};
