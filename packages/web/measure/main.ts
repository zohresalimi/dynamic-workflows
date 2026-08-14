/**
 * KAR-16.6 AC3/AC4 — the page `pnpm measure:graph` measures.
 *
 * A harness, not a view, and deliberately outside `../src`: it is not part of
 * the shipped SPA and must not enter its bundle, its budget or its route table.
 * What it *does* use is the shipping code — the real `plan.ts` projection over
 * real recorded events, the real `GraphCanvas`, the real ELK worker — because a
 * measurement of a simplified page is a measurement of a page nobody runs.
 *
 * The events arrive from a real `deflow replay stress-400 --speed max` daemon.
 * They are fetched by the script rather than by this page and handed over
 * through `window.__deflowMeasure.render`, for one boring reason: the harness is
 * served from a static origin of its own, the daemon validates `Origin`, and a
 * cross-origin fetch would be measuring CORS. The bytes are the daemon's
 * either way.
 *
 * Everything this file exposes is a *measurement*, never an assertion: what is
 * a regression and what is jitter is the spec's call
 * (`e2e/measure-graph.test.ts`), and the numbers are recorded in
 * `docs/measurements/vue-flow-400.md`.
 */
import { type Event, parseEvent } from '@DeFlow/core';
import { createApp, defineComponent, h, shallowRef } from 'vue';
import GraphCanvas from '../src/components/graph/GraphCanvas.vue';
import MemoryNode from '../src/components/graph/MemoryNode.vue';
import { applyBlackboard, emptyBlackboard } from '../src/ledger/projections/blackboard.ts';
import { type MemoryNodeVM, memoryGraph } from '../src/ledger/projections/memory-graph.ts';
import { applyPlan, emptyPlan } from '../src/ledger/projections/plan.ts';
import type { PlanEdgeVM, PlanNodeVM } from '../src/ledger/vm.ts';
import type {
  DrawnGraph,
  MeasureApi,
  MeasureGlobal,
  MemoryRenderRequest,
  MemoryRenderResult,
  RenderRequest,
  RenderResult,
} from './api.ts';
import '../src/styles/theme.css';

const container = document.querySelector('#canvas') as HTMLElement;
let unmount: (() => void) | null = null;

/** The plan, folded from the recording exactly as a tab folds it. */
function planOf(events: readonly unknown[]): {
  nodes: PlanNodeVM[];
  edges: PlanEdgeVM[];
  unreadable: number;
} {
  const state = emptyPlan();
  let unreadable = 0;
  for (const raw of events) {
    const parsed = parseEvent(raw);
    if (parsed.status !== 'ok') {
      unreadable += 1;
      continue;
    }
    applyPlan(state, parsed.event as Event);
  }
  // Map iteration order is insertion order, and insertion order here is the
  // ledger's — which is the input the layout's stability depends on.
  return { nodes: [...state.nodes.values()], edges: [...state.edges.values()], unreadable };
}

/**
 * KAR-17.9 row 7 — the blackboard, folded and aggregated the way the memory
 * view does it.
 *
 * The same `parseEvent`, the same projection, the same selector, the same
 * `GraphCanvas`. The only thing this does not use is `MemoryGraphView` itself,
 * because the view owns a route, a store and a request to a daemon — none of
 * which is what row 7 is asking about. What it is asking about is whether the
 * *drawing* survives the renderer being replaced.
 */
function memoryOf(
  events: readonly unknown[],
  expand: string | undefined,
): { nodes: MemoryNodeVM[]; edges: PlanEdgeVM[]; facts: number; drawnFacts: number } {
  const board = emptyBlackboard();
  for (const raw of events) {
    const parsed = parseEvent(raw);
    if (parsed.status === 'ok') applyBlackboard(board, parsed.event as Event);
  }
  const graph = memoryGraph(board, {
    expanded: new Set(expand === undefined ? [] : [expand]),
  });
  return {
    nodes: [...graph.nodes],
    edges: [...graph.edges],
    facts: graph.facts,
    drawnFacts: graph.drawnFacts,
  };
}

let frames: number[] = [];
let ticking = 0;

const api: MeasureApi = {
  async render(request: RenderRequest): Promise<RenderResult> {
    unmount?.();
    const plan = planOf(request.events);
    const nodes = request.limit === undefined ? plan.nodes : plan.nodes.slice(0, request.limit);
    const keep = new Set(nodes.map((node) => node.id));
    const edges = plan.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to));

    const started = performance.now();
    const layoutMs = shallowRef<number | null>(null);

    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(GraphCanvas, {
              nodes,
              edges,
              onlyRenderVisibleElements: request.onlyRenderVisibleElements,
              onLaidOut: (detail: { ms: number }) => {
                layoutMs.value ??= detail.ms;
              },
            });
        },
      }),
    );
    app.mount(container);
    unmount = () => {
      app.unmount();
      unmount = null;
    };

    // First paint of the **full** graph: every node the plan holds, on screen.
    // With culling on that is by definition fewer than every node, so the wait
    // is for the layout plus one frame instead.
    const wanted = request.onlyRenderVisibleElements ? 1 : nodes.length;
    await painted(wanted);
    const firstPaintMs = performance.now() - started;

    return {
      nodes: nodes.length,
      edges: edges.length,
      layoutMs: layoutMs.value ?? 0,
      firstPaintMs,
      unreadableEvents: plan.unreadable,
    };
  },

  async renderMemory(request: MemoryRenderRequest): Promise<MemoryRenderResult> {
    unmount?.();
    const graph = memoryOf(request.events, request.expand);
    const bodies = new Map(graph.nodes.map((node) => [node.id, node] as const));

    const app = createApp(
      defineComponent({
        setup() {
          return () =>
            h(
              GraphCanvas,
              { nodes: graph.nodes, edges: graph.edges, onlyRenderVisibleElements: false },
              {
                node: ({ node, selected }: { node: PlanNodeVM; selected: boolean }) => {
                  const body = bodies.get(node.id);
                  return body === undefined ? null : h(MemoryNode, { node: body, selected });
                },
              },
            );
        },
      }),
    );
    app.mount(container);
    unmount = () => {
      app.unmount();
      unmount = null;
    };

    await painted(graph.nodes.length);

    const drawn = [...container.querySelectorAll('[data-memory-node]')];
    return {
      facts: graph.facts,
      drawn: drawn.length,
      drawnFacts: graph.drawnFacts,
      kinds: drawn.map((node) => node.getAttribute('data-memory-kind') ?? ''),
      renderer:
        container.querySelector('[data-graph-canvas]')?.getAttribute('data-renderer') ?? 'vue-flow',
      firstLabel: container.querySelector('.vue-flow__node')?.getAttribute('aria-label') ?? '',
    };
  },

  startFrames(): void {
    frames = [];
    let previous = performance.now();
    const step = (now: number): void => {
      frames.push(now - previous);
      previous = now;
      ticking = requestAnimationFrame(step);
    };
    ticking = requestAnimationFrame(step);
  },

  stopFrames(): number[] {
    cancelAnimationFrame(ticking);
    // The first interval spans the gap between `startFrames` and the first
    // frame, which is scheduling latency rather than rendering cost.
    return frames.slice(1);
  },

  /**
   * What reached the DOM, answered **here**.
   *
   * The e2e slice compiles without the DOM lib, so a spec cannot read a node's
   * `aria-label` for itself without either widening that config or casting its
   * way through `globalThis`. Answering in the page and handing back data is
   * the convention `e2e/spike-s3-elk-worker.test.ts` set, and it also means the
   * spec asserts on the same DOM the measurement walked.
   */
  drawn(): DrawnGraph {
    const nodes = [...container.querySelectorAll('.vue-flow__node')];
    const first = nodes[0];
    return {
      count: nodes.length,
      firstLabel: first?.getAttribute('aria-label') ?? '',
      firstTitle: first?.querySelector('h3')?.textContent ?? '',
      renderer:
        container.querySelector('[data-graph-canvas]')?.getAttribute('data-renderer') ?? 'vue-flow',
    };
  },
};

(globalThis as unknown as MeasureGlobal).__deflowMeasure = api;

/** Resolves once at least `wanted` nodes are in the DOM and a frame has run. */
function painted(wanted: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = performance.now() + 120_000;
    const check = (): void => {
      const drawn = container.querySelectorAll('.vue-flow__node').length;
      if (drawn >= wanted) {
        requestAnimationFrame(() => resolve());
        return;
      }
      if (performance.now() > deadline) {
        reject(new Error(`only ${String(drawn)} of ${String(wanted)} nodes were drawn`));
        return;
      }
      requestAnimationFrame(check);
    };
    check();
  });
}
