/**
 * KAR-07.6 — reading and writing the `conflict_probe` matrix
 * (docs/09-workspace-and-safety.md §6.2).
 *
 * **The pair is normalized here, and only here.** `merge-tree` is symmetric —
 * probing `(a, b)` and `(b, a)` asks one question — so the key is formed from
 * the branch names sorted, with each branch's tip travelling with it through
 * the swap. Doing it at this boundary rather than asking callers to sort is
 * what makes "one row per pair" true by construction: a caller that names the
 * branches the other way round writes the row it meant to, instead of a second
 * row holding a second answer that the scheduler may then read at random.
 *
 * `path_count` is derived from `paths` on write for the same reason: two
 * columns describing one fact can disagree, and the only way they cannot is if
 * one place computes both.
 */
import type { Db, DbValue } from '@DeFlow/core';

/** One probed branch pair. `branchA`/`branchB` are as the *caller* named them;
 * what lands in the table is the canonical ordering of the two. */
export interface ConflictProbeRow {
  readonly runId: string;
  readonly branchA: string;
  readonly branchB: string;
  /** ms epoch, from the injected `Clock`. */
  readonly probedAt: number;
  /** The tip of `branchA` at the moment of the probe — half of what makes a
   * stale row detectable rather than silently trusted. */
  readonly aCommit: string;
  readonly bCommit: string;
  readonly clean: boolean;
  /** `merge-tree --name-only`'s own spelling of the conflicted paths. */
  readonly paths: readonly string[];
}

const COLUMNS =
  'run_id, branch_a, branch_b, probed_at, a_commit, b_commit, clean, path_count, paths_json';

/** SQLite's upsert: the pair is the identity, so a second probe of it replaces
 * the answer rather than appending one. */
const UPSERT_SQL = `
  INSERT INTO conflict_probe (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (run_id, branch_a, branch_b) DO UPDATE SET
    probed_at  = excluded.probed_at,
    a_commit   = excluded.a_commit,
    b_commit   = excluded.b_commit,
    clean      = excluded.clean,
    path_count = excluded.path_count,
    paths_json = excluded.paths_json
`;

const READ_ONE_SQL = `SELECT ${COLUMNS} FROM conflict_probe WHERE run_id = ? AND branch_a = ? AND branch_b = ?`;

const READ_RUN_SQL = `SELECT ${COLUMNS} FROM conflict_probe WHERE run_id = ? ORDER BY branch_a, branch_b`;

interface ConflictProbeRecord {
  readonly run_id: string;
  readonly branch_a: string;
  readonly branch_b: string;
  readonly probed_at: number;
  readonly a_commit: string;
  readonly b_commit: string;
  readonly clean: number;
  readonly path_count: number;
  readonly paths_json: string;
}

/** The canonical `(branchA, branchB)` ordering, with each tip carried along. */
export function canonicalPair<T>(
  branchA: string,
  branchB: string,
  aValue: T,
  bValue: T,
): { branchA: string; branchB: string; aValue: T; bValue: T } {
  return branchA <= branchB
    ? { branchA, branchB, aValue, bValue }
    : { branchA: branchB, branchB: branchA, aValue: bValue, bValue: aValue };
}

function bind(row: ConflictProbeRow): DbValue[] {
  const pair = canonicalPair(row.branchA, row.branchB, row.aCommit, row.bCommit);
  return [
    row.runId,
    pair.branchA,
    pair.branchB,
    row.probedAt,
    pair.aValue,
    pair.bValue,
    row.clean ? 1 : 0,
    row.paths.length,
    JSON.stringify(row.paths),
  ];
}

function hydrate(record: ConflictProbeRecord): ConflictProbeRow {
  return {
    runId: record.run_id,
    branchA: record.branch_a,
    branchB: record.branch_b,
    probedAt: record.probed_at,
    aCommit: record.a_commit,
    bCommit: record.b_commit,
    clean: record.clean === 1,
    paths: JSON.parse(record.paths_json) as string[],
  };
}

/** Records one probe. The pair is canonicalised, so probing `(b, a)` updates
 * the row `(a, b)` created. */
export function upsertConflictProbe(db: Db, row: ConflictProbeRow): void {
  db.prepare(UPSERT_SQL).run(...bind(row));
}

/** The stored answer for one pair, in either order, or `null` if it has never
 * been probed under this run. */
export function readConflictProbe(
  db: Db,
  runId: string,
  branchA: string,
  branchB: string,
): ConflictProbeRow | null {
  const pair = canonicalPair(branchA, branchB, null, null);
  const record = db
    .prepare<ConflictProbeRecord>(READ_ONE_SQL)
    .get(runId, pair.branchA, pair.branchB);
  return record === undefined ? null : hydrate(record);
}

/** The whole matrix for a run, in pair order — what the merge queue sorts and
 * what the collision map renders. */
export function readConflictProbes(db: Db, runId: string): ConflictProbeRow[] {
  return db.prepare<ConflictProbeRecord>(READ_RUN_SQL).all(runId).map(hydrate);
}
