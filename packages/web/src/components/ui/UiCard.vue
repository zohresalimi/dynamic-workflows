<script setup lang="ts">
/**
 * KAR-24.2 AC1 — the container the other four in this file build on top of.
 *
 * `variant` is `raised | inset | flush`, never `project` or `node`: the story's
 * "one rule" (EPIC-24-design-system.md, "The one rule this epic is designed
 * around") is that this component may not know what it is for, and a caller
 * reaching for a fourth variant named after a screen is that rule breaking.
 * `raised` is a panel sitting on the canvas, `inset` is a panel sitting inside
 * one, `flush` is no chrome at all — a layout convenience for a caller that
 * wants the padding and slot but none of the border. All three are appearance,
 * none is a domain.
 *
 * `interactive` is deliberately shallow: a pointer cursor and a hover border,
 * nothing else. It does **not** turn this `<div>` into a button — a `<div
 * interactive>` with a click handler is invisible to a keyboard user and to
 * assistive tech, because a div has no interaction semantics no matter what
 * CSS is on it (WCAG 2.1.1). A caller that needs a click target puts a real
 * `<button>` or `<RouterLink>` around or inside this card; this component will
 * not pretend a cursor style is the same thing as focusability.
 */
withDefaults(
  defineProps<{
    readonly variant?: 'raised' | 'inset' | 'flush';
    readonly interactive?: boolean;
  }>(),
  { variant: 'raised', interactive: false },
);
</script>

<template>
  <div class="ui-card" :data-variant="variant" :data-interactive="interactive || undefined">
    <slot />
  </div>
</template>

<style scoped>
.ui-card {
  box-sizing: border-box;
}

.ui-card[data-variant="raised"] {
  background: var(--surface);
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-xl);
  padding: 14px; /* geometry — the raised card's padding, not a type size */
}

.ui-card[data-variant="inset"] {
  background: var(--surface-inset);
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-lg);
  padding: 8px 9px; /* geometry — the inset card's padding */
}

.ui-card[data-variant="flush"] {
  background: transparent;
  border: none;
  border-radius: 0;
  padding: 0;
}

.ui-card[data-interactive] {
  cursor: pointer;
}

.ui-card[data-interactive]:hover {
  border-color: var(--edge-hover);
}
</style>
