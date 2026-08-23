<script setup lang="ts">
/**
 * KAR-24.2 AC1 — the dashed placeholder every empty list ends at ("New
 * project", "No runs yet"). EPIC-24 AC5 (KAR-24.7) requires every list to have
 * a real empty state with a sentence and an action rather than a bare "No
 * runs" — this is the one component that answer routes through, so the
 * sentence and the action are structural, not optional decoration a screen can
 * skip.
 *
 * ## The redesign's three changes here, and the reason for each
 *
 * - **No dashed placeholder.** The dashed rectangle was a wireframe idiom: it
 *   said "a thing goes here" on a screen where nothing is coming. What is
 *   left is the sentence and the action, which are the parts an operator
 *   reads (system law 1 — fewer boxes, not prettier ones).
 * - **120px, not 210px.** The tile height was sized for a grid cell in the
 *   prototype; used inline — a project's history, a run's board — it opened a
 *   hole in the page proportional to how little there was to say.
 * - **A neutral hover.** It used to read `--state-running`, which is a *run
 *   status* owned by ../../lib/state-palette.ts. An empty list is not a
 *   running anything, and system law 3 keeps the state palette for states;
 *   `--edge-hover`/`--ink-muted` say "this responds" without borrowing a
 *   meaning.
 */
defineProps<{
  readonly title: string;
  readonly hint?: string;
}>();
</script>

<template>
  <div class="ui-empty-state">
    <p class="ui-empty-state__title">{{ title }}</p>
    <p v-if="hint" class="ui-empty-state__hint">{{ hint }}</p>
    <div v-if="$slots.action" class="ui-empty-state__action">
      <slot name="action" />
    </div>
  </div>
</template>

<style scoped>
.ui-empty-state {
  min-height: 120px; /* geometry — an inline empty state, not a grid tile */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px; /* geometry — the stack gap between title, hint and action */
  border: 1px solid var(--edge);
  border-radius: var(--radius-xl);
  color: var(--ink-dim);
  transition:
    border-color 120ms ease,
    color 120ms ease;
}

.ui-empty-state:hover {
  border-color: var(--edge-hover);
  color: var(--ink-muted);
}

.ui-empty-state__title {
  font-size: var(--text-md);
  margin: 0;
}

.ui-empty-state__hint {
  font-size: var(--text-sm);
  color: var(--ink-faint);
  margin: 0;
}
</style>
