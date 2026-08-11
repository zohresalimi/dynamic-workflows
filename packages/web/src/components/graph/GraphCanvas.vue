<script setup lang="ts">
/**
 * KAR-16.6 — the graph facade. **The only file in `packages/web/src` that
 * imports `@vue-flow/core`.**
 *
 * Verifies: EPIC-16-S35, EPIC-16-S39, EPIC-16-S40 · AC1, AC2, AC7, AC8, AC9
 *
 * Vue Flow is the single largest third-party risk in this frontend (A3-1,
 * **High**): last npm release 2026-01-28, effectively one maintainer, an
 * unreleased `next-release` branch, no announced v2, no Vue 3.6 compatibility
 * statement. It is alive but slow. This file costs about a day and turns
 * "replace the renderer" from a rewrite into a one-file change — which is also
 * what lets the memory graph (F10.4) swap to `sigma` + `graphology`, comfortable
 * into the tens of thousands of nodes, without touching the plan graph.
 *
 * `packages/web/scripts/check-graph-facade.ts` is the rule that keeps that true,
 * and it runs in `pnpm lint`.
 *
 * ## The surface
 *
 * In: `PlanNodeVM[]` and `PlanEdgeVM[]` — the projection's own view-models, in
 * **ledger-insertion order**, because that order is what keeps the layout
 * stable across a replan (`./layout.ts`). Out: `select` and `activate`, both
 * carrying a node id, and `laid-out` carrying how long ELK took. A node body is
 * the caller's `#node` slot: per-node live status, streaming badge, gate
 * verdict and cost are Vue components, which is the reason Vue Flow was chosen
 * over the canvas-first alternatives in the first place.
 *
 * No Vue Flow type appears in any of that.
 *
 * ## Motion
 *
 * One CSS rule in `../../styles/theme.css` — `transition: transform 200ms
 * ease-out` on `.vue-flow__node` — and **no code here writes a transform**.
 * That is not a style preference: Vue Flow writes an inline `transform` on
 * every node on every frame, so a bespoke `translate3d` animation is overwritten
 * intermittently rather than reliably, which is the worst kind of bug to
 * diagnose (docs/12 §6.1, corrected). `data-motion` on the root switches the
 * transition off while a node is dragged and while the viewport moves, because
 * a transition fighting a drag feels like input lag.
 *
 * ## Accessibility
 *
 * `disableKeyboardA11y` is **not** set, and it is not an oversight that it is
 * missing — it is the quickest way to stop Vue Flow's key handling conflicting
 * with the app's `j`/`k` map, and docs/12 §9.3 says plainly not to. The
 * conflict is resolved in the keymap. Every node carries an `ariaLabel` built
 * from the view-model, the drawing carries a `<title>`, and a toggleable table
 * lists the same graph in a form a non-visual reader can read top to bottom —
 * which doubles as the copy-into-a-PR-description surface.
 */
import {
  type CoordinateExtent,
  type NodeMouseEvent,
  VueFlow,
  type VueFlowStore,
} from '@vue-flow/core';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { PlanNodeVM } from '../../ledger/vm.ts';
import { GRAPH_DEFAULTS } from './defaults.ts';
import type { GraphLayout, LayoutEngine } from './layout.ts';
import {
  ariaLabelOf,
  type GraphCanvasEmits,
  type GraphCanvasProps,
  type GraphCanvasSlots,
  type NodePlacement,
} from './types.ts';

/**
 * How far out the viewport may zoom.
 *
 * The renderer's own default is `0.5`, and on a real plan that makes "fit the
 * view" a lie: a twelve-node chain is already ~3,400 px wide, so the fit is
 * clamped and the first node sits off the left edge of the pane, unreachable by
 * pointer and invisible to a screenshot. A plan graph is wide by nature — this
 * is a DAG of work, not a mind map — so the floor is low enough that the fit is
 * a fit.
 */
const MIN_ZOOM = 0.05;

// Only the three that have a *value* to default to. `costs`, `positions` and
// `nodeExtent` are absent-or-given, and `withDefaults` wants a factory rather
// than a literal `undefined` for an object-typed prop — a default that would
// only restate what optional already means.
const props = withDefaults(defineProps<GraphCanvasProps>(), {
  selected: null,
  onlyRenderVisibleElements: GRAPH_DEFAULTS.onlyRenderVisibleElements,
  elevateNodesOnSelect: GRAPH_DEFAULTS.elevateNodesOnSelect,
  fitViewOnInit: true,
});

const emit = defineEmits<GraphCanvasEmits>();

defineSlots<GraphCanvasSlots>();

/**
 * The layout, or `null` before the first one lands.
 *
 * `shallowRef` because it is replaced wholesale and holds a `Map` of 400
 * entries: deep reactivity over that is the single most likely way to miss NF3
 * (docs/12 §4).
 */
const layout = shallowRef<GraphLayout | null>(null);
const motion = ref<'on' | 'off'>('on');
const tableOpen = ref(false);

let engine: LayoutEngine | null = null;
/** Which layout run is current; a slower earlier one must not land after it. */
let generation = 0;

/**
 * The renderer's own store, held only to fit the view — see `fitNow`. It never
 * leaves this file, which is what keeps the facade's surface DeFlow's.
 */
let flow: VueFlowStore | null = null;

/**
 * Fits the viewport around the graph, once the nodes have been **measured**.
 *
 * `fitViewOnInit` alone is not enough here and the failure is quiet: the canvas
 * renders no nodes at all until the first layout lands, so "on init" fits an
 * empty graph and the drawing arrives partly off-screen — on a 12-node chain,
 * the first node sits several hundred pixels to the left of the pane, visible
 * to nobody and reachable by no pointer. `nodesInitialized` is the event that
 * means "every node has a measured box", which is the earliest moment a fit can
 * be correct.
 */
function onInit(instance: VueFlowStore): void {
  flow = instance;
}

function fitNow(): void {
  if (props.fitViewOnInit) flow?.fitView({ padding: 0.12 });
}

/** Where each node goes: the caller's positions, or the layout's, or none yet. */
const placement = computed<NodePlacement | null>(
  () => props.positions ?? layout.value?.positions ?? null,
);

/**
 * The renderer's nodes.
 *
 * Empty until there is a placement, deliberately: a graph that paints at the
 * origin and then jumps into place reports a first paint that is not the first
 * paint of the graph, and AC3's number is exactly that measurement.
 */
const flowNodes = computed(() => {
  const at = placement.value;
  if (at === null) return [];
  return props.nodes.map((node, index) => {
    const position = at.get(node.id);
    return {
      id: node.id,
      type: 'plan' as const,
      position: { x: position?.x ?? 0, y: position?.y ?? index * 96 },
      ariaLabel: ariaLabelOf(node),
      selected: node.id === props.selected,
      data: node,
    };
  });
});

/**
 * The renderer's edges — and, like the nodes, nothing at all until there is a
 * placement. An edge whose endpoints have not been handed over yet is not
 * drawn, it is *warned about*, once per edge per render, into a console nobody
 * reads.
 */
const flowEdges = computed(() =>
  placement.value === null
    ? []
    : props.edges.map((edge) => ({
        id: edge.id,
        source: edge.from,
        target: edge.to,
        class: `plan-edge plan-edge--${edge.kind}`,
        ariaLabel: `${edge.kind} edge from ${edge.from} to ${edge.to}`,
      })),
);

/**
 * `nodeExtent`, bound only when there is one.
 *
 * Under `exactOptionalPropertyTypes` the renderer's prop does not admit
 * `undefined`, and passing it anyway is a type error rather than the "absent"
 * it means at runtime — so an absent extent is an absent *binding*.
 */
const extent = computed<{ nodeExtent?: CoordinateExtent }>(() =>
  props.nodeExtent === undefined
    ? {}
    : { nodeExtent: props.nodeExtent as unknown as CoordinateExtent },
);

const isSelected = (node: PlanNodeVM): boolean => node.id === props.selected;
const costOf = (node: PlanNodeVM): string => props.costs?.get(node.id) ?? 'not priced';

/** Re-lays the graph out. Off the main thread; see `./layout.ts`. */
async function relayout(): Promise<void> {
  if (props.positions !== undefined) return;
  const mine = (generation += 1);

  if (engine === null) {
    // Dynamic, so `elkjs` is in a chunk of its own rather than in the initial
    // one the landing view pays for — AC5, and the budget
    // `packages/web/test/integration/bundle-budget.test.ts` holds.
    const { createLayoutEngine } = await import('./layout.ts');
    if (engine === null) engine = createLayoutEngine();
  }

  try {
    const next = await engine.layout(props.nodes, props.edges);
    if (mine !== generation) return;
    layout.value = next;
    emit('laid-out', { ms: next.ms, nodes: next.positions.size });
  } catch (cause) {
    // A worker that failed to start must degrade to a readable graph rather
    // than to a blank panel: a column is a poor drawing and an honest one.
    if (mine !== generation) return;
    console.warn('[graph] layout failed; falling back to a column', cause);
    layout.value = {
      positions: new Map(
        props.nodes.map((node, index) => [
          node.id,
          { id: node.id, x: 0, y: index * 96, width: 224, height: 84 },
        ]),
      ),
      width: 224,
      height: props.nodes.length * 96,
      ms: 0,
    };
  }
}

watch(
  () => [props.nodes, props.edges] as const,
  () => {
    void relayout();
  },
);

onMounted(() => {
  void relayout();
});

onBeforeUnmount(() => {
  // The worker outlives the component otherwise, and an orphaned worker is one
  // of the four things EPIC-16-S27's soak counts.
  engine?.dispose();
  engine = null;
});

/**
 * Selection follows focus.
 *
 * Vue Flow makes every node focusable and Tab-traversable for free — that is
 * the a11y that must not be undone — but focusing a node is not selecting it,
 * and a keyboard operator who cannot see which node they are on has traversal
 * without navigation.
 */
function onFocusIn(event: FocusEvent): void {
  const id = (event.target as HTMLElement | null)?.closest<HTMLElement>('.vue-flow__node')?.dataset[
    'id'
  ];
  if (id !== undefined && id !== props.selected) emit('select', id);
}

/**
 * The safety net under `data-motion`.
 *
 * The renderer emits `moveStart` unconditionally when a pan gesture begins and
 * `moveEnd` **only if the viewport actually changed** (`viewChanged(...)` in
 * `@vue-flow/core@1.48.2`). So a press-and-release on the pane, or a drag that
 * ends where it started, switches the transition off and never switches it back
 * on — a graph that has quietly stopped animating for the rest of the session,
 * with nothing in the DOM to say why. A pointer that is no longer down is the
 * end of every gesture there is, so that is what restores it.
 */
function endGesture(): void {
  motion.value = 'on';
}

onMounted(() => {
  window.addEventListener('pointerup', endGesture);
  window.addEventListener('pointercancel', endGesture);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerup', endGesture);
  window.removeEventListener('pointercancel', endGesture);
});

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter') return;
  const id = (event.target as HTMLElement | null)?.closest<HTMLElement>('.vue-flow__node')?.dataset[
    'id'
  ];
  if (id !== undefined) emit('activate', id);
}
</script>

<template>
  <section
    class="graph-canvas"
    data-graph-canvas
    :data-motion="motion"
    :aria-label="`Plan graph, ${props.nodes.length} nodes`"
    @focusin="onFocusIn"
    @keydown="onKeydown"
  >
    <VueFlow
      :nodes="flowNodes"
      :edges="flowEdges"
      :fit-view-on-init="props.fitViewOnInit"
      :only-render-visible-elements="props.onlyRenderVisibleElements"
      :elevate-nodes-on-select="props.elevateNodesOnSelect"
      v-bind="extent"
      :min-zoom="MIN_ZOOM"
      @init="onInit"
      @nodes-initialized="fitNow"
      @node-click="({ node }: NodeMouseEvent) => emit('select', node.id)"
      @node-double-click="({ node }: NodeMouseEvent) => emit('activate', node.id)"
      @node-drag-start="motion = 'off'"
      @node-drag-stop="motion = 'on'"
      @move-start="motion = 'off'"
      @move-end="motion = 'on'"
    >
      <template #node-plan="{ data }">
        <slot name="node" :node="data as PlanNodeVM" :selected="isSelected(data as PlanNodeVM)">
          <!--
            The default body exists so the canvas is never a grid of blank
            boxes when a view forgets the slot; every real view supplies one.
          -->
          <article class="graph-node">
            <h3 class="graph-node__title">{{ (data as PlanNodeVM).title }}</h3>
            <span class="graph-node__state">{{ (data as PlanNodeVM).state }}</span>
          </article>
        </slot>
      </template>
    </VueFlow>

    <!--
      The drawing, described. A screen reader meets a titled graphic rather than
      a nameless region full of buttons; the table below is the readable form.
    -->
    <svg
      class="graph-canvas__caption"
      role="img"
      :aria-label="`Plan graph, ${props.nodes.length} nodes and ${props.edges.length} edges`"
    >
      <title>Plan graph: {{ props.nodes.length }} nodes, {{ props.edges.length }} edges</title>
    </svg>

    <button
      class="graph-canvas__table-toggle"
      type="button"
      data-graph-table-toggle
      :aria-expanded="tableOpen"
      @click="tableOpen = !tableOpen"
    >
      {{ tableOpen ? 'Hide the node table' : 'Show the node table' }}
    </button>

    <table v-if="tableOpen" class="graph-canvas__table" data-graph-table>
      <caption>
        Every node in this plan, with its state, provider and cost.
      </caption>
      <thead>
        <tr>
          <th scope="col">Node</th>
          <th scope="col">State</th>
          <th scope="col">Provider</th>
          <th scope="col">Cost</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="node in props.nodes" :key="node.id" :data-table-node="node.id">
          <th scope="row">{{ node.title }}</th>
          <td>{{ node.state }}</td>
          <td>{{ node.provider ?? 'no provider yet' }}</td>
          <td>{{ costOf(node) }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<style scoped>
/*
 * `display: grid` with one row, rather than a plain block, and that is
 * load-bearing: Vue Flow's own sheet sizes `.vue-flow` at `height: 100%`, and a
 * percentage height against a parent whose own height is `100%` of an auto
 * parent resolves to `auto` — which is zero, which renders nothing and warns
 * *"the Vue Flow parent container needs a width and a height"* into a console
 * nobody is reading. A grid row is a definite size, so the child has one.
 */
.graph-canvas {
  position: relative;
  display: grid;
  grid-template-rows: 1fr;
  height: 100%;
  min-height: 24rem;
}

/*
 * Absolutely positioned and pointer-transparent: it describes the drawing, it
 * does not draw. Zero-sized would drop it out of the accessibility tree in
 * some engines, which is the one thing it exists for.
 */
.graph-canvas__caption {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.graph-canvas__table-toggle {
  position: absolute;
  right: 0.5rem;
  bottom: 0.5rem;
  z-index: 5;
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--edge);
  border-radius: 999px;
  background: var(--surface-raised);
  color: inherit;
  font-size: 0.8125rem;
}

.graph-canvas__table {
  position: absolute;
  inset: auto 0.5rem 2.5rem 0.5rem;
  z-index: 5;
  max-height: 60%;
  overflow: auto;
  border: 1px solid var(--edge);
  border-radius: 0.5rem;
  background: var(--surface-raised);
  border-collapse: collapse;
  font-size: 0.8125rem;
}

.graph-canvas__table th,
.graph-canvas__table td {
  padding: 0.2rem 0.5rem;
  text-align: left;
  border-bottom: 1px solid var(--edge);
}

.graph-node {
  display: grid;
  gap: 0.35rem;
  padding: 0.6rem 0.75rem;
  border: 2px solid var(--edge);
  border-radius: 0.5rem;
  background: var(--surface-raised);
  min-width: 12rem;
  text-align: left;
}

.graph-node__title {
  font-size: 0.9rem;
  font-weight: 600;
}

/*
 * The node transition itself is NOT here. It lives in ../../styles/theme.css,
 * after that file's `@import` of Vue Flow's own sheet, because a scoped
 * `:deep()` rule would have to out-specify a third-party stylesheet whose
 * import order this component does not control — and "the media query wraps the
 * wrong rule" is precisely the failure the reduced-motion spec is written
 * against.
 */
</style>
