/**
 * Migration 0014 — `intake_key`, KAR-10.1 AC6's `Idempotency-Key` map.
 *
 * `POST /api/runs` mints a `RunId` before `run.created` (or any other event
 * naming the run) exists to key a lookup on, so the mapping from an
 * operator-supplied `Idempotency-Key` header to the run it created cannot live
 * on the run itself — there is no run row yet at the moment the key first
 * needs to be checked. A dedicated table, keyed on the header value, is what
 * lets a repeat of the same key find the original `RunId` in one indexed read
 * before intake does any work a second time.
 *
 * Deliberately not the `effect` journal (migration 0007): that table's key is
 * `(runId, nodeId, attempt, ordinal)`, a shape that names a run this request
 * has not created yet on its first arrival. This is a different idempotency
 * concern — "was a run already created for this request" — answered before a
 * `RunId` exists to build an effect key from.
 */
import type { Migration } from '../migrate.ts';

export const migration0014IntakeKeys: Migration = {
  id: 14,
  name: 'intake-keys',
  up(db) {
    db.exec(`
      CREATE TABLE intake_key (
        idempotency_key TEXT    PRIMARY KEY,
        run_id          TEXT    NOT NULL,
        created_at      INTEGER NOT NULL
      ) STRICT
    `);
  },
};
