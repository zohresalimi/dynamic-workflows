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
    /**
     * How much padding the chip spends — `sm` (the default, what every caller
     * had before this prop existed) or `xs`, the tighter one a chip sitting
     * inline in a heading or a table row wants.
     *
     * A prop rather than a caller's own `:deep()` override, because "make this
     * chip a bit smaller" was being answered five different ways with five
     * different paddings. Two rungs, both appearance and neither named after a
     * screen, which is the library's own rule for what may become a prop.
     */
    readonly size?: 'xs' | 'sm';
  }>(),
  {
    variant: 'neutral',
    mono: false,
    size: 'sm',
  },
);
</script>

<template>
  <span
    class="ui-chip"
    :data-variant="variant"
    :data-size="size"
    :class="{ 'ui-chip--mono': mono }"
  >
    <slot />
  </span>
</template>

<style scoped>
.ui-chip {
  display: inline-flex;
  align-items: center;
  border-radius: var(--radius-xs);
  border: 1px solid var(--edge-control);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  color: var(--ink-muted);
  background: transparent;
  line-height: 1.4;
  white-space: nowrap;
}

.ui-chip[data-size="sm"] {
  padding: 2px 6px; /* geometry, not type */
}

.ui-chip[data-size="xs"] {
  padding: 1px 5px; /* geometry, not type */
}

/*
 * System law 1 — the neutral chip loses its border.
 *
 * A neutral chip is almost always *inside* a card, next to a title or in a
 * table row, and a bordered box inside a bordered box is the second wall the
 * redesign exists to take down. It carries its own quiet ground instead: a
 * hueless 7% mix of the theme's own `--ink`, which reads as a chip on paper
 * and on near-black without either theme needing a value of its own. The
 * tinted variants below keep their borders — they are meant to be found.
 */
.ui-chip[data-variant="neutral"] {
  border: none;
  background: color-mix(in oklab, var(--ink) 7%, transparent);
  color: var(--ink-muted);
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
/* Law 3 — `accent` names the accent. It used to name `--state-running`, which
   made every "this is the emphasised one" chip a claim about a *run status*
   that happened to share a hex. */
.ui-chip[data-variant="accent"] {
  color: var(--accent);
  border-color: color-mix(in oklab, var(--accent) 30%, var(--edge));
  background: color-mix(in oklab, var(--accent) 10%, var(--surface));
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
