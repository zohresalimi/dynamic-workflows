<script setup lang="ts">
/**
 * KAR-17.4 — F10.5's context budget, drawn.
 *
 * Verifies: EPIC-17-S17, EPIC-17-S18, EPIC-17-S19, EPIC-17-S32 ·
 * AC1–AC10
 *
 * **This component decides nothing.** Every offset, every total, every gap and
 * every compaction bar is `../lib/context-budget.ts` and, through it,
 * `compactionChart()` in `@DeFlow/core`. What is here is the DOM those decisions
 * produce — `<rect>`s in a Vue template with a `:y` and a `:height`, and no
 * `d3-selection` anywhere. Two owners of the same subtree is a class of bug you
 * cannot fix (docs/12 §6.9), and the arithmetic half of d3 does not need one.
 *
 * ## The gap
 *
 * A `context.compacted` with `fidelity: 'partial'` has no post-compaction
 * count, and this template has no expression that could invent one: the "after"
 * slot is `CompactionBars.vue`'s, which renders KAR-09.6's own `gap` style —
 * an outline with the words *not reported* in it and **no `data-value`
 * attribute at all**. The delta beside it is rendered `v-if="mark.saved !== null"`,
 * so there is no subtraction against a number nobody measured.
 *
 * ## The axis
 *
 * The plot is 100 units tall and the domain top is `chart.domainMax`, which is
 * the *budget* unless a bar broke through it. That is AC2: a scale fitted to the
 * data puts the tallest bar at the top of every chart and headroom stops being
 * visible, which is the one question this view exists to answer. A bar at 0.3%
 * of its budget is therefore drawn as a sliver, honestly, and the figures beside
 * it are where the numbers live.
 *
 * Compaction ticks sit **below** the baseline rather than at their `before`
 * height on purpose. A `vendor.session` compaction counts a 167,000-token
 * session against a 10,000-token packet budget: they are different quantities,
 * and drawing one on the other's axis is a claim neither event makes.
 */
import { computed, ref } from 'vue';
import {
  type BudgetBarVM,
  type BudgetChartVM,
  type BudgetSliceVM,
  PINNED_SURVIVED_LABEL,
} from '../lib/context-budget.ts';
import CompactionBars from './CompactionBars.vue';
import DataTableTwin from './DataTableTwin.vue';

const props = defineProps<{ readonly chart: BudgetChartVM }>();

const emit = defineEmits<{
  inspect: [{ readonly nodeId: string; readonly attempt: number; readonly segmentId: string }];
}>();

const tableOpen = ref(false);

/** Viewbox units. The plot is `PLOT`; the strip below it carries the ticks. */
const BAR_WIDTH = 24;
const GAP = 16;
const PLOT = 100;
const TICKS = 8;

const xOf = (index: number): number => GAP + index * (BAR_WIDTH + GAP);
const width = (): number => Math.max(xOf(props.chart.bars.length), BAR_WIDTH + 2 * GAP);

/** Token space to view space, with the baseline at the bottom of the plot. */
const yOf = (tokens: number): number => PLOT - (tokens / props.chart.domainMax) * PLOT;
const heightOf = (slice: { readonly from: number; readonly to: number }): number =>
  ((slice.to - slice.from) / props.chart.domainMax) * PLOT;

const tokens = (value: number): string => value.toLocaleString('en-US');
const percent = (fraction: number): string => `${Math.round(fraction * 1000) / 10}%`;

/** AC7's hover: what it is, how big, how that was counted, and where from. */
const describe = (slice: BudgetSliceVM): string =>
  `${slice.kind} · ${tokens(slice.tokens)} tokens (${slice.method}) · from event ${slice.sourceEvent}`;

const slicesOf = (bar: BudgetBarVM): readonly BudgetSliceVM[] =>
  bar.bands.flatMap((band) => band.slices);

function open(bar: BudgetBarVM, slice: BudgetSliceVM): void {
  emit('inspect', { nodeId: bar.nodeId, attempt: bar.attempt, segmentId: slice.segmentId });
}

const TABLE_COLUMNS = [
  { key: 'invocation', label: 'Invocation' },
  { key: 'kind', label: 'Segment kind' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'method', label: 'Method' },
] as const;

/** The rects, as rows. The same walk, in the same order, formatted once. */
const tableRows = computed(() =>
  props.chart.bars.flatMap((bar) =>
    slicesOf(bar).map((slice) => ({
      key: `${bar.invocation}/${slice.segmentId}`,
      invocation: bar.invocation,
      kind: slice.kind,
      tokens: tokens(slice.tokens),
      method: slice.method,
    })),
  ),
);
</script>

<template>
  <figure class="budget" data-context-budget>
    <svg
      class="budget__chart"
      data-budget-chart
      role="img"
      :viewBox="`0 0 ${width()} ${PLOT + TICKS}`"
      :aria-label="`Context budget: ${props.chart.bars.length} invocations against a ${tokens(props.chart.domainMax)}-token axis`"
    >
      <title>
        Context budget: {{ props.chart.bars.length }} invocations, stacked by segment kind, against
        a {{ tokens(props.chart.domainMax) }}-token axis.
      </title>

      <g
        v-for="(bar, index) in props.chart.bars"
        :key="bar.invocation"
        :data-budget-bar="bar.invocation"
        :data-over-budget="bar.overBudget"
      >
        <rect
          v-for="slice in slicesOf(bar)"
          :key="slice.segmentId"
          class="budget__slice"
          :data-slice="slice.segmentId"
          :data-invocation="bar.invocation"
          :data-kind="slice.kind"
          :data-method="slice.method"
          :data-tokens="slice.tokens"
          :data-source-event="slice.sourceEvent"
          :data-pinned="slice.pinned"
          role="button"
          tabindex="0"
          :x="xOf(index)"
          :y="yOf(slice.to)"
          :width="BAR_WIDTH"
          :height="heightOf(slice)"
          @click="open(bar, slice)"
          @keydown.enter="open(bar, slice)"
        >
          <title>{{ describe(slice) }}</title>
        </rect>

        <!--
          AC2 — the budget, drawn from `budget.limitTokens` and from nothing
          else. It overhangs the bar on both sides so it reads as a threshold
          rather than as the bar's own cap.
        -->
        <line
          class="budget__line"
          data-budget-line
          :data-limit-tokens="bar.limitTokens"
          :x1="xOf(index) - 4"
          :x2="xOf(index) + BAR_WIDTH + 4"
          :y1="yOf(bar.limitTokens)"
          :y2="yOf(bar.limitTokens)"
        />

        <line
          v-for="mark in bar.compactions"
          :key="mark.seq"
          class="budget__compaction"
          data-compaction-mark
          :data-seq="mark.seq"
          :data-fidelity="mark.fidelity"
          :x1="xOf(index)"
          :x2="xOf(index) + BAR_WIDTH"
          :y1="PLOT + 3"
          :y2="PLOT + 3"
        />
      </g>
    </svg>

    <div class="budget__details">
      <article
        v-for="bar in props.chart.bars"
        :key="bar.invocation"
        class="budget__detail"
        :data-bar-detail="bar.invocation"
      >
        <h3 class="budget__heading">{{ bar.invocation }}</h3>

        <p class="budget__caption" data-budget-caption>
          Budget {{ tokens(bar.limitTokens) }} tokens — {{ percent(bar.fraction) }} of the model's
          window.
          <span v-if="!bar.fractionWithinPolicy" class="budget__warn" data-fraction-out-of-policy>
            That fraction is above the 0.6 ceiling this project allows.
          </span>
        </p>

        <!--
          AC8. One figure per counting method, never one figure: a heuristic
          estimate and a vendor-reported count are different kinds of number,
          and their sum is neither of them.
        -->
        <ul class="budget__totals">
          <li
            v-for="total in bar.totals"
            :key="total.method"
            data-bar-total
            :data-method="total.method"
            :data-tokens="total.tokens"
          >
            {{ tokens(total.tokens) }}
            tokens counted by {{ total.method }}
          </li>
        </ul>

        <!--
          AC6 — a pin integrity violation is a blocking marker on the
          invocation, not a warning beside it: the pinned set is the run's
          governance, and compaction deleting one is the failure mode this whole
          view exists for.
        -->
        <div v-if="bar.violation !== null" class="budget__violation" data-violation>
          <p class="budget__violation-title">
            A pinned segment did not survive into the prompt.
            <span v-if="bar.failure !== null" data-failure-reason>{{ bar.failure.reason }}</span>
          </p>
          <ul>
            <li v-for="digest in bar.violation.missingDigests" :key="digest" data-missing-digest>
              {{ digest }}
            </li>
          </ul>
          <ul>
            <li v-for="id in bar.violation.segmentIds" :key="id" data-segment-id>{{ id }}</li>
          </ul>
        </div>

        <section
          v-for="mark in bar.compactions"
          :key="mark.seq"
          class="budget__compaction-detail"
          :data-compaction="mark.seq"
          :data-scope="mark.scope"
          :data-fidelity="mark.fidelity"
        >
          <h4>Compacted at seq {{ mark.seq }} — {{ mark.scope }} ({{ mark.trigger }})</h4>

          <CompactionBars :chart="mark.chart" />

          <p v-if="mark.saved !== null" data-delta>Freed {{ tokens(mark.saved) }} tokens.</p>
          <p v-if="mark.gapLabel !== null" class="budget__gap" data-gap-label>
            {{ mark.gapLabel }}
          </p>

          <p v-if="mark.originalHandle !== null">
            <a
              :data-original-handle="mark.originalHandle"
              :href="`/api/artifacts/${mark.originalHandle.replace('artifact://', '')}`"
            >
              The packet as it was before this compaction
            </a>
          </p>

          <!-- AC5 — the integrity check's own evidence, stated positively. -->
          <div class="budget__kept" data-pinned-kept>
            <p>{{ PINNED_SURVIVED_LABEL }} ({{ mark.pinnedKept.length }}):</p>
            <ul>
              <li v-for="digest in mark.pinnedKept" :key="digest" data-digest>{{ digest }}</li>
            </ul>
          </div>
        </section>
      </article>

      <!--
        A compaction whose `context.built` this tab never saw. Rendered rather
        than dropped: it is still something that happened to the run.
      -->
      <article v-if="props.chart.unattached.length > 0" class="budget__detail" data-unattached>
        <h3 class="budget__heading">Compactions with no packet in this tab</h3>
        <section
          v-for="mark in props.chart.unattached"
          :key="mark.seq"
          :data-compaction="mark.seq"
          :data-scope="mark.scope"
          :data-fidelity="mark.fidelity"
        >
          <CompactionBars :chart="mark.chart" />
        </section>
      </article>
    </div>

    <button
      class="budget__table-toggle"
      type="button"
      data-budget-table-toggle
      :aria-expanded="tableOpen"
      @click="tableOpen = !tableOpen"
    >
      {{ tableOpen ? 'Hide the segment table' : 'Show the segment table' }}
    </button>

    <!--
      EPIC-17-S32 — the chart, in a form a non-visual reader can read top to
      bottom and anybody can paste into a PR description. `tableRows` walks the
      same `bands`/`slices` the rects are drawn from: a table built from a
      second derivation is a second source of truth, and it disagrees
      eventually.

      The markup is `DataTableTwin.vue`, shared with the run timeline
      (EPIC-17-S32 scenario 3) — the twin is one component parameterised per
      chart, not one table per view drifting apart a column at a time.
    -->
    <DataTableTwin
      v-if="tableOpen"
      name="budget"
      caption="Every context segment of every invocation, with the method its token count came
        from."
      :columns="TABLE_COLUMNS"
      :rows="tableRows"
    />
  </figure>
</template>

<style scoped>
.budget {
  display: grid;
  gap: 1rem;
  margin: 0;
  padding: 1rem;
  color: var(--ink);
}

.budget__chart {
  inline-size: 100%;
  max-block-size: 22rem;
}

/*
 * KAR-16.1's rule (docs/12 §9.1): every colour below is a palette token, never
 * a literal. Nine kinds against seven state names plus the two neutral inks —
 * the assignment is arbitrary, the *source* is not, which is what makes dark
 * mode nine variable lookups instead of an audit.
 */
.budget__slice {
  cursor: pointer;
  fill: var(--ink-muted);
}

.budget__slice:focus-visible {
  outline: 2px solid var(--focus-ring);
}

.budget__slice[data-kind="pinned.constraints"] {
  fill: var(--state-failed);
}

.budget__slice[data-kind="pinned.spec"] {
  fill: var(--state-awaiting-human);
}

.budget__slice[data-kind="pinned.pathscope"] {
  fill: var(--state-blocked);
}

.budget__slice[data-kind="task.brief"] {
  fill: var(--state-running);
}

.budget__slice[data-kind="fact"] {
  fill: var(--state-passed);
}

.budget__slice[data-kind="artifact.handle"] {
  fill: var(--state-abandoned);
}

.budget__slice[data-kind="retrieved"] {
  fill: var(--focus-ring);
}

.budget__slice[data-kind="history.summary"] {
  fill: var(--state-pending);
}

.budget__slice[data-kind="tool.output"] {
  fill: var(--ink-muted);
}

.budget__line {
  stroke: var(--ink);
  stroke-width: 0.6;
  stroke-dasharray: 3 2;
}

.budget__compaction {
  stroke: var(--state-blocked);
  stroke-width: 3;
}

.budget__details {
  display: grid;
  gap: 1rem;
}

.budget__detail {
  display: grid;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--edge);
  border-radius: 0.5rem;
  background: var(--surface-raised);
}

.budget__heading {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.9rem;
  font-weight: 600;
}

.budget__caption,
.budget__totals,
.budget__kept {
  color: var(--ink-muted);
  font-size: 0.85rem;
}

.budget__totals,
.budget__kept ul,
.budget__violation ul {
  padding: 0;
  margin: 0;
  list-style: none;
}

.budget__kept li,
.budget__violation li {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  overflow-wrap: anywhere;
}

.budget__violation {
  padding: 0.5rem;
  border-inline-start: 3px solid var(--state-failed);
  background: color-mix(in oklch, var(--state-failed) 12%, var(--surface-raised));
}

.budget__violation-title {
  font-weight: 600;
}

.budget__warn,
.budget__gap {
  color: var(--state-blocked);
}

.budget__compaction-detail {
  display: grid;
  gap: 0.4rem;
  padding-block-start: 0.5rem;
  border-block-start: 1px solid var(--edge);
}
</style>
