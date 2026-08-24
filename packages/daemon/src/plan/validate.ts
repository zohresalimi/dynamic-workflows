/**
 * KAR-11.2 — the one entry point to plan validation that can spawn a process,
 * and the one entry point to committing a patched plan
 * (docs/06-planning-and-replanning.md §3.3, §3.5, §8).
 *
 * `@DeFlow/core`'s `validatePlan` is pure and performs every check that is a
 * function of the document. Exactly one check is not: §3.3 insists that a node
 * id be validated *"with git itself rather than reimplementing its rules"*, and
 * a `git check-ref-format` is a real subprocess. So this module is the thin
 * layer that asks git, hands the answer to the pure validator, and returns one
 * diagnostics array — never two, and never a second set of rules.
 *
 * **The ref shape is D13's, and it is the reason this file also exports
 * `nodeRefOf`.** `refs/heads/DeFlow/<runId>__<nodeId>`, flat, with `__` and
 * never `/`, because git refs are files in a directory tree: under the PRD's
 * `DeFlow/<runId>/<nodeId>` scheme, `refs/heads/DeFlow/r1` would have to be both
 * a file (the run-level integration branch) and a directory (the node branches
 * beneath it), and git will hold only one of the two. That is a *verified* bug,
 * not a preference — ../../test/integration/plan-validation.test.ts reproduces
 * git's refusal — and it is exactly the kind of thing a later tidy-up of branch
 * names reintroduces, which is why the composition lives in one function with a
 * regression test on it.
 *
 * **`commitPatchedPlan` exists so that "revalidate before the transaction
 * commits" is a shape rather than a discipline.** 06 §8's warning is that *"the
 * patch that adds a node reading a key nothing writes is the one that actually
 * bites, because it happens at node 27 of 40"*, and §3.5 is that a failing patch
 * is *"rejected outright — never partially applied"*. Both hold here by
 * construction: the function takes the already-composed successor graph, and the
 * only paths out of it are "validated and committed" or "rejected, with nothing
 * written but the `plan.patch.rejected` that says so".
 *
 * Note what this function deliberately does **not** take: the policy engine's
 * decision. EPIC-11-S18's second scenario is that a patch the policy engine
 * approved is still refused by validation, and the cheapest way to guarantee
 * that is to give the decision nowhere to be passed in.
 *
 * Verifies: EPIC-11-S10, EPIC-11-S12, EPIC-11-S18 (the validation half) ·
 * AC7, AC9, AC11
 */
import type {
  Db,
  PatchDecision,
  PlanDiagnostic,
  PlanGraph,
  PlanNode,
  PlannerAttribution,
  PlanTimeCapability,
  ProposedBy,
  TaskSpec,
} from '@DeFlow/core';
import { hasBlockingDiagnostic, validatePlan, withCoveredByGates } from '@DeFlow/core';
import { appendEvents, applyPatchedPlanVersion, PATCH_STALE } from '@DeFlow/ledger';
import { PERFORMABLE_NODE_TYPES, PERFORMABLE_TOOL_KINDS } from '../exec/performable.ts';

/**
 * D13's flat node ref. The one place the string is composed, so the scheme is
 * one edit and one regression test rather than a convention.
 */
export function nodeRefOf(runId: string, nodeId: string): string {
  return `refs/heads/DeFlow/${runId}__${nodeId}`;
}

/** What this module needs of `RefFormatChecker`: git's verdict on a full ref. */
export interface NodeRefChecker {
  isValidRef(ref: string): Promise<boolean>;
}

export interface PlanValidationRequest {
  readonly plan: PlanGraph;
  readonly spec: TaskSpec;
  readonly caps: readonly PlanTimeCapability[];
  readonly estimatePacketTokens: (node: PlanNode) => number;
  readonly refs: NodeRefChecker;
}

/**
 * What one validation pass produces: the diagnostics, and the spec as the walk
 * leaves it.
 *
 * KAR-12.4 AC3 — *"`coveredByGates` is written by validation, not by the
 * planner"*. The two travel together because they are the same walk over the
 * same graph: `spec` is `request.spec` with every criterion's `coveredByGates`
 * recomputed from this plan version's **active** gate nodes and overwritten,
 * and the diagnostics are what that walk found wrong. Returning only the
 * diagnostics would leave the criterion → node mapping computed and thrown
 * away, which is how the acceptance board ends up asking the planner where a
 * criterion's evidence lives.
 *
 * `spec.specHash` is deliberately unchanged: `specHash` excludes the derived
 * field (@DeFlow/core's ./hash.ts), so the annotated document is the same
 * identity as the pinned one — otherwise validating a patched plan would void
 * every verdict in the ledger (AC6).
 */
export interface PlanValidation {
  readonly diagnostics: readonly PlanDiagnostic[];
  /** The pinned spec with `coveredByGates` written from this plan version. */
  readonly spec: TaskSpec;
}

/**
 * Every diagnostic §3 produces for `plan`, git's verdict included, plus the
 * annotated spec.
 *
 * The refs are checked concurrently and then handed to the pure validator in
 * one set, rather than interleaved with the other checks, because the answer
 * per id is independent and a 400-node plan should not pay for 400 sequential
 * process spawns. `RefFormatChecker` caches per composed ref, so a repeated id
 * — which is itself a diagnostic — costs one process, not two.
 */
export async function validatePlanVersion(request: PlanValidationRequest): Promise<PlanValidation> {
  const ids = request.plan.nodes.map((node): string => node.id);
  const verdicts = await Promise.all(
    ids.map(async (id) => ({
      id,
      ok: await request.refs.isValidRef(nodeRefOf(request.plan.runId, id)),
    })),
  );

  return {
    diagnostics: validatePlan(request.plan, request.spec, request.caps, {
      estimatePacketTokens: request.estimatePacketTokens,
      // KAR-23.9 — what this daemon can actually perform, read from the one
      // constant `pipeline/live-nodes.ts` composes its registry against.
      //
      // Supplied here rather than by each caller, and that is the whole design:
      // `compilePlanV1`, `commitPatchedPlan`, `gates/repair-loop.ts` and
      // `providers/quota-reroute.ts` all get the guard with **zero** call-site
      // changes, and a patch cannot smuggle a `map` node past it either. A
      // per-caller option would be a check somebody eventually forgets, which
      // is how sixteen nodes were admitted on 2026-08-24 for work seven of them
      // could never do.
      performable: {
        nodeTypes: PERFORMABLE_NODE_TYPES,
        toolKinds: PERFORMABLE_TOOL_KINDS,
      },
      refusedRefs: verdicts.filter((verdict) => !verdict.ok).map((verdict) => verdict.id),
    }),
    spec: withCoveredByGates(request.spec, request.plan),
  };
}

export interface CommitPatchedPlanRequest extends PlanValidationRequest {
  readonly db: Db;
  /** `<target-repo>/.DeFlow/runs/<runId>`. */
  readonly runDir: string;
  /** The composed successor graph, with `planHash` already addressing it. */
  readonly graph: PlanGraph;
  /**
   * KAR-11.3 AC6 — the plan the proposer derived its ops against. Compared
   * against `run.plan_hash` inside the write transaction; a mismatch is
   * `PATCH_STALE` and **no rebase is attempted**.
   */
  readonly basePlanHash: string;
  readonly patchId: string;
  /**
   * KAR-11.3 AC4 — the policy engine's ruling, which `plan.patched` has to
   * carry.
   *
   * It is **recorded, never consulted**. EPIC-11-S18's second scenario is that
   * an `auto` decision does not buy a patch past validation, and the shape that
   * guarantees it is the order of this function's body: `validatePlanVersion`
   * runs first and unconditionally, and the rejection branch returns before
   * anything reads this field. The parameter used to be absent, which made the
   * guarantee true but untestable — the scenario could not even be written.
   * Now it is passed, and the test passes `'auto'` and still expects a refusal.
   */
  readonly decision: PatchDecision;
  readonly by: ProposedBy;
  readonly planner: PlannerAttribution;
  /** From the injected `Clock`, never `Date.now()`. */
  readonly ts: number;
  readonly epoch: number;
  /** KAR-11.3 AC4's kill point, forwarded to the transaction. Undefined in
   * production; the crash-fuzz harness is the only caller that sets it. */
  readonly crashPoint?: (() => void) | undefined;
}

export type CommitPatchedPlanOutcome =
  | {
      readonly outcome: 'committed';
      readonly diagnostics: readonly PlanDiagnostic[];
      /** KAR-12.4 AC3 — the pinned spec with `coveredByGates` rewritten from
       * the *successor* version, because a patch that retires or adds a gate
       * node changes which nodes cover which criterion. */
      readonly spec: TaskSpec;
      readonly seq: number;
      readonly planHash: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly diagnostics: readonly PlanDiagnostic[];
      readonly seq: number;
    }
  | {
      readonly outcome: 'stale';
      readonly code: typeof PATCH_STALE;
      /** AC6 — what the proposer must re-derive against. */
      readonly currentPlanHash: string | null;
      readonly diagnostics: readonly PlanDiagnostic[];
      readonly seq: number;
    };

/** The `rule` a validation rejection files itself under, so the approval queue
 * can group it with the policy engine's rules without pretending it is one. */
export const PATCH_REJECTED_BY_VALIDATION = 'plan-invalid';

/**
 * KAR-11.3 AC6 — the `rule` a stale proposal is filed under.
 *
 * Recorded as `by: 'validation'` rather than `'policy'`, and the distinction is
 * the one EPIC-11-S18's note draws: the policy engine asks *should we?* and
 * everything else asks *can we?* A stale patch is not a patch anybody
 * disapproved of — it is a patch about a graph that no longer exists — so an
 * operator reading the approval queue must not see it grouped with the rules
 * that refuse patches on their merits.
 */
export const PATCH_REJECTED_AS_STALE = 'patch-stale';

/** One `plan.patch.rejected`, and the seq it landed at. */
function appendRejection(
  request: CommitPatchedPlanRequest,
  rule: string,
  diagnostics: readonly PlanDiagnostic[],
): number {
  const [seq] = appendEvents(request.db, [
    {
      runId: request.graph.runId,
      ts: request.ts,
      kind: 'plan.patch.rejected',
      v: 2,
      epoch: request.epoch,
      payload: {
        patchId: request.patchId,
        rule,
        by: 'validation',
        ...(diagnostics.length === 0
          ? {}
          : { diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic })) }),
      },
    },
  ]);
  if (seq === undefined) throw new Error('appending plan.patch.rejected returned no seq');
  return seq;
}

/**
 * Revalidates a patched plan and either commits it, rejects it whole, or
 * refuses it as stale.
 *
 * `graph` is the *successor* document, not the ops — composing it is
 * `applyPatch`'s (@DeFlow/core) — and taking it that way is what makes "never
 * partially applied" structural: there is no intermediate state to leave
 * behind, because nothing here mutates the base plan. On either refusal the
 * only write is `plan.patch.rejected`, which is a record of the refusal rather
 * than a change to the run's plan.
 *
 * The three outcomes answer three different questions, in this order and no
 * other: *is the resulting graph runnable?* (validation, always, first), *is
 * this still the graph the proposer reasoned about?* (`basePlanHash`, inside
 * the write transaction), and only then *record it*.
 */
export async function commitPatchedPlan(
  request: CommitPatchedPlanRequest,
): Promise<CommitPatchedPlanOutcome> {
  const { diagnostics, spec } = await validatePlanVersion({ ...request, plan: request.graph });

  if (hasBlockingDiagnostic(diagnostics)) {
    return {
      outcome: 'rejected',
      diagnostics,
      seq: appendRejection(request, PATCH_REJECTED_BY_VALIDATION, diagnostics),
    };
  }

  const applied = await applyPatchedPlanVersion(request.db, {
    runDir: request.runDir,
    graph: request.graph,
    basePlanHash: request.basePlanHash,
    patchId: request.patchId,
    decision: request.decision,
    by: request.by,
    planner: request.planner,
    diagnostics,
    ts: request.ts,
    epoch: request.epoch,
    crashPoint: request.crashPoint,
  });

  if (applied.outcome === 'stale') {
    return {
      outcome: 'stale',
      code: PATCH_STALE,
      currentPlanHash: applied.currentPlanHash,
      diagnostics,
      seq: appendRejection(request, PATCH_REJECTED_AS_STALE, []),
    };
  }

  return {
    outcome: 'committed',
    diagnostics,
    spec,
    seq: applied.seq,
    planHash: applied.planHash,
  };
}
