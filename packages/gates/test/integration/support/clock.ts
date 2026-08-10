/**
 * A real `Clock` for the gate specs that want real elapsed time.
 *
 * `TestClock` is the right port implementation for the timeout spec — a five
 * second gate timeout is released by hand rather than waited for — but it is
 * the wrong one for `durationMs`: a clock that never advances reports a gate
 * that took no time, and an assertion against that would be measuring the
 * fixture rather than the runner.
 *
 * Not `vi.useFakeTimers()`, ever: these specs have a live child process, and
 * faking the event loop's timers stops the child's real I/O from arriving.
 */
import type { Clock, TimerHandle } from '@DeFlow/core';

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }),
  setTimer: (ms, fn): TimerHandle => {
    const handle = setTimeout(fn, ms);
    // `unref` so a gate's five-minute timeout cannot hold the process open past
    // the assertion that cancelled it.
    handle.unref?.();
    return {
      cancel: () => {
        clearTimeout(handle);
      },
    };
  },
};
