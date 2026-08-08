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
  PlanDiagnostic,
  PlanGraph,
  PlanNode,
  PlannerAttribution,
  PlanTimeCapability,
  ProposedBy,
  TaskSpec,
} from '@DeFlow/core';
import { hasBlockingDiagnostic, validatePlan } from '@DeFlow/core';
import { appendEvents, persistPlanVersion } from '@DeFlow/ledger';

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
 * Every diagnostic §3 produces for `plan`, git's verdict included.
 *
 * The refs are checked concurrently and then handed to the pure validator in
 * one set, rather than interleaved with the other checks, because the answer
 * per id is independent and a 400-node plan should not pay for 400 sequential
 * process spawns. `RefFormatChecker` caches per composed ref, so a repeated id
 * — which is itself a diagnostic — costs one process, not two.
 */
export async function validatePlanVersion(
  request: PlanValidationRequest,
): Promise<readonly PlanDiagnostic[]> {
  const ids = request.plan.nodes.map((node): string => node.id);
  const verdicts = await Promise.all(
    ids.map(async (id) => ({
      id,
      ok: await request.refs.isValidRef(nodeRefOf(request.plan.runId, id)),
    })),
  );

  return validatePlan(request.plan, request.spec, request.caps, {
    estimatePacketTokens: request.estimatePacketTokens,
    refusedRefs: verdicts.filter((verdict) => !verdict.ok).map((verdict) => verdict.id),
  });
}

export interface CommitPatchedPlanRequest extends PlanValidationRequest {
  readonly db: Db;
  /** `<target-repo>/.DeFlow/runs/<runId>`. */
  readonly runDir: string;
  /** The composed successor graph, with `planHash` already addressing it. */
  readonly graph: PlanGraph;
  readonly patchId: string;
  readonly by: ProposedBy;
  readonly planner: PlannerAttribution;
  /** From the injected `Clock`, never `Date.now()`. */
  readonly ts: number;
  readonly epoch: number;
}

export type CommitPatchedPlanOutcome =
  | {
      readonly outcome: 'committed';
      readonly diagnostics: readonly PlanDiagnostic[];
      readonly seq: number;
      readonly planHash: string;
    }
  | {
      readonly outcome: 'rejected';
      readonly diagnostics: readonly PlanDiagnostic[];
      readonly seq: number;
    };

/** The `rule` a validation rejection files itself under, so the approval queue
 * can group it with the policy engine's rules without pretending it is one. */
export const PATCH_REJECTED_BY_VALIDATION = 'plan-invalid';

/**
 * Revalidates a patched plan and either commits it or rejects it whole.
 *
 * `graph` is the *successor* document, not the ops — applying them is
 * KAR-11.3's — and taking it that way is what makes "never partially applied"
 * structural: there is no intermediate state to leave behind, because nothing
 * here mutates the base plan. On rejection the only write is
 * `plan.patch.rejected`, which is a record of the refusal rather than a change
 * to the run's plan.
 */
export async function commitPatchedPlan(
  request: CommitPatchedPlanRequest,
): Promise<CommitPatchedPlanOutcome> {
  const diagnostics = await validatePlanVersion({ ...request, plan: request.graph });

  if (hasBlockingDiagnostic(diagnostics)) {
    const [seq] = appendEvents(request.db, [
      {
        runId: request.graph.runId,
        ts: request.ts,
        kind: 'plan.patch.rejected',
        v: 2,
        epoch: request.epoch,
        payload: {
          patchId: request.patchId,
          rule: PATCH_REJECTED_BY_VALIDATION,
          by: 'validation',
          diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic })),
        },
      },
    ]);
    if (seq === undefined) throw new Error('appending plan.patch.rejected returned no seq');
    return { outcome: 'rejected', diagnostics, seq };
  }

  const persisted = await persistPlanVersion(request.db, {
    runDir: request.runDir,
    graph: request.graph,
    by: request.by,
    planner: request.planner,
    diagnostics,
    ts: request.ts,
    epoch: request.epoch,
  });

  return {
    outcome: 'committed',
    diagnostics,
    seq: persisted.seq,
    planHash: persisted.planHash,
  };
}
