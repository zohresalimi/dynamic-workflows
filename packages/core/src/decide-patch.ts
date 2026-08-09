/**
 * KAR-11.4 — `decidePatch`, the one door a proposed patch goes through
 * (docs/06-planning-and-replanning.md §4.3, §7).
 *
 * The rule table lives next door in ./patch-policy.ts and is data. This module
 * is the *order* the table is asked in, and the order is the story:
 *
 * ```ts
 * if (s.circuitBreaker === 'tripped' && p.proposedBy !== 'human') reject
 * return evaluateRules(p, s)
 * ```
 *
 * 06 §7 calls that two-line shape *"the sharpest edge in the whole design, and
 * getting it backwards is expensive"*. The natural implementation puts
 * `evaluateRules` first and the breaker second, and the system it produces
 * answers churn by replanning harder: a run that has replanned three times
 * without completing a node keeps auto-applying the cheap read-only analysis
 * patches that are exactly what a churning planner emits. *"Three consecutive
 * replans with no completed nodes is not a plan that needs a fourth revision; it
 * is a plan built on a false premise, and the only thing that can supply the
 * missing premise is the person who wrote the spec."*
 *
 * **A human-authored patch is evaluated normally, and that is not an
 * exemption.** It still faces the whole table — a human's depth-4 replan is
 * still refused — but it is not short-circuited, because a human patch is how
 * the run is rescued, and a breaker that blocked it would make the trip
 * terminal.
 *
 * **The five dimensions come from DeFlow's own estimate, never from the
 * proposer's arithmetic.** `PlanPatch.policy` is mandatory (KAR-02.4 AC1) so
 * that a patch the engine *cannot* rule on is refused at the schema boundary
 * rather than defaulted to `auto`; but the numbers this function predicates over
 * are `estimatePatch`'s, because an agent that could declare its own patch cheap
 * could auto-apply anything. The two are reconciled at the gate, before this
 * function is reached: 06 §4.2's pipeline is `patch ▸ estimate ▸ policy engine`,
 * in that order.
 *
 * Pure, in the strong sense AC1 asks for: no clock, no database, no filesystem,
 * no rule table read from disk. The rules arrive on the state because they were
 * pinned into the ledger when the run started, which is what makes a mid-run
 * edit of `.DeFlow/config.yaml` unable to change the rules a live run plays by
 * (AC10).
 *
 * Verifies: EPIC-11-S19 (unit half), EPIC-11-S22, EPIC-11-S23 (unit half) ·
 * AC1, AC2, AC4, AC6, AC7, AC8, AC9
 */
import type { PatchEstimate } from './cost-estimate.ts';
import {
  compilePatchRules,
  DEFAULT_PATCH_RULES,
  elapsedBudgetFraction,
  evaluatePatchPolicy,
  type PatchPolicyRuling,
  type PatchRule,
  type RerouteEquivalence,
  type RulablePatchEstimate,
} from './patch-policy.ts';
import { PERMISSION_LEVELS, type PermissionLevel } from './plan-graph.ts';
import type { PlanPatch } from './plan-patch.ts';
import type { RunState } from './run-state.ts';

/**
 * The rule id a short-circuited patch is filed under.
 *
 * A named id rather than a bare `reject`, because AC2's requirement is that the
 * decision carries *which rule fired* — and "the policy engine said no" is not
 * an answer an operator can act on. This one in particular has a specific
 * remedy attached: propose the patch yourself.
 */
export const PATCH_CIRCUIT_BREAKER_RULE = 'circuit-breaker-tripped';

/** Whether §11.3's churn detector has tripped for this run. */
export type CircuitBreakerState = 'clear' | 'tripped';

/**
 * The breaker as *reduced state*, never as a flag somebody sets.
 *
 * KAR-06.8's detector produces `run.needs_human { reason: 'churn' }`, the
 * reducer folds it into `RunState.needsHuman`, and this reads it back. Deriving
 * it means a daemon that restarted mid-trip comes back still tripped, and a
 * replay reaches the same answer at the same seq — which a boolean living in the
 * scheduler's memory could not do.
 *
 * Only `churn` counts. A run paused at its budget ceiling or waiting on a
 * reconcile question is also `needs-human`, but neither says the *plan* is
 * built on a false premise, and short-circuiting patches there would refuse the
 * replan that a raised ceiling exists to allow.
 */
export function circuitBreakerOf(state: RunState): CircuitBreakerState {
  return state.needsHuman?.reason === 'churn' ? 'tripped' : 'clear';
}

/**
 * Everything `decidePatch` is allowed to know, and nothing else.
 *
 * Each field is either reduced from the ledger (`circuitBreaker`,
 * `ambientPermission`, `rules`) or computed by a pure function over it
 * (`estimate`, `elapsedBudgetFraction`). `patchDecisionStateOf` below is the one
 * place a `RunState` becomes one of these, so a caller cannot quietly hand the
 * engine a permission level or a rule table from somewhere else.
 */
export interface PatchDecisionState {
  readonly circuitBreaker: CircuitBreakerState;
  /** The permission level the run itself is executing at — what an escalation
   * is measured against. */
  readonly ambientPermission: PermissionLevel;
  readonly elapsedBudgetFraction: number;
  readonly estimate: RulablePatchEstimate;
  /** The table pinned into this run's manifest, compiled. */
  readonly rules: readonly PatchRule[];
  /** F5.6 — answered by the safety model. Absent means "not asked", which is
   * not the same as "no", and is why the rule needs an explicit `true`. */
  readonly touchesExecutionBoundary?: boolean | undefined;
  /** Present only for a scheduler-proposed provider swap (§4.4). */
  readonly reroute?: RerouteEquivalence | undefined;
}

/**
 * AC8 — the breaker first, the table second, and nothing between them.
 *
 * The early return is the entire mechanism. A test that only asserts the
 * *decision* of a patch the table would have rejected anyway cannot tell this
 * implementation from the inverted one; the test that can hands it a patch that
 * would otherwise match `read-only-analysis` and asserts the table was never
 * consulted.
 */
export function decidePatch(patch: PlanPatch, state: PatchDecisionState): PatchPolicyRuling {
  if (state.circuitBreaker === 'tripped' && patch.proposedBy !== 'human') {
    return { decision: 'reject', ruleId: PATCH_CIRCUIT_BREAKER_RULE };
  }

  return evaluatePatchPolicy(
    {
      estimate: state.estimate,
      ambientPermission: state.ambientPermission,
      elapsedBudgetFraction: state.elapsedBudgetFraction,
      touchesExecutionBoundary: state.touchesExecutionBoundary,
      reroute: state.reroute,
    },
    state.rules,
  );
}

/**
 * The permission level the run itself is executing at: the most capable level
 * any *active* node in the current plan was given.
 *
 * An escalation is a comparison against something, and the run's own ceiling is
 * the honest baseline — a patch asking for `worktree` inside a run that already
 * writes to a worktree is not an escalation, and one asking for it inside a
 * read-only investigation is.
 */
export function ambientPermissionOf(state: RunState): PermissionLevel {
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
 * AC10 — the rule table this run is being judged by: the one pinned at run
 * start, or the shipped defaults for a run that predates the pin.
 *
 * Never the file on disk. `.DeFlow/config.yaml` is read exactly once per run,
 * when `policy.patch.loaded` is appended; from then on the table travels in the
 * ledger, so a replay of a six-month-old run reaches the decisions that run
 * actually made rather than the ones today's config would have produced.
 */
export function patchRulesOf(state: RunState): readonly PatchRule[] {
  const pinned = state.patchPolicy;
  return pinned === null ? DEFAULT_PATCH_RULES : compilePatchRules(pinned.rules);
}

export interface PatchDecisionInputs {
  /** KAR-14.3's pre-flight estimate for this patch. */
  readonly estimate: PatchEstimate | RulablePatchEstimate;
  /** ms epoch from the injected `Clock`. Read here, not held: the fraction is a
   * number by the time it reaches `decidePatch`. */
  readonly now: number;
  readonly touchesExecutionBoundary?: boolean | undefined;
  readonly reroute?: RerouteEquivalence | undefined;
}

/**
 * The one place a `RunState` becomes a `PatchDecisionState`.
 *
 * Wall-clock elapsed is measured from the run's own start, which is `0` until
 * `run.started` — a run that has not begun has consumed none of its clock.
 */
export function patchDecisionStateOf(
  state: RunState,
  inputs: PatchDecisionInputs,
): PatchDecisionState {
  const elapsed = state.startedTs === 0 ? null : inputs.now - state.startedTs;

  return {
    circuitBreaker: circuitBreakerOf(state),
    ambientPermission: ambientPermissionOf(state),
    elapsedBudgetFraction: elapsedBudgetFraction(state.budget.run, state.ceilings.run, elapsed),
    estimate: {
      costUsdDelta: inputs.estimate.costUsdDelta,
      blastRadiusFiles: inputs.estimate.blastRadiusFiles,
      maxPermission: inputs.estimate.maxPermission,
      replanDepth: inputs.estimate.replanDepth,
    },
    rules: patchRulesOf(state),
    touchesExecutionBoundary: inputs.touchesExecutionBoundary,
    reroute: inputs.reroute,
  };
}
