/**
 * KAR-16.4 — the debug ring: the one place a raw envelope is allowed to live
 * (docs/12-frontend-architecture.md §5.1).
 *
 * > **Never retain the raw event array.** Apply each event to the projections
 * > and drop it. Keep a bounded ring of the last ~2,000 raw events for the
 * > debug pane and nothing more.
 *
 * Three properties, and each one is a rule about memory rather than about
 * ergonomics:
 *
 * 1. **Fixed size, allocated once.** The backing array is `cap` slots from the
 *    first push to the last, and pushing past the end overwrites slot
 *    `n % cap`. Not `push` + `shift`: `shift` re-indexes the whole array on
 *    every event, which on a chatty run is the per-frame allocation this store
 *    exists to avoid, and it makes the ring's cost a function of the run's
 *    length in exactly the place that must not have one.
 * 2. **The overwritten slot is released.** Assigning the new entry over the old
 *    one is what drops the last reference the tab holds to it — which is what
 *    makes the `WeakRef` assertion in `../stores/useRunStore.test.ts` true. A
 *    ring that grew a second array "for the inspector" would keep every
 *    envelope of a six-hour run alive behind an API that still looks bounded.
 * 3. **It is indexed from the oldest.** A debug pane pages forward through it,
 *    so `at(0)` is the oldest entry held rather than slot zero of the backing
 *    array, and the wrap is this module's business rather than every caller's.
 *
 * Deliberately not reactive and deliberately not Vue-aware: the store holds it
 * behind a `shallowRef` counter like every other projection, because a deep
 * `reactive()` over two thousand envelopes is the exact cost §4 is about.
 */

/**
 * The default cap, and the number `../app/leak-assert.ts` reports.
 *
 * Named rather than inlined because the dev counter prints it: raising it is
 * then visible in the log the operator is already reading, instead of being a
 * quiet edit to a literal (EPIC-16-S25).
 */
export const DEBUG_RING_CAP = 2_000;

export interface EventRing<T> {
  /** The fixed number of entries this ring will ever hold. */
  readonly cap: number;
  /** How many it holds now — `min(pushed, cap)`. */
  readonly size: number;
  /** How many were ever pushed. Monotonic; not a memory cost. */
  readonly pushed: number;
  push(item: T): void;
  /** Oldest first. A fresh array each call; the ring keeps its own. */
  toArray(): readonly T[];
  /** `index` 0 is the oldest entry held, not slot zero of the buffer. */
  at(index: number): T | undefined;
  oldest(): T | undefined;
  newest(): T | undefined;
  /** Releases every slot. What `unwatch` owes a run nobody is looking at. */
  clear(): void;
}

/**
 * A fixed-size circular buffer of `cap` entries.
 *
 * `cap` must be a positive integer, and a bad one throws rather than being
 * clamped: a ring quietly holding nothing is a debug pane that is empty for a
 * reason nobody can see, which is worse than a boot failure that names it.
 */
export function createEventRing<T>(cap: number = DEBUG_RING_CAP): EventRing<T> {
  if (!Number.isInteger(cap) || cap < 1) {
    throw new RangeError(
      `the debug ring's cap must be a positive integer, not ${cap}: a ring that holds nothing ` +
        'is an empty inspector with no explanation',
    );
  }

  // `undefined` is the empty slot, which is why the accessors below narrow
  // rather than index straight through. The array is allocated once and never
  // grows: `slots.length` is `cap` for the life of the ring.
  const slots: (T | undefined)[] = Array.from({ length: cap });
  let pushed = 0;

  /** The backing index of the `index`-th oldest entry held. */
  const slotOf = (index: number): number => (start() + index) % cap;

  /** The backing index of the oldest entry held. */
  const start = (): number => (pushed <= cap ? 0 : pushed % cap);

  const size = (): number => Math.min(pushed, cap);

  return {
    cap,
    get size() {
      return size();
    },
    get pushed() {
      return pushed;
    },

    push(item) {
      // The assignment is the release: whatever occupied this slot has no other
      // reference in the tab, so it becomes collectable here and nowhere else.
      slots[pushed % cap] = item;
      pushed += 1;
    },

    toArray() {
      const held = size();
      const out: T[] = Array.from({ length: held });
      for (let index = 0; index < held; index += 1) out[index] = slots[slotOf(index)] as T;
      return out;
    },

    at(index) {
      if (!Number.isInteger(index) || index < 0 || index >= size()) return undefined;
      return slots[slotOf(index)];
    },

    oldest() {
      return size() === 0 ? undefined : slots[start()];
    },

    newest() {
      return pushed === 0 ? undefined : slots[(pushed - 1) % cap];
    },

    clear() {
      slots.fill(undefined);
      pushed = 0;
    },
  };
}
