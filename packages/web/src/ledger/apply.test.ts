/**
 * KAR-16.2 test plan #1, #3, #4 and #9 — the dispatcher, at the level the
 * projections see it.
 *
 * Verifies: EPIC-16-S9, EPIC-16-S10, EPIC-16-S11, EPIC-16-S24 · AC5, AC6, AC7,
 * AC8
 *
 * `../api/dispatch.ts` already holds the frame-level half of this: a named
 * frame is control and an unnamed one is a ledger event, and an unknown `kind`
 * advances the cursor without reaching the reducer. What it cannot say is the
 * thing the acceptance criteria actually name — *"every projection is
 * deep-equal to its state before the frame"* — because it has no projections.
 * This module is where they attach, so this is where that assertion belongs.
 *
 * Three properties are asserted here and each fails silently in production:
 *
 * - **Idempotency by `seq`.** A reconnect's backfill and a `subscribe`'s
 *   backfill both overlap what the tab already applied. The overlap is designed
 *   in (docs/11 §5), so a projection set that is not seq-guarded produces a
 *   plausible, wrong picture — a doubled cost total, a node started twice — with
 *   nothing anywhere reporting an error.
 * - **Fan-out by `runId`.** One connection carries every run the tab watches, so
 *   the routing is the only thing keeping `r_b`'s traffic out of `r_a`'s panel.
 * - **Unknown kinds are ignored, exactly as the backend reducer ignores them.**
 *   That is what lets an older UI build run against a newer daemon without
 *   corruption, and the cursor still has to advance past the event or the tab
 *   re-requests it on every reconnect, forever.
 */
import type { Event } from '@DeFlow/core';
import { expect, it, describe as suite, vi } from 'vitest';
import { createDispatcher } from '../api/dispatch.ts';
import { createLedgerApply, type Projection } from './apply.ts';

const RUN_A = 'run_20260810T093000Z_aa0001';
const RUN_B = 'run_20260810T093000Z_bb0002';

const envelope = (
  seq: number,
  runId: string,
  kind: string,
  payload: unknown = { node: 'n-impl-3', attempt: 1, phase: 'running' },
): string => JSON.stringify({ seq, runId, ts: 1_754_140_000_000, kind, v: 1, epoch: 7, payload });

const frame = (seq: number, runId: string, kind = 'node.progress', payload?: unknown) => ({
  id: String(seq),
  data: envelope(seq, runId, kind, payload),
});

/** What a projection looks like from here: state in, event in, nothing out. */
interface Trace {
  readonly seqs: number[];
  readonly phases: string[];
}

const trace: Projection<Trace> = {
  name: 'trace',
  create: () => ({ seqs: [], phases: [] }),
  apply(state, event) {
    state.seqs.push(event.seq);
    if (event.kind === 'node.progress') state.phases.push(event.payload.phase);
  },
};

/** A second one, so "every projection" means more than one. */
const counter: Projection<{ applied: number }> = {
  name: 'counter',
  create: () => ({ applied: 0 }),
  apply(state) {
    state.applied += 1;
  },
};

const parsed = (seq: number, runId: string, kind = 'node.progress'): Event => {
  const applied: Event[] = [];
  const dispatcher = createDispatcher({
    applyEvent: (event) => applied.push(event),
    control: () => {},
  });
  dispatcher.onFrame(frame(seq, runId, kind));
  const event = applied[0];
  if (event === undefined) throw new Error(`the fixture ${kind} did not parse`);
  return event;
};

suite('EPIC-16-S10 — control frames never reach a projection (AC7)', () => {
  it('leaves every projection byte-identical after hello, subscribed, caught_up and fatal', () => {
    const ledgers = createLedgerApply({ projections: [trace, counter] });
    const run = ledgers.watch(RUN_A);
    const dispatcher = createDispatcher({
      applyEvent: (event) => ledgers.apply(event),
      control: () => {},
    });

    dispatcher.onFrame(frame(11, RUN_A));
    const before = JSON.stringify([run.state(trace), run.state(counter)]);

    for (const [name, data] of [
      ['hello', { streamId: 's_1', daemonEpoch: 7, headSeq: 4127 }],
      ['subscribed', { runs: [RUN_A] }],
      ['caught_up', { runId: RUN_A, seq: 4127 }],
      ['fatal', { error: { code: 'internal', message: 'no' } }],
    ] as const) {
      dispatcher.onFrame({ event: name, data: JSON.stringify(data) });
    }

    expect(JSON.stringify([run.state(trace), run.state(counter)])).toBe(before);
    expect(run.appliedSeq()).toBe(11);
  });
});

suite('EPIC-16-S11 — an old tab meets a newer daemon (AC8)', () => {
  it('mutates no projection for a kind this build has never heard of', () => {
    const unknown = vi.fn();
    const ledgers = createLedgerApply({ projections: [trace, counter] });
    const run = ledgers.watch(RUN_A);
    const dispatcher = createDispatcher({
      applyEvent: (event) => ledgers.apply(event),
      control: () => {},
      onUnknownKind: unknown,
    });

    dispatcher.onFrame(frame(9099, RUN_A));
    const before = JSON.stringify([run.state(trace), run.state(counter)]);

    expect(() =>
      dispatcher.onFrame(frame(9100, RUN_A, 'node.telemetry.sampled', { samples: 4 })),
    ).not.toThrow();

    expect(JSON.stringify([run.state(trace), run.state(counter)])).toBe(before);
    expect(unknown).toHaveBeenCalledWith('node.telemetry.sampled', 9100);
    // The cursor advances past it regardless. A client that skipped both would
    // ask for that event again on every reconnect for the life of the run.
    expect(dispatcher.cursor()).toBe(9100);
  });

  it('never throws out of a projection, because one bad event must not kill the tab', () => {
    const exploding: Projection<{ seen: number }> = {
      name: 'exploding',
      create: () => ({ seen: 0 }),
      apply(state, event) {
        state.seen += 1;
        if (event.seq === 3) throw new Error('a projection this build got wrong');
      },
    };
    const failed = vi.fn();
    const ledgers = createLedgerApply({
      projections: [exploding, counter],
      onProjectionError: failed,
    });
    const run = ledgers.watch(RUN_A);

    expect(() => {
      for (const seq of [2, 3, 4]) ledgers.apply(parsed(seq, RUN_A));
    }).not.toThrow();

    // The one that threw is reported, the ones beside it still ran, and the
    // stream carried on: a throw on event 4,000 of a six-hour run must not take
    // out every projection in the tab.
    expect(failed).toHaveBeenCalledTimes(1);
    expect(run.state(counter).applied).toBe(3);
    expect(run.appliedSeq()).toBe(4);
  });
});

suite('EPIC-16-S9 — a gap in seq is a healthy log (AC6)', () => {
  it('applies 4, 5, 7, 8, 12 in order with no error state and no refetch', () => {
    const ledgers = createLedgerApply({ projections: [trace] });
    const run = ledgers.watch(RUN_A);

    for (const seq of [4, 5, 7, 8, 12]) ledgers.apply(parsed(seq, RUN_A));

    expect(run.state(trace).seqs).toEqual([4, 5, 7, 8, 12]);
    expect(run.appliedSeq()).toBe(12);
    // Not "seven events were lost". The only honest count is what arrived.
    expect(run.appliedCount()).toBe(5);
  });
});

suite('EPIC-16-S24 — a backfill that overlaps the cursor (AC2)', () => {
  it('changes nothing when the daemon resends events the tab already applied', () => {
    const ledgers = createLedgerApply({ projections: [trace, counter] });
    const run = ledgers.watch(RUN_A);

    for (const seq of [40, 41, 42, 43]) ledgers.apply(parsed(seq, RUN_A));
    const before = JSON.stringify([run.state(trace), run.state(counter)]);

    // The overlap window: a `subscribe` backfills from the connection's opening
    // cursor, which is behind where this tab has got to.
    for (const seq of [42, 43, 44]) ledgers.apply(parsed(seq, RUN_A));

    expect(run.state(trace).seqs).toEqual([40, 41, 42, 43, 44]);
    expect(run.state(counter).applied).toBe(5);
    expect(JSON.parse(before)).not.toEqual([run.state(trace), run.state(counter)]);
    expect(run.appliedSeq()).toBe(44);
  });

  it('reports whether it applied, so a caller can tell a duplicate from an event', () => {
    const ledgers = createLedgerApply({ projections: [trace] });
    ledgers.watch(RUN_A);

    expect(ledgers.apply(parsed(7, RUN_A))).toBe(true);
    expect(ledgers.apply(parsed(7, RUN_A))).toBe(false);
    expect(ledgers.apply(parsed(6, RUN_A))).toBe(false);
    expect(ledgers.apply(parsed(8, RUN_A))).toBe(true);
  });

  it('keeps one run’s projections untouched by another run’s traffic', () => {
    const ledgers = createLedgerApply({ projections: [trace] });
    const a = ledgers.watch(RUN_A);
    const b = ledgers.watch(RUN_B);

    for (const [seq, runId] of [
      [1, RUN_A],
      [2, RUN_B],
      [3, RUN_A],
      [4, RUN_B],
      [5, RUN_A],
    ] as const) {
      ledgers.apply(parsed(seq, runId));
    }

    expect(a.state(trace).seqs).toEqual([1, 3, 5]);
    expect(b.state(trace).seqs).toEqual([2, 4]);
    // Each run holds its own instance of each projection, never a shared one.
    expect(a.state(trace)).not.toBe(b.state(trace));
  });

  it('drops an event for a run nothing is watching rather than inventing a panel', () => {
    // The server owns the filter, so a panel the operator has just closed keeps
    // delivering until the daemon is told. That must not resurrect it.
    const ledgers = createLedgerApply({ projections: [trace] });
    ledgers.watch(RUN_A);

    expect(ledgers.apply(parsed(9, RUN_B))).toBe(false);
    expect(ledgers.ledger(RUN_B)).toBeUndefined();
  });

  it('forgets a run entirely when its panel closes', () => {
    const ledgers = createLedgerApply({ projections: [trace] });
    ledgers.watch(RUN_A);
    ledgers.apply(parsed(3, RUN_A));

    ledgers.unwatch(RUN_A);
    expect(ledgers.ledger(RUN_A)).toBeUndefined();
    // Re-opening the panel starts a fresh projection set, hydrated from scratch
    // — never a stale one holding half a run.
    expect(ledgers.watch(RUN_A).appliedSeq()).toBe(0);
  });
});

suite('the projection seam KAR-16.3 fills in', () => {
  it('gives every registered projection its own state and every event to all of them', () => {
    const ledgers = createLedgerApply({ projections: [trace, counter] });
    const run = ledgers.watch(RUN_A);

    ledgers.apply(parsed(1, RUN_A));
    ledgers.apply(parsed(2, RUN_A));

    expect(run.state(trace).seqs).toEqual([1, 2]);
    expect(run.state(counter).applied).toBe(2);
    expect(run.projections().map((projection) => projection.name)).toEqual(['trace', 'counter']);
  });

  it('reports each applied event once, for the debug ring KAR-16.4 hangs off it', () => {
    const seen: number[] = [];
    const ledgers = createLedgerApply({
      projections: [trace],
      onApplied: (event) => seen.push(event.seq),
    });
    ledgers.watch(RUN_A);

    ledgers.apply(parsed(1, RUN_A));
    ledgers.apply(parsed(1, RUN_A));
    ledgers.apply(parsed(2, RUN_A));

    expect(seen).toEqual([1, 2]);
  });
});
