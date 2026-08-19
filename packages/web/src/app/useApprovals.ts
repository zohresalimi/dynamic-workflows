/**
 * KAR-25.7 — the approvals control's lifetime: one `GET /api/approvals`, one
 * global subscription, no poll.
 *
 * Mirrors `./useRunList.ts`'s own shape on purpose, down to which factory it
 * injects: `RUNS_FEED` is the tab's one `?runs=*` subscription
 * (`../ledger/shared-hub.ts`), and there is no reason for this composable to
 * open a second one under a different name. `../../test/shell.ts`'s
 * `runsFeed` override already exercises both consumers through the one fake,
 * exactly as the real factory routes both through the one shared hub.
 *
 * `App.vue` calls this once, unconditionally, the same place the old
 * `loadApprovals` lived — see its own docblock for why `awaitingOperator`
 * moved out of a `ref` filled at `onMounted` and into a store this composable
 * fills instead.
 */
import { inject, onScopeDispose } from 'vue';
import { useApiClient } from '../api/provide.ts';
import { readToken } from '../api/token.ts';
import type { RunsFeed, RunsFeedFactory } from '../ledger/runs-feed.ts';
import { type ApprovalRowIn, useApprovalsStore } from '../stores/useApprovalsStore.ts';
import { useSessionStore } from '../stores/useSessionStore.ts';
import { openLazyRunsFeed, RUNS_FEED } from './useRunList.ts';

export interface ApprovalsHandle {
  /** Resolves once the first page has been fetched and the stream is open. */
  readonly ready: Promise<void>;
}

/** The one call this composable makes, named — same seam `useRunList.ts` and
 * `ProjectWorkflowsView.vue` draw for their own calls. */
interface ApprovalsApi {
  readonly approvals: {
    readonly $get: (args: {
      readonly query: Record<string, never>;
    }) => Promise<{ readonly ok: boolean; readonly json: () => Promise<unknown> }>;
  };
}

export function useApprovals(): ApprovalsHandle {
  const store = useApprovalsStore();
  const session = useSessionStore();
  const client = useApiClient() as unknown as ApprovalsApi;
  const open = inject<RunsFeedFactory>(RUNS_FEED, openLazyRunsFeed);

  // The same rule `App.vue`'s old `loadApprovals` followed: a tokenless tab
  // issues nothing, not even the subscription, matching AC6 of the story that
  // put the topbar and rail on every route (`App.vue`'s own docblock).
  if (!session.authenticated) {
    return { ready: Promise.resolve() };
  }

  const feed: RunsFeed = open({
    token: readToken,
    onLifecycle: (event) => {
      store.applyLifecycle(event);
    },
  });

  const ready = (async (): Promise<void> => {
    try {
      const response = await client.approvals.$get({ query: {} });
      if (response.ok) {
        const body = (await response.json()) as { items?: readonly ApprovalRowIn[] };
        store.hydrate(body.items ?? []);
      }
    } catch {
      // A daemon that is restarting is not something to shout about in a
      // toolbar; the control simply does not appear — the same rule the old
      // `loadApprovals` followed.
    }
    await feed.ready;
  })();

  onScopeDispose(() => {
    feed.close();
  });

  return { ready };
}
