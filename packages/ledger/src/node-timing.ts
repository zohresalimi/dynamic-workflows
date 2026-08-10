/**
 * KAR-15.6 AC3 — when a node started and when it stopped, for the F10.3
 * inspector bundle.
 *
 * `RunState.nodes[id].startedTs` exists; there is no `endedTs` beside it and
 * there should not be. The projection carries what `decide()` needs, and *when
 * a node finished* is not an input to scheduling — adding it would grow
 * `run.state_json` for every node of every run to serve one panel.
 *
 * So the inspector asks the ledger, as two aggregates over that node's own
 * rows. Aggregates rather than a cursor window, for the reason
 * `../test/append-only.test.ts` states: the result is one row and no cursor is
 * left open over the rest of the log, so this cannot become the unbounded scan
 * that stalls every in-flight append behind it.
 *
 * `durationMs` is `null` while the node is still running rather than
 * `now - startedTs`. A duration measured against the wall clock changes every
 * time the page is reloaded, and — on a node that finished an hour ago and
 * whose terminal event this build does not recognise — it is simply wrong.
 */
import type { Db } from '@DeFlow/core';

/**
 * The events that end a node attempt. `node.failed` counts: the last of them
 * across attempts is when the node stopped, whatever it stopped as.
 */
const TERMINAL_KINDS = ['node.completed', 'node.failed', 'node.cancelled'] as const;

const STARTED_SQL = `SELECT min(ts) AS ts FROM event
   WHERE run_id = ? AND node_id = ? AND kind = 'node.started'`;

const ENDED_SQL = `SELECT max(ts) AS ts FROM event
   WHERE run_id = ? AND node_id = ? AND kind IN (${TERMINAL_KINDS.map(() => '?').join(', ')})`;

export interface NodeTiming {
  /** The first `node.started`'s `ts`; `null` for a node that never ran. */
  readonly startedTs: number | null;
  /** The last terminal event's `ts`; `null` while the node is still running. */
  readonly endedTs: number | null;
  /** `endedTs - startedTs`, or `null` when either end is open. */
  readonly durationMs: number | null;
}

export function readNodeTiming(db: Db, runId: string, nodeId: string): NodeTiming {
  const startedTs = db.prepare<{ ts: number | null }>(STARTED_SQL).get(runId, nodeId)?.ts ?? null;
  const endedTs =
    db.prepare<{ ts: number | null }>(ENDED_SQL).get(runId, nodeId, ...TERMINAL_KINDS)?.ts ?? null;

  return {
    startedTs,
    endedTs,
    durationMs: startedTs === null || endedTs === null ? null : endedTs - startedTs,
  };
}
