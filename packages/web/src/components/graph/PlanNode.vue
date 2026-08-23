<script setup lang="ts">
/**
 * KAR-24.5 — the node body, in direction A's language.
 *
 * Verifies: EPIC-24-S19, EPIC-24-S20, EPIC-24-S21, EPIC-24-S22 · AC1, AC2, AC4
 *
 * Direction A's node is a 200px card: a header (icon tile, title, mono status)
 * over a body (a runtime line, a meta line, and a meta/time row). This is that
 * card, built from `UiCard`, `UiIconTile` and `UiStateChip` — the three of
 * `ui/index.ts`'s fifteen this shape needs — rather than the hand-rolled
 * `<article>` KAR-17.1 shipped. `UiMeter` is named in KAR-24.5 AC1 alongside
 * them and is deliberately **not used**: a meter needs a percentage, and
 * `./node-body.ts` — read first, per the story's own instruction — carries no
 * such field. `phase` and `progressMessage` are strings, not a fraction, and
 * inventing one here to give the fourth component a job would be exactly the
 * KAR-24.5 AC2 violation the story is written to forbid: *"every field is one
 * the view model already carries… this story adds no field to it."* See the
 * note above the template for what else direction A draws that the same rule
 * refuses.
 *
 * Every value still arrives already decided on a `NodeBodyVM` from
 * `./node-body.ts` — that has not changed, and neither has the reason: "is
 * this priced or unpriced", "how long has this been going" and "what does the
 * palette call this state" are answered once, purely, under test without a
 * browser. What changed is only how the answers are laid out.
 *
 * **Colour is never the only signal** (WCAG 1.4.1, docs/12 §9.2). The border
 * and the icon tile both read `stateVar()`, `UiStateChip` carries the same
 * state as a glyph *and* a word, and the type glyph beside the title says what
 * kind of work this is. Turn every colour off and the body still reads.
 *
 * Every `data-slot` the pre-KAR-24.5 component set is still set, on the same
 * kind of element it was on before: `packages/web/src/views/plan-graph.test.ts`
 * queries by them and is the contract this file may not edit its way around.
 *
 * The whole thing is one flat `UiCard` with `data-slot` hooks rather than six
 * sub-components: it is rendered once per node, up to four hundred times, and
 * every component instance on that path is paid for on every relayout.
 */
import { computed } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import { stateVar } from '../../lib/state-palette.ts';
import { UiCard, UiIconTile, UiStateChip } from '../ui/index.ts';
import { glyphFor } from './glyphs.ts';
import type { NodeBodyVM } from './node-body.ts';
import { NODE_SIZE } from './node-size.ts';

const props = defineProps<{
  readonly body: NodeBodyVM;
  readonly selected: boolean;
  /**
   * The run this graph belongs to, for the verdict chip's link (KAR-17.6 AC1).
   *
   * Absent on the bare landing route, where there is no run to open a diff of —
   * and the chip is then plain text rather than a link to nowhere.
   */
  readonly runId?: string | null;
  /**
   * KAR-25.1 — whether the graph above this node is open at a project-less
   * legacy URL (`/runs/:runId…`) rather than its project-scoped one.
   *
   * A boolean from the parent rather than a `useRoute()` here: this component
   * renders once per node — up to four hundred times in the stress fixture
   * (`e2e/plan-graph-stress.test.ts`) — and the answer is the same for every
   * node on the page, decided once by whichever route matched. `../../views/PlanGraphView.vue`
   * computes it once and passes it down.
   */
  readonly legacy?: boolean;
}>();

const glyph = computed(() => glyphFor(props.body.type === 'node' ? null : props.body.type));

/**
 * KAR-17.6 AC1 — the chip is the way in to the review surface.
 *
 * The per-node scope, because the question the chip answers is *"what did this
 * node do"*, and **the file and the line** where the verdict located its worst
 * finding. Carrying only the file would land the operator at the top of a diff
 * to hunt for what the gate already told them — which is the two-window
 * workflow F7.7 exists to delete.
 *
 * KAR-25.1 — `run-diff` needs a `projectId` now; a project-less run reached
 * at its legacy URL has none to give it, so `props.legacy` picks
 * `legacy-run-diff` instead. Named pushes inherit a *present* `projectId`
 * from the current route automatically (vue-router 5's `pickParams`), which
 * is why the scoped branch below does not have to state one.
 */
const verdictTo = computed<RouteLocationRaw | null>(() => {
  if (props.runId == null || props.runId === '') return null;
  return {
    name: props.legacy === true ? 'legacy-run-diff' : 'run-diff',
    params: { runId: props.runId },
    query: {
      scope: 'node',
      node: props.body.id,
      ...(props.body.verdictFile === null || props.body.verdictLine === null
        ? {}
        : { file: props.body.verdictFile, line: String(props.body.verdictLine) }),
    },
  };
});

/** What a screen reader is told the chip does, rather than "typecheck: fail". */
const verdictLabel = computed(() => {
  const what = `${props.body.verdictGate ?? 'gate'}: ${props.body.verdict ?? ''}`;
  if (props.body.verdictFile === null) return `${what} — open this node's diff`;
  return `${what} — open ${props.body.verdictFile} at line ${String(props.body.verdictLine)}`;
});

/**
 * `UiCard`'s own `raised` chrome sets a 14px padding, and a scoped class rule
 * here cannot out-specify it: a scoped selector on a component's own root
 * carries *two* attribute selectors once the child's `[data-variant="raised"]`
 * is counted alongside its scope hash, which beats this file's one-attribute
 * `.plan-node[data-v-…]`. An inline style is the one thing that always wins
 * regardless — the same reason `borderColor` was already bound this way
 * before KAR-24.5 — so the card's padding and its exact box both live here
 * rather than in a losing CSS rule. Binding `width`/`height` off `NODE_SIZE`
 * itself, rather than restating `200px`/`152px` in two places, is what keeps
 * AC3's "two statements of one number" down to one.
 */
const cardStyle = computed(() => ({
  borderColor: stateVar(props.body.state),
  padding: '0',
  width: `${NODE_SIZE.width}px`,
  height: `${NODE_SIZE.height}px`,
}));
</script>

<template>
  <!--
    `class="plan-node"` and not a component-local name: `../../styles/theme.css`
    already keys the drag/pan transition and the reduced-motion switch-off off
    this exact class name (KAR-16.6 AC7, KAR-16.1 AC8), and a component that is
    the root of a child renders with the parent's scope hash as well as its
    own — so `<style scoped>` below can address `UiCard`'s own root element
    directly, the same way `GalleryView.vue`'s composite does.

    `data-motion-token` carries the KAR-24.5 AC4 contract: it is set only while
    the node is streaming, and it says nothing about *why* — theme.css's
    `[data-motion-token]` rule under `prefers-reduced-motion: reduce` turns the
    animation off without this file naming that rule, which is what keeps
    `../../app/reduced-motion.test.ts` passing unmodified.
  -->
  <UiCard
    variant="raised"
    class="plan-node"
    :data-plan-node="body.id"
    :data-state="body.state"
    :data-selected="selected ? 'true' : 'false'"
    :data-motion-token="body.streaming ? '' : undefined"
    :style="cardStyle"
  >
    <header class="plan-node__head">
      <UiIconTile size="sm" :tint="stateVar(body.state)" data-slot="type-glyph" :title="body.type">
        <component :is="glyph" :size="10" :stroke-width="2" aria-hidden="true" />
      </UiIconTile>
      <h3 class="plan-node__title">{{ body.title }}</h3>
      <!--
        The streaming badge. Present only while an agent is actually producing
        output, because a badge that is always there is not a badge — and it
        carries a word as well as a pulse, for the same reason everything else
        here does.
      -->
      <span v-if="body.streaming" class="plan-node__streaming" data-slot="streaming">
        <span class="plan-node__pulse" aria-hidden="true" />
        streaming
      </span>
      <!--
        `class="state-chip"` alongside `UiStateChip`'s own `ui-state-chip`: the
        two selectors coexist on the same element (Vue merges a fallthrough
        `class` rather than replacing one), and it is what
        `../../app/reduced-motion.test.ts`'s *"leaves the rest of the app
        alone"* case still finds on this route now that the state chip is
        `UiStateChip` directly rather than the app-level `StateChip.vue`
        wrapper that used to carry that class.
      -->
      <UiStateChip :state="body.state" class="state-chip" />
    </header>

    <!--
      A gate verdict belongs on the node whose *work* was judged, not on the
      gate — "which of my steps did a gate refuse" is the question, and it is
      asked of the step. Rendered only when one exists, same as before.
    -->
    <div v-if="body.verdict !== null" class="plan-node__row">
      <RouterLink
        v-if="verdictTo !== null"
        class="plan-node__verdict"
        :to="verdictTo"
        :data-verdict="body.verdict"
        :data-verdict-line="body.verdictLine"
        data-slot="verdict"
        :aria-label="verdictLabel"
      >
        {{ body.verdictGate }}: {{ body.verdict }}
      </RouterLink>
      <span v-else class="plan-node__verdict" :data-verdict="body.verdict" data-slot="verdict">
        {{ body.verdictGate }}: {{ body.verdict }}
      </span>
    </div>

    <!--
      Direction A's runtime line: what ran this, on one mono row. The prototype
      tints a small dot here by *which* runtime it was (`n.runtimeTint`) — a
      distinction `node-body.ts` has no field for, because it carries the
      provider's name and not a swatch keyed to it, so the dot here is plain
      rather than invented (KAR-24.5 AC2).
    -->
    <p class="plan-node__runtime">
      <span class="plan-node__dot" aria-hidden="true" />
      <span data-slot="provider">{{ body.provider }}</span>
      <span aria-hidden="true">·</span>
      <span data-slot="model">{{ body.model }}</span>
    </p>

    <p class="plan-node__meta">
      <span data-slot="type">{{ body.type }}</span>
      <span aria-hidden="true">·</span>
      <span data-slot="permission">{{ body.permission }}</span>
    </p>

    <p v-if="body.phase !== null" class="plan-node__phase" data-slot="phase">
      {{ body.phase }}
      <template v-if="body.progressMessage !== null"> — {{ body.progressMessage }}</template>
    </p>

    <p class="plan-node__figures">
      <span data-slot="elapsed">{{ body.elapsed }}</span>
      <span data-slot="cost">{{ body.cost }}</span>
    </p>
  </UiCard>
</template>

<style scoped>
/*
 * The drawn size lives in the `cardStyle` inline binding above, not here — see
 * that computed's own comment for why a scoped rule cannot carry it. What is
 * left for this class is what an inline style cannot usefully express: text
 * clipping, and the two state-driven effects below. `box-sizing: border-box`
 * is `UiCard`'s own unconditional rule (not repeated here), which is what
 * makes the inline `width`/`height` the *whole* box rather than the content
 * box plus a border this file would then have to account for.
 */
.plan-node {
  overflow: hidden;
  text-align: left;
}

/*
 * The selected node, ringed rather than recoloured: the border is already
 * carrying the state, and a selection that repainted it would lose the one
 * signal the whole graph is read by.
 */
.plan-node[data-selected="true"] {
  box-shadow: 0 0 0 2px var(--focus-ring);
}

/*
 * KAR-24.5 AC4 — a running node pulses. `theme.css`'s `pulsering` keyframe
 * animates `box-shadow`, so it is a ring around the *card*, matching the
 * prototype's own `n.anim` (applied to the whole node div, not a sub-element).
 * `[data-motion-token]` is what switches it off under reduced motion; this
 * rule only supplies the animation the token is naming.
 */
.plan-node[data-state="running"] {
  animation: pulsering 2.2s ease-out infinite;
}

.plan-node__head {
  display: flex;
  align-items: center;
  gap: 7px; /* geometry — direction A's header gutter */
  padding: 8px 10px 7px; /* geometry — direction A's header padding */
  border-bottom: 1px solid var(--edge);
  min-width: 0;
}

.plan-node__title {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plan-node__streaming {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 0.2rem;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--state-running);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.plan-node__pulse {
  width: 0.4rem;
  height: 0.4rem;
  border-radius: 999px;
  background: currentcolor;
}

.plan-node__row {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
  padding: 7px 10px 0; /* geometry — the body's own side padding */
}

.plan-node__verdict {
  padding: 0.05em 0.4em;
  border: 1px solid currentcolor;
  border-radius: 999px;
  font-size: var(--text-xs);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--state-passed);
}

.plan-node__verdict[data-verdict="fail"] {
  color: var(--state-failed);
}

.plan-node__verdict[data-verdict="needs-human"] {
  color: var(--state-awaiting-human);
}

.plan-node__runtime {
  display: flex;
  align-items: center;
  gap: 5px; /* geometry — the runtime dot's own gutter */
  margin: 0;
  padding: 8px 10px 0; /* geometry — the body's own side padding */
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plan-node__dot {
  flex: none;
  width: 5px; /* geometry — direction A's runtime dot */
  height: 5px; /* geometry — direction A's runtime dot */
  border-radius: 1px;
  background: var(--ink-faint);
}

.plan-node__meta,
.plan-node__figures,
.plan-node__phase {
  display: flex;
  gap: 0.25rem;
  margin: 0;
  padding: 6px 10px 0; /* geometry — the body's own side padding */
  font-size: var(--text-xs);
  color: var(--ink-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plan-node__figures {
  justify-content: space-between;
  padding-bottom: 9px; /* geometry — the card's own bottom padding */
  font-family: var(--font-mono);
}

.plan-node__phase {
  color: var(--state-running);
}
</style>
