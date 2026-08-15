/**
 * KAR-22.1 — the `project` table's five reads and writes (migration 0016).
 *
 * Storage only. Nothing here touches the filesystem, spawns `git` or decides
 * whether a path is still a repository: those are questions about the outside
 * world, they change while nobody is looking, and they belong to the daemon —
 * see `packages/daemon/src/projects/projects.ts`. What lives here is the row.
 *
 * `path` arrives already resolved. This module does not call `realpath`,
 * because `@DeFlow/ledger` may not perform I/O the caller did not ask for, and
 * because a store that silently rewrote its own key would make
 * `readProjectByPath` answer for a path nobody passed it.
 *
 * Time arrives as a plain millisecond epoch (NF9). There is no `Date.now()` in
 * this file and there must not be: `created_at` is what orders a list, and a
 * clock read here would be one the caller's `TestClock` could not control.
 */
import type { Db, ProjectId } from '@DeFlow/core';

export interface ProjectRecord {
  readonly id: ProjectId;
  readonly name: string;
  /** Absolute and already `realpath`-resolved by the caller. */
  readonly path: string;
  /** ms epoch, from the caller's `Clock`. */
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly created_at: number;
  readonly updated_at: number;
}

const toRecord = (row: ProjectRow): ProjectRecord => ({
  id: row.id as ProjectId,
  name: row.name,
  path: row.path,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT = 'SELECT id, name, path, created_at, updated_at FROM project';

/**
 * Records a project.
 *
 * Returns `'exists'` — rather than throwing — when this path already belongs to
 * one: two people creating the same project is a *conflict to report*, not a
 * program error, and the caller needs the existing id to say which project it
 * collided with. `INSERT … ON CONFLICT DO NOTHING` and a read, in one
 * transaction, so the answer cannot be raced.
 */
export function insertProject(
  db: Db,
  record: ProjectRecord,
): { readonly outcome: 'inserted' } | { readonly outcome: 'exists'; readonly existing: ProjectId } {
  return db.transaction(() => {
    const changed = db
      .prepare(
        `INSERT INTO project (id, name, path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (path) DO NOTHING`,
      )
      .run(record.id, record.name, record.path, record.createdAt, record.updatedAt).changes;

    if (changed === 1) return { outcome: 'inserted' as const };

    const existing = db.prepare<ProjectRow>(`${SELECT} WHERE path = ?`).get(record.path);
    if (existing === undefined) {
      // The insert was refused and no row holds the path: the only remaining
      // explanation is a collision on the primary key, which means a minted id
      // was reused. That is a bug, not a state to paper over.
      throw new Error(`could not record project '${record.id}': its id is already in use`);
    }
    return { outcome: 'exists' as const, existing: existing.id as ProjectId };
  });
}

/** Every project, oldest first — the order the ids themselves sort in. */
export function listProjects(db: Db): readonly ProjectRecord[] {
  return db.prepare<ProjectRow>(`${SELECT} ORDER BY id`).all().map(toRecord);
}

export function readProject(db: Db, id: ProjectId): ProjectRecord | null {
  const row = db.prepare<ProjectRow>(`${SELECT} WHERE id = ?`).get(id);
  return row === undefined ? null : toRecord(row);
}

export function readProjectByPath(db: Db, path: string): ProjectRecord | null {
  const row = db.prepare<ProjectRow>(`${SELECT} WHERE path = ?`).get(path);
  return row === undefined ? null : toRecord(row);
}

/** Renames a project. `false` when this ledger holds no such project. */
export function renameProject(db: Db, id: ProjectId, name: string, at: number): boolean {
  return (
    db.prepare('UPDATE project SET name = ?, updated_at = ? WHERE id = ?').run(name, at, id)
      .changes === 1
  );
}

/**
 * Forgets a project: drops its row, and touches nothing else, ever.
 *
 * **`forget` rather than `delete`, deliberately, and for two reasons that
 * agree.** It is the more accurate word — KAR-22.1 AC6 is that removing a
 * project destroys nothing of the operator's, and "delete" is exactly the fear
 * the confirmation dialog exists to answer. And `@DeFlow/ledger` may export no
 * function whose name begins `delete`/`update`/`amend`/`prune`
 * (`test/append-only.test.ts`), because the package's contract is that its API
 * offers no way to amend the event log; a `deleteProject` here would be a false
 * positive against a guard that is worth keeping total rather than clever.
 *
 * There is no filesystem in scope in this file at all, which is the cheapest
 * way to make "no files are deleted" structurally true rather than remembered.
 */
export function forgetProject(db: Db, id: ProjectId): boolean {
  return db.prepare('DELETE FROM project WHERE id = ?').run(id).changes === 1;
}

/**
 * The runs submitted against `projectId`, newest first.
 *
 * Read from the `event` table rather than from a join table, because
 * `task.submitted`'s provenance is where the fact lives (KAR-22.1 AC7) — one
 * source, and a deleted project cannot orphan a run's own record of where it
 * came from. `json_extract` over the payload is the same technique
 * `./plans.ts` and `./rate-limits.ts` already use for exactly this reason: a
 * dedicated column would be a second copy of a value the payload already
 * carries.
 *
 * Ordered by the run's own first `seq` — the total order of the system, and the
 * only one of `seq`, `ts` and `runId` a wrong clock cannot write incorrectly.
 */
export function runIdsForProject(db: Db, projectId: string, limit: number): readonly string[] {
  return db
    .prepare<{ run_id: string }>(
      `SELECT run_id, MIN(seq) AS first_seq
         FROM event
        WHERE kind = 'task.submitted'
          AND json_extract(payload, '$.provenance.projectId') = ?
        GROUP BY run_id
        ORDER BY first_seq DESC
        LIMIT ?`,
    )
    .all(projectId, limit)
    .map((row) => row.run_id);
}
