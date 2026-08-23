<script setup lang="ts">
/**
 * The evidence column of the gate card: the spec, laid out to be **read**.
 *
 * `RunGateBanner.vue`'s responsibility 1 — "saying what is being asked" — with
 * the one change the redesign makes to it: the F1.3 gate's prompt is a whole
 * framed document, and a 14rem `<pre>` with a scrollbar is not a surface
 * anybody reads a document on. It is the same bytes; only the layout is new.
 *
 * ## The rule this file does not bend
 *
 * There is still exactly one renderer of the framed document, and it is
 * `renderSpecForReview` in `@DeFlow/core`. This component re-renders nothing:
 * it hands the gate's own `prompt` to `./spec-prompt-sections.ts`, which finds
 * that renderer's heading lines and hands back the bytes between them
 * unchanged (that module's round-trip test is what keeps it true). A prompt it
 * cannot parse — a permission escalation, a future gate — falls back to the
 * `<pre>` this surface has always had, because guessing at the shape of a
 * document somebody is about to approve is the one failure worth being loud
 * about.
 *
 * ## System laws, applied
 *
 * - **Law 1.** The column has exactly one `UiCard variant="inset"` — the goal.
 *   Everything below it sits flush on the gate card's own surface, separated
 *   by `--edge` hairlines. The prior-decisions group is the one layer-2
 *   container, and it is a background shift with no border: a bordered group
 *   inside a bordered card is the doubled wall the redesign removes.
 * - **Law 2.** Mono is spent on the criteria ids, the failure-mode ids and the
 *   decision sources — machine-owned strings — and nowhere else here. The
 *   section captions are `UiSectionLabel` (the app's one uppercase mono
 *   caption, and this is its licensed use: a group caption inside a card
 *   body). "Prior decisions" is a heading rather than a caption, sentence-case
 *   sans, because a caption set in a quieter voice than its own rows demotes
 *   the group it is naming.
 * - **Law 3.** No accent, no state colour. This column is evidence; the one
 *   coloured thing on the card is its own state chip.
 *
 * ## Why the pinned decisions are not clamped
 *
 * They are the part of the document an operator has to *judge* — "the run has
 * already decided X, and you are about to approve a spec that assumes it" —
 * and a two-line clamp on a judgement is a truncation of the evidence. Height
 * is bounded by the disclosure below instead: three rows are always visible,
 * the rest are one press away, and every one of them wraps in full when shown.
 */
import { computed } from 'vue';
import { UiCard, UiChip, UiDisclosure, UiSectionLabel } from '../ui/index.ts';
import {
  parsePriorDecision,
  promptSize,
  type SpecPromptSection,
  sectionItems,
  splitSpecPrompt,
} from './spec-prompt-sections.ts';

const props = defineProps<{
  /** The gate's own `human.requested.prompt`, verbatim. */
  readonly prompt: string;
}>();

/** How many pinned decisions stay visible before the disclosure takes over. */
const VISIBLE_DECISIONS = 3;

const sections = computed(() => splitSpecPrompt(props.prompt));

const goal = computed<SpecPromptSection | null>(
  () => sections.value?.find((section) => section.title === 'Goal') ?? null,
);

/**
 * Everything between the goal and the pinned decisions, in the renderer's own
 * order — the sections drawn as titled lists.
 */
const bodySections = computed<readonly SpecPromptSection[]>(() =>
  (sections.value ?? []).filter(
    (section) => section.title !== 'Goal' && section.title !== 'Prior decisions',
  ),
);

const decisions = computed(() => {
  const section = sections.value?.find((each) => each.title === 'Prior decisions');
  if (section === undefined) return [];
  return sectionItems(section).map((item) => parsePriorDecision(item.text));
});

const hiddenDecisions = computed(() => Math.max(0, decisions.value.length - VISIBLE_DECISIONS));

/** The document's own weight, for the last row of the decisions list. */
const size = computed(() => promptSize(props.prompt));
</script>

<template>
  <div class="evidence" data-run-gate-prompt>
    <!--
      The fallback, and it is first in the file rather than an afterthought: a
      prompt this cannot parse is rendered exactly as this surface always
      rendered every prompt. Nothing is hidden and nothing is guessed at.
    -->
    <pre v-if="sections === null" class="evidence__raw">{{ prompt }}</pre>

    <template v-else>
      <UiCard v-if="goal" variant="inset" class="evidence__goal">
        <UiSectionLabel>Goal</UiSectionLabel>
        <p
          v-for="(line, index) in goal.lines.filter((each) => each.trim() !== '')"
          :key="index"
          class="evidence__goal-line"
        >
          {{ line }}
        </p>
      </UiCard>

      <section v-for="section in bodySections" :key="section.title" class="evidence__section">
        <UiSectionLabel>{{ section.title }}</UiSectionLabel>
        <ul class="evidence__list">
          <li
            v-for="(item, index) in sectionItems(section)"
            :key="index"
            class="evidence__item"
            :data-bullet="item.bullet || undefined"
          >
            {{ item.text }}
          </li>
        </ul>
      </section>

      <!--
        The one layer-2 container in this column: a background shift and a
        radius, no border (law 1). The heading is sentence-case sans rather
        than a `UiSectionLabel`, because these rows are the evidence an
        operator judges and a caption quieter than its own rows reads as a
        footnote to them.
      -->
      <section v-if="decisions.length > 0" class="evidence__decisions">
        <header class="evidence__decisions-head">
          <h4 class="evidence__decisions-title">Prior decisions</h4>
          <UiChip mono size="xs">{{ decisions.length }}</UiChip>
        </header>

        <ol class="evidence__decision-rows">
          <li
            v-for="(decision, index) in decisions.slice(0, VISIBLE_DECISIONS)"
            :key="index"
            class="evidence__decision"
          >
            <span class="evidence__decision-source">
              <UiChip v-if="decision.source" mono size="xs">{{ decision.source }}</UiChip>
            </span>
            <span class="evidence__decision-text">{{ decision.decision }}</span>
          </li>
        </ol>

        <!--
          The rest, and the document's own weight as the list's last row. The
          disclosure keeps its content in the DOM while closed
          (`UiDisclosure`'s own contract), so nothing here disappears from
          `textContent` or from find-in-page just because it is folded away.
        -->
        <UiDisclosure
          class="evidence__more"
          :label="
            hiddenDecisions > 0
              ? `Show all ${decisions.length} pinned decisions — never compacted`
              : 'Pinned decisions are never compacted'
          "
        >
          <ol class="evidence__decision-rows">
            <li
              v-for="(decision, index) in decisions.slice(VISIBLE_DECISIONS)"
              :key="index"
              class="evidence__decision"
            >
              <span class="evidence__decision-source">
                <UiChip v-if="decision.source" mono size="xs">{{ decision.source }}</UiChip>
              </span>
              <span class="evidence__decision-text">{{ decision.decision }}</span>
            </li>
            <li class="evidence__decision evidence__decision--ghost" data-run-gate-prompt-size>
              <span class="evidence__decision-source">
                <UiChip mono size="xs">{{ size }}</UiChip>
              </span>
              <span class="evidence__decision-text">Full framed document</span>
            </li>
          </ol>
        </UiDisclosure>
      </section>
    </template>
  </div>
</template>

<style scoped>
.evidence {
  display: grid;
  gap: 12px; /* geometry — the column's own stack gap */
  min-width: 0;
}

/* The unparsed prompt, exactly as this surface has always drawn one. */
.evidence__raw {
  margin: 0;
  max-height: 22rem;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  color: var(--ink-strong);
  background: var(--surface-inset);
  border-radius: var(--radius-sm);
  padding: 10px; /* geometry — the code block's own padding */
}

.evidence__goal {
  display: grid;
  gap: 6px; /* geometry — caption-to-prose gap */
}

/* The goal is the one piece of prose on this column that is meant to be read
   at reading size rather than scanned at list size. */
.evidence__goal-line {
  margin: 0;
  font-size: var(--text-md);
  color: var(--ink);
  overflow-wrap: anywhere;
}

/* Law 1 — sections are separated by a hairline, never by a second box. */
.evidence__section {
  display: grid;
  gap: 6px; /* geometry — caption-to-list gap */
  padding-top: 10px; /* geometry — the rule's breathing room */
  border-top: 1px solid var(--edge);
}

.evidence__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 3px; /* geometry — the list's own row gap */
}

.evidence__item {
  font-size: var(--text-sm);
  color: var(--ink-strong);
  overflow-wrap: anywhere;
}

/* The framed document's own `- ` marker, drawn by the list rather than
   printed into the text — the bytes are the document's either way (see
   `sectionItems`). */
.evidence__item[data-bullet] {
  padding-left: 12px; /* geometry — hanging indent for the marker */
  position: relative;
}

.evidence__item[data-bullet]::before {
  content: "–";
  position: absolute;
  left: 0;
  color: var(--ink-faint);
}

.evidence__decisions {
  display: grid;
  gap: 6px; /* geometry — heading-to-rows gap */
  padding: 10px; /* geometry — the group's own padding */
  background: var(--surface-inset);
  border-radius: var(--radius-lg);
}

.evidence__decisions-head {
  display: flex;
  align-items: center;
  gap: 8px; /* geometry — title-to-count gutter */
}

.evidence__decisions-title {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 600;
  color: var(--ink);
}

.evidence__decision-rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

/* 6.5rem and not a pixel figure: the source column has to hold the longest
   source word at whatever size the reader's browser is set to, and a px column
   stops fitting the moment the ramp or the root size moves. */
.evidence__decision {
  display: grid;
  grid-template-columns: 6.5rem minmax(0, 1fr);
  gap: 8px; /* geometry — the row's own gutter */
  align-items: start;
  padding: 6px 0; /* geometry — the row's own vertical rhythm */
  border-top: 1px solid var(--edge);
}

.evidence__decision:hover {
  background: var(--surface);
}

.evidence__decision-source {
  min-width: 0;
}

/* Wrapped in full, never clamped: see the header comment. */
.evidence__decision-text {
  font-size: var(--text-base);
  color: var(--ink-strong);
  min-width: 0;
  overflow-wrap: anywhere;
}

.evidence__decision--ghost .evidence__decision-text {
  color: var(--ink-faint);
}

.evidence__more {
  min-width: 0;
}

/*
 * Law 1, enforced across a component boundary. `UiDisclosure`'s body draws its
 * own inset panel — background, border and padding — which is right when it
 * opens inside a plain row and wrong here, where it opens *inside* the layer-2
 * group it belongs to. Stripping the chrome rather than the component keeps
 * one disclosure in the library instead of a second one for this card.
 */
.evidence__more :deep(.ui-disclosure__body) {
  background: transparent;
  border: none;
  padding: 0;
  margin-top: 0;
}
</style>
