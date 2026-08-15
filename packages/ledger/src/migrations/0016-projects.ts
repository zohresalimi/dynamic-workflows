/**
 * Migration 0016 — `project`, KAR-22.1's map from a name to a repository.
 *
 * A **table, not an event stream**, and that is the decision worth recording
 * here rather than only in the epic file. The `event` log is a run's history:
 * append-only, replayed by `reduce()`, and never mutated. A project has a
 * rename and a delete, so expressing it as events would mean a projection over
 * three kinds to answer "what projects are there" — for state whose whole
 * lifecycle is CRUD. `provider_capabilities` (0004) and `worktrees` (0008) are
 * tables for the same reason.
 *
 * `path` is `UNIQUE` and holds the **realpath**. A directory has several
 * spellings — a trailing slash, a symlink, the resolved form — and a
 * constraint over the string a caller happened to send is satisfied by all of
 * them at once, which would give one directory three projects, three histories
 * and one set of files. Resolving before the insert is what makes the
 * constraint mean what it says.
 *
 * There is deliberately **no** foreign key to a run, and no run column here.
 * What links a run to a project is `task.submitted`'s own provenance, so
 * deleting a project cannot orphan a run's record of where it came from — see
 * KAR-22.1 AC6, whose whole point is that removing a project destroys nothing.
 */
import type { Migration } from '../migrate.ts';

export const migration0016Projects: Migration = {
  id: 16,
  name: 'projects',
  up(db) {
    db.exec(`
      CREATE TABLE project (
        id         TEXT    PRIMARY KEY,
        name       TEXT    NOT NULL,
        path       TEXT    NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT
    `);
    // Listing is the common read and it is ordered by creation; the primary
    // key already sorts that way (`prj_<timestamp>_<hex>`), so this index is
    // for the *other* order — most recently touched first — which the UI wants
    // once a machine holds more projects than fit on a screen.
    db.exec('CREATE INDEX project_updated ON project(updated_at DESC)');
  },
};
