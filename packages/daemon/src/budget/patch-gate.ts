/**
 * KAR-14.3 AC5, AC6 — the gate a proposed `PlanPatch` passes through before
 * anything is applied (docs/06-planning-and-replanning.md §4.2, §4.3).
 *
 * The whole of §4.2's pipeline is `patch ▸ estimate ▸ policy engine ▸ auto |
 * approve | reject`, and this module is the middle arrow made real: it prices
 * the patch with the same pure estimator the spec-approval surface uses, asks
 * how much of the run's allowance is already gone, and puts the two through the
 * F2.5 rule table.
 *
 * **What it deliberately does not do is apply anything.** Applying the ops,
 * writing the new content-addressed `plan` row, the `basePlanHash` optimistic
 * concurrency check and the `plan.patched` append are KAR-11.3's, and the
 * approval queue an `approve` lands in is EPIC-13's. What this owns is the one
 * decision KAR-14.3 is responsible for — *may this patch spend more* — and the
 * record of it when the answer is no.
 *
 * A rejection is recorded as `plan.patch.rejected { patchId, rule, by }`, the
 * kind the ledger already has for exactly this. It is not recorded as
 * `plan.patched`: that payload carries the `fromHash`/`toHash` of a plan
 * document that was actually written, and a rejection writes none — a
 * `toHash` invented for it would be a hash of nothing on the log for ever.
 * Rejections *are* recorded, because NF10 requires it: "the run wanted to do X
 * and was not allowed to" is exactly the state a user asks about later, and a
 * rejection that named no rule would be unanswerable.
 */
import type {
  Db,
  EstimatorInputs,
  PatchEstimate,
  PermissionLevel,
  RunId,
  RunState,
} from '@DeFlow/core';
import {
  EVENT_CURRENT_VERSIONS,
  elapsedBudgetFraction,
  estimatePatch,
  evaluatePatchPolicy,
  type PatchPolicyDecision,
  PERMISSION_LEVELS,
  PlanPatchSchema,
} from '@DeFlow/core';
import { appendEvents } from '@DeFlow/ledger';

export interface PatchGateInput {
  readonly runId: RunId;
  /** The state the ledger reduces to right now. */
  readonly state: RunState;
  /** The proposal, as `DeFlow.proposePlanPatch` recorded it. */
  readonly patch: unknown;
  readonly estimator: EstimatorInputs;
  /** ms epoch, from the injected `Clock` — never `Date.now()`. */
  readonly now: number;
  /**
   * F5.6 — whether the patch reaches the execution boundary. Supplied by the
   * safety model; absent means "not asked", which is *not* the same as "no",
   * and is why the corresponding rule needs an explicit `true` to fire.
   */
  readonly touchesExecutionBoundary?: boolean | undefined;
}

export interface PatchRuling {
  readonly decision: PatchPolicyDecision;
  readonly ruleId: string;
  readonly estimate: PatchEstimate;
  /** The figure the `budget-exhausted` rule was evaluated against (AC6). */
  readonly elapsedBudgetFraction: number;
}

/**
 * The permission level the run itself is executing at: the most capable level
 * any active node in the plan was given.
 *
 * An escalation is a comparison against *something*, and the run's own ceiling
 * is the honest baseline — a patch asking for `worktree` inside a run that
 * already writes to a worktree is not an escalation, and one asking for it
 * inside a read-only investigation is.
 */
function ambientPermission(state: RunState): PermissionLevel {
  let highest: PermissionLevel = 'read';
  for (const node of state.plan?.nodes ?? []) {
    if (node.lifecycle !== 'active') continue;
    if (PERMISSION_LEVELS.indexOf(node.permission) > PERMISSION_LEVELS.indexOf(highest)) {
      highest = node.permission;
    }
  }
  return highest;
}

/**
 * Prices `patch`, rules on it, and records the rejection when there is one.
 *
 * Synchronous and transactional in the same breath as every other ledger write
 * in this package: the append is one `appendEvents` call, so a crash leaves
 * either the decision on the log or no decision at all — never a patch that was
 * ruled on twice.
 */
export function rulePatch(db: Db, input: PatchGateInput): PatchRuling {
  const patch = PlanPatchSchema.parse(input.patch);
  const base = { nodes: input.state.plan?.nodes ?? [] };

  const estimate = estimatePatch(patch, base, {
    ...input.estimator,
    planVersion: input.state.planVersion,
  });

  // Wall-clock elapsed is measured from the run's own start, which is `0` until
  // `run.started` — a run that has not begun has consumed none of its clock.
  const elapsed = input.state.startedTs === 0 ? null : input.now - input.state.startedTs;
  const fraction = elapsedBudgetFraction(input.state.budget.run, input.state.ceilings.run, elapsed);

  const ruling = evaluatePatchPolicy({
    estimate,
    ambientPermission: ambientPermission(input.state),
    elapsedBudgetFraction: fraction,
    touchesExecutionBoundary: input.touchesExecutionBoundary,
  });

  if (ruling.decision === 'reject') {
    appendEvents(db, [
      {
        runId: input.runId,
        ts: input.now,
        kind: 'plan.patch.rejected',
        v: EVENT_CURRENT_VERSIONS['plan.patch.rejected'],
        epoch: input.state.epoch,
        payload: { patchId: patch.id, rule: ruling.ruleId, by: 'policy' },
      },
    ]);
  }

  return { ...ruling, estimate, elapsedBudgetFraction: fraction };
}
