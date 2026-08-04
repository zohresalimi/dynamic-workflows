/**
 * KAR-02.3 — `readsAreSatisfiable`: every declared read must be produced by
 * an ancestor, or by the pinned spec.
 *
 * docs/04-domain-model.md §3.1 calls this "pure reachability over the DAG,
 * roughly 60 lines, and the cheapest correctness gate in the system" — it
 * runs before a single token is spent, and it catches the planner error that
 * is otherwise invisible until an agent is already running with a context
 * packet that is missing the one fact it was told to use.
 *
 * The sibling case is the one that matters. A parallel node writing a fact
 * you read is a **race**, not a dependency: nothing orders it before you, so
 * "it is in the graph somewhere" is not the same claim as "it will have
 * happened by the time you run". Only ancestors count.
 *
 * This is deliberately *not* the full plan validator: cycles, gate coverage
 * and criterion traceability are KAR-11.2. It therefore has to terminate on a
 * graph that has a cycle rather than assume one cannot reach it.
 *
 * Verifies: EPIC-02-S11 · AC6
 */
import type { NodeId } from './ids.ts';
import type { PlanGraph, PlanNode } from './plan-graph.ts';

/** One declared read that no ancestor produces. `read` is the fact key as the
 * node declared it, prefix form included, so the message can quote it back. */
export interface UnsatisfiedRead {
  readonly node: NodeId;
  readonly read: string;
}

/** `finding/*` matches `finding/auth-uses-jwt`; an exact key matches itself.
 * The wildcard is a trailing prefix marker, not a glob — there is no
 * `finding/*\/auth` form, because a fact key namespace is flat by design. */
function matches(readKey: string, writeKey: string): boolean {
  return readKey.endsWith('*') ? writeKey.startsWith(readKey.slice(0, -1)) : writeKey === readKey;
}

/**
 * Every node that must have finished before `nodeId` can start: the
 * transitive closure of `deps`, widened by the graph's own edges so that a
 * plan whose edges say more than its `deps` do is not silently under-checked.
 * (A plan where the two disagree is the full validator's to reject.)
 */
function ancestorsOf(
  start: NodeId,
  predecessors: ReadonlyMap<string, readonly NodeId[]>,
): Set<string> {
  const seen = new Set<string>();
  const queue = [...(predecessors.get(start) ?? [])];
  // A visited set rather than recursion: this runs on unvalidated planner
  // output, and a cycle here must return a result, not blow the stack.
  while (queue.length > 0) {
    const current = queue.pop();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    queue.push(...(predecessors.get(current) ?? []));
  }
  return seen;
}

function predecessorMap(graph: PlanGraph): Map<string, NodeId[]> {
  const predecessors = new Map<string, NodeId[]>();
  const add = (to: string, from: NodeId): void => {
    const existing = predecessors.get(to);
    if (existing === undefined) predecessors.set(to, [from]);
    else if (!existing.includes(from)) existing.push(from);
  };
  for (const node of graph.nodes) for (const dep of node.deps) add(node.id, dep);
  for (const edge of graph.edges) add(edge.to, edge.from);
  return predecessors;
}

/** The fact keys a set of nodes declares writing. */
function writtenKeys(nodes: readonly PlanNode[]): string[] {
  return nodes.flatMap((node) => node.writes.map((write) => write.key));
}

/**
 * Returns one entry per declared read that no ancestor satisfies — `[]` for a
 * sound graph.
 *
 * Only `kind: 'fact'` reads are checked. A `spec` read is always satisfiable
 * because F1.5 pins the spec into every packet regardless of position in the
 * graph, and an `artifact` read names a content-addressed handle that exists
 * independently of the plan (no `WriteDecl` can produce one), so neither can
 * be dangling in the sense this walk is looking for.
 */
export function readsAreSatisfiable(graph: PlanGraph): UnsatisfiedRead[] {
  const byId = new Map(graph.nodes.map((node) => [node.id as string, node]));
  const predecessors = predecessorMap(graph);
  const violations: UnsatisfiedRead[] = [];

  for (const node of graph.nodes) {
    const factReads = node.reads.filter((read) => read.kind === 'fact');
    if (factReads.length === 0) continue;

    // A node's own writes do not count: it cannot read what it has not run
    // far enough to produce.
    const ancestors = [...ancestorsOf(node.id, predecessors)]
      .map((id) => byId.get(id))
      .filter(
        (ancestor): ancestor is PlanNode => ancestor !== undefined && ancestor.id !== node.id,
      );
    const available = writtenKeys(ancestors);

    for (const read of factReads) {
      if (!available.some((key) => matches(read.key, key))) {
        violations.push({ node: node.id, read: read.key });
      }
    }
  }

  return violations;
}
