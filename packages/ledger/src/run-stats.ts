/**
 * KAR-03.4 AC6 — the assumption that removed snapshotting, turned into a
 * number the daemon can read.
 *
 * DeFlow ships no snapshot table. That decision rests on one measured claim:
 * a 40-node multi-hour run produces on the order of **2,000** control-plane
 * events, and folding 2,000 events is single-digit milliseconds
 * (docs/05-durable-execution.md §5.1). Roadmap risk **A1-3** is that the claim
 * is 10-100x off because someone starts emitting a control event per tool call
 * — which would make "do not build snapshotting" wrong, and would be
 * discovered by a nine-hour run becoming slow to open rather than by anything
 * saying so.
 *
 * So the count is instrumented from M1 rather than assumed. Two thresholds are
 * exported with it, because a number with no line drawn next to it is not
 * instrumentation:
 *
 * - `CONTROL_EVENT_BUDGET` — the upper bound the standard 40-node fixture is
 *   asserted against. It is an order of magnitude above the fixture, so it
 *   catches the per-tool-call regression and nothing smaller.
 * - `SNAPSHOT_REVISIT_THRESHOLD` — the count in a *single run* past which real
 *   snapshots become worth building. Below it, if ledger file size is the
 *   concern rather than fold time, the cheaper move is putting `io_chunk` in a
 *   second SQLite file via `ATTACH`.
 */
import type { Db, EventSeq, RunId } from '@DeFlow/core';

/** @see the module comment. */
export const CONTROL_EVENT_BUDGET = 20_000;

/** @see the module comment. */
export const SNAPSHOT_REVISIT_THRESHOLD = 100_000;

/**
 * What one run costs the ledger. The control-plane count is the number that
 * matters; the data-plane pair is what it is being compared against, and the
 * comparison is the whole point of the split.
 */
export interface RunStats {
  readonly runId: RunId;
  /** `count(*) FROM event WHERE run_id = ?` — the A1-3 measurement. */
  readonly controlEventCount: number;
  readonly ioChunkCount: number;
  readonly ioBytes: number;
  /** Highest `event.seq` for this run; 0 when it has none. */
  readonly lastSeq: EventSeq | 0;
}

// Aggregates, so they are bounded by construction — one row out, served by
// event_run_seq / io_run_seq. They are not on the fold path: this is a
// reporting read, called when a run record is rendered, not per event.
const CONTROL_PLANE_SQL = `SELECT count(*) AS events, coalesce(max(seq), 0) AS last_seq
  FROM event WHERE run_id = ?`;

const DATA_PLANE_SQL = `SELECT count(*) AS chunks, coalesce(sum(length(data)), 0) AS bytes
  FROM io_chunk WHERE run_id = ?`;

/**
 * Reads the per-run counters straight off the ledger.
 *
 * Computed rather than cached on purpose: the `run` table is a projection
 * *cache* (KAR-03.6) that is allowed to be stale or absent, and a counter whose
 * job is to catch a regression must not be able to disagree with the rows it
 * counts.
 */
export function readRunStats(db: Db, runId: RunId): RunStats {
  const control = db
    .prepare<{ events: number; last_seq: number }>(CONTROL_PLANE_SQL)
    .get(runId) ?? { events: 0, last_seq: 0 };
  const data = db.prepare<{ chunks: number; bytes: number }>(DATA_PLANE_SQL).get(runId) ?? {
    chunks: 0,
    bytes: 0,
  };

  return {
    runId,
    controlEventCount: control.events,
    ioChunkCount: data.chunks,
    ioBytes: data.bytes,
    lastSeq: control.last_seq as EventSeq | 0,
  };
}
