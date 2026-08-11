/**
 * KAR-16.4 AC2 — the debug ring is bounded, ordered, and forgets.
 *
 * Verifies: EPIC-16-S25 (scenario 2) · AC1, AC2
 *
 * The ring is the *only* structure in the tab allowed to hold a raw envelope,
 * which is what makes its bound the whole of docs/12-frontend-architecture.md
 * §5.1: *"unbounded retention has no visible symptom until the tab dies at hour
 * four of a real run"*. So the interesting assertions are not "it holds the
 * last N" — they are "it holds **at most** N whatever you do to it" and "the
 * slot it rolled past no longer refers to what was in it".
 *
 * The second one is what `../stores/useRunStore.test.ts` then holds a `WeakRef`
 * over. A ring that kept its overwritten slots alive would pass every ordering
 * assertion in this file and still kill the tab at hour four.
 */
import { expect, it, describe as suite } from 'vitest';
import { createEventRing, DEBUG_RING_CAP } from './ring.ts';

/** A stand-in for an envelope: identity matters, the shape does not. */
const item = (seq: number) => ({ seq });

suite('AC2 — the ring never exceeds its cap', () => {
  it('holds exactly its cap after ten thousand pushes', () => {
    const ring = createEventRing<{ seq: number }>();

    for (let seq = 1; seq <= 10_000; seq += 1) ring.push(item(seq));

    expect(ring.cap).toBe(DEBUG_RING_CAP);
    expect(ring.size).toBe(DEBUG_RING_CAP);
    expect(ring.toArray()).toHaveLength(DEBUG_RING_CAP);
  });

  it('is never over its cap at any point along the way', () => {
    const ring = createEventRing<{ seq: number }>(64);
    let worst = 0;

    for (let seq = 1; seq <= 5_000; seq += 1) {
      ring.push(item(seq));
      worst = Math.max(worst, ring.size);
    }

    expect(worst).toBe(64);
  });

  it('fills before it wraps, so a short run is not padded', () => {
    const ring = createEventRing<{ seq: number }>(8);

    ring.push(item(1));
    ring.push(item(2));

    expect(ring.size).toBe(2);
    expect(ring.toArray().map((one) => one.seq)).toEqual([1, 2]);
  });

  it('refuses a cap that is not a positive integer, rather than silently holding nothing', () => {
    expect(() => createEventRing(0)).toThrow(/cap/i);
    expect(() => createEventRing(-1)).toThrow(/cap/i);
    expect(() => createEventRing(2.5)).toThrow(/cap/i);
  });
});

suite('AC2 — the oldest entry advances monotonically', () => {
  it('reports oldest and newest in push order, before and after the wrap', () => {
    const ring = createEventRing<{ seq: number }>(4);

    for (let seq = 1; seq <= 3; seq += 1) ring.push(item(seq));
    expect(ring.oldest()?.seq).toBe(1);
    expect(ring.newest()?.seq).toBe(3);

    for (let seq = 4; seq <= 9; seq += 1) ring.push(item(seq));
    expect(ring.oldest()?.seq).toBe(6);
    expect(ring.newest()?.seq).toBe(9);
    expect(ring.toArray().map((one) => one.seq)).toEqual([6, 7, 8, 9]);
  });

  it('never lets the oldest seq go backwards over a long run', () => {
    const ring = createEventRing<{ seq: number }>(32);
    let previous = 0;

    for (let seq = 1; seq <= 4_000; seq += 1) {
      ring.push(item(seq));
      const oldest = ring.oldest()?.seq ?? 0;
      expect(oldest).toBeGreaterThanOrEqual(previous);
      previous = oldest;
    }

    expect(previous).toBe(4_000 - 31);
  });

  it('indexes from the oldest, so a debug pane can page it without arithmetic', () => {
    const ring = createEventRing<{ seq: number }>(3);

    for (let seq = 1; seq <= 5; seq += 1) ring.push(item(seq));

    expect(ring.at(0)?.seq).toBe(3);
    expect(ring.at(2)?.seq).toBe(5);
    expect(ring.at(3)).toBeUndefined();
    expect(ring.at(-1)).toBeUndefined();
  });

  it('an empty ring answers with undefined rather than throwing', () => {
    const ring = createEventRing<{ seq: number }>(4);

    expect(ring.size).toBe(0);
    expect(ring.oldest()).toBeUndefined();
    expect(ring.newest()).toBeUndefined();
    expect(ring.toArray()).toEqual([]);
  });
});

suite('AC1 — the slot the ring rolled past holds nothing', () => {
  it('drops its reference to an overwritten entry', () => {
    const ring = createEventRing<{ seq: number }>(2);
    const rolled = item(1);
    const seen = new WeakRef(rolled);

    ring.push(rolled);
    ring.push(item(2));
    ring.push(item(3));

    // The observable half of the retention claim, without a GC: nothing the
    // ring can hand back is the rolled entry any more. `../stores`'s WeakRef
    // test is the other half, and it is the one that fails for a ring that
    // kept a second array "for the inspector".
    expect(ring.toArray()).not.toContain(rolled);
    expect(ring.toArray().map((one) => one.seq)).toEqual([2, 3]);
    expect(seen.deref()).toBe(rolled);
  });

  it('clears every slot, so an unwatched run does not keep two thousand envelopes alive', () => {
    const ring = createEventRing<{ seq: number }>(8);
    for (let seq = 1; seq <= 8; seq += 1) ring.push(item(seq));

    ring.clear();

    expect(ring.size).toBe(0);
    expect(ring.toArray()).toEqual([]);
    expect(ring.oldest()).toBeUndefined();
  });
});
