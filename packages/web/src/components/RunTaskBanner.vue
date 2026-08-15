<script setup lang="ts">
/**
 * KAR-22.2 AC6 — the run header's fifth surface: what this run was asked to do.
 *
 * The sibling of `./RunProviderBanner.vue` and `./RunGateBanner.vue`, written to
 * the same rule: it is true of the *run* rather than of one panel of it, so it
 * lives in the shell rather than in a view, and an operator who wants to know
 * what they asked for should not have to find the right tab first.
 *
 * **It renders a projection, never the composer's memory.** The composer clears
 * when it submits; this reads `task.submitted` off the run's own ledger, which
 * is what makes the answer the same on a second tab, after a reload, and for
 * every run started from a terminal (EPIC-22-S27).
 *
 * Renders nothing at all before the run's first event has been folded. An empty
 * banner would be a sentence about the absence of a fact, and this surface only
 * reports facts.
 *
 * Verifies: EPIC-22-S27 · AC6
 */
import type { SubmittedTask } from '../ledger/projections/index.ts';

defineProps<{ readonly task: SubmittedTask | null }>();

/** What the kind is called on screen — the operator's word for the door the run
 * came in through, not the payload's. */
const LABELS: Readonly<Record<string, string>> = {
  text: 'prompt',
  file: 'file',
  issue: 'issue',
};
</script>

<template>
  <section v-if="task" class="run-task" data-run-task :data-run-task-kind="task.kind">
    <span class="run-task__kind">{{ LABELS[task.kind] ?? task.kind }}</span>
    <!--
      The source as it was submitted, never summarised: intake stores `raw`
      byte-for-byte and this is the only place it is shown back. A source over
      the inline threshold has no `raw` at all, and the honest rendering of that
      is the file it came from plus the handle it went to.
    -->
    <span class="run-task__summary" :title="task.raw ?? task.summary">{{ task.summary }}</span>
    <span v-if="task.raw === null && task.handle" class="run-task__handle">{{ task.handle }}</span>
  </section>
</template>

<style scoped>
.run-task {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  min-width: 0;
  font-size: 0.8125rem;
}

.run-task__kind {
  padding: 0.05rem 0.4rem;
  border: 1px solid var(--edge, rgb(0 0 0 / 20%));
  border-radius: 999px;
  opacity: 0.8;
}

.run-task__summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 28ch;
}

.run-task__handle {
  font-family: var(--font-mono, monospace);
  opacity: 0.6;
}
</style>
