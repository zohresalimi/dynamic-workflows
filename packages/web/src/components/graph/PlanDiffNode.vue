<script setup lang="ts">
/**
 * KAR-17.2 / KAR-24.5 — one node of the union graph, encoded by what happened
 * to it between the two versions being viewed, now drawn from `UiCard`.
 *
 * Verifies: EPIC-17-S7 · AC4, AC9; EPIC-24-S19..S22 · AC1
 *
 * ## Four classes, and none of them is a colour
 *
 * WCAG 1.4.1, and also simply better for a diff: roughly 8% of male engineers
 * will otherwise misread it, and a plan diff misread is a plan diff that
 * produced a wrong conclusion rather than no conclusion. So each class carries
 * a **border style**, an **opacity** and a **glyph**, and the four are
 * distinguishable from each other with colour switched off entirely —
 * `../../views/plan-scrubber.test.ts` asserts exactly that, as four distinct
 * signatures rather than four distinct hues.
 *
 * | class     | border | opacity | glyph |
 * | --------- | ------ | ------- | ----- |
 * | added     | solid  | full    | `+`   |
 * | removed   | dashed | reduced | `−`   |
 * | changed   | solid  | full    | `±`   |
 * | unchanged | solid  | full    | —     |
 *
 * `UiCard` is the shell for the reason the rest of this story reaches for it:
 * one raised surface, one radius, one background token, shared with every
 * other card in the application rather than redrawn here. `UiIconTile`,
 * `UiStateChip` and `UiMeter` are **not** reached for on this file — the
 * `+`/`−`/`±` badge is a mark in the diff vocabulary the table above defines,
 * not a *kind* glyph or a run *state*, and forcing it into `UiStateChip`'s
 * glyph-plus-label shape would blur a distinction this file's own encoding
 * depends on being kept separate from `PlanNode.vue`'s.
 *
 * ## Why a removed node is drawn at all
 *
 * It is drawn **in place**, at its union-layout coordinates. A node that simply
 * vanishes between two frames is indistinguishable from a node that moved off
 * screen, and "in place" is only meaningful because the layout covered both
 * versions (`../../lib/plan-diff.ts`).
 *
 * ## The click-through belongs to `changed` alone
 *
 * A `button` and not a click handler on the card: the field-level patch panel
 * is the answer to *"why is there a step here that I didn't ask for?"*, and an
 * answer only a pointer can reach is an answer half the operators cannot get
 * to. The other three classes have no patch to show — an added node's "patch"
 * is the whole node — so they get no control, which is also what stops the
 * graph being a field of buttons that mostly do nothing.
 */
import { computed } from 'vue';
import type { DiffClass, PlanVersionNodeVM } from '../../lib/plan-diff.ts';
import { UiCard } from '../ui/index.ts';

const props = defineProps<{
  readonly node: PlanVersionNodeVM;
  readonly diffClass: DiffClass;
  readonly selected?: boolean;
}>();

defineEmits<{ (event: 'open', nodeId: string): void }>();

/** The glyph half of the encoding. `unchanged` deliberately has none. */
const GLYPHS: Record<DiffClass, string> = {
  added: '+',
  removed: '−',
  changed: '±',
  unchanged: '',
};

/** The word a reader hears, which is the third signal and the accessible one. */
const WORDS: Record<DiffClass, string> = {
  added: 'added by this patch',
  removed: 'removed by this patch',
  changed: 'changed by this patch',
  unchanged: 'unchanged',
};

/**
 * The border half of the encoding, per class — and, like `./PlanNode.vue`'s
 * `cardStyle`, bound as an inline style rather than left to a scoped
 * `[data-diff-class="…"]` rule. `UiCard`'s own `[data-variant="raised"]` rule
 * carries one more attribute selector than a scoped rule on this file can, so
 * it would otherwise win the border this table exists to set — see the note
 * on `./PlanNode.vue`'s `cardStyle` for the full argument. `unchanged` reads
 * the plain `--edge` token, matching what the base card looked like before any
 * class was known.
 */
const CLASS_STYLE: Record<
  DiffClass,
  { borderStyle: string; borderColor: string; opacity: string }
> = {
  added: { borderStyle: 'solid', borderColor: 'var(--state-passed)', opacity: '1' },
  // Dashed *and* faded. Either alone would be ambiguous against a theme that
  // dims distant nodes (KAR-17.1 AC7); together they are a removal.
  removed: { borderStyle: 'dashed', borderColor: 'var(--state-abandoned)', opacity: '0.55' },
  changed: { borderStyle: 'solid', borderColor: 'var(--state-running)', opacity: '1' },
  unchanged: { borderStyle: 'solid', borderColor: 'var(--edge)', opacity: '1' },
};

const cardStyle = computed(() => ({
  ...CLASS_STYLE[props.diffClass],
  padding: '8px 10px', // geometry — direction A's card padding, not UiCard's general one
}));
</script>

<template>
  <UiCard
    variant="raised"
    class="diff-node"
    :class="{ 'is-selected': props.selected }"
    :data-diff-node="props.node.id"
    :data-diff-class="props.diffClass"
    :style="cardStyle"
  >
    <header class="diff-node__head">
      <!--
        `added` gets the badge and the other marked classes get a marker: two
        attribute names rather than one, because AC4 names "a `+` badge" and "a
        modified marker" as different things and a spec that could not tell them
        apart could not assert AC4.
      -->
      <span
        v-if="props.diffClass === 'added'"
        class="diff-node__badge"
        data-diff-badge
        :aria-label="WORDS[props.diffClass]"
        >{{ GLYPHS[props.diffClass] }}</span
      >
      <span
        v-else-if="GLYPHS[props.diffClass] !== ''"
        class="diff-node__marker"
        data-diff-marker
        :aria-label="WORDS[props.diffClass]"
        >{{ GLYPHS[props.diffClass] }}</span
      >

      <h3 class="diff-node__title">{{ props.node.title }}</h3>
    </header>

    <p class="diff-node__meta">
      <span>{{ props.node.type ?? 'node' }}</span>
      <span>{{ props.node.provider ?? 'no provider yet' }}</span>
      <span>{{ props.node.permission ?? 'no permission recorded' }}</span>
    </p>

    <!--
      AC9's split. Two nodes that came out of one carry the id they came from,
      and without it a split is indistinguishable from one node removed and two
      unrelated ones added — which is the single most confusing thing a replan
      can do to a reader.
    -->
    <p v-if="props.node.derivedFrom.length > 0" class="diff-node__derived">
      derived from {{ props.node.derivedFrom.join(', ') }}
    </p>

    <button
      v-if="props.diffClass === 'changed'"
      class="diff-node__open"
      type="button"
      data-diff-open
      @click.stop="$emit('open', props.node.id)"
    >
      Why did this change?
    </button>

    <!-- The word, for a reader, on every class including the unmarked one. -->
    <span class="visually-hidden">{{ WORDS[props.diffClass] }}</span>
  </UiCard>
</template>

<style scoped>
/*
 * The border and the opacity live in `cardStyle` above — see its comment for
 * why a scoped rule cannot carry them here. What is left below is geometry an
 * inline style cannot usefully express, plus the selection ring, which
 * `UiCard`'s own rules never touch.
 */
.diff-node {
  display: grid;
  gap: 0.25rem;
  width: 100%;
  height: 100%;
  text-align: left;
}

.diff-node.is-selected {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.diff-node__head {
  display: flex;
  gap: 0.4rem;
  align-items: baseline;
}

.diff-node__badge,
.diff-node__marker {
  display: inline-grid;
  place-content: center;
  min-width: 1.1rem;
  height: 1.1rem;
  border-radius: 999px;
  font-size: 0.8rem;
  font-weight: 700;
  line-height: 1;
}

.diff-node__badge {
  border: 1px solid var(--state-passed);
  color: var(--state-passed);
}

.diff-node__marker {
  border: 1px solid currentcolor;
}

.diff-node__title {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
}

.diff-node__meta,
.diff-node__derived {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin: 0;
  color: var(--ink-muted);
  font-size: var(--text-xs);
}

.diff-node__open {
  justify-self: start;
  padding: 0.1rem 0.45rem;
  border: 1px solid var(--edge);
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font-size: var(--text-xs);
}

/*
 * The accessible-name half of "never colour-only". Off-screen rather than
 * `display: none`, which would take it out of the accessibility tree and leave
 * a colour-only encoding for exactly the reader who cannot use one.
 */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  border: 0;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
