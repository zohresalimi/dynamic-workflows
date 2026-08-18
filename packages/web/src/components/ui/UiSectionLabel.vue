<script setup lang="ts">
/**
 * KAR-24.2 AC1 — the small mono caption every panel uses to name a section
 * ("STREAMING OUTPUT", "TOOL CALLS", "RUNTIMES"), spelled once so its
 * tracking and case do not get re-typed slightly differently on the next
 * screen.
 *
 * A `<div>` by default. An `as` prop exists only for the day some caller
 * genuinely needs this text under a heading element for outline purposes;
 * until that day the story's own guidance ("prefer not to") is followed and
 * every current use stays a `<div>`.
 */
withDefaults(
  defineProps<{
    readonly as?: string;
  }>(),
  {
    as: 'div',
  },
);
</script>

<template>
  <component :is="as" class="ui-section-label">
    <slot />
  </component>
</template>

<style scoped>
.ui-section-label {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  letter-spacing: 0.12em;
  color: var(--ink-faint);
  text-transform: uppercase;
}
</style>
