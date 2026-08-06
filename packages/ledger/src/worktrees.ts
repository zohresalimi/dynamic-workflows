/**
 * KAR-07.2 — reading and writing the `worktrees` projection
 * (docs/09-workspace-and-safety.md §4.3).
 *
 * **One write function, and it replaces everything.** `replaceWorktrees` takes
 * the full list `git worktree list --porcelain -z` just reported and makes the
 * table equal to it, inside one transaction. There is deliberately no
 * `insertWorktree`, no `updateWorktree` and no `deleteWorktree`: a partial
 * update is how a projection drifts from its source one call at a time, and
 * this projection's entire reason for existing is that **git is the authority**
 * and SQLite is an index over it. An operator who removes a worktree in their
 * own terminal has to reconcile cleanly, not produce a stale row nobody can
 * explain.
 *
 * SQLite has no boolean type under `STRICT`, so the five flags are stored as
 * 0/1 INTEGERs with CHECK constraints and converted at this boundary — the one
 * place that knows both representations.
 */
import type { Db, DbValue } from '@DeFlow/core';

/** One row of the projection: exactly what git reported, plus the run/node the
 * lock reason identified and when the refresh happened. */
export interface WorktreeRow {
  /** Absolute path, git's own identity for the worktree, and the primary key. */
  readonly path: string;
  /** The checked-out commit; `null` for a bare repository entry. */
  readonly head: string | null;
  /** Full ref (`refs/heads/…`); `null` when detached or bare. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly lockReason: string | null;
  /** Git still lists it, but its directory is gone — reap, do not treat as live. */
  readonly prunable: boolean;
  readonly prunableReason: string | null;
  /** Parsed out of DeFlow's own lock reason; `null` for anyone else's worktree. */
  readonly runId: string | null;
  readonly nodeId: string | null;
  /** ms epoch, from the injected `Clock`. */
  readonly refreshedAt: number;
}

const COLUMNS =
  'path, head, branch, detached, bare, locked, lock_reason, prunable, prunable_reason, run_id, node_id, refreshed_at';

const INSERT_SQL = `INSERT INTO worktrees (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const READ_SQL = `SELECT ${COLUMNS} FROM worktrees ORDER BY path`;

interface WorktreeRecord {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly detached: number;
  readonly bare: number;
  readonly locked: number;
  readonly lock_reason: string | null;
  readonly prunable: number;
  readonly prunable_reason: string | null;
  readonly run_id: string | null;
  readonly node_id: string | null;
  readonly refreshed_at: number;
}

const flag = (value: boolean): number => (value ? 1 : 0);

function bind(row: WorktreeRow): DbValue[] {
  return [
    row.path,
    row.head,
    row.branch,
    flag(row.detached),
    flag(row.bare),
    flag(row.locked),
    row.lockReason,
    flag(row.prunable),
    row.prunableReason,
    row.runId,
    row.nodeId,
    row.refreshedAt,
  ];
}

function hydrate(record: WorktreeRecord): WorktreeRow {
  return {
    path: record.path,
    head: record.head,
    branch: record.branch,
    detached: record.detached === 1,
    bare: record.bare === 1,
    locked: record.locked === 1,
    lockReason: record.lock_reason,
    prunable: record.prunable === 1,
    prunableReason: record.prunable_reason,
    runId: record.run_id,
    nodeId: record.node_id,
    refreshedAt: record.refreshed_at,
  };
}

/**
 * Makes the table equal to `rows` — git's whole answer — in one transaction.
 *
 * Delete-then-insert rather than an upsert plus a delete of the complement: the
 * two-statement form is what makes "the table is exactly what git said" true by
 * construction, with no set arithmetic to get wrong, and the table is tens of
 * rows. An empty `rows` empties the table, because git reporting no worktrees
 * is a real answer and not a reason to keep the old ones.
 */
export function replaceWorktrees(db: Db, rows: readonly WorktreeRow[]): void {
  const insert = db.prepare(INSERT_SQL);
  db.transaction(() => {
    db.exec('DELETE FROM worktrees');
    for (const row of rows) insert.run(...bind(row));
  });
}

/** Every row, in path order — the order the UI shows and the order a diff
 * against a fresh porcelain read is easiest to reason about. */
export function readWorktrees(db: Db): WorktreeRow[] {
  return db.prepare<WorktreeRecord>(READ_SQL).all().map(hydrate);
}
