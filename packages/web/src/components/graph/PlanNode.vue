<script setup lang="ts">
/**
 * KAR-17.1 AC4 — the node body, and the entire reason Vue Flow was chosen.
 *
 * > It renders `PlanNodeVM[]` … through `GraphCanvas`, with a custom node
 * > component — which is the entire reason Vue Flow was chosen over the
 * > canvas-first alternatives: *a custom node **is** a Vue component*, which is
 * > exactly what per-node live status, a streaming badge, a gate verdict chip
 * > and a cost figure need (docs/12 §6.1).
 *
 * So this is that component, and it is deliberately dumb: every value it shows
 * arrives already decided on a `NodeBodyVM` from `./node-body.ts`, which is
 * where "is this priced or unpriced", "how long has this been going" and "what
 * does the palette call this state" are answered — once, purely, and under
 * test without a browser.
 *
 * **Colour is never the only signal** (WCAG 1.4.1, docs/12 §9.2). The border
 * reads `--state-*`, `StateChip` carries the same state as a glyph *and* a
 * word, and the type glyph beside the title says what kind of work this is.
 * Turn every colour off and the body still reads.
 *
 * The whole thing is one flat `<article>` with `data-slot` hooks rather than
 * six sub-components: it is rendered once per node, up to four hundred times,
 * and every component instance on that path is paid for on every relayout.
 */
import { computed } from 'vue';
import StateChip from '../StateChip.vue';
import { glyphFor } from './glyphs.ts';
import type { NodeBodyVM } from './node-body.ts';

const props = defineProps<{
  readonly body: NodeBodyVM;
  readonly selected: boolean;
}>();

const glyph = computed(() => glyphFor(props.body.type === 'node' ? null : props.body.type));
</script>

<template>
  <article
    class="plan-node"
    :data-plan-node="body.id"
    :data-state="body.state"
    :data-selected="selected ? 'true' : 'false'"
    :style="{ borderColor: `var(--state-${body.state})` }"
  >
    <header class="plan-node__head">
      <span class="plan-node__type" data-slot="type-glyph" :title="body.type">
        <component :is="glyph" :size="14" :stroke-width="2" aria-hidden="true" />
      </span>
      <h3 class="plan-node__title">{{ body.title }}</h3>
      <!--
        The streaming badge. Present only while an agent is actually producing
        output, because a badge that is always there is not a badge — and it
        carries a word as well as a pulse, for the same reason everything else
        here does.
      -->
      <span v-if="body.streaming" class="plan-node__streaming" data-slot="streaming">
        <span class="plan-node__pulse" aria-hidden="true" />
        streaming
      </span>
    </header>

    <div class="plan-node__row">
      <StateChip :state="body.state" />
      <!--
        A gate verdict belongs on the node whose *work* was judged, not on the
        gate — "which of my steps did a gate refuse" is the question, and it is
        asked of the step.
      -->
      <span
        v-if="body.verdict !== null"
        class="plan-node__verdict"
        :data-verdict="body.verdict"
        data-slot="verdict"
      >
        {{ body.verdictGate }}: {{ body.verdict }}
      </span>
    </div>

    <p class="plan-node__meta">
      <span data-slot="type">{{ body.type }}</span>
      <span aria-hidden="true">·</span>
      <span data-slot="provider">{{ body.provider }}</span>
      <span aria-hidden="true">·</span>
      <span data-slot="model">{{ body.model }}</span>
      <span aria-hidden="true">·</span>
      <span data-slot="permission">{{ body.permission }}</span>
    </p>

    <p v-if="body.phase !== null" class="plan-node__phase" data-slot="phase">
      {{ body.phase }}
      <template v-if="body.progressMessage !== null"> — {{ body.progressMessage }}</template>
    </p>

    <p class="plan-node__figures">
      <span data-slot="elapsed">{{ body.elapsed }}</span>
      <span aria-hidden="true">·</span>
      <span data-slot="cost">{{ body.cost }}</span>
    </p>
  </article>
</template>

<style scoped>
.plan-node {
  display: grid;
  gap: 0.3rem;
  padding: 0.5rem 0.65rem;
  border: 2px solid var(--edge);
  border-radius: 0.5rem;
  background: var(--surface-raised);
  /*
   * The drawn size, and it must equal `NODE_SIZE` in `./node-size.ts` — ELK
   * spaces boxes, so a body larger than the box ELK was told about overlaps its
   * neighbours and a smaller one leaves the drawing full of holes.
   */
  width: 248px;
  height: 108px;
  overflow: hidden;
  text-align: left;
  box-sizing: border-box;
}

/*
 * The selected node, ringed rather than recoloured: the border is already
 * carrying the state, and a selection that repainted it would lose the one
 * signal the whole graph is read by.
 */
.plan-node[data-selected="true"] {
  box-shadow: 0 0 0 2px var(--focus-ring);
}

.plan-node__head {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
}

.plan-node__type {
  display: inline-flex;
  color: var(--ink-muted);
}

.plan-node__title {
  font-size: 0.8125rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-node__streaming {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  margin-left: auto;
  font-size: 0.625rem;
  color: var(--state-running);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.plan-node__pulse {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 999px;
  background: currentcolor;
}

.plan-node__row {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
}

.plan-node__verdict {
  padding: 0.05em 0.4em;
  border: 1px solid currentcolor;
  border-radius: 999px;
  font-size: 0.6875rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--state-passed);
}

.plan-node__verdict[data-verdict="fail"] {
  color: var(--state-failed);
}

.plan-node__verdict[data-verdict="needs-human"] {
  color: var(--state-awaiting-human);
}

.plan-node__meta,
.plan-node__figures,
.plan-node__phase {
  display: flex;
  gap: 0.25rem;
  font-size: 0.6875rem;
  color: var(--ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plan-node__phase {
  color: var(--state-running);
}
</style>
