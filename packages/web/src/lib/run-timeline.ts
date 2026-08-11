/**
 * KAR-17.8 — F10.9's run timeline, derived. The Gantt's whole brain, with no
 * DOM in it.
 *
 * Verifies: EPIC-17-S30, EPIC-17-S31, EPIC-17-S32 · AC1–AC9
 *
 * ## What d3 is used for here, and what it is not
 *
 * `scaleUtc` maps a `ts` to an x, `scaleBand` maps a node to a lane, `line` maps
 * the cost series to a path string, and `max` bounds the money axis. All four
 * are **pure functions from data to numbers or strings**; not one of them
 * touches an element. The rendering is a `v-for` over what this module returns,
 * so the DOM has exactly one owner (docs/12-frontend-architecture.md §6.9), and
 * `test/no-d3-selection-in-web.test.ts` is what keeps it that way.
 *
 * `d3-axis` is inside AC10's allowed set and is deliberately not installed:
 * `axisBottom(scale)` only knows how to draw *through a d3 selection*, so
 * importing it would drag the banned half back in as a transitive dependency.
 * Ticks come from `scale.ticks()`, which needs no selection at all.
 *
 * `scaleUtc` rather than `scaleTime`, and `utcFormat` rather than `timeFormat`:
 * the ledger's `ts` is epoch milliseconds, and a chart whose axis labels moved
 * with the reader's machine would make two people looking at the same run
 * disagree about when something happened. The zone is stated in the label.
 *
 * ## Nothing here invents an end time
 *
 * An open span keeps `endTs: null` all the way into the data table, where it
 * renders as an em dash. What `now` buys is the bar's *right edge* — a
 * coordinate, not a measurement — and `open: true` beside it so the renderer
 * can cap that edge differently. Writing `now` into `endTs` would put an
 * invented duration into the accessible twin, where nothing could distinguish
 * it from something that was measured.
 *
 * ## Six idle hours are not six busy hours
 *
 * A suspension is a segment of its own inside the bar, and `busyMs` is the span
 * minus its idle time. A timeline that drew a six-hour human gate the way it
 * draws six hours of work makes a cheap run look expensive and hides where the
 * wall clock actually went — which is most of what this view exists to answer.
 *
 * ## `seq` orders, `ts` positions
 *
 * The x-axis is wall clock and therefore `ts`, but `ts` is informational and
 * moves backwards across a laptop sleep or an NTP correction (docs/04 §9). A
 * bar that appears to start before its predecessor finished is labelled
 * `tsArtefact` and **left exactly where the ledger put it**. Clamping it would
 * make the chart look correct and be wrong, which is the same failure class as
 * a fabricated compaction "after".
 */
import { max } from 'd3-array';
import {
  type ScaleBand,
  type ScaleLinear,
  type ScaleTime,
  scaleBand,
  scaleLinear,
  scaleUtc,
} from 'd3-scale';
import { curveStepAfter, line } from 'd3-shape';
import { utcFormat } from 'd3-time-format';
import type { SpanCost, SpanVM, TimelineProjection } from '../ledger/projections/timeline.ts';
import { type DisplayState, STATE_LABELS, stateVar } from './state-palette.ts';

/** A half-open wall-clock window, in epoch milliseconds. */
export interface TimeWindow {
  readonly from: number;
  readonly to: number;
}

/**
 * The smallest window a zoom will produce.
 *
 * A floor rather than a guard against division by zero: without one, four more
 * key presses than anybody meant to make leaves a window of nanoseconds and a
 * chart that looks broken rather than zoomed.
 */
export const MIN_WINDOW_MS = 1_000;

/** AC5 — the word this marker uses, and the word it must never use. */
export const PAUSED_LABEL = 'Budget ceiling reached — the run paused';

/** AC6. */
export const RATE_LIMITED_LABEL = 'The provider rate-limited this run';

/** AC7 — an observation. A long build and a wedged agent look identical here. */
export const STALLED_LABEL = 'The daemon noticed no progress';

/** EPIC-17-S31 — said in the tooltip rather than clamped out of the data. */
export const TS_ARTEFACT_NOTE =
  'This bar starts before an earlier attempt ended. `ts` is informational and can move ' +
  'backwards across a laptop sleep or an NTP correction; the order is `seq`, and it is correct.';

export type SegmentKind = 'execution' | 'suspended';

export interface TimelineSegmentVM {
  readonly kind: SegmentKind;
  readonly fromTs: number;
  readonly toTs: number;
  readonly x: number;
  readonly width: number;
  /** Nothing has ended this segment yet; its right edge is `now`. */
  readonly open: boolean;
}

export interface TimelineBarVM {
  /** `${nodeId}#${attempt}` — the projection's own key. */
  readonly key: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly lane: number;
  readonly state: DisplayState;
  /** A palette reference, never a resolved colour (docs/12 §9.1). */
  readonly colour: string;
  /** The second signal, so state is not carried by hue alone (AC2). */
  readonly pattern: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly startTs: number;
  /** `null` while the attempt is running. Never `now`. */
  readonly endTs: number | null;
  readonly open: boolean;
  readonly durationMs: number | null;
  /** Execution time: the span minus its idle time. */
  readonly busyMs: number | null;
  readonly suspendedMs: number | null;
  readonly costUsd: SpanCost;
  readonly segments: readonly TimelineSegmentVM[];
  /** EPIC-17-S31 — set when `ts` disagrees with `seq`. */
  readonly tsArtefact: string | null;
}

export type MarkerKind = 'paused' | 'rate-limited' | 'stalled';

export interface TimelineMarkerVM {
  readonly kind: MarkerKind;
  readonly seq: number;
  readonly ts: number;
  readonly x: number;
  readonly label: string;
  readonly detail: string;
}

export interface TimelineLaneVM {
  readonly nodeId: string;
  readonly y: number;
  readonly height: number;
}

export interface TimelineTickVM {
  readonly value: number;
  readonly offset: number;
  readonly label: string;
}

export interface CostLineVM {
  readonly source: 'vendor-reported' | 'estimated';
  readonly path: string;
}

/**
 * One table row per bar — AC9's seven columns, plus the key that joins it back.
 *
 * Strings rather than numbers because this *is* the rendered form: the table
 * doubles as the copy-paste-into-a-PR-description surface (docs/12 §9.4), and a
 * component that formatted the figures for itself would be a second derivation
 * and would disagree with the chart eventually.
 *
 * A `type` and not an `interface`, which is load-bearing rather than style:
 * TypeScript gives an object *type* an implicit index signature and an
 * interface none, so only this spelling is assignable to the shared table
 * component's `Record<string, string>` rows.
 */
export type TimelineRowVM = {
  readonly key: string;
  readonly node: string;
  readonly attempt: string;
  readonly start: string;
  readonly end: string;
  readonly duration: string;
  readonly state: string;
  readonly cost: string;
};

export interface TimelineChartVM {
  /** The whole run, in wall clock. */
  readonly extent: TimeWindow;
  /** What is drawn — the extent unless somebody zoomed. */
  readonly window: TimeWindow;
  readonly plot: { readonly width: number; readonly height: number };
  readonly lanes: readonly TimelineLaneVM[];
  readonly bars: readonly TimelineBarVM[];
  readonly markers: readonly TimelineMarkerVM[];
  readonly costLines: readonly CostLineVM[];
  readonly costPoints: readonly { readonly vendorReported: number | null }[];
  readonly costMax: number;
  readonly timeTicks: readonly TimelineTickVM[];
  readonly costTicks: readonly TimelineTickVM[];
  readonly rows: readonly TimelineRowVM[];
  readonly label: string;
  readonly empty: boolean;
}

export interface TimelineInput {
  readonly timeline: TimelineProjection;
  /**
   * Wall clock, for the open bar's right edge.
   *
   * A parameter and not `Date.now()`: a chart that read the clock for itself
   * could not be asserted against, and "the bar reaches the right-hand edge"
   * would be a property of when the spec happened to run.
   */
  readonly now: number;
  /** `null` means the whole run. */
  readonly window?: TimeWindow | null;
  readonly plot?: { readonly width: number; readonly laneHeight: number };
}

const DEFAULT_PLOT = { width: 1_000, laneHeight: 26 } as const;

/**
 * Seven states, seven fills — the pattern half of "never colour alone".
 *
 * These are ids the component defines as `<pattern>` elements; the assignment
 * lives here beside the colour for the reason `state-palette.ts` gives about
 * labels, which is that two signals defined in two files drift.
 */
export const STATE_PATTERNS: Record<DisplayState, string> = {
  pending: 'tl-dots',
  running: 'tl-forward',
  blocked: 'tl-cross',
  passed: 'tl-solid',
  failed: 'tl-back',
  abandoned: 'tl-sparse',
  'awaiting-human': 'tl-vertical',
};

const stateOf = (span: SpanVM): DisplayState => {
  if (span.outcome === 'passed') return 'passed';
  if (span.outcome === 'failed') return 'failed';
  if (span.outcome === 'cancelled') return 'abandoned';
  return span.suspensions.some((one) => one.untilTs === null) ? 'awaiting-human' : 'running';
};

const stamp = utcFormat('%Y-%m-%d %H:%M:%S');

/** `2026-08-11 09:00:07Z`. UTC, and it says so. */
export const formatInstant = (ts: number): string => `${stamp(new Date(ts))}Z`;

/** `6h 2m`, `10m`, `4s`. Coarse on purpose: this is a wall-clock summary. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
  return `${rest}s`;
}

/** `$25.4`, `$0.147`, `$25`. Trailing zeros trimmed, nothing rounded away. */
export function formatMoney(value: number): string {
  return `$${value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
}

/**
 * A span's money, as the table prints it.
 *
 * A provider that priced nothing is **named** rather than folded into a zero,
 * because "$0.147 plus gemini-cli, which does not report" and "$0.147" are
 * different statements and only one of them is true (docs/08 §7).
 */
export function formatCost(cost: SpanCost): string {
  const parts: string[] = [];
  if (cost.vendorReported !== null) parts.push(`${formatMoney(cost.vendorReported)} billed`);
  if (cost.estimated !== null) parts.push(`${formatMoney(cost.estimated)} estimated`);
  for (const provider of cost.unaccounted) parts.push(`${provider} (unpriced)`);
  return parts.length === 0 ? '—' : parts.join(' + ');
}

// ── the viewport ─────────────────────────────────────────────────────────────
//
// AC8 wants zoom and brush to work from the keyboard as well as from the
// pointer, and the way to get that is for neither input to own the state: both
// produce a `TimeWindow` through the pure functions below, and the component
// holds one `ref`. A `d3-zoom` behaviour bound to an element would have given
// the pointer a private transform the keyboard could not reach — which is how
// "keyboard support" ends up meaning "tab stops on a chart nobody can move".

const span = (window: TimeWindow): number => window.to - window.from;

/** Slides `window` inside `extent` without changing its width. */
function clampWindow(window: TimeWindow, extent: TimeWindow): TimeWindow {
  const width = Math.min(span(window), span(extent));
  if (window.from < extent.from) return { from: extent.from, to: extent.from + width };
  if (window.from + width > extent.to) return { from: extent.to - width, to: extent.to };
  return { from: window.from, to: window.from + width };
}

/**
 * `window` scaled by `factor` about `focus`, kept inside `extent`.
 *
 * `factor < 1` zooms in. The focus is what makes a wheel gesture and a `+` key
 * press the same operation with a different anchor.
 */
export function zoomWindow(
  window: TimeWindow,
  extent: TimeWindow,
  factor: number,
  focus: number = window.from + span(window) / 2,
): TimeWindow {
  const width = Math.min(Math.max(span(window) * factor, MIN_WINDOW_MS), span(extent));
  const ratio = span(window) === 0 ? 0.5 : (focus - window.from) / span(window);
  const anchored = Math.min(Math.max(ratio, 0), 1);
  return clampWindow(
    { from: focus - width * anchored, to: focus - width * anchored + width },
    extent,
  );
}

/** `window` moved by `fraction` of its own width, stopped at `extent`'s ends. */
export function panWindow(window: TimeWindow, extent: TimeWindow, fraction: number): TimeWindow {
  const shift = span(window) * fraction;
  return clampWindow({ from: window.from + shift, to: window.to + shift }, extent);
}

/**
 * The window a pointer drag from `x0` to `x1` selects, in either direction.
 *
 * `within` is whatever is currently drawn, so a brush composes with a zoom
 * instead of always reaching back to the whole run.
 */
export function windowFromBrush(
  within: TimeWindow,
  x0: number,
  x1: number,
  plotWidth: number,
): TimeWindow {
  const low = Math.min(x0, x1);
  const high = Math.max(x0, x1);
  const at = (x: number): number => within.from + (x / plotWidth) * span(within);
  const from = at(low);
  const to = Math.max(at(high), from + MIN_WINDOW_MS);
  return clampWindow({ from, to }, within);
}

export type TimelineCommand = 'pan-left' | 'pan-right' | 'zoom-in' | 'zoom-out' | 'reset';

export interface KeyLike {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
}

/**
 * The keyboard half of AC8.
 *
 * A modified arrow belongs to the browser — Cmd-Left is Back, Alt-Left is a
 * word jump in a field — so a chart that swallowed it would be taking a key
 * away from somebody navigating rather than reading.
 */
export function timelineKeyCommand(event: KeyLike): TimelineCommand | null {
  if (event.metaKey === true || event.ctrlKey === true || event.altKey === true) return null;
  switch (event.key) {
    case 'ArrowLeft':
      return 'pan-left';
    case 'ArrowRight':
      return 'pan-right';
    case '+':
    case '=':
      return 'zoom-in';
    case '-':
    case '_':
      return 'zoom-out';
    case 'Home':
    case '0':
      return 'reset';
    default:
      return null;
  }
}

// ── the chart ────────────────────────────────────────────────────────────────

/** Everything the run timeline draws, from the projection and a clock reading. */
export function runTimeline(input: TimelineInput): TimelineChartVM {
  const state = input.timeline;
  const geometry = input.plot ?? DEFAULT_PLOT;
  const spans = [...state.spans.values()];
  const extent = runExtent(state, spans, input.now);
  const window = input.window ?? extent;
  const height = Math.max(state.lanes.length, 1) * geometry.laneHeight;

  const x: TimeScale = scaleUtc().domain([window.from, window.to]).range([0, geometry.width]);
  const lane: LaneScale = scaleBand<string>()
    .domain(state.lanes)
    .range([0, height])
    .paddingInner(0.25)
    .paddingOuter(0.15);

  const bars = spans.map((one) => bar(one, spans, x, lane, geometry.width, input.now));
  const money = max(state.costSeries, (point) =>
    Math.max(point.vendorReported ?? 0, point.estimated ?? 0),
  );
  const costMax = money === undefined || money === 0 ? 1 : money;
  const y: MoneyScale = scaleLinear().domain([0, costMax]).range([height, 0]);

  return {
    extent,
    window,
    plot: { width: geometry.width, height },
    lanes: state.lanes.map((nodeId) => ({
      nodeId,
      y: lane(nodeId) ?? 0,
      height: lane.bandwidth(),
    })),
    bars,
    markers: markers(state, window, x),
    costLines: costLines(state, x, y),
    costPoints: state.costSeries,
    costMax,
    timeTicks: x.ticks(6).map((tick) => ({
      value: tick.getTime(),
      offset: x(tick),
      label: x.tickFormat()(tick),
    })),
    costTicks: y.ticks(4).map((tick) => ({
      value: tick,
      offset: y(tick),
      label: formatMoney(tick),
    })),
    rows: bars.map(row),
    label:
      `Run timeline: ${bars.length} attempt bars across ${state.lanes.length} nodes, ` +
      `${formatInstant(window.from)} to ${formatInstant(window.to)}, ` +
      'with cumulative cost on a second axis.',
    empty: bars.length === 0,
  };
}

/**
 * The run's wall-clock extent.
 *
 * `now` is included only when something is still open — a finished run ends
 * when it ended, and stretching its axis to the moment somebody opened the tab
 * would draw hours of empty plot and make every bar a sliver.
 */
function runExtent(state: TimelineProjection, spans: readonly SpanVM[], now: number): TimeWindow {
  const stamps: number[] = [];
  for (const one of spans) {
    stamps.push(one.startTs);
    if (one.endTs !== null) stamps.push(one.endTs);
  }
  for (const suspension of state.suspensions) {
    stamps.push(suspension.fromTs);
    if (suspension.untilTs !== null) stamps.push(suspension.untilTs);
  }
  for (const point of state.costSeries) stamps.push(point.ts);
  for (const mark of [...state.pauses, ...state.rateLimits, ...state.stalls]) stamps.push(mark.ts);

  const open =
    spans.some((one) => one.open) || state.suspensions.some((one) => one.untilTs === null);
  if (open) stamps.push(now);
  if (stamps.length === 0) return { from: now - MIN_WINDOW_MS, to: now };

  const from = Math.min(...stamps);
  const to = Math.max(...stamps);
  return to - from < MIN_WINDOW_MS ? { from, to: from + MIN_WINDOW_MS } : { from, to };
}

// Spelled out rather than `ReturnType<typeof scaleUtc>`: the factory is
// generic over its range and output, and `ReturnType` collapses both to
// `unknown`, which quietly turns every coordinate in this file into one.
type TimeScale = ScaleTime<number, number>;
type LaneScale = ScaleBand<string>;
type MoneyScale = ScaleLinear<number, number>;

function bar(
  one: SpanVM,
  spans: readonly SpanVM[],
  x: TimeScale,
  lane: LaneScale,
  plotWidth: number,
  now: number,
): TimelineBarVM {
  const end = one.endTs ?? now;
  const state = stateOf(one);
  const left = clamp(x(one.startTs), 0, plotWidth);
  const right = clamp(x(end), 0, plotWidth);

  return {
    key: `${one.nodeId}#${one.attempt}`,
    nodeId: one.nodeId,
    attempt: one.attempt,
    lane: one.lane,
    state,
    colour: stateVar(state),
    pattern: STATE_PATTERNS[state],
    x: left,
    y: lane(one.nodeId) ?? 0,
    width: Math.max(right - left, 0),
    height: lane.bandwidth(),
    startTs: one.startTs,
    endTs: one.endTs,
    open: one.open,
    durationMs: one.endTs === null ? null : one.endTs - one.startTs,
    busyMs: one.endTs === null ? null : one.endTs - one.startTs - (one.suspendedMs ?? 0),
    suspendedMs: one.suspendedMs,
    costUsd: one.costUsd,
    segments: segments(one, end, x, plotWidth),
    tsArtefact: tsArtefact(one, spans) ? TS_ARTEFACT_NOTE : null,
  };
}

/**
 * The bar, cut into what ran and what waited.
 *
 * Walked in `seq` order rather than `ts` order for the reason the whole module
 * is: two suspensions whose `ts` crossed a clock correction would otherwise cut
 * the bar in the wrong places, and the cut is the point of the exercise.
 */
function segments(one: SpanVM, end: number, x: TimeScale, plotWidth: number): TimelineSegmentVM[] {
  const built: TimelineSegmentVM[] = [];
  const at = (from: number, to: number, kind: SegmentKind, open: boolean): void => {
    if (to <= from) return;
    const left = clamp(x(from), 0, plotWidth);
    const right = clamp(x(to), 0, plotWidth);
    built.push({ kind, fromTs: from, toTs: to, x: left, width: Math.max(right - left, 0), open });
  };

  let cursor = one.startTs;
  for (const suspension of [...one.suspensions].toSorted(
    (left, right) => left.fromSeq - right.fromSeq,
  )) {
    at(cursor, suspension.fromTs, 'execution', false);
    const until = suspension.untilTs ?? end;
    at(suspension.fromTs, until, 'suspended', suspension.untilTs === null);
    cursor = Math.max(cursor, until);
  }
  at(cursor, end, 'execution', one.open);
  return built;
}

/**
 * True when `seq` says this attempt began after another had ended, and `ts`
 * says otherwise.
 *
 * The condition is deliberately narrow: an *overlap* between two running nodes
 * is parallelism and the thing this chart exists to show. What is impossible is
 * starting before something that finished before you started.
 */
function tsArtefact(one: SpanVM, spans: readonly SpanVM[]): boolean {
  return spans.some(
    (other) =>
      other.endSeq !== null &&
      other.endSeq < one.startSeq &&
      other.endTs !== null &&
      other.endTs > one.startTs,
  );
}

function markers(state: TimelineProjection, window: TimeWindow, x: TimeScale): TimelineMarkerVM[] {
  const built: TimelineMarkerVM[] = [];

  for (const pause of state.pauses) {
    built.push({
      kind: 'paused',
      seq: pause.seq,
      ts: pause.ts,
      x: x(pause.ts),
      label: PAUSED_LABEL,
      detail:
        `${pause.scope} ${pause.dimension} ceiling ` +
        `${dimensionValue(pause.dimension, pause.limit)}; ` +
        `${dimensionValue(pause.dimension, pause.actual)} reached` +
        `${pause.node === null ? '' : ` on ${pause.node}`}.`,
    });
  }

  for (const limit of state.rateLimits) {
    built.push({
      kind: 'rate-limited',
      seq: limit.seq,
      ts: limit.ts,
      x: x(limit.ts),
      label: RATE_LIMITED_LABEL,
      detail:
        `${limit.provider} — ` +
        (limit.resetsAt === null
          ? 'the vendor named no reset time.'
          : `resets at ${formatInstant(limit.resetsAt)}.`),
    });
  }

  for (const stall of state.stalls) {
    built.push({
      kind: 'stalled',
      seq: stall.seq,
      ts: stall.ts,
      x: x(stall.ts),
      label: STALLED_LABEL,
      detail:
        `No event for ${formatDuration(stall.idleMs)} after seq ${stall.watermarkSeq}. ` +
        (stall.runningNodes.length === 0
          ? 'No node was running.'
          : `Still running: ${stall.runningNodes.join(', ')}.`) +
        ' A long build looks the same from here — this is an observation, not a verdict.',
    });
  }

  return built
    .filter((mark) => mark.ts >= window.from && mark.ts <= window.to)
    .toSorted((left, right) => left.seq - right.seq);
}

const dimensionValue = (dimension: 'cost' | 'wallclock', value: number): string =>
  dimension === 'cost' ? formatMoney(value) : formatDuration(value);

/**
 * One path per counting tier, and never one path over both.
 *
 * `curveStepAfter` because a cumulative total is a step function: it holds flat
 * until an event moves it, and a straight interpolation between two points
 * would draw money being spent during minutes nothing was spent.
 */
function costLines(state: TimelineProjection, x: TimeScale, y: MoneyScale): CostLineVM[] {
  const built: CostLineVM[] = [];
  const sources = [
    {
      source: 'vendor-reported',
      read: (point: { vendorReported: number | null }) => point.vendorReported,
    },
    { source: 'estimated', read: (point: { estimated: number | null }) => point.estimated },
  ] as const;

  for (const { source, read } of sources) {
    if (!state.costSeries.some((point) => read(point) !== null)) continue;
    const path = line<(typeof state.costSeries)[number]>()
      .defined((point) => read(point) !== null)
      .curve(curveStepAfter)
      .x((point) => x(point.ts))
      .y((point) => y(read(point) ?? 0))(state.costSeries);
    if (path === null) continue;
    built.push({ source, path });
  }

  return built;
}

const row = (one: TimelineBarVM): TimelineRowVM => ({
  key: one.key,
  node: one.nodeId,
  attempt: String(one.attempt),
  start: formatInstant(one.startTs),
  end: one.endTs === null ? '—' : formatInstant(one.endTs),
  duration: one.durationMs === null ? '—' : formatDuration(one.durationMs),
  state: STATE_LABELS[one.state],
  cost: formatCost(one.costUsd),
});

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);
