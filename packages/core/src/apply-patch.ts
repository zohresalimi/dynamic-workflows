/**
 * KAR-11.3 — turning a `PlanPatch` into the *next* `PlanGraph`
 * (docs/06-planning-and-replanning.md §4.2, docs/04-domain-model.md §1.1, §3).
 *
 * One function, and everything about it is downstream of a single sentence in
 * 06 §4.2: **plans are never mutated.** So this is not an "applier" in the
 * mutate-in-place sense — it is a *function from a document to the next
 * document*, and the base it was given comes back untouched. What lands in the
 * `plan` table is the return value; what was already there stays byte-identical,
 * which is what makes the plan-evolution scrubber (F10.2) show what actually
 * ran rather than a reconstruction of it.
 *
 * Three properties are load-bearing and each fails differently:
 *
 *   1. **Whole or not at all.** The structural check runs over the *whole*
 *      patch first, and a single bad op means no op is applied. 06 §3.5: *"a
 *      failing patch is rejected outright — never partially applied"*. A
 *      per-op loop that applied what it could would leave a graph nobody
 *      proposed, addressed by a hash nobody can explain.
 *   2. **Structural ops retire; they never delete.** `split-node` marks its
 *      source `superseded` and `abandon-branch` marks its root and everything
 *      downstream `abandoned`. Both stay in the document. §1.1's reason is the
 *      effect journal — `(runId, nodeId, attempt, ordinal)` is an idempotency
 *      key, and an id that disappears and comes back orphans a memoised result
 *      so the side effect runs twice, undetectably. The scrubber's reason is
 *      the other half: a node that vanishes renders as a delete, and *"a
 *      renamed node renders as a delete plus an insert, which is exactly the
 *      wrong story to tell about a plan that was merely edited"*.
 *   3. **The successor re-addresses itself.** `planHash` is recomputed over the
 *      new document, `parent` points at the base's hash and `version` is the
 *      base's plus one. The `plan` table's primary key *is* the content
 *      address, so a successor still carrying its parent's hash would silently
 *      collide with the row it was derived from.
 *
 * What is deliberately not here: the policy engine (KAR-11.4 / `patch-policy.ts`
 * — nothing in this file reads `patch.policy`), plan validation (KAR-11.2 —
 * reachability, cycles and capability checks run over the *result* of this
 * function, before it is committed), the `basePlanHash` staleness check and the
 * transaction (@DeFlow/ledger). This module is arithmetic on a document.
 *
 * Verifies: EPIC-11-S13 (third scenario), EPIC-11-S17 · AC2, AC7
 */
import { planHash } from './hash.ts';
import { type NodeId, NodeIdSchema } from './ids.ts';
import type { PlanEdge, PlanGraph, PlanNode } from './plan-graph.ts';
import {
  type PatchError,
  type PlanPatch,
  type ProposedBy,
  patchIsWellFormed,
} from './plan-patch.ts';

export interface ApplyPatchOptions {
  /**
   * The successor's `createdAt`, ISO-8601, from the injected `Clock`.
   *
   * An argument rather than a `new Date()` because it is hashed into the
   * document: a plan version whose address depends on ambient wall-clock time
   * is a plan version no test can pin and no replay can reproduce.
   */
  readonly createdAt: string;
}

export type ApplyPatchResult =
  | { readonly ok: true; readonly graph: PlanGraph }
  | { readonly ok: false; readonly errors: readonly PatchError[] };

/**
 * `PlanGraph.createdBy` admits `'planner' | 'human' | NodeId`; a patch may also
 * be proposed by `'scheduler'` (F3.9's quota reroute). The literal satisfies
 * the `NodeId` charset, so the value survives the round trip unchanged and the
 * scrubber can still answer *who changed the plan* — which is the whole reason
 * `'scheduler'` is a first-class proposer rather than a silent swap.
 */
function createdByOf(proposedBy: ProposedBy): PlanGraph['createdBy'] {
  return proposedBy === 'scheduler' ? NodeIdSchema.parse('scheduler') : proposedBy;
}

/**
 * `from -> [to, …]`, `deps` widened by the graph's own `edges` — the same
 * ancestry relation ./topo-sort.ts and ./validate-declared-reads.ts compute,
 * read the other way round. The three must agree about what a descendant is,
 * or a branch abandoned here stays schedulable there.
 */
function successorsOf(
  nodes: readonly PlanNode[],
  edges: readonly PlanEdge[],
): Map<string, NodeId[]> {
  const successors = new Map<string, NodeId[]>();
  const add = (from: string, to: NodeId): void => {
    const existing = successors.get(from);
    if (existing === undefined) successors.set(from, [to]);
    else if (!existing.includes(to)) existing.push(to);
  };
  for (const node of nodes) {
    for (const dep of node.deps) add(dep, node.id);
  }
  for (const edge of edges) add(edge.from, edge.to);
  return successors;
}

/** `root` and everything reachable from it. `abandon-branch` cascades by
 * construction: 04 §4 puts the *root* in the op and says the descendants
 * follow when the patch is applied, which is here. */
function branchOf(
  root: NodeId,
  nodes: readonly PlanNode[],
  edges: readonly PlanEdge[],
): Set<string> {
  const successors = successorsOf(nodes, edges);
  const reached = new Set<string>([root]);
  const pending: NodeId[] = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const next of successors.get(current) ?? []) {
      if (reached.has(next)) continue;
      reached.add(next);
      pending.push(next);
    }
  }
  return reached;
}

/**
 * Applies `patch` to `base` and returns the next plan version.
 *
 * Refuses — with every structural error rather than the first, because the
 * proposer has to re-derive and wants the whole list on one round trip — when
 * any op names a node that is not there, would move an id, reuses a retired
 * one, or targets a node of the wrong type.
 */
export async function applyPatch(
  base: PlanGraph,
  patch: PlanPatch,
  options: ApplyPatchOptions,
): Promise<ApplyPatchResult> {
  const wellFormed = patchIsWellFormed(patch, base);
  if (!wellFormed.ok) return { ok: false, errors: wellFormed.errors };

  // A deep copy up front: every mutation below is against nodes this function
  // owns, so the caller's document — which may already be a row in the
  // content-addressed table — cannot be reached from here at all.
  const nodes: PlanNode[] = structuredClone(base.nodes as PlanNode[]);
  const edges: PlanEdge[] = structuredClone(base.edges as PlanEdge[]);
  const byId = new Map<string, PlanNode>(nodes.map((node) => [node.id, node]));

  const append = (fresh: readonly PlanNode[]): void => {
    for (const node of structuredClone(fresh as PlanNode[])) {
      nodes.push(node);
      byId.set(node.id, node);
    }
  };

  for (const op of patch.ops) {
    switch (op.op) {
      case 'insert-nodes': {
        append(op.nodes);
        edges.push(...structuredClone(op.edges as PlanEdge[]));
        break;
      }
      case 'split-node': {
        const source = byId.get(op.node);
        // `patchIsWellFormed` proved it is here and active; the guard is for
        // the type, not for the case.
        if (source !== undefined) source.lifecycle = 'superseded';
        append(op.into);
        edges.push(...structuredClone(op.edges as PlanEdge[]));
        break;
      }
      case 'replace-provider': {
        const node = byId.get(op.node);
        // `patchIsWellFormed` already refused a non-agent target; the narrowing
        // is what lets `provider` be reached at all.
        if (node?.type === 'agent') {
          // `prefer` is *replaced*, not prepended: a reroute away from a
          // provider that is rate-limited or cannot honour the node's
          // requirements must not leave that provider as a fallback the
          // scheduler will try again the moment the first choice hesitates.
          node.provider = { ...node.provider, prefer: [op.provider] };
          if (op.model !== undefined) node.model = op.model;
        }
        break;
      }
      case 'extend-loop': {
        const node = byId.get(op.node);
        if (node?.type === 'loop') node.maxRounds = op.maxRounds;
        break;
      }
      case 'abandon-branch': {
        for (const id of branchOf(op.root, nodes, edges)) {
          const node = byId.get(id);
          // An already-superseded node keeps its own retirement: an id retires
          // once, and overwriting `superseded` with `abandoned` would lose the
          // reason the split happened.
          if (node !== undefined && node.lifecycle === 'active') node.lifecycle = 'abandoned';
        }
        break;
      }
    }
  }

  const draft = {
    ...base,
    version: base.version + 1,
    parent: base.planHash,
    createdBy: createdByOf(patch.proposedBy),
    createdAt: options.createdAt,
    nodes,
    edges,
  };

  return {
    ok: true,
    graph: {
      ...draft,
      planHash: await planHash(draft as unknown as Record<string, unknown>),
    },
  };
}
