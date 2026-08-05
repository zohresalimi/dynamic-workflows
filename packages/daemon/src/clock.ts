/**
 * `systemClock` — the `Clock` port over the real one (docs/14-testing-strategy.md §8).
 *
 * The port exists so that engine code never reaches for `Date.now()` or
 * `setTimeout` directly (NF9), which is what lets a six-hour human gate be
 * exercised in microseconds by `TestClock` while a real child process's I/O
 * still arrives. This file is the other half of that arrangement, and it is
 * deliberately the only place in the daemon that names either global.
 *
 * `unref()` on the timer: a pending timer must not be the reason DeFlowd stays
 * alive. Everything scheduled through this clock is a grace window or an
 * escalation, and a process kept running by one of those is a process that
 * cannot shut down cleanly.
 */
import type { Clock, TimerHandle } from '@DeFlow/core';

export const systemClock: Clock = {
  now: () => Date.now(),

  setTimer(ms: number, fn: () => void): TimerHandle {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return {
      cancel: () => {
        clearTimeout(timer);
      },
    };
  },

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
  },
};
