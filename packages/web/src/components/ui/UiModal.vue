<script setup lang="ts">
/**
 * KAR-24.2 AC1, AC4 — the modal chrome the composer and the new-project form
 * sit inside. Built on `reka-ui`'s `DialogRoot` / `DialogPortal` /
 * `DialogOverlay` / `DialogContent` / `DialogTitle` / `DialogClose`, not
 * hand-rolled: focus trap, `Esc`, outside-click, `aria-modal` and focus return
 * are exactly what docs/12-frontend-architecture.md §9.3 credits Reka UI for
 * and says not to reimplement, and `CommandJumper.vue` is the precedent this
 * follows for how the primitives compose.
 *
 * Openness is `open` (a prop) plus a `close` emit, not `modelValue` — this
 * component is reached for from views that already read an overlay flag off a
 * store (as `CommandJumper` does from `useUiStore`), and a `close` emit maps
 * onto "clear that flag" more directly than a `v-model` the caller would have
 * to wrap in a computed anyway. `DialogRoot`'s own `update:open` is what
 * fires `close`, so the same event that Reka fires for Escape, outside-click
 * and its own `DialogClose` all funnel through one place.
 */
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';

/*
 * Two attributes Reka does not write for us, and both are deliberate on its
 * part rather than oversights.
 *
 * `aria-modal` — Reka's DialogContent renders `role="dialog"` and traps focus,
 * but leaves the attribute to the consumer, because a non-modal dialog uses
 * the same component. AC4 wants the modal one, so it is stated here. The first
 * run of ./a11y.test.ts is what noticed it was missing.
 *
 * `:aria-describedby="undefined"` — Reka warns on every open when a dialog has
 * no description, which is the right default for a content dialog and the
 * wrong one for this component: a modal here is a titled form, and its body is
 * the fields rather than a paragraph describing them. Passing `undefined`
 * explicitly is Reka's own documented way of saying "there is no description
 * and that is intended", and it is better than a console warning on every
 * modal in the application, which is how people learn to ignore warnings.
 */

withDefaults(
  defineProps<{
    readonly open: boolean;
    readonly title?: string;
  }>(),
  {},
);

const emit = defineEmits<{
  close: [];
}>();

function onUpdateOpen(next: boolean): void {
  if (!next) emit('close');
}
</script>

<template>
  <DialogRoot :open="open" @update:open="onUpdateOpen">
    <DialogPortal>
      <DialogOverlay class="ui-modal__overlay">
        <DialogContent
          class="ui-modal__panel"
          aria-modal="true"
          :aria-describedby="undefined"
          @pointer-down-outside="() => emit('close')"
        >
          <div v-if="title" class="ui-modal__header">
            <DialogTitle class="ui-modal__title">{{ title }}</DialogTitle>
            <DialogClose class="ui-modal__close" aria-label="Close">✕</DialogClose>
          </div>
          <div class="ui-modal__body">
            <slot />
          </div>
          <div v-if="$slots.footer" class="ui-modal__footer">
            <slot name="footer" />
          </div>
        </DialogContent>
      </DialogOverlay>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.ui-modal__overlay {
  position: fixed;
  inset: 0;
  background: var(--surface-overlay);
  display: grid;
  place-items: center;
  padding: 24px; /* geometry — the overlay's inset from the viewport edge */
}

.ui-modal__panel {
  width: 480px; /* geometry — the modal's fixed width */
  max-width: 100%;
  background: var(--surface);
  border: 1px solid var(--edge-control);
  border-radius: var(--radius-2xl);
  box-shadow: var(--shadow-modal);
  overflow: hidden;
}

.ui-modal__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 15px 16px 13px; /* geometry — the header's own padding */
  border-bottom: 1px solid var(--edge-strong);
}

.ui-modal__title {
  font-size: var(--text-lg);
  font-weight: 600;
}

.ui-modal__close {
  background: transparent;
  border: none;
  color: var(--ink-muted);
  cursor: pointer;
  line-height: 1;
}

.ui-modal__close:hover {
  color: var(--ink);
}

.ui-modal__body {
  padding: 15px 16px; /* geometry — the body's own padding */
  display: flex;
  flex-direction: column;
  gap: 14px; /* geometry — the gap between body sections */
}

.ui-modal__footer {
  padding: 13px 16px; /* geometry — the footer's own padding */
  border-top: 1px solid var(--edge-strong);
  background: var(--surface-raised);
  display: flex;
  gap: 8px; /* geometry — the gap between footer actions */
  justify-content: flex-end;
}
</style>
