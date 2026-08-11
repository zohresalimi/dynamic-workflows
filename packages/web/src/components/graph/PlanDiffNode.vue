<script setup lang="ts">
/**
 * KAR-17.2 — one node of the union graph, encoded by what happened to it
 * between the two versions being viewed.
 *
 * Verifies: EPIC-17-S7 · AC4, AC9
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
import type { DiffClass, PlanVersionNodeVM } from '../../lib/plan-diff.ts';

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
</script>

<template>
  <article
    class="diff-node"
    :class="{ 'is-selected': props.selected }"
    :data-diff-node="props.node.id"
    :data-diff-class="props.diffClass"
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
  </article>
</template>

<style scoped>
/*
 * The border, the opacity and the glyph are the encoding; the colour is on top
 * of it. Every rule below that sets a colour also sets something that is not a
 * colour, which is the invariant AC4 turns on.
 */
.diff-node {
  display: grid;
  gap: 0.25rem;
  width: 100%;
  height: 100%;
  padding: 0.5rem 0.65rem;
  border: 2px solid var(--edge);
  border-radius: 0.5rem;
  background: var(--surface-raised);
  opacity: 1;
  text-align: left;
}

.diff-node[data-diff-class="added"] {
  border-style: solid;
  border-color: var(--state-passed);
}

/*
 * Dashed *and* faded. Either alone would be ambiguous against a theme that
 * dims distant nodes (KAR-17.1 AC7); together they are a removal.
 */
.diff-node[data-diff-class="removed"] {
  border-style: dashed;
  border-color: var(--state-abandoned);
  opacity: 0.55;
}

.diff-node[data-diff-class="changed"] {
  border-style: solid;
  border-color: var(--state-running);
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
  font-size: 0.85rem;
  font-weight: 600;
}

.diff-node__meta,
.diff-node__derived {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  color: var(--ink-muted);
  font-size: 0.7rem;
}

.diff-node__open {
  justify-self: start;
  padding: 0.1rem 0.45rem;
  border: 1px solid var(--edge);
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font-size: 0.7rem;
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
