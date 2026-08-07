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
 * ## Why this file is thirty lines and not ninety
 *
 * docs/08-context-and-memory.md §2.1 describes the *same* gate — F6.2, the
 * same walk, the same ancestor rule, the same pinned spec — under the name
 * `validateDeclaredReads`, and KAR-09.1 shipped it. For a while this module
 * carried its own copy of the walk, and the two had already drifted: the copy
 * here treated only the *read* side as a possible `finding/*` prefix, so an
 * ancestor declaring the write `finding/*` (which a recon node that cannot
 * know its findings' names up front is entitled to declare) was reported as
 * an undeclared read by `readsAreSatisfiable` and accepted by
 * `validateDeclaredReads`. Whichever one KAR-11.2 happened to wire into the
 * `plan.proposed` / `plan.patched` path would have decided that plan's fate.
 *
 * So there is exactly one implementation — `./validate-declared-reads.ts` —
 * and this is its KAR-02.3-shaped view: the same verdict, in the
 * `{ node, read }` pairs EPIC-02-S11 and 04-domain-model §3.1 name. Both
 * names stay exported because both epics' acceptance criteria use their own,
 * and both are already public API. Nothing here may grow a second opinion
 * about matching, ancestry or pinning; `reads-satisfiable.test.ts` has a
 * corpus that fails the moment it does.
 *
 * This is deliberately *not* the full plan validator: cycles, gate coverage
 * and criterion traceability are KAR-11.2. It therefore has to terminate on a
 * graph that has a cycle rather than assume one cannot reach it.
 *
 * Verifies: EPIC-02-S11 · AC6
 */
import type { NodeId } from './ids.ts';
import type { PlanGraph } from './plan-graph.ts';
import { validateDeclaredReads } from './validate-declared-reads.ts';

/** One declared read that no ancestor produces. `read` is the fact key as the
 * node declared it, prefix form included, so the message can quote it back —
 * or, for a `spec` read, the canonical `spec:<section>` key. */
export interface UnsatisfiedRead {
  readonly node: NodeId;
  readonly read: string;
}

/**
 * Returns one entry per declared read that no ancestor satisfies — `[]` for a
 * sound graph — ordered by `(node, read)`, so the result is stable regardless
 * of the order `graph.nodes` happens to list them in.
 *
 * Only reads that name something a `WriteDecl` could have produced are
 * reported. A `spec` read is always satisfiable because F1.5 pins the spec
 * into every packet regardless of position in the graph, and an `artifact`
 * read names a content-addressed handle that exists independently of the plan
 * (no `WriteDecl` can produce one), so neither can be dangling in the sense
 * this walk is looking for.
 */
export function readsAreSatisfiable(graph: PlanGraph): UnsatisfiedRead[] {
  return validateDeclaredReads(graph).map((error) => ({ node: error.node, read: error.key }));
}
