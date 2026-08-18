<script setup lang="ts">
/**
 * KAR-24.2 AC1 — fan-out bars, run progress and the swarm dock header: every
 * place direction A shows a total as two competing fractions (what finished,
 * what is still running) rather than the single fraction UiMeter draws.
 *
 * `total === 0` is guarded rather than left to produce `NaN%` widths — a plan
 * with no nodes yet is a real state this renders through (an empty track),
 * not a division this component gets to crash on.
 *
 * AC4 — the value triad plus `aria-valuetext`, because "42% done" is not what
 * this bar means: two independent fractions collapse to one `aria-valuenow`
 * (done, the fraction that only grows) with `aria-valuetext` spelling out the
 * running fraction a numeric-only reading would drop.
 */
import { computed } from 'vue';

const props = defineProps<{
  readonly done: number;
  readonly running: number;
  readonly total: number;
}>();

const donePct = computed(() => (props.total === 0 ? 0 : (props.done / props.total) * 100));
const runningPct = computed(() => (props.total === 0 ? 0 : (props.running / props.total) * 100));
const valueText = computed(() => `${props.done} of ${props.total} done, ${props.running} running`);
</script>

<template>
  <div
    class="ui-progress-split"
    role="progressbar"
    :aria-valuenow="donePct"
    aria-valuemin="0"
    aria-valuemax="100"
    :aria-valuetext="valueText"
  >
    <div class="ui-progress-split__done" :style="{ width: `${donePct}%` }" />
    <div class="ui-progress-split__running" :style="{ width: `${runningPct}%` }" />
  </div>
</template>

<style scoped>
.ui-progress-split {
  display: flex;
  height: 4px; /* geometry — the track's own thickness */
  border-radius: var(--radius-xs);
  background: var(--edge-strong);
  overflow: hidden;
}

.ui-progress-split__done {
  height: 100%;
  background: var(--state-passed);
  transition: width 0.4s ease;
}

.ui-progress-split__running {
  height: 100%;
  background: var(--state-running);
  transition: width 0.4s ease;
}
</style>
