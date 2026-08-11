/**
 * KAR-17.1 — what the facade had to grow for a **live** plan graph.
 *
 * Verifies: EPIC-17-S1 (scenario 3), EPIC-17-S2 (scenario 3), EPIC-17-S3
 * (scenario 1) · AC1, AC3, AC5, AC6, AC7, AC9, AC10
 *
 * `./GraphCanvas.test.ts` is KAR-16.6's file and stays as it is: it asserts the
 * facade's *surface* — a node is a slot, no Vue Flow type escapes, the motion
 * rule, the a11y contract. This file asserts the four things a facade needs
 * once a **run** is streaming through it, all of which EPIC-16 had no view to
 * discover:
 *
 * 1. **A progress event is not a shape change.** Forty `node.progress` events
 *    on a running node produce forty new view-model arrays, and a canvas that
 *    relaid out on array identity would run ELK forty times for a graph whose
 *    shape never moved. That is the single most expensive mistake available
 *    here and it is invisible in a screenshot.
 * 2. **Edges carry `carries[]`.** F10.1's *"edges labelled with what flows
 *    across them"* is real data on the projection's edge, and a control edge
 *    must not pretend to carry anything.
 * 3. **A selection has a neighbourhood.** Highlighting one node in four hundred
 *    without dimming the rest is not a highlight.
 * 4. **The world is bounded and has a map.** AC9's minimap, zoom controls and
 *    `nodeExtent`.
 *
 * Real Chromium, like everything else in this directory: every assertion below
 * is a computed style, a measured position or an SVG marker, and jsdom answers
 * all three with a plausible zero (docs/14 §13).
 */
import { expect, it, describe as suite } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-vue';
import type { PlanEdgeVM, PlanNodeVM } from '../../ledger/vm.ts';
import '../../styles/theme.css';
import GraphCanvas from './GraphCanvas.vue';

function node(id: string, over: Partial<PlanNodeVM> = {}): PlanNodeVM {
  return {
    id,
    title: `title of ${id}`,
    type: 'implement',
    lifecycle: 'active',
    status: 'running',
    state: 'running',
    provider: 'claude-code',
    model: 'claude-sonnet-4-6',
    permission: 'worktree',
    worktree: null,
    binary: null,
    attempt: 1,
    phase: null,
    progressMessage: null,
    failure: null,
    suspendedUntil: null,
    blocked: null,
    retry: null,
    unschedulable: null,
    ...over,
  };
}

const control = (from: string, to: string): PlanEdgeVM => ({
  id: `${from}→${to}:control`,
  from,
  to,
  kind: 'control',
  carries: [],
});

const data = (from: string, to: string, carries: readonly string[]): PlanEdgeVM => ({
  id: `${from}→${to}:data`,
  from,
  to,
  kind: 'data',
  carries,
});

/** Twelve nodes in a chain — the shape the test plan's rows are written on. */
const TWELVE = Array.from({ length: 12 }, (_, index) => node(`n${index}`));
const CHAIN = TWELVE.slice(1).map((each, index) => control(`n${index}`, each.id));

const NODE_SLOT = {
  node: `<template #node="{ node }">
    <article class="test-node" :data-node="node.id" :data-phase="node.phase ?? ''">
      <h3>{{ node.title }}</h3>
      <span class="test-node__state">{{ node.state }}</span>
    </article>
  </template>`,
};

function mount(props: Record<string, unknown> = {}) {
  return render(GraphCanvas, {
    props: { nodes: TWELVE, edges: CHAIN, ...props },
    slots: NODE_SLOT,
  });
}

const rendered = (container: Element): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('.vue-flow__node'),
];

async function laidOut(container: Element, count: number): Promise<void> {
  await expect.poll(() => rendered(container).length, { timeout: 15_000 }).toBe(count);
}

/** How many layouts the canvas has reported. `undefined` is none, not a throw. */
const layouts = (screen: { emitted(name: string): unknown[] | undefined }): number =>
  screen.emitted('laid-out')?.length ?? 0;

/** Long enough that a relayout, had one been queued, has landed and emitted. */
const settle = (ms = 500): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The drawing order the renderer is currently painting: by column, then down it.
 *
 * Read off the inline `transform` the renderer writes rather than off the
 * layout object, because the claim AC6 makes is about what the operator sees.
 * Two drawings that agree on this sequence have not reshuffled, whatever the
 * coordinates say — the same measure `./layout.test.ts` uses one level down.
 */
function drawingOrder(container: Element, only: readonly string[]): string[] {
  const at = new Map<string, { x: number; y: number }>();
  for (const element of rendered(container)) {
    const id = element.dataset['id'];
    const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(element.style.transform);
    if (id === undefined || match === null) continue;
    at.set(id, { x: Number(match[1]), y: Number(match[2]) });
  }
  return [...only]
    .filter((id) => at.has(id))
    .sort((left, right) => {
      const a = at.get(left) as { x: number; y: number };
      const b = at.get(right) as { x: number; y: number };
      return a.x - b.x || a.y - b.y || left.localeCompare(right);
    });
}

suite('AC3 — a progress event is not a shape change', () => {
  it('lays the graph out once, and not again when a node’s phase moves', async () => {
    const screen = mount();
    await laidOut(screen.container, 12);
    await expect.poll(() => layouts(screen)).toBe(1);

    // What the store hands a view on every `node.progress`: a **new array** of
    // new snapshot objects, with the same nodes in the same order and one
    // node's phase moved. Identity has changed everywhere; shape has not.
    for (const phase of ['reading', 'editing', 'testing']) {
      await screen.rerender({
        nodes: TWELVE.map((each) => (each.id === 'n3' ? node('n3', { phase }) : node(each.id))),
      });
      await expect
        .poll(() => screen.container.querySelector('[data-node="n3"]')?.getAttribute('data-phase'))
        .toBe(phase);
    }

    await settle();

    // The whole point: three progress events, zero relayouts. A canvas that
    // watched array identity would be at four by now, and on a real run — where
    // a chatty agent emits progress every few hundred milliseconds — it would
    // be running ELK for the life of the node.
    expect(layouts(screen)).toBe(1);
  });

  it('lays it out again the moment a node actually arrives', async () => {
    const screen = mount();
    await laidOut(screen.container, 12);

    // The control for the assertion above. Without it, an emit that simply
    // never fires would satisfy "exactly one layout" perfectly.
    await screen.rerender({
      nodes: [...TWELVE, node('n12')],
      edges: [...CHAIN, control('n11', 'n12')],
    });

    await expect.poll(() => layouts(screen), { timeout: 15_000 }).toBe(2);
    await laidOut(screen.container, 13);
  });
});

suite('AC5 — edges say what flows across them, and only when something does', () => {
  const PAIR = [node('n_recon'), node('n_impl_3')];
  const FACT = 'finding/auth-uses-jwt';

  it('labels a data edge with the fact keys it carries', async () => {
    const screen = render(GraphCanvas, {
      props: { nodes: PAIR, edges: [data('n_recon', 'n_impl_3', [FACT])] },
      slots: NODE_SLOT,
    });
    await laidOut(screen.container, 2);

    const label = await expect
      .poll(() => screen.container.querySelector('.plan-edge--data .vue-flow__edge-text'))
      .not.toBeNull()
      .then(() => screen.container.querySelector('.plan-edge--data .vue-flow__edge-text'));

    expect(label?.textContent).toContain(FACT);
    // And the same words to a reader who is not looking at the drawing.
    expect(
      screen.container.querySelector('.plan-edge--data')?.getAttribute('aria-label'),
    ).toContain(FACT);
  });

  it('gives a control edge no carried facts, because it carries none', async () => {
    const screen = render(GraphCanvas, {
      props: { nodes: PAIR, edges: [control('n_recon', 'n_impl_3')] },
      slots: NODE_SLOT,
    });
    await laidOut(screen.container, 2);

    expect(screen.container.querySelector('.plan-edge--control')).not.toBeNull();
    // The red this row names: edge labels faked from node titles. A control
    // edge with a label at all is that bug, whatever the label says.
    expect(screen.container.querySelector('.plan-edge--control .vue-flow__edge-text')).toBeNull();
    expect(
      screen.container.querySelector('.plan-edge--control')?.getAttribute('aria-label'),
    ).not.toContain('carries');
  });

  it('keeps the label out of the way until the edge is hovered', async () => {
    const screen = render(GraphCanvas, {
      props: { nodes: PAIR, edges: [data('n_recon', 'n_impl_3', [FACT])] },
      slots: NODE_SLOT,
    });
    await laidOut(screen.container, 2);
    await expect
      .poll(() => screen.container.querySelector('.plan-edge--data .vue-flow__edge-textwrapper'))
      .not.toBeNull();

    const wrapper = screen.container.querySelector(
      '.plan-edge--data .vue-flow__edge-textwrapper',
    ) as SVGGElement;
    // A forty-node plan with a label on every data edge is unreadable, which is
    // why AC5 says "on hover" and not "always".
    expect(getComputedStyle(wrapper).opacity).toBe('0');

    // The renderer's own wide transparent hit path — two nodes side by side in
    // a left-to-right layered drawing put a straight segment through the centre
    // of its box, so the pointer lands on the stroke rather than beside it.
    await userEvent.hover(
      page.elementLocator(
        screen.container.querySelector('.plan-edge--data .vue-flow__edge-interaction') as Element,
      ),
    );

    await expect.poll(() => getComputedStyle(wrapper).opacity).toBe('1');
  });

  it('lists the carried facts in the data-table twin as well', async () => {
    const screen = render(GraphCanvas, {
      props: {
        nodes: PAIR,
        edges: [data('n_recon', 'n_impl_3', [FACT]), control('n_impl_3', 'n_recon')],
      },
      slots: NODE_SLOT,
    });
    await laidOut(screen.container, 2);
    await userEvent.click(screen.container.querySelector('[data-graph-table-toggle]') as Element);

    const rows = [...screen.container.querySelectorAll('[data-graph-edge-table] tbody tr')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain(FACT);
    // A control edge's cell says it carries nothing, rather than being blank —
    // a blank cell in a pasted PR description reads as a missing value.
    expect(rows[1]?.textContent).toContain('nothing');
    expect(rows[1]?.textContent).not.toContain(FACT);
  });
});

suite('AC1 — an edge is drawn with a direction', () => {
  it('puts an arrow head on the target end of every edge', async () => {
    const screen = mount();
    await laidOut(screen.container, 12);

    const paths = [...screen.container.querySelectorAll('.vue-flow__edge-path')];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      // The renderer quotes the fragment — `url('#arrowclosed')` — which is
      // valid and is what has to be parsed to find the definition it names.
      const marker = /^url\(['"]?#(.+?)['"]?\)$/.exec(path.getAttribute('marker-end') ?? '');
      // A DAG drawn without arrow heads is a picture of a graph with no
      // dependencies in it, which is the one thing this drawing is for.
      expect(marker).not.toBeNull();
      const id = marker?.[1] ?? '';
      expect(screen.container.querySelector(`marker[id="${CSS.escape(id)}"]`)).not.toBeNull();
    }
  });
});

suite('AC6 — nodes arriving mid-run do not reshuffle the ones already drawn', () => {
  it('keeps the pre-existing drawing order across twenty insertions', async () => {
    const screen = mount();
    await laidOut(screen.container, 12);

    const existing = TWELVE.map((each) => each.id);
    const before = drawingOrder(screen.container, existing);
    expect(before).toHaveLength(12);

    // A `map` fan-out, arriving the way one really does: a few at a time, each
    // batch re-laid out, rather than twenty nodes appearing at once — which is
    // the case a single rerender would test and the run never produces.
    const fanned: PlanNodeVM[] = [];
    const fannedEdges: PlanEdgeVM[] = [];
    for (let index = 0; index < 20; index += 1) {
      fanned.push(node(`m${index}`));
      fannedEdges.push(control('n5', `m${index}`));
      if (index % 5 !== 4) continue;
      await screen.rerender({ nodes: [...TWELVE, ...fanned], edges: [...CHAIN, ...fannedEdges] });
      await laidOut(screen.container, 12 + fanned.length);
    }

    expect(drawingOrder(screen.container, existing)).toEqual(before);

    // The control. "Nothing moved at all" would satisfy the assertion above
    // without model order doing any work — a fan-out of twenty has to displace
    // something in a layered drawing.
    const after = new Map(
      rendered(screen.container).map((element) => [element.dataset['id'], element.style.transform]),
    );
    expect([...after.keys()]).toHaveLength(32);
  }, 60_000);
});

suite('AC7 — a selection highlights its immediate neighbourhood', () => {
  it('marks the node, its neighbours and the edges between them', async () => {
    const screen = mount({ selected: 'n1' });
    await laidOut(screen.container, 12);

    const classOf = (id: string): string =>
      screen.container.querySelector(`.vue-flow__node[data-id="${id}"]`)?.className ?? '';

    expect(classOf('n1')).toContain('is-selected');
    // n0 → n1 → n2: both sides of the selection are its neighbourhood, because
    // "what fed this node" is the first question and "what it fed" the second.
    expect(classOf('n0')).toContain('is-neighbour');
    expect(classOf('n2')).toContain('is-neighbour');
    expect(classOf('n7')).toContain('is-distant');

    const edgeClass = (id: string): string =>
      screen.container.querySelector(`.vue-flow__edge[data-id="${id}"]`)?.getAttribute('class') ??
      '';
    expect(edgeClass('n0→n1:control')).toContain('is-adjacent');
    expect(edgeClass('n6→n7:control')).not.toContain('is-adjacent');
  });

  it('dims the rest, because a highlight nothing recedes from is not one', async () => {
    const screen = mount({ selected: 'n1' });
    await laidOut(screen.container, 12);

    const opacity = (id: string): number =>
      Number(
        getComputedStyle(
          screen.container.querySelector(`.vue-flow__node[data-id="${id}"]`) as Element,
        ).opacity,
      );

    expect(opacity('n1')).toBe(1);
    expect(opacity('n0')).toBe(1);
    expect(opacity('n7')).toBeLessThan(1);
  });

  it('leaves every node at full strength when nothing is selected', async () => {
    const screen = mount();
    await laidOut(screen.container, 12);

    for (const element of rendered(screen.container)) {
      expect(Number(getComputedStyle(element).opacity)).toBe(1);
      expect(element.className).not.toContain('is-distant');
    }
  });
});

suite('AC9 — a minimap, zoom controls and a world with edges to it', () => {
  it('renders a minimap with a node in it for every node in the graph', async () => {
    const screen = mount();
    await laidOut(screen.container, 12);

    await expect.poll(() => screen.container.querySelector('.vue-flow__minimap')).not.toBeNull();
    await expect
      .poll(() => screen.container.querySelectorAll('.vue-flow__minimap-node').length)
      .toBe(12);
  });

  it('zooms from the controls, not only from a wheel nobody knows about', async () => {
    const screen = mount();
    await laidOut(screen.container, 12);

    const pane = () =>
      (screen.container.querySelector('.vue-flow__transformationpane') as HTMLElement).style
        .transform;
    const before = pane();

    await userEvent.click(screen.container.querySelector('.vue-flow__controls-zoomin') as Element);
    await expect.poll(pane).not.toBe(before);

    // And a way back to the graph, which is the other half of "and lost".
    expect(screen.container.querySelector('.vue-flow__controls-fitview')).not.toBeNull();
  });

  it('bounds the world to the graph it drew', async () => {
    const screen = mount();
    await laidOut(screen.container, 12);

    const extent = await expect
      .poll(() =>
        screen.container.querySelector('[data-graph-canvas]')?.getAttribute('data-extent'),
      )
      .not.toBeNull()
      .then(() =>
        (screen.container.querySelector('[data-graph-canvas]')?.getAttribute('data-extent') ?? '')
          .split(',')
          .map(Number),
      );

    expect(extent).toHaveLength(4);
    for (const value of extent) expect(Number.isFinite(value)).toBe(true);

    const [minX, minY, maxX, maxY] = extent as [number, number, number, number];
    const xs = rendered(screen.container).map((element) => {
      const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(element.style.transform);
      return { x: Number(match?.[1] ?? 0), y: Number(match?.[2] ?? 0) };
    });
    // Every node the renderer drew is inside the box, which is what makes the
    // box a bound on the graph rather than an arbitrary rectangle near it.
    for (const { x, y } of xs) {
      expect(x).toBeGreaterThanOrEqual(minX);
      expect(y).toBeGreaterThanOrEqual(minY);
      expect(x).toBeLessThanOrEqual(maxX);
      expect(y).toBeLessThanOrEqual(maxY);
    }
    expect(maxX).toBeGreaterThan(minX);
  });

  it('still yields to an extent the caller states for itself', async () => {
    const screen = mount({
      nodeExtent: [
        [0, 0],
        [10, 10],
      ],
    });
    await laidOut(screen.container, 12);

    expect(screen.container.querySelector('[data-graph-canvas]')?.getAttribute('data-extent')).toBe(
      '0,0,10,10',
    );
  });
});

suite('AC10 — the data-table twin is the whole view, in a form you can paste', () => {
  it('lists node, type, state, provider, permission, duration and cost', async () => {
    const screen = mount({
      costs: new Map([['n0', '$0.42']]),
      durations: new Map([['n0', '12.0 s']]),
    });
    await laidOut(screen.container, 12);
    await userEvent.click(screen.container.querySelector('[data-graph-table-toggle]') as Element);

    const headers = [...screen.container.querySelectorAll('[data-graph-table] thead th')].map(
      (cell) => cell.textContent?.trim(),
    );
    expect(headers).toEqual([
      'Node',
      'Type',
      'State',
      'Provider',
      'Permission',
      'Duration',
      'Cost',
    ]);

    const first = screen.container.querySelector('[data-graph-table] tbody tr');
    expect(first?.textContent).toContain('title of n0');
    expect(first?.textContent).toContain('implement');
    expect(first?.textContent).toContain('running');
    expect(first?.textContent).toContain('claude-code');
    expect(first?.textContent).toContain('worktree');
    expect(first?.textContent).toContain('12.0 s');
    expect(first?.textContent).toContain('$0.42');
  });

  it('is reachable from the keyboard, which is the only reason it is a button', async () => {
    const screen = mount();
    await laidOut(screen.container, 12);

    const toggle = screen.container.querySelector('[data-graph-table-toggle]') as HTMLElement;
    toggle.focus();
    await userEvent.keyboard('{Enter}');

    await expect.poll(() => screen.container.querySelector('[data-graph-table]')).not.toBeNull();
  });
});
