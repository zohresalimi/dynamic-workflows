/**
 * KAR-17.9 — `memory-graph.ts`: the blackboard, aggregated **before** it is
 * rendered (F10.4, F6.3).
 *
 * Verifies: EPIC-17-S33 · AC1, AC2, AC4
 *
 * > *"Solve it in product before you solve it in rendering"*
 * > ([12 §6.4](../../../../../docs/12-frontend-architecture.md)).
 *
 * The memory graph is the one surface in this frontend whose node count is
 * **unbounded**: plan nodes stay in the dozens for the life of a run, while
 * facts accumulate for as long as the run does. A view that drew one dot per
 * fact would be a nine-hour run's worth of dots, and the question an operator
 * actually arrives with — *"which node produced the wrong assumption?"* — would
 * be harder to answer than before they opened it.
 *
 * So the default view is one bubble per **producing node**, with a count, and
 * facts are drawn only for a producer the operator expanded, one bounded page
 * at a time. That is the whole design, and it lives here rather than in the
 * component for the reason the epic's Definition of Done states plainly:
 * nothing outside `ledger/projections/` contains reduction logic. A component
 * that grouped three thousand facts would do it again on every render, in a
 * place no projection spec can reach.
 *
 * ## What this module is, and is not
 *
 * It is a **pure selector over an already-folded `BlackboardProjection`**, not
 * an eighth projection: it folds no events and has no `apply`. `./index.ts`'s
 * seven-module registry is untouched, and `blackboard.ts` remains the only
 * thing that reads `fact.*` envelopes.
 *
 * ## Taint is read, never inferred
 *
 * `fact.invalidated` carries its own `taints[]` — the daemon's list of readers
 * whose `fact.read` sits at a `seq` earlier than the invalidation. This module
 * reports that list as given, from `BlackboardProjection.taints`. Recomputing
 * it from the consumer edges the graph happens to be holding would produce a
 * *different* answer — it would mark a node that read the fact after it was
 * invalidated, and it would miss a node whose read this tab never saw — and an
 * answer that depends on when you opened the page is not an answer.
 */
import type { BlackboardProjection, FactVM } from './blackboard.ts';
import { applyPlan, edgeId, emptyPlan, type PlanEdgeVM, type PlanNodeVM } from './plan.ts';

/** How many of a producer's facts one expanded page holds. */
export const MEMORY_PAGE_SIZE = 50;

/**
 * How many fact nodes may be drawn at once, however many producers are open.
 *
 * The number is the measurement's, not taste's: KAR-16.6 measured this renderer
 * at 404 nodes inside two frames at the 95th percentile
 * (`docs/measurements/vue-flow-400.md`), and a graph of producer bubbles plus
 * this many facts stays comfortably underneath it. Thirty open producers at a
 * full page each would be 1,500 — the size at which
 * [12 §6.4](../../../../../docs/12-frontend-architecture.md) says to stop
 * paginating and swap the renderer, which is a different decision than this
 * one.
 */
export const MEMORY_EXPANDED_CAP = 200;

/**
 * How many fact keys an aggregate edge names before it stops listing them.
 *
 * F10.1's *"edges labelled with what flows"* applied to an edge that may stand
 * for hundreds of facts: the first few keys are what makes the edge legible,
 * and the rest is a wall of text over a line two hundred pixels long. The count
 * is on the node.
 */
export const MEMORY_EDGE_CARRIES = 8;

export type MemoryNodeKind = 'producer' | 'fact';

/** Which slice of an expanded producer's facts is on screen. */
export interface MemoryPageVM {
  /** Zero-based. */
  readonly page: number;
  readonly pages: number;
  /** One-based, inclusive, for *"51–100 of 900"*. */
  readonly from: number;
  readonly to: number;
  readonly total: number;
  readonly size: number;
}

export interface MemoryFacts {
  readonly kind: MemoryNodeKind;
  /** The plan node this bubble stands for, or `null` on a fact node. */
  readonly node: string | null;
  /** The bare title, without the count the accessible name carries. */
  readonly label: string;
  /** Facts written: the producer's count, or `1` for a fact node. */
  readonly factCount: number;
  /** How many of those were later invalidated. */
  readonly invalidCount: number;
  /** Distinct nodes that read them. */
  readonly consumerCount: number;
  readonly factId: string | null;
  readonly factKey: string | null;
  /** This fact — or, on a bubble, any of this node's facts — was invalidated. */
  readonly invalid: boolean;
  /** This node consumed something that later proved wrong (`taints[]`). */
  readonly tainted: boolean;
  /** The facts that tainted it, exactly as `fact.invalidated` named them. */
  readonly taints: readonly string[];
  readonly expanded: boolean;
  /** Which page of this producer's facts is drawn, when it is expanded. */
  readonly page: MemoryPageVM | null;
}

/**
 * A node of the memory graph.
 *
 * A `PlanNodeVM` **plus** `memory`, for the same reason KAR-17.2's
 * `PlanVersionNodeVM` is: `GraphCanvas` takes `PlanNodeVM[]`, and a second
 * graph surface that needed its own canvas prop would be a second renderer to
 * swap. The plan half is the real projection's node where the plan has
 * described one, so a bubble carries the node's own state and title rather than
 * a memory-graph invention of them.
 */
export interface MemoryNodeVM extends PlanNodeVM {
  readonly memory: MemoryFacts;
}

export interface MemoryGraphOptions {
  /** Producers whose facts are drawn individually. */
  readonly expanded?: ReadonlySet<string>;
  /** Which page of each expanded producer's facts to draw. Zero-based. */
  readonly pages?: ReadonlyMap<string, number>;
  readonly pageSize?: number;
  /** The ceiling on drawn fact nodes. Defaults to `MEMORY_EXPANDED_CAP`. */
  readonly cap?: number;
  /** The plan's nodes, for the title and display state of each bubble. */
  readonly plan?: ReadonlyMap<string, PlanNodeVM>;
}

export interface MemoryGraphVM {
  readonly nodes: readonly MemoryNodeVM[];
  readonly edges: readonly PlanEdgeVM[];
  /** Facts on the blackboard. */
  readonly facts: number;
  /** Facts drawn as nodes of their own. Zero in the default view, at any size. */
  readonly drawnFacts: number;
  /** An expansion the cap cut short, so the view can say so rather than lie. */
  readonly truncated: boolean;
}

/** A bubble's graph id. Namespaced, so a node id can never collide with a fact id. */
export const producerNodeId = (node: string): string => `node:${node}`;
/** A fact node's graph id. */
export const factNodeId = (factId: string): string => `fact:${factId}`;

/**
 * A `PlanNodeVM` for a node the plan projection has not described.
 *
 * Minted **through `applyPlan`** rather than written out as a literal, and that
 * is deliberate: `PlanNodeVM` grows a field every time a story needs one, and a
 * hand-written blank here would be a second definition of "an untouched node"
 * that compiles until the day it does not. Asking the projection for one costs
 * an object per undescribed node — bounded by the plan, not by the facts — and
 * cannot drift.
 *
 * The envelope is cast because it is not one: it is the smallest input that
 * makes the projection mint a node, and it never reaches a ledger.
 */
function blankNode(id: string): PlanNodeVM {
  const state = emptyPlan();
  applyPlan(state, {
    seq: 1,
    kind: 'node.scheduled',
    payload: { node: id, provider: 'deflow', permission: 'read' },
  } as never);
  const minted = state.nodes.get(id);
  if (minted === undefined) throw new Error(`the plan projection minted no node for ${id}`);
  return minted;
}

/** Every distinct node that read one of `facts`, in first-read order. */
function consumersOf(facts: readonly FactVM[]): string[] {
  const seen: string[] = [];
  for (const fact of facts) {
    for (const consumer of fact.consumers) {
      if (!seen.includes(consumer.node)) seen.push(consumer.node);
    }
  }
  return seen;
}

/** The page of `ids` the operator asked for, clamped to what exists. */
function pageOf(ids: readonly string[], wanted: number, size: number): MemoryPageVM {
  const pages = Math.max(1, Math.ceil(ids.length / size));
  const page = Math.min(Math.max(0, wanted), pages - 1);
  const from = page * size;
  return {
    page,
    pages,
    from: ids.length === 0 ? 0 : from + 1,
    to: Math.min(from + size, ids.length),
    total: ids.length,
    size,
  };
}

/**
 * The graph, aggregated by producing node.
 *
 * Node order is the **ledger's**: producers and readers in the order their
 * first fact was written, then the drawn facts. `./plan.ts`'s layout depends on
 * that order being stable across a re-render, and the blackboard's `Map`s are
 * already in it.
 */
export function memoryGraph(
  state: BlackboardProjection,
  options: MemoryGraphOptions = {},
): MemoryGraphVM {
  const size = options.pageSize ?? MEMORY_PAGE_SIZE;
  const cap = options.cap ?? MEMORY_EXPANDED_CAP;
  const expanded = options.expanded ?? new Set<string>();
  const facts = [...state.facts.values()];

  // ── who is on the graph, in ledger order ───────────────────────────────────
  const participants: string[] = [];
  const join = (node: string): void => {
    if (!participants.includes(node)) participants.push(node);
  };
  for (const fact of facts) {
    join(fact.provenance.byNode);
    for (const consumer of fact.consumers) join(consumer.node);
  }
  // A node the ledger only ever named in a `taints[]` is still a node that
  // consumed something wrong, and leaving it off would hide exactly the thing
  // AC4 asks the view to highlight.
  for (const node of state.taints.keys()) join(node);
  // And a producer whose every fact this tab saw written but never read.
  for (const node of state.byProducer.keys()) join(node);

  // ── which facts get a node of their own ────────────────────────────────────
  const drawn = new Map<string, FactVM>();
  const pages = new Map<string, MemoryPageVM>();
  let truncated = false;

  for (const producer of state.byProducer.keys()) {
    if (!expanded.has(producer)) continue;
    const ids = state.byProducer.get(producer) ?? [];
    const slice = pageOf(ids, options.pages?.get(producer) ?? 0, size);
    pages.set(producer, slice);

    for (const id of ids.slice(slice.page * size, slice.page * size + size)) {
      if (drawn.size >= cap) {
        truncated = true;
        break;
      }
      const fact = state.facts.get(id);
      if (fact !== undefined) drawn.set(id, fact);
    }
  }

  // ── the nodes ──────────────────────────────────────────────────────────────
  const nodes: MemoryNodeVM[] = [];

  for (const node of participants) {
    const written = (state.byProducer.get(node) ?? [])
      .map((id) => state.facts.get(id))
      .filter((fact): fact is FactVM => fact !== undefined);
    const invalidCount = written.filter((fact) => fact.invalid !== null).length;
    const tainted = state.taints.get(node) ?? [];
    const base = options.plan?.get(node) ?? blankNode(node);
    const label = base.title;
    const suffix =
      written.length === 0
        ? 'reads only'
        : `${String(written.length)} fact${written.length === 1 ? '' : 's'}`;

    nodes.push({
      ...base,
      // Namespaced, so a plan node id can never collide with a fact id — and
      // set here rather than by mutating `base`, which is the plan
      // projection's own object and belongs to it.
      id: producerNodeId(node),
      // The accessible name `GraphCanvas` builds is `${type} ${title}, …`, so
      // the count has to be *in* the title: a bubble whose whole content is a
      // number that a screen reader never reads out is a bubble that only works
      // for people who can see it.
      title: `${label} · ${suffix}${tainted.length === 0 ? '' : ', tainted'}`,
      type: written.length === 0 ? 'reader' : 'writer',
      memory: {
        kind: 'producer',
        node,
        label,
        factCount: written.length,
        invalidCount,
        consumerCount: consumersOf(written).length,
        factId: null,
        factKey: null,
        invalid: invalidCount > 0,
        tainted: tainted.length > 0,
        taints: tainted.map((one) => one.factId),
        expanded: expanded.has(node),
        page: pages.get(node) ?? null,
      },
    });
  }

  for (const fact of drawn.values()) {
    const invalid = fact.invalid !== null;
    nodes.push({
      ...blankNode(fact.provenance.byNode),
      id: factNodeId(fact.id),
      title: `${fact.key}${invalid ? ', invalidated' : ''} · ${String(fact.consumers.length)} read${
        fact.consumers.length === 1 ? 'er' : 'ers'
      }`,
      type: 'fact',
      state: invalid ? 'failed' : 'passed',
      memory: {
        kind: 'fact',
        node: fact.provenance.byNode,
        label: fact.key,
        factCount: 1,
        invalidCount: invalid ? 1 : 0,
        consumerCount: fact.consumers.length,
        factId: fact.id,
        factKey: fact.key,
        invalid,
        tainted: false,
        taints: invalid ? [...(fact.invalid?.taints ?? [])] : [],
        expanded: false,
        page: null,
      },
    });
  }

  // ── the edges ──────────────────────────────────────────────────────────────
  //
  // Every fact is represented exactly once: through its own node when it is
  // drawn, and through its writer's aggregate edge when it is not. A fact
  // counted twice would double the apparent traffic between two nodes, and a
  // fact counted zero times would leave a reader on the graph with no reason
  // to be there.
  const edges = new Map<string, { from: string; to: string; carries: string[]; more: number }>();
  const add = (from: string, to: string, key: string): void => {
    const id = edgeId(from, to, 'data');
    const held = edges.get(id) ?? { from, to, carries: [], more: 0 };
    if (held.carries.length < MEMORY_EDGE_CARRIES) held.carries.push(key);
    else held.more += 1;
    edges.set(id, held);
  };

  for (const fact of facts) {
    const writer = producerNodeId(fact.provenance.byNode);
    if (drawn.has(fact.id)) {
      add(writer, factNodeId(fact.id), fact.key);
      for (const consumer of fact.consumers) {
        add(factNodeId(fact.id), producerNodeId(consumer.node), fact.key);
      }
      continue;
    }
    for (const consumer of fact.consumers) add(writer, producerNodeId(consumer.node), fact.key);
  }

  return {
    nodes,
    edges: [...edges].map(([id, edge]) => ({
      id,
      from: edge.from,
      to: edge.to,
      kind: 'data' as const,
      carries:
        edge.more === 0 ? edge.carries : [...edge.carries, `…and ${String(edge.more)} more facts`],
    })),
    facts: state.facts.size,
    drawnFacts: drawn.size,
    truncated,
  };
}
