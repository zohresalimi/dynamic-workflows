/**
 * KAR-16.5 AC4 — the schedule as the *ledger* sees it, on an advanced clock.
 *
 * Verifies: EPIC-16-S33 · AC4
 *
 * `../../src/replay/speed.test.ts` proves the arithmetic; this proves the
 * player applies it — that at `1x` the recorded inter-event delays are what
 * actually separate the commits, and at `20x` they are that divided by twenty.
 *
 * Driven by `TestClock`, so *"a fixture whose recorded events span 40 minutes"*
 * is exercised in milliseconds and the tolerance is **zero**: an assertion about
 * wall-clock timing would need a tolerance and would flake on a loaded laptop,
 * whereas an injected clock makes the schedule exactly checkable. No timer is
 * faked, so the SQLite writes still really happen (docs/14-testing-strategy.md
 * §8).
 *
 * File-backed, never `:memory:` — this is the write path, and the events have to
 * land somewhere the daemon's own read connection could see them.
 */
import type { StoredEvent } from '@DeFlow/ledger';
import { openLedger, readRange } from '@DeFlow/ledger';
import { it, TestClock } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { startPlayer } from '../../src/replay/player.ts';
import { parseSpeed } from '../../src/replay/speed.ts';

const RUN = 'run_20260811T090000Z_a1b2c3';
const T0 = 1_786_438_800_000;
const MINUTE = 60_000;

/** A recording whose events are 0, 10 and 40 minutes in — S33's 40-minute span. */
const RECORDING: readonly StoredEvent[] = [0, 10, 40].map(
  (minutes, index) =>
    ({
      seq: (index + 1) * 3,
      runId: RUN,
      ts: T0 + minutes * MINUTE,
      kind: 'node.progress',
      v: 1,
      epoch: 3,
      payload: { node: 'impl', attempt: 1, phase: 'running', message: `at ${minutes}m` },
    }) as StoredEvent,
);

/**
 * Lets the player's own promises settle after the clock moves.
 *
 * `TestClock.advance` flushes microtasks between timers, and committing a slice
 * is a real `await` into SQLite past that — so without one turn of the macrotask
 * queue the assertion reads the position from *before* the commit it is about.
 * A real `setImmediate` is safe here precisely because no timer is faked: the
 * clock under test is an injected port, not a patched global.
 */
const settle = (): Promise<void> => new Promise((resolve) => void setImmediate(resolve));

const committed = (dir: string): number[] => {
  const db = openLedger(dir);
  try {
    return readRange(db, RUN, 0, 100).events.map((event) => event.seq);
  } finally {
    db.close();
  }
};

suite('EPIC-16-S33 — the recorded delays are what separate the commits', () => {
  it('reproduces them exactly at 1x', async ({ tmp, clock }) => {
    const db = openLedger(tmp);
    try {
      const player = startPlayer({
        db,
        events: RECORDING,
        speed: parseSpeed('1x'),
        clock,
      });

      // The first event is due at once; the others are ten and forty recorded
      // minutes away and must not arrive early.
      await clock.advance(0);
      await settle();
      expect(player.position()).toBe(3);

      await clock.advance(10 * MINUTE - 1);
      await settle();
      expect(player.position(), 'the 10-minute event arrived a millisecond early').toBe(3);

      await clock.advance(1);
      await settle();
      expect(player.position()).toBe(6);

      await clock.advance(30 * MINUTE);
      await settle();
      expect(player.position()).toBe(9);
      await player.played();
    } finally {
      db.close();
    }

    expect(committed(tmp)).toEqual([3, 6, 9]);
  });

  it('divides the whole timeline by 20 at 20x', async ({ tmp }) => {
    const clock = new TestClock(T0);
    const db = openLedger(tmp);
    try {
      const player = startPlayer({
        db,
        events: RECORDING,
        speed: parseSpeed('20x'),
        clock,
      });

      await clock.advance(0);
      // Forty recorded minutes is two played minutes; ten is thirty seconds.
      await clock.advance(30_000 - 1);
      await settle();
      expect(player.position()).toBe(3);

      await clock.advance(1);
      await settle();
      expect(player.position()).toBe(6);

      await clock.advance(90_000);
      await settle();
      expect(player.position()).toBe(9);
      await player.played();
    } finally {
      db.close();
    }
  });

  it('emits everything without a single wait at max', async ({ tmp, clock }) => {
    const db = openLedger(tmp);
    try {
      const player = startPlayer({ db, events: RECORDING, speed: parseSpeed('max'), clock });
      // No advance at all: `max` is the *absence* of a schedule, so a fixture
      // that needed the clock moved would be a fixture the six-hour soak and
      // the 400-node measurement could not use.
      await player.played();

      expect(player.position()).toBe(9);
      expect(clock.pending, 'max scheduled a timer').toBe(0);
    } finally {
      db.close();
    }

    expect(committed(tmp)).toEqual([3, 6, 9]);
  });

  it('holds the schedule across a pause rather than skipping it', async ({ tmp, clock }) => {
    const db = openLedger(tmp);
    try {
      const player = startPlayer({ db, events: RECORDING, speed: parseSpeed('1x'), clock });
      await clock.advance(0);
      await settle();
      expect(player.position()).toBe(3);

      player.pause();
      await clock.advance(60 * MINUTE);
      await settle();
      // An hour passed and nothing was emitted: paused means paused, and the
      // events that came due are *held*, not queued up to fire on resume.
      expect(player.position()).toBe(3);

      player.resume();
      await clock.advance(0);
      await settle();
      expect(player.position(), 'resuming fired the events the pause held').toBe(3);

      // The remaining timeline moved with the pause: the 10-minute event is
      // still ten minutes away from the moment playback resumed.
      await clock.advance(10 * MINUTE);
      await settle();
      expect(player.position()).toBe(6);
      await player.stop();
    } finally {
      db.close();
    }
  });
});
