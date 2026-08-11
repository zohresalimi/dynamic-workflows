/**
 * KAR-17.2 — the union graph, and the join that attaches the daemon's diff to
 * it (docs/12-frontend-architecture.md §6.2).
 *
 * Verifies: EPIC-17-S6, EPIC-17-S7 · AC3, AC4, AC9
 *
 * ## What this module is, and the much bigger thing it is not
 *
 * It is **not a diff**. `GET /api/runs/:id/plans/diff` is the answer to "what
 * changed between two plan versions": `diffPlanGraphs` in `@DeFlow/daemon`
 * computes it, the endpoint serves it, and `../views/PlanEvolutionView.vue`
 * renders that document rather than one of its own — a rule EPIC-15-S47 asserts
 * directly, because two implementations of a diff is two answers to the one
 * question this view exists to answer.
 *
 * What is here is the other half, which the server deliberately does not do
 * (KAR-11.5 AC4: *"`unionLayoutKey` is a cache key, never coordinates — the
 * server computes no x/y"*):
 *
 * 1. **The union graph.** Every node and every edge appearing in *either*
 *    version, in one list, so the pair can be laid out **once** and both
 *    versions rendered at those coordinates. This is the load-bearing mechanism
 *    of the whole view: *"its entire value is that a human can see what changed,
 *    so any layout that reflows between versions destroys it"*. On a 40-node
 *    replan the reflow is larger than the eye can track and the operator ends up
 *    diffing by hand, which is the thing the view exists to remove.
 * 2. **The join.** The endpoint's four id lists and two edge lists, keyed onto
 *    the union so every node and edge carries exactly one of `added`,
 *    `removed`, `changed`, `unchanged`.
 *
 * ## Two identities, and neither is a position
 *
 * **Nodes are `nodeId`.** Assigned by the planner, stable across every
 * `PlanPatch`, asserted by the daemon, and **never** derived from position or
 * label — if ids were ever reused or renumbered, this view and the memory graph
 * would produce silently wrong output rather than failing. Nothing below indexes
 * into an array to decide what a node *is*.
 *
 * **Union edges are `` `${source}->${target}` ``**, which is coarser than the
 * daemon's edge identity on purpose. `diffPlanGraphs` keys an edge on its whole
 * document — `from`, `to`, `kind`, `carries` — because a control edge that
 * became a data edge really is a different edge to an operator. The *layout*
 * cannot use that: two edges between the same pair of boxes draw on top of each
 * other, measure as two and say nothing. So the union collapses a pair to one
 * edge and the class is joined onto it; the endpoint's finer answer is what
 * decides which class that is.
 *
 * ## Why the removed node is still here
 *
 * A node that vanishes between two frames is indistinguishable from a node that
 * moved off screen. Keeping it in the union — laid out with everything else, and
 * rendered in place at reduced opacity — is what makes a removal legible, and is
 * the reason the union is *both* versions rather than the newer one.
 */
import type { NodeStatus } from '@DeFlow/core';
import type { PlanEdgeVM, PlanNodeVM } from '../ledger/vm.ts';
import type { JsonPatchOperation } from './plan-patch.ts';

/** One of the four classes AC4's encoding matrix distinguishes. */
export type DiffClass = 'added' | 'removed' | 'changed' | 'unchanged';

/**
 * A node of one plan *version*, as this view renders it.
 *
 * `PlanNodeVM` plus `derivedFrom`, which is what makes AC9's split legible: two
 * nodes that came out of one carry the id they came from, and without it a
 * split is indistinguishable from "one node removed and two unrelated ones
 * added". It is on the plan document already (`PlanNode.derivedFrom`); the live
 * graph's projection has no use for it and correctly does not carry it.
 */
export interface PlanVersionNodeVM extends PlanNodeVM {
  readonly derivedFrom: readonly string[];
}

/** One version's graph, mapped out of the plan document the snapshot carried. */
export interface PlanVersionGraph {
  readonly nodes: readonly PlanVersionNodeVM[];
  readonly edges: readonly PlanEdgeVM[];
}

export interface UnionGraph extends PlanVersionGraph {
  /** The `unionLayoutKey` the diff endpoint returned for this pair (AC6). */
  readonly key: string;
}

/** The plan document as it arrives on `RunState.plan`; only the read fields. */
export interface PlanGraphShape {
  readonly nodes: readonly PlanNodeShape[];
  readonly edges: readonly PlanEdgeShape[];
}

export interface PlanNodeShape {
  readonly id: string;
  readonly title?: string | undefined;
  readonly type?: string | undefined;
  readonly lifecycle?: string | undefined;
  readonly permission?: string | undefined;
  readonly model?: string | undefined;
  readonly provider?: { readonly prefer?: readonly string[] | undefined } | undefined;
  readonly derivedFrom?: readonly string[] | undefined;
}

export interface PlanEdgeShape {
  readonly from: string;
  readonly to: string;
  readonly kind?: string | undefined;
  readonly carries?: readonly string[] | undefined;
}

/** The diff document, exactly as `GET /api/runs/:id/plans/diff` returns it. */
export interface PlanDiffDocument {
  readonly from: number;
  readonly to: number;
  readonly nodes: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly changed: readonly {
      readonly id: string;
      readonly patch: readonly JsonPatchOperation[];
    }[];
    readonly unchanged: readonly string[];
  };
  readonly edges: {
    readonly added: readonly PlanEdgeShape[];
    readonly removed: readonly PlanEdgeShape[];
  };
  readonly unionLayoutKey?: string | undefined;
  readonly reason: string | null;
  readonly decision: string | null;
}

/**
 * The union graph's edge identity — see the module note for why it is coarser
 * than the daemon's.
 */
export const unionEdgeId = (from: string, to: string): string => `${from}->${to}`;

/**
 * One plan version's document, in the view-model vocabulary.
 *
 * A **mapping**, not a fold: it takes the whole immutable document a snapshot
 * carried and reads fields off it, so it has no `seq` guard, no held proposals
 * and no idempotency question. `../ledger/projections/plan.ts` is the fold, and
 * it is the right thing for a *live* run; a scrub position is a document that is
 * never going to change again.
 *
 * The status is `scheduled` — which renders as `pending` — for every node,
 * deliberately. A plan version is a statement about the *shape of the work*, and
 * painting a historical version with the run states it later reached would put
 * two unrelated encodings on one drawing: this view's four-way diff class, and
 * the seven-state run palette. AC4's encoding is the one this view is for.
 */
export function planGraphVMs(graph: PlanGraphShape | null | undefined): PlanVersionGraph {
  if (graph === null || graph === undefined) return { nodes: [], edges: [] };

  const seen = new Set<string>();
  const nodes: PlanVersionNodeVM[] = [];
  for (const node of graph.nodes) {
    // A document with a duplicate id is a daemon bug, not something to render
    // twice: two boxes with one id lay out on top of each other and the second
    // silently wins every lookup below.
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    nodes.push(toVersionNode(node));
  }

  const edges: PlanEdgeVM[] = [];
  const edgeSeen = new Set<string>();
  for (const edge of graph.edges) {
    const id = unionEdgeId(edge.from, edge.to);
    if (edgeSeen.has(id)) continue;
    edgeSeen.add(id);
    edges.push(toVersionEdge(id, edge));
  }

  return { nodes, edges };
}

/**
 * Every node and edge in either version, in one graph.
 *
 * Order is `before`'s, then whatever `after` adds, and it is not incidental:
 * ELK's `considerModelOrder` reads the order it is handed (`../components/graph/layout.ts`),
 * so a union assembled from a `Map`'s iteration or from a sort would be stable
 * by luck. It is also why this takes two arrays rather than two `Map`s.
 *
 * A node in both versions is taken from `after`: the newer document is what the
 * operator is stepping *to*, and a changed node should read with its new
 * provider and its new permission while the patch panel says what moved.
 */
export function unionGraphOf(
  before: PlanVersionGraph,
  after: PlanVersionGraph,
  key: string,
): UnionGraph {
  const newer = new Map(after.nodes.map((node) => [node.id, node]));
  const nodes: PlanVersionNodeVM[] = [];
  const placed = new Set<string>();

  for (const node of before.nodes) {
    nodes.push(newer.get(node.id) ?? node);
    placed.add(node.id);
  }
  for (const node of after.nodes) {
    if (placed.has(node.id)) continue;
    nodes.push(node);
    placed.add(node.id);
  }

  const edges: PlanEdgeVM[] = [];
  const edgePlaced = new Set<string>();
  for (const edge of [...before.edges, ...after.edges]) {
    if (edgePlaced.has(edge.id)) continue;
    edgePlaced.add(edge.id);
    edges.push(edge);
  }

  return { nodes, edges, key };
}

/**
 * `nodeId` → its class, straight off the endpoint's four lists.
 *
 * Nothing here compares two documents. A node that appears in none of the four
 * lists gets no entry at all, and the renderer treats that as `unchanged` —
 * which is the honest reading of a diff that did not mention it, and better than
 * inventing a fifth class for "the endpoint and the snapshot disagree".
 */
export function nodeClassesOf(document: PlanDiffDocument): ReadonlyMap<string, DiffClass> {
  const classes = new Map<string, DiffClass>();
  for (const id of document.nodes.unchanged) classes.set(id, 'unchanged');
  for (const id of document.nodes.added) classes.set(id, 'added');
  for (const id of document.nodes.removed) classes.set(id, 'removed');
  for (const node of document.nodes.changed) classes.set(node.id, 'changed');
  return classes;
}

/**
 * Union edge id → its class.
 *
 * The endpoint reports edges as documents rather than ids, and reports a
 * `kind` change as a removal plus an addition (its identity is the whole
 * document). Collapsed onto the union's coarser identity, that pair lands on one
 * edge twice — and `changed` is the right answer for it, because from the
 * drawing's point of view the edge between those two boxes is still there and is
 * no longer the same edge.
 */
export function edgeClassesOf(
  document: PlanDiffDocument,
  union: UnionGraph,
): ReadonlyMap<string, DiffClass> {
  const classes = new Map<string, DiffClass>();
  for (const edge of union.edges) classes.set(edge.id, 'unchanged');

  const added = new Set(document.edges.added.map((edge) => unionEdgeId(edge.from, edge.to)));
  const removed = new Set(document.edges.removed.map((edge) => unionEdgeId(edge.from, edge.to)));

  for (const id of added) classes.set(id, added.has(id) && removed.has(id) ? 'changed' : 'added');
  for (const id of removed) {
    if (!added.has(id)) classes.set(id, 'removed');
  }
  return classes;
}

/**
 * The RFC 6902 operations behind a changed node, or `null` when it did not
 * change.
 *
 * `null` rather than `[]`: an empty array reads as *"it changed, and the change
 * was nothing"*, which is exactly the wrong thing to open a "why did this
 * change" panel on.
 */
export function patchOfChangedNode(
  document: PlanDiffDocument,
  nodeId: string,
): readonly JsonPatchOperation[] | null {
  return document.nodes.changed.find((node) => node.id === nodeId)?.patch ?? null;
}

function toVersionNode(node: PlanNodeShape): PlanVersionNodeVM {
  return {
    id: node.id,
    title: node.title ?? node.id,
    type: node.type ?? null,
    lifecycle: (node.lifecycle ?? 'active') as PlanNodeVM['lifecycle'],
    status: 'scheduled' as NodeStatus,
    state: node.lifecycle === 'abandoned' ? 'abandoned' : 'pending',
    provider: node.provider?.prefer?.[0] ?? null,
    model: node.model ?? null,
    permission: node.permission ?? null,
    // `pathScopes` is deliberately not carried. A plan node has them, and the
    // *inspector* is where they belong (KAR-17.3); this view's node body shows
    // type, provider, permission and `derivedFrom`, and a field nothing renders
    // is a field that goes stale without anybody noticing.
    derivedFrom: [...(node.derivedFrom ?? [])],
    worktree: null,
    binary: null,
    attempt: 0,
    phase: null,
    progressMessage: null,
    failure: null,
    suspendedUntil: null,
    blocked: null,
    retry: null,
    unschedulable: null,
  };
}

function toVersionEdge(id: string, edge: PlanEdgeShape): PlanEdgeVM {
  return {
    id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind === 'data' ? 'data' : 'control',
    carries: [...(edge.carries ?? [])],
  };
}
