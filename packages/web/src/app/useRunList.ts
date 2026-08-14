/**
 * KAR-19.1 AC5 — the root route's lifetime: one list request, one global
 * subscription, no poll.
 *
 * The shape mirrors `./useRunFeed.ts` deliberately, including the injected
 * factory and the reason for it: a browser spec that opened the real feed would
 * open a real socket against the runner's own origin — a Vite dev server, not a
 * daemon — and would then be a spec about a 404. The shipped application injects
 * nothing and gets the real thing.
 *
 * The subscription is `?runs=*`, whose membership is already exactly the four
 * low-volume lifecycle kinds (docs/11 §3). That is what makes a live list cost
 * one connection rather than a poll or a firehose, and it is why this composable
 * has no interval in it at all.
 */
import { type InjectionKey, inject, onScopeDispose } from 'vue';
import { useApiClient } from '../api/provide.ts';
import { readToken } from '../api/token.ts';
// Type-only, for the reason `./useRunFeed.ts` gives: reaching the transport as a
// value pulls `parseEvent` and the whole schema vocabulary into the boot chunk.
import type { RunsFeed, RunsFeedFactory } from '../ledger/runs-feed.ts';
import { type RunListRow, useRunListStore } from '../stores/useRunListStore.ts';

export const RUNS_FEED: InjectionKey<RunsFeedFactory> = Symbol('DeFlow.runsFeed');

/** The default factory: the real global feed, in a chunk of its own. */
export const openLazyRunsFeed: RunsFeedFactory = (options): RunsFeed => {
  let opened: RunsFeed | null = null;
  let closed = false;

  const ready = import('../ledger/runs-feed.ts').then(async ({ openRunsFeed }) => {
    if (closed) return;
    opened = openRunsFeed(options);
    await opened.ready;
  });

  return {
    ready,
    close(): void {
      closed = true;
      opened?.close();
      opened = null;
    },
  };
};

export interface RunListHandle {
  /** Resolves once the first page has been fetched and the stream is open. */
  readonly ready: Promise<void>;
}

/**
 * Opens the run list for the lifetime of the calling component.
 *
 * The order is hydrate-then-subscribe, the same order `openLedgerStream` uses
 * per run and for the same reason: a frame that arrives while the page request
 * is in flight is applied on top of it, so the seam produces neither a gap nor a
 * duplicate — `applyLifecycle` updates a run already on the page in place.
 */
export function useRunList(): RunListHandle {
  const store = useRunListStore();
  const client = useApiClient();
  const open = inject(RUNS_FEED, openLazyRunsFeed);

  const feed = open({
    token: readToken,
    onLifecycle: (event) => {
      store.applyLifecycle(event);
    },
  });

  const ready = (async (): Promise<void> => {
    try {
      // The three parameters are stated rather than omitted: `hc<ApiType>` types
      // the query off the route's own validator, so a parameter this list stops
      // sending is a compile error rather than a silently unfiltered page.
      const response = await client.runs.$get({
        query: { status: undefined, limit: undefined, cursor: undefined },
      });
      if (response.ok) {
        const page = (await response.json()) as { runs?: readonly RunListRow[] };
        store.hydrate(page.runs ?? []);
      }
    } catch {
      // A daemon that is still starting, or a tab whose token has not arrived
      // yet, answers nothing — and the list is still the right page to be on.
      // The subscription below is what fills it either way, which is the whole
      // reason this route does not depend on the request succeeding.
    }
    await feed.ready;
  })();

  onScopeDispose(() => {
    feed.close();
  });

  return { ready };
}
