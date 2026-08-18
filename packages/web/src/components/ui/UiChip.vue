<script setup lang="ts">
/**
 * KAR-24.2 AC1, AC3 — the small tinted label every screen uses for a tag, a
 * pill or a badge that is not a run state (that is `UiStateChip`, which wraps
 * `src/lib/state-palette.ts` instead of taking a colour of its own).
 *
 * Six variants — `neutral | accent | ok | warn | error | info` — chosen for
 * what they mean semantically, not for the seven or eight callers that will
 * eventually reach for them. Each tinted variant reads a single `--state-*`
 * custom property for its foreground and derives its border and background
 * from that same property with `color-mix()`: one declaration per variant
 * instead of three separately-maintained colours that could drift apart the
 * next time a token's value moves.
 */
withDefaults(
  defineProps<{
    readonly variant?: 'neutral' | 'accent' | 'ok' | 'warn' | 'error' | 'info';
    readonly mono?: boolean;
  }>(),
  {
    variant: 'neutral',
    mono: false,
  },
);
</script>

<template>
  <span class="ui-chip" :data-variant="variant" :class="{ 'ui-chip--mono': mono }">
    <slot />
  </span>
</template>

<style scoped>
.ui-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--edge-control);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  color: var(--ink-muted);
  background: transparent;
  line-height: 1.4;
  white-space: nowrap;
}

.ui-chip--mono {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

/*
 * The four tinted variants each name one `--state-*` token and let
 * `color-mix()` derive the other two channels from it, rather than each
 * variant carrying its own border and background custom property — the
 * formula is the thing that is shared, not the resolved colours.
 */
.ui-chip[data-variant="accent"] {
  color: var(--state-running);
  border-color: color-mix(in oklab, var(--state-running) 30%, var(--edge));
  background: color-mix(in oklab, var(--state-running) 10%, var(--surface));
}

.ui-chip[data-variant="ok"] {
  color: var(--state-passed);
  border-color: color-mix(in oklab, var(--state-passed) 30%, var(--edge));
  background: color-mix(in oklab, var(--state-passed) 10%, var(--surface));
}

.ui-chip[data-variant="warn"] {
  color: var(--state-blocked);
  border-color: color-mix(in oklab, var(--state-blocked) 30%, var(--edge));
  background: color-mix(in oklab, var(--state-blocked) 10%, var(--surface));
}

.ui-chip[data-variant="error"] {
  color: var(--state-failed);
  border-color: color-mix(in oklab, var(--state-failed) 30%, var(--edge));
  background: color-mix(in oklab, var(--state-failed) 10%, var(--surface));
}

.ui-chip[data-variant="info"] {
  color: var(--state-awaiting-human);
  border-color: color-mix(in oklab, var(--state-awaiting-human) 30%, var(--edge));
  background: color-mix(in oklab, var(--state-awaiting-human) 10%, var(--surface));
}
</style>
