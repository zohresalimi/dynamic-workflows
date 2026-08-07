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
  BudgetEnforceability,
  BudgetRollup,
  NodeStatus,
  PlanHash,
  ProviderId,
  RunCeilings,
  RunId,
  RunOutcome,
  RunState,
  RunStatus,
  TokenAccounting,
} from '@DeFlow/core';
import { budgetEnforceability } from '@DeFlow/core';

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
  /** KAR-14.2 — the ceilings in force, as the ledger pinned them. */
  readonly ceilings: RunCeilings;
  /**
   * KAR-14.2 AC8 — **the marker**: `false` when this run sets a cost ceiling
   * DeFlow cannot measure, because a provider it schedules reports no usage at
   * all.
   *
   * A boolean beside the detail rather than only inside it, because that is
   * what a surface renders: the spec-approval screen has to be able to say
   * "this ceiling will not fire" without reasoning about a list, and it has to
   * be able to say it *before* execution begins.
   */
  readonly budgetEnforceable: boolean;
  /** Which dimension is unenforceable and whose accounting made it so. */
  readonly budgetEnforceability: BudgetEnforceability;
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
export function runSummary(
  runId: RunId,
  state: RunState,
  headSeq: number,
  /**
   * The capability manifest's accounting fidelity for a provider. A parameter
   * because @DeFlow/core owns no provider registry, and because a summary that
   * looked one up itself would answer differently in a test than in production.
   */
  accounting: (provider: ProviderId) => TokenAccounting,
): RunSummary {
  const enforceability = budgetEnforceability(state, accounting);
  return {
    runId,
    status: state.status,
    outcome: state.outcome,
    planHash: state.planHash,
    planVersion: state.planVersion,
    nodeCounts: countNodes(state),
    budget: state.budget,
    ceilings: state.ceilings,
    budgetEnforceable: enforceability.cost,
    budgetEnforceability: enforceability,
    watermarkSeq: state.watermarkSeq,
    headSeq,
  };
}
