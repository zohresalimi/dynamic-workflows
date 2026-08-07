/**
 * KAR-14.1 AC8 — what `GET /api/runs/:id` answers with.
 *
 * `docs/11-api-and-realtime.md` §6 describes the run summary in five words:
 * *"status, plan version, counts, cost, head seq"*. This file is those five
 * words as a type, and it is deliberately a **pure function of `RunState`**:
 * every figure it reports was produced by `reduce()`, so a client that holds
 * the same events reaches the same body without asking, and a `kill -9`
 * between two requests cannot make the two disagree.
 *
 * That is the whole of AC8's last clause — *"no separate polling endpoint
 * exists"*. The rollup is not a resource of its own because it is not a source
 * of its own: it is the projection, served once here for a client that has just
 * arrived, and thereafter kept current by the `budget.consumed` frames the
 * ordinary event stream already carries.
 *
 * **`budget` is passed through whole and untouched.** No flattening, no
 * convenience total, no `costUsd: number` for a header — `cost-rollup.ts`
 * explains at length why subscription quota and real currency are two
 * substances and why an unmeasurable provider contributes `null` rather than
 * `0`, and a summary that added them back up would undo all of it at the one
 * place an operator actually looks.
 *
 * Verifies: EPIC-14-S1 · KAR-14.1 AC3, AC4, AC8
 */
import type {
  BudgetRollup,
  NodeStatus,
  PlanHash,
  RunId,
  RunOutcome,
  RunState,
  RunStatus,
} from '@DeFlow/core';

export interface RunSummary {
  readonly runId: RunId;
  readonly status: RunStatus;
  readonly outcome: RunOutcome | null;
  readonly planHash: PlanHash | null;
  readonly planVersion: number;
  /**
   * How many nodes are in each status, with the statuses nothing is in left
   * out — a summary of a 300-node plan should not be a fixed nine-key object
   * that is mostly zeroes, and `Object.keys` is then a useful answer on its own.
   */
  readonly nodeCounts: Readonly<Partial<Record<NodeStatus, number>>>;
  /** KAR-14.1's projection, verbatim. @see @DeFlow/core's cost-rollup.ts */
  readonly budget: BudgetRollup;
  /** The `seq` of the last event that moved this projection (F4.7). */
  readonly watermarkSeq: number;
  /**
   * The ledger's head across *every* run, which is what an SSE client compares
   * its own cursor against (§4.2). Per-run it would be a different number with
   * the same name, and the client would conclude it had lost events.
   */
  readonly headSeq: number;
}

/** Counts by status, in the order the statuses were first met. */
function countNodes(state: RunState): Readonly<Partial<Record<NodeStatus, number>>> {
  const counts: Partial<Record<NodeStatus, number>> = {};
  for (const node of Object.values(state.nodes)) {
    counts[node.status] = (counts[node.status] ?? 0) + 1;
  }
  return counts;
}

/**
 * The summary body for `runId`, folded from `state`.
 *
 * `runId` is a parameter rather than `state.runId` on purpose: a run whose
 * `run.created` has been pruned folds to a state with a `null` id, and the id
 * the caller resolved the run by is the truer answer than `null` — the route
 * has already established that the ledger holds this run.
 */
export function runSummary(runId: RunId, state: RunState, headSeq: number): RunSummary {
  return {
    runId,
    status: state.status,
    outcome: state.outcome,
    planHash: state.planHash,
    planVersion: state.planVersion,
    nodeCounts: countNodes(state),
    budget: state.budget,
    watermarkSeq: state.watermarkSeq,
    headSeq,
  };
}
