<script setup lang="ts">
/**
 * KAR-17.9 — a node body on the memory graph.
 *
 * Verifies: EPIC-17-S33 · AC1, AC2, AC4
 *
 * Two shapes behind one component, because they are two states of the same
 * thing: a **bubble** standing for everything one plan node wrote, and a
 * **fact** the operator expanded that bubble to see. Rendering them as two
 * components would put the expand control and the thing it expands into in
 * different files for no gain.
 *
 * This is the reason Vue Flow was chosen over the canvas-first alternatives at
 * all ([12 §6.1](../../../../../docs/12-frontend-architecture.md)): a custom
 * node **is** a Vue component, so a fact count, a taint warning and an expand
 * button are ordinary markup with ordinary focus behaviour rather than
 * hit-testing arithmetic over a `<canvas>`.
 *
 * **Nothing here is encoded by colour alone.** Invalidated carries a struck
 * label, the word *"invalidated"* and a glyph; tainted carries a glyph and the
 * word. The palette is `--state-*` through `stateVar`, which is where every
 * other view's colours come from.
 */
import { AlertTriangle, ChevronDown, ChevronRight, Database, FileWarning } from 'lucide-vue-next';
import { computed } from 'vue';
import type { MemoryNodeVM } from '../../ledger/projections/memory-graph.ts';
import { stateVar } from '../../lib/state-palette.ts';

const props = defineProps<{
  readonly node: MemoryNodeVM;
  readonly selected: boolean;
}>();

const emit = defineEmits<{
  /** The operator asked for this producer's facts, or asked to put them away. */
  (event: 'toggle', node: string): void;
  /** A step through an expanded producer's pages. `-1` back, `+1` on. */
  (event: 'page', detail: { node: string; by: number }): void;
}>();

const memory = computed(() => props.node.memory);
const colour = computed(() => stateVar(props.node.state));
</script>

<template>
  <article
    class="memory-node"
    :data-memory-node="props.node.id"
    :data-memory-kind="memory.kind"
    :data-fact-count="String(memory.factCount)"
    :data-tainted="String(memory.tainted)"
    :data-invalid="String(memory.invalid)"
    :data-selected="String(props.selected)"
    :style="{ '--node-colour': colour }"
  >
    <header class="memory-node__head">
      <component :is="memory.kind === 'fact' ? FileWarning : Database" class="memory-node__glyph" />
      <h3
        class="memory-node__title"
        :data-struck="String(memory.invalid && memory.kind === 'fact')"
      >
        {{ memory.label }}
      </h3>
    </header>

    <p v-if="memory.kind === 'producer'" class="memory-node__counts">
      <span data-memory-count>
        {{ memory.factCount }}
        fact{{ memory.factCount === 1 ? '' : 's' }}
      </span>
      <span data-memory-consumers> read by {{ memory.consumerCount }} </span>
      <span v-if="memory.invalidCount > 0" data-memory-invalid-count>
        {{ memory.invalidCount }}
        invalidated
      </span>
    </p>

    <p v-else class="memory-node__counts">
      <span data-memory-consumers>{{ memory.consumerCount }} readers</span>
      <span v-if="memory.invalid" data-memory-fact-invalid>invalidated</span>
    </p>

    <p v-if="memory.tainted" class="memory-node__taint" data-memory-taint>
      <AlertTriangle class="memory-node__glyph" />
      Consumed {{ memory.taints.length }} fact{{ memory.taints.length === 1 ? '' : 's' }}
      that later proved wrong
    </p>

    <footer v-if="memory.kind === 'producer' && memory.factCount > 0" class="memory-node__foot">
      <button
        type="button"
        class="memory-node__button"
        data-memory-expand
        :aria-expanded="memory.expanded"
        @click.stop="emit('toggle', memory.node as string)"
      >
        <component :is="memory.expanded ? ChevronDown : ChevronRight" class="memory-node__glyph" />
        {{ memory.expanded ? 'Hide' : 'Show' }}
        facts
      </button>

      <span v-if="memory.page !== null" class="memory-node__page" data-memory-page>
        {{ memory.page.from }}–{{ memory.page.to }}
        of {{ memory.page.total }}
      </span>

      <template v-if="memory.page !== null && memory.page.pages > 1">
        <button
          type="button"
          class="memory-node__button"
          data-memory-prev
          :disabled="memory.page.page === 0"
          @click.stop="emit('page', { node: memory.node as string, by: -1 })"
        >
          Previous page
        </button>
        <button
          type="button"
          class="memory-node__button"
          data-memory-next
          :disabled="memory.page.page >= memory.page.pages - 1"
          @click.stop="emit('page', { node: memory.node as string, by: 1 })"
        >
          Next page
        </button>
      </template>
    </footer>
  </article>
</template>

<style scoped>
.memory-node {
  display: grid;
  gap: 0.3rem;
  width: 15rem;
  padding: 0.55rem 0.7rem;
  border: 2px solid var(--node-colour, var(--edge));
  border-radius: 0.6rem;
  background: var(--surface-raised);
  text-align: left;
  font-size: 0.8rem;
}

.memory-node[data-selected="true"] {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.memory-node[data-memory-kind="fact"] {
  border-style: dashed;
}

.memory-node__head {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.memory-node__glyph {
  width: 0.9rem;
  height: 0.9rem;
  flex: none;
}

.memory-node__title {
  margin: 0;
  font-size: 0.85rem;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.memory-node__title[data-struck="true"] {
  text-decoration: line-through;
}

.memory-node__counts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0;
  color: var(--ink-muted);
}

.memory-node__taint {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  margin: 0;
  color: var(--state-failed);
}

.memory-node__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
}

.memory-node__button {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.15rem 0.4rem;
  border: 1px solid var(--edge);
  border-radius: 0.35rem;
  background: var(--surface);
  color: inherit;
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.memory-node__button:disabled {
  opacity: 0.5;
  cursor: default;
}

.memory-node__page {
  color: var(--ink-muted);
}
</style>
