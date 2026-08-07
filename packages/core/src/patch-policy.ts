/**
 * KAR-14.3 — F2.5's patch policy engine: the estimate turned into a decision
 * (docs/06-planning-and-replanning.md §4.3).
 *
 * *"Declarative, ordered, first match wins."* The table below is that sentence
 * as data, rule for rule and in the order the architecture states them, so a
 * reader can put the yaml and this file side by side. It is data rather than a
 * chain of `if`s for the reason the document gives: the table lives in
 * `.DeFlow/config.yaml` under `policy.patch` and is hashed into the run
 * manifest, so what fired is reconstructable from the log, and a mid-run edit
 * cannot silently change the rules of a run already in flight.
 *
 * Three things in here are the whole story.
 *
 * **The default arm is `approve`, not `auto`.** *"Anything the rules do not
 * recognise goes to a human."* Every other decision this module makes is a
 * refinement of that one.
 *
 * **A numeric predicate is false for `null`, never true.** An unpriceable patch
 * (KAR-14.3 AC7) has `costUsdDelta: null`; if that were coerced to `0` it would
 * satisfy `costDeltaUsd <= 5.00`, match `read-only-analysis`, and auto-apply the
 * most expensive class of patch on exactly the providers DeFlow cannot meter.
 * So `lte`/`gt` here answer `false` on `null` and the patch falls to the default
 * arm — a human. That is the second half of the defence and both halves must
 * hold.
 *
 * **An escalation is a comparison, not a threshold.** `maxPermission: worktree`
 * is an escalation from `read` and a *de-escalation* from `full`, and a rule
 * that compared the level against a constant would queue a patch that reduces
 * capability. The ladder is ordered, so the comparison is against the run's own
 * ambient level.
 *
 * Verifies: EPIC-14-S16, EPIC-14-S17, EPIC-14-S18 · KAR-14.3 AC5, AC6, AC7
 */
import type { Ceiling } from './budget-ceiling.ts';
import type { PatchEstimate } from './cost-estimate.ts';
import type { CostRollup } from './cost-rollup.ts';
import type { ProviderAuthMode } from './event-payloads.ts';
import { PERMISSION_LEVELS, type PermissionLevel } from './plan-graph.ts';
import type { PatchDecisionOutcome } from './plan-patch.ts';

/** The three decisions the rule table can reach, in F2.5's own vocabulary. */
export const PATCH_POLICY_DECISIONS = ['auto', 'approve', 'reject'] as const;

export type PatchPolicyDecision = (typeof PATCH_POLICY_DECISIONS)[number];

/** Above this, a patch is `expensive` and goes to a human. */
export const EXPENSIVE_COST_USD = 5;
/** Above this many files, the blast radius is wide enough to want an opinion. */
export const WIDE_BLAST_RADIUS_FILES = 25;
/** F2.5: replanning deeper than this is a loop that is not converging. */
export const MAX_REPLAN_DEPTH = 3;
/** At or above this fraction of the ceiling, the run has spent what it was given. */
export const BUDGET_EXHAUSTED_FRACTION = 1;

/** The five dimensions of §4.3's table, as the estimator produces them. */
export type RulablePatchEstimate = Pick<
  PatchEstimate,
  'costUsdDelta' | 'blastRadiusFiles' | 'maxPermission' | 'replanDepth'
>;

export interface PatchPolicyInput {
  readonly estimate: RulablePatchEstimate;
  /** The permission level the run itself is executing at. */
  readonly ambientPermission: PermissionLevel;
  /** KAR-14.1's rollup against KAR-14.2's ceiling — see below. */
  readonly elapsedBudgetFraction: number;
  /**
   * F5.6 — whether the patch reaches the execution boundary (a deny-listed
   * command, the sandbox itself). Supplied by the safety model rather than
   * derived here: this module rules, it does not inspect.
   */
  readonly touchesExecutionBoundary?: boolean | undefined;
}

export interface PatchRule {
  readonly id: string;
  readonly decision: PatchPolicyDecision;
  readonly matches: (input: PatchPolicyInput) => boolean;
}

export interface PatchPolicyRuling {
  readonly decision: PatchPolicyDecision;
  readonly ruleId: string;
}

const rank = (level: PermissionLevel): number => PERMISSION_LEVELS.indexOf(level);

/**
 * `value > threshold`, answering `false` for an unknown value.
 *
 * The pair below is the one place `null` meets a number in this engine, and
 * both arms lean the same way: an unknown cost matches neither the rule that
 * would queue it nor the rule that would auto-apply it, so it reaches the
 * default arm and a human sees it.
 */
const gt = (value: number | null, threshold: number): boolean =>
  value !== null && value > threshold;

const lte = (value: number | null, threshold: number): boolean =>
  value !== null && value <= threshold;

/**
 * The default rule table, verbatim from §4.3 and in its order.
 *
 * First match wins, so the order *is* the policy: permission and the execution
 * boundary are asked before cost, because a patch that escalates capability is
 * a human's decision however cheap it is; depth and budget are asked before
 * cost because both are reasons to stop rather than to price.
 */
export const DEFAULT_PATCH_RULES: readonly PatchRule[] = Object.freeze([
  {
    id: 'escalates-permission',
    decision: 'approve',
    matches: (input) => rank(input.estimate.maxPermission) > rank(input.ambientPermission),
  },
  {
    id: 'touches-execution-boundary',
    decision: 'approve',
    matches: (input) => input.touchesExecutionBoundary === true,
  },
  {
    id: 'replan-depth-exceeded',
    decision: 'reject',
    matches: (input) => input.estimate.replanDepth > MAX_REPLAN_DEPTH,
  },
  {
    id: 'budget-exhausted',
    decision: 'reject',
    matches: (input) => input.elapsedBudgetFraction >= BUDGET_EXHAUSTED_FRACTION,
  },
  {
    id: 'expensive',
    decision: 'approve',
    matches: (input) => gt(input.estimate.costUsdDelta, EXPENSIVE_COST_USD),
  },
  {
    id: 'wide-blast-radius',
    decision: 'approve',
    matches: (input) => input.estimate.blastRadiusFiles > WIDE_BLAST_RADIUS_FILES,
  },
  {
    id: 'read-only-analysis',
    decision: 'auto',
    matches: (input) =>
      input.estimate.maxPermission === 'read' &&
      lte(input.estimate.costUsdDelta, EXPENSIVE_COST_USD),
  },
  {
    id: 'default',
    decision: 'approve',
    matches: () => true,
  },
]);

/**
 * AC5 — the decision, and the rule that made it.
 *
 * The rule id travels with the decision because a rejection with no named rule
 * is unanswerable: *"the run wanted to do X and was not allowed to"* is exactly
 * the state NF10 requires to be traceable, and "the policy engine said no" is
 * not a trace.
 */
export function evaluatePatchPolicy(
  input: PatchPolicyInput,
  rules: readonly PatchRule[] = DEFAULT_PATCH_RULES,
): PatchPolicyRuling {
  for (const rule of rules) {
    if (rule.matches(input)) return { decision: rule.decision, ruleId: rule.id };
  }
  // Unreachable with the default table, whose last arm matches everything — but
  // a caller may pass its own, and a table with no default arm must not
  // silently apply a patch nothing ruled on.
  return { decision: 'approve', ruleId: 'default' };
}

/**
 * The rule table's vocabulary in the ledger's.
 *
 * `approve` is a *request* for approval — the patch is queued for a human
 * (F8.3), it is not applied — and `PatchDecision.decision` spells that
 * `'queued'`. `'approved'` is what a human's answer looks like afterwards, and
 * conflating the two would record a patch as approved that nobody has seen.
 */
export function patchDecisionOutcome(decision: PatchPolicyDecision): PatchDecisionOutcome {
  if (decision === 'auto') return 'auto';
  if (decision === 'reject') return 'rejected';
  return 'queued';
}

// ── the elapsed budget ───────────────────────────────────────────────────────

const AUTH_MODES: readonly ProviderAuthMode[] = ['subscription', 'api_key'];

/**
 * AC6 — how much of what this run was given it has already spent, in both
 * dimensions, **the larger winning**.
 *
 * Not the mean, and not one dimension: a run at 90% of its money and 40% of its
 * clock has 10% of its allowance left, not 65%, and averaging the two is how a
 * run gets to spend past a ceiling by being fast.
 *
 * Each money substance is measured against the ceiling on its own, for the
 * reason `budget-ceiling.ts` gives at length: subscription quota and real
 * currency are not summable, so the fraction is the largest cell's, never the
 * total's. A dimension with no ceiling contributes nothing — an unbounded run
 * cannot be exhausted — and so does an unmeasurable cell, because a blank cost
 * cell is not a full budget.
 */
export function elapsedBudgetFraction(
  rollup: CostRollup,
  ceiling: Ceiling,
  elapsedMs: number | null,
): number {
  let fraction = 0;

  if (ceiling.costUsd !== null && ceiling.costUsd > 0) {
    for (const mode of AUTH_MODES) {
      const spent = mode === 'subscription' ? rollup.costUsd.subscription : rollup.costUsd.apiKey;
      if (spent === null) continue;
      fraction = Math.max(fraction, spent / ceiling.costUsd);
    }
  }

  if (ceiling.wallclockMs !== null && ceiling.wallclockMs > 0 && elapsedMs !== null) {
    fraction = Math.max(fraction, elapsedMs / ceiling.wallclockMs);
  }

  return fraction;
}
