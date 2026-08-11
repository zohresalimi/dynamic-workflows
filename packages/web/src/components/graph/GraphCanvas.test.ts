/**
 * KAR-16.6 — the graph facade, in a real Chromium.
 *
 * Verifies: EPIC-16-S35, EPIC-16-S39, EPIC-16-S40 · AC1, AC2, AC7, AC8, AC9
 *
 * Everything here is geometric or computed-style, which is why it is in the
 * `web` project and not the unit one: jsdom and happy-dom have no SVG
 * measurement, no canvas and no layout, and they do not fail cleanly —
 * `getBBox()` returns 0, element sizes report as zero, and a spec asserting
 * "the node was drawn" passes against nothing at all (docs/14 §13).
 *
 * The facade's whole promise is that its **surface** is DeFlow's: `PlanNodeVM`
 * in, a node slot out, DeFlow events, and no Vue Flow type or option id in
 * sight. So the assertions below are written against the surface a view sees,
 * never against Vue Flow's API — the one exception being the rendered
 * `.vue-flow__node` class, which is the renderer's own DOM and is exactly what
 * a swap is allowed to change.
 */
import { afterEach, expect, it, describe as suite } from 'vitest';
import { commands, page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-vue';
import type { PlanEdgeVM, PlanNodeVM } from '../../ledger/vm.ts';
import '../../styles/theme.css';
import GraphCanvas from './GraphCanvas.vue';
import rawFacadeSource from './GraphCanvas.vue?raw';

/**
 * The facade's source with its comments removed.
 *
 * The two assertions below are about what the file *does*, and the file
 * explains at length why it does not set `disableKeyboardA11y` and why it
 * writes no `translate3d` of its own. Matching the prose would force the
 * explanation to be deleted to make the test pass, which is backwards — the
 * same narrowing `test/no-replay-branch-in-web.test.ts` makes, for the same
 * reason.
 */
const facadeSource = rawFacadeSource
  .replaceAll(/<!--[\s\S]*?-->/g, ' ')
  .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
  .replaceAll(/(^|[^:])\/\/[^\n]*/g, '$1');

function node(id: string, over: Partial<PlanNodeVM> = {}): PlanNodeVM {
  return {
    id,
    title: `title of ${id}`,
    type: 'implement',
    lifecycle: 'active',
    status: 'running',
    state: 'running',
    provider: 'claude-code',
    model: null,
    permission: null,
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

const edge = (from: string, to: string): PlanEdgeVM => ({
  id: `${from}->${to}`,
  from,
  to,
  kind: 'control',
  carries: [],
});

/** Twelve nodes in a chain, which is what the test plan's row 4 asks for. */
const TWELVE = Array.from({ length: 12 }, (_, index) => node(`n${index}`));
const CHAIN = TWELVE.slice(1).map((each, index) => edge(`n${index}`, each.id));

/** Mounts the facade with the node slot a view would give it. */
function mount(props: Record<string, unknown> = {}) {
  return render(GraphCanvas, {
    props: { nodes: TWELVE, edges: CHAIN, ...props },
    slots: {
      node: `<template #node="{ node, selected }">
        <article class="test-node" :data-node="node.id" :data-selected="selected">
          <h3>{{ node.title }}</h3>
          <span class="test-node__state">{{ node.state }}</span>
        </article>
      </template>`,
    },
  });
}

/** The rendered nodes, in DOM order. */
const rendered = (container: Element): HTMLElement[] => [
  ...container.querySelectorAll<HTMLElement>('.vue-flow__node'),
];

/** Waits for the canvas to have laid the graph out at all. */
async function laidOut(container: Element, count = TWELVE.length): Promise<void> {
  await expect.poll(() => rendered(container).length, { timeout: 15_000 }).toBe(count);
}

afterEach(async () => {
  await commands.emulateMedia({});
});

suite('AC2 — a node is a Vue component the caller supplies', () => {
  it('renders the caller’s slot once per node, with the view-model in it', async () => {
    const screen = mount();
    await laidOut(screen.container);

    const bodies = [...screen.container.querySelectorAll('.test-node')];
    expect(bodies).toHaveLength(12);
    expect(bodies.map((body) => body.getAttribute('data-node'))).toEqual(
      TWELVE.map((each) => each.id),
    );
    // Per-node live status is the reason Vue Flow was chosen over the
    // canvas-first alternatives: a node body is a component, not a drawing.
    expect(bodies[0]?.textContent).toContain('title of n0');
    expect(bodies[0]?.textContent).toContain('running');
  });

  it('tells the slot which node is selected, so a body can style itself', async () => {
    const screen = mount({ selected: 'n3' });
    await laidOut(screen.container);

    const selected = [...screen.container.querySelectorAll('.test-node')].filter(
      (body) => body.getAttribute('data-selected') === 'true',
    );
    expect(selected.map((body) => body.getAttribute('data-node'))).toEqual(['n3']);
  });

  it('lays the nodes out rather than stacking them at the origin', async () => {
    const screen = mount();
    await laidOut(screen.container);

    // The layout arrives from the worker, so this is a poll rather than a read:
    // what it rules out is a canvas that renders every node at 0,0 and looks
    // fine in a screenshot of one node.
    await expect
      .poll(
        () => new Set(rendered(screen.container).map((element) => element.style.transform)).size,
        { timeout: 15_000 },
      )
      .toBe(12);
  });
});

suite('EPIC-16-S40 — the graph is reachable from the keyboard and by a reader', () => {
  it('gives every node the accessible name the view-model spells out', async () => {
    const screen = mount();
    await laidOut(screen.container);

    // `${node.type} ${node.title}, ${node.state}, ${node.provider}` — most of
    // what a screen reader needs from a DAG, in one line (docs/12 §9.3).
    expect(rendered(screen.container)[0]?.getAttribute('aria-label')).toBe(
      'implement title of n0, running, claude-code',
    );
  });

  it('still names a node whose type and provider have not arrived yet', async () => {
    const screen = render(GraphCanvas, {
      props: { nodes: [node('n_fresh', { type: null, provider: null })], edges: [] },
    });
    await laidOut(screen.container, 1);

    // A plan node exists before any `node.started` says what will run it, and
    // "null title of n_fresh, running, null" is worse than saying neither.
    const label = rendered(screen.container)[0]?.getAttribute('aria-label') ?? '';
    expect(label).toContain('title of n_fresh');
    expect(label).toContain('running');
    expect(label).not.toContain('null');
  });

  it('leaves Vue Flow’s keyboard a11y on, which is most of what carries this', async () => {
    const screen = mount();
    await laidOut(screen.container);

    // `disableKeyboardA11y` is the quickest way to stop key handlers
    // conflicting with a custom keymap, and it is a direct instruction not to
    // (docs/12 §9.3). Its absence is asserted twice: in the option surface,
    // and in the consequence — a node you cannot Tab to.
    expect(facadeSource).not.toContain('disableKeyboardA11y');
    for (const element of rendered(screen.container)) {
      expect(element.getAttribute('tabindex')).toBe('0');
    }
  });

  it('moves the selection as focus traverses, and opens on Enter', async () => {
    const selected: string[] = [];
    const activated: string[] = [];
    const screen = render(GraphCanvas, {
      props: {
        nodes: TWELVE,
        edges: CHAIN,
        onSelect: (id: string) => selected.push(id),
        onActivate: (id: string) => activated.push(id),
      },
    });
    await laidOut(screen.container);

    const nodes = rendered(screen.container);
    nodes[0]?.focus();
    await expect.poll(() => selected.at(-1)).toBe('n0');

    await userEvent.tab();
    await expect.poll(() => selected.at(-1)).toBe('n1');

    await userEvent.keyboard('{Enter}');
    expect(activated).toEqual(['n1']);
  });

  it('carries a title and a label on the drawing itself', async () => {
    const screen = mount();
    await laidOut(screen.container);

    const canvas = screen.container.querySelector('[data-graph-canvas]');
    expect(canvas?.getAttribute('aria-label')).toContain('Plan graph');
    expect(screen.container.querySelector('svg title')?.textContent).toContain('12');
  });

  it('offers the same graph as a table, which is also the paste-into-a-PR surface', async () => {
    const screen = mount({
      costs: new Map([
        ['n0', '$0.42'],
        ['n1', '$1.10'],
      ]),
    });
    await laidOut(screen.container);

    // Hidden until asked for: the table is an escape route, not a second view.
    expect(screen.container.querySelector('[data-graph-table]')).toBeNull();
    await userEvent.click(screen.container.querySelector('[data-graph-table-toggle]') as Element);

    const rows = [...screen.container.querySelectorAll('[data-graph-table] tbody tr')];
    expect(rows).toHaveLength(12);
    expect(rows[0]?.textContent).toContain('title of n0');
    expect(rows[0]?.textContent).toContain('running');
    expect(rows[0]?.textContent).toContain('claude-code');
    expect(rows[0]?.textContent).toContain('$0.42');
    // A node nobody priced says so, rather than reading as free.
    expect(rows[2]?.textContent).not.toContain('$0.00');
  });
});

suite('EPIC-16-S39 — the node animation you must not write', () => {
  it('animates a node with a transform transition, and with nothing else', async () => {
    const screen = mount();
    await laidOut(screen.container);

    const style = getComputedStyle(rendered(screen.container)[0] as Element);
    expect(style.transitionProperty).toBe('transform');
    expect(style.transitionDuration).toBe('0.2s');
    expect(style.transitionTimingFunction).toBe('ease-out');
  });

  it('writes no transform of its own — the renderer owns that inline style', () => {
    // The bug this prevents: a build that authors its own translate3d
    // transitions on nodes finds Vue Flow writing an inline `transform` over
    // them, so the animation works sometimes and not others. The facade's
    // source may not contain a transform write at all.
    expect(facadeSource).not.toMatch(/style\.transform\s*=/);
    expect(facadeSource).not.toContain('translate3d');
  });

  it('switches the transition off while a node is being dragged', async () => {
    const screen = mount();
    await laidOut(screen.container);

    const nodes = rendered(screen.container);
    const seen = await watchMotion(screen.container, () =>
      // Through `page.elementLocator`, not through the elements themselves:
      // handed a bare element, the runner derives a locator from its text
      // content, and a node's text is also the pane's text — so the drag lands
      // on the pane and the spec fails for a reason that has nothing to do with
      // the component.
      userEvent.dragAndDrop(
        page.elementLocator(nodes[0] as Element),
        page.elementLocator(nodes[6] as Element),
      ),
    );

    // Off during, back on after: a transition left off is as wrong as one left
    // on, and only the sequence can tell the two apart.
    expect(seen).toContain('off');
    expect(seen.at(-1)).toBe('on');
  });

  it('switches it off while the viewport is moving', async () => {
    const screen = mount();
    await laidOut(screen.container);

    const before = transformOf(screen.container);
    const seen = await watchMotion(screen.container, async () => {
      await zoom(screen.container);
    });

    expect(seen).toContain('off');
    expect(seen.at(-1)).toBe('on');
    // The control: a viewport that did not move would satisfy the sequence
    // above by accident, because the canvas would simply never have been asked.
    expect(transformOf(screen.container)).not.toBe(before);
  });

  it('switches it back on when the pointer goes up, whatever the renderer says', async () => {
    const screen = mount();
    await laidOut(screen.container);
    const canvas = screen.container.querySelector('[data-graph-canvas]') as HTMLElement;

    // The renderer emits "the viewport started moving" unconditionally and
    // "it stopped" **only if the viewport actually changed** (`viewChanged` in
    // @vue-flow/core@1.48.2). A press and release that moves nothing is
    // therefore a gesture with a start and no end, and the graph quietly stops
    // animating for the rest of the session with nothing in the DOM to say why.
    // A pointer that is no longer down ends every gesture there is.
    await zoom(screen.container, { settle: false });
    await expect.poll(() => canvas.dataset['motion']).toBe('off');

    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    // Restored now, rather than 150 ms from now when the renderer's own end
    // event lands — which is what makes this an assertion about the net.
    expect(canvas.dataset['motion']).toBe('on');
  });

  it('computes it as none under prefers-reduced-motion', async () => {
    const screen = mount();
    await laidOut(screen.container);

    await commands.emulateMedia({ reducedMotion: 'reduce' });
    expect(getComputedStyle(rendered(screen.container)[0] as Element).transitionProperty).toBe(
      'none',
    );
  });
});

suite('AC9 — the three renderer knobs are the facade’s props', () => {
  it('elevates a selected node only when asked to', async () => {
    const raised = mount({ selected: 'n5', elevateNodesOnSelect: true });
    await laidOut(raised.container);
    const elevated = raised.container.querySelector<HTMLElement>('[data-id="n5"]');

    const flat = mount({ selected: 'n5', elevateNodesOnSelect: false });
    await laidOut(flat.container);
    const level = flat.container.querySelector<HTMLElement>('[data-id="n5"]');

    expect(Number(elevated?.style.zIndex ?? 0)).toBeGreaterThan(Number(level?.style.zIndex ?? 0));
  });

  it('renders every node when culling is off and fewer when it is on', async () => {
    const all = mount({ onlyRenderVisibleElements: false, fitViewOnInit: false });
    await laidOut(all.container);

    const culled = mount({ onlyRenderVisibleElements: true, fitViewOnInit: false });
    await expect
      .poll(() => rendered(culled.container).length, { timeout: 15_000 })
      .toBeLessThan(TWELVE.length);
  });

  it('clamps a node to the extent it is given', async () => {
    const screen = mount({
      nodeExtent: [
        [0, 0],
        [10, 10],
      ],
    });
    await laidOut(screen.container);

    await expect
      .poll(
        () =>
          rendered(screen.container).every((element) =>
            /translate\(\s*(?:[0-9]|10)(?:\.\d+)?px,\s*(?:[0-9]|10)(?:\.\d+)?px/.test(
              element.style.transform,
            ),
          ),
        { timeout: 15_000 },
      )
      .toBe(true);
  });

  it('defaults the three from the measurement, not from taste', async () => {
    const { GRAPH_DEFAULTS } = await import('./defaults.ts');
    const screen = mount();
    await laidOut(screen.container);

    // The defaults are a committed measurement's conclusions, and the file
    // they come from names the run that produced them.
    expect(GRAPH_DEFAULTS.measuredBy).toContain('docs/measurements/vue-flow-400.md');
    expect(typeof GRAPH_DEFAULTS.onlyRenderVisibleElements).toBe('boolean');
    expect(typeof GRAPH_DEFAULTS.elevateNodesOnSelect).toBe('boolean');
  });
});

/** The viewport transform the renderer is currently drawing at. */
const transformOf = (container: Element): string =>
  (container.querySelector('.vue-flow__transformationpane') as HTMLElement).style.transform;

/**
 * Zooms the viewport with real wheel events over the pane.
 *
 * A wheel rather than a pointer drag, and for a reason worth recording: the
 * renderer's pan gesture is d3-zoom's, and driving it through the runner's
 * `dragAndDrop` proved to depend on exactly where the two elements' centres
 * landed — a pan of a few pixels starts no gesture at all, and the resulting
 * spec is a coin toss about geometry rather than a statement about motion.
 * A wheel over the pane is the same d3 gesture, the same `moveStart`/`moveEnd`
 * pair and the same `data-motion` transition, and it is deterministic. The
 * drag half of AC7 is covered by the node-drag spec above, with a real pointer.
 */
async function zoom(container: Element, options: { settle?: boolean } = {}): Promise<void> {
  const pane = container.querySelector('.vue-flow__pane') as HTMLElement;
  const box = pane.getBoundingClientRect();
  for (let step = 0; step < 3; step += 1) {
    pane.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
        deltaY: -120,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  // The renderer ends a wheel gesture on a ~150 ms timer; `settle: false` is
  // for the spec that wants to see the middle of one.
  if (options.settle !== false) await new Promise((resolve) => setTimeout(resolve, 400));
}

/**
 * Records every value `data-motion` takes on the canvas across `during`, and
 * for a moment afterwards.
 *
 * The transition is switched off *while* something is happening, so the state
 * that matters is gone by the time the interaction resolves — a mutation
 * observer is the only honest way to see it, where polling would sample a
 * few-hundred-millisecond window at whatever rate the runner felt like. The
 * tail matters as much as the middle: the renderer's "the viewport stopped
 * moving" event lands after the pointer is up, so the observer stays attached
 * until motion comes back on rather than closing on the next frame.
 */
async function watchMotion(container: Element, during: () => Promise<void>): Promise<string[]> {
  const canvas = container.querySelector('[data-graph-canvas]') as HTMLElement;
  const seen: string[] = [canvas.dataset['motion'] ?? ''];
  const observer = new MutationObserver(() => {
    const value = canvas.dataset['motion'] ?? '';
    if (seen.at(-1) !== value) seen.push(value);
  });
  observer.observe(canvas, { attributes: true, attributeFilter: ['data-motion'] });
  try {
    await during();
    await expect.poll(() => seen.at(-1), { timeout: 5_000 }).toBe('on');
  } finally {
    observer.disconnect();
  }
  return seen;
}
