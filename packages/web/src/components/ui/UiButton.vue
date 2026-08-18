<script setup lang="ts">
/**
 * KAR-24.2 AC1, AC3, AC4 — the one clickable rectangle every screen reaches for.
 *
 * Four variants, named for what they look like rather than for what they are
 * next to: `primary | secondary | ghost | danger`. A fifth variant born on a
 * screen — `variant="start-run"` — is exactly the failure "the one rule this
 * epic is designed around" (EPIC-24-design-system.md) is written against, so
 * this component stops at appearance and lets the caller's slot carry the
 * meaning.
 *
 * It renders a real `<button>`, not a styled `<div
 * @click>`: a div has no keyboard activation and no disabled semantics for
 * free, and clawing both back by hand is the reimplementation §9.3 warns
 * against for interactive primitives. `disabled` is passed through as the DOM
 * attribute — never only a class — so assistive tech and `:disabled` styling
 * agree with each other.
 */
withDefaults(
  defineProps<{
    readonly variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    readonly size?: 'sm' | 'md';
    readonly disabled?: boolean;
    /*
     * KAR-24.7 — `type` is a prop, and it defaults to `button`.
     *
     * The default is the safe one: a `<button>` inside a `<form>` submits it
     * unless told otherwise, and a toolbar button that quietly submits the
     * form it happens to sit in is a bug nobody writes on purpose. But
     * hardcoding it, which is how this component shipped, made the library
     * unusable for the one case that genuinely needs `submit` — and KAR-24.7's
     * project-create form went back to a bare `<button>` rather than use it.
     * A primitive a caller has to step around is a primitive that has started
     * to shrink the system rather than grow it.
     */
    readonly type?: 'button' | 'submit' | 'reset';
  }>(),
  {
    variant: 'secondary',
    size: 'sm',
    disabled: false,
    type: 'button',
  },
);
</script>

<template>
  <button
    :type="type"
    class="ui-button"
    :data-variant="variant"
    :data-size="size"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<style scoped>
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.4em;
  font-family: var(--font-sans);
  font-size: var(--text-base);
  border-radius: var(--radius-md);
  border: 1px solid var(--edge-control);
  background: var(--surface-control);
  color: var(--ink);
  font-weight: 500;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    color 120ms ease,
    filter 120ms ease;
}

/* Sizing is the prototype's own padding scale, tied to `data-size` rather
   than to a token ramp that has no 5px/6px/8px rungs of its own. */
.ui-button[data-size="sm"] {
  padding: 5px 10px; /* geometry, not type */
}

.ui-button[data-size="md"] {
  padding: 8px 13px; /* geometry, not type */
}

.ui-button[data-variant="primary"][data-size="md"] {
  border-radius: var(--radius-lg);
}

.ui-button[data-variant="primary"] {
  border-color: var(--state-running);
  background: var(--state-running);
  color: var(--surface-canvas);
  font-weight: 600;
}

.ui-button[data-variant="primary"][data-size="sm"] {
  padding: 6px 11px; /* geometry, not type */
}

.ui-button[data-variant="secondary"] {
  border-color: var(--edge-control);
  background: var(--surface-control);
  color: var(--ink);
  font-weight: 500;
}

.ui-button[data-variant="ghost"] {
  border-color: var(--edge-control);
  background: transparent;
  color: var(--ink-muted);
}

.ui-button[data-variant="danger"] {
  border-color: var(--state-failed);
  background: transparent;
  color: var(--state-failed);
  font-weight: 600;
}

.ui-button[data-variant="primary"]:hover:not(:disabled) {
  filter: brightness(1.08);
}

.ui-button[data-variant="secondary"]:hover:not(:disabled),
.ui-button[data-variant="ghost"]:hover:not(:disabled),
.ui-button[data-variant="danger"]:hover:not(:disabled) {
  border-color: var(--edge-hover);
  color: var(--ink);
}

/*
 * AC4 — every interactive component shows the focus ring on
 * `:focus-visible` and none of them removes it without replacing it. The
 * repository's default `:focus-visible` rule (theme.css) already applies
 * here; this override only widens the offset so the ring clears the
 * button's own border rather than sitting flush against it.
 */
.ui-button:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

/*
 * Disabled is visibly disabled and carries the real attribute (never only a
 * class), so `aria-disabled`-style ambiguity never arises here.
 */
.ui-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
