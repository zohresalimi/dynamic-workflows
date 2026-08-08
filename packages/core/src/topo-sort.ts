/**
 * KAR-11.2 — the plan's topological order, and its only cycle detector
 * (docs/06-planning-and-replanning.md §3.1).
 *
 * §3.1 walks the DAG in topological order to check reachability and then says
 * the cycle check comes free: *"`topoSort` throwing is the check."* That is a
 * design constraint, not a shortcut. Two implementations — one in the validator
 * and one in the scheduler — is how a graph comes to be acyclic for the thing
 * that admits it and cyclic for the thing that runs it, and the run that
 * discovers the disagreement discovers it at node 27.
 *
 * Ancestry is `deps` widened by the graph's own `edges`, exactly as
 * ./validate-declared-reads.ts computes it: a `data` edge's `carries` label is
 * a rendering concern (F10.1), but any edge — `control` or `data` — is an
 * ordering constraint. The two modules must agree about what an ancestor is, or
 * the reachability check and the order it walks in are about different graphs.
 *
 * **Ties break on the node id**, so the order is a property of the document
 * rather than of the order the planner happened to emit its nodes in. A plan
 * that hashes the same must sort the same, or a snapshot of the walk is noise
 * and a scheduler restart reorders work that did not change.
 *
 * Verifies: EPIC-11-S7 (first scenario) · AC3
 */
import type { NodeId } from './ids.ts';
import type { PlanGraph } from './plan-graph.ts';

/**
 * Thrown by `topoSort` for a graph that is not a DAG, carrying the nodes on
 * one cycle in the order they close it.
 *
 * The nodes are a field and not only a sentence, because KAR-11.2's diagnostic
 * has to name them in `PlanDiagnostic.node` and F10.1 has to highlight them in
 * the graph — neither can parse them back out of prose.
 */
export class PlanCycleError extends Error {
  /** One cycle, in walk order. `['a', 'b', 'c']` closes `c -> a`. */
  readonly cycle: readonly NodeId[];

  constructor(cycle: readonly NodeId[]) {
    super(
      `the plan graph is not a DAG: ${[...cycle, cycle[0]].join(' -> ')}. ` +
        'A cyclic plan has no schedulable first node, so it is refused before anything runs.',
    );
    this.name = 'PlanCycleError';
    this.cycle = cycle;
  }
}

/** `to -> [from, …]`: every node that must finish before `to` may start. */
function predecessorsOf(graph: PlanGraph): Map<string, NodeId[]> {
  const predecessors = new Map<string, NodeId[]>();
  const add = (to: string, from: NodeId): void => {
    const existing = predecessors.get(to);
    if (existing === undefined) predecessors.set(to, [from]);
    else if (!existing.includes(from)) existing.push(from);
  };
  for (const node of graph.nodes) {
    predecessors.set(node.id, predecessors.get(node.id) ?? []);
    for (const dep of node.deps) add(node.id, dep);
  }
  for (const edge of graph.edges) add(edge.to, edge.from);
  return predecessors;
}

/**
 * One cycle inside `remaining`, found by walking successors until a node
 * repeats and then dropping the tail that led into it.
 *
 * `remaining` is what Kahn's algorithm could not emit, which is exactly the
 * union of every cycle and everything downstream of one. Walking from the
 * lowest remaining id makes the answer deterministic; trimming at the first
 * repeat is what keeps an acyclic tail hanging off a cycle out of the report,
 * so the diagnostic names the nodes the operator has to break rather than every
 * node the break stalled.
 */
function findCycle(
  remaining: readonly NodeId[],
  successors: ReadonlyMap<string, readonly NodeId[]>,
): readonly NodeId[] {
  const inPlay = new Set<string>(remaining);
  const start = [...remaining].toSorted()[0];
  if (start === undefined) return [];

  const path: NodeId[] = [];
  const seen = new Map<string, number>();
  let current: NodeId | undefined = start;

  while (current !== undefined && !seen.has(current)) {
    seen.set(current, path.length);
    path.push(current);
    current = (successors.get(current) ?? []).filter((next) => inPlay.has(next)).toSorted()[0];
  }

  if (current === undefined) return path;
  return path.slice(seen.get(current) ?? 0);
}

/**
 * Keeps the ready set sorted by inserting in place, rather than re-sorting it
 * after every push.
 *
 * The difference is the whole of AC12's fan-out. A `map` over 400 items makes
 * 400 nodes ready at the same instant, and re-sorting a growing array on each
 * one is O(n² log n) — measured at a 2.5x cost for a 2x graph, which is the
 * super-linear shape the 400-node budget exists to keep out. A binary insert is
 * O(log n) comparisons and one memmove, and the order it produces is identical.
 */
function insertSorted(sorted: NodeId[], value: NodeId): void {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((sorted[mid] as string) < (value as string)) low = mid + 1;
    else high = mid;
  }
  sorted.splice(low, 0, value);
}

/**
 * Every node id in an order where each node follows all of its ancestors.
 *
 * Kahn's algorithm over an id-sorted ready set. Throws `PlanCycleError` when
 * the graph is not a DAG — and that throw is the *only* cycle check DeFlow
 * performs, which is what AC3 means by "not a second implementation".
 *
 * A `deps` entry naming a node the graph does not contain is not this
 * function's fault to report: it contributes no ordering constraint here and is
 * caught as an unreachable read or a dangling edge by the checks that own it.
 */
export function topoSort(graph: PlanGraph): readonly NodeId[] {
  const present = new Set(graph.nodes.map((node) => node.id));
  const predecessors = predecessorsOf(graph);
  const successors = new Map<string, NodeId[]>();
  const indegree = new Map<string, number>();

  for (const node of graph.nodes) {
    const upstream = (predecessors.get(node.id) ?? []).filter((dep) => present.has(dep));
    indegree.set(node.id, upstream.length);
    for (const dep of upstream) {
      const existing = successors.get(dep);
      if (existing === undefined) successors.set(dep, [node.id]);
      else existing.push(node.id);
    }
  }

  const ready = graph.nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id)
    .toSorted();
  const order: NodeId[] = [];

  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) break;
    order.push(next);
    for (const dependant of successors.get(next) ?? []) {
      const left = (indegree.get(dependant) ?? 0) - 1;
      indegree.set(dependant, left);
      if (left === 0) insertSorted(ready, dependant);
    }
  }

  if (order.length !== graph.nodes.length) {
    const emitted = new Set<string>(order);
    const remaining = graph.nodes.map((node) => node.id).filter((id) => !emitted.has(id));
    throw new PlanCycleError(findCycle(remaining, successors));
  }

  return order;
}
