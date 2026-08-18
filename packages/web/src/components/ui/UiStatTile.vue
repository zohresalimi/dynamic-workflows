<script setup lang="ts">
/**
 * KAR-24.2 AC1 — the inspector's 2×2 stat grid and the project card's stat
 * row, both built from the same label-over-value tile instead of a bespoke
 * grid re-laid-out per screen.
 *
 * `tone` is the same five-word vocabulary as everywhere else a value needs a
 * state-adjacent colour (`default | ok | warn | error | accent`) — never a
 * screen name — so a tile reporting a failure count and a tile reporting a
 * queue depth are the same component with a different word, not two
 * components. `default` resolves to `--ink` rather than a state token,
 * because a tile with nothing notable to say should not borrow a colour that
 * implies it does.
 */
withDefaults(
  defineProps<{
    readonly label: string;
    readonly value: string | number;
    readonly tone?: 'default' | 'ok' | 'warn' | 'error' | 'accent';
  }>(),
  { tone: 'default' },
);
</script>

<template>
  <div class="ui-stat-tile" :data-tone="tone">
    <span class="ui-stat-tile__label">{{ label }}</span>
    <span class="ui-stat-tile__value">{{ value }}</span>
  </div>
</template>

<style scoped>
.ui-stat-tile {
  display: flex;
  flex-direction: column;
  gap: 2px; /* geometry — the label/value stack */
  background: var(--surface-inset);
  border: 1px solid var(--edge-strong);
  border-radius: var(--radius-lg);
  padding: 8px 9px; /* geometry — the tile's own padding */
}

.ui-stat-tile__label {
  font-family: var(--font-mono);
  font-size: var(--text-2xs);
  letter-spacing: 0.1em;
  color: var(--ink-faint);
}

.ui-stat-tile__value {
  font-family: var(--font-mono);
  font-size: var(--text-lg);
  color: var(--ink);
}

.ui-stat-tile[data-tone="ok"] .ui-stat-tile__value {
  color: var(--state-passed);
}

.ui-stat-tile[data-tone="warn"] .ui-stat-tile__value {
  color: var(--state-blocked);
}

.ui-stat-tile[data-tone="error"] .ui-stat-tile__value {
  color: var(--state-failed);
}

.ui-stat-tile[data-tone="accent"] .ui-stat-tile__value {
  color: var(--state-running);
}
</style>
