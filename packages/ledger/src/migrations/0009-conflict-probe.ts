/**
 * Migration 0009 — `conflict_probe`, the live pairwise conflict matrix
 * (docs/09-workspace-and-safety.md §6.2, KAR-07.6, Decision D14).
 *
 * `git merge-tree --write-tree` is ground truth for conflict, and it is cheap
 * enough to run after every write-node commit. This table is where those
 * answers live, and its shape follows from one question the scheduler asks
 * constantly: *is the answer I stored still true?*
 *
 * - **`(run_id, branch_a, branch_b)` is the primary key.** The pair is the
 *   identity; probing it again updates the row rather than appending to a
 *   history nobody reads. The pair is normalized before the key is formed
 *   (../conflict-probe.ts), so `(a,b)` and `(b,a)` cannot become two rows
 *   holding two answers to one question.
 * - **Both tips are stored.** Three columns that turn "is this still true?"
 *   from unanswerable into a comparison. Without them the table is a source of
 *   confidently wrong scheduling decisions the moment a node commits again,
 *   and that failure is silent — which is the worst kind this system has.
 * - **`path_count` beside `paths_json`.** The merge queue orders by ascending
 *   conflict count (§7.1) and the collision map renders it; neither should
 *   have to parse JSON in SQL to sort. It is derived on write from the paths
 *   themselves, in the one place that knows both.
 * - **`clean` is 0/1**, because SQLite under `STRICT` has no boolean type. The
 *   conversion lives at the ../conflict-probe.ts boundary.
 *
 * No index besides the primary key. A run holds one row per branch pair — tens
 * for a five-node fan-out — and every read is either the whole run's matrix or
 * one pair by its key.
 *
 * Append-only and never edited once shipped — see
 * `test/migrations-content-hash.test.ts`.
 */
import type { Migration } from '../migrate.ts';

export const migration0009ConflictProbe: Migration = {
  id: 9,
  name: 'conflict-probe',
  up(db) {
    db.exec(`
      CREATE TABLE conflict_probe (
        run_id     TEXT    NOT NULL,
        branch_a   TEXT    NOT NULL,
        branch_b   TEXT    NOT NULL,
        probed_at  INTEGER NOT NULL,
        a_commit   TEXT    NOT NULL,
        b_commit   TEXT    NOT NULL,
        clean      INTEGER NOT NULL CHECK (clean IN (0, 1)),
        path_count INTEGER NOT NULL,
        paths_json TEXT    NOT NULL,
        PRIMARY KEY (run_id, branch_a, branch_b)
      ) STRICT
    `);
  },
};
