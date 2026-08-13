/**
 * KAR-19.9 AC6 — why a run that ended badly ended, on `GET /api/runs/:id`.
 *
 * The reported run of 2026-08-13 had no answer to give: its ledger recorded
 * none of the fifteen identical failures, so every surface could say *"created
 * — no nodes yet"* and be telling the truth. With the failures journalled
 * (AC1), the ending is in the log — and this is the two lines that carry it to
 * the tools a waiting human has open, rather than making each of them fold the
 * event stream to find out.
 *
 * **It re-words nothing.** `reason`, `class` and `message` are the typed
 * `NodeFailure` the ledger holds, copied out of the projection; the status word
 * beside them is `runStatusLabel`'s and is not produced here. A summary that
 * re-phrased the vendor's own sentence would be a third description of one
 * failure, which is the class of defect this epic exists to remove.
 *
 * **Only for a run that has ended.** The field answers *"why did this run
 * stop"*, and a live run with one failed node behind it has not stopped — its
 * node is retrying, and a summary that led with the failure would be reporting
 * an ending that has not happened. The failed attempts are on the event stream
 * either way, which is where the run's own view reads them from.
 *
 * A sibling of `./run-refusal.ts` and deliberately shaped like it: a refusal is
 * why a run never started and this is why one stopped, and both are attached to
 * the summary rather than folded into `RunState`, which is the projection and
 * not a presentation.
 *
 * Verifies: EPIC-19-S58 · KAR-19.9 AC6
 */
import type { NodeFailure, NodeId, RunState } from '@DeFlow/core';

/** What `GET /api/runs/:id` carries for a run that ended on a failure. */
export interface RunFailure {
  /** The node whose failure ended the run. */
  readonly node: NodeId;
  /** KAR-02.10's closed taxonomy, verbatim. */
  readonly reason: NodeFailure['reason'];
  readonly class: NodeFailure['class'];
  /** The provider-level sentence, as the failure carried it. */
  readonly message: string;
  /** How many attempts the node spent — `attempt + 1` of its own policy. */
  readonly attempts: number;
}

/** Statuses that mean the run is over. Both of them. */
const ENDED = new Set<RunState['status']>(['completed', 'aborted']);

/**
 * Why this run ended, or `null` — for every run that is still going and every
 * run that ended well, which is nearly all of them.
 *
 * The node picked is the **first** one to fail, by the seq that last moved it,
 * which is the same rule `classifyRun` applies one process away when it turns
 * the same projection into an exit code: the first failure is the one that
 * explains the ones after it.
 */
export function runFailure(state: RunState): RunFailure | null {
  if (!ENDED.has(state.status)) return null;

  const failed = Object.entries(state.nodes)
    .filter(([, node]) => node.status === 'failed' && node.failure !== null)
    .toSorted((left, right) => left[1].updatedSeq - right[1].updatedSeq);

  const first = failed[0];
  if (first === undefined) return null;
  const [node, entry] = first;
  const failure = entry.failure;
  if (failure === null) return null;

  return {
    node: node as NodeId,
    reason: failure.reason,
    class: failure.class,
    message: failure.message,
    attempts: entry.attempts,
  };
}
