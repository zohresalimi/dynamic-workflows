/**
 * KAR-06.6 — the ~1 Hz ticker, and the one timer in the system that is allowed
 * to exist (docs/05-durable-execution.md §10.1).
 *
 * Everything here is driven by `TestClock`, which is not a convenience: a
 * six-hour human gate is exercised in microseconds, and because no *real* timer
 * was faked, a child process's real I/O still arrives. `vi.useFakeTimers()`
 * cannot make that trade — it freezes the event loop, so the child's output
 * never reaches the awaiting spec and it hangs for the whole slice timeout.
 *
 * Verifies: EPIC-06-S21 (scenario 3), EPIC-06-S22 (scenario 2) ·
 * AC1, AC2, AC6, AC8
 */
import { TestClock } from '@DeFlow/testkit';
import { expect, it, describe as suite } from 'vitest';
import { sleepHint, startTicker, TICK_INTERVAL_MS } from './ticker.ts';

const NOW = 1_754_308_400_000;

const hours = (count: number): number => count * 3_600_000;
const days = (count: number): number => count * 86_400_000;

/** Node's ceiling: `setTimeout(2**31)` fires after ~1 ms rather than clamping. */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

suite('the sleep hint is a hint, and it is never the wait (AC2)', () => {
  it('sleeps a full second when nothing at all is waiting', () => {
    expect(sleepHint(NOW, null)).toBe(TICK_INTERVAL_MS);
    expect(TICK_INTERVAL_MS).toBe(1_000);
  });

  it('sleeps only until the next wake when that is nearer than a second', () => {
    expect(sleepHint(NOW, NOW + 200)).toBe(200);
    expect(sleepHint(NOW, NOW + 1)).toBe(1);
  });

  it('still sleeps a second when the next wake is 30 days out', () => {
    // The reason this story exists: a 30-day delay handed to setTimeout fires
    // after ~1 ms. The hint is capped, so no timer ever holds the real wait.
    expect(sleepHint(NOW, NOW + days(30))).toBe(TICK_INTERVAL_MS);
    expect(sleepHint(NOW, NOW + days(30))).toBeLessThanOrEqual(MAX_TIMER_DELAY);
  });

  it('sleeps a full second, never less, at the boundary', () => {
    expect(sleepHint(NOW, NOW + TICK_INTERVAL_MS)).toBe(TICK_INTERVAL_MS);
    expect(sleepHint(NOW, NOW + TICK_INTERVAL_MS + 1)).toBe(TICK_INTERVAL_MS);
  });

  it('AC8: a wake already past sleeps a whole second, because the tick that just ran saw it', () => {
    // Never zero, and never negative. The tick at `now` already queried
    // `wake_at <= now`; a row still sitting there is one nothing is ready to
    // consume, and a 0 ms hint would turn "zero CPU while suspended" into a
    // spin loop.
    expect(sleepHint(NOW, NOW)).toBe(TICK_INTERVAL_MS);
    expect(sleepHint(NOW, NOW - hours(1))).toBe(TICK_INTERVAL_MS);
  });

  it('AC8: and a clock that jumped backwards still sleeps at most a second', () => {
    // `now` moved back an hour under a wake that was 200 ms away: the naive
    // `nextWakeAt - now` is an hour, which is a wake this daemon would sit
    // through. The cap is what keeps a corrected clock from being a stall.
    expect(sleepHint(NOW - hours(1), NOW + 200)).toBe(TICK_INTERVAL_MS);
  });
});

suite('the ticker wakes at most once per second (AC2)', () => {
  /** A ticker over a hand-advanced clock, counting the instants it ran at. */
  function ticking(nextWakeAt: () => number | null = () => null) {
    const clock = new TestClock(NOW);
    const ticks: number[] = [];
    const ticker = startTicker({
      clock,
      nextWakeAt,
      onTick: (now) => {
        ticks.push(now);
      },
    });
    return { clock, ticks, ticker };
  }

  it('ticks once at start, so a daemon notices due work without waiting a second', () => {
    const { ticks, ticker } = ticking();
    expect(ticks).toEqual([NOW]);
    ticker.stop();
  });

  it('ticks once a second while nothing is waiting', async () => {
    const { clock, ticks, ticker } = ticking();

    await clock.advance(5_000);

    expect(ticks).toEqual([NOW, NOW + 1_000, NOW + 2_000, NOW + 3_000, NOW + 4_000, NOW + 5_000]);
    ticker.stop();
  });

  it('ticks early when a wake is nearer than a second, and not before it', async () => {
    // A wake 200 ms out, consumed by the tick that finds it — which is what a
    // real tick does, and what keeps the next hint honest.
    let wakeAt: number | null = NOW + 200;
    const clock = new TestClock(NOW);
    const ticks: number[] = [];
    const ticker = startTicker({
      clock,
      nextWakeAt: () => wakeAt,
      onTick: (now) => {
        ticks.push(now);
        if (wakeAt !== null && now >= wakeAt) wakeAt = null;
      },
    });

    await clock.advance(199);
    expect(ticks).toEqual([NOW]);

    await clock.advance(1);
    expect(ticks).toEqual([NOW, NOW + 200]);

    // And having consumed it, the ticker goes back to its one-second ceiling.
    await clock.advance(1_000);
    expect(ticks).toEqual([NOW, NOW + 200, NOW + 1_200]);
    ticker.stop();
  });

  it('holds exactly one pending timer, and none once it is stopped', async () => {
    const { clock, ticker } = ticking();

    expect(clock.pending).toBe(1);
    await clock.advance(3_000);
    expect(clock.pending).toBe(1);

    ticker.stop();
    expect(clock.pending).toBe(0);
  });

  it('stops for good — a stopped ticker never ticks again', async () => {
    const { clock, ticks, ticker } = ticking();
    ticker.stop();

    await clock.advance(10_000);

    expect(ticks).toEqual([NOW]);
  });
});

suite('EPIC-06-S22 scenario 2 — six hours pass in microseconds (AC6)', () => {
  it('fires a six-hour gate with no wall-clock time passing', async () => {
    const clock = new TestClock(NOW);
    const gateAt = NOW + hours(6);
    const fired: number[] = [];

    const ticker = startTicker({
      clock,
      nextWakeAt: () => (fired.length === 0 ? gateAt : null),
      onTick: (now) => {
        if (fired.length === 0 && now >= gateAt) fired.push(now);
      },
    });

    const wallBefore = Date.now();
    await clock.advance(hours(6));
    const wallElapsed = Date.now() - wallBefore;

    // The gate fired exactly once, at the instant on the row …
    expect(fired).toEqual([gateAt]);
    // … the test clock really did move six hours …
    expect(clock.now()).toBe(gateAt);
    // … and the wall clock did not. (Generously bounded: the assertion is
    // "no real waiting happened", not a benchmark.)
    expect(wallElapsed).toBeLessThan(5_000);

    ticker.stop();
  });

  it('does not fire it early, however many ticks pass in between', async () => {
    const clock = new TestClock(NOW);
    const gateAt = NOW + hours(6);
    const fired: number[] = [];
    let ticks = 0;

    const ticker = startTicker({
      clock,
      nextWakeAt: () => gateAt,
      onTick: (now) => {
        ticks += 1;
        if (now >= gateAt) fired.push(now);
      },
    });

    await clock.advance(hours(6) - 1);
    expect(fired).toEqual([]);
    // One tick a second for six hours, plus the one at start.
    expect(ticks).toBe(hours(6) / TICK_INTERVAL_MS);

    ticker.stop();
  });
});

suite('a tick that is asynchronous still never overlaps itself', () => {
  it('schedules nothing at all while a tick is still in flight', async () => {
    const clock = new TestClock(NOW);
    let ticks = 0;
    let release: (() => void) | null = null;

    const ticker = startTicker({
      clock,
      nextWakeAt: () => null,
      onTick: () =>
        new Promise<void>((resolve) => {
          ticks += 1;
          release = resolve;
        }),
    });

    // The first tick is in flight and has not settled: no timer exists, so no
    // amount of time passing can start a second one over the same ledger.
    expect(ticks).toBe(1);
    expect(clock.pending).toBe(0);

    await clock.advance(5_000);
    expect(ticks).toBe(1);

    // Once it settles, the loop resumes — one second later, not five.
    (release as unknown as () => void)();
    await Promise.resolve();
    expect(clock.pending).toBe(1);

    await clock.advance(1_000);
    expect(ticks).toBe(2);

    (release as unknown as () => void)();
    ticker.stop();
  });

  it('keeps ticking after a tick throws, and hands the failure to onError', async () => {
    const clock = new TestClock(NOW);
    const errors: unknown[] = [];
    let ticks = 0;

    const ticker = startTicker({
      clock,
      nextWakeAt: () => null,
      onError: (error) => errors.push(error),
      onTick: () => {
        ticks += 1;
        if (ticks === 1) throw new Error('the ledger was busy');
      },
    });

    await clock.advance(2_000);

    // A tick that fails is a tick, not the end of the daemon: the loop is what
    // reconciles a run back to a sane state, so stopping it on the first error
    // is how a run wedges.
    expect(ticks).toBe(3);
    expect((errors[0] as Error).message).toBe('the ledger was busy');
    ticker.stop();
  });
});
