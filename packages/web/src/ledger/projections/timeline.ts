/**
 * KAR-16.3 — `timeline.ts`: execution spans for the Gantt, plus the cost series
 * (F10.9).
 *
 * Verifies: EPIC-16-S21, EPIC-16-S23 · AC9, AC10, AC11
 *
 * ## Nothing here invents an end time
 *
 * A node that started and has not finished has an **open** span: `endTs` is
 * `null`, and it is neither `now` nor the last event's `ts`. Both of those look
 * like measurements and are not one, and the Gantt has a rendering for an open
 * span — an unterminated bar — that it does not have for a lie.
 *
 * The same rule applies to a suspension that nothing has answered yet, and to
 * `suspendedMs`, which is `null` rather than a duration counted up to the
 * present.
 *
 * ## `seq` orders; `ts` positions
 *
 * The Gantt's x-axis is wall clock and therefore uses `ts`. Every *ordering*
 * decision — which span opened first, which lane a node gets, which event
 * closes a suspension — is on `seq`, because `ts` is informational only and a
 * laptop sleep or an NTP correction moves it backwards (docs/04 §9).
 *
 * ## One span per (nodeId, attempt)
 *
 * A node that failed and was retried is two spans in one lane, not one merged
 * bar. Merging them would hide the retry, which is the single most useful thing
 * the Gantt has to say about a flaky node — and the gap between them is where
 * the backoff lives.
 */
import type { Event } from '@DeFlow/core';
import { type Ignorable, ignored } from './kinds.ts';

export type SpanOutcome = 'passed' | 'failed' | 'cancelled';

export interface SuspensionVM {
  readonly nodeId: string;
  readonly attempt: number;
  readonly kind: string;
  readonly fromSeq: number;
  readonly fromTs: number;
  /** `null` while nothing has answered it. Never `now`. */
  untilSeq: number | null;
  untilTs: number | null;
}

export interface SpanVM {
  readonly nodeId: string;
  readonly attempt: number;
  readonly lane: number;
  readonly startSeq: number;
  readonly startTs: number;
  endSeq: number | null;
  endTs: number | null;
  /** `true` while the attempt has no terminal event. */
  open: boolean;
  outcome: SpanOutcome | null;
  suspensions: SuspensionVM[];
  /** Idle time inside this span, or `null` while a suspension is unanswered. */
  suspendedMs: number | null;
}

export interface CostPointVM {
  readonly seq: number;
  readonly ts: number;
  /** Cumulative, per source. Never one mixed number — see `./cost.ts`. */
  readonly vendorReported: number | null;
  readonly estimated: number | null;
}

export interface TimelineProjection {
  appliedSeq: number;
  /** `${nodeId}#${attempt}` → its span. */
  spans: Map<string, SpanVM>;
  /** One lane per node, in first-start order. */
  lanes: string[];
  /** Every suspension, including those on nodes that never executed. */
  suspensions: SuspensionVM[];
  costSeries: CostPointVM[];
}

export function emptyTimeline(): TimelineProjection {
  return { appliedSeq: 0, spans: new Map(), lanes: [], suspensions: [], costSeries: [] };
}

export const spanKey = (nodeId: string, attempt: number): string => `${nodeId}#${attempt}`;

export function applyTimeline(state: TimelineProjection, event: Event): void {
  if (event.seq <= state.appliedSeq) return;
  state.appliedSeq = event.seq;

  switch (event.kind) {
    case 'node.started': {
      const key = spanKey(event.payload.node, event.payload.attempt);
      if (state.spans.has(key)) return;
      // A start closes whatever this node was waiting for: a resumed attempt is
      // the answer to the suspension, whether or not a `human.responded`
      // preceded it.
      close(state, event.payload.node, event.seq, event.ts);
      state.spans.set(key, {
        nodeId: event.payload.node,
        attempt: event.payload.attempt,
        lane: lane(state, event.payload.node),
        startSeq: event.seq,
        startTs: event.ts,
        endSeq: null,
        endTs: null,
        open: true,
        outcome: null,
        suspensions: [],
        suspendedMs: null,
      });
      return;
    }

    case 'node.completed':
      terminate(state, event.payload.node, event.payload.attempt, event.seq, event.ts, 'passed');
      return;

    case 'node.failed':
      terminate(state, event.payload.node, event.payload.attempt, event.seq, event.ts, 'failed');
      return;

    case 'node.cancelled':
      terminate(state, event.payload.node, event.payload.attempt, event.seq, event.ts, 'cancelled');
      return;

    case 'node.suspended': {
      const open = newestOpenSpan(state, event.payload.node);
      const suspension: SuspensionVM = {
        nodeId: event.payload.node,
        attempt: open?.attempt ?? event.attempt ?? 0,
        kind: event.payload.until.kind,
        fromSeq: event.seq,
        fromTs: event.ts,
        untilSeq: null,
        untilTs: null,
      };
      state.suspensions.push(suspension);
      // Attached to a span only where one exists. A node that was scheduled and
      // suspended and never started has waited without executing, and a span
      // for it would have to invent a start.
      open?.suspensions.push(suspension);
      return;
    }

    case 'human.responded':
      close(state, event.payload.node, event.seq, event.ts);
      return;

    case 'budget.consumed': {
      const previous = state.costSeries.at(-1);
      const key = event.payload.usage.source === 'vendor-reported' ? 'vendorReported' : 'estimated';
      const point = {
        seq: event.seq,
        ts: event.ts,
        vendorReported: previous?.vendorReported ?? null,
        estimated: previous?.estimated ?? null,
      };
      // A turn nobody could price adds a point and no money: the series still
      // has to move in time, and `null` is what the chart draws as a gap.
      if (event.payload.costUsd !== null) {
        point[key] = addMoney(point[key], event.payload.costUsd);
      }
      state.costSeries.push(point);
      return;
    }

    default:
      ignored<'timeline'>(event as Ignorable<'timeline'>);
      return;
  }
}

/** The lane `nodeId` renders in — one per node, assigned on first start. */
function lane(state: TimelineProjection, nodeId: string): number {
  const held = state.lanes.indexOf(nodeId);
  if (held !== -1) return held;
  state.lanes.push(nodeId);
  return state.lanes.length - 1;
}

function newestOpenSpan(state: TimelineProjection, nodeId: string): SpanVM | undefined {
  let newest: SpanVM | undefined;
  for (const span of state.spans.values()) {
    if (span.nodeId !== nodeId || !span.open) continue;
    if (newest === undefined || span.startSeq > newest.startSeq) newest = span;
  }
  return newest;
}

function terminate(
  state: TimelineProjection,
  nodeId: string,
  attempt: number,
  seq: number,
  ts: number,
  outcome: SpanOutcome,
): void {
  close(state, nodeId, seq, ts);
  const span = state.spans.get(spanKey(nodeId, attempt));
  // A terminal event for an attempt whose start this tab never saw is dropped
  // rather than turned into a zero-length span at the terminal's own `ts`. The
  // hydrate path exists so that does not happen; faking a bar would hide it.
  if (span === undefined) return;
  span.endSeq = seq;
  span.endTs = ts;
  span.open = false;
  span.outcome = outcome;
  span.suspendedMs = idleMs(span);
}

/** Closes every open suspension of `nodeId`. Idempotent by construction. */
function close(state: TimelineProjection, nodeId: string, seq: number, ts: number): void {
  for (const suspension of state.suspensions) {
    if (suspension.nodeId !== nodeId || suspension.untilSeq !== null) continue;
    if (suspension.fromSeq >= seq) continue;
    suspension.untilSeq = seq;
    suspension.untilTs = ts;
  }
  const span = newestOpenSpan(state, nodeId);
  if (span !== undefined) span.suspendedMs = idleMs(span);
}

/** `null` while any suspension in the span is still unanswered. */
function idleMs(span: SpanVM): number | null {
  if (span.suspensions.length === 0) return 0;
  let total = 0;
  for (const suspension of span.suspensions) {
    if (suspension.untilTs === null) return null;
    total += suspension.untilTs - suspension.fromTs;
  }
  return total;
}

const addMoney = (held: number | null, next: number): number =>
  Math.round(((held ?? 0) + next) * 1_000_000) / 1_000_000;
