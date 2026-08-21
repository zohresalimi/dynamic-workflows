// This directory is the component library: every primitive a DeFlow screen is
// built from, and nothing else. The barrel exists because of KAR-24.2 AC7 —
// nothing outside `ui/` is allowed to import a file inside it by path, so the
// full set of things the library offers is one file a reader can open, and
// adding a sixteenth component is a visible decision in this file's diff
// rather than an import path that quietly appeared somewhere in a screen.
//
// Fifteen was a ceiling, not a target: the story's "one rule" is that a shape
// is only promoted here once it recurs across screens with no domain-specific
// variant name attached. A shape that has shown up twice so far is a slot in
// an existing component (a named slot, a `data-variant` value drawn from the
// fixed vocabularies), not a reason to add a sixteenth file.
//
// The sixteenth exists, and this comment is the record of the decision it
// asked for: KAR-26.4 added `UiDisclosure`, the row-level disclosure the
// settings blueprint demotes its prose behind. It recurs across screens by
// construction (runtime rows and connector rows on day one), carries no
// domain-specific variant name (no `variant`/`size`/`tone` at all), and no
// existing primitive could express it — collapsing is not a slot on any of
// the fifteen. Sixteen is the new ceiling, on the same rule.

// `DisplayState` is the shared vocabulary UiStateChip's `state` prop is typed
// against (see src/lib/state-palette.ts) — re-exported here so a caller who
// only imports from `ui/` can still type a `state` value without reaching
// past the barrel.
export type { DisplayState } from '../../lib/state-palette.ts';
export { default as UiButton } from './UiButton.vue';
export { default as UiCard } from './UiCard.vue';
export { default as UiChip } from './UiChip.vue';
export { default as UiDisclosure } from './UiDisclosure.vue';
export { default as UiEmptyState } from './UiEmptyState.vue';
export { default as UiField } from './UiField.vue';
export { default as UiIconTile } from './UiIconTile.vue';
export { default as UiMetaRow } from './UiMetaRow.vue';
export { default as UiMeter } from './UiMeter.vue';
export { default as UiModal } from './UiModal.vue';
export { default as UiPanel } from './UiPanel.vue';
export { default as UiProgressSplit } from './UiProgressSplit.vue';
export { default as UiSectionLabel } from './UiSectionLabel.vue';
export { default as UiStateChip } from './UiStateChip.vue';
export { default as UiStatTile } from './UiStatTile.vue';
export { default as UiToggle } from './UiToggle.vue';
