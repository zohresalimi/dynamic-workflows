<script setup lang="ts">
/**
 * KAR-24.2 AC1 — the dashed placeholder every empty list ends at ("New
 * project", "No runs yet"). EPIC-24 AC5 (KAR-24.7) requires every list to have
 * a real empty state with a sentence and an action rather than a bare "No
 * runs" — this is the one component that answer routes through, so the
 * sentence and the action are structural, not optional decoration a screen can
 * skip.
 *
 * The hover treatment reads `--state-running` rather than a border/ink pairing
 * invented here: an empty state is an invitation to act, and `running` is
 * already this application's colour for "something is about to happen" —
 * reusing it says the same thing with a token this file doesn't own a second
 * copy of.
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
  min-height: 210px; /* geometry — the prototype's empty-tile height */
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px; /* geometry — the stack gap between title, hint and action */
  border: 1px dashed var(--edge-dashed);
  border-radius: var(--radius-xl);
  color: var(--ink-dim);
  transition:
    border-color 120ms ease,
    color 120ms ease;
}

.ui-empty-state:hover {
  border-color: var(--state-running);
  color: var(--state-running);
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
