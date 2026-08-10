/**
 * KAR-05.9 — reading and writing the `process` table.
 *
 * One function here is load-bearing and the rest are plumbing:
 * `appendEventsWithProcess` writes the row **inside the same transaction as
 * `node.started`** (AC6). The alternative — append, then insert — has a window
 * between the two writes, and that window is the moment the daemon is most
 * likely to die, because it has just started a child process. A row lost there
 * is an agent no future daemon knows exists; an event lost there is a `process`
 * row pointing at a node that never started.
 *
 * `state` is the only mutable column, and it moves in one direction: `live` to
 * one of three terminal answers. There is no `updateProcess`, because
 * everything else in the row describes an OS fact that was true at spawn and
 * cannot become truer.
 */
import type { Db, EventSeq } from '@DeFlow/core';
import { type AppendOptions, appendEvents, type EventDraft } from './append.ts';
import { committing } from './notify.ts';

/** `live` is the only non-terminal state; the other three are AC7's answers. */
export const PROCESS_STATES = ['live', 'exited', 'reaped', 'discarded'] as const;

export type ProcessState = (typeof PROCESS_STATES)[number];

/** What is known about a spawned agent at the instant it started. */
export interface ProcessRowDraft {
  readonly runId: string;
  readonly nodeId: string;
  /** 0-based, matching the event envelope. */
  readonly attempt: number;
  readonly pid: number;
  /** The group to signal. Equal to `pid` for a `detached: true` spawn, and the
   * only handle left on the descendants once the leader is gone. */
  readonly pgid: number;
  /**
   * The OS's own start time for `pid`, verbatim and unparsed — `ps -o lstart=`
   * on darwin, `/proc/<pid>/stat` field 22 on linux. `null` when it could not
   * be read, which makes the row unverifiable and therefore never killable.
   */
  readonly startedAt: string | null;
  readonly binarySha256: string;
  /** The worktree the agent is editing, whose lock a dead orphan still holds. */
  readonly worktree: string | null;
  /** ms epoch, from the injected `Clock`. */
  readonly spawnedAt: number;
}

export type ProcessRow = ProcessRowDraft & { readonly state: ProcessState };

/** Which process a caller means. A retry is a different row. */
export interface ProcessKey {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
}

const RECORD_SQL = `
  INSERT INTO process
    (run_id, node_id, attempt, pid, pgid, started_at, binary_sha256, worktree, spawned_at, state)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')
  ON CONFLICT (run_id, node_id, attempt) DO UPDATE SET
    pid = excluded.pid,
    pgid = excluded.pgid,
    started_at = excluded.started_at,
    binary_sha256 = excluded.binary_sha256,
    worktree = excluded.worktree,
    spawned_at = excluded.spawned_at,
    state = 'live'
`;

const MARK_SQL = `UPDATE process SET state = ? WHERE run_id = ? AND node_id = ? AND attempt = ?`;

const COLUMNS = `run_id, node_id, attempt, pid, pgid, started_at, binary_sha256, worktree, spawned_at, state`;

const LIVE_SQL = `
  SELECT ${COLUMNS} FROM process
   WHERE state = 'live'
   ORDER BY spawned_at, run_id, node_id, attempt
`;

const ALL_SQL = `SELECT ${COLUMNS} FROM process ORDER BY spawned_at, run_id, node_id, attempt`;

const ONE_SQL = `
  SELECT ${COLUMNS} FROM process WHERE run_id = ? AND node_id = ? AND attempt = ?
`;

function bindings(row: ProcessRowDraft): (string | number | null)[] {
  return [
    row.runId,
    row.nodeId,
    row.attempt,
    row.pid,
    row.pgid,
    row.startedAt,
    row.binarySha256,
    row.worktree,
    row.spawnedAt,
  ];
}

/**
 * Writes the row for a process that is running now.
 *
 * The upsert is for the one case that produces the same key twice: a resumed
 * node whose previous row was never cleared because the daemon died. The new
 * spawn is the truth about that key, and the old pid is either already reaped
 * or was dealt with by the reaper before this daemon scheduled anything.
 */
export function recordProcess(db: Db, row: ProcessRowDraft): void {
  db.prepare(RECORD_SQL).run(...bindings(row));
}

/** Moves a row to a terminal state. Silent when there is no such row. */
export function markProcess(db: Db, key: ProcessKey, state: ProcessState): void {
  if (!PROCESS_STATES.includes(state)) {
    throw new TypeError(
      `process.state must be one of ${PROCESS_STATES.join(', ')}; got ${JSON.stringify(state)}. ` +
        'A state outside the closed set would hide a running agent from every future reaper.',
    );
  }
  db.prepare(MARK_SQL).run(state, key.runId, key.nodeId, key.attempt);
}

/** The clean-exit path of AC6: the process ended on its own terms. */
export function clearProcess(db: Db, key: ProcessKey): void {
  markProcess(db, key, 'exited');
}

interface ProcessDbRow {
  readonly run_id: string;
  readonly node_id: string;
  readonly attempt: number;
  readonly pid: number;
  readonly pgid: number;
  readonly started_at: string | null;
  readonly binary_sha256: string;
  readonly worktree: string | null;
  readonly spawned_at: number;
  readonly state: string;
}

/**
 * Every row that still claims to describe a running process, oldest first.
 *
 * This is the reaper's whole input on boot. It is deliberately not filtered by
 * run: an orphan is an orphan whatever run it belonged to, and a daemon that
 * only reaped the runs it intended to resume would leave the rest editing
 * worktrees for ever.
 */
export function readLiveProcesses(db: Db): readonly ProcessRow[] {
  return db.prepare<ProcessDbRow>(LIVE_SQL).all().map(toRow);
}

/**
 * The row for one attempt, whatever state it is in, or `undefined` when that
 * attempt never spawned anything.
 *
 * The kill switch's input (KAR-06.7): a `CancelNode` names a `(run, node,
 * attempt)` and needs the pid, the pgid and the recorded start time for exactly
 * that attempt. Scanning `readProcesses` for it would read every row of every
 * run to answer a question the primary key already indexes, and would make a
 * *previous* attempt's row reachable by accident — which is a signal sent to
 * the wrong pid.
 */
export function readProcess(db: Db, key: ProcessKey): ProcessRow | undefined {
  const stored = db.prepare<ProcessDbRow>(ONE_SQL).get(key.runId, key.nodeId, key.attempt);
  return stored === undefined ? undefined : toRow(stored);
}

/** Every row, terminal ones included — the audit view, not the reaper's input. */
export function readProcesses(db: Db): readonly ProcessRow[] {
  return db.prepare<ProcessDbRow>(ALL_SQL).all().map(toRow);
}

function toRow(stored: ProcessDbRow): ProcessRow {
  return {
    runId: stored.run_id,
    nodeId: stored.node_id,
    attempt: stored.attempt,
    pid: stored.pid,
    pgid: stored.pgid,
    startedAt: stored.started_at,
    binarySha256: stored.binary_sha256,
    worktree: stored.worktree,
    spawnedAt: stored.spawned_at,
    state: stored.state as ProcessState,
  };
}

/**
 * Appends `drafts` and writes `row` in **one** transaction (AC6).
 *
 * The event goes first so that a refused envelope — an append-only table cannot
 * be repaired, so the boundary refuses rather than writes — takes the process
 * row with it. What must never exist is a `process` row for a spawn that no
 * event records, because nothing would ever look at the run it belongs to.
 */
export function appendEventsWithProcess(
  db: Db,
  drafts: readonly EventDraft[],
  row: ProcessRowDraft,
  options: AppendOptions = {},
): EventSeq[] {
  return committing(db, () => {
    const seqs = appendEvents(db, drafts, options);
    recordProcess(db, row);
    return seqs;
  });
}
