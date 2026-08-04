/**
 * The `Clock` port (docs/14-testing-strategy.md §8).
 *
 * NF9 asks for a deterministic core, which has one concrete consequence:
 * **time enters through this port**, never through `Date.now()` or
 * `setTimeout` in engine code. The implementations live outside core —
 * `SystemClock` in @DeFlow/daemon, `TestClock` in @DeFlow/testkit.
 *
 * The reason this is a port rather than a testing convenience is that
 * `vi.useFakeTimers()` freezes the event loop's timers, so a spec that fakes
 * time while a child process is alive never receives the child's real I/O and
 * deadlocks for the full slice timeout — and the retry-backoff, budget-ceiling,
 * no-progress and long-suspension paths (F4.5–F4.8) are all about time *around*
 * child processes. An injected clock is the only way to test them at all.
 */

/**
 * What `setTimer` hands back.
 *
 * The ECMAScript `Disposable` interface would be the natural type, but it lives
 * in `lib.esnext.disposable`, and docs/16-repo-layout.md §5 pins the workspace
 * to `lib: ["es2024"]`. So the port declares the one operation it needs.
 */
export interface TimerHandle {
  /** Cancels the timer if it has not fired. Idempotent. */
  cancel(): void;
}

export interface Clock {
  /** Milliseconds since the Unix epoch, as this clock understands them. */
  now(): number;
  /**
   * Resolves once `ms` have passed on this clock. Rejects with the signal's
   * reason if `signal` aborts first, and drops the pending timer when it does.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Runs `fn` once, `ms` from now. */
  setTimer(ms: number, fn: () => void): TimerHandle;
}
