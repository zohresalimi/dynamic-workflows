<script setup lang="ts">
/**
 * KAR-25.5 — the composer's page frame: "/projects/:projectId/new-run".
 *
 * Verifies: AC1, AC3, AC5, AC8, EPIC-25-S34, EPIC-25-S35 · KAR-25.5
 *
 * The composer used to be `App.vue`'s global overlay, opened by `c` or the
 * topbar's "Start a run" button and closed by `Esc`, an outside click, or a
 * submit. Neither reason it lived there survives this story: "reachable from
 * anywhere in the project" is a property a *route* has too (`App.vue`'s
 * `openComposer()` gets there from any route the same way the overlay used
 * to), and a form with nowhere to cancel *to* was never really a dialog to
 * begin with — see `../components/RunComposer.vue`'s own header for the
 * `UiModal` removal in full.
 *
 * This file owns exactly the page chrome: the heading, and the footer hint.
 * `RunComposer.vue` is the composer bar itself, kept a separate file so its
 * `data-composer-*` selectors and `composer.test.ts` keep their identity —
 * this split mirrors `ProjectWorkflowsView.vue` mounting `PlanGraphView`
 * rather than inlining the canvas.
 *
 * `<main>` is already `App.vue`'s (`shell__main`, wrapping every `RouterView`);
 * this view fills it rather than opening a second one, unlike `ProjectsView`,
 * `RunListView` and `SettingsView`, which each predate a shell that wraps
 * every route in one and still carry their own `MAIN_CONTENT_ID` main from
 * before that was true. Not fixed here — nothing in this story owns that
 * cleanup — but this file does not repeat it.
 *
 * **"Start from a workflow" is not rendered.** The blueprint draws a row of
 * chips under the bar ("Issue → PR pipeline · 8 steps", "Nightly regression
 * triage"); there is no workflow entity anywhere in this product to draw them
 * from — `grep -rn workflow packages/daemon/src packages/core/src` finds
 * nothing but MCP catalog prose, and "Workflows" is only KAR-25.1's rename of
 * the project view. The story's own acceptance criterion ("when the project
 * has any") is satisfied vacuously by omitting the section, which is the
 * option this story's design pass recommended over inventing a "start from a
 * past run" chip that would be a different claim than the blueprint makes.
 */
import RunComposer from '../components/RunComposer.vue';

const props = defineProps<{
  /** From `/projects/:projectId/new-run` (`props: true`). */
  readonly projectId: string;
}>();
</script>

<template>
  <div class="new-run" data-new-run>
    <h1 class="new-run__heading">What do you want me to do?</h1>

    <RunComposer :project-id="props.projectId" />

    <p class="new-run__hint">Press / to focus the prompt · ⌘↵ to run</p>
  </div>
</template>

<style scoped>
.new-run {
  max-width: 46rem;
  margin: 0 auto;
  padding: 48px 16px 16px; /* geometry — the page's own top-heavy padding, the heading centred in the frame */
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 20px; /* geometry — heading-to-bar-to-hint stack gap */
}

.new-run__heading {
  text-align: center;
  margin: 0;
  font-size: var(--text-2xl);
  color: var(--ink);
}

.new-run__hint {
  text-align: center;
  margin: 0;
  font-size: var(--text-xs);
  color: var(--ink-faint);
}
</style>
