/**
 * KAR-03.8 — `openAndReplay`, the one call DeFlowd makes to come back to life
 * (docs/05-durable-execution.md §14, F4.2).
 *
 *     open → migrate → find every run → validate its checkpoint → fold the tail
 *
 * `replayRun` (./checkpoint.ts) is the per-run half and does the interesting
 * work. This file is the part that makes it a *start*: it decides which runs
 * exist, and it never lets one bad run stop the daemon from serving the others.
 *
 * Three properties, and none of them is a nicety:
 *
 * 1. **A fresh engine over the same file.** The daemon restarts by constructing
 *    a new connection over the bytes a dead process left behind, so that is the
 *    only path this function offers. `:memory:` cannot express it at all —
 *    it cannot be reopened, it cannot exercise WAL recovery, and it hides
 *    exactly the ordering bugs a restart exists to expose
 *    (docs/14-testing-strategy.md §7).
 * 2. **Gaps are ordinary.** Nothing here asserts that `seq` is contiguous.
 *    `AUTOINCREMENT` never reissues a pruned number and the sequence is shared
 *    across every run in the directory, so a hole is the normal shape of a
 *    ledger and not evidence of damage. The fold walks what is there and
 *    invents nothing (EPIC-03-S24 scenario 3).
 * 3. **Unknown kinds are data.** A ledger written by a newer DeFlowd folds to a
 *    *degraded* projection, never to a crash loop: the reducer skips what it
 *    does not know and the caller gets a count it can log in one line
 *    (EPIC-03-S16). This is the system's single forward-compatibility
 *    mechanism, and replay is where it has to hold.
 */
import type { Db, RunId, RunState } from '@DeFlow/core';
import { join } from 'node:path';
import { type ReplayOptions, type ReplayResult, replayRun } from './checkpoint.ts';
import { migrate } from './migrate.ts';
import { MIGRATIONS } from './migrations/index.ts';
import { openWrite } from './sqlite-db.ts';

/**
 * Every run the directory holds, oldest first.
 *
 * "Oldest" is the run's first `seq`, not its id or its `ts`: `seq` is the total
 * order of the system, and it is the only one of the three that cannot be
 * written wrong by a clock. A `run` row whose events have been pruned away
 * still counts as a run — it sorts last, because it has no first event to sort
 * by, and replaying it to the initial state is a truer answer than pretending
 * it was never there.
 */
// The ORDER BY lives outside the compound SELECT: SQLite only allows a
// compound's ORDER BY to name result columns, so `first_seq IS NULL` — which is
// what puts the eventless runs last — has to be applied to the union as a whole.
const RUN_IDS_SQL = `SELECT run_id, first_seq FROM (
    SELECT run_id, min(seq) AS first_seq FROM event GROUP BY run_id
    UNION ALL
    SELECT run_id, NULL AS first_seq FROM run WHERE run_id NOT IN (SELECT run_id FROM event)
  )
  ORDER BY first_seq IS NULL, first_seq, run_id`;

const HEAD_SEQ_SQL = 'SELECT coalesce(max(seq), 0) AS head FROM event';

/** @see RUN_IDS_SQL */
export function listRunIds(db: Db): RunId[] {
  return db
    .prepare<{ run_id: string; first_seq: number | null }>(RUN_IDS_SQL)
    .all()
    .map((row) => row.run_id as RunId);
}

/**
 * The highest `seq` this ledger has ever committed, across every run; 0 when it
 * holds none.
 *
 * Global rather than per-run because that is what it is: one `AUTOINCREMENT`
 * serves the whole directory. It is what `/api/health` reports as `headSeq` and
 * what an SSE client compares its cursor against.
 */
export function headSeq(db: Db): number {
  return db.prepare<{ head: number }>(HEAD_SEQ_SQL).get()?.head ?? 0;
}

/** One run's replay, and which run it was. */
export interface RunReplay extends ReplayResult {
  readonly runId: RunId;
}

export interface LedgerReplay {
  /** What the daemon serves: run id to the state it folds to. */
  readonly runs: ReadonlyMap<RunId, RunState>;
  /** The same runs, in the same order, with how each one was rebuilt. */
  readonly replays: readonly RunReplay[];
  /** @see headSeq */
  readonly headSeq: number;
}

/**
 * Replays every run in an already-open ledger.
 *
 * Separate from `openAndReplay` because `boot.ts` has already opened and
 * migrated the ledger by the time it wants this — it took the lease and bumped
 * the epoch on the way — and opening a second connection to do it would
 * contend with the write lock the lease exists to make unnecessary.
 */
export function replayAll(db: Db, options: ReplayOptions = {}): LedgerReplay {
  const replays = listRunIds(db).map((runId) => ({ runId, ...replayRun(db, runId, options) }));
  return {
    runs: new Map(replays.map((replay) => [replay.runId, replay.state])),
    replays,
    headSeq: headSeq(db),
  };
}

/** An open, migrated, replayed ledger. The caller owns `db` and closes it. */
export interface OpenedLedger extends LedgerReplay {
  readonly db: Db;
}

/**
 * Opens `dataDir`, migrates it, and rebuilds the state of every run in it.
 *
 * The connection comes back with the map because the daemon needs both and
 * because closing it is the caller's business: this is the front door of a
 * process that then runs for hours.
 *
 * A migration failure — `LedgerTooNew` above all — closes the connection it
 * just opened before rethrowing, exactly as `openLedger` does, so a caller that
 * catches and retries never finds `LedgerAlreadyOpen` in its own way.
 */
export function openAndReplay(dataDir: string, options: ReplayOptions = {}): OpenedLedger {
  const db = openWrite(join(dataDir, 'ledger.db'));
  try {
    migrate(db, MIGRATIONS, dataDir);
    return { db, ...replayAll(db, options) };
  } catch (error) {
    db.close();
    throw error;
  }
}
