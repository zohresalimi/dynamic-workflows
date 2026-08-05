/**
 * KAR-06.6 — the ~1 Hz ticker (docs/05-durable-execution.md §10.1).
 *
 * This is the whole of "the daemon has a loop". It owns no policy — `decide()`
 * is pure and lives in @DeFlow/core — and it owns no waits: every wait in the
 * system, from a 2-second retry backoff to a 30-day human gate, is a
 * `node_wake` row (see @DeFlow/ledger's node-wake.ts). What this file does is
 * arrange to look at the table often enough.
 *
 * **The sleep here is a hint, never the wait.** That distinction is the entire
 * story, and it is load-bearing rather than pedantic:
 *
 *   - **Verified 2026-08-02:** Node's maximum timer delay is `2**31 - 1` ms =
 *     24.9 days. Passing `2**31` does not throw and does not clamp — it fires
 *     the callback after **1 ms**, with only a `TimeoutOverflowWarning` on
 *     stderr. A 30-day gate written as a timer fires instantly and nothing in
 *     the logs says "durability failure". `sleepHint` caps at one second, so no
 *     delay this daemon ever hands a timer can come near that ceiling.
 *   - Timers do not fire during laptop sleep and do not survive a restart.
 *     Being wrong about the hint therefore costs at most one second of latency
 *     and never a missed wake, because what actually fires a wake is
 *     re-querying `wake_at <= now` against the clock on the next tick.
 *
 * The 1 Hz figure is a *ceiling on latency*, not a polling loop to be
 * optimised: a run with nothing due and nothing ready costs one indexed
 * `SELECT` per second, measured at ~0.2 ms in this schema. If that shows up in
 * a profile, the problem is elsewhere.
 *
 * Time arrives through the `Clock` port, so a `TestClock` drives this loop and
 * a six-hour gate is exercised in microseconds (AC2) — with no fake timers, so
 * a child process's real I/O still arrives.
 *
 * Verifies: EPIC-06-S21 (scenario 3), EPIC-06-S22 (scenario 2) ·
 * AC1, AC2, AC6, AC8
 */
import type { Clock, TimerHandle } from '@DeFlow/core';

/**
 * The tick ceiling: the longest this daemon will go without looking at
 * `node_wake`, and therefore the worst-case latency between a wake coming due
 * and the run noticing.
 */
export const TICK_INTERVAL_MS = 1_000;

/**
 * How long to sleep before looking again: `min(nextWakeAt - now, 1000)`,
 * floored at zero.
 *
 * Both bounds matter and both are about a clock that misbehaves (AC8).
 *
 * The cap means a wake 30 days out never becomes a 30-day timer — the row is
 * the wait, this is only how often the row is read. It is also what absorbs a
 * clock that jumped *backwards*: `nextWakeAt - now` then reads as far larger
 * than it is, and sleeping that long would be a daemon that sits through the
 * correction. It sleeps a second instead, and the wake is found by the next
 * `wake_at <= now`.
 *
 * A `nextWakeAt` that is not in the future sleeps a full second rather than
 * zero, which looks backwards and is not: the tick that just ran queried
 * `wake_at <= now` and has already had its chance at that row. If it is still
 * there — a run paused mid-gate, say — then it is a wake nothing is going to
 * consume yet, and a zero-millisecond hint would turn "zero CPU while
 * suspended" into a spin loop. AC2's ceiling is one tick per second, and this
 * is the line that keeps it one.
 */
export function sleepHint(
  now: number,
  nextWakeAt: number | null,
  intervalMs: number = TICK_INTERVAL_MS,
): number {
  if (nextWakeAt === null) return intervalMs;
  const until = nextWakeAt - now;
  return until <= 0 ? intervalMs : Math.min(until, intervalMs);
}

export interface TickerOptions {
  /** Time enters here and nowhere else, so a `TestClock` drives the loop. */
  readonly clock: Clock;
  /**
   * One tick. Called with the clock's instant, which is the same `now` that
   * should reach `decide(state, now)` and the due-row query — reading the clock
   * twice inside one tick is how two answers about the same instant disagree.
   */
  readonly onTick: (now: number) => void | Promise<void>;
  /**
   * The earliest instant anything is waiting for, or `null` when nothing is.
   * Re-read after every tick, because the tick itself is what most often
   * changes the answer.
   */
  readonly nextWakeAt: () => number | null;
  /** Overridable so a spec can tick faster than 1 Hz; production never does. */
  readonly intervalMs?: number;
  /**
   * Where a failed tick goes. A tick that throws is a tick, not the end of the
   * daemon: the loop is what reconciles a run back to a sane state, so
   * stopping on the first error is how a run wedges.
   */
  readonly onError?: (error: unknown) => void;
}

export interface Ticker {
  /** Cancels the pending timer. Idempotent, and permanent. */
  stop(): void;
  /** True until `stop()` is called. */
  readonly running: boolean;
}

/**
 * Starts the loop, **ticking once immediately**.
 *
 * The first tick is not deferred because the instant a daemon finishes booting
 * is exactly when it is most likely to have work: wakes that came due while it
 * was down, effects to reconcile, locks to reclaim. Waiting a second first
 * would mean a restart is always at least a second slower than it needs to be,
 * for no gain.
 */
export function startTicker(options: TickerOptions): Ticker {
  const { clock, onTick, nextWakeAt, intervalMs = TICK_INTERVAL_MS, onError } = options;

  let stopped = false;
  let timer: TimerHandle | null = null;

  const fail = (error: unknown): void => {
    if (onError === undefined) throw error;
    onError(error);
  };

  function schedule(): void {
    if (stopped) return;
    timer = clock.setTimer(sleepHint(clock.now(), nextWakeAt(), intervalMs), tick);
  }

  /**
   * The next tick is scheduled only once this one has settled, so two ticks
   * can never be in flight over the same ledger. A synchronous `onTick`
   * reschedules synchronously — no microtask in between — which is what makes
   * a `TestClock.advance` over six hours deterministic.
   */
  function tick(): void {
    let pending: void | Promise<void>;
    try {
      pending = onTick(clock.now());
    } catch (error) {
      fail(error);
      schedule();
      return;
    }

    if (!isPromise(pending)) {
      schedule();
      return;
    }

    pending.then(
      () => {
        schedule();
      },
      (error: unknown) => {
        fail(error);
        schedule();
      },
    );
  }

  tick();

  return {
    stop(): void {
      stopped = true;
      timer?.cancel();
      timer = null;
    },
    get running(): boolean {
      return !stopped;
    },
  };
}

const isPromise = (value: void | Promise<void>): value is Promise<void> =>
  typeof (value as Promise<void> | undefined)?.then === 'function';
