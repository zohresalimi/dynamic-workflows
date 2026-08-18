/**
 * KAR-24.5 — the canvas's own chrome, in direction A's language, in a real
 * Chromium.
 *
 * Verifies: EPIC-24-S19, EPIC-24-S22 · AC5
 *
 * `GraphCanvas.test.ts` is the facade's behavioural contract and stays
 * unmodified by this story; this file is the restyle's own contract, for the
 * three things AC5 adds that file has no reason to know about: the dot grid,
 * the zoom pill, and an edge's motion. Real Chromium and not jsdom, for the
 * same reason as its neighbour — `getComputedStyle`'s `background-image` and
 * an SVG edge's classList are both things jsdom fails silently rather than
 * usefully (docs/14 §13).
 *
 * What this file does **not** re-litigate: whether Vue Flow's own keyboard
 * a11y survives (`GraphCanvas.test.ts`, EPIC-16-S40), whether the minimap and
 * the fit-view button still work (`live-graph.test.ts`, EPIC-16-S1 — and the
 * reason the zoom-in/zoom-out buttons below keep their original
 * `.vue-flow__controls-*` class names rather than a new one of this story's
 * own), or reduced motion (`../../app/reduced-motion.test.ts`, AC4). Those
 * specs are named here so a reader who came looking for "does the graph still
 * work" knows where the rest of the answer lives.
 */
import { afterEach, expect, it, describe as suite } from 'vitest';
import { render } from 'vitest-browser-vue';
import type { PlanEdgeVM, PlanNodeVM } from '../../ledger/vm.ts';
import type { DisplayState } from '../../lib/state-palette.ts';
import '../../styles/theme.css';
import GraphCanvas from './GraphCanvas.vue';

function node(id: string, state: DisplayState): PlanNodeVM {
  return {
    id,
    title: `title of ${id}`,
    type: 'implement',
    lifecycle: 'active',
    status: 'running',
    state,
    provider: 'claude-code',
    model: null,
    permission: null,
    pathScopes: null,
    worktree: null,
    binary: null,
    attempt: 1,
    phase: null,
    progressMessage: null,
    result: null,
    failure: null,
    failures: [],
    suspendedUntil: null,
    blocked: null,
    retry: null,
    unschedulable: null,
  };
}

const edge = (from: string, to: string): PlanEdgeVM => ({
  id: `${from}->${to}`,
  from,
  to,
  kind: 'control',
  carries: [],
});

/**
 * A three-node chain with one edge feeding a running node and one feeding a
 * node that has not started — AC5's two named edge treatments, both present
 * in the one graph a reader has to hold in their head.
 */
const NODES = [node('n0', 'passed'), node('n1', 'running'), node('n2', 'pending')];
const EDGES = [edge('n0', 'n1'), edge('n1', 'n2')];

function mount() {
  return render(GraphCanvas, {
    props: { nodes: NODES, edges: EDGES },
    slots: {
      node: `<template #node="{ node }">
        <article class="test-node" :data-node="node.id" />
      </template>`,
    },
  });
}

async function laidOut(container: Element, count = NODES.length): Promise<void> {
  await expect
    .poll(() => container.querySelectorAll('.vue-flow__node').length, { timeout: 15_000 })
    .toBe(count);
}

/** Every rendered edge's outer `<g>`, keyed by the `id` the facade gave it. */
function edgeElement(container: Element, id: string): Element | null {
  return container.querySelector(`.vue-flow__edge[data-id="${id}"]`);
}

afterEach(() => {
  // No `commands.emulateMedia({})` reset here (unlike its neighbours): this
  // file never emulates a media feature, so there is nothing to put back.
});

suite('AC5 — the dot grid', () => {
  it('paints direction A’s grid behind the pane, without a new dependency', async () => {
    const screen = mount();
    await laidOut(screen.container);

    const canvas = screen.container.querySelector('[data-graph-dot-grid]');
    expect(canvas).not.toBeNull();

    const style = getComputedStyle(canvas as Element);
    expect(style.backgroundImage).toContain('radial-gradient');
    // 22px both ways — direction A's own pitch, not a rounder number invented
    // for this restyle.
    expect(style.backgroundSize).toBe('22px 22px');
  });
});

suite('AC5 — the zoom pill', () => {
  it('gives zoom in and zoom out real buttons with accessible names', async () => {
    const screen = mount();
    await laidOut(screen.container);

    const zoomIn = screen.container.querySelector('.vue-flow__controls-zoomin');
    const zoomOut = screen.container.querySelector('.vue-flow__controls-zoomout');

    expect(zoomIn?.tagName).toBe('BUTTON');
    expect(zoomOut?.tagName).toBe('BUTTON');
    expect(zoomIn?.getAttribute('aria-label')).toBe('Zoom in');
    expect(zoomOut?.getAttribute('aria-label')).toBe('Zoom out');

    // AC5's own fit-view carry-over: `live-graph.test.ts` already drives this
    // button, so this file only confirms the restyle left it a real button
    // rather than re-asserting that it works.
    expect(screen.container.querySelector('.vue-flow__controls-fitview')?.tagName).toBe('BUTTON');
  });

  it('reports the zoom level, and pressing + changes what it reports', async () => {
    const screen = mount();
    await laidOut(screen.container);

    const label = () => screen.container.querySelector('[data-graph-zoom-value]')?.textContent;
    await expect.poll(label).toMatch(/^\d+%$/);
    const before = label();

    // A plain DOM `.click()` and not `userEvent.click()`: the latter drives a
    // real Playwright pointer to the button's screen position and leaves it
    // parked there, and this slice's `fileParallelism: false` keeps every
    // spec file on the one browser page — so a later file's own small graph
    // can lay an edge label down under that exact pixel and read a spurious
    // `:hover` on mount, for a reason that has nothing to do with that file.
    // A synthetic click dispatches the same trusted event Vue's `@click`
    // listens for, without moving anything real.
    (screen.container.querySelector('.vue-flow__controls-zoomin') as HTMLButtonElement).click();

    await expect.poll(label).not.toBe(before);
  });

  it('reports the zoom level changing the other way on −, too', async () => {
    const screen = mount();
    await laidOut(screen.container);

    const label = () => screen.container.querySelector('[data-graph-zoom-value]')?.textContent;
    await expect.poll(label).toMatch(/^\d+%$/);
    const before = label();

    (screen.container.querySelector('.vue-flow__controls-zoomout') as HTMLButtonElement).click();

    await expect.poll(label).not.toBe(before);
  });
});

suite('AC5 — an edge’s motion', () => {
  it('gives the edge feeding the running node dashrun, animated, and the motion token', async () => {
    const screen = mount();
    await laidOut(screen.container);

    await expect
      .poll(() => edgeElement(screen.container, 'n0->n1'), { timeout: 15_000 })
      .not.toBeNull();
    const element = edgeElement(screen.container, 'n0->n1') as Element;

    expect(element.classList.contains('plan-edge--running')).toBe(true);
    expect(element.classList.contains('animated')).toBe(true);
    expect(element.hasAttribute('data-motion-token')).toBe(true);

    const path = element.querySelector('.vue-flow__edge-path') as Element;
    const style = getComputedStyle(path);
    expect(style.animationName).toBe('dashrun');
  });

  it('leaves the edge feeding the not-yet-started node inert and undashed-run', async () => {
    const screen = mount();
    await laidOut(screen.container);

    await expect
      .poll(() => edgeElement(screen.container, 'n1->n2'), { timeout: 15_000 })
      .not.toBeNull();
    const element = edgeElement(screen.container, 'n1->n2') as Element;

    expect(element.classList.contains('plan-edge--pending')).toBe(true);
    expect(element.classList.contains('animated')).toBe(false);
    expect(element.hasAttribute('data-motion-token')).toBe(false);

    const path = element.querySelector('.vue-flow__edge-path') as Element;
    const style = getComputedStyle(path);
    expect(style.animationName).not.toBe('dashrun');
  });
});
