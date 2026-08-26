/**
 * KAR-28.5 — the phases projection: what shape this run has, and where it is.
 *
 * The blueprint's run screen carries a **PHASES** panel — `Scope 1/1`,
 * `Search 6/6`, `Verify 31/75` — and KAR-26.5's frame audit marked the whole
 * band *"out of scope: facts the daemon does not have"*. This file is that
 * fact. KAR-28.6 draws it, and the two are separate stories precisely so the
 * projection cannot be invented inside a component.
 *
 * **What a phase is** is the load-bearing question, and it is answered in
 * [ADR 0018](../../../docs/adr/0018-a-phase-is-a-top-level-step-of-the-executing-plan.md)
 * rather than here, because the word arrived from a picture rather than from the
 * domain — and `node.progress.phase` already exists in the ledger meaning
 * something else entirely (one agent's inner state during one attempt, in
 * whatever vocabulary its vendor uses). The short form, which
 * [04 §3.3](../../../docs/04-domain-model.md) states as the mechanism:
 *
 * > A phase is a **top-level step of the executing plan** — a node no other node
 * > of that plan contains — and its work items are the nodes the plan
 * > materialises from it.
 *
 * Three rules follow from that and they are what the tests are mostly about:
 *
 *   1. **`total` is a count of node ids that exist**, never a width something
 *      might turn out to have. A `map` whose `over` collection has not been read
 *      reports the one template node the graph holds, not the fan-out it is
 *      hoping for. There is no estimate here to be wrong.
 *   2. **The `body` template drops out once children exist.** It stays in the
 *      graph and never runs (see the `stress-400` fixture, which says so in a
 *      comment), so counting it beside its 400 children would report `401`.
 *   3. **A run with no adopted plan has no phases**, and says so. It is not
 *      given the stages of its own lifecycle as a consolation shape — those are
 *      events, not work with a denominator, and a progress bar made out of a
 *      boolean is the kind of invention this whole epic exists to refuse.
 *
 * No clock is read, nothing is sorted by when it happened, and every input is
 * `RunState` — which is a fold of the ledger, so the answer after a `kill -9` is
 * the answer before it without anybody arranging for that.
 *
 * Verifies: EPIC-28-S20, EPIC-28-S21, EPIC-28-S22 · KAR-28.5 AC1, AC2, AC3
 */
import type { NodeId } from './ids.ts';
import type { NodeType, PlanGraph, PlanNode } from './plan-graph.ts';
import type { NodeStatus, RunState } from './run-state.ts';
import { topoSort } from './topo-sort.ts';

/**
 * A phase's state, folded from its work items and from nothing else.
 *
 * `cancelled` is its own member rather than folded into `failed` for the reason
 * `NODE_STATUSES` gives at length: *"a run's own history has to be able to say
 * 'the operator stopped this' rather than 'the agent broke'"*, and a band that
 * painted the two the same colour would undo that at the one place an operator
 * looks.
 */
export const PHASE_STATES = ['pending', 'running', 'complete', 'failed', 'cancelled'] as const;

export type PhaseState = (typeof PHASE_STATES)[number];

/** The node statuses that mean the scheduler still has this item in hand. */
const LIVE_STATUSES: readonly NodeStatus[] = [
  'scheduled',
  'running',
  'awaiting-retry',
  'suspended',
  'blocked',
];

/** One top-level step of the plan, with the work recorded inside it. */
export interface RunPhase {
  /** The plan node this phase *is*. Not a synthesised label. */
  readonly id: NodeId;
  /** The node's own `title`, verbatim — the plan's words, never composed. */
  readonly title: string;
  readonly type: NodeType;
  readonly state: PhaseState;
  /** Work items whose folded status is `completed`. */
  readonly completed: number;
  /** Work items the plan contains **right now**. Never a projected width. */
  readonly total: number;
  /**
   * The work items themselves, in plan order.
   *
   * Carried rather than left for the band to re-derive, because KAR-28.6 has to
   * show *"the work happening in the selected phase"* and a second derivation of
   * membership in a component is a second answer that can disagree with the
   * counts beside it.
   */
  readonly nodes: readonly NodeId[];
}

/**
 * Why the answer has the shape it has.
 *
 * `'no-plan'` is not an error and not an empty success — it is the honest
 * report of a run that has been submitted, or is still being framed, and has
 * therefore not adopted a graph anything could have phases of.
 */
export type PhasesBasis = 'plan' | 'no-plan';

export interface RunPhases {
  readonly basis: PhasesBasis;
  readonly phases: readonly RunPhase[];
}

const NO_PLAN: RunPhases = { basis: 'no-plan', phases: [] };

/**
 * `<parent>--<itemId>` — the id form KAR-02.1 fixed for `map` and `loop`
 * children, and the only containment signal the plan document carries.
 *
 * A convention rather than a foreign key, which ADR 0018 records as the cost of
 * deriving this at all: a future producer that mints child ids some other way
 * would quietly promote 400 children to 400 phases, and
 * `packages/core/test/run-phases-corpus.test.ts` is the check that would notice.
 */
function isChildOf(parent: NodeId, candidate: NodeId): boolean {
  return candidate !== parent && candidate.startsWith(`${parent}--`);
}

/** Every id an inline subgraph holds, at any depth — containers included. */
function inlineIds(nodes: readonly PlanNode[]): NodeId[] {
  const ids: NodeId[] = [];
  for (const node of nodes) {
    ids.push(node.id);
    if (node.type === 'subgraph' && node.graph.kind === 'inline') {
      ids.push(...inlineIds(node.graph.nodes));
    }
  }
  return ids;
}

/**
 * The active leaves of an inline subgraph — the things that actually run.
 *
 * A nested subgraph contributes its own leaves rather than itself, so a phase's
 * `total` counts work and not containers. An empty nested subgraph falls back to
 * itself, because a container with nothing in it is the only node there is.
 */
function inlineLeaves(nodes: readonly PlanNode[]): NodeId[] {
  const ids: NodeId[] = [];
  for (const node of nodes) {
    if (node.lifecycle !== 'active') continue;
    if (node.type === 'subgraph' && node.graph.kind === 'inline') {
      const nested = inlineLeaves(node.graph.nodes);
      if (nested.length > 0) {
        ids.push(...nested);
        continue;
      }
    }
    ids.push(node.id);
  }
  return ids;
}

/** The ids `node` contains, whether or not they are work items of it. */
function contains(
  node: PlanNode,
  active: readonly PlanNode[],
  present: ReadonlySet<string>,
): NodeId[] {
  if (node.type === 'subgraph') {
    return node.graph.kind === 'inline' ? inlineIds(node.graph.nodes) : [];
  }
  if (node.type !== 'map' && node.type !== 'loop') return [];
  const ids = active.filter((other) => isChildOf(node.id, other.id)).map((other) => other.id);
  if (node.body !== node.id && present.has(node.body)) ids.push(node.body);
  return ids;
}

/**
 * The work items of `node`: its materialised children, else its `body`
 * template, else itself.
 *
 * The three-step fallback is rule 1 and rule 2 of the module note in one place —
 * the template is what the children were cut from, so it counts only while there
 * are no children to count instead.
 */
function workItems(
  node: PlanNode,
  active: readonly PlanNode[],
  byId: ReadonlyMap<string, PlanNode>,
): readonly NodeId[] {
  if (node.type === 'subgraph' && node.graph.kind === 'inline') {
    const leaves = inlineLeaves(node.graph.nodes);
    if (leaves.length > 0) return leaves;
  }
  if (node.type === 'map' || node.type === 'loop') {
    const children = active
      .filter((other) => isChildOf(node.id, other.id))
      .map((other) => other.id);
    if (children.length > 0) return children;
    const body = byId.get(node.body);
    if (body !== undefined && body.id !== node.id && body.lifecycle === 'active') return [body.id];
  }
  return [node.id];
}

/**
 * What a phase's work items add up to: its state, and how many are done.
 *
 * Exported because KAR-28.6's band folds it a second time. The band gets the
 * *membership* of each phase from this projection over the wire — containment is
 * a property of the plan document (`body` templates, inline subgraphs) that the
 * tab's flat plan projection cannot see — but it cannot get the **counts** that
 * way, because a refetch per node event is exactly the per-frame request that
 * screen's design forbids. So it folds the same items' statuses off the stream,
 * through this function, in the tick they arrive.
 *
 * That is one rule with two callers rather than two rules: a band that counted
 * `completed` its own way would eventually read `3/7` beside a row list showing
 * four passed nodes, and nothing would say which of them was wrong.
 */
export interface PhaseFold {
  readonly state: PhaseState;
  readonly completed: number;
  readonly total: number;
}

export function foldPhaseItems(statuses: readonly (NodeStatus | undefined)[]): PhaseFold {
  return {
    state: phaseState(statuses),
    completed: statuses.filter((status) => status === 'completed').length,
    total: statuses.length,
  };
}

/**
 * A phase's state from its items' statuses, by a fixed precedence.
 *
 * The last two arms are the ones worth reading. A phase with completed work and
 * nothing live is **running**, not complete — a paused run, or one waiting on a
 * gate elsewhere, has not finished this phase — and a phase nothing has touched
 * is **pending** rather than anything more confident.
 */
function phaseState(statuses: readonly (NodeStatus | undefined)[]): PhaseState {
  if (statuses.some((status) => status !== undefined && LIVE_STATUSES.includes(status))) {
    return 'running';
  }
  if (statuses.every((status) => status === 'completed')) return 'complete';
  if (statuses.some((status) => status === 'failed')) return 'failed';
  if (statuses.some((status) => status === 'cancelled')) return 'cancelled';
  if (statuses.some((status) => status === 'completed')) return 'running';
  return 'pending';
}

/**
 * The plan's node ids in dependency order, falling back to the document's own
 * order for a graph that cannot be sorted.
 *
 * A cycle cannot reach `RunState.plan` through a validating daemon —
 * `validatePlan` refuses it before `plan.proposed` is ever accepted — so this is
 * defence against an older ledger, and the choice is deliberate: a run summary
 * that throws because a three-year-old graph has a cycle serves nothing, while
 * an honestly-ordered-by-document list still answers every question the band
 * asks.
 */
function planOrder(plan: PlanGraph): readonly NodeId[] {
  try {
    return topoSort(plan);
  } catch {
    return plan.nodes.map((node) => node.id);
  }
}

/**
 * This run's phases, folded from the plan it adopted and the node events the
 * ledger recorded against it.
 *
 * A pure function of `RunState` and of nothing else — no clock, no database, no
 * second walk of the log — which is the whole of AC3: it is a fold, so a daemon
 * that died between two reads cannot make them disagree.
 */
export function runPhases(state: RunState): RunPhases {
  const plan = state.plan;
  if (plan === null) return NO_PLAN;

  const active = plan.nodes.filter((node) => node.lifecycle === 'active');
  const byId = new Map<string, PlanNode>(plan.nodes.map((node) => [node.id, node]));
  const present = new Set<string>(active.map((node) => node.id));

  const contained = new Set<string>();
  for (const node of active) {
    for (const id of contains(node, active, present)) contained.add(id);
  }

  const topLevel = new Map<string, PlanNode>(
    active.filter((node) => !contained.has(node.id)).map((node) => [node.id, node]),
  );

  const phases: RunPhase[] = [];
  for (const id of planOrder(plan)) {
    const node = topLevel.get(id);
    if (node === undefined) continue;
    const nodes = workItems(node, active, byId);
    const statuses = nodes.map((item) => state.nodes[item]?.status);
    phases.push({
      id: node.id,
      title: node.title,
      type: node.type,
      ...foldPhaseItems(statuses),
      nodes,
    });
  }

  return { basis: 'plan', phases };
}
