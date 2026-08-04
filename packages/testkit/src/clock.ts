/**
 * `TestClock` — the `Clock` port, advanced by hand (docs/14-testing-strategy.md §8).
 *
 * Nothing here touches a real timer, which is the whole point: a six-hour human
 * gate is exercised in microseconds, and because no real timer was faked, a
 * child process's real I/O still arrives. `vi.useFakeTimers()` cannot make that
 * trade — it freezes the event loop's timers, so the child's output never
 * reaches the awaiting test and the spec hangs for the full slice timeout.
 */
import type { Clock, TimerHandle } from '@DeFlow/core';

interface ScheduledTimer {
  readonly due: number;
  readonly fn: () => void;
  /** Insertion order, so two timers due at the same instant fire in order. */
  readonly seq: number;
  cancelled: boolean;
}

export class TestClock implements Clock {
  #now: number;
  #seq = 0;
  #timers = new Set<ScheduledTimer>();

  constructor(startMs = 0) {
    this.#now = startMs;
  }

  now(): number {
    return this.#now;
  }

  /** Timers registered and not yet fired or cancelled. */
  get pending(): number {
    return this.#timers.size;
  }

  setTimer(ms: number, fn: () => void): TimerHandle {
    const timer: ScheduledTimer = { due: this.#now + ms, fn, seq: this.#seq++, cancelled: false };
    this.#timers.add(timer);
    return {
      cancel: () => {
        timer.cancelled = true;
        this.#timers.delete(timer);
      },
    };
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted === true) {
        reject(signal.reason ?? new Error('aborted'));
        return;
      }
      const timer = this.setTimer(ms, () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
      function onAbort(this: AbortSignal): void {
        timer.cancel();
        reject(this.reason ?? new Error('aborted'));
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Moves the clock forward, firing every timer that comes due on the way.
   *
   * `now()` sits at each timer's due time while that timer's callback runs, so a
   * timer registered from inside a callback is scheduled relative to when it
   * actually fired — and fires too, if it also comes due inside the window.
   */
  async advance(ms: number): Promise<void> {
    if (ms < 0) throw new Error(`TestClock cannot advance backwards (asked for ${ms}ms)`);
    const target = this.#now + ms;

    for (;;) {
      const next = this.#nextDueBefore(target);
      if (next === undefined) break;
      this.#timers.delete(next);
      this.#now = next.due;
      next.fn();
      // Let anything the callback resolved settle before the next timer fires,
      // so awaiting code observes the clock at each step.
      await Promise.resolve();
    }

    this.#now = target;
    await Promise.resolve();
  }

  #nextDueBefore(target: number): ScheduledTimer | undefined {
    let best: ScheduledTimer | undefined;
    for (const timer of this.#timers) {
      if (timer.cancelled || timer.due > target) continue;
      if (best === undefined || timer.due < best.due || (timer.due === best.due && timer.seq < best.seq)) {
        best = timer;
      }
    }
    return best;
  }
}
