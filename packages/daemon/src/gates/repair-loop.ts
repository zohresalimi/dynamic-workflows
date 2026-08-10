/**
 * KAR-12.5, from the daemon's side: a failing verdict becomes a **committed
 * plan version** carrying one fix node per blocking finding
 * (docs/10-verification-gates.md §7).
 *
 * `@DeFlow/gates` already decides everything about the repair that is a
 * function of its inputs — how many fix nodes a verdict earns, what each one is
 * briefed with, how narrow its write scope is, and which tier re-opens once it
 * lands. All of that is pure and tested there. What is left, and what lives
 * here, is the part with a database in it, and it is deliberately shaped like
 * `applyQuotaReroute`:
 *
 *     repairPatchesFor → rulePatch → applyPatch → commitPatchedPlan
 *
 * Two consequences follow from that shape, and both are the point.
 *
 * **Nothing here edits a plan.** A repair is a `PlanPatch` ruled on by the same
 * policy engine as a planner's, revalidated by the same `commitPatchedPlan`,
 * and written through the same single seam — so a fix node appears in the plan
 * scrubber like any other change, with a reason and a decision beside it. A
 * code path that inserted the node directly would be a repair with no version
 * behind it: invisible in F10.2, and unexplainable to an operator.
 *
 * **`auto` is a ruling, never a bypass.** `applied` is only true with a
 * committed version behind it: validation runs after the ruling and may still
 * refuse, and reporting success on the strength of the decision alone would
 * claim a fix node the run is not executing.
 *
 * The re-run set is `gatesAfterRepair`, which is the **deterministic tier** and
 * not the gate that failed — *"a fix that breaks typecheck is caught before the
 * review is paid for again"* (§7, AC5).
 */
import type {
  Db,
  EstimatorInputs,
  Handle,
  LadderGate,
  NodeId,
  PatchPolicyDecision,
  PermissionLevel,
  PlanGraph,
  PlanNode,
  PlannerAttribution,
  PlanPatch,
  PlanTimeCapability,
  ProposedBy,
  RunId,
  TaskSpec,
  VerdictV3,
} from '@DeFlow/core';
import { applyPatch, EVENT_CURRENT_VERSIONS } from '@DeFlow/core';
import { gatesAfterRepair, type RepairContext, repairPatchesFor } from '@DeFlow/gates';
import { appendEvents, replayRun } from '@DeFlow/ledger';
import { rulePatch } from '../budget/patch-gate.ts';
import {
  type CommitPatchedPlanOutcome,
  commitPatchedPlan,
  type NodeRefChecker,
} from '../plan/validate.ts';

/** The rule a structurally impossible repair is filed under — reachable only
 * when the base graph moved under the proposal. Recorded rather than thrown,
 * because NF10's question is *"what did the run want to do and why did it not
 * happen"*. */
export const REPAIR_NOT_APPLICABLE = 'repair-not-applicable';

/** What the caller must supply that a verdict does not carry. */
export interface GateRepairContext extends Omit<RepairContext, 'evidence'> {
  readonly evaluatedNode: NodeId;
  readonly ambientPermission: PermissionLevel;
  readonly replanDepth: number;
  readonly proposedBy: ProposedBy;
  /** Handles to the failing command's output — what the fix node reads instead
   * of a transcript (§7). */
  readonly evidence: readonly Handle[];
}

export interface GateRepairRequest {
  readonly runId: RunId;
  /** The verdict that failed, exactly as `gate.evaluated` recorded it. */
  readonly verdict: VerdictV3;
  /** The plan version the ops are derived against. */
  readonly base: PlanGraph;
  /** `<target-repo>/.DeFlow/runs/<runId>`. */
  readonly runDir: string;
  readonly spec: TaskSpec;
  readonly caps: readonly PlanTimeCapability[];
  readonly estimatePacketTokens: (node: PlanNode) => number;
  readonly refs: NodeRefChecker;
  readonly estimator: EstimatorInputs;
  readonly planner: PlannerAttribution;
  /** From the injected `Clock`, never `Date.now()`. */
  readonly ts: number;
  readonly epoch: number;
  readonly context: GateRepairContext;
  readonly configPolicyHash?: string | undefined;
  readonly touchesExecutionBoundary?: boolean | undefined;
}

/** One proposal and what the policy engine said about it. */
export interface GateRepairRuling {
  readonly node: NodeId;
  readonly patch: PlanPatch;
  readonly decision: PatchPolicyDecision;
  readonly ruleId: string;
  readonly applied: boolean;
  readonly commit?: CommitPatchedPlanOutcome;
}

export interface GateRepairOutcome {
  /** `none` for a `pass`, `human` for a verdict nothing can repair, `fix`
   * otherwise — the vocabulary `repairPatchesFor` already speaks. */
  readonly kind: 'none' | 'human' | 'fix';
  /** Why, when the answer was `none` or `human`. */
  readonly why: string | null;
  /** The prompt a human needs, when there is one. */
  readonly prompt: string | null;
  /** The fix nodes the run is now executing. */
  readonly applied: readonly NodeId[];
  readonly decisions: readonly GateRepairRuling[];
  /**
   * The gates to schedule once a fix node completes: the deterministic tier,
   * with every earlier outcome discarded (AC5).
   *
   * Empty when nothing was applied — a run with no fix node in flight has
   * nothing to re-verify.
   */
  readonly rerun: readonly LadderGate[];
}

const NOTHING: Omit<GateRepairOutcome, 'kind' | 'why' | 'prompt'> = {
  applied: [],
  decisions: [],
  rerun: [],
};

/** The plan's gate nodes, as the ladder sees them. */
function laddersOf(graph: PlanGraph): readonly LadderGate[] {
  const gates: LadderGate[] = [];
  for (const node of graph.nodes) {
    if (node.type !== 'gate' || node.lifecycle !== 'active') continue;
    gates.push({
      node: node.id,
      gate: node.gate.kind === 'deterministic' ? node.gate.gateId : (node.id as unknown as never),
      kind: node.gate.kind,
    });
  }
  return gates;
}

/**
 * Proposes, rules on and — when the ruling is `auto` — commits the fix nodes a
 * failing verdict earns.
 *
 * Patches are applied **in order and cumulatively**: each one is composed
 * against the version the previous one produced, because two patches derived
 * from the same base and applied blind would each claim the other's plan hash
 * was current, and the second would be refused as stale for no reason a reader
 * could explain.
 */
export async function applyGateRepair(
  db: Db,
  request: GateRepairRequest,
): Promise<GateRepairOutcome> {
  const decision = repairPatchesFor(request.verdict, {
    evaluatedNode: request.context.evaluatedNode,
    ambientPermission: request.context.ambientPermission,
    replanDepth: request.context.replanDepth,
    evidence: request.context.evidence,
    proposedBy: request.context.proposedBy,
    ...(request.context.severityFloor === undefined
      ? {}
      : { severityFloor: request.context.severityFloor }),
    ...(request.context.testScopes === undefined ? {} : { testScopes: request.context.testScopes }),
    ...(request.context.fixPermission === undefined
      ? {}
      : { fixPermission: request.context.fixPermission }),
    ...(request.context.fixProvider === undefined
      ? {}
      : { fixProvider: request.context.fixProvider }),
  });

  if (decision.kind === 'none') {
    return { kind: 'none', why: decision.why, prompt: null, ...NOTHING };
  }
  if (decision.kind === 'human') {
    return { kind: 'human', why: decision.why, prompt: decision.prompt, ...NOTHING };
  }

  const decisions: GateRepairRuling[] = [];
  const applied: NodeId[] = [];
  let base = request.base;

  for (const target of decision.findings) {
    const ruling = rulePatch(db, {
      runId: request.runId,
      state: replayRun(db, request.runId).state,
      patch: target.patch,
      estimator: request.estimator,
      now: request.ts,
      ...(request.touchesExecutionBoundary === undefined
        ? {}
        : { touchesExecutionBoundary: request.touchesExecutionBoundary }),
      ...(request.configPolicyHash === undefined
        ? {}
        : { configPolicyHash: request.configPolicyHash }),
    });

    if (ruling.decision !== 'auto') {
      decisions.push({
        node: target.node,
        patch: target.patch,
        decision: ruling.decision,
        ruleId: ruling.ruleId,
        applied: false,
      });
      continue;
    }

    const composed = await applyPatch(base, target.patch, {
      createdAt: new Date(request.ts).toISOString(),
    });
    if (!composed.ok) {
      appendEvents(db, [
        {
          runId: request.runId,
          ts: request.ts,
          kind: 'plan.patch.rejected',
          v:
            (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)['plan.patch.rejected'] ??
            1,
          epoch: request.epoch,
          payload: {
            patchId: target.patch.id,
            rule: REPAIR_NOT_APPLICABLE,
            by: 'validation',
          },
        },
      ]);
      decisions.push({
        node: target.node,
        patch: target.patch,
        decision: ruling.decision,
        ruleId: ruling.ruleId,
        applied: false,
      });
      continue;
    }

    const commit = await commitPatchedPlan({
      db,
      runDir: request.runDir,
      graph: composed.graph,
      spec: request.spec,
      caps: request.caps,
      estimatePacketTokens: request.estimatePacketTokens,
      refs: request.refs,
      plan: composed.graph,
      basePlanHash: base.planHash,
      patchId: target.patch.id,
      decision: {
        decision: 'auto',
        by: 'policy',
        rule: ruling.ruleId,
        at: new Date(request.ts).toISOString(),
      },
      by: target.patch.proposedBy,
      planner: request.planner,
      ts: request.ts,
      epoch: request.epoch,
    });

    const committed = commit.outcome === 'committed';
    if (committed) {
      base = composed.graph;
      applied.push(target.node);
    }
    decisions.push({
      node: target.node,
      patch: target.patch,
      decision: ruling.decision,
      ruleId: ruling.ruleId,
      applied: committed,
      commit,
    });
  }

  return {
    kind: 'fix',
    why: null,
    prompt: null,
    applied,
    decisions,
    rerun: applied.length === 0 ? [] : gatesAfterRepair(laddersOf(base)),
  };
}
