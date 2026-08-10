<script setup lang="ts">
/**
 * F10.1's live plan graph — the landing view, and therefore the reason
 * `@vue-flow/core` is in the initial chunk rather than behind a lazy route
 * (AC9, docs/12-frontend-architecture.md §10).
 *
 * This story delivers the **frame**: the canvas, the per-node accessible name,
 * the state chips reading the shared palette, and the selection the `j`/`k` map
 * moves. The layout engine (elkjs in a worker), the node view-model and the
 * 400-node performance baseline are KAR-16.3 / KAR-16.6, and the nodes
 * themselves arrive from the projection store rather than from here — this view
 * renders `useUiStore().nodes` and holds no data of its own, which is what
 * makes it possible to test the keyboard map against a store instead of against
 * a fixture server.
 *
 * `disableKeyboardA11y` is **not** set, deliberately: Vue Flow ships
 * `aria-live`, `aria-label`, `aria-describedby`, `aria-roledescription` and
 * keyboard node traversal, and turning that off to hand-roll it is how a DAG
 * becomes unreadable to a screen reader (docs/12 §9.3).
 */
import { VueFlow } from '@vue-flow/core';
import { computed } from 'vue';
import StateChip from '../components/StateChip.vue';
import { STATE_LABELS } from '../lib/state-palette.ts';
import { type GraphNode, useUiStore } from '../stores/useUiStore.ts';

const ui = useUiStore();

/** Vertical stack: real layout is KAR-16.6's worker, not this story's. */
const LANE_X = 0;
const ROW_HEIGHT = 92;

/**
 * The one line that carries most of what a screen reader needs from a DAG
 * (docs/12 §9.3): type, title, state.
 */
const ariaLabelOf = (node: GraphNode): string => `${node.title}, ${STATE_LABELS[ui.stateOf(node)]}`;

const flowNodes = computed(() =>
  ui.nodes.map((node, index) => ({
    id: node.id,
    type: 'default' as const,
    position: { x: LANE_X, y: index * ROW_HEIGHT },
    ariaLabel: ariaLabelOf(node),
    data: node,
  })),
);
</script>

<template>
  <section class="plan-graph" aria-label="Plan graph">
    <VueFlow
      :nodes="flowNodes"
      :edges="[]"
      :nodes-draggable="false"
      :fit-view-on-init="true"
      @node-click="({ node }) => ui.selectNode(node.id)"
    >
      <template #node-default="{ id, data }">
        <article
          class="plan-node"
          :data-node="id"
          :data-selected="id === ui.selectedNodeId ? 'true' : 'false'"
          :style="{ borderColor: `var(--state-${ui.stateOf(data)})` }"
        >
          <h3 class="plan-node__title">{{ data.title }}</h3>
          <StateChip :state="ui.stateOf(data)" />
        </article>
      </template>
    </VueFlow>

    <p v-if="ui.nodes.length === 0" class="plan-graph__empty">
      No plan yet. A run's graph appears here as soon as its first plan is compiled.
    </p>
  </section>
</template>

<style scoped>
.plan-graph {
  position: relative;
  height: 100%;
  min-height: 20rem;
}

.plan-node {
  display: grid;
  gap: 0.4rem;
  padding: 0.6rem 0.75rem;
  border: 2px solid var(--edge);
  border-radius: 0.5rem;
  background: var(--surface-raised);
  min-width: 12rem;
  text-align: left;
}

.plan-node[data-selected="true"] {
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.plan-node__title {
  font-size: 0.9rem;
  font-weight: 600;
}

.plan-graph__empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  color: var(--ink-muted);
  pointer-events: none;
}

/*
 * The reduced-motion override for `.vue-flow__node` deliberately does NOT live
 * here. It is in ../styles/theme.css, after the `@import` of Vue Flow's own
 * stylesheet, because a scoped `:deep()` rule would have to out-specify a
 * third-party sheet whose import order this component does not control — and
 * "the media query wraps the wrong rule" is exactly the failure AC8's test is
 * written against.
 */
</style>
