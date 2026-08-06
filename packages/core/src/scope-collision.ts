/**
 * KAR-07.6 AC7 — `scopeCollisions`: the one thing declared path scopes still
 * refuse at plan time (docs/09-workspace-and-safety.md §6.3, §7.3).
 *
 * Decision D14 makes `git merge-tree --write-tree` ground truth for conflict
 * and demotes F5.3's declared scopes to a *prediction*. The reason is
 * measured, not stylistic: most declared overlaps never actually conflict —
 * two agents editing different functions in one file merge fine — so
 * serializing every node whose scopes overlap throws away real parallelism to
 * avoid a conflict that mostly does not happen. The run-time probe catches the
 * ones that do, within milliseconds of the commit that caused them.
 *
 * What survives is the case no probe can rescue and no scheduler should have
 * to discover: two nodes that can run at the same time, each declaring the
 * *same single file* as its entire write scope. Every edit either makes will
 * be to that file, so a conflict is not a risk, it is the plan. That is worth
 * refusing before a token is spent.
 *
 * Two qualifiers, both load-bearing:
 *
 * - **Concurrent only.** A node and its own successor may perfectly reasonably
 *   both be scoped to one file — write it, then fix it — and a check that
 *   fired on them would reject correct plans. Only nodes where neither is an
 *   ancestor of the other are compared, which is the same "a sibling is a
 *   race, an ancestor is an ordering" reading `readsAreSatisfiable` uses.
 * - **Write nodes only.** `pathScopes.write` on a `read`-permission node is a
 *   declaration nothing can act on; the permission ladder (F5.4) is what stops
 *   it writing, and this is not a second, weaker copy of that rule.
 *
 * Like `readsAreSatisfiable`, this is a pure function returning findings; the
 * plan validator that turns them into a rejection is KAR-11.2's.
 *
 * Verifies: EPIC-07-S25 (scenarios 1, 3) · AC7
 */
import type { NodeId } from './ids.ts';
import type { PlanGraph, PlanNode } from './plan-graph.ts';

/** Two concurrent write nodes whose entire declared scope is the same file. */
export interface ScopeCollision {
  /** Both node ids, in the order they appear in the plan. */
  readonly nodes: readonly [NodeId, NodeId];
  /** The single path both of them claim. */
  readonly path: string;
}

/**
 * A glob names a set whose membership nobody here can decide, and two sets
 * that overlap are exactly the case D14 hands to `merge-tree`. `src/**` on
 * both sides is therefore not a collision — it is the *normal* shape of two
 * parallel write nodes.
 */
const GLOB = /[*?[\]{}]/;

/** The node's whole write scope, when that scope is exactly one concrete file. */
function soleWritePath(node: PlanNode): string | null {
  if (node.permission === 'read') return null;
  const [path, ...rest] = node.pathScopes.write;
  if (path === undefined || rest.length > 0) return null;
  return GLOB.test(path) || path.endsWith('/') ? null : path;
}

/**
 * `deps` plus the graph's own edges, so a plan whose edges say more than its
 * `deps` do is not silently under-checked. (A plan where the two disagree is
 * the full validator's to reject.)
 */
function predecessorsOf(graph: PlanGraph): Map<string, NodeId[]> {
  const predecessors = new Map<string, NodeId[]>();
  const add = (to: string, from: NodeId): void => {
    predecessors.set(to, [...(predecessors.get(to) ?? []), from]);
  };
  for (const node of graph.nodes) for (const dep of node.deps) add(node.id, dep);
  for (const edge of graph.edges) add(edge.to, edge.from);
  return predecessors;
}

/**
 * Everything that must have finished before `start` can run. A visited set
 * rather than recursion: this runs on unvalidated planner output, and a cycle
 * has to return an answer rather than blow the stack.
 */
function ancestorsOf(
  start: NodeId,
  predecessors: ReadonlyMap<string, readonly NodeId[]>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [...(predecessors.get(start) ?? [])];
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    queue.push(...(predecessors.get(current) ?? []));
  }
  return seen;
}

/**
 * Every pair of concurrent write nodes whose entire declared write scope is
 * the same single path, in plan order. Empty is the answer for every other
 * shape of overlap, including two nodes both scoped to `src/**` — that is the
 * probe's business, not the planner's (AC7).
 */
export function scopeCollisions(graph: PlanGraph): ScopeCollision[] {
  const candidates = graph.nodes
    .map((node) => ({ id: node.id, path: soleWritePath(node) }))
    .filter((candidate): candidate is { id: NodeId; path: string } => candidate.path !== null);
  if (candidates.length < 2) return [];

  const predecessors = predecessorsOf(graph);
  const ancestors = new Map(
    candidates.map((candidate) => [candidate.id, ancestorsOf(candidate.id, predecessors)]),
  );

  const collisions: ScopeCollision[] = [];
  for (const [index, left] of candidates.entries()) {
    for (const right of candidates.slice(index + 1)) {
      if (left.path !== right.path) continue;
      if (ancestors.get(right.id)?.has(left.id) === true) continue;
      if (ancestors.get(left.id)?.has(right.id) === true) continue;
      collisions.push({ nodes: [left.id, right.id], path: left.path });
    }
  }
  return collisions;
}
