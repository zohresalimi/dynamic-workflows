/**
 * KAR-16.4 AC9 — the dev-only projection counter
 * (docs/12-frontend-architecture.md §5.4).
 *
 * > **Ship a dev-only assertion.** Every 60 seconds in dev, log
 * > `{ nodes, facts, events, terminals }` counts. *You will find the leak in
 * > week one instead of in hour four of a run you cared about.*
 *
 * The four counters are not arbitrary: they are exactly the four candidates
 * EPIC-16-S27 names, in order of likelihood, when the soak fails on heap
 * growth — the raw event array, a per-node progress array, undisposed
 * terminals, and ELK inputs held by a Vue proxy. A log that named three of them
 * would leave the fourth diagnosed by guesswork.
 *
 * ## Why it cannot reach production
 *
 * The whole module is loaded by a **dynamic** `import()` inside
 * `if (import.meta.env.DEV)` in `./create-app.ts`. Vite substitutes `false` for
 * that expression in a production build, the branch is eliminated, and the
 * module never enters the graph — so `PROJECTION_LOG_TAG` is not merely
 * unreachable in the shipped bundle, it is absent from it. A static import with
 * a guarded call site would depend on tree-shaking noticing that the only use
 * had gone, which is a property of the bundler's mood rather than of this file.
 * `../../test/integration/dev-leak-assertion.test.ts` greps the built output.
 *
 * ## Why the interval is injected
 *
 * `startLeakAssertion` takes a clock. That is what lets its own spec fire ticks
 * by hand instead of reaching for fake timers — which this project does not
 * use in a suite that keeps real connections open — and it keeps the one
 * `setInterval` in the frontend in one named place, `browserInterval`, whose
 * only job is to be the thing a spec substitutes.
 */
import type { RunStoreCounts } from '../stores/useRunStore.ts';

/**
 * The tag the log line carries, and the string the production-bundle grep
 * looks for.
 *
 * Short and unmistakable: a dev console filtered to `[proj]` shows the trend
 * and nothing else, and a build containing it has shipped a development
 * assertion to an operator.
 */
export const PROJECTION_LOG_TAG = '[proj]';

/** Sixty seconds — long enough to be a trend, short enough to catch week one. */
export const LEAK_ASSERTION_INTERVAL_MS = 60_000;

/** The one thing this module needs of time. */
export interface IntervalClock {
  /** Calls `tick` every `everyMs` until the returned function is called. */
  every(everyMs: number, tick: () => void): () => void;
}

export interface LeakAssertionOptions {
  /** Sampled fresh on every tick, so the log is a trend and not a snapshot. */
  readonly counts: () => RunStoreCounts;
  readonly clock?: IntervalClock;
  readonly log?: (tag: string, counts: RunStoreCounts) => void;
  readonly everyMs?: number;
}

/**
 * The browser's own interval, as the injected port.
 *
 * The single `setInterval` in `@DeFlow/web`, and it is a *diagnostic* rather
 * than a wait: nothing in this project schedules work on a timer — a wait is a
 * `node_wake` row on the daemon side (docs/05 §10.1) — and this one only prints
 * a line in a development console.
 */
export const browserInterval: IntervalClock = {
  every(everyMs, tick) {
    const handle = setInterval(tick, everyMs);
    return () => clearInterval(handle);
  },
};

/**
 * Starts the counter. Returns the stop, which a torn-down app must call — an
 * interval outliving its store is itself a leak, and one this file would then
 * be reporting on.
 */
export function startLeakAssertion(options: LeakAssertionOptions): () => void {
  const clock = options.clock ?? browserInterval;
  const log = options.log ?? ((tag, counts) => console.debug(tag, counts));
  const everyMs = options.everyMs ?? LEAK_ASSERTION_INTERVAL_MS;

  return clock.every(everyMs, () => {
    log(PROJECTION_LOG_TAG, options.counts());
  });
}
