/**
 * KAR-22.4 — the `connector` table's three reads and writes (migration 0017).
 *
 * Storage only, and there is remarkably little of it, which is the point: a
 * connector row is `(projectId, service, createdAt)` and holds **no credential
 * of any kind** (ADR-0003, amended 2026-08-16). Everything that is a question
 * about the outside world — is the GitHub CLI installed, is it authorised, does
 * its token carry the scope — belongs to the daemon and is asked every time,
 * because a stored answer is a cache of somebody else's credential store.
 *
 * Time arrives as a plain millisecond epoch (NF9). There is no `Date.now()` in
 * this file and there must not be.
 */
import type { Db, ProjectId } from '@DeFlow/core';

export interface ConnectorRecord {
  readonly projectId: ProjectId;
  /** The registry's service id — `'github'` at KAR-22.4. */
  readonly service: string;
  /** ms epoch, from the caller's `Clock`. */
  readonly createdAt: number;
}

interface ConnectorRow {
  readonly project_id: string;
  readonly service: string;
  readonly created_at: number;
}

const toRecord = (row: ConnectorRow): ConnectorRecord => ({
  projectId: row.project_id as ProjectId,
  service: row.service,
  createdAt: row.created_at,
});

const SELECT = 'SELECT project_id, service, created_at FROM connector';

/**
 * Records that `projectId` may use `service`.
 *
 * Idempotent: connecting a service that is already connected keeps the original
 * `created_at` rather than moving it, so "connected since" survives a second
 * click on the button.
 */
export function insertConnector(db: Db, record: ConnectorRecord): void {
  db.prepare(
    `INSERT INTO connector (project_id, service, created_at)
     VALUES (?, ?, ?) ON CONFLICT (project_id, service) DO NOTHING`,
  ).run(record.projectId, record.service, record.createdAt);
}

/** Every connector on `projectId`, oldest first. */
export function listConnectors(db: Db, projectId: ProjectId): readonly ConnectorRecord[] {
  return db
    .prepare<ConnectorRow>(`${SELECT} WHERE project_id = ? ORDER BY created_at ASC`)
    .all(projectId)
    .map(toRecord);
}

/** `projectId`'s connector for `service`, or `null`. */
export function readConnector(
  db: Db,
  projectId: ProjectId,
  service: string,
): ConnectorRecord | null {
  const row = db
    .prepare<ConnectorRow>(`${SELECT} WHERE project_id = ? AND service = ?`)
    .get(projectId, service);
  return row === undefined ? null : toRecord(row);
}

/**
 * Forgets `projectId`'s connector for `service`. `true` when a row went.
 *
 * This is the whole of "removing a connector revokes DeFlow's access" for a
 * service whose credential DeFlow does not hold: the row *is* the access, and
 * once it is gone the daemon spawns nothing for that project. The operator's
 * own credential is untouched, deliberately — it is theirs, and the service
 * descriptor names the command that revokes it.
 */
export function forgetConnector(db: Db, projectId: ProjectId, service: string): boolean {
  return (
    db.prepare('DELETE FROM connector WHERE project_id = ? AND service = ?').run(projectId, service)
      .changes > 0
  );
}
