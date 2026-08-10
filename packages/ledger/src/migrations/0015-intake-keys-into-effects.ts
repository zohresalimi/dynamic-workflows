/**
 * Migration 0015 — the API-level `Idempotency-Key` moves into the `effect`
 * journal, and `intake_key` is dropped (KAR-15.5 AC5).
 *
 * Migration 0014 gave the key a table of its own and argued for it: the effect
 * journal's key is `(runId, nodeId, attempt, ordinal)`, a shape that names a
 * run the first arrival of a request has not created yet. That argument is
 * about the *engine's* key format, not about the table — and
 * `docs/11-api-and-realtime.md` §11.3 has always said the opposite about the
 * table: *"it is stored in the `effect` journal alongside engine-level
 * idempotency keys, not in a separate table."* The journal's primary key is one
 * text column, so a namespaced `intake:<header value>` fits it without touching
 * the engine's format, and a run creation is an effect in exactly the sense
 * §8.2 means — intent, result, and a retry that reads the result back.
 *
 * The rows are **copied, not dropped**. A retried `POST /api/runs` arriving
 * after an upgrade must still find the run its key already minted; discarding
 * the mapping would start a second run for a request that already succeeded,
 * which is the failure the key exists to prevent.
 *
 * Two fields cannot be recovered for a migrated row, and both are recorded
 * honestly rather than invented:
 *
 * - **`request_hash`** is `migrated`. The original request body was never
 *   stored, so no digest over it can be produced now; a plausible-looking
 *   `sha256-000…` would be a hash that matches nothing and reads as one that
 *   does.
 * - **`result_json`** is rebuilt from the ledger as `{ runId, seq, status }` —
 *   the same three fields the route returns, with `seq` read as the run's first
 *   event, which is what KAR-10.1's repeat path derived it as. So a retry after
 *   this migration is answered with the body the pre-migration daemon would
 *   have answered with, not with a different one.
 *
 * Append-only and never edited once shipped — see
 * `test/migrations-content-hash.test.ts`.
 */
import type { Migration } from '../migrate.ts';

export const migration0015IntakeKeysIntoEffects: Migration = {
  id: 15,
  name: 'intake-keys-into-effects',
  up(db) {
    // Born `pending`, because migration 0006's `effect_born_pending` trigger
    // refuses any other insert — the completion below is the second half.
    db.exec(`
      INSERT INTO effect
        (ikey, run_id, node_id, attempt, ordinal, kind, request_hash, state, started_at)
      SELECT 'intake:' || idempotency_key, run_id, ':intake', 0, 0, 'intake', 'migrated',
             'pending', created_at
        FROM intake_key
    `);

    // Terminal immediately: a `pending` row is what the next daemon life
    // inherits and reconciles, and there is nothing here to reconcile.
    db.exec(`
      UPDATE effect
         SET state = 'done',
             ended_at = started_at,
             result_json = '{"runId":"' || run_id || '","seq":' ||
               coalesce((SELECT min(seq) FROM event WHERE event.run_id = effect.run_id), 0) ||
               ',"status":"awaiting-spec-approval"}'
       WHERE kind = 'intake' AND state = 'pending'
    `);

    db.exec('DROP TABLE intake_key');
  },
};
