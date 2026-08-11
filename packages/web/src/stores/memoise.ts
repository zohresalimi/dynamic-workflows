/**
 * KAR-16.4 — turning a projection's mutable state into view models a renderer
 * can diff (docs/12-frontend-architecture.md §4).
 *
 * The projections mutate in place, on purpose: a reducer that allocated a new
 * node object per event would allocate a graph per frame on a chatty run. But a
 * component cannot see an in-place mutation — Vue compares a child's props by
 * reference, so a node object that was mutated is a prop that did not change,
 * and the DOM stays on the old phase forever.
 *
 * This module is the seam between those two facts. `memoise` walks a
 * projection's `Map`, and for each entry answers with **the same snapshot
 * object as last time** if nothing a component can see has changed, or a fresh
 * frozen copy if something has. So exactly the changed entries get new prop
 * identities, and exactly their subtrees are patched.
 *
 * ## Why the comparators are explicit rather than a deep equality
 *
 * A deep compare over four hundred nodes per render is the cost this whole
 * store exists to avoid, and a generic shallow compare is *wrong* for spans,
 * whose `suspensions` array is appended to in place. So each comparator states
 * which fields a component can observe, and is written against what the
 * projection actually does to that state — every nested object on a node
 * (`failure`, `blocked`, `retry`, `binary`) is assigned wholesale by
 * `../ledger/projections/plan.ts`, which is what makes a shallow compare
 * sufficient there and worth saying out loud here.
 *
 * Nothing in this file imports Vue, and nothing in it knows about an event.
 */

/** Whether the held snapshot still describes `live`. */
export type Unchanged<T> = (held: T, live: T) => boolean;

/** A frozen view model over `live`. Called only when something changed. */
export type Snapshot<T> = (live: T) => T;

/**
 * The memoised list, oldest key first, with unchanged entries reused.
 *
 * `cache` is mutated: entries for keys the projection no longer holds are
 * dropped, so a plan that abandoned a node does not keep its snapshot alive —
 * this map is bounded by the plan exactly as the projection is.
 */
export function memoise<T extends object>(
  cache: Map<string, T>,
  live: ReadonlyMap<string, T>,
  unchanged: Unchanged<T>,
  snapshot: Snapshot<T>,
): readonly T[] {
  const out: T[] = [];

  for (const [key, current] of live) {
    const held = cache.get(key);
    if (held !== undefined && unchanged(held, current)) {
      out.push(held);
      continue;
    }
    const fresh = snapshot(current);
    cache.set(key, fresh);
    out.push(fresh);
  }

  if (cache.size !== live.size) {
    for (const key of [...cache.keys()]) if (!live.has(key)) cache.delete(key);
  }

  // Frozen rather than `markRaw`d: `reactive()` returns a non-extensible object
  // unchanged, so this array cannot become a proxy on the way into a component
  // that spreads it into a `reactive()` — and unlike `markRaw` it also refuses
  // a caller that tries to sort it in place.
  return Object.freeze(out);
}

/** A frozen shallow copy — the default snapshot for a flat view model. */
export const copy = <T extends object>(live: T): T => Object.freeze({ ...live });

/**
 * Own enumerable keys compared with `Object.is`.
 *
 * Sufficient for `PlanNodeVM` because every nested value it holds is assigned
 * wholesale by the projection rather than mutated: a new `failure`, a new
 * `blocked`, a new `retry`, a new `binary` object each time.
 */
export function shallowUnchanged<T extends object>(held: T, live: T): boolean {
  const keys = Object.keys(live) as (keyof T)[];
  if (keys.length !== Object.keys(held).length) return false;
  return keys.every((key) => Object.is(held[key], live[key]));
}

/** `PlanEdgeVM` — flat, except `carries`, which is a fresh array on each read. */
export function edgeUnchanged<T extends { readonly carries: readonly string[] }>(
  held: T,
  live: T,
): boolean {
  if (held.carries.length !== live.carries.length) return false;
  if (!held.carries.every((one, index) => one === live.carries[index])) return false;
  const keys = (Object.keys(live) as (keyof T)[]).filter((key) => key !== 'carries');
  return keys.every((key) => Object.is(held[key], live[key]));
}

/** The mutable fields of a suspension. Everything else on it is `readonly`. */
interface SuspensionShape {
  readonly untilSeq: number | null;
  readonly untilTs: number | null;
}

/** The mutable fields of a span, plus the suspensions appended to it. */
interface SpanShape {
  readonly endSeq: number | null;
  readonly endTs: number | null;
  readonly open: boolean;
  readonly outcome: string | null;
  readonly suspendedMs: number | null;
  readonly suspensions: readonly SuspensionShape[];
}

/**
 * A span is unchanged when none of its mutable fields moved **and** no
 * suspension was appended or answered.
 *
 * The `suspensions` array is the one place a projection in this codebase
 * mutates a nested collection in place, which is why a shallow compare would be
 * quietly wrong here: an answered suspension is what turns six idle hours into
 * a number, and it would never reach the screen.
 */
export function spanUnchanged<T extends SpanShape>(held: T, live: T): boolean {
  if (
    !Object.is(held.endSeq, live.endSeq) ||
    !Object.is(held.endTs, live.endTs) ||
    held.open !== live.open ||
    held.outcome !== live.outcome ||
    !Object.is(held.suspendedMs, live.suspendedMs) ||
    held.suspensions.length !== live.suspensions.length
  ) {
    return false;
  }

  return held.suspensions.every((one, index) => {
    const other = live.suspensions[index];
    return (
      other !== undefined &&
      Object.is(one.untilSeq, other.untilSeq) &&
      Object.is(one.untilTs, other.untilTs)
    );
  });
}

/** A span's snapshot copies its suspensions, so the list cannot grow underneath. */
export function copySpan<T extends SpanShape>(live: T): T {
  return Object.freeze({
    ...live,
    suspensions: Object.freeze(live.suspensions.map((one) => Object.freeze({ ...one }))),
  });
}
