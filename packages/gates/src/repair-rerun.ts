/**
 * KAR-12.5 AC5 — the plan change that re-runs the gate set from the
 * deterministic tier once a fix node has landed
 * (docs/10-verification-gates.md §7).
 *
 * ./repair.ts's `gatesAfterRepair` answers *which* gates re-open, and that is
 * the whole of the decision. What it cannot answer is how a run gets to run one
 * again, and the obvious answer — re-admit the node — is not available: the
 * ladder reads a recorded outcome **per node** (`admitGates`), so a gate node
 * that has answered `fail` is answered for ever, and a scheduler that ignored
 * that would re-admit the failing gate for ever too.
 *
 * So a re-run is a **new gate node**, and the milestone rule already says so out
 * loud: *"gate ids, not node ids: the same definition may be scheduled more than
 * once across a repair loop, and it is the definition that is required"*
 * (./milestone.ts). Three things follow, and each is load-bearing.
 *
 * **The re-run depends on the fix.** Its `deps` are the fix nodes, so the gate
 * cannot run against the tree the producer left; §5.2's stale green is exactly
 * what a re-run with the old dependencies would produce.
 *
 * **The answered node is retired, never deleted.** `abandon-branch` marks it
 * `abandoned` and it stays in the document — the effect journal keys on node
 * ids, and an id that disappears and comes back orphans a memoised result
 * (`applyPatch` §1.1). Retiring it is also what keeps the ladder honest: an
 * abandoned node is not in the gate set, so the tier's verdict is the re-run's
 * and not a `fail` from before the repair existed.
 *
 * **The tier is the deterministic one, and the patch says nothing about the
 * rest.** An adversarial gate is a tier above; if the re-run goes green the
 * ladder opens it by itself, and if it does not, the review was never bought.
 *
 * This module decides nothing about whether the change applies: like every
 * other proposal, it is a `PlanPatch` for the policy engine to rule on and
 * `commitPatchedPlan` to validate. Pure — no clock, no database, no filesystem.
 *
 * Verifies: EPIC-12-S29 (re-run half) · AC5
 */
import {
  type GateId,
  type LadderGate,
  type NodeId,
  NodeIdSchema,
  type PlanEdge,
  type PlanGraph,
  type PlanNode,
  type PlanPatch,
  PlanPatchSchema,
  type ProposedBy,
  toSingleLine,
} from '@DeFlow/core';
import { gatesAfterRepair } from './repair.ts';

/** `NodeIdSchema`'s own ceiling, so a minted id is refused here rather than
 * three layers down inside `applyPatch`. */
const NODE_ID_MAX = 63;

/**
 * The id a gate node's `round`-th run carries: `<node>-r<round>`.
 *
 * The round is *in* the id rather than in a field beside it for the reason the
 * finding id is in the fix node's: an operator reading `gate-typecheck-r2` in a
 * worktree name, a branch name or a timeline knows which pass they are looking
 * at without opening the plan.
 *
 * A gate node id long enough to overflow the charset is truncated on the left
 * rather than rejected: the suffix is the part that distinguishes two rounds of
 * the same node, and dropping it to keep a prefix would mint the same id twice.
 */
export function rerunGateNodeId(node: NodeId, round: number): NodeId {
  const suffix = `-r${String(round)}`;
  const head = node.slice(0, Math.max(1, NODE_ID_MAX - suffix.length));
  return NodeIdSchema.parse(`${head}${suffix}`);
}

export interface RerunGatesInput {
  /** The plan version the ops are derived against. */
  readonly base: PlanGraph;
  /** The fix nodes whose completion the re-run must follow. */
  readonly after: readonly NodeId[];
  readonly proposedBy: ProposedBy;
  /** Distance from `PlanGraph` v1, for the policy engine's replan-depth rule. */
  readonly replanDepth: number;
  /** 2 for a gate node's first re-run, 3 for the next. */
  readonly round: number;
  /**
   * What the fix node's branch showed, rendered into the patch's `reason`.
   *
   * The ordering check (./repair-ordering.ts) is the only evidence that the
   * three steps happened in order, and the plan scrubber renders `reason`
   * verbatim (F10.2) — so putting the two commit shas here is what makes AC4's
   * demonstration readable from the plan history rather than only from a
   * branch somebody still has.
   */
  readonly detail?: string;
}

/** The gate nodes of a graph, as the ladder sees them. */
function laddersOf(graph: PlanGraph): readonly LadderGate[] {
  const gates: LadderGate[] = [];
  for (const node of graph.nodes) {
    if (node.type !== 'gate' || node.lifecycle !== 'active') continue;
    gates.push({
      node: node.id,
      // An adversarial gate has no definition file to be identified by, so it
      // is its own node — the same substitution `decide()` makes.
      gate: node.gate.kind === 'deterministic' ? node.gate.gateId : (node.id as unknown as GateId),
      kind: node.gate.kind,
    });
  }
  return gates;
}

/**
 * AC5 — the patch that re-runs the deterministic tier after `after` completes,
 * or `null` when the plan has no deterministic gate to re-run.
 *
 * `null` rather than an empty patch: a patch with no ops is a plan version with
 * no change in it, and committing one would put a row in the plan history that
 * an operator cannot be told the meaning of.
 */
export function rerunGatePatch(input: RerunGatesInput): PlanPatch | null {
  const byId = new Map<NodeId, PlanNode>(input.base.nodes.map((node) => [node.id, node]));
  const targets = gatesAfterRepair(laddersOf(input.base)).filter(
    (gate) => gate.kind === 'deterministic',
  );

  const nodes: PlanNode[] = [];
  const edges: PlanEdge[] = [];
  const retired: NodeId[] = [];

  for (const target of targets) {
    const answered = byId.get(target.node);
    if (answered === undefined || answered.type !== 'gate') continue;
    const id = rerunGateNodeId(answered.id, input.round);
    nodes.push({ ...answered, id, deps: [...input.after], lifecycle: 'active' });
    for (const fix of input.after) edges.push({ from: fix, to: id, kind: 'control' });
    retired.push(answered.id);
  }

  if (nodes.length === 0) return null;

  const reason = toSingleLine(
    `${input.after.join(', ')} landed: the gate set re-runs from the deterministic tier ` +
      `(${targets.map((gate) => gate.gate).join(', ')}), not from the gate that failed` +
      (input.detail === undefined ? '' : ` — ${input.detail}`),
  );

  return PlanPatchSchema.parse({
    schemaId: 'DeFlow.planpatch.v1',
    id: `rerun-${input.after.join('-')}-r${String(input.round)}`,
    proposedBy: input.proposedBy,
    reason,
    ops: [
      { op: 'insert-nodes', nodes, edges },
      ...retired.map((root) => ({
        op: 'abandon-branch' as const,
        root,
        reason: toSingleLine(
          `answered before ${input.after.join(', ')} landed, so its verdict is about a tree ` +
            'nobody has: the re-run above replaces it',
        ),
      })),
    ],
    policy: {
      // A deterministic gate spends nothing (KAR-12.1's `costUsd: 0`), so this
      // is a measurement rather than an optimistic estimate.
      estimatedCostDeltaUsd: 0,
      estimatedWallClockDeltaMs: 0,
      blastRadius: { paths: [], nodeCount: nodes.length },
      replanDepth: input.replanDepth,
      // The re-run is the same node's contract at a later commit: it asks for
      // nothing the plan had not already granted, and saying otherwise would
      // route a gate through the approval queue for running twice.
      escalatesPermission: null,
      addsWriteCapability: false,
    },
  });
}
