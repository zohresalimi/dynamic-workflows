<script setup lang="ts">
/**
 * The run header: what this run was asked to do, on what, and how it is going.
 *
 * Everything here already existed and was scattered: the task summary and the
 * provider sentence were squeezed into a 52px topbar between a breadcrumb and
 * a search field, the run's status was a pill beside them, and the project's
 * name and path were in a raised card of their own below. Four surfaces for
 * one paragraph of facts about one run.
 *
 * ## Why it is flush on the canvas and not a card
 *
 * System law 1 gives a page one raised object, and on this page that object is
 * the gate card — the thing an operator has to *do*. A header card would be a
 * second raised box competing with it, and it would win by being first. So the
 * header is content on the ground: an `<h1>`, a row of labelled pairs, and two
 * quiet lines. Nothing about it is chrome.
 *
 * ## Why it says the status exactly once
 *
 * System law 4. `RunStatusPill` is the run's status on this surface and the
 * only thing on it that says a status word — no "awaiting human" chip beside
 * the title, no second badge counting gates. The topbar says how many things
 * are waiting across every run (`ApprovalsMenu`), and the gate card says what
 * *this* gate is. Three surfaces, three different sentences.
 *
 * ## What it owns
 *
 * No request, no store mutation, and no formatting of its own. `task` arrives
 * as a prop because `App.vue` already holds it; `RunStatusPill` and
 * `RunMetaStrip` read `useRunStore()` for themselves, which is the exception
 * those two components already made and documented — reading a store is not
 * mutating one.
 */
import type { SubmittedTask } from '../ledger/projections/index.ts';
import RunStatusPill from './frame/RunStatusPill.vue';
import RunMetaStrip from './RunMetaStrip.vue';
import RunTaskBanner from './RunTaskBanner.vue';

defineProps<{
  /** `run.submittedTask`, threaded down rather than read a second time. */
  readonly task: SubmittedTask | null;
  /** The project's display name, or its id until the answer lands. */
  readonly projectName: string;
  /**
   * The project's directory, as the daemon reports it.
   *
   * Required-and-nullable rather than optional, and the same for the two
   * below: under `exactOptionalPropertyTypes` an optional prop cannot be
   * handed a `string | null | undefined`, and every caller here is computing
   * exactly that from an answer that may not have landed. `null` is the
   * honest value for "the daemon has not told us", and it is a value rather
   * than an absence.
   */
  readonly projectPath: string | null;
  /** The daemon's own sentence about the project's directory, when it has one. */
  readonly healthMessage: string | null;
  /** When the run on screen was created — the `started` pair's value. */
  readonly startedAt: string | null;
}>();
</script>

<template>
  <header class="run-header" data-run-header>
    <div class="run-header__title-row">
      <!--
        The `<h1>` is the task itself: it is what this page is about. Nothing
        else on the page is a heading of this weight.
      -->
      <RunTaskBanner class="run-header__task" :task="task" heading />
      <h1 v-if="task === null" class="run-header__fallback">{{ projectName }}</h1>
      <!-- Law 4 — the header's one status token. -->
      <RunStatusPill class="run-header__status" />
    </div>

    <RunMetaStrip :started-at="startedAt" />

    <!--
      A project whose directory has gone still shows everything below; it just
      says so, in the daemon's own sentence (EPIC-22-S45). The sentence is the
      carrier and it is prose — never a chip (law 5), which is what the health
      chip beside it used to be.
    -->
    <p v-if="healthMessage" class="run-header__health" data-workspace-health role="status">
      {{ healthMessage }}
    </p>

    <p class="run-header__project">
      <span data-workspace-project-name>{{ projectName }}</span>
      <span v-if="projectPath">{{ projectPath }}</span>
    </p>
  </header>
</template>

<style scoped>
/* Flush on `--surface-canvas`: no background, no border, no shadow. See the
   header comment — this is content, not chrome. */
.run-header {
  display: grid;
  gap: 6px; /* geometry — the header's own row rhythm */
  min-width: 0;
}

.run-header__title-row {
  display: flex;
  align-items: baseline;
  gap: 12px; /* geometry — title-to-status gutter */
  min-width: 0;
}

.run-header__task {
  min-width: 0;
  flex: 1 1 auto;
}

/* Before the run's first frame there is no task to be the heading, and a page
   with no `<h1>` is a page a screen reader cannot outline. The project's name
   stands in until the projection has one. */
.run-header__fallback {
  margin: 0;
  font-size: var(--text-xl);
  font-weight: 600;
  min-width: 0;
  overflow-wrap: anywhere;
  flex: 1 1 auto;
}

.run-header__status {
  flex: none;
  margin-left: auto;
}

/* The message is always a sentence: the colour is an extra cue, never the
   carrier (docs/12 §9.2). */
.run-header__health {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--state-blocked);
}

.run-header__project {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px; /* geometry — name-to-path gutter */
  margin: 0;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-faint);
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
