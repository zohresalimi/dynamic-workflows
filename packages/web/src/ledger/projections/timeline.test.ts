/**
 * KAR-16.3 — `timeline.ts`, the F10.9 projection.
 *
 * Verifies: EPIC-16-S21 · AC9
 */
import { expect, it, describe as suite } from 'vitest';
import { fold, ledger, unknownKind } from '../../../test/run-fixtures.ts';
import { applyTimeline, emptyTimeline, spanKey, type TimelineProjection } from './timeline.ts';

const HAPPY = 'happy-path-12';
const timeline = (): TimelineProjection => fold(HAPPY, emptyTimeline, applyTimeline);

const HOUR = 3_600_000;

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
