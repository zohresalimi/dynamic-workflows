/**
 * KAR-11.6 AC7 — what changed between two plan versions, as node sets plus
 * field-level patches (docs/06-planning-and-replanning.md §4.4, §5).
 *
 * 06 §4.4 is emphatic that *"the scheduler does not silently swap providers"*:
 * a quota reroute goes through the policy engine and produces a `plan.patched`
 * event *"so the swap appears in the visualisation — which is the entire point
 * of F3.9's wording."* Appearing in the visualisation is this module's job. A
 * reroute that produced a new plan version nobody could see the shape of would
 * satisfy the letter of AC2 and none of AC7.
 *
 * Three decisions:
 *
 *   1. **Identity is `NodeId` and nothing else.** Diffing by object equality
 *      would report a provider swap as `removed: ['implement']` plus
 *      `added: ['implement']`, which loses the one fact the operator wants —
 *      that it is the *same step*, running somewhere else. It is also what
 *      EPIC-17's plan-evolution scrubber is budgeted against: a node that
 *      keeps its id across versions animates as a move, and one that does not
 *      animates as a death and a birth.
 *   2. **`rfc6902`, never `fast-json-patch`.** The catalog pin says so and
 *      02 §4 says why — `fast-json-patch` last shipped in 2022. The patch
 *      array is RFC 6902 because that is what KAR-11.5 AC3 hands the client
 *      and what the inspector renders field by field.
 *   3. **Graph-level fields are not node state.** `version`, `planHash`,
 *      `parent` and `createdAt` differ between *any* two real versions, so
 *      folding them into the comparison would report every node as changed on
 *      every replan. The diff is computed over the node and edge documents
 *      only; the version pair travels beside it as `from`/`to`.
 *
 * Pure: no I/O, no clock, no ledger. The endpoint that serves this over HTTP,
 * the `unionLayoutKey` and the `reason`/`decision` join are KAR-11.5's.
 *
 * Verifies: EPIC-11-S31 · AC7
 */
import type { NodeId, PlanEdge, PlanGraph, PlanNode } from '@DeFlow/core';
import { createPatch, type Operation } from 'rfc6902';

/** A node present in both versions whose document moved, with the RFC 6902
 * operations that take the `from` node to the `to` node. */
export interface ChangedPlanNode {
  readonly id: NodeId;
  readonly patch: readonly Operation[];
}

export interface PlanNodesDiff {
  /** Ids present only in `to`, in `to`'s node order. */
  readonly added: readonly NodeId[];
  /** Ids present only in `from`, in `from`'s node order. */
  readonly removed: readonly NodeId[];
  /** Ids present in both whose documents differ, in `to`'s node order. */
  readonly changed: readonly ChangedPlanNode[];
  /** Ids present in both whose documents are identical, in `to`'s node order. */
  readonly unchanged: readonly NodeId[];
}

export interface PlanEdgesDiff {
  readonly added: readonly PlanEdge[];
  readonly removed: readonly PlanEdge[];
}

export interface PlanGraphDiff {
  /** `from.version` — the diff describes a version *pair*, and a caller that
   * had to re-derive it from the graphs would be free to get it backwards. */
  readonly from: number;
  readonly to: number;
  readonly nodes: PlanNodesDiff;
  readonly edges: PlanEdgesDiff;
}

/**
 * An edge has no id, so its identity is its whole document. The key is built
 * field by field rather than by `JSON.stringify(edge)` so that two edges that
 * differ only in key insertion order — one composed by the compiler, one by a
 * patch reducer — are still the same edge.
 */
function edgeKey(edge: PlanEdge): string {
  return JSON.stringify([edge.from, edge.to, edge.kind, edge.carries ?? null]);
}

/** Multiset difference: `left` minus `right`, keeping duplicates that `right`
 * does not account for and preserving `left`'s order. */
function edgesMissingFrom(left: readonly PlanEdge[], right: readonly PlanEdge[]): PlanEdge[] {
  const remaining = new Map<string, number>();
  for (const edge of right) {
    const key = edgeKey(edge);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const missing: PlanEdge[] = [];
  for (const edge of left) {
    const key = edgeKey(edge);
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    else missing.push(edge);
  }
  return missing;
}

/**
 * The node- and edge-level difference between two versions of one run's plan.
 *
 * `from` and `to` are ordinary plan documents; nothing here assumes they are
 * adjacent versions, so `v1 → v4` is as meaningful as `v3 → v4`.
 */
export function diffPlanGraphs(from: PlanGraph, to: PlanGraph): PlanGraphDiff {
  const before = new Map<NodeId, PlanNode>(from.nodes.map((node) => [node.id, node]));
  const after = new Map<NodeId, PlanNode>(to.nodes.map((node) => [node.id, node]));

  const added: NodeId[] = [];
  const changed: ChangedPlanNode[] = [];
  const unchanged: NodeId[] = [];

  for (const node of to.nodes) {
    const previous = before.get(node.id);
    if (previous === undefined) {
      added.push(node.id);
      continue;
    }
    const patch = createPatch(previous, node);
    if (patch.length === 0) unchanged.push(node.id);
    else changed.push({ id: node.id, patch });
  }

  const removed = from.nodes.filter((node) => !after.has(node.id)).map((node) => node.id);

  return {
    from: from.version,
    to: to.version,
    nodes: { added, removed, changed, unchanged },
    edges: {
      added: edgesMissingFrom(to.edges, from.edges),
      removed: edgesMissingFrom(from.edges, to.edges),
    },
  };
}
