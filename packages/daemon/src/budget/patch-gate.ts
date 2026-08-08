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
import type { Db, EstimatorInputs, PatchEstimate, RunId, RunState } from '@DeFlow/core';
import {
  decidePatch,
  EVENT_CURRENT_VERSIONS,
  estimatePatch,
  type PatchPolicyDecision,
  PlanPatchSchema,
  patchDecisionStateOf,
  toSingleLine,
} from '@DeFlow/core';
import { appendEvents, type EventDraft } from '@DeFlow/ledger';

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
  /**
   * KAR-11.4 AC10 — the digest of the rule table in `.DeFlow/config.yaml`
   * **right now**, when the caller has read it.
   *
   * Used for one thing and never for deciding: if it differs from what this run
   * pinned at start, the divergence is recorded so the operator is told. *"An
   * operator who edits the config expecting it to take effect and gets no
   * signal will assume the engine is broken."* Absent means nobody looked,
   * which is not the same as "they match".
   */
  readonly configPolicyHash?: string | undefined;
}

export interface PatchRuling {
  readonly decision: PatchPolicyDecision;
  readonly ruleId: string;
  readonly estimate: PatchEstimate;
  /** The figure the `budget-exhausted` rule was evaluated against (AC6). */
  readonly elapsedBudgetFraction: number;
  /** KAR-11.4 AC10 — the on-disk table no longer matches the pinned one, and
   * this call is what said so. */
  readonly configDrifted: boolean;
}

/**
 * Prices `patch`, rules on it, and records what it decided.
 *
 * Three outcomes and three different records, because they are three different
 * facts:
 *
 * - **`reject`** appends `plan.patch.rejected` and — unless the run is already
 *   waiting on somebody — `run.needs_human { reason: 'patch-rejected' }`. AC6:
 *   *"the run transitions to needs_human"*, and the patch stays in the approval
 *   queue so a human can approve it explicitly.
 * - **`approve`** appends `plan.patch.queued` with the rule and the estimate it
 *   was ruled on. The run is untouched: *"the patch is pending, not the run"*,
 *   so unrelated branches keep scheduling.
 * - **`auto`** appends nothing here. The patch is applied by
 *   `commitPatchedPlan`, which revalidates first and writes `plan.patched` in
 *   the same transaction as the new plan row — an `auto` that recorded a
 *   decision *before* revalidation would put a decision on the log for a patch
 *   validation is about to refuse.
 *
 * Synchronous and one `appendEvents` call per outcome, so a crash leaves either
 * the decision on the log or no decision at all — never a patch ruled on twice.
 */
export function rulePatch(db: Db, input: PatchGateInput): PatchRuling {
  const patch = PlanPatchSchema.parse(input.patch);
  const base = { nodes: input.state.plan?.nodes ?? [] };

  const estimate = estimatePatch(patch, base, {
    ...input.estimator,
    planVersion: input.state.planVersion,
  });

  const decisionState = patchDecisionStateOf(input.state, {
    estimate,
    now: input.now,
    touchesExecutionBoundary: input.touchesExecutionBoundary,
  });

  const drifted = driftDraft(input);
  if (drifted !== null) appendEvents(db, [drifted]);

  const ruling = decidePatch(patch, decisionState);
  const drafts: EventDraft[] = [];

  if (ruling.decision === 'reject') {
    drafts.push(
      event(input, 'plan.patch.rejected', {
        patchId: patch.id,
        rule: ruling.ruleId,
        by: 'policy',
      }),
    );
    // Asked once. A run already waiting on a human — for churn, for a budget
    // ceiling — does not need a second ask, and a queue of identical
    // escalations is how an operator learns to ignore them. The rejection
    // itself is always recorded, which is what NF10 requires.
    if (input.state.needsHuman === null) {
      drafts.push(
        event(input, 'run.needs_human', {
          reason: 'patch-rejected',
          detail: toSingleLine(
            `patch ${patch.id} was rejected by ${ruling.ruleId}: ${patch.reason} ` +
              '— approve it explicitly from the queue if it should proceed',
          ),
        }),
      );
    }
  } else if (ruling.decision === 'approve') {
    drafts.push(
      event(input, 'plan.patch.queued', {
        patchId: patch.id,
        rule: ruling.ruleId,
        estimate: {
          costUsdDelta: estimate.costUsdDelta,
          blastRadiusFiles: estimate.blastRadiusFiles,
          maxPermission: estimate.maxPermission,
          replanDepth: estimate.replanDepth,
        },
      }),
    );
  }

  if (drafts.length > 0) appendEvents(db, drafts);

  return {
    ...ruling,
    estimate,
    elapsedBudgetFraction: decisionState.elapsedBudgetFraction,
    configDrifted: drifted !== null,
  };
}

function event(input: PatchGateInput, kind: string, payload: unknown): EventDraft {
  return {
    runId: input.runId,
    ts: input.now,
    kind,
    v: EVENT_CURRENT_VERSIONS[kind as keyof typeof EVENT_CURRENT_VERSIONS],
    epoch: input.state.epoch,
    payload,
  } as EventDraft;
}

/**
 * AC10 — `policy.patch.drifted`, or `null` when there is nothing to say.
 *
 * Reported once per distinct on-disk digest: the reducer remembers which one
 * was last reported, so an operator who saves the file forty times over an
 * afternoon is told once per *edit*, not once per patch. A run that pinned
 * nothing has nothing to have drifted from.
 */
function driftDraft(input: PatchGateInput): EventDraft | null {
  const pinned = input.state.patchPolicy;
  const current = input.configPolicyHash;
  if (pinned === null || current === undefined) return null;
  if (current === pinned.hash || current === pinned.drift) return null;

  return event(input, 'policy.patch.drifted', {
    pinnedHash: pinned.hash,
    configHash: current,
  });
}
