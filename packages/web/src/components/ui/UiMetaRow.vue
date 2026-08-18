<script setup lang="ts">
/**
 * KAR-24.2 AC1 — one label/value line, the inspector's config tab and any
 * other "key: value" list built out of the same row rather than a table
 * nobody needs for two columns.
 *
 * The label sits at a fixed 96px so a stack of rows lines its values up in a
 * column regardless of how long each label is — a flex-basis that varied per
 * row would make the value column ragged, which is the one thing a settings
 * list cannot afford to be. `mono` defaults on because the value is usually an
 * identifier, a model id or a number, and JetBrains Mono is this
 * application's typeface for exactly that (KAR-24.1 AC4).
 */
withDefaults(
  defineProps<{
    readonly label: string;
    readonly value: string;
    readonly mono?: boolean;
  }>(),
  { mono: true },
);
</script>

<template>
  <div class="ui-meta-row">
    <span class="ui-meta-row__label">{{ label }}</span>
    <span class="ui-meta-row__value" :data-mono="mono || undefined">{{ value }}</span>
  </div>
</template>

<style scoped>
.ui-meta-row {
  display: flex;
  align-items: center;
  gap: 10px; /* geometry — the label/value gutter */
  padding: 9px 11px; /* geometry — the row's own padding */
  border-bottom: 1px solid var(--edge);
}

.ui-meta-row__label {
  width: 96px; /* geometry — the fixed label column the value aligns against */
  flex: none;
  font-size: var(--text-base);
  color: var(--ink-muted);
}

.ui-meta-row__value {
  flex: 1;
  text-align: right;
  font-size: var(--text-sm);
  color: var(--ink);
}

.ui-meta-row__value[data-mono] {
  font-family: var(--font-mono);
}
</style>
