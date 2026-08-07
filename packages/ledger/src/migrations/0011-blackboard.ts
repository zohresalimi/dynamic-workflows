/**
 * Migration 0011 — `fact` and `fact_edges`, the blackboard as a materialised
 * view (docs/08-context-and-memory.md §8.1, docs/04-domain-model.md §5.1,
 * KAR-09.8).
 *
 * These are the only two tables in the ledger that may be dropped without
 * losing anything: `fact.written`, `fact.read` and `fact.invalidated` are the
 * truth, and `rebuildBlackboard` puts both tables back from seq 0. That is not
 * a nice property to have — it is what makes F10.4's memory graph and NF10's
 * auditability fall out of the event log instead of needing an instrumentation
 * project of their own.
 *
 * Four things about the shape:
 *
 * - **`fact_edges` has no primary key and no uniqueness.** An edge is an
 *   *event*: the same node reading the same fact twice is two edges, at two
 *   seqs, and collapsing them would erase the second read from the graph. Its
 *   two indexes are the two directions the graph is walked — "who touched this
 *   fact" (`fact_edges_by_fact`) and "what did this node touch"
 *   (`fact_edges_by_node`) — and §8.2's taint query is the first one with a
 *   `direction`/`event_seq` filter applied.
 * - **`direction` is CHECK-constrained rather than trusted.** It has exactly
 *   two values for ever; a third would mean an edge nobody's query knows how
 *   to interpret, and the constraint is free.
 * - **`invalidated_by` and `invalidated_reason` are columns on `fact`, not a
 *   third table, and they are the *only* mutable cells here.** Which nodes a
 *   given invalidation taints is deliberately not stored: it is derived from
 *   `fact_edges` with `event_seq < invalidated_by` on every read, because a
 *   node may read the fact *after* the invalidation and must not be tainted by
 *   it (EPIC-09-S44) — and a stored answer would come back from a rebuild
 *   wrong in exactly that case.
 * - **`at_event` beside `at`.** `at` is ISO 8601 and display-only; ordering is
 *   always by `at_event`, because the wall clock is not monotonic and a laptop
 *   that slept mid-run must not be able to reorder the blackboard.
 *
 * The DDL below is a frozen copy of `BLACKBOARD_SCHEMA` in `../blackboard.ts`,
 * which is what `rebuildBlackboard` recreates the tables with. It is duplicated
 * rather than imported because a shipped migration must run the same bytes
 * next year that it ran today, and `test/integration/blackboard-rebuild.test.ts`
 * compares `sqlite_master` after a migration against `sqlite_master` after a
 * rebuild so the two cannot drift silently.
 *
 * Append-only and never edited once shipped — see
 * `test/migrations-content-hash.test.ts`.
 */
import type { Migration } from '../migrate.ts';

export const migration0011Blackboard: Migration = {
  id: 11,
  name: 'blackboard',
  up(db) {
    db.exec(`CREATE TABLE fact (
        fact_id            TEXT    NOT NULL PRIMARY KEY,
        run_id             TEXT    NOT NULL,
        key                TEXT    NOT NULL,
        kind               TEXT    NOT NULL,
        schema_id          TEXT    NOT NULL,
        value              TEXT    NOT NULL,
        by_node            TEXT    NOT NULL,
        by_provider        TEXT    NOT NULL,
        by_model           TEXT    NOT NULL,
        from_evidence      TEXT    NOT NULL,
        at_event           INTEGER NOT NULL,
        at                 TEXT    NOT NULL,
        confidence         TEXT    NOT NULL CHECK (confidence IN ('asserted','verified','speculative')),
        supersedes         TEXT,
        invalidated_by     INTEGER,
        invalidated_reason TEXT,
        written_seq        INTEGER NOT NULL
      ) STRICT`);
    db.exec('CREATE INDEX fact_by_run_key ON fact(run_id, key, at_event)');
    db.exec(`CREATE TABLE fact_edges (
        fact_id   TEXT    NOT NULL,
        run_id    TEXT    NOT NULL,
        node_id   TEXT    NOT NULL,
        direction TEXT    NOT NULL CHECK (direction IN ('read','write')),
        event_seq INTEGER NOT NULL
      ) STRICT`);
    db.exec('CREATE INDEX fact_edges_by_fact ON fact_edges(fact_id, event_seq)');
    db.exec('CREATE INDEX fact_edges_by_node ON fact_edges(node_id, event_seq)');
  },
};
