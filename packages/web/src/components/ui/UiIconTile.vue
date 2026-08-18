<script setup lang="ts">
/**
 * KAR-24.2 AC1, AC3 — the rounded square behind every node, row and card icon
 * in direction A, one component instead of the same three lines of flex
 * centring rewritten on every screen.
 *
 * `tint` is a CSS colour *value*, not a variant name: the component writes no
 * colour of its own and takes whatever the caller passes, on the
 * understanding that the caller sourced it from a token
 * (`var(--state-passed)`, `stateVar(state)`, …). That keeps this component
 * free of a `variant` prop that would otherwise grow one entry per screen —
 * exactly the failure "the one rule this epic is designed around" names.
 */
withDefaults(
  defineProps<{
    readonly size?: 'sm' | 'md' | 'lg';
    readonly tint?: string;
  }>(),
  {
    size: 'sm',
    tint: 'var(--surface-control)',
  },
);
</script>

<template>
  <span class="ui-icon-tile" :data-size="size" :style="{ background: tint }">
    <slot />
  </span>
</template>

<style scoped>
.ui-icon-tile {
  display: grid;
  place-items: center;
  flex: none;
  color: var(--ink);
}

/* Structural pixel dimensions read off the prototype, not type sizes — see
   HARD RULES §3. */
.ui-icon-tile[data-size="sm"] {
  width: 18px; /* geometry, not type */
  height: 18px; /* geometry, not type */
  border-radius: var(--radius-sm);
}

.ui-icon-tile[data-size="md"] {
  width: 22px; /* geometry, not type */
  height: 22px; /* geometry, not type */
  border-radius: var(--radius-md);
}

.ui-icon-tile[data-size="lg"] {
  width: 26px; /* geometry, not type */
  height: 26px; /* geometry, not type */
  border-radius: var(--radius-md);
}
</style>
