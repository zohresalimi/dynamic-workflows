/**
 * KAR-16.3 — `timeline.ts`, the F10.9 projection.
 * KAR-17.8 — the three markers and the per-attempt money the Gantt overlays.
 *
 * Verifies: EPIC-16-S21, EPIC-17-S30, EPIC-17-S31 · AC9 (KAR-16.3);
 * AC1, AC3, AC4, AC5, AC6, AC7 (KAR-17.8)
 *
 * KAR-17.8's test plan rows 1, 2 and 3 are here rather than beside the chart,
 * because the span builder, the lane assignment and the cost series *are* this
 * module — the chart next door turns them into coordinates and owns no data of
 * its own.
 */
import type { Event } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { fold, ledger, unknownKind } from '../../../test/run-fixtures.ts';
import { applyTimeline, emptyTimeline, spanKey, type TimelineProjection } from './timeline.ts';

const HAPPY = 'happy-path-12';
const timeline = (): TimelineProjection => fold(HAPPY, emptyTimeline, applyTimeline);

/** Folds only the events up to and including `seq`, the way a live tab sees them. */
function upTo(seq: number): TimelineProjection {
  const state = emptyTimeline();
  for (const event of ledger(HAPPY)) {
    if (event.seq > seq) break;
    applyTimeline(state, event);
  }
  return state;
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

suite('EPIC-16-S21 — spans from start/terminal pairs', () => {
  it('yields one span per attempt, with a start, an end and a lane', () => {
    const span = timeline().spans.get(spanKey('recon-auth-surface', 0));

    expect(span?.startTs).toBeGreaterThan(0);
    expect(span?.endTs).toBeGreaterThan(span?.startTs ?? 0);
    expect(span?.outcome).toBe('passed');
    expect(typeof span?.lane).toBe('number');
  });

  it('gives parallel nodes distinct lanes, so overlap is visible', () => {
    const state = timeline();
    const lanes = [...state.spans.values()].map((span) => `${span.nodeId}:${span.lane}`);
    const byNode = new Map(lanes.map((entry) => entry.split(':') as [string, string]));

    // One lane per node, and no two nodes share one.
    expect(new Set(byNode.values()).size).toBe(byNode.size);
  });

  it('orders spans by seq and never by ts', () => {
    const state = timeline();
    const seqs = [...state.spans.values()].map((span) => span.startSeq);

    // `ts` is informational: a laptop sleep or an NTP correction moves it
    // backwards (docs/04 §9). Every ordering decision here is on `seq`.
    expect(seqs).toEqual([...seqs].toSorted((left, right) => left - right));
  });
});

suite('EPIC-16-S21 — a node still running (AC9)', () => {
  it('leaves the span open-ended, inventing no end time', () => {
    const span = timeline().spans.get(spanKey('impl-signup', 0));

    expect(span?.open).toBe(true);
    expect(span?.endTs).toBeNull();
    expect(span?.endSeq).toBeNull();
    expect(span?.outcome).toBeNull();
  });

  it('does not fall back to the last event’s ts, which is the plausible mistake', () => {
    const state = timeline();
    const last = ledger(HAPPY).at(-1);
    const span = state.spans.get(spanKey('impl-signup', 0));

    expect(span?.endTs).not.toBe(last?.ts);
  });
});

suite('EPIC-16-S21 — a node suspended for six hours on a human gate (AC9)', () => {
  it('records the suspension as a distinct segment of the span', () => {
    const span = timeline().spans.get(spanKey('review-security', 0));
    const [suspension] = span?.suspensions ?? [];

    expect(suspension?.kind).toBe('human');
    expect(suspension?.untilTs).not.toBeNull();
    expect((suspension?.untilTs ?? 0) - (suspension?.fromTs ?? 0)).toBe(6 * HOUR);
  });

  it('keeps idle time out of busy time, because they cost very different things', () => {
    const span = timeline().spans.get(spanKey('review-security', 0));

    expect(span?.suspendedMs).toBe(6 * HOUR);
  });

  it('leaves a suspension nothing has answered open, rather than closing it at now', () => {
    const state = timeline();
    const waiting = state.suspensions.find((one) => one.nodeId === 'approve-release');

    expect(waiting?.untilTs).toBeNull();
    expect(waiting?.untilSeq).toBeNull();
  });

  it('gives a node that only ever waited no execution span at all', () => {
    // `approve-release` was scheduled and suspended and never started. A span
    // for it would have to invent a start, and six idle hours drawn as six busy
    // ones is the misreading the Gantt exists to prevent.
    expect(timeline().spans.has(spanKey('approve-release', 0))).toBe(false);
  });
});

suite('EPIC-16-S21 — retries', () => {
  it('yields two spans keyed by (nodeId, attempt), never one merged span', () => {
    const state = timeline();

    expect(state.spans.get(spanKey('impl-logout', 0))?.outcome).toBe('failed');
    expect(state.spans.get(spanKey('impl-logout', 1))?.outcome).toBe('passed');
  });

  it('puts both attempts of one node in the same lane, because it is one node', () => {
    const state = timeline();

    expect(state.spans.get(spanKey('impl-logout', 0))?.lane).toBe(
      state.spans.get(spanKey('impl-logout', 1))?.lane,
    );
  });
});

suite('EPIC-16-S21 — the cost series', () => {
  it('accumulates budget.consumed into a cumulative series the second axis renders', () => {
    const series = timeline().costSeries;

    expect(series.length).toBeGreaterThan(1);
    expect(series.map((point) => point.seq)).toEqual(
      series.map((point) => point.seq).toSorted((left, right) => left - right),
    );
    // Cumulative, and still separated by source: the second axis of a Gantt is
    // no place to start mixing billing truth with an estimate.
    expect(series.at(-1)?.vendorReported).toBeCloseTo(0.209, 6);
    expect(series.at(-1)?.estimated).toBeCloseTo(0.081, 6);
  });

  it('never decreases', () => {
    const series = timeline().costSeries;
    const totals = series.map((point) => point.vendorReported ?? 0);

    expect(totals).toEqual([...totals].toSorted((left, right) => left - right));
  });
});

// ── KAR-17.8 ─────────────────────────────────────────────────────────────────

suite('KAR-17.8 row 1 — the span builder keeps the open span open', () => {
  it('gives the running node a span with no end at all', () => {
    const span = timeline().spans.get(spanKey('impl-signup', 0));

    expect(span?.open).toBe(true);
    expect(span?.endTs).toBeNull();
    expect(span?.endSeq).toBeNull();
    // The plausible invention this module has to refuse: the last event's `ts`,
    // which looks like a measurement of when the node stopped and is not one.
    // (`now` is the other, and there is no clock read anywhere in this file —
    // the lint rule that forbids one is what makes that checkable.)
    expect(span?.endTs).not.toBe(ledger(HAPPY).at(-1)?.ts);
  });

  it('separates the six idle hours of a human gate from the busy time around them', () => {
    const span = timeline().spans.get(spanKey('review-security', 0));

    expect(span?.suspendedMs).toBe(6 * HOUR);
    expect(span?.suspensions).toHaveLength(1);
    expect(span?.suspensions[0]?.kind).toBe('human');
  });
});

suite('KAR-17.8 row 2 — lanes are stable across re-renders', () => {
  it('never reshuffles a lane a node already holds when a new node starts', () => {
    // A tab renders at every seq it applies, so "stable" means: the lane a node
    // held at seq n is the lane it holds at seq n+k, for every k. A lane
    // assigned by sorting a growing array satisfies neither.
    const held = new Map<string, number>();

    const state = emptyTimeline();
    for (const event of ledger(HAPPY)) {
      applyTimeline(state, event);
      for (const span of state.spans.values()) {
        const previous = held.get(span.nodeId);
        if (previous !== undefined) expect(span.lane).toBe(previous);
        held.set(span.nodeId, span.lane);
      }
    }

    expect(held.size).toBeGreaterThan(3);
  });

  it('keeps the lane list a prefix of itself as more of the ledger arrives', () => {
    const early = upTo(30).lanes;
    const late = timeline().lanes;

    expect(late.slice(0, early.length)).toEqual(early);
  });
});

suite('KAR-17.8 row 3 — the cumulative cost series', () => {
  it('is monotonic per source and matches the sum of every budget.consumed', () => {
    const series = timeline().costSeries;

    const summed = { vendorReported: 0, estimated: 0 };
    for (const event of ledger(HAPPY)) {
      if (event.kind !== 'budget.consumed') continue;
      const cost = event.payload.costUsd;
      if (cost === null) continue;
      const key = event.payload.usage.source === 'vendor-reported' ? 'vendorReported' : 'estimated';
      summed[key] += cost;
    }

    expect(series.at(-1)?.vendorReported).toBeCloseTo(summed.vendorReported, 6);
    expect(series.at(-1)?.estimated).toBeCloseTo(summed.estimated, 6);
  });

  it('does not reset when a node is retried', () => {
    // `impl-logout` fails at seq 27 and passes at seq 30. A series rebuilt per
    // attempt drops back to the retry's own spend at that point.
    const series = timeline().costSeries;
    const vendor = series.map((point) => point.vendorReported ?? 0);

    expect(vendor).toEqual([...vendor].toSorted((left, right) => left - right));
    expect(vendor.at(-1)).toBeGreaterThan(vendor[0] ?? 0);
  });

  it('charges an attempt only the budget.consumed that named it', () => {
    // AC9's table has a cost column per `(nodeId, attempt)`, and the plausible
    // wrong answer is a per-node total shared out across its attempts: it
    // reports two equal figures for two attempts that spent different amounts,
    // which is worse than no figure because it looks like a measurement.
    const state = timeline();

    expect(state.spans.get(spanKey('recon-auth-surface', 0))?.costUsd.vendorReported).toBeCloseTo(
      0.062,
      6,
    );
    // `impl-logout` failed, was retried and passed, and no `budget.consumed`
    // ever named either attempt — the completion result carries usage, and a
    // result is not a spend event. Both cells stay blank rather than inheriting
    // a slice of the run's total.
    expect(state.spans.get(spanKey('impl-logout', 0))?.costUsd.vendorReported).toBeNull();
    expect(state.spans.get(spanKey('impl-logout', 1))?.costUsd.vendorReported).toBeNull();
  });

  it('names a provider that priced nothing rather than charging the attempt zero', () => {
    // `gemini-cli` reports usage and no `costUsd` at all on seq 43. A `0` there
    // is a claim that nothing was spent, and it is false (docs/08 §7).
    const span = timeline().spans.get(spanKey('impl-signup', 0));

    expect(span?.costUsd.estimated).toBeNull();
    expect(span?.costUsd.unaccounted).toEqual(['gemini-cli']);
    expect(span?.costUsd.vendorReported).toBeCloseTo(0.147, 6);
  });
});

suite('KAR-17.8 — the three markers the timeline overlays (AC5, AC6, AC7)', () => {
  it('records budget.exceeded as the point the run PAUSED', () => {
    const [pause, ...rest] = timeline().pauses;

    expect(rest).toEqual([]);
    expect(pause?.seq).toBe(76);
    expect(pause?.scope).toBe('run');
    expect(pause?.dimension).toBe('cost');
    expect(pause?.limit).toBe(25);
    expect(pause?.actual).toBeCloseTo(25.4, 6);
    // The x position is wall clock, so the marker has to carry its own `ts`:
    // a marker placed at the cost series' last point would sit wherever the
    // last spend happened to land instead of where the ceiling tripped.
    expect(pause?.ts).toBe(ledger(HAPPY).find((event) => event.seq === 76)?.ts);
  });

  it('records provider.rate_limited with the reset the vendor named', () => {
    const [limit, ...rest] = timeline().rateLimits;

    expect(rest).toEqual([]);
    expect(limit?.seq).toBe(44);
    expect(limit?.provider).toBe('claude-code');
    expect(limit?.resetsAt).not.toBeNull();
    expect((limit?.resetsAt ?? 0) - (limit?.ts ?? 0)).toBeGreaterThan(0);
  });

  it('records run.stalled with its idle time and the nodes that were running', () => {
    const [stall, ...rest] = timeline().stalls;

    expect(rest).toEqual([]);
    expect(stall?.seq).toBe(45);
    expect(stall?.idleMs).toBe(10 * MINUTE);
    expect(stall?.watermarkSeq).toBe(41);
    expect(stall?.runningNodes).toEqual(['impl-signup']);
  });

  it('keeps every marker in seq order, however its ts landed', () => {
    const state = timeline();
    const seqs = [...state.pauses, ...state.rateLimits, ...state.stalls].map((mark) => mark.seq);

    expect(seqs).toEqual([...new Set(seqs)]);
  });

  it('folds a marker exactly once, however many times the event is replayed', () => {
    const state = timeline();
    const exceeded = ledger(HAPPY).find((event) => event.seq === 76) as Event;

    applyTimeline(state, exceeded);

    expect(state.pauses).toHaveLength(1);
  });
});

suite('AC11 — an unknown kind is ignored, without throwing and without mutating', () => {
  it('leaves the projection byte-identical', () => {
    const state = timeline();
    const before = structuredClone(state);

    expect(() => {
      applyTimeline(state, unknownKind(9_100, ledger(HAPPY)[0]?.runId ?? ''));
    }).not.toThrow();

    expect({ ...state, appliedSeq: before.appliedSeq }).toEqual(before);
  });
});
