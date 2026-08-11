/**
 * KAR-17.4 — F10.5's context budget, derived. The chart's whole brain, with no
 * DOM in it.
 *
 * Verifies: EPIC-17-S17, EPIC-17-S18, EPIC-17-S19, EPIC-17-S32 ·
 * AC1, AC2, AC4, AC5, AC6, AC8, AC10
 *
 * ## The rule this file exists to keep
 *
 * `context.compacted` carries `fidelity: 'exact' | 'partial'` and
 * `after: number | null`, because vendor-side compaction reports a *pre*-token
 * count and nothing else — Claude Code's `compact_boundary` frame is
 * `{ trigger, pre_tokens }` (**verified 2026-08-02**, docs/04 §9.1). **When the
 * fidelity is `'partial'`, the gap is rendered as a gap.** There is no `?? 0`
 * below, no interpolation and no dashed guess, because *a bar with a fabricated
 * "after" number is worse than an honest hole* — a reader cannot tell the
 * fabrication from a measurement, and that is the difference between an
 * auditable system and one that quietly lies.
 *
 * The discriminator does that work, not a branch here: `compactionChart()` in
 * `@DeFlow/core` (KAR-09.6 AC5) is the rendering contract for a compaction, and
 * this module hands each event to it and keeps what comes back. Both fidelities
 * therefore render in one view with no special case (AC10), and the rule stays
 * checkable in `@DeFlow/core`'s own suite rather than in a browser.
 *
 * ## Why the stack is not `d3-shape`'s `stack()`
 *
 * d3's stack generator wants **one key order for the whole chart**: it is built
 * for a matrix where every row carries the same series. AC1 wants the opposite —
 * *"pinned segments always the base of the stack, matching the order they render
 * in the prompt"* — and the prompt order is a property of each packet
 * (`renderOrderOf` in `@DeFlow/core`: pinned first, then everything else by
 * `sourceEvent`). Two invocations can order their kinds differently and both be
 * right. A global key order would silently be wrong for one of them, so the
 * offsets are accumulated per bar here instead. The rest of d3's advice stands
 * and is followed elsewhere: it is a maths library in this codebase, and no
 * component may import `d3-selection` (docs/12 §6.9).
 *
 * ## Totals are per method, never one figure
 *
 * AC8: a `heuristic` estimate and a `vendor-reported` count are different kinds
 * of number, and adding them produces a figure that is neither. So a bar and a
 * band each carry `totals: MethodTotal[]` — one entry per counting method
 * present — and there is deliberately no single `total` field for a template to
 * reach for. `stacked` exists for *geometry only*: it is how tall to draw, not a
 * number anything displays.
 */
import {
  BUDGET_FRACTION_CEILING,
  BUDGET_FRACTION_DEFAULT,
  type CompactionChart,
  type CompactionTrigger,
  type CompactionView,
  compactionChart,
  type Handle,
  type SegmentId,
} from '@DeFlow/core';
import type {
  CompactionVM,
  ContextProjection,
  PacketVM,
  PinViolationVM,
  SegmentKind,
  SegmentVM,
} from '../ledger/projections/context.ts';

/** §5.2's *"default 0.5"*, re-exported so a view reads one definition. */
export const DEFAULT_BUDGET_FRACTION = BUDGET_FRACTION_DEFAULT;

/** §5.2's *"never above 0.6"*. */
export const MAX_BUDGET_FRACTION = BUDGET_FRACTION_CEILING;

/**
 * AC4's label, in one place.
 *
 * It says *vendor-reported* rather than "unknown" because the distinction is
 * the point: somebody did report something — a `pre_tokens` figure — and what
 * is missing is the other end of it.
 */
export const VENDOR_POST_COUNT_UNAVAILABLE = 'vendor-reported; post-count unavailable';

/** AC5's positive assertion, the words the pinned-digest list is filed under. */
export const PINNED_SURVIVED_LABEL = 'these pinned digests survived';

/** One token figure, and the method that produced it. Never merged (AC8). */
export interface MethodTotal {
  readonly method: string;
  readonly tokens: number;
}

/** One segment, as a rect: hoverable, addressable, click-through-able (AC7). */
export interface BudgetSliceVM {
  readonly segmentId: string;
  readonly kind: SegmentKind;
  readonly pinned: boolean;
  readonly tokens: number;
  readonly method: string;
  readonly sourceEvent: number;
  /** Token space, base first. */
  readonly from: number;
  readonly to: number;
}

/** One `SegmentKind`'s band of the stack (AC1). */
export interface BudgetBandVM {
  readonly kind: SegmentKind;
  readonly pinned: boolean;
  readonly from: number;
  readonly to: number;
  readonly totals: readonly MethodTotal[];
  readonly slices: readonly BudgetSliceVM[];
}

/** One `context.compacted`, ready to annotate a bar with (AC3, AC4, AC5). */
export interface CompactionMarkVM {
  readonly seq: number;
  readonly node: string;
  readonly scope: CompactionVM['scope'];
  readonly fidelity: CompactionVM['fidelity'];
  readonly trigger: string;
  readonly before: number;
  /** `null` when the vendor reported no post count. Never coerced. */
  readonly after: number | null;
  /** `before - after`, or `null` when there is no honest `after` to subtract. */
  readonly saved: number | null;
  /**
   * AC4's words, present exactly when the chart's `after` bar is a gap — so the
   * label and the geometry cannot disagree about whether a number exists.
   */
  readonly gapLabel: string | null;
  /** KAR-09.6's rendering contract, decided there and rendered here. */
  readonly chart: CompactionChart;
  readonly droppedSegments: readonly string[];
  readonly originalHandle: string | null;
  readonly pinnedKept: readonly string[];
}

/** The typed failure the violated node ended on (AC6). */
export interface BudgetFailureVM {
  readonly reason: string;
  readonly class: string;
  readonly message: string;
  readonly evidence: readonly string[];
}

/** One node invocation: one stacked bar. */
export interface BudgetBarVM {
  /** `${nodeId}#${attempt}` — the packet projection's own key. */
  readonly invocation: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly builtAtSeq: number;
  readonly limitTokens: number;
  readonly fraction: number;
  /** False for a packet built against a fraction above §5.2's ceiling. */
  readonly fractionWithinPolicy: boolean;
  readonly bands: readonly BudgetBandVM[];
  readonly totals: readonly MethodTotal[];
  /**
   * The bar's height in token space. **Geometry, not a displayed figure** — see
   * the module note on AC8.
   */
  readonly stacked: number;
  readonly overBudget: boolean;
  /** Where this bar's budget line sits, as a fraction of the chart's domain. */
  readonly budgetLine: number;
  readonly compactions: readonly CompactionMarkVM[];
  readonly violation: PinViolationVM | null;
  readonly failure: BudgetFailureVM | null;
}

export interface BudgetChartVM {
  readonly bars: readonly BudgetBarVM[];
  /**
   * The top of the token axis: the largest budget, or the tallest bar when one
   * broke through it.
   *
   * **Not `max(bar)`** (AC2). A scale fitted to the data alone puts the tallest
   * bar at the top of every chart, and headroom — the entire question this view
   * answers — stops being visible at all.
   */
  readonly domainMax: number;
  /** The shared budget line, or `null` when the bars disagree about theirs. */
  readonly budgetLine: number | null;
  /**
   * Compactions naming an invocation this projection never saw a
   * `context.built` for.
   *
   * Kept rather than dropped: a tab that joined the stream late has no packet
   * to annotate, and silently discarding the event would hide the one thing
   * this view exists to show.
   */
  readonly unattached: readonly CompactionMarkVM[];
}

/**
 * `renderOrderOf`'s rule, over the record form of a segment.
 *
 * Restated rather than imported because `@DeFlow/core`'s function is typed over
 * `Segment` — which carries `text` — and what a projection holds is the record
 * form the ledger stores, without it. The rule itself is one line and it is the
 * same one: pinned first, then everything else in `sourceEvent` order.
 * `toSorted` is stable, so segments sharing a `sourceEvent` keep the order the
 * builder wrote them in, which is the order they were rendered in.
 */
export function promptOrderOf(segments: readonly SegmentVM[]): readonly SegmentVM[] {
  const bySourceEvent = (a: SegmentVM, b: SegmentVM): number => a.sourceEvent - b.sourceEvent;
  return [
    ...segments.filter((segment) => segment.pinned).toSorted(bySourceEvent),
    ...segments.filter((segment) => !segment.pinned).toSorted(bySourceEvent),
  ];
}

/** Sums by counting method, in order of first appearance. Never one number. */
function totalsByMethod(slices: readonly BudgetSliceVM[]): readonly MethodTotal[] {
  const sums = new Map<string, number>();
  for (const slice of slices) sums.set(slice.method, (sums.get(slice.method) ?? 0) + slice.tokens);
  return [...sums].map(([method, tokens]) => ({ method, tokens }));
}

function bandsOf(packet: PacketVM): readonly BudgetBandVM[] {
  // Kinds in the order the prompt introduces them, which is what puts the
  // pinned block at the base: every pinned segment precedes every unpinned one,
  // and a `pinned.*` kind has no unpinned members.
  const byKind = new Map<SegmentKind, SegmentVM[]>();
  for (const segment of promptOrderOf(packet.segments)) {
    const held = byKind.get(segment.kind);
    if (held === undefined) byKind.set(segment.kind, [segment]);
    else held.push(segment);
  }

  const bands: BudgetBandVM[] = [];
  let offset = 0;
  for (const [kind, segments] of byKind) {
    const from = offset;
    const slices: BudgetSliceVM[] = segments.map((segment) => {
      const slice: BudgetSliceVM = {
        segmentId: segment.id,
        kind: segment.kind,
        pinned: segment.pinned,
        tokens: segment.tokens.estimated,
        method: segment.tokens.method,
        sourceEvent: segment.sourceEvent,
        from: offset,
        to: offset + segment.tokens.estimated,
      };
      offset = slice.to;
      return slice;
    });

    bands.push({
      kind,
      pinned: segments.every((segment) => segment.pinned),
      from,
      to: offset,
      totals: totalsByMethod(slices),
      slices,
    });
  }
  return bands;
}

/**
 * The `CompactionView` `compactionChart()` consumes, from what the projection
 * kept.
 *
 * `inferred` is recomputed rather than carried because the projection does not
 * hold it: it is true exactly when a `partial` event has an `after` anyway —
 * §6.2's one permitted recovery — and false for every `exact` one.
 *
 * The two casts restore the brands `../ledger/projections/context.ts`
 * deliberately widened to `string` for the views. Nothing downstream re-derives
 * an id from them; they are carried to `compactionChart` and rendered.
 */
function markOf(record: CompactionVM): CompactionMarkVM {
  const view: CompactionView = {
    scope: record.scope,
    fidelity: record.fidelity,
    trigger: record.trigger as CompactionTrigger,
    before: record.before,
    after: record.after,
    inferred: record.fidelity === 'partial' && record.after !== null,
    droppedSegments: record.droppedSegments as readonly SegmentId[],
    demotedToHandles: record.demotedToHandles as readonly Handle[],
    originalHandle: record.originalHandle as Handle | null,
  };
  const chart = compactionChart(view);

  return {
    seq: record.seq,
    node: record.node,
    scope: record.scope,
    fidelity: record.fidelity,
    trigger: record.trigger,
    before: record.before,
    after: record.after,
    saved: record.saved,
    // Read off the chart rather than off the event, so a label saying "no
    // number" cannot appear beside a bar that drew one.
    gapLabel: chart.bars[1].style === 'gap' ? VENDOR_POST_COUNT_UNAVAILABLE : null,
    chart,
    droppedSegments: record.droppedSegments,
    originalHandle: record.originalHandle,
    pinnedKept: record.pinnedKept,
  };
}

/** The invocation key a packet and a violation are both filed under. */
const invocationOf = (nodeId: string, attempt: number): string => `${nodeId}#${attempt}`;

/**
 * The whole chart, from the context projection.
 *
 * `failures` is a join the caller supplies rather than a lookup this module
 * does, because a node's typed failure lives in the *plan* projection and the
 * seven projections never read one another (KAR-16.3). AC6 needs the reason
 * beside the violation, and this is the seam that gets it there.
 */
export function budgetChart(
  context: Pick<ContextProjection, 'packets' | 'compactions' | 'violations'>,
  failures: ReadonlyMap<string, BudgetFailureVM> = new Map(),
): BudgetChartVM {
  const packets = [...context.packets.values()].toSorted(
    (a, b) =>
      a.builtAtSeq - b.builtAtSeq ||
      invocationOf(a.nodeId, a.attempt).localeCompare(invocationOf(b.nodeId, b.attempt)),
  );

  const violations = new Map(
    context.violations.map((violation) => [
      invocationOf(violation.node, violation.attempt),
      violation,
    ]),
  );

  const marks = new Map<string, CompactionMarkVM[]>();
  const unattached: CompactionMarkVM[] = [];
  for (const record of context.compactions) {
    const mark = markOf(record);
    // The invocation a compaction belongs to is the latest packet of that node
    // built at or before it. A compaction that precedes every packet of its
    // node — a tab that hydrated mid-run — attaches to the first one there is,
    // because that is the invocation it happened inside.
    const candidates = packets.filter((one) => one.nodeId === record.node);
    const at = candidates.findLast((one) => one.builtAtSeq <= record.seq) ?? candidates[0] ?? null;
    if (at === null) {
      unattached.push(mark);
      continue;
    }
    const key = invocationOf(at.nodeId, at.attempt);
    const held = marks.get(key);
    if (held === undefined) marks.set(key, [mark]);
    else held.push(mark);
  }

  const partial = packets.map((packet) => {
    const bands = bandsOf(packet);
    const slices = bands.flatMap((band) => band.slices);
    return {
      packet,
      bands,
      totals: totalsByMethod(slices),
      stacked: slices.reduce((sum, slice) => sum + slice.tokens, 0),
    };
  });

  // AC2, in one expression: the domain is the budget unless a bar broke it.
  const domainMax = Math.max(
    1,
    ...partial.map((one) => one.packet.budget.limitTokens),
    ...partial.map((one) => one.stacked),
  );

  const bars: BudgetBarVM[] = partial.map(({ packet, bands, totals, stacked }) => {
    const invocation = invocationOf(packet.nodeId, packet.attempt);
    return {
      invocation,
      nodeId: packet.nodeId,
      attempt: packet.attempt,
      builtAtSeq: packet.builtAtSeq,
      limitTokens: packet.budget.limitTokens,
      fraction: packet.budget.fraction,
      fractionWithinPolicy: packet.budget.fraction <= MAX_BUDGET_FRACTION,
      bands,
      totals,
      stacked,
      overBudget: stacked > packet.budget.limitTokens,
      budgetLine: packet.budget.limitTokens / domainMax,
      compactions: marks.get(invocation) ?? [],
      violation: packet.violation ?? violations.get(invocation) ?? null,
      failure: failures.get(invocation) ?? null,
    };
  });

  const lines = new Set(bars.map((bar) => bar.budgetLine));

  return {
    bars,
    domainMax,
    budgetLine: lines.size === 1 ? ([...lines][0] as number) : null,
    unattached,
  };
}

/** A token figure as a share of the axis, for a `height` or a `y`. */
export const heightFraction = (tokens: number, domainMax: number): number => tokens / domainMax;
