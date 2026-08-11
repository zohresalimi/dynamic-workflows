<script setup lang="ts">
/**
 * KAR-17.8 — F10.9's run timeline, drawn.
 *
 * Verifies: EPIC-17-S30, EPIC-17-S31, EPIC-17-S32 · AC1–AC10
 *
 * **This component decides nothing about the data.** Every x, every width,
 * every lane, every marker position and every table cell is
 * `../lib/run-timeline.ts`. What is here is the DOM those decisions produce —
 * `<rect>`s in a Vue template with an `:x` and a `:width` — and the one piece
 * of state a drawing legitimately owns: which slice of the run is on screen.
 *
 * There is no `d3-selection` call anywhere, and there is no `d3-axis`. Two
 * owners of the same subtree is a class of bug you cannot fix (docs/12 §6.9),
 * and `d3-axis` is a renderer that only knows how to write through a selection;
 * the ticks below come from the scale itself.
 * `test/no-d3-selection-in-web.test.ts` is what keeps that true.
 *
 * ## The open bar has a cap, not an end
 *
 * A running attempt draws to `now` with an explicit end cap and
 * `data-open="true"`. Its `endTs` is still `null` in the data, and the table
 * below prints an em dash for it. The cap is the visual statement that the
 * right-hand edge is where the clock is, not where the work stopped.
 *
 * ## The suspension is a different fill, not a lighter one
 *
 * A six-hour human gate and six hours of work are the same width and must not
 * be the same thing to look at, so the idle segment is drawn with its own
 * hatch and its own token. Anything subtler ("slightly paler") is a difference
 * a reader has to already know about to notice.
 *
 * ## AC2, in the `<defs>`
 *
 * Seven states, seven patterns. The colour is `var(--state-…)` in every case
 * and the pattern is the second signal, so nothing here is legible only to a
 * reader who can separate the hues (WCAG 1.4.1).
 */
import { computed, ref, useTemplateRef } from 'vue';
import type { TimelineProjection } from '../ledger/projections/timeline.ts';
import {
  MIN_WINDOW_MS,
  panWindow,
  runTimeline,
  type TimeWindow,
  timelineKeyCommand,
  windowFromBrush,
  zoomWindow,
} from '../lib/run-timeline.ts';
import { DISPLAY_STATES, STATE_LABELS } from '../lib/state-palette.ts';
import DataTableTwin from './DataTableTwin.vue';

const props = defineProps<{
  readonly timeline: TimelineProjection;
  /**
   * Wall clock, for the open bar's right edge.
   *
   * A prop rather than a `Date.now()` in here: the projection is mutated in
   * place, so the component would have no honest moment to read a clock at, and
   * a spec could not assert on a bar whose width changed between renders.
   */
  readonly now: number;
  /** The projection's own counter — this recomputes when it moves, not before. */
  readonly version: number;
}>();

/** `null` is the whole run. AC8's viewport, owned here and nowhere else. */
const window = ref<TimeWindow | null>(null);
const tableOpen = ref(false);
const helpOpen = ref(false);

const chart = computed(() => {
  void props.version;
  return runTimeline({ timeline: props.timeline, now: props.now, window: window.value });
});

/** Vertical room under the lanes for the time axis. */
const AXIS = 22;
/** Room to the left of the plot for the lane labels. */
const GUTTER = 150;

const viewBox = computed(
  () => `0 0 ${GUTTER + chart.value.plot.width} ${chart.value.plot.height + AXIS}`,
);

const TABLE_COLUMNS = [
  { key: 'node', label: 'Node' },
  { key: 'attempt', label: 'Attempt' },
  { key: 'start', label: 'Start' },
  { key: 'end', label: 'End' },
  { key: 'duration', label: 'Duration' },
  { key: 'state', label: 'State' },
  { key: 'cost', label: 'Cost' },
] as const;

const ZOOM_STEP = 0.6;
const PAN_STEP = 0.25;

function apply(command: ReturnType<typeof timelineKeyCommand>): boolean {
  const built = chart.value;
  switch (command) {
    case 'zoom-in':
      window.value = zoomWindow(built.window, built.extent, ZOOM_STEP);
      return true;
    case 'zoom-out':
      window.value = zoomWindow(built.window, built.extent, 1 / ZOOM_STEP);
      return true;
    case 'pan-left':
      window.value = panWindow(built.window, built.extent, -PAN_STEP);
      return true;
    case 'pan-right':
      window.value = panWindow(built.window, built.extent, PAN_STEP);
      return true;
    case 'reset':
      window.value = null;
      return true;
    default:
      return false;
  }
}

/**
 * AC8 — the keyboard half.
 *
 * The same four operations the pointer has, through the same pure functions,
 * because a chart whose pointer gesture owned a private transform is a chart
 * the keyboard can focus and not move.
 */
function onKeydown(event: KeyboardEvent): void {
  if (apply(timelineKeyCommand(event))) event.preventDefault();
}

/** The plot's own rectangle, for turning a client x into a plot x. */
const plot = useTemplateRef<SVGRectElement>('plot');

function localX(clientX: number): number | null {
  const box = plot.value?.getBoundingClientRect();
  if (box === undefined || box.width === 0) return null;
  return ((clientX - box.left) / box.width) * chart.value.plot.width;
}

/** The pointer half: a wheel zooms about the cursor, a drag brushes. */
function onWheel(event: WheelEvent): void {
  const built = chart.value;
  const at = localX(event.clientX);
  if (at === null) return;
  const focus = built.window.from + (at / built.plot.width) * (built.window.to - built.window.from);
  window.value = zoomWindow(
    built.window,
    built.extent,
    event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP,
    focus,
  );
  event.preventDefault();
}

const brushFrom = ref<number | null>(null);

function onPointerDown(event: PointerEvent): void {
  brushFrom.value = localX(event.clientX);
}

function onPointerUp(event: PointerEvent): void {
  const start = brushFrom.value;
  brushFrom.value = null;
  const end = localX(event.clientX);
  if (start === null || end === null) return;
  // A click is not a brush. Below the floor it is a selection gesture nobody
  // made, and swallowing it would make the chart impossible to click.
  if (Math.abs(end - start) < 4) return;
  window.value = windowFromBrush(chart.value.window, start, end, chart.value.plot.width);
}

const MARKER_GLYPHS = {
  paused: '⏸',
  'rate-limited': '⏳',
  stalled: '⚠',
} as const;

const windowLabel = computed(() => {
  const built = chart.value;
  const whole = built.window.from === built.extent.from && built.window.to === built.extent.to;
  const width = Math.max(built.window.to - built.window.from, MIN_WINDOW_MS);
  return whole ? 'Showing the whole run' : `Showing ${Math.round(width / 1_000)}s of the run`;
});
</script>

<template>
  <figure class="gantt" data-run-timeline>
    <svg
      class="gantt__chart"
      data-timeline-chart
      role="img"
      tabindex="0"
      :viewBox="viewBox"
      :aria-label="chart.label"
      @keydown="onKeydown"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointerup="onPointerUp"
    >
      <title>{{ chart.label }}</title>

      <!--
        AC2 — the second signal. Seven states, seven silhouettes, chosen to
        differ in shape and not only in density: a set where two of them were
        both "diagonal lines, a bit closer together" satisfies the letter of the
        rule and none of its purpose.
      -->
      <defs>
        <pattern id="tl-solid" width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill="currentColor" opacity="0" />
        </pattern>
        <pattern id="tl-forward" width="6" height="6" patternUnits="userSpaceOnUse">
          <path d="M0,6 L6,0" stroke="currentColor" stroke-width="1.4" />
        </pattern>
        <pattern id="tl-back" width="6" height="6" patternUnits="userSpaceOnUse">
          <path d="M0,0 L6,6" stroke="currentColor" stroke-width="1.4" />
        </pattern>
        <pattern id="tl-cross" width="6" height="6" patternUnits="userSpaceOnUse">
          <path d="M0,0 L6,6 M0,6 L6,0" stroke="currentColor" stroke-width="1" />
        </pattern>
        <pattern id="tl-vertical" width="6" height="6" patternUnits="userSpaceOnUse">
          <path d="M3,0 L3,6" stroke="currentColor" stroke-width="1.6" />
        </pattern>
        <pattern id="tl-dots" width="6" height="6" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="3" r="1.2" fill="currentColor" />
        </pattern>
        <pattern id="tl-sparse" width="10" height="10" patternUnits="userSpaceOnUse">
          <circle cx="5" cy="5" r="1" fill="currentColor" />
        </pattern>
        <pattern id="tl-idle" width="8" height="8" patternUnits="userSpaceOnUse">
          <path d="M0,8 L8,0" stroke="currentColor" stroke-width="2" />
        </pattern>
      </defs>

      <!-- The lane labels, outside the plot so a zoom never moves them. -->
      <g class="gantt__gutter">
        <text
          v-for="lane in chart.lanes"
          :key="lane.nodeId"
          :data-lane="lane.nodeId"
          class="gantt__lane-label"
          :x="GUTTER - 8"
          :y="lane.y + lane.height / 2"
          dominant-baseline="middle"
          text-anchor="end"
        >
          {{ lane.nodeId }}
        </text>
      </g>

      <g :transform="`translate(${GUTTER},0)`">
        <!--
          The plot's own box, as an element.

          A `<g>` measures to the union of what it happens to contain, which is
          not the same rectangle and drifts as bars come and go — so the pointer
          gestures and the specs would both be doing arithmetic against
          something that moves for reasons unrelated to the scale.
        -->
        <rect
          ref="plot"
          class="gantt__surface"
          data-plot
          x="0"
          y="0"
          :width="chart.plot.width"
          :height="chart.plot.height"
        />

        <!-- The wall-clock grid. Ticks from the scale; no axis renderer. -->
        <g class="gantt__grid">
          <line
            v-for="tick in chart.timeTicks"
            :key="tick.value"
            :x1="tick.offset"
            :x2="tick.offset"
            :y1="0"
            :y2="chart.plot.height"
          />
        </g>

        <g
          v-for="bar in chart.bars"
          :key="bar.key"
          :data-bar="bar.key"
          :data-state="bar.state"
          :data-open="bar.open"
          :data-start-ts="bar.startTs"
          :data-attempt="bar.attempt"
          :style="{ color: bar.colour }"
        >
          <title>
            {{ bar.nodeId }}
            attempt {{ bar.attempt }} — {{ STATE_LABELS[bar.state] }}.
            <template v-if="bar.suspendedMs !== null && bar.suspendedMs > 0">
              Idle time is drawn separately from execution.
            </template>
            <template v-if="bar.tsArtefact !== null">{{ bar.tsArtefact }}</template>
          </title>

          <rect
            v-for="segment in bar.segments"
            :key="`${segment.kind}-${segment.fromTs}`"
            class="gantt__segment"
            :data-segment="segment.kind"
            :data-idle-ms="segment.kind === 'suspended' ? segment.toTs - segment.fromTs : undefined"
            :x="segment.x"
            :y="bar.y"
            :width="segment.width"
            :height="bar.height"
          />

          <!--
            The pattern sits on top of the fill rather than replacing it, so the
            colour and the shape are both present rather than one standing in
            for the other.
          -->
          <rect
            class="gantt__pattern"
            data-fill
            :data-pattern="bar.pattern"
            :x="bar.x"
            :y="bar.y"
            :width="bar.width"
            :height="bar.height"
            :fill="`url(#${bar.pattern})`"
          />

          <!-- AC3 — the running attempt's right edge is the clock, not an end. -->
          <line
            v-if="bar.open"
            class="gantt__cap"
            data-open-cap
            :x1="bar.x + bar.width"
            :x2="bar.x + bar.width"
            :y1="bar.y - 2"
            :y2="bar.y + bar.height + 2"
          />
        </g>

        <!-- AC5 — the second axis, one path per counting tier and never one over both. -->
        <path
          v-for="line in chart.costLines"
          :key="line.source"
          class="gantt__cost"
          data-cost-line
          :data-source="line.source"
          :d="line.path"
        />

        <g
          v-for="mark in chart.markers"
          :key="`${mark.kind}-${mark.seq}`"
          class="gantt__mark"
          :data-mark="mark.kind"
          :data-seq="mark.seq"
        >
          <title>{{ mark.label }} — {{ mark.detail }}</title>
          <line :x1="mark.x" :x2="mark.x" :y1="0" :y2="chart.plot.height" />
          <text :x="mark.x" y="10" text-anchor="middle">{{ MARKER_GLYPHS[mark.kind] }}</text>
        </g>

        <g class="gantt__axis" :transform="`translate(0,${chart.plot.height})`">
          <text
            v-for="tick in chart.timeTicks"
            :key="tick.value"
            :x="tick.offset"
            y="14"
            text-anchor="middle"
          >
            {{ tick.label }}
          </text>
        </g>
      </g>

      <!-- The money axis, on the right, in the same view box. -->
      <g
        class="gantt__axis"
        data-cost-axis
        :transform="`translate(${GUTTER + chart.plot.width},0)`"
      >
        <text v-for="tick in chart.costTicks" :key="tick.value" x="6" :y="tick.offset">
          {{ tick.label }}
        </text>
      </g>
    </svg>

    <p class="gantt__window" data-timeline-window>{{ windowLabel }}</p>

    <!--
      AC5, AC6, AC7 — the three markers in words as well as as glyphs. A tick on
      a time axis is not a statement; this is where each one says what it was
      and, in the stall's case, what it deliberately is not.
    -->
    <ul v-if="chart.markers.length > 0" class="gantt__marks">
      <li
        v-for="mark in chart.markers"
        :key="`${mark.kind}-${mark.seq}`"
        :data-marker="mark.kind"
        :data-seq="mark.seq"
      >
        <span aria-hidden="true">{{ MARKER_GLYPHS[mark.kind] }}</span>
        <strong>{{ mark.label }}</strong>
        <span>{{ mark.detail }}</span>
      </li>
    </ul>

    <!-- The legend. Colour and pattern together, once, in the states' own order. -->
    <ul class="gantt__legend">
      <li v-for="state in DISPLAY_STATES" :key="state" :data-legend="state">
        <svg class="gantt__swatch" viewBox="0 0 16 12" role="presentation" aria-hidden="true">
          <rect width="16" height="12" :fill="`var(--state-${state})`" />
        </svg>
        {{ STATE_LABELS[state] }}
      </li>
    </ul>

    <div class="gantt__controls">
      <button
        type="button"
        data-timeline-table-toggle
        :aria-expanded="tableOpen"
        @click="tableOpen = !tableOpen"
      >
        {{ tableOpen ? 'Hide the attempt table' : 'Show the attempt table' }}
      </button>
      <button
        type="button"
        data-timeline-help-toggle
        :aria-expanded="helpOpen"
        @click="helpOpen = !helpOpen"
      >
        {{ helpOpen ? 'Hide the keyboard controls' : 'Keyboard controls' }}
      </button>
    </div>

    <p v-if="helpOpen" class="gantt__help" data-timeline-help>
      Focus the chart, then: Arrow Left and Arrow Right pan, <kbd>+</kbd> and <kbd>-</kbd> zoom, and
      <kbd>Home</kbd>
      returns to the whole run. The pointer does the same with a wheel and a drag.
    </p>

    <!--
      EPIC-17-S32 — the chart, in a form a non-visual reader can read top to
      bottom and anybody can paste into a PR description. `chart.rows` is
      `chart.bars` mapped, so there is no second derivation to disagree with.
    -->
    <DataTableTwin
      v-if="tableOpen"
      name="timeline"
      caption="Every attempt of every node, with what it cost. An em dash is a value nothing has
        measured yet — never a zero."
      :columns="TABLE_COLUMNS"
      :rows="chart.rows"
    />
  </figure>
</template>

<style scoped>
.gantt {
  display: grid;
  gap: 0.75rem;
  margin: 0;
  padding: 1rem;
  color: var(--ink);
}

.gantt__chart {
  inline-size: 100%;
  max-block-size: 32rem;
  touch-action: none;
}

.gantt__chart:focus-visible {
  outline: 2px solid var(--focus-ring);
}

.gantt__surface {
  fill: none;
  pointer-events: all;
}

.gantt__segment {
  fill: currentcolor;
}

/*
 * The idle segment is a different *thing*, not a paler version of the same one.
 * Six idle hours and six busy hours cost very different amounts, and a reader
 * should not have to already know the convention to see which is which.
 */
[data-segment="suspended"] {
  fill: var(--surface-raised);
  stroke: currentcolor;
  stroke-width: 1;
  stroke-dasharray: 3 2;
}

.gantt__pattern {
  color: var(--surface);
  pointer-events: none;
  opacity: 0.55;
}

.gantt__cap {
  stroke: currentcolor;
  stroke-width: 2.5;
  stroke-dasharray: 2 2;
}

.gantt__cost {
  fill: none;
  stroke: var(--ink);
  stroke-width: 1.5;
}

.gantt__cost[data-source="estimated"] {
  stroke-dasharray: 4 3;
  opacity: 0.7;
}

.gantt__grid line {
  stroke: var(--edge);
  stroke-width: 0.5;
}

.gantt__mark line {
  stroke: var(--state-blocked);
  stroke-width: 1.5;
  stroke-dasharray: 4 2;
}

.gantt__mark text {
  font-size: 10px;
  fill: var(--state-blocked);
}

.gantt__lane-label,
.gantt__axis text {
  font-size: 10px;
  fill: var(--ink-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.gantt__window,
.gantt__help {
  color: var(--ink-muted);
  font-size: 0.85rem;
}

.gantt__marks,
.gantt__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1rem;
  padding: 0;
  margin: 0;
  list-style: none;
  font-size: 0.85rem;
}

.gantt__marks li {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.15rem 0.5rem;
  padding: 0.4rem 0.6rem;
  border-inline-start: 3px solid var(--state-blocked);
  background: var(--surface-raised);
}

.gantt__marks strong {
  font-weight: 600;
}

.gantt__marks span:last-child {
  grid-column: 2;
  color: var(--ink-muted);
}

.gantt__legend li {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  color: var(--ink-muted);
}

.gantt__swatch {
  inline-size: 16px;
  block-size: 12px;
}

.gantt__controls {
  display: flex;
  gap: 0.5rem;
}

.gantt__controls button {
  padding: 0.25rem 0.6rem;
  border: 1px solid var(--edge);
  border-radius: 0.35rem;
  background: var(--surface-raised);
  color: inherit;
  font-size: 0.85rem;
}
</style>
