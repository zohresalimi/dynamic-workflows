<script setup lang="ts">
/**
 * KAR-24.2 AC5 — the design-system wrapper around the run-state vocabulary,
 * not a second definition of it.
 *
 * `src/components/StateChip.vue` (KAR-16.1) already carries colour + glyph +
 * text label for the seven `DisplayState`s, and that contract is a fixed
 * point this story is told not to touch: the glyph set, `STATE_LABELS` and
 * `stateVar()` all live in `src/lib/state-palette.ts` and stay there. This
 * component is the `ui/` vocabulary's entry point to that contract — it reads
 * the same palette and lifts the same glyph markup, rather than drawing new
 * icons or inventing a second label map that could drift from the first.
 *
 * The label is real text and is never `aria-hidden`: WCAG 1.4.1 and §9.2's
 * "colour is never the only signal" both fail the moment a status board can
 * be read only by colour, and a hidden label is exactly that with extra
 * steps.
 */
import { Ban, Check, CircleSlash, Clock, Play, UserRound, X } from 'lucide-vue-next';
import type { Component } from 'vue';
import { computed } from 'vue';
import { type DisplayState, STATE_LABELS, stateVar } from '../../lib/state-palette.ts';

const props = defineProps<{
  readonly state: DisplayState;
  /** Overrides the palette's own text, for a caller that needs a shorter word in a tight row. */
  readonly label?: string;
}>();

// Lifted verbatim from StateChip.vue — see the comment there for why shape,
// not just stroke count, is what these seven have to differ in.
const GLYPHS: Record<DisplayState, Component> = {
  pending: Clock,
  running: Play,
  blocked: Ban,
  passed: Check,
  failed: X,
  abandoned: CircleSlash,
  'awaiting-human': UserRound,
};

const resolvedLabel = computed(() => props.label ?? STATE_LABELS[props.state]);
const glyph = computed(() => GLYPHS[props.state]);
const colour = computed(() => stateVar(props.state));
</script>

<template>
  <span
    class="ui-state-chip"
    role="img"
    :aria-label="resolvedLabel"
    :data-state="state"
    :style="{ color: colour }"
  >
    <span class="ui-state-chip__glyph" data-slot="glyph" aria-hidden="true">
      <component :is="glyph" :size="12" :stroke-width="2.25" />
    </span>
    <span class="ui-state-chip__label" data-slot="label">{{ resolvedLabel }}</span>
  </span>
</template>

<style scoped>
.ui-state-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  padding: 3px 7px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.4;
  white-space: nowrap;
  /*
   * Same derivation as StateChip.vue: the fill comes from `currentcolor`,
   * which is the `colour` computed above, so there is one place — that
   * computed — that ever names a `--state-*` token.
   */
  background: color-mix(in oklab, currentcolor 12%, transparent);
  transition: background-color 120ms ease;
}

.ui-state-chip__glyph {
  display: inline-flex;
}
</style>
