/**
 * KAR-16.6 — the ELK adapter and the layout stability that comes free with it.
 *
 * Verifies: EPIC-16-S38, EPIC-16-S37 (the wiring scenario) · AC5, AC6
 *
 * In a real Chromium rather than in Node, and that is not ceremony: the thing
 * under test is `elkjs` **in a worker**, reached through Vite's `?worker`
 * import, and a Node-side run would exercise a different loader and a different
 * transport to say nothing about the path that ships (docs/14 §13, the epic's
 * own note). What it costs is one worker start per file; what it buys is that
 * the recipe S3 settled is the recipe asserted.
 *
 * The stability assertion is **on ordering, not on pixel coordinates**, and it
 * carries its own control: a layout in which nothing moved at all would satisfy
 * "the order is unchanged" perfectly and prove nothing, so the same run asserts
 * that coordinates *did* change. That pairing is the whole spec.
 */
import { expect, it, describe as suite } from 'vitest';
import type { PlanEdgeVM, PlanNodeVM } from '../../ledger/vm.ts';
import {
  createLayoutEngine,
  type GraphLayout,
  LAYOUT_OPTIONS,
  NODE_SIZE,
  toElkGraph,
} from './layout.ts';

/** A node with only the fields layout reads, spelled as the projection does. */
function node(id: string, title = id): PlanNodeVM {
  return {
    id,
    title,
    type: 'implement',
    lifecycle: 'active',
    status: 'scheduled',
    state: 'pending',
    provider: 'claude-code',
    model: null,
    permission: null,
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

function edge(from: string, to: string): PlanEdgeVM {
  return { id: `${from}->${to}`, from, to, kind: 'control', carries: [] };
}

/**
 * A 60-node DAG, in ledger-insertion order.
 *
 * A ternary tree so a layered algorithm has real layers to build, plus a few
 * forward cross-edges so it also has crossings to minimise — the same shape
 * S3's spike used, for the same reason: a graph with no crossings cannot show
 * an ordering change even when one happens.
 */
function sixtyNodes(): { nodes: PlanNodeVM[]; edges: PlanEdgeVM[] } {
  const nodes: PlanNodeVM[] = [];
  const edges: PlanEdgeVM[] = [];
  for (let index = 0; index < 60; index += 1) {
    const id = `n${String(index).padStart(2, '0')}`;
    nodes.push(node(id, `step ${index}`));
    if (index > 0) edges.push(edge(`n${String(Math.floor((index - 1) / 3)).padStart(2, '0')}`, id));
    if (index > 10 && index % 7 === 0)
      edges.push(edge(`n${String(index - 5).padStart(2, '0')}`, id));
  }
  return { nodes, edges };
}

/**
 * The pre-existing nodes, in the order the drawing puts them: by layer (the `x`
 * column, which for a left-to-right layered drawing *is* the layer), then down
 * the column. Two layouts that agree on this sequence have not reshuffled the
 * graph, whatever the coordinates say.
 */
function drawingOrder(layout: GraphLayout, ids: readonly string[]): string[] {
  return [...ids].sort((left, right) => {
    const a = layout.positions.get(left);
    const b = layout.positions.get(right);
    if (a === undefined || b === undefined) throw new Error(`${left}/${right} was not laid out`);
    return a.x - b.x || a.y - b.y || left.localeCompare(right);
  });
}

suite('AC6 — the adapter maps the plan in ledger-insertion order', () => {
  it('feeds ELK the array it was given, in that order, without sorting it', () => {
    // Ids whose lexical order is the reverse of their ledger order: a mapper
    // that sorted — or that walked a Map it built for itself — comes out
    // backwards here and identical on any realistic id scheme.
    const nodes = [node('z_first'), node('m_second'), node('a_third')];

    expect(toElkGraph(nodes, []).children.map((child) => child.id)).toEqual([
      'z_first',
      'm_second',
      'a_third',
    ]);
  });

  it('gives every node the size the renderer draws it at, so ELK spaces real boxes', () => {
    const [first] = toElkGraph([node('n1')], []).children;

    expect(first?.width).toBe(NODE_SIZE.width);
    expect(first?.height).toBe(NODE_SIZE.height);
  });

  it('maps edges to ELK sources and targets, keeping the projection’s ids', () => {
    const graph = toElkGraph([node('a'), node('b')], [edge('a', 'b')]);

    expect(graph.edges).toEqual([{ id: 'a->b', sources: ['a'], targets: ['b'] }]);
  });

  it('sets considerModelOrder on the layered algorithm, which is the one in use', () => {
    // The test plan's red for this row is "the option was set on the wrong ELK
    // layout algorithm": `considerModelOrder` is a `layered` option, and set
    // under any other algorithm it is silently inert — which is the failure
    // mode S3 found for the constraint options next door.
    expect(LAYOUT_OPTIONS['elk.algorithm']).toBe('layered');
    expect(LAYOUT_OPTIONS['org.eclipse.elk.layered.considerModelOrder.strategy']).toBe(
      'NODES_AND_EDGES',
    );
    expect(LAYOUT_OPTIONS['org.eclipse.elk.layered.crossingMinimization.forceNodeModelOrder']).toBe(
      'true',
    );
    expect(toElkGraph([node('a')], []).layoutOptions).toMatchObject(LAYOUT_OPTIONS);
  });

  it('does not carry a per-node layout constraint, because those do not work', () => {
    // S3, rows 12–15: `layerChoiceConstraint` and `positionChoiceConstraint`
    // are ignored by elkjs 0.12.0 — with `interactiveLayout` on as well — and
    // the one recipe that appears to obey them produces a byte-identical
    // drawing with no constraint at all. Model order is the mechanism; this
    // asserts nobody quietly added the other one back.
    const graph = toElkGraph(sixtyNodes().nodes, sixtyNodes().edges);
    const asText = JSON.stringify(graph);

    expect(asText).not.toContain('layerChoiceConstraint');
    expect(asText).not.toContain('positionChoiceConstraint');
    expect(asText).not.toContain('interactiveLayout');
  });
});

suite('EPIC-16-S38 — adding a node does not reshuffle the graph (AC6)', () => {
  it('leaves the relative ordering of 60 existing nodes unchanged, and moves them', async () => {
    const engine = createLayoutEngine();
    try {
      const before = sixtyNodes();
      const first = await engine.layout(before.nodes, before.edges);

      // A node inserted mid-graph, in ledger order: it arrives after the
      // nodes that already existed, and it hangs off one of them.
      const after = {
        nodes: [...before.nodes, node('n_new', 'a node the replan added')],
        edges: [...before.edges, edge('n07', 'n_new')],
      };
      const second = await engine.layout(after.nodes, after.edges);

      const existing = before.nodes.map((each) => each.id);
      expect(drawingOrder(second, existing)).toEqual(drawingOrder(first, existing));

      // The control. "Nothing moved" would satisfy the assertion above without
      // the option doing any work at all, and a 61st node in a layered drawing
      // has to displace something — so at least one pre-existing node must sit
      // at different coordinates in the two layouts.
      const moved = existing.filter((id) => {
        const a = first.positions.get(id);
        const b = second.positions.get(id);
        return a?.x !== b?.x || a?.y !== b?.y;
      });
      expect(moved.length).toBeGreaterThan(0);
    } finally {
      engine.dispose();
    }
  }, 30_000);

  it('reshuffles the same graph the moment forceNodeModelOrder is off', async () => {
    // The finding this pins. `considerModelOrder.strategy` on its own is
    // accepted, is listed by `knownLayoutOptions()`, and changes nothing: the
    // insertion reorders the existing nodes exactly as it does with no options
    // at all. It is the sibling `crossingMinimization.forceNodeModelOrder` that
    // makes the strategy bite, and the test above would pass for the wrong
    // reason on any graph flat enough not to need it — so this run is the
    // control that says the graph is not flat and the option is load-bearing.
    const engine = createLayoutEngine({
      'org.eclipse.elk.layered.crossingMinimization.forceNodeModelOrder': 'false',
    });
    try {
      const before = sixtyNodes();
      const first = await engine.layout(before.nodes, before.edges);
      const second = await engine.layout(
        [...before.nodes, node('n_new')],
        [...before.edges, edge('n07', 'n_new')],
      );

      const existing = before.nodes.map((each) => each.id);
      expect(drawingOrder(second, existing)).not.toEqual(drawingOrder(first, existing));
    } finally {
      engine.dispose();
    }
  }, 30_000);

  it('lays every node out off the main thread, and reports how long it took', async () => {
    const engine = createLayoutEngine();
    try {
      const { nodes, edges } = sixtyNodes();

      // A 10 ms heartbeat across the call: if ELK ran on the main thread, the
      // ~90 ms layout S3 measured would swallow most of these ticks. Counted
      // the way EPIC-00-S14 counted them, for the same reason.
      let ticks = 0;
      const heartbeat = setInterval(() => {
        ticks += 1;
      }, 10);
      let layout: GraphLayout;
      try {
        layout = await engine.layout(nodes, edges);
      } finally {
        clearInterval(heartbeat);
      }

      expect(layout.positions.size).toBe(60);
      expect(new Set([...layout.positions.values()].map((at) => `${at.x},${at.y}`)).size).toBe(60);
      expect(layout.ms).toBeGreaterThan(0);
      expect(ticks).toBeGreaterThanOrEqual(5);
    } finally {
      engine.dispose();
    }
  }, 30_000);
});
