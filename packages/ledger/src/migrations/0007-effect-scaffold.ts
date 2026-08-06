/**
 * Migration 0007 — one more legal edit to a `pending` effect row: its
 * `result_json` scaffold (KAR-06.4 AC5, docs/05-durable-execution.md §8.3).
 *
 * 0006's `effect_state_moves_once` allowed exactly one transition — `pending`
 * to `done` or `failed` — and that was one rule too many, for a reason that
 * only becomes visible when the `shell` probe is written.
 *
 * A `mutating` shell command reconciles by comparing a hash of
 * `git status --porcelain` against the hash journalled **before** the command
 * ran and the hash journalled the instant it returned. Both have to be durable
 * while the row is still `pending`, because the crash they exist to survive is
 * precisely the one that happens before the row goes terminal. Journalling
 * them anywhere else was considered and is worse: an event would put a
 * mechanical detail nobody replays into the timeline, and a side table would
 * be a second place an effect's state lives.
 *
 * So the trigger is replaced — not edited; 0006's file is untouched and stays
 * shipped — with one that permits `pending → pending` when `ended_at` is still
 * `NULL`. Combined with `effect_identity_immutable`, which 0006 already
 * installed and this migration deliberately leaves alone, the only column such
 * an update can change is `result_json`. Everything else 0006 refused is still
 * refused:
 *
 * - a row inserted in any state but `pending` (0006's `effect_born_pending`);
 * - any edit to a `done` or `failed` row, including one that only rewrites
 *   `result_json` — a terminal row is frozen the instant it becomes terminal;
 * - `ended_at` set while the state still says `pending`, which would claim the
 *   effect finished and leave no record of how;
 * - a delete, ever.
 *
 * `DROP TRIGGER` then `CREATE TRIGGER` rather than an `ALTER`: SQLite has no
 * way to modify a trigger in place, and the pair runs inside the migration
 * runner's transaction, so no ledger is ever open with neither rule installed.
 *
 * Append-only and never edited once shipped — see
 * `test/migrations-content-hash.test.ts`.
 */
import type { Migration } from '../migrate.ts';

export const migration0007EffectScaffold: Migration = {
  id: 7,
  name: 'effect-scaffold',
  up(db) {
    db.exec('DROP TRIGGER effect_state_moves_once');

    db.exec(`
      CREATE TRIGGER effect_state_moves_once
      BEFORE UPDATE ON effect
      WHEN NOT (
        (OLD.state = 'pending' AND NEW.state IN ('done', 'failed'))
        OR (OLD.state = 'pending' AND NEW.state = 'pending' AND NEW.ended_at IS NULL)
      )
      BEGIN
        SELECT RAISE(
          ABORT,
          'a pending effect row may take a result_json scaffold or move to done or failed, and nothing else; a terminal row is frozen, and re-opening one turns "this already happened" into "this never happened"'
        );
      END
    `);
  },
};
