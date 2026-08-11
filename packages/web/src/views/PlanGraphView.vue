<script setup lang="ts">
/**
 * F10.1's live plan graph — the landing view.
 *
 * This view renders **through `GraphCanvas`** and imports no renderer of its
 * own; `packages/web/scripts/check-graph-facade.ts` fails `pnpm lint` if any
 * view ever does (KAR-16.6 AC1). What that buys is the thing the roadmap asks
 * for: Vue Flow is the largest third-party risk in this frontend, and replacing
 * it is a change to one file in `../components/graph/` rather than to every
 * view that ever drew a node.
 *
 * The view's own job is small and stays small: it supplies the **node body** —
 * the slot the facade calls once per node — and it hands the canvas its
 * selection. Layout, motion, keyboard traversal and the accessible names are
 * the canvas's, which is why they are tested once rather than once per view.
 *
 * The nodes themselves arrive from the shell's UI store, which is what makes
 * the keyboard map testable against a store instead of against a server. Their
 * full view-model — provider, cost, gate verdicts, streaming phase — is the run
 * store's (KAR-16.4) and arrives with EPIC-17's wiring; `asPlanNode` below is
 * the honest stand-in until then, and it invents nothing: what the shell does
 * not know is `null`.
 */
import { computed } from 'vue';
import GraphCanvas from '../components/graph/GraphCanvas.vue';
import StateChip from '../components/StateChip.vue';
import type { PlanNodeVM } from '../ledger/vm.ts';
import { type GraphNode, useUiStore } from '../stores/useUiStore.ts';

const ui = useUiStore();

/**
 * The shell's node, in the projection's vocabulary.
 *
 * Every field the shell cannot answer yet is `null` rather than a plausible
 * default: a `provider` of `'claude-code'` invented here would be announced to
 * a screen reader as fact.
 */
function asPlanNode(node: GraphNode): PlanNodeVM {
  return {
    id: node.id,
    title: node.title,
    type: null,
    lifecycle: 'active',
    status: node.status,
    state: ui.stateOf(node),
    provider: null,
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

const nodes = computed<readonly PlanNodeVM[]>(() => ui.nodes.map(asPlanNode));
</script>

<template>
  <section class="plan-graph" aria-label="Plan graph">
    <GraphCanvas
      :nodes="nodes"
      :edges="[]"
      :selected="ui.selectedNodeId"
      @select="(id: string) => ui.selectNode(id)"
      @activate="(id: string) => { ui.selectNode(id); ui.inspectSelected('inspector'); }"
    >
      <template #node="{ node }">
        <article
          class="plan-node"
          :data-node="node.id"
          :data-selected="node.id === ui.selectedNodeId ? 'true' : 'false'"
          :style="{ borderColor: `var(--state-${node.state})` }"
        >
          <h3 class="plan-node__title">{{ node.title }}</h3>
          <StateChip :state="node.state" />
        </article>
      </template>
    </GraphCanvas>

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
 * here. It is in ../styles/theme.css, after the `@import` of the renderer's own
 * stylesheet, because a scoped `:deep()` rule would have to out-specify a
 * third-party sheet whose import order this component does not control — and
 * "the media query wraps the wrong rule" is exactly the failure AC8's test is
 * written against.
 */
</style>
