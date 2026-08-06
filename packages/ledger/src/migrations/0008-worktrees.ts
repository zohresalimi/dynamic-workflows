/**
 * Migration 0008 — `worktrees`, an **index over git** rather than a record of
 * it (docs/09-workspace-and-safety.md §4.3, KAR-07.2).
 *
 * > Git is the authority; SQLite is an index over it. The moment a user runs
 * > `git worktree remove` by hand — and they will — a SQLite-authoritative
 * > design is wrong and does not know it.
 *
 * Four things about the shape follow from that sentence:
 *
 * - **`path` is the primary key**, because it is git's own identity for a
 *   worktree. Not a synthetic id and not `(run_id, node_id)`: an operator can
 *   create a worktree DeFlow knows nothing about, and this table has to be able
 *   to hold it.
 * - **`run_id` and `node_id` are nullable and derived**, parsed out of the lock
 *   reason DeFlow itself wrote (`DeFlow run=<runId> node=<nodeId>`). Git
 *   reports that reason back verbatim in `worktree list --porcelain`, so the
 *   association travels *in the repository* and this column is a convenience
 *   over it — never a second place the truth lives. Someone else's worktree,
 *   or one locked by a human with their own reason, simply has NULLs here.
 * - **`prunable` is a stored flag, not a derived one.** A worktree whose
 *   directory was `rm -rf`'d is still listed by git, marked prunable, and it
 *   must be visible as scheduled-for-reaping rather than either live or absent.
 * - **No timestamps beyond `refreshed_at`.** This table answers "what did git
 *   say the last time we asked"; anything historical belongs in the event log,
 *   which is where `workspace.worktree_created` and `workspace.reconciled`
 *   already are.
 *
 * There is no index besides the primary key. The whole table is read at once by
 * the projection refresh and by the UI, and it holds one row per live worktree
 * — tens, not thousands.
 *
 * Append-only and never edited once shipped — see
 * `test/migrations-content-hash.test.ts`.
 */
import type { Migration } from '../migrate.ts';

export const migration0008Worktrees: Migration = {
  id: 8,
  name: 'worktrees',
  up(db) {
    db.exec(`
      CREATE TABLE worktrees (
        path            TEXT    NOT NULL PRIMARY KEY,
        head            TEXT,
        branch          TEXT,
        detached        INTEGER NOT NULL CHECK (detached IN (0, 1)),
        bare            INTEGER NOT NULL CHECK (bare IN (0, 1)),
        locked          INTEGER NOT NULL CHECK (locked IN (0, 1)),
        lock_reason     TEXT,
        prunable        INTEGER NOT NULL CHECK (prunable IN (0, 1)),
        prunable_reason TEXT,
        run_id          TEXT,
        node_id         TEXT,
        refreshed_at    INTEGER NOT NULL
      ) STRICT
    `);
  },
};
