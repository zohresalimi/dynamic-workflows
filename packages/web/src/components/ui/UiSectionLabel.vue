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
 *
 * ## System law 2 — this is the application's only uppercase mono caption
 *
 * Uppercase mono is loud, and the redesign spends it in exactly one place: a
 * *group caption inside a card body*, naming a set of rows below it. It is
 * not a panel title (those are sentence-case sans), not a table header, and
 * not a label on a metadata pair — a caption that shouts louder than the
 * thing it captions is a caption that has become the content. The tracking
 * comes down from 0.12em to 0.08em for the same reason: at the new `--text-xs`
 * the old figure spaced the letters past the point where the word reads as a
 * word.
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
  letter-spacing: 0.08em;
  color: var(--ink-faint);
  text-transform: uppercase;
}
</style>
