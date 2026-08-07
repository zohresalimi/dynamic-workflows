/**
 * KAR-09.1 — `validateDeclaredReads`: every node's declared `reads` must be
 * satisfiable from an ancestor's declared `writes`, or from the pinned spec,
 * before a run starts (docs/08-context-and-memory.md §2.1).
 *
 * §2.1 prints this "in full" as a sketch and calls it *"the cheapest
 * correctness gate in the system"* — pure DAG reachability, no clock, no I/O,
 * no mutation of `g`. It lives here, in `@DeFlow/core`, because repo-layout
 * R1 makes this the one package in the workspace that is pure *structurally*
 * rather than by convention (see `test/purity.test.ts`, which scans every
 * production source under `packages/core/src` for exactly the banned reads
 * this module must never contain).
 *
 * This is the **only** implementation of the F6.2 read-reachability gate in
 * the workspace. 04-domain-model.md §3.1 describes the same rule under
 * EPIC-02's name for it, `readsAreSatisfiable`; that function
 * (./reads-satisfiable.ts) is a mapping of this one's result into KAR-02.3's
 * `{ node, read }` shape, and must stay that way. The two shipped as separate
 * walks for one commit and had already disagreed about a `finding/*` on the
 * *write* side — see that module's note.
 *
 * `validateDeclaredReads` is deliberately the only thing this module does.
 * EPIC-11's own prerequisite note says it plainly: *"`@DeFlow/core`, so
 * `KAR-11.2` wires it in rather than reimplementing reachability."* Wiring
 * this into the real `plan.proposed` and `plan.patch.proposed ->
 * plan.patched` / `plan.patch.rejected` decision path — the ledger, the
 * policy engine, the actual `applyOps` — is KAR-11.2/11.3/11.4's job, not
 * this one's. What this module guarantees, so that wiring cannot drift into
 * two implementations, is a single function with a single error code that
 * behaves identically whether the graph it is handed represents a freshly
 * proposed plan or a plan with a patch already merged into it — see the
 * "AC6" suite in the test file for the direct demonstration.
 *
 * Verifies: EPIC-09-S1, EPIC-09-S2, EPIC-09-S3, EPIC-09-S4, EPIC-09-S5 ·
 * AC1, AC2, AC3, AC4, AC5, AC6, AC7
 */
import type { NodeId } from './ids.ts';
import type { PlanGraph, ReadDecl } from './plan-graph.ts';

/**
 * AC3. The four pinned `TaskSpec` sections, canonicalised as `spec:<section>`
 * — always satisfy a `{ kind: 'spec', section }` read, with no ancestor
 * required, even for a root node with none. (The node's own path scopes are
 * also part of the pinned set the packet builder assembles from, KAR-09.2 /
 * KAR-09.3 — but `ReadDecl` has no `pathscope` kind, so there is nothing of
 * that shape for this validator to check.)
 */
export const PINNED_KEYS: ReadonlySet<string> = new Set([
  'spec:goal',
  'spec:criteria',
  'spec:constraints',
  'spec:nonGoals',
]);

/** AC6. One error code, so the `plan.proposed` and `plan.patched` call sites
 * — wherever they end up living — cannot disagree on what a rejection is. */
export interface UndeclaredReadError {
  readonly code: 'undeclared-read';
  readonly node: NodeId;
  readonly key: string;
}

function isPrefixGlob(key: string): boolean {
  return key.endsWith('/*');
}

/** Keeps the trailing `/`, drops only the `*` — the separator is what keeps
 * `finding/auth` from satisfying `finding/authz` below. */
function globPrefix(key: string): string {
  return key.slice(0, -1);
}

/** A `/`-anchored prefix match, checked in whichever direction carries the
 * glob: a written `finding/*` satisfies a read of `finding/auth-uses-jwt`,
 * and a read of `finding/*` is satisfied by a write of
 * `finding/auth-uses-jwt` — but a plain `finding/auth` never satisfies
 * `finding/authz`, because neither side carries a `*` for the match to
 * anchor on. */
function keyMatches(requested: string, available: string): boolean {
  if (requested === available) return true;
  if (isPrefixGlob(requested) && available.startsWith(globPrefix(requested))) return true;
  if (isPrefixGlob(available) && requested.startsWith(globPrefix(available))) return true;
  return false;
}

/**
 * AC4. Exact keys, `<namespace>/*` prefix globs (including the `ext:`
 * namespace, which is just another `/`-separated prefix) and the pinned spec
 * keys, in that order of precedence. `reachable` is normally an ancestor's
 * accumulated `writes`, but the function itself does not know or care where
 * the set came from — that is what makes it reusable from `satisfies()`'s own
 * table test as much as from `validateDeclaredReads`.
 */
export function satisfies(reachable: Iterable<string>, requested: string): boolean {
  if (PINNED_KEYS.has(requested)) return true;
  for (const available of reachable) {
    if (keyMatches(requested, available)) return true;
  }
  return false;
}

/**
 * Every node id that must have finished before `nodeId` can start: the
 * transitive closure of `deps`, widened by the graph's own edges (a `data`
 * edge's `carries` label is a rendering concern, F10.1 — any edge, `control`
 * or `data`, establishes ancestry here). Iterative and visited-set based, not
 * recursive: this runs on unvalidated planner output, so a cyclic graph must
 * still return a result rather than overflow the stack (cycle rejection
 * itself is KAR-11.2's).
 *
 * `start` is never in the result, even when a cycle walks back round to it. A
 * node cannot read what it has not run far enough to produce, and a cyclic
 * graph is precisely where that rule must not quietly switch itself off.
 */
function ancestorsOf(
  start: NodeId,
  predecessors: ReadonlyMap<string, readonly NodeId[]>,
): Set<NodeId> {
  const seen = new Set<NodeId>();
  const queue: NodeId[] = [...(predecessors.get(start) ?? [])];
  let cursor = 0;
  while (cursor < queue.length) {
    const current = queue[cursor];
    cursor += 1;
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    for (const next of predecessors.get(current) ?? []) queue.push(next);
  }
  seen.delete(start);
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

/** The canonical key a declared read asks `satisfies()` to resolve, or
 * `null` for a kind this validator does not walk ancestry for: an `artifact`
 * read names a content-addressed handle that exists independently of the
 * plan, so no `WriteDecl` can produce — or fail to produce — one. */
function readKey(read: ReadDecl): string | null {
  switch (read.kind) {
    case 'fact':
      return read.key;
    case 'spec':
      return `spec:${read.section}`;
    case 'artifact':
      return null;
    default:
      return null;
  }
}

/**
 * AC1, AC2, AC5, AC7. Pure: no clock, no I/O, no mutation of `g`. Returns one
 * `UndeclaredReadError` per declared read that no ancestor's `writes` and no
 * pinned key satisfies — **every** violation, not the first — sorted by
 * `(node, key)` so a snapshot of the result is stable regardless of the
 * order `g.nodes` happens to list them in.
 *
 * The ancestor set is computed exactly once per node, before that node's own
 * reads are checked against it — never once per read. Recomputing it per read
 * is invisible at ten nodes and turns the O(V+E) walk this is supposed to be
 * into an O(V·E) one at the 400-node fan-out AC7 measures against.
 */
export function validateDeclaredReads(g: PlanGraph): UndeclaredReadError[] {
  const errors: UndeclaredReadError[] = [];
  const writesByNode = new Map<string, string[]>(
    g.nodes.map((node) => [node.id, node.writes.map((write) => write.key)]),
  );
  const predecessors = predecessorMap(g);

  for (const node of g.nodes) {
    if (node.reads.length === 0) continue;

    const reachable = new Set<string>();
    for (const ancestor of ancestorsOf(node.id, predecessors)) {
      for (const key of writesByNode.get(ancestor) ?? []) reachable.add(key);
    }

    for (const read of node.reads) {
      const key = readKey(read);
      if (key === null) continue;
      if (!satisfies(reachable, key)) {
        errors.push({ code: 'undeclared-read', node: node.id, key });
      }
    }
  }

  return errors.toSorted((a, b) => a.node.localeCompare(b.node) || a.key.localeCompare(b.key));
}
