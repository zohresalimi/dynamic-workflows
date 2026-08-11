/**
 * KAR-17.1 — the wire EPIC-16 left unconnected.
 *
 * Verifies: EPIC-16-S1 (both rendering clauses), EPIC-17-S1 · AC1, AC3
 *
 * EPIC-16 finished with every piece built and **nothing joining them**:
 * `openLedgerStream` had no production caller, `useRunStore.applyEvent` had no
 * production caller, and `PlanGraphView` rendered from a shell store that
 * nothing ever filled. An application assembled that way opens against a real
 * replay and draws an empty graph however deep the ledger is — and every
 * individual spec stays green, because each half works perfectly on its own.
 * This module is the join, and it is a module rather than four lines in a
 * component so that the join itself can be reasoned about.
 *
 * ## Who folds
 *
 * `openLedgerStream` can fold events itself — it takes a projection set and
 * keeps one instance of it per watched run. It is given **no projections here**,
 * and that is the design rather than an omission:
 *
 * - The reactive surface every view reads is `useRunStore` (KAR-16.4): the
 *   `shallowRef` containers, the per-projection version counters, the memoised
 *   `planNodes` / `planEdges` selectors, the bounded debug ring and the dev
 *   leak counter. All of that hangs off `applyEvent`.
 * - Handing the stream the same seven reducers would fold every event **twice**
 *   — once into a set nothing renders from, once into the store — for a run
 *   that can be tens of thousands of events long.
 *
 * So the stream keeps what only it can keep: one connection per tab, the
 * cursor, the hydrate-then-subscribe ordering, the reconnect policy and the
 * `caught_up` handshake. The fold is the store's. What crosses between them is
 * one callback carrying one already-parsed `EventEnvelope`, which is also what
 * keeps NF10 — *"there is no other data path into the store"* — a property you
 * can check by reading forty lines.
 *
 * ## What this module deliberately does not do
 *
 * It does not know about Vue, about a route, or about a component's lifetime.
 * `../app/useRunFeed.ts` owns those. The seam is `EventSink`, which
 * `useRunStore` satisfies structurally — so nothing under `ledger/` imports a
 * store, and `test/dependency-direction.test.ts` stays true.
 */
import type { Event } from '@DeFlow/core';
import { type LedgerStream, type LedgerStreamState, openLedgerStream } from './stream.ts';

/**
 * Whatever folds an event. `useRunStore` is one; a spec's recorder is another.
 *
 * A structural interface rather than the store's own type: `ledger/` is below
 * `stores/` and importing upwards — even for a type — is the first step in a
 * cycle that ends with the projections importing Vue.
 */
export interface EventSink {
  /** Returns whether the event was applied. A duplicate is `false`, not a throw. */
  applyEvent(event: Event): boolean;
}

export interface RunFeedOptions {
  readonly runId: string;
  readonly sink: EventSink;
  /** Defaults to the page's own origin plus `/api`, as the daemon serves it. */
  readonly baseUrl?: string;
  /** Read per request, so a token acquired after this opened still attaches. */
  readonly token?: () => string | null | undefined;
  /** The build this tab was served with, for the skew check. */
  readonly build?: string;
  /** Every state change of the connection: hydrating, live, reconnecting. */
  readonly onStatus?: (state: LedgerStreamState) => void;
}

export interface RunFeed {
  readonly runId: string;
  /**
   * Resolves when the run is hydrated to its head **and** the daemon has said
   * `caught_up` for it. Rejects if the stream could not be opened at all.
   *
   * Exposed so a caller can tell "the graph is empty because the run is empty"
   * from "the graph is empty because nothing has arrived yet" — which are the
   * same picture and different bugs.
   */
  readonly ready: Promise<void>;
  close(): void;
}

/** How a feed is made. Injected so a spec can hand a view a scripted one. */
export type RunFeedFactory = (options: RunFeedOptions) => RunFeed;

/**
 * Opens the stream for one run and pours it into `sink`.
 *
 * One feed per open run panel; `close()` is the whole teardown — the socket,
 * the reconnect timer and the subscription go with it.
 */
export const openRunFeed: RunFeedFactory = (options: RunFeedOptions): RunFeed => {
  const stream: LedgerStream = openLedgerStream({
    // See the module note: the fold belongs to the sink, and a second set here
    // would be a second fold of every event for a projection nobody renders.
    projections: [],
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.build === undefined ? {} : { build: options.build }),
    ...(options.onStatus === undefined ? {} : { onStateChange: options.onStatus }),
    onApplied: (event) => {
      options.sink.applyEvent(event);
    },
  });

  const ready = stream.watch(options.runId).then(() => undefined);

  return {
    runId: options.runId,
    ready,
    close(): void {
      stream.unwatch(options.runId);
      stream.close();
    },
  };
};
