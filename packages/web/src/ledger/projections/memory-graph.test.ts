/**
 * KAR-17.9 test plan rows 1, 2 and 3 — the memory graph is aggregated **before**
 * it is rendered.
 *
 * Verifies: EPIC-17-S33 · AC1, AC2, AC4
 *
 * Every assertion here is against a pure function over a folded
 * `BlackboardProjection`, in the node environment, in milliseconds. That is the
 * whole point of the story's first three test rows: the red condition each one
 * names is *"the graph is built from raw facts and aggregated in the
 * component"*, and a component cannot be asked any of these questions without a
 * browser and a mount.
 */
import { expect, it, describe as suite } from 'vitest';
import { memoryStressLedger } from '../../../test/memory-stress.ts';
import { fold } from '../../../test/run-fixtures.ts';
import { applyBlackboard, type BlackboardProjection, emptyBlackboard } from './blackboard.ts';
import {
  MEMORY_EXPANDED_CAP,
  MEMORY_PAGE_SIZE,
  type MemoryNodeVM,
  memoryGraph,
} from './memory-graph.ts';

const HAPPY = 'happy-path-12';

const board = (): BlackboardProjection => fold(HAPPY, emptyBlackboard, applyBlackboard);

/** The blackboard of a generated stress ledger, folded the way a tab folds it. */
function stress(options: Parameters<typeof memoryStressLedger>[0] = {}): BlackboardProjection {
  const state = emptyBlackboard();
  for (const event of memoryStressLedger(options).events) applyBlackboard(state, event);
  return state;
}

const byNode = (nodes: readonly MemoryNodeVM[], node: string): MemoryNodeVM | undefined =>
  nodes.find((one) => one.memory.kind === 'producer' && one.memory.node === node);

suite('KAR-17.9 test 1 — the default view is one bubble per producing node (AC1)', () => {
  it('draws a bubble per node with the count of facts it wrote', () => {
    const graph = memoryGraph(board());

    expect(byNode(graph.nodes, 'recon-auth-surface')?.memory.factCount).toBe(1);
    expect(byNode(graph.nodes, 'plan-migration')?.memory.factCount).toBe(1);
    expect(byNode(graph.nodes, 'review-security')?.memory.factCount).toBe(1);
    // A node that only ever *read* is still on the graph — it is the other end
    // of every edge the view exists to draw — with a count of nothing written.
    expect(byNode(graph.nodes, 'impl-login')?.memory.factCount).toBe(0);
  });

  it('renders no raw facts at all by default', () => {
    const graph = memoryGraph(board());

    expect(graph.nodes.every((node) => node.memory.kind === 'producer')).toBe(true);
    expect(graph.drawnFacts).toBe(0);
  });

  it('draws an edge from writer to reader, labelled with what crossed it', () => {
    const graph = memoryGraph(board());

    const edge = graph.edges.find(
      (one) => one.from === 'node:recon-auth-surface' && one.to === 'node:plan-migration',
    );
    expect(edge?.kind).toBe('data');
    expect(edge?.carries).toEqual(['finding/auth-uses-jwt']);

    expect(
      graph.edges.find(
        (one) => one.from === 'node:review-security' && one.to === 'node:impl-signup',
      )?.carries,
    ).toEqual(['risk/legacy-shim-needed']);
  });

  it('stays bounded by the plan at three thousand facts, not by the facts', () => {
    // AC1's *"raw facts are not rendered by default at any run size"*, asked of
    // the size the story names. Thirty producers and twelve readers is
    // forty-two bubbles however many facts they wrote between them.
    const state = stress();

    expect(state.facts.size).toBe(3000);

    const graph = memoryGraph(state);
    expect(graph.facts).toBe(3000);
    expect(graph.drawnFacts).toBe(0);
    expect(graph.nodes).toHaveLength(42);
  });
});

suite('KAR-17.9 test 2 — expansion is capped and paginated (AC2)', () => {
  const NINE_HUNDRED = { producers: 1, factsPerProducer: 900, consumersPerFact: 1 } as const;

  it('draws one page of facts, not nine hundred of them', () => {
    const graph = memoryGraph(stress(NINE_HUNDRED), { expanded: new Set(['producer-0']) });

    expect(graph.drawnFacts).toBe(MEMORY_PAGE_SIZE);
    expect(graph.nodes.filter((node) => node.memory.kind === 'fact')).toHaveLength(
      MEMORY_PAGE_SIZE,
    );
    // The bubble stays: facts expand *inline*, they do not replace their writer.
    expect(byNode(graph.nodes, 'producer-0')?.memory.expanded).toBe(true);
  });

  it('reports which page it drew, so the view can offer the next one', () => {
    const graph = memoryGraph(stress(NINE_HUNDRED), { expanded: new Set(['producer-0']) });
    const page = byNode(graph.nodes, 'producer-0')?.memory.page;

    expect(page).toEqual({
      page: 0,
      pages: Math.ceil(900 / MEMORY_PAGE_SIZE),
      from: 1,
      to: MEMORY_PAGE_SIZE,
      total: 900,
      size: MEMORY_PAGE_SIZE,
    });
  });

  it('draws the page it is asked for, in ledger order', () => {
    const state = stress(NINE_HUNDRED);
    const graph = memoryGraph(state, {
      expanded: new Set(['producer-0']),
      pages: new Map([['producer-0', 3]]),
    });

    const written = state.byProducer.get('producer-0') ?? [];
    const drawn = graph.nodes
      .filter((node) => node.memory.kind === 'fact')
      .map((node) => node.memory.factId);

    expect(drawn).toEqual(written.slice(150, 200));
    expect(byNode(graph.nodes, 'producer-0')?.memory.page?.from).toBe(151);
  });

  it('collapsing restores the aggregate', () => {
    const state = stress(NINE_HUNDRED);

    expect(memoryGraph(state, { expanded: new Set() }).drawnFacts).toBe(0);
    expect(memoryGraph(state).nodes).toHaveLength(
      memoryGraph(state, { expanded: new Set() }).nodes.length,
    );
  });

  it('caps the drawn facts however many producers are expanded at once', () => {
    const state = stress({ producers: 30, factsPerProducer: 100, consumersPerFact: 1 });
    const everyone = new Set(Array.from({ length: 30 }, (_, n) => `producer-${String(n)}`));

    const graph = memoryGraph(state, { expanded: everyone });

    // Thirty producers × a fifty-fact page would be 1,500 nodes — the number
    // the escape hatch in docs/12 §6.4 exists for. The cap is what keeps the
    // default renderer inside the measurement KAR-16.6 took.
    expect(graph.drawnFacts).toBe(MEMORY_EXPANDED_CAP);
    expect(graph.truncated).toBe(true);
  });

  it('keeps every fact represented exactly once — as a node, or on its writer’s edge', () => {
    const state = stress({ producers: 1, factsPerProducer: 60, consumersPerFact: 1 });
    const graph = memoryGraph(state, { expanded: new Set(['producer-0']) });

    // The fifty on the page are drawn; the ten off it are still accounted for
    // by the aggregate edge from their writer, so no consumer silently loses
    // its reason for being on the graph.
    const aggregate = graph.edges.filter((edge) => edge.from === 'node:producer-0');
    const fromFacts = graph.edges.filter((edge) => edge.from.startsWith('fact:'));

    expect(fromFacts).toHaveLength(MEMORY_PAGE_SIZE);
    expect(aggregate.filter((edge) => edge.to.startsWith('node:'))).not.toHaveLength(0);
  });
});

suite('KAR-17.9 test 3 — taint is carried from the event, never recomputed (AC4)', () => {
  it('marks an invalidated fact distinctly', () => {
    const state = board();
    const graph = memoryGraph(state, { expanded: new Set(['plan-migration']) });

    const fact = graph.nodes.find((node) => node.memory.kind === 'fact');
    expect(fact?.memory.factKey).toBe('decision/router-guard-shape');
    expect(fact?.memory.invalid).toBe(true);
    expect(byNode(graph.nodes, 'plan-migration')?.memory.invalidCount).toBe(1);
  });

  it('highlights every node the invalidation named, including one that never read it', () => {
    // `fact.invalidated` at seq 78 names `taints: [impl-login, impl-signup]`,
    // and `impl-signup` is **not** in that fact's consumer set — it read a
    // different one. A graph that recomputed taint from its own edges would
    // leave it clean, which is the failure this assertion exists for.
    const graph = memoryGraph(board());

    expect(byNode(graph.nodes, 'impl-login')?.memory.tainted).toBe(true);
    expect(byNode(graph.nodes, 'impl-signup')?.memory.tainted).toBe(true);
    expect(byNode(graph.nodes, 'impl-signup')?.memory.taints).toEqual([
      'fact_e8d87892b0287c860826701c30',
    ]);
  });

  it('leaves a reader the invalidation did not name alone', () => {
    // A read that happened *after* the invalidation is not tainted — the
    // daemon compares `EventSeq`s and leaves it off `taints[]`. A projection
    // that walked the consumer set would mark it.
    const state = board();
    const invalidated = [...state.facts.values()].find((fact) => fact.invalid !== null);
    applyBlackboard(state, {
      seq: 900,
      runId: 'run_20260811T090000Z_a1b2c3',
      ts: 1_786_438_900_000,
      epoch: 3,
      kind: 'fact.read',
      v: 1,
      payload: { factId: invalidated?.id, key: invalidated?.key, by: 'smoke-tests' },
    } as never);

    const graph = memoryGraph(state);
    expect(byNode(graph.nodes, 'smoke-tests')?.memory.tainted).toBe(false);
    // …and it is still drawn as a consumer, which is the other half of honest.
    expect(byNode(graph.nodes, 'smoke-tests')).toBeDefined();
  });
});
