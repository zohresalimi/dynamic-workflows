<script setup lang="ts">
/**
 * KAR-17.8 — F10.9's run timeline view.
 *
 * Verifies: EPIC-17-S30, EPIC-17-S31, EPIC-17-S32 · AC1–AC10
 *
 * Roadmap §3 keeps this at P0 with an argument worth repeating, because it is
 * the reason the story is an `M` and not an `L`: *"it looks like the expensive
 * one and is not"*. Everything it draws — `node.started`, `node.completed`,
 * `node.suspended`, `budget.consumed` — is already in a projection, so the
 * whole view is a scale, an SVG and a table.
 *
 * **It joins nothing and it reduces nothing.** The timeline projection is the
 * single source, which is what lets the chart and its data table be the same
 * derivation rather than two that agree today. The only thing this file adds is
 * the clock: `useNow` so a running attempt's bar keeps reaching the right-hand
 * edge while the tab is open, injected as a prop so the drawing itself stays a
 * pure function of (projection, now) and can be asserted without waiting for
 * time to pass.
 */
import { useNow } from '@vueuse/core';
import { computed } from 'vue';
import { useRunFeed } from '../app/useRunFeed.ts';
import RunTimelineChart from '../components/RunTimelineChart.vue';
import { useRunStore } from '../stores/useRunStore.ts';

const props = defineProps<{
  /** From `/runs/:runId/timeline`. */
  readonly runId?: string;
}>();

const run = useRunStore();
const runId = computed<string | null>(() => props.runId ?? null);
const { status } = useRunFeed(runId);

/**
 * Ticked once a second, the same cadence the plan graph uses for node bodies.
 *
 * A running bar has to keep growing or it reads as a node that stopped, and
 * the alternative — recomputing only when an event lands — freezes the bar of
 * exactly the node nobody has heard from, which is the one being looked at.
 */
const now = useNow({ interval: 1_000 });

/** The projection's own counter, so this recomputes on a timeline event only. */
const version = computed<number>(() => run.version('timeline'));

const hasSpans = computed<boolean>(() => {
  void version.value;
  return run.timeline.spans.size > 0;
});
</script>

<template>
  <section class="timeline" aria-label="Run timeline">
    <RunTimelineChart
      v-if="hasSpans"
      :timeline="run.timeline"
      :now="now.getTime()"
      :version="version"
    />

    <p v-else class="timeline__empty" data-timeline-empty>
      <template v-if="runId === null">
        No run open. Open one at <code>/runs/&lt;runId&gt;/timeline</code>.
      </template>
      <template v-else-if="status === 'hydrating'">Reading the run's ledger…</template>
      <template v-else-if="status === 'reconnecting'">
        Reconnecting to the daemon. This is what the tab last saw.
      </template>
      <template v-else>
        No node has started yet. A lane appears here for every node, and a bar for every attempt.
      </template>
    </p>
  </section>
</template>

<style scoped>
.timeline {
  block-size: 100%;
  overflow: auto;
}

.timeline__empty {
  display: grid;
  place-content: center;
  min-block-size: 12rem;
  color: var(--ink-muted);
  text-align: center;
}
</style>
