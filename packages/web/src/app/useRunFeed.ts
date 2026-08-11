/**
 * KAR-17.1 — a run panel's lifetime, as a composable.
 *
 * `../ledger/feed.ts` knows how to pour one run's stream into a sink and
 * nothing else. This is the half that knows about Vue: which run the route is
 * on, when to open, when to close, and what a view should render while the
 * connection is somewhere other than `live`.
 *
 * **The factory is injected.** A browser spec that mounted the real one would
 * open a real socket against the runner's own origin — which is a Vite dev
 * server, not a daemon — and would then be a spec about a 404. The default is
 * the real feed, so the shipped application injects nothing and gets the real
 * thing; `packages/web/test/shell.ts` is the one caller that overrides it, and
 * the whole stack from socket to node body is asserted end to end in
 * `e2e/plan-graph.test.ts` against a real `DeFlow replay` daemon instead.
 */
import { type InjectionKey, inject, onScopeDispose, type Ref, ref, watch } from 'vue';
import { useApiClient } from '../api/provide.ts';
import { readToken } from '../api/token.ts';
// Type-only. `../ledger/feed.ts` reaches `openLedgerStream`, and through it
// `parseEvent` and every zod schema `@DeFlow/core` owns — see `openLazyRunFeed`.
import type { RunFeed, RunFeedFactory, RunFeedOptions } from '../ledger/feed.ts';
import type { ConnectionStatus } from '../ledger/stream.ts';
import { useRunStore } from '../stores/useRunStore.ts';

export const RUN_FEED: InjectionKey<RunFeedFactory> = Symbol('DeFlow.runFeed');

/**
 * The default factory: the real feed, fetched in a chunk of its own.
 *
 * ## Why this is a dynamic import
 *
 * The transport is **data-path code, not shell code**. `../ledger/feed.ts`
 * reaches `openLedgerStream` → `../api/hydrate.ts` and `../api/dispatch.ts` →
 * `parseEvent`, and `parseEvent` has to know every event kind, so it pulls the
 * whole of `@DeFlow/core`'s schema vocabulary and zod with it: about 42 KB gzip
 * that nothing on screen needs in order to *be on screen*. Statically imported
 * from here it lands in the chunk `index.html` preloads, where it is parsed and
 * executed before the first paint — which is precisely the ~200 KB budget NF3
 * is contingent on (docs/12 §10), and which
 * `../../test/integration/bundle-budget.test.ts` holds.
 *
 * Split off, the shell paints, the keymap answers and the route is interactive
 * while the transport is still arriving over localhost. Nothing waits longer
 * for its data than it did: the fetch starts in the same tick this composable
 * runs, one dynamic import ahead of a network round trip to the daemon that was
 * always going to dominate it.
 *
 * ## Why it is not simply `await`ed at the call site
 *
 * `RunFeedFactory` is synchronous, because the injected test double is and
 * because a composable cannot await inside a `watch` handler without giving up
 * the ordering guarantee below it. So the handle is real immediately and the
 * module lands inside it: `ready` resolves when the run is hydrated exactly as
 * the eager feed's does, and `close()` is honoured whether it arrives before or
 * after the import lands — a panel opened and shut inside one tick must not
 * leave a socket behind it.
 */
export const openLazyRunFeed: RunFeedFactory = (options: RunFeedOptions): RunFeed => {
  let opened: RunFeed | null = null;
  let closed = false;

  const ready = import('../ledger/feed.ts').then(async ({ openRunFeed }) => {
    if (closed) return;
    opened = openRunFeed(options);
    await opened.ready;
  });

  return {
    runId: options.runId,
    ready,
    close(): void {
      closed = true;
      opened?.close();
      opened = null;
    },
  };
};

export interface RunFeedHandle {
  /** What the connection is doing, for a view that wants to say so. */
  readonly status: Ref<ConnectionStatus>;
  /** The stream reported a `fatal` this client must not retry. */
  readonly fatal: Ref<string | null>;
}

/**
 * Keeps the run store fed for whichever run `runId` names.
 *
 * Re-entrant by design: a route change from one run to another closes the old
 * feed before opening the new one, because two feeds means two connections and
 * one connection per tab is KAR-16.2's whole promise.
 */
export function useRunFeed(runId: Ref<string | null>): RunFeedHandle {
  const run = useRunStore();
  const client = useApiClient();
  const open = inject(RUN_FEED, openLazyRunFeed);

  const status = ref<ConnectionStatus>('idle');
  const fatal = ref<string | null>(null);
  let feed: RunFeed | null = null;

  function close(): void {
    feed?.close();
    feed = null;
    status.value = 'idle';
  }

  watch(
    runId,
    (id) => {
      close();
      fatal.value = null;
      if (id === null) return;

      // Before the feed, not after: an event that arrived for a run the store
      // is not open on is dropped, and the drop is silent by design
      // (`useRunStore.applyEvent`). The client is handed over here because the
      // store's scrubber is built from it — the graph does not scrub, but the
      // views that hang off this one do, and they share this store.
      run.open(id, { client });

      feed = open({
        runId: id,
        sink: run,
        token: readToken,
        onStatus: (state) => {
          status.value = state.status;
          fatal.value = state.fatal?.code ?? null;
        },
      });
      // A feed that cannot open is a view that renders nothing with no
      // explanation. The rejection is surfaced as a fatal rather than left as
      // an unhandled rejection in a console nobody is reading.
      feed.ready.catch((cause: unknown) => {
        fatal.value = cause instanceof Error ? cause.message : String(cause);
      });
    },
    { immediate: true },
  );

  // The component, not the tab: `close()` here and `run.close()` deliberately
  // not. The store's projections are this tab's picture of the run, and a
  // panel that is re-opened a second later should not have to re-fold a
  // multi-hour ledger to show the same graph again.
  onScopeDispose(close);

  return { status, fatal };
}
