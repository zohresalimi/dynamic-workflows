/**
 * KAR-15.3 — the post-commit emitter fires **after** the transaction returns,
 * and exactly once for a batch however deeply the append was nested.
 *
 * Verifies: EPIC-15-S22 (the emitter fires post-commit) · AC14
 *
 * > If the emitter fires inside the transaction, a stream can read a row that
 * > a subsequent rollback removes, and the client's cursor advances past an
 * > event that does not exist. (docs/11-api-and-realtime.md §5.2)
 *
 * The nesting half is this ledger's own doing: `appendEventsConsumingWakes`,
 * `appendEventsSchedulingWakes` and `appendEventsWithProcess` each wrap
 * `appendEvents` in a transaction of their own, so an emitter placed naively
 * inside `appendEvents` would fire while the *outer* transaction is still open
 * — which is the same defect, one level up. `committing` counts the depth and
 * emits only as the outermost one returns.
 *
 * The notification deliberately carries no payload. The reaction to it is
 * "drain from my cursor", so a missed one costs latency and never
 * correctness — which is why a spurious one, the price of a caller wrapping us
 * in a transaction we cannot see, is harmless: the drain finds nothing.
 */
import { FakeDb } from '@DeFlow/testkit';
import { afterEach, expect, it, describe as suite } from 'vitest';
import { committing, onCommitted } from './notify.ts';

const listeners: (() => void)[] = [];
const offs: (() => void)[] = [];

afterEach(() => {
  for (const off of offs.splice(0)) off();
  listeners.splice(0);
});

/** Subscribes for the duration of one test and counts the wake-ups. */
function counting(): () => number {
  let woke = 0;
  offs.push(
    onCommitted(() => {
      woke += 1;
    }),
  );
  return () => woke;
}

suite('committing — the emitter is post-commit (AC14)', () => {
  it('emits after the work has returned, never during it', () => {
    const db = new FakeDb();
    const woke = counting();
    const seen: number[] = [];

    const result = committing(db, () => {
      seen.push(woke());
      return 'done';
    });

    expect(result).toBe('done');
    // Nothing had woken while the transaction was open; one wake-up after.
    expect(seen).toEqual([0]);
    expect(woke()).toBe(1);
  });

  it('emits once for a nested append, as the outermost transaction returns', () => {
    const db = new FakeDb();
    const woke = counting();

    const inner: number[] = [];
    committing(db, () => {
      committing(db, () => {
        inner.push(woke());
      });
      // The inner `committing` returned — and still nothing has been told,
      // because the rows are not committed until this one does.
      inner.push(woke());
    });

    expect(inner).toEqual([0, 0]);
    expect(woke()).toBe(1);
  });

  it('emits nothing at all when the transaction throws', () => {
    const db = new FakeDb();
    const woke = counting();

    expect(() =>
      committing(db, () => {
        throw new Error('the batch was refused');
      }),
    ).toThrow('the batch was refused');

    expect(woke()).toBe(0);
  });

  it('emits nothing when an inner append is undone by an outer throw', () => {
    const db = new FakeDb();
    const woke = counting();

    expect(() =>
      committing(db, () => {
        committing(db, () => 'the rows nobody will ever see');
        throw new Error('rolled back');
      }),
    ).toThrow('rolled back');

    expect(woke()).toBe(0);
  });

  it('leaves the depth clean after a throw, so the next commit still emits', () => {
    const db = new FakeDb();
    const woke = counting();

    expect(() =>
      committing(db, () => {
        throw new Error('boom');
      }),
    ).toThrow();
    committing(db, () => 'the next batch');

    expect(woke()).toBe(1);
  });

  it('unsubscribes, so a closed stream is not woken for the life of the daemon', () => {
    const db = new FakeDb();
    let woke = 0;
    const off = onCommitted(() => {
      woke += 1;
    });
    committing(db, () => 'first');
    off();
    committing(db, () => 'second');

    expect(woke).toBe(1);
  });

  it('survives a listener that throws, because one stream is not the others', () => {
    const db = new FakeDb();
    offs.push(
      onCommitted(() => {
        throw new Error('a closed socket');
      }),
    );
    const woke = counting();

    expect(() => committing(db, () => 'the batch')).not.toThrow();
    expect(woke()).toBe(1);
  });
});
