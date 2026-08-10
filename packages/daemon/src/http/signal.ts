/**
 * The park primitive of the two-phase drain (docs/11-api-and-realtime.md §5).
 *
 * The serving loop is *drain to empty, then park until something commits, then
 * drain again*. Between the last drain query and the park there is a window,
 * and the naive version loses every event that commits inside it: the drain
 * did not see the row, and the notification arrived before anything was
 * waiting for one.
 *
 * So this **latches**. `notify()` with nobody parked is remembered, and the
 * next `wait()` returns immediately. That is the whole of it — and it is
 * enough, because the reaction to a wake-up is *"drain from my cursor"* rather
 * than *"here is the payload"*. A burst of commits is therefore one drain, not
 * one per commit, and a wake-up that turns out to have nothing behind it costs
 * one bounded query.
 */
export class Signal {
  /** A notification that arrived while nobody was parked. */
  #latched = false;
  #waiters: (() => void)[] = [];

  /** Wakes everything parked; remembers the wake-up if nothing is. */
  notify(): void {
    if (this.#waiters.length === 0) {
      this.#latched = true;
      return;
    }
    for (const wake of this.#waiters.splice(0)) wake();
  }

  /** Resolves on the next `notify()`, or at once if one has already happened. */
  wait(): Promise<void> {
    if (this.#latched) {
      this.#latched = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}
