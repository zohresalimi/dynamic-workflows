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
import { Controls } from '@vue-flow/controls';
import '@vue-flow/controls/dist/style.css';
import {
  type CoordinateExtent,
  MarkerType,
  type NodeMouseEvent,
  VueFlow,
  type VueFlowStore,
} from '@vue-flow/core';
import { MiniMap } from '@vue-flow/minimap';
import '@vue-flow/minimap/dist/style.css';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { PlanEdgeVM, PlanNodeVM } from '../../ledger/vm.ts';
import { GRAPH_DEFAULTS } from './defaults.ts';
import type { GraphLayout, LayoutEngine } from './layout.ts';
// A value import, and from `./node-size.ts` rather than from `./layout.ts` on
// purpose: the latter pulls `elkjs` into whatever chunk imports it, and this
// file reaches the layout engine through a dynamic `import()` for exactly that
// reason. See the note in `./node-size.ts`.
import { COLUMN_STRIDE, NODE_SIZE } from './node-size.ts';
import {
  ariaLabelOf,
  type Extent,
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

/**
 * How far outside the drawing a node may be dragged, in world pixels.
 *
 * KAR-17.1 AC9's *"prevents the graph being panned into empty space and lost"*.
 * The bound is derived from the layout rather than configured, because the only
 * honest edge of a plan graph is the plan: a constant would be too tight on a
 * 400-node fan-out and pointless on a three-node chain. It is deliberately
 * loose — a node has to be draggable clear of its neighbours to be reorganised
 * by hand — and its job is to stop a drag or a pan ending somewhere with no
 * landmark in any direction, not to keep the drawing tidy.
 */
const EXTENT_PADDING = 400;

/**
 * How far the *viewport* may travel past the same box.
 *
 * `nodeExtent` bounds where nodes may be; it says nothing about where the
 * camera may point, and "panned into empty space" is a statement about the
 * camera. Vue Flow's knob for that is `translateExtent`, so AC9 needs both, and
 * this one is generous on purpose: roughly a graph's width of blank on every
 * side, so there is always somewhere to put a node down and never an infinite
 * plane to get lost on.
 */
const TRAVEL_PADDING = 1000;

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
 * The selected node's immediate neighbourhood — everything one edge away.
 *
 * KAR-17.1 AC7. Both directions, because *"what fed this node"* is the first
 * question an operator asks of a bad node and *"what did it feed"* is the
 * second, and a highlight that only followed the arrows would answer one of
 * them. Empty when nothing is selected, which is what makes "dim the rest" a
 * no-op rather than a graph that starts out half faded.
 */
const neighbourhood = computed<ReadonlySet<string>>(() => {
  const selected = props.selected;
  if (selected === null || selected === undefined) return new Set();
  const near = new Set<string>();
  for (const edge of props.edges) {
    if (edge.from === selected) near.add(edge.to);
    if (edge.to === selected) near.add(edge.from);
  }
  return near;
});

/** Selected / one edge away / everything else — or nothing at all. */
function proximityOf(nodeId: string): string {
  if (props.selected === null || props.selected === undefined) return '';
  if (nodeId === props.selected) return ' is-selected';
  return neighbourhood.value.has(nodeId) ? ' is-neighbour' : ' is-distant';
}

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
      position: { x: position?.x ?? 0, y: position?.y ?? index * COLUMN_STRIDE },
      ariaLabel: ariaLabelOf(node),
      selected: node.id === props.selected,
      class: `plan-node-shell${proximityOf(node.id)}`,
      data: node,
    };
  });
});

/**
 * What an edge says it carries — F10.1's *"edges labelled with what flows"*.
 *
 * `carries[]` is a field on the projection's edge, populated for `kind: 'data'`
 * (docs/04 §3), so this is a rendering of real data rather than a label
 * invented here. A control edge gets **no label element at all**: an empty one
 * would still draw a background chip on the drawing and would still be read
 * out, and "this edge carries nothing" is not a thing a control edge needs to
 * say — carrying nothing is what a control edge *is*.
 */
const carriedBy = (edge: PlanEdgeVM): string | undefined =>
  edge.kind === 'data' && edge.carries.length > 0 ? edge.carries.join(', ') : undefined;

/**
 * The renderer's edges — and, like the nodes, nothing at all until there is a
 * placement. An edge whose endpoints have not been handed over yet is not
 * drawn, it is *warned about*, once per edge per render, into a console nobody
 * reads.
 */
const flowEdges = computed(() =>
  placement.value === null
    ? []
    : props.edges.map((edge) => {
        const carries = carriedBy(edge);
        const adjacent =
          props.selected !== null &&
          props.selected !== undefined &&
          (edge.from === props.selected || edge.to === props.selected);
        return {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          class: `plan-edge plan-edge--${edge.kind}${adjacent ? ' is-adjacent' : ''}`,
          // AC1's *"every edge with its direction"*. A DAG drawn without arrow
          // heads is a picture of a graph with no dependencies in it, which is
          // the one thing this drawing exists to show.
          markerEnd: MarkerType.ArrowClosed,
          ...(carries === undefined ? {} : { label: carries }),
          ariaLabel:
            carries === undefined
              ? `${edge.kind} edge from ${edge.from} to ${edge.to}`
              : `${edge.kind} edge from ${edge.from} to ${edge.to}, carries ${carries}`,
        };
      }),
);

/**
 * The world, as a pair of corners — the caller's if it stated one, and
 * otherwise the drawing's own bounding box with room to move around it.
 *
 * `null` until the first layout lands: an extent derived from no positions is
 * a point at the origin, and binding *that* pins every node to 0,0 before the
 * graph has been drawn once.
 */
const world = computed<Extent | null>(() => {
  if (props.nodeExtent !== undefined) return props.nodeExtent;
  const at = placement.value;
  if (at === null || at.size === 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const { x, y } of at.values()) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [
    [minX - EXTENT_PADDING, minY - EXTENT_PADDING],
    [maxX + EXTENT_PADDING, maxY + EXTENT_PADDING],
  ];
});

/**
 * The same box, published on the DOM so it can be asserted on.
 *
 * A bound nobody can observe is a bound nobody can test, and "the graph cannot
 * be lost" is exactly the kind of claim that quietly stops being true when a
 * later change reorders two computeds.
 */
const extentAttribute = computed<string | undefined>(() => {
  const box = world.value;
  return box === null ? undefined : `${box[0][0]},${box[0][1]},${box[1][0]},${box[1][1]}`;
});

/**
 * `nodeExtent` and `translateExtent`, bound only when there is a world.
 *
 * Under `exactOptionalPropertyTypes` the renderer's props do not admit
 * `undefined`, and passing it anyway is a type error rather than the "absent"
 * it means at runtime — so an absent extent is an absent *binding*.
 */
const extent = computed<{ nodeExtent?: CoordinateExtent; translateExtent?: CoordinateExtent }>(
  () => {
    const box = world.value;
    if (box === null) return {};
    const travel: Extent = [
      [box[0][0] - TRAVEL_PADDING, box[0][1] - TRAVEL_PADDING],
      [box[1][0] + TRAVEL_PADDING, box[1][1] + TRAVEL_PADDING],
    ];
    return {
      nodeExtent: box as unknown as CoordinateExtent,
      translateExtent: travel as unknown as CoordinateExtent,
    };
  },
);

const isSelected = (node: PlanNodeVM): boolean => node.id === props.selected;
const costOf = (node: PlanNodeVM): string => props.costs?.get(node.id) ?? 'not priced';
const durationOf = (node: PlanNodeVM): string => props.durations?.get(node.id) ?? 'not started';
/** The table's cell for AC5's `carries[]`; never blank, because blank is a bug. */
const carriesOf = (edge: PlanEdgeVM): string => carriedBy(edge) ?? 'nothing';

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
          {
            id: node.id,
            x: 0,
            y: index * COLUMN_STRIDE,
            width: NODE_SIZE.width,
            height: NODE_SIZE.height,
          },
        ]),
      ),
      width: NODE_SIZE.width,
      height: props.nodes.length * COLUMN_STRIDE,
      ms: 0,
    };
  }
}

/**
 * The graph's **shape**, as a string: which nodes exist and which edges join
 * them, in order.
 *
 * KAR-17.1 AC3, and the single most expensive mistake available in this file.
 * The store hands out a fresh memoised array on every projection bump, so the
 * `nodes` prop's identity changes on every `node.progress` event — and a
 * chatty agent emits one every few hundred milliseconds. A watcher on that
 * identity runs ELK for the life of the node, for a drawing whose shape never
 * moved, and the symptom is not an error: it is a graph that feels sluggish
 * while a run is live and fine the moment it finishes.
 *
 * Layout is a function of the ids and the edges and of nothing else — node
 * boxes are a fixed size (`./layout.ts`) — so this string is exactly the input
 * that can change the drawing, and a phase, a cost or a state change is
 * correctly *not* in it. The node bodies still update: `flowNodes` reads
 * `props.nodes` directly and re-derives without the layout being touched.
 */
const topology = computed(
  () =>
    `${props.nodes.map((node) => node.id).join(' ')}|` +
    `${props.edges.map((edge) => edge.id).join(' ')}`,
);

watch(topology, () => {
  void relayout();
});

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
    :data-extent="extentAttribute"
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

      <!--
        AC9. Both are addons over the renderer's own store rather than second
        renderers, and both live here rather than in a view for the same reason
        `VueFlow` does: a view that reached for `@vue-flow/minimap` would be
        reaching past the facade, which `packages/web/scripts/check-graph-facade.ts`
        refuses across the whole `@vue-flow/` scope.
      -->
      <MiniMap pannable zoomable />
      <Controls :show-interactive="false" />
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

    <!--
      AC10 — the whole view, in a form a non-visual reader can read top to
      bottom and anybody can paste into a PR description. Two tables rather than
      one: the nodes are the work, and the edges are what flowed between them
      (AC5), and a single table cannot carry both without inventing a row type.
    -->
    <div v-if="tableOpen" class="graph-canvas__tables">
      <table class="graph-canvas__table" data-graph-table>
        <caption>
          Every node in this plan, with its state, provider, permission, duration and cost.
        </caption>
        <thead>
          <tr>
            <th scope="col">Node</th>
            <th scope="col">Type</th>
            <th scope="col">State</th>
            <th scope="col">Provider</th>
            <th scope="col">Permission</th>
            <th scope="col">Duration</th>
            <th scope="col">Cost</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="node in props.nodes" :key="node.id" :data-table-node="node.id">
            <th scope="row">{{ node.title }}</th>
            <td>{{ node.type ?? 'node' }}</td>
            <td>{{ node.state }}</td>
            <td>{{ node.provider ?? 'no provider yet' }}</td>
            <td>{{ node.permission ?? 'no permission recorded' }}</td>
            <td>{{ durationOf(node) }}</td>
            <td>{{ costOf(node) }}</td>
          </tr>
        </tbody>
      </table>

      <table class="graph-canvas__table" data-graph-edge-table>
        <caption>
          Every edge, and the facts each data edge carries.
        </caption>
        <thead>
          <tr>
            <th scope="col">From</th>
            <th scope="col">To</th>
            <th scope="col">Kind</th>
            <th scope="col">Carries</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="edge in props.edges" :key="edge.id" :data-table-edge="edge.id">
            <th scope="row">{{ edge.from }}</th>
            <td>{{ edge.to }}</td>
            <td>{{ edge.kind }}</td>
            <td>{{ carriesOf(edge) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
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

.graph-canvas__tables {
  position: absolute;
  inset: auto 0.5rem 2.5rem 0.5rem;
  z-index: 5;
  display: grid;
  gap: 0.5rem;
  max-height: 60%;
  overflow: auto;
}

.graph-canvas__table {
  width: 100%;
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
 * AC7 — a selection has a neighbourhood, and the rest of the graph recedes.
 *
 * Opacity and **not** `transition`, deliberately: the renderer's own node
 * transition is `transform 200ms ease-out` and nothing else (KAR-16.6 AC7,
 * asserted on the computed style), so a second transition declared here would
 * silently break that promise while looking like a nicety.
 *
 * `:deep()` because `.vue-flow__node` is the renderer's own element and a
 * scoped rule would never reach it — the node body inside it is the slot's, but
 * the box around it is not.
 */
.graph-canvas :deep(.vue-flow__node.is-distant) {
  opacity: 0.32;
}

.graph-canvas :deep(.vue-flow__edge.is-adjacent .vue-flow__edge-path) {
  stroke: var(--focus-ring);
  stroke-width: 2;
}

/*
 * AC5 — a data edge's `carries[]`, on hover.
 *
 * Always in the DOM (so a reader and the data-table twin can both reach it) and
 * transparent until the pointer or the keyboard arrives, because a forty-node
 * plan with a permanent label on every data edge is unreadable — which is the
 * reason the acceptance criterion says "on hover" rather than "always".
 */
.graph-canvas :deep(.vue-flow__edge-textwrapper) {
  opacity: 0;
  /*
   * A label sits on the midpoint of the edge it labels — which is exactly
   * where the renderer's wide transparent hit path is — so a label that took
   * pointer events would swallow the hover that is meant to reveal it, and the
   * only way to see it would be to have already seen it.
   */
  pointer-events: none;
}

.graph-canvas :deep(.vue-flow__edge:hover .vue-flow__edge-textwrapper),
.graph-canvas :deep(.vue-flow__edge:focus-within .vue-flow__edge-textwrapper),
.graph-canvas :deep(.vue-flow__edge.selected .vue-flow__edge-textwrapper) {
  opacity: 1;
}

.graph-canvas :deep(.vue-flow__edge-text) {
  fill: var(--ink);
  font-size: 11px;
}

.graph-canvas :deep(.vue-flow__edge-textbg) {
  fill: var(--surface-raised);
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
