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
 * ## `heading`, and why this is one component rather than two
 *
 * The redesign gives the project view a real run header, whose first row is
 * this same task at heading size. That could have been new markup in
 * `./RunHeader.vue` — and it would have been a second element carrying
 * `data-run-task`, a second `title="raw"`, a second decision about what to do
 * when a source has no `raw` at all. Three hooks and one honesty rule, copied.
 * So the *element* is a prop instead: `heading` renders an `<h1>` at
 * `--text-xl`, clamped to two lines and wrapping anywhere; the default renders
 * the `<section>` the topbar has always shown, one ellipsised line wide. One
 * component, one set of facts, two sizes.
 *
 * Verifies: EPIC-22-S27 · AC6
 */
import type { SubmittedTask } from '../ledger/projections/index.ts';
import { UiChip } from './ui/index.ts';

withDefaults(
  defineProps<{
    readonly task: SubmittedTask | null;
    /** Render as the page's `<h1>` rather than as the topbar's one-liner. */
    readonly heading?: boolean;
  }>(),
  { heading: false },
);

/** What the kind is called on screen — the operator's word for the door the run
 * came in through, not the payload's. */
const LABELS: Readonly<Record<string, string>> = {
  text: 'prompt',
  file: 'file',
  issue: 'issue',
};
</script>

<template>
  <component
    :is="heading ? 'h1' : 'section'"
    v-if="task"
    class="run-task"
    :class="{ 'run-task--heading': heading }"
    data-run-task
    :data-run-task-kind="task.kind"
  >
    <!--
      System law 1 — the kind was a hand-rolled pill with a border and a
      999px radius, which is `UiChip` spelled again in one file. It is the
      chip now, borderless in its neutral variant, which is what a small tag
      sitting inside a heading should weigh.
    -->
    <UiChip class="run-task__kind" size="xs">{{ LABELS[task.kind] ?? task.kind }}</UiChip>
    <!--
      The source as it was submitted, never summarised: intake stores `raw`
      byte-for-byte and this is the only place it is shown back. A source over
      the inline threshold has no `raw` at all, and the honest rendering of that
      is the file it came from plus the handle it went to.
    -->
    <span class="run-task__summary" :title="task.raw ?? task.summary">{{ task.summary }}</span>
    <span v-if="task.raw === null && task.handle" class="run-task__handle">{{ task.handle }}</span>
  </component>
</template>

<style scoped>
.run-task {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  min-width: 0;
  margin: 0;
  font-size: var(--text-md);
}

.run-task__kind {
  flex: none;
  align-self: center;
}

.run-task__summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 28ch;
}

.run-task__handle {
  font-family: var(--font-mono);
  color: var(--ink-faint);
}

/*
 * The heading form: the page's own `<h1>`. Two lines and then an ellipsis —
 * a task summary is a whole prompt, and an unbounded one pushes the gate card
 * off the fold, which is the one thing this page's layout exists to prevent.
 */
.run-task--heading {
  font-size: var(--text-xl);
  font-weight: 600;
  line-height: 1.25;
  align-items: baseline;
  flex-wrap: wrap;
}

.run-task--heading .run-task__summary {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  white-space: normal;
  overflow-wrap: anywhere;
  max-width: none;
  min-width: 0;
}

.run-task--heading .run-task__handle {
  font-size: var(--text-xs);
}
</style>
