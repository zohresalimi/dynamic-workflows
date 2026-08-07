/**
 * KAR-09.6 — compaction as an event that says honestly how much it knows
 * (docs/08-context-and-memory.md §6).
 *
 * DeFlow owns exactly half of F6.6. Its own packet-level compaction knows
 * everything the requirement asks for: it counted the tokens on both sides, it
 * knows which `SegmentId`s it demoted and to which handles, and it can keep the
 * pre-compaction manifest. The vendor's own in-session compaction knows almost
 * none of it — Claude Code's `compact_boundary` frame carries
 * `compact_metadata.pre_tokens` and nothing else: no post count, no dropped
 * list, no handle to what it summarised away (verified 2026-08-02 from the
 * binary's zod schemas).
 *
 * So the type is a **discriminated union rather than one shape with optional
 * fields**, and that is the load-bearing decision in this file. §6.2 permits
 * one recovery — read the next turn's `modelUsage[model].inputTokens` as an
 * approximate post-compaction figure — and immediately pins its label: *store
 * it as `after` with `fidelity: 'partial'`, label it inferred everywhere it is
 * displayed, and never promote it to `'exact'`.* A single shape with
 * `fidelity: 'exact' | 'partial'` makes that a rule somebody has to remember at
 * every call site. Two arms make it a compile error, which is what AC4 asks
 * for.
 *
 * The recovered figure is also **not** written back into the event. The ledger
 * is append-only and the vendor reported `pre_tokens` alone; what the ledger
 * stores stays what the vendor said. The inference is a property of the
 * *projection* (`compactionView`), which is where "flagged `inferred: true`"
 * can be true of everything downstream at once, including a consumer reading
 * the event years later.
 *
 * `compactionChart` is AC5's rendering contract expressed as data so it can be
 * tested without a browser and cannot be re-decided per view: a `partial`
 * event's `after` bar is hatched and labelled, an absent one is a gap rather
 * than a zero, and there is a plain sentence saying the vendor does not report
 * what it dropped. *"A chart with a fabricated 'after' number is worse than an
 * honest gap."*
 *
 * Verifies: EPIC-09-S30, EPIC-09-S31, EPIC-09-S32, EPIC-09-S33, EPIC-09-S35 ·
 * AC1, AC2, AC3, AC4, AC5, AC7, AC8
 */
import type { Handle, SegmentId } from './ids.ts';
import type { PermissionLevel } from './plan-graph.ts';

/** What `compact_metadata.trigger` can say. The vendor's vocabulary, not ours. */
export type VendorCompactTrigger = 'auto' | 'manual';

/** DeFlow's own vocabulary: who decided, on which side of the wire. */
export type CompactionTrigger = 'threshold' | 'manual' | 'vendor.auto';

/**
 * AC3. `'auto'` becomes `'vendor.auto'` rather than a bare `'auto'` because the
 * distinction the operator needs is *whose* threshold fired: DeFlow's own
 * budget produces `'threshold'`, and the two must never fold together in a
 * cost view.
 */
export function compactionTriggerOf(trigger: VendorCompactTrigger): 'vendor.auto' | 'manual' {
  return trigger === 'auto' ? 'vendor.auto' : 'manual';
}

/** The half of F6.6 that is fully achievable: DeFlow counted both ends. */
export interface PacketCompaction {
  readonly scope: 'DeFlow.packet';
  readonly fidelity: 'exact';
  readonly trigger: 'threshold' | 'manual';
  readonly before: number;
  readonly after: number;
  readonly droppedSegments: readonly SegmentId[];
  readonly demotedToHandles: readonly Handle[];
  readonly pinnedKept: readonly string[];
  /** The pre-compaction manifest blob (AC1). */
  readonly originalHandle: Handle | null;
}

/**
 * The half the vendor owns. `after: null` and the two empty arrays are typed as
 * literals, so a caller cannot fill them in later "just this once".
 *
 * `originalHandle` is the one thing that can be populated here, and it is not
 * vendor-reported: it is §6.3's transcript snapshot, a file DeFlow copied
 * itself. It stays nullable because that path is Unverified — a missing file is
 * `null`, never an error (AC6).
 */
export interface VendorCompaction {
  readonly scope: 'vendor.session';
  readonly fidelity: 'partial';
  readonly trigger: 'vendor.auto' | 'manual';
  readonly before: number;
  readonly after: null;
  readonly droppedSegments: readonly [];
  readonly demotedToHandles: readonly [];
  readonly pinnedKept: readonly string[];
  readonly originalHandle: Handle | null;
}

export type Compaction = PacketCompaction | VendorCompaction;

export function packetCompaction(input: {
  readonly trigger: 'threshold' | 'manual';
  readonly before: number;
  readonly after: number;
  readonly droppedSegments: readonly SegmentId[];
  readonly demotedToHandles: readonly Handle[];
  readonly pinnedKept: readonly string[];
  readonly originalHandle: Handle | null;
}): PacketCompaction {
  return { scope: 'DeFlow.packet', fidelity: 'exact', ...input };
}

/** AC2 — everything the boundary frame reported, and nothing else. */
export function vendorCompaction(input: {
  readonly trigger: VendorCompactTrigger;
  /** `compact_metadata.pre_tokens`. */
  readonly preTokens: number;
  readonly pinnedKept?: readonly string[];
  /** §6.3's transcript snapshot, when the file was there. */
  readonly originalHandle?: Handle | null;
}): VendorCompaction {
  return {
    scope: 'vendor.session',
    fidelity: 'partial',
    trigger: compactionTriggerOf(input.trigger),
    before: input.preTokens,
    after: null,
    droppedSegments: [],
    demotedToHandles: [],
    pinnedKept: input.pinnedKept ?? [],
    originalHandle: input.originalHandle ?? null,
  };
}

/** F10.5's payload: the event, plus whether its `after` was measured or guessed. */
export interface CompactionView {
  readonly scope: Compaction['scope'];
  readonly fidelity: Compaction['fidelity'];
  readonly trigger: CompactionTrigger;
  readonly before: number;
  readonly after: number | null;
  /** True only ever on a `vendor.session` event (AC4). */
  readonly inferred: boolean;
  readonly droppedSegments: readonly SegmentId[];
  readonly demotedToHandles: readonly Handle[];
  readonly originalHandle: Handle | null;
}

/**
 * The projection a consumer renders, given the compaction and — optionally —
 * the next turn's Tier-1 report.
 *
 * The `later` argument is ignored for an exact event on purpose: a measured
 * number is not improved by an approximation of itself, and overwriting one
 * with the other is how a chart ends up mixing the two.
 */
export function compactionView(
  record: Compaction,
  later?: { readonly inputTokens?: number | undefined },
): CompactionView {
  const common = {
    trigger: record.trigger,
    before: record.before,
    droppedSegments: record.droppedSegments,
    demotedToHandles: record.demotedToHandles,
    originalHandle: record.originalHandle,
  };

  if (record.scope === 'DeFlow.packet') {
    return {
      ...common,
      scope: 'DeFlow.packet',
      fidelity: 'exact',
      after: record.after,
      inferred: false,
    };
  }

  const inputTokens = later?.inputTokens;
  return {
    ...common,
    scope: 'vendor.session',
    // Still 'partial'. There is no branch above or below that can change it,
    // because the arm it would have to be written into does not exist.
    fidelity: 'partial',
    after: inputTokens ?? null,
    inferred: inputTokens !== undefined,
  };
}

/** The word the hatched bar carries. One constant, so the view and the test
 * cannot drift into two spellings of it. */
export const INFERRED_LABEL = 'inferred';

/** What a `gap` bar says where a number would have been. */
export const NOT_REPORTED_LABEL = 'not reported';

/** AC5's plain sentence. */
export const VENDOR_UNREPORTED_NOTE =
  'The provider compacted its own session and does not report what it dropped, so DeFlow ' +
  'cannot show a measured after figure for it.';

/** AC5's tooltip for the inferred figure — §6.2's own caveat, verbatim in
 * meaning: the number includes whatever the agent did after compacting. */
export const INFERRED_AFTER_TOOLTIP =
  'Inferred from the next turn’s reported input tokens. It includes whatever the agent did ' +
  'after the compaction, so it is an upper bound rather than a measurement.';

export type CompactionBarStyle = 'solid' | 'hatched' | 'gap';

export interface CompactionBar {
  readonly slot: 'before' | 'after';
  readonly style: CompactionBarStyle;
  /** `null` is a gap. It is never 0 — a zero is a claim nobody made. */
  readonly value: number | null;
  readonly label: string | null;
}

/** One demoted body, paired with the handle that fetches it back. */
export interface DroppedSegmentEntry {
  readonly segment: SegmentId;
  /** `null` only if a producer recorded a segment with no handle — the packet
   * store always records both, in the same order. */
  readonly handle: Handle | null;
}

export interface CompactionChart {
  readonly bars: readonly [CompactionBar, CompactionBar];
  /**
   * What was dropped, ready to be listed and clicked through
   * (EPIC-09-S33, first scenario). Empty for a vendor compaction — and empty
   * because the vendor said nothing, which is why the note beside it exists.
   */
  readonly dropped: readonly DroppedSegmentEntry[];
  /** The plain sentence, or `null` when there is nothing to apologise for. */
  readonly note: string | null;
  readonly tooltip: string | null;
}

/** AC5 — the rendering contract, decided once and rendered by EPIC-17. */
export function compactionChart(view: CompactionView): CompactionChart {
  const before: CompactionBar = {
    slot: 'before',
    style: 'solid',
    value: view.before,
    label: null,
  };

  // Paired by index: `droppedSegments[i]` was demoted to `demotedToHandles[i]`,
  // which is the order `PacketDemotion` records them in. Pairing them here
  // rather than in the view is what stops each consumer inventing its own
  // join and getting it subtly wrong for the one packet with two demotions.
  const dropped: DroppedSegmentEntry[] = view.droppedSegments.map((segment, index) => ({
    segment,
    handle: view.demotedToHandles[index] ?? null,
  }));

  if (view.fidelity === 'exact') {
    return {
      bars: [before, { slot: 'after', style: 'solid', value: view.after, label: null }],
      dropped,
      note: null,
      tooltip: null,
    };
  }

  const after: CompactionBar =
    view.after === null
      ? { slot: 'after', style: 'gap', value: null, label: NOT_REPORTED_LABEL }
      : { slot: 'after', style: 'hatched', value: view.after, label: INFERRED_LABEL };

  return {
    bars: [before, after],
    dropped,
    note: VENDOR_UNREPORTED_NOTE,
    tooltip: view.after === null ? null : INFERRED_AFTER_TOOLTIP,
  };
}

/**
 * The two decoded CLI constants the threshold arithmetic needs.
 *
 * Passed in rather than defined here: they came from **one** shipping bundle
 * (Claude Code 2.1.220), they are private implementation details with no
 * compatibility guarantee, and they belong beside the vendor's invocation in
 * `@DeFlow/adapters`' provider registry — the one file allowed to know which
 * vendor is which. `@DeFlow/core` does the arithmetic and knows no vendor.
 */
export interface AutoCompactConstants {
  /** The largest output reservation the CLI subtracts from the window. */
  readonly outputReserve: number;
  /** How far below the effective window auto-compaction fires. */
  readonly autoCompactOffset: number;
}

/** What the turn reported about its own model — never a table (KAR-09.7 AC2). */
export interface ReportedWindow {
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
}

/** `contextWindow − min(maxOutputTokens, outputReserve)`. */
export function effectiveWindowOf(turn: ReportedWindow, constants: AutoCompactConstants): number {
  return turn.contextWindow - Math.min(turn.maxOutputTokens, constants.outputReserve);
}

/** Where the CLI compacts when nobody overrides it. */
export function defaultAutoCompactThreshold(
  turn: ReportedWindow,
  constants: AutoCompactConstants,
): number {
  return effectiveWindowOf(turn, constants) - constants.autoCompactOffset;
}

/**
 * AC7, and the footgun EPIC-09-S35 exists for: the CLI applies
 * `Math.min(pct × effectiveWindow, defaultThreshold)`, so the override can only
 * ever move compaction **earlier**. A policy designed around extending a
 * session past the vendor's threshold is designed against a lever that does not
 * exist — which is fine, because F6.6 wants compaction earlier anyway.
 */
export function overriddenAutoCompactThreshold(
  pct: number,
  turn: ReportedWindow,
  constants: AutoCompactConstants,
): number {
  // Multiply before dividing: `0.7 * 180_000` is 125_999.999… in binary
  // floating point, and a threshold one token early is a difference nobody can
  // explain from the arithmetic they were shown.
  const requested = Math.floor((pct * effectiveWindowOf(turn, constants)) / 100);
  return Math.min(requested, defaultAutoCompactThreshold(turn, constants));
}

/** §6's default for a node that can write: compact at 70% of the window. */
export const DEFAULT_AUTOCOMPACT_PCT = 70;

/** The lever one node runs with, as the scheduling event records it (AC8). */
export interface CompactionLever {
  /** `null` leaves the vendor's own threshold alone. */
  readonly autocompactPct: number | null;
  readonly autoCompactDisabled: boolean;
}

/**
 * A write-capable node that asked to disable auto-compaction.
 *
 * Refused rather than honoured: AC8 scopes the opt-in to `read` because a
 * `read` node that runs out of context loses an analysis, and a `worktree` or
 * `full` node that runs out of context loses work it has already written to
 * disk. Allowing it everywhere would make "the opt-in is recorded so a hard
 * failure is attributable" an epitaph rather than a diagnostic.
 */
export class AutoCompactDisableRefused extends Error {
  readonly permission: PermissionLevel;

  constructor(permission: PermissionLevel) {
    super(
      `a ${permission} node may not set DISABLE_AUTO_COMPACT: a mid-node context exhaustion ` +
        'on a write-capable node loses work already on disk, so the opt-in is scoped to read ' +
        'nodes (KAR-09.6 AC8)',
    );
    this.name = 'AutoCompactDisableRefused';
    this.permission = permission;
  }
}

export function compactionLever(input: {
  readonly permission: PermissionLevel;
  /** `providers.<id>.autocompactPct`, when the operator set one. */
  readonly autocompactPct?: number | undefined;
  readonly disableAutoCompact?: boolean | undefined;
}): CompactionLever {
  const writeCapable = input.permission !== 'read';
  if (input.disableAutoCompact === true && writeCapable) {
    throw new AutoCompactDisableRefused(input.permission);
  }

  return {
    autocompactPct: input.autocompactPct ?? (writeCapable ? DEFAULT_AUTOCOMPACT_PCT : null),
    autoCompactDisabled: input.disableAutoCompact === true,
  };
}
