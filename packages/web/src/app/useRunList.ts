/**
 * KAR-19.1 AC5, KAR-25.1 — this project's run list's lifetime: one list
 * request, one subscription, no poll.
 *
 * The shape mirrors `./useRunFeed.ts` deliberately, including the injected
 * factory and the reason for it: a browser spec that opened the real feed would
 * open a real socket against the runner's own origin — a Vite dev server, not a
 * daemon — and would then be a spec about a 404. The shipped application injects
 * nothing and gets the real thing.
 *
 * **The hydrate is project-scoped; the subscription is not, and cannot be.**
 * `GET /api/projects/:id/runs` (KAR-22.3 AC4) is the server-side filter this
 * list's initial page comes from. The live update after that still rides the
 * global `?runs=*` topic, whose four lifecycle kinds (docs/11 §3) are what
 * keep a live list to one connection rather than a poll — but `run.created`
 * carries no `projectId` (`RunCreatedSchema`, `packages/core/src/event-payloads.ts`),
 * so `applyLifecycle`'s **update-in-place** path (a frame for a run already on
 * this page) still works, and its **insert** path cannot: a run started
 * elsewhere while this page is open is not knowable as "not mine" from the
 * frame alone, so it is not added, and appears only on the next visit. This is
 * a known, accepted gap from EPIC-19-S2's original "no refetch, ever" claim —
 * see `../views/run-list.test.ts`'s own suite for the scenario that documents
 * it, and KAR-25.1's story notes for why fixing it (adding `projectId` to the
 * event) is out of this story's scope.
 */
import { type InjectionKey, inject, onScopeDispose } from 'vue';
import { useApiClient } from '../api/provide.ts';
import { readToken } from '../api/token.ts';
// Type-only, for the reason `./useRunFeed.ts` gives: reaching the transport as a
// value pulls `parseEvent` and the whole schema vocabulary into the boot chunk.
import type { RunsFeed, RunsFeedFactory } from '../ledger/runs-feed.ts';
import { type RunListRow, useRunListStore } from '../stores/useRunListStore.ts';

export const RUNS_FEED: InjectionKey<RunsFeedFactory> = Symbol('DeFlow.runsFeed');

/**
 * The default factory: the real global feed, in a chunk of its own.
 *
 * KAR-25.7 — this is `../ledger/shared-hub.ts`'s `watchLifecycle`, not
 * `../ledger/runs-feed.ts`'s `openRunsFeed`: a lifecycle listener opened this
 * way joins the tab's one shared connection rather than opening a private
 * one. `./useApprovals.ts` injects this exact same factory for exactly that
 * reason — the run list and the approvals store are two listeners on one
 * socket, never two sockets. See `../ledger/shared-hub.ts`'s header comment.
 */
export const openLazyRunsFeed: RunsFeedFactory = (options): RunsFeed => {
  let opened: RunsFeed | null = null;
  let closed = false;

  const ready = import('../ledger/shared-hub.ts').then(async ({ watchLifecycle }) => {
    if (closed) return;
    const watch = watchLifecycle(options.onLifecycle, {
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.build === undefined ? {} : { build: options.build }),
      ...(options.onStatus === undefined ? {} : { onStatus: options.onStatus }),
    });
    opened = { ready: watch.ready, close: () => watch.close() };
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
export function useRunList(projectId: string): RunListHandle {
  const store = useRunListStore();
  const client = useApiClient();
  const open = inject(RUNS_FEED, openLazyRunsFeed);

  const feed = open({
    token: readToken,
    onLifecycle: (event) => {
      // KAR-25.1 — the update-in-place half of `applyLifecycle` survives the
      // move to project scope (it matches on `runId`); the insert half
      // cannot, because `run.created` carries no `projectId` to check against
      // this list's own scope (see the header comment above). Forwarding
      // only events for a run this list already hydrated is what keeps a run
      // started in a *different* project from appearing here live — the
      // alternative, forwarding everything, would insert it.
      if (!store.list.some((row) => row.runId === event.runId)) return;
      store.applyLifecycle(event);
    },
  });

  const ready = (async (): Promise<void> => {
    try {
      // KAR-22.3 AC4 — the server's own filter, not a client-side sieve of the
      // global list: `runIdsForProject` is a `WHERE` over the event table, so
      // a project with three runs among three hundred is three rows.
      const response = await (
        client as unknown as {
          readonly projects: {
            readonly ':id': {
              readonly runs: {
                readonly $get: (args: {
                  readonly param: { readonly id: string };
                }) => Promise<{ readonly ok: boolean; readonly json: () => Promise<unknown> }>;
              };
            };
          };
        }
      ).projects[':id'].runs.$get({ param: { id: projectId } });
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
