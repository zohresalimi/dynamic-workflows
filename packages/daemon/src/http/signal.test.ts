/**
 * KAR-15.3 — the park primitive, and the one property that makes the two-phase
 * drain correct.
 *
 * Verifies: EPIC-15-S21 (the race window) · AC14
 *
 * The serving loop is *drain to empty, then park on the post-commit signal*.
 * Between the last drain query and the park there is a window, and an event
 * committing inside it is the event the naive version loses forever: the drain
 * did not see it, and the notification arrived before anything was waiting.
 *
 * So the signal **latches**. A notify with no waiter is remembered, and the
 * next `wait()` returns immediately rather than blocking for a notification
 * that has already been and gone. That single rule is what the concurrency
 * scenario in EPIC-15-S21 is about; everything else in the loop is bookkeeping.
 */
import { expect, it, describe as suite } from 'vitest';
import { Signal } from './signal.ts';

/**
 * Whether `promise` has settled by the time the microtask queue drains.
 *
 * A flag rather than `Promise.race` against a resolved promise: `race` compares
 * *scheduling*, and both candidates would be scheduled, so the answer would be
 * whichever `.then` was registered first rather than whether the signal fired.
 */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  return done;
}

suite('Signal — a notification is never lost (AC14)', () => {
  it('resolves a waiter that was already parked', async () => {
    const signal = new Signal();
    const waiting = signal.wait();
    expect(await settled(waiting)).toBe(false);
    signal.notify();
    await waiting;
  });

  it('remembers a notify that arrived before anyone waited', async () => {
    const signal = new Signal();
    // The race window: the commit lands after the final drain query and before
    // the handler parks.
    signal.notify();
    expect(await settled(signal.wait())).toBe(true);
  });

  it('consumes the latch, so the next wait parks again', async () => {
    const signal = new Signal();
    signal.notify();
    await signal.wait();
    expect(await settled(signal.wait())).toBe(false);
  });

  it('collapses a burst of notifications into one wake-up', async () => {
    const signal = new Signal();
    for (let index = 0; index < 500; index += 1) signal.notify();
    await signal.wait();
    // The reaction to a wake-up is "drain from my cursor", not "here is the
    // payload", so 500 commits are one drain rather than 500 wake-ups.
    expect(await settled(signal.wait())).toBe(false);
  });

  it('wakes every parked waiter, because one connection is not the only one', async () => {
    const signal = new Signal();
    const waiters = [signal.wait(), signal.wait(), signal.wait()];
    signal.notify();
    await Promise.all(waiters);
  });
});
