<script setup lang="ts">
/**
 * KAR-16.6 AC10 — the proof that swapping the renderer is a one-file change.
 *
 * Verifies: EPIC-16-S35 (scenario 2) · AC10
 *
 * > A spike branch replaces `GraphCanvas`'s internals with a stub renderer and
 * > every consuming view still compiles and renders.
 *
 * This is that spike branch, committed — because a claim that lives on a branch
 * nobody made is a claim nobody checks. `DeFlow_GRAPH_RENDERER=stub` aliases
 * `./GraphCanvas.vue` to this file at build time (`../../../scripts/renderer-alias.ts`),
 * and `e2e/graph-facade-swap.test.ts` builds the app that way, asserts the
 * built output contains **no Vue Flow at all**, and then renders a real plan
 * through it in a real Chromium.
 *
 * It is not a mock. It draws the graph: absolutely-positioned node bodies at
 * laid-out coordinates, the same `#node` slot, the same accessible names, the
 * same `select`/`activate`/`laid-out` events, the same ELK layout through
 * `./layout.ts`. What it does not have is a viewport — no pan, no zoom, no
 * edges — which is exactly the shape a `sigma` or `graphology` port would start
 * from, and the reason the escape hatch is worth having.
 *
 * Nothing imports it in a normal build, so it costs the shipped bundle nothing.
 */
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue';
import { GRAPH_DEFAULTS } from './defaults.ts';
import type { GraphLayout, LayoutEngine } from './layout.ts';
import {
  ariaLabelOf,
  type GraphCanvasEmits,
  type GraphCanvasProps,
  type GraphCanvasSlots,
  type NodePlacement,
} from './types.ts';

const props = withDefaults(defineProps<GraphCanvasProps>(), {
  selected: null,
  onlyRenderVisibleElements: GRAPH_DEFAULTS.onlyRenderVisibleElements,
  elevateNodesOnSelect: GRAPH_DEFAULTS.elevateNodesOnSelect,
  fitViewOnInit: true,
});

const emit = defineEmits<GraphCanvasEmits>();
defineSlots<GraphCanvasSlots>();

const layout = shallowRef<GraphLayout | null>(null);
let engine: LayoutEngine | null = null;

const placement = computed<NodePlacement | null>(
  () => props.positions ?? layout.value?.positions ?? null,
);

const drawn = computed(() => {
  const at = placement.value;
  if (at === null) return [];
  return props.nodes.map((node, index) => ({
    node,
    x: at.get(node.id)?.x ?? 0,
    y: at.get(node.id)?.y ?? index * 96,
  }));
});

async function relayout(): Promise<void> {
  if (props.positions !== undefined) return;
  const { createLayoutEngine } = await import('./layout.ts');
  engine ??= createLayoutEngine();
  const next = await engine.layout(props.nodes, props.edges);
  layout.value = next;
  emit('laid-out', { ms: next.ms, nodes: next.positions.size });
}

watch(
  () => [props.nodes, props.edges] as const,
  () => void relayout(),
);
onMounted(() => void relayout());
onBeforeUnmount(() => {
  engine?.dispose();
  engine = null;
});
</script>

<template>
  <section
    class="graph-canvas"
    data-graph-canvas
    data-renderer="stub"
    data-motion="on"
    :aria-label="`Plan graph, ${props.nodes.length} nodes`"
  >
    <div class="graph-canvas__pane">
      <div
        v-for="placed in drawn"
        :key="placed.node.id"
        class="vue-flow__node"
        :data-id="placed.node.id"
        role="group"
        tabindex="0"
        :aria-label="ariaLabelOf(placed.node)"
        :style="{ transform: `translate(${placed.x}px, ${placed.y}px)` }"
        @focusin="emit('select', placed.node.id)"
        @keydown.enter="emit('activate', placed.node.id)"
        @click="emit('select', placed.node.id)"
      >
        <slot name="node" :node="placed.node" :selected="placed.node.id === props.selected">
          <article class="graph-node">
            <h3 class="graph-node__title">{{ placed.node.title }}</h3>
            <span class="graph-node__state">{{ placed.node.state }}</span>
          </article>
        </slot>
      </div>
    </div>
  </section>
</template>

<style scoped>
.graph-canvas {
  position: relative;
  height: 100%;
  min-height: 24rem;
  overflow: auto;
}

.graph-canvas__pane {
  position: relative;
  width: 100%;
  height: 100%;
}

.vue-flow__node {
  position: absolute;
  top: 0;
  left: 0;
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
</style>
