<script setup lang="ts">
/**
 * KAR-17.7 AC2 — one criterion's status, as colour + glyph + label.
 *
 * The three-state sibling of `./StateChip.vue`, and built to the same rule for
 * the same reason (WCAG 1.4.1): no prop turns any of the three signals off.
 * `unverifiable` is not a muted `unsatisfied` — it borrows `awaiting-human`'s
 * hue via `criterionStatusVar` precisely so a reader who cannot see colour at
 * all still gets a different glyph (`∅`) and a different word.
 */
import { computed } from 'vue';
import {
  CRITERION_STATUS_STYLE,
  type CriterionStatus,
  criterionStatusVar,
} from '../lib/criteria-board.ts';

const props = defineProps<{
  readonly status: CriterionStatus;
}>();

const style = computed(() => CRITERION_STATUS_STYLE[props.status]);
const colour = computed(() => criterionStatusVar(props.status));
</script>

<template>
  <span
    class="criterion-status"
    role="img"
    :aria-label="style.label"
    :data-status="status"
    :style="{ color: colour }"
  >
    <span class="criterion-status__glyph" data-status-glyph aria-hidden="true"
      >{{ style.glyph }}</span
    >
    <span class="criterion-status__label" data-status-label>{{ style.label }}</span>
  </span>
</template>

<style scoped>
.criterion-status {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  padding: 0.15em 0.5em;
  border: 1px solid currentcolor;
  border-radius: 999px;
  background: color-mix(in oklch, currentcolor 12%, var(--surface));
  font-size: 0.8125rem;
  line-height: 1.4;
  white-space: nowrap;
  transition: background-color 120ms ease;
}

.criterion-status__glyph {
  display: inline-flex;
}
</style>
