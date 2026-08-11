<script setup lang="ts">
/**
 * KAR-16.1 AC5 — the one component every view renders a run state through.
 *
 * Colour + glyph + text label, every time (WCAG 1.4.1,
 * docs/12-frontend-architecture.md §9.2). There is deliberately no prop for
 * turning any of the three off: a "compact" variant that dropped the label is
 * how a status board becomes colour-only one PR at a time.
 *
 * `role="img"` with the label as its accessible name, rather than a bare span:
 * a span has no role, so it has no accessible name at all, and a test asserting
 * on one would be asserting on nothing. The glyph inside is `aria-hidden`
 * because the name already says "Failed" and announcing it twice is worse than
 * either.
 *
 * The colour is an **inline `var(--state-…)` reference** and never a resolved
 * value: the palette lives in one stylesheet (../styles/theme.css) and dark
 * mode is those seven lines being redefined, so a component that computed a
 * colour would be a second definition and the two would drift.
 */
import { Ban, Check, CircleSlash, Clock, Play, UserRound, X } from 'lucide-vue-next';
import type { Component } from 'vue';
import { computed } from 'vue';
import { type DisplayState, STATE_LABELS, stateVar } from '../lib/state-palette.ts';

const props = defineProps<{
  readonly state: DisplayState;
  /** Rendered after the label — an attempt count, a duration, a node id. */
  readonly detail?: string;
}>();

/**
 * Seven states, seven silhouettes.
 *
 * Chosen to differ in *shape* and not only in stroke count, because the whole
 * point of the glyph is to carry the state for a reader who cannot rely on the
 * hue. A set where `passed` and `failed` were both a circle would satisfy the
 * letter of the rule and none of its purpose.
 */
const GLYPHS: Record<DisplayState, Component> = {
  pending: Clock,
  running: Play,
  blocked: Ban,
  passed: Check,
  failed: X,
  abandoned: CircleSlash,
  'awaiting-human': UserRound,
};

const label = computed(() => STATE_LABELS[props.state]);
const glyph = computed(() => GLYPHS[props.state]);
const colour = computed(() => stateVar(props.state));
</script>

<template>
  <span
    class="state-chip"
    role="img"
    :aria-label="label"
    :data-state="state"
    :style="{ color: colour }"
  >
    <span class="state-chip__glyph" data-slot="glyph" aria-hidden="true">
      <component :is="glyph" :size="14" :stroke-width="2.25" />
    </span>
    <span class="state-chip__label" data-slot="label">{{ label }}</span>
    <span v-if="detail !== undefined" class="state-chip__detail" data-slot="detail">
      {{ detail }}
    </span>
  </span>
</template>

<style scoped>
.state-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  padding: 0.15em 0.5em;
  border: 1px solid currentcolor;
  border-radius: 999px;
  /*
   * The fill is derived from the same variable rather than being an eighth
   * token: `color-mix` keeps the tint in step with any future change to the
   * seven, and keeps the surface underneath it whichever theme is on.
   */
  background: color-mix(in oklch, currentcolor 12%, var(--surface));
  font-size: 0.8125rem;
  line-height: 1.4;
  white-space: nowrap;
  /*
   * Deliberately outside the `prefers-reduced-motion` block in
   * ../styles/theme.css: a chip settling into a new colour is not the motion
   * that makes people ill, and a blanket kill of every transition in the app
   * makes it feel broken rather than calm.
   */
  transition: background-color 120ms ease;
}

.state-chip__glyph {
  display: inline-flex;
}

.state-chip__detail {
  color: var(--ink-muted);
}
</style>
