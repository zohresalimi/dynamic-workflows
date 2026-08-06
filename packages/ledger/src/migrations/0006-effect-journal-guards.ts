/**
 * Migration 0006 — the triggers that make the `effect` journal's history
 * unrewritable (KAR-06.3 AC8, docs/05-durable-execution.md §8.2).
 *
 * The `effect` table has existed since 0001. What it has never had is a rule
 * about how a row may change, and the rule is the whole point of the table: a
 * row records that a side effect was *intended*, and the only honest edit to
 * that record is the one that says how it turned out. Everything else — a
 * second attempt rewriting the memoised result, a repair script resetting a
 * `done` row to `pending` so it "runs again", a prune that deletes old rows —
 * silently converts "this already happened" into "this never happened", which
 * is exactly the confusion the journal exists to prevent.
 *
 * So the shape is enforced by four triggers rather than by convention:
 *
 * 1. **Born pending.** An `INSERT` may only create a `pending` row. A row that
 *    arrives already `done` is a memoised result for work nobody recorded
 *    intending to perform, and it would short-circuit an effect that never ran.
 * 2. **One transition, one direction.** An `UPDATE` is legal only when it moves
 *    `pending` to `done` or to `failed`. Every other update — including one
 *    that leaves `state` alone and rewrites `result_json` — is refused, so a
 *    terminal row is frozen the instant it becomes terminal.
 * 3. **Identity is immutable.** `ikey`, the four key components, `kind`,
 *    `request_hash` and `started_at` describe what was asked for and when; none
 *    of them can become truer later. Editing `request_hash` in particular would
 *    disable the guard in AC7 by making the stored hash agree with whatever is
 *    being asked for now.
 * 4. **Never deleted.** There is no retention story for this table and there
 *    should not be one: the row is small, and the moment it is gone the effect
 *    it describes is indistinguishable from one that never started.
 *
 * A trigger rather than a `CHECK`: `CHECK` sees one row's new values and cannot
 * compare them against the values that row already had, which is the entire
 * question here. Rewriting the table to add constraints would also mean copying
 * every row of a live journal, and the constraint we want is about transitions
 * anyway.
 *
 * Append-only and never edited once shipped — see
 * `test/migrations-content-hash.test.ts`. A later change to these rules is
 * migration 0007.
 */
import type { Migration } from '../migrate.ts';

export const migration0006EffectJournalGuards: Migration = {
  id: 6,
  name: 'effect-journal-guards',
  up(db) {
    db.exec(`
      CREATE TRIGGER effect_born_pending
      BEFORE INSERT ON effect
      WHEN NEW.state <> 'pending'
      BEGIN
        SELECT RAISE(
          ABORT,
          'effect rows are written pending, before the side effect: an effect row inserted in any other state is a memoised outcome for work no intent recorded'
        );
      END
    `);

    db.exec(`
      CREATE TRIGGER effect_state_moves_once
      BEFORE UPDATE ON effect
      WHEN NOT (OLD.state = 'pending' AND NEW.state IN ('done', 'failed'))
      BEGIN
        SELECT RAISE(
          ABORT,
          'the only legal edit to an effect row moves it from pending to done or failed; a terminal row is frozen, and re-opening one turns "this already happened" into "this never happened"'
        );
      END
    `);

    db.exec(`
      CREATE TRIGGER effect_identity_immutable
      BEFORE UPDATE ON effect
      WHEN OLD.ikey <> NEW.ikey
        OR OLD.run_id <> NEW.run_id
        OR OLD.node_id <> NEW.node_id
        OR OLD.attempt <> NEW.attempt
        OR OLD.ordinal <> NEW.ordinal
        OR OLD.kind <> NEW.kind
        OR OLD.request_hash <> NEW.request_hash
        OR OLD.started_at <> NEW.started_at
      BEGIN
        SELECT RAISE(
          ABORT,
          'an effect row identity — ikey, run_id, node_id, attempt, ordinal, kind, request_hash, started_at — describes what was asked for and cannot be edited; rewriting request_hash would disable the guard that catches a plan edit landing under a journalled effect'
        );
      END
    `);

    db.exec(`
      CREATE TRIGGER effect_never_deleted
      BEFORE DELETE ON effect
      BEGIN
        SELECT RAISE(
          ABORT,
          'effect rows are never deleted: a missing row is indistinguishable from an effect that never started, which is the one thing the journal exists to tell apart'
        );
      END
    `);
  },
};
