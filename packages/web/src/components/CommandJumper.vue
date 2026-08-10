<script setup lang="ts">
/**
 * The Cmd-K run/node jumper (AC7, docs/12-frontend-architecture.md §8, §9.5).
 *
 * *"`resizable` and `command` carry an operator UI further than any amount of
 * visual polish"* — and they are **taken, not built**. This is the vendored
 * shadcn-vue `command` shape: a Reka UI `DialogRoot` around a `ListboxRoot`
 * with a `ListboxFilter`, which is where the genuinely hard half of the
 * accessibility comes from — focus trap, roving tabindex, `aria-activedescendant`,
 * outside-click, and the `aria-expanded`/`aria-controls` wiring nobody
 * hand-rolls correctly.
 *
 * The open/closed state is the UI store's overlay stack rather than a local
 * `ref`, and `@escape-key-down` is **prevented** on purpose: `Esc` has exactly
 * one implementation in this application (../app/keyboard.ts), and it closes
 * the topmost overlay. Two Escape handlers is how one keypress closes two
 * dialogs.
 */
import {
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
  ListboxContent,
  ListboxFilter,
  ListboxItem,
  ListboxRoot,
} from 'reka-ui';
import { computed, ref, watch } from 'vue';
import { JUMPER_OVERLAY } from '../app/ids.ts';
import { useUiStore } from '../stores/useUiStore.ts';
import StateChip from './StateChip.vue';

const ui = useUiStore();
const query = ref('');

const open = computed({
  get: () => ui.isOverlayOpen(JUMPER_OVERLAY),
  set: (next: boolean) => {
    if (next) ui.openOverlay(JUMPER_OVERLAY);
    else ui.closeOverlay(JUMPER_OVERLAY);
  },
});

// A jumper that reopens holding the last search is a jumper you have to clear
// before you can use it.
watch(open, (isOpen) => {
  if (isOpen) query.value = '';
});

const matches = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return needle === ''
    ? ui.nodes
    : ui.nodes.filter(
        (node) =>
          node.title.toLowerCase().includes(needle) || node.id.toLowerCase().includes(needle),
      );
});

function jumpTo(id: string): void {
  ui.selectNode(id);
  ui.closeOverlay(JUMPER_OVERLAY);
}
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="jumper__scrim" />
      <DialogContent
        class="jumper"
        data-overlay="jumper"
        @escape-key-down="(event: Event) => event.preventDefault()"
      >
        <DialogTitle class="jumper__title">Jump to a node</DialogTitle>
        <DialogDescription class="jumper__hint">
          Type to filter. Enter jumps, Escape closes.
        </DialogDescription>

        <ListboxRoot class="jumper__list" @highlight="() => {}">
          <ListboxFilter
            v-model="query"
            class="jumper__filter"
            auto-focus
            placeholder="Node title or id"
          />
          <ListboxContent>
            <ListboxItem
              v-for="node in matches"
              :key="node.id"
              :value="node.id"
              class="jumper__item"
              @select="jumpTo(node.id)"
            >
              <span class="jumper__item-title">{{ node.title }}</span>
              <StateChip :state="ui.stateOf(node)" />
            </ListboxItem>
            <p v-if="matches.length === 0" class="jumper__empty">No node matches “{{ query }}”.</p>
          </ListboxContent>
        </ListboxRoot>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.jumper__scrim {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 40%);
}

.jumper {
  position: fixed;
  top: 15vh;
  left: 50%;
  translate: -50% 0;
  width: min(38rem, 92vw);
  padding: 0.75rem;
  border: 1px solid var(--edge);
  border-radius: 0.75rem;
  background: var(--surface-raised);
  color: var(--ink);
}

.jumper__title {
  font-size: 0.8rem;
  color: var(--ink-muted);
}

.jumper__hint {
  font-size: 0.75rem;
  color: var(--ink-muted);
}

.jumper__filter {
  width: 100%;
  margin: 0.5rem 0;
  padding: 0.5rem;
  border: 1px solid var(--edge);
  border-radius: 0.5rem;
  background: var(--surface);
  color: inherit;
}

.jumper__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.4rem 0.5rem;
  border-radius: 0.375rem;
  cursor: default;
}

.jumper__item[data-highlighted] {
  background: color-mix(in oklch, var(--focus-ring) 18%, var(--surface-raised));
}

.jumper__empty {
  padding: 0.5rem;
  color: var(--ink-muted);
}
</style>
