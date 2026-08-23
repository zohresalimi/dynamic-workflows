<script setup lang="ts">
/**
 * What the graph says when it has no nodes to draw — extracted from
 * `../../views/PlanGraphView.vue` so that a second surface can say it too.
 *
 * The redesign gives a run that has stopped at its spec gate a slim strip
 * instead of an empty 3fr/2fr split, and that strip has to report the same
 * four states the canvas does: no run open, hydrating, reconnecting, or a run
 * whose plan has not been compiled yet. Two components spelling those four
 * sentences is how they start to disagree — one saying "Reconnecting…" while
 * the other still says "Reading the run's ledger…" for the same feed status —
 * so the sentences live here and both callers mount this.
 *
 * `PlanGraphView` keeps its own `v-if` on `nodes.length === 0` and its own
 * absolute-positioned placement: *where* the note sits is the caller's layout
 * problem, and this component takes no position of its own.
 */
defineProps<{
  /** The run on screen, or `null` on the project-less landing route. */
  readonly runId: string | null;
  /** `useRunFeed()`'s own status word for this run's subscription. */
  readonly status: string;
}>();
</script>

<template>
  <span class="graph-empty" data-graph-empty>
    <template v-if="runId === null">
      No run open. Open one at <code>/runs/&lt;runId&gt;</code>, or start one with
      <code>deflow run</code>.
    </template>
    <template v-else-if="status === 'hydrating'">Reading the run's ledger…</template>
    <template v-else-if="status === 'reconnecting'">
      Reconnecting to the daemon. The graph is what this tab last saw.
    </template>
    <template v-else>
      No plan yet. A run's graph appears here as soon as its first plan is compiled.
    </template>
  </span>
</template>

<style scoped>
.graph-empty {
  color: var(--ink-muted);
  font-size: var(--text-sm);
}
</style>
