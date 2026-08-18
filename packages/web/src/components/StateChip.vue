<script setup lang="ts">
/**
 * KAR-16.1 AC5, KAR-24.2 AC5 — the one component every view renders a run
 * state through, now a thin wrapper around `ui/UiStateChip`.
 *
 * The name, the file and the two props (`state`, `detail`) are the fixed
 * point `StateChip.test.ts` was written against, and KAR-24.2 does not get to
 * move any of them — every screen listed in `TaskBoard.vue`, `NodeInspector.vue`
 * and `CommandJumper.vue` still imports `StateChip` exactly as before. What
 * moves is the *body*: colour, glyph and label are no longer drawn here a
 * second time, they are `UiStateChip`, imported from the barrel (`../ui/index.ts`,
 * never by file path — AC7) so the design system has exactly one place that
 * knows the seven glyphs and one that reads `stateVar()`. `detail` is the one
 * thing `UiStateChip` does not carry — it is a run-state concept ("an attempt
 * count, a duration, a node id"), not a design-system primitive — so it stays
 * here as a plain sibling span rather than becoming a prop on the shared
 * component that every other caller would then have to ignore.
 */
import type { DisplayState } from '../lib/state-palette.ts';
import { UiStateChip } from './ui/index.ts';

defineProps<{
  readonly state: DisplayState;
  /** Rendered after the label — an attempt count, a duration, a node id. */
  readonly detail?: string;
}>();
</script>

<template>
  <span class="state-chip">
    <UiStateChip :state="state" />
    <span v-if="detail !== undefined" class="state-chip__detail" data-slot="detail">
      {{ detail }}
    </span>
  </span>
</template>

<style scoped>
.state-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
}

.state-chip__detail {
  color: var(--ink-muted);
  font-size: var(--text-xs);
  white-space: nowrap;
}
</style>
