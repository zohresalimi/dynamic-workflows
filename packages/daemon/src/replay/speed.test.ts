/**
 * KAR-16.5 test plan #2 — the speed scheduler.
 *
 * Verifies: EPIC-16-S33 · AC4
 *
 * *"Red when `--speed` is ignored or applied per-frame incorrectly."* The
 * per-frame failure is the interesting one and it is why the schedule is
 * computed from **offsets against the first recorded event** rather than from
 * each gap in turn: dividing gap-by-gap accumulates rounding, so a 40-minute
 * fixture at 20x drifts seconds away from two minutes by the end while every
 * individual gap looks right. The schedule is a pure function of the recorded
 * timestamps, which is what lets this be asserted without a clock at all.
 *
 * `max` is not "a very large number": it is *no schedule*, which is a different
 * thing. A large divisor still walks the timeline and still pays a timer per
 * event; `max` emits as fast as the socket drains, and the six-hour soak in
 * EPIC-16-S27 and the graph measurement in EPIC-16-S36 are only practical
 * because of it.
 */
import { expect, it, describe as suite } from 'vitest';
import { BadSpeed, emissionOffsets, parseSpeed, SPEEDS } from './speed.ts';

const T0 = 1_786_438_800_000;

/** Recorded timestamps, as a fixture's envelopes carry them. */
const at = (...offsets: number[]): { ts: number }[] => offsets.map((ms) => ({ ts: T0 + ms }));

suite('--speed, as the flag accepts it (AC4)', () => {
  it('accepts the four the acceptance criteria name', () => {
    expect(parseSpeed('1x')).toEqual({ kind: 'rate', factor: 1 });
    expect(parseSpeed('20x')).toEqual({ kind: 'rate', factor: 20 });
    expect(parseSpeed('50x')).toEqual({ kind: 'rate', factor: 50 });
    expect(parseSpeed('max')).toEqual({ kind: 'max' });
    expect(SPEEDS).toEqual(['1x', '20x', '50x', 'max']);
  });

  it('accepts a bare number and a fractional rate, for slowing a run down', () => {
    expect(parseSpeed('2')).toEqual({ kind: 'rate', factor: 2 });
    expect(parseSpeed('0.5x')).toEqual({ kind: 'rate', factor: 0.5 });
  });

  it('refuses anything else rather than defaulting to a speed nobody asked for', () => {
    // A silent fallback to 1x is how a `--speed 20` typo becomes "the harness
    // hangs", forty minutes at a time.
    expect(() => parseSpeed('fast')).toThrow(BadSpeed);
    expect(() => parseSpeed('0x')).toThrow(BadSpeed);
    expect(() => parseSpeed('-2x')).toThrow(BadSpeed);
    expect(() => parseSpeed('')).toThrow(BadSpeed);
  });
});

suite('the emission schedule is offsets from the first event, never gap-by-gap', () => {
  it('reproduces the recorded delays at 1x', () => {
    expect(emissionOffsets(at(0, 500, 1_500, 41_000), { kind: 'rate', factor: 1 })).toEqual([
      0, 500, 1_500, 41_000,
    ]);
  });

  it('divides the whole timeline by 20 — a 40-minute run becomes two minutes', () => {
    const forty = 40 * 60_000;
    const offsets = emissionOffsets(at(0, forty / 2, forty), { kind: 'rate', factor: 20 });

    expect(offsets).toEqual([0, 60_000, 120_000]);
  });

  it('divides by 50', () => {
    expect(emissionOffsets(at(0, 5_000, 50_000), { kind: 'rate', factor: 50 })).toEqual([
      0, 100, 1_000,
    ]);
  });

  it('does not accumulate rounding across ten thousand events', () => {
    // Each gap is 3 ms, which at 20x is 0.15 ms — a value that rounds to 0 (or
    // to 1) per frame. Summed gap-by-gap, ten thousand of them land anywhere
    // between 0 and 10 seconds away from the truth. From offsets, the last
    // frame is exactly where the recording says it is.
    const events = at(...Array.from({ length: 10_000 }, (_, index) => index * 3));
    const offsets = emissionOffsets(events, { kind: 'rate', factor: 20 });

    expect(offsets.at(-1)).toBeCloseTo((9_999 * 3) / 20, 6);
    expect(offsets[0]).toBe(0);
  });

  it('yields zero delay for every event at max', () => {
    const offsets = emissionOffsets(at(0, 500, 41_000), { kind: 'max' });
    expect(offsets).toEqual([0, 0, 0]);
  });

  it('never goes backwards, even when a recorder wrote two events out of ts order', () => {
    // `seq` is the order, `ts` is a measurement — an event committed later can
    // carry an earlier timestamp when a batch was assembled out of order. The
    // schedule is monotonic regardless, because a negative delay would emit the
    // ledger's own order backwards.
    expect(emissionOffsets(at(0, 900, 400, 1_000), { kind: 'rate', factor: 1 })).toEqual([
      0, 900, 900, 1_000,
    ]);
  });

  it('has nothing to schedule for an empty timeline', () => {
    expect(emissionOffsets([], { kind: 'max' })).toEqual([]);
  });
});
