/**
 * KAR-25.1 AC7, EPIC-25-S06 — the eight run views, reachable at their old
 * `/runs/:runId…` paths as well as their new `/projects/:projectId/runs/:runId…`
 * ones.
 *
 * A run submitted before projects existed, or from a terminal that named
 * none, carries no `projectId` — and every fixture under `test/fixtures/runs/`
 * is exactly that: a ledger that starts at `run.created` with no
 * `task.submitted` at all. So a bookmark of `/runs/:runId` cannot simply
 * 404 once Runs becomes project-scoped, and it cannot simply redirect either,
 * because a project-less run has nowhere to redirect *to*. Three outcomes,
 * decided once here rather than once per view:
 *
 * 1. **The run exists and belongs to a project** — redirect to the
 *    project-scoped equivalent, replacing the address bar entry so Back does
 *    not return to a link that only ever pointed at itself.
 * 2. **The run exists and belongs to no project** — render the legacy route
 *    in place. The view is the same component either way; only the route
 *    that reached it differs.
 * 3. **The run does not exist** — the legacy route renders the existing
 *    not-found view instead of its own component, and the URL is left alone.
 *    `to.meta.runMissing` is what tells the route's own wrapper to make that
 *    swap, rather than a second redirect: redirecting to `not-found`'s own
 *    `/:pathMatch(.*)*` would stringify back to the same `/runs/<id>` path and
 *    re-match this exact record on the next navigation — a loop, not a fix.
 *
 * **Where the fact comes from.** `GET /api/runs/:id` already answers
 * `projectId` when the run's first event named one (`runProjectId`,
 * `packages/daemon/src/http/api.ts`) and already 404s `run_not_found` when it
 * does not hold the run at all (`resolveRun`, same file). Both existed before
 * this story; the web app simply had no caller for the field. This guard is
 * that caller, and it is deliberately **not** a `@pinia/colada` query: that
 * endpoint is on the projection side of KAR-16.4 AC10's line, and a `beforeEach`
 * has no component to hold a query result in anyway.
 *
 * **Why a global `beforeEach` rather than eight identical `beforeEnter`s.**
 * The guard needs the API client the *running application* was given —
 * `mountShell` provides one per spec, `main.ts` provides the real one — and
 * that is only resolvable once the app exists, which a route table built at
 * module load time is not. `../app/create-app.ts` installs this with
 * `app.runWithContext`, so `useApiClient()` resolves the same client every
 * other view in that app sees. Filtered to the eight `legacy-*` names, it is
 * the same rule the plan describes as a shared `beforeEnter` — one guard, one
 * place, applied to exactly those routes.
 */
import { type Component, defineComponent, h } from 'vue';
import type { NavigationGuardWithThis, RouteLocationRaw } from 'vue-router';
import { useRoute } from 'vue-router';
import type { ApiClient } from '../api/client.ts';
import NotFoundView from '../views/NotFoundView.vue';

declare module 'vue-router' {
  interface RouteMeta {
    /** Set by `createLegacyRunGuard` when the run named in the URL does not
     * exist. The legacy route's own wrapper renders `NotFoundView` when this
     * is `true`, rather than a second redirect — see the header comment. */
    runMissing?: boolean;
  }
}

/** The eight canonical run-view names this module doubles into `legacy-<name>`. */
export const RUN_VIEW_NAMES = [
  'run-plan',
  'plan-evolution',
  'run-context',
  'run-diff',
  'run-criteria',
  'run-timeline',
  'run-node-output',
  'run-memory',
] as const;

export type RunViewName = (typeof RUN_VIEW_NAMES)[number];

const LEGACY_NAMES = new Set<string>(RUN_VIEW_NAMES.map((name) => `legacy-${name}`));

/**
 * A view rendered at a `legacy-*` route: the real view, unless the guard
 * marked this navigation's run missing, in which case it is `NotFoundView`.
 *
 * `inheritAttrs: false` plus a manual `h(component, attrs)` rather than
 * `defineProps`, because `props: true` on the route hands this wrapper
 * whatever params the matched record declares (`runId`, and `nodeId` for the
 * output route) and it has no business knowing their names — it only ever
 * forwards them to whichever component it picked.
 */
export function withLegacyRunGuard(component: Component): Component {
  return defineComponent({
    name: 'LegacyRunGuardView',
    inheritAttrs: false,
    setup(_props, { attrs }) {
      const route = useRoute();
      return () => (route.meta.runMissing === true ? h(NotFoundView) : h(component, attrs));
    },
  });
}

/** The lazy-import equivalent, for the seven legacy records that stay lazy. */
export function lazyWithLegacyRunGuard(
  loader: () => Promise<{ default: Component }>,
): () => Promise<{ default: Component }> {
  return () => loader().then((loaded) => ({ default: withLegacyRunGuard(loaded.default) }));
}

/**
 * KAR-25.1 — the dual-name problem, in one function.
 *
 * A named push to `run-diff` (or any of its seven siblings) throws `Missing
 * required param "projectId"` from a route that carries none — which is
 * exactly a project-less run at its legacy URL, branch (b) of
 * `createLegacyRunGuard` above. `PlanNode.vue`, `ReviewFinding.vue`,
 * `DiffReviewView.vue` and `AcceptanceCriteriaView.vue` each build a link to
 * one of the eight run views from wherever they currently are, and none of
 * them can hard-code the canonical name any more — so they build it through
 * this instead: pass the `projectId` this call site currently has (its own
 * `route.params['projectId']`, typed loosely because that is what
 * `RouteParams` gives back), and get the canonical name back when there is
 * one to scope by, or the `legacy-*` twin when there is not.
 *
 * Vue-router 5.2.0 *does* inherit a missing required param from the current
 * location for a named push (`pickParams`, `dist/vue-router.js`), so a
 * `{ name: 'run-diff', params: { runId } }` push from an already
 * project-scoped route would resolve on its own — this function exists only
 * for the other half, where there is no `projectId` to inherit.
 */
export function runRouteTo(
  name: RunViewName,
  projectId: string | readonly string[] | null | undefined,
  params: Record<string, string | undefined>,
  query?: Record<string, unknown>,
): RouteLocationRaw {
  const scoped = typeof projectId === 'string' && projectId !== '';
  return {
    name: scoped ? name : `legacy-${name}`,
    params: scoped ? { projectId, ...params } : params,
    ...(query === undefined ? {} : { query }),
  } as RouteLocationRaw;
}

/** The shape `GET /api/runs/:id` answers with, reduced to the one field this
 * guard reads. */
interface RunLookupBody {
  readonly projectId?: unknown;
}

async function safeErrorCode(response: {
  readonly json: () => Promise<unknown>;
}): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    return typeof body.error?.code === 'string' ? body.error.code : null;
  } catch {
    return null;
  }
}

/**
 * The three-way branch the header comment describes, as a `router.beforeEach`.
 *
 * `resolveClient` is a thunk rather than a client, because the client a spec
 * or a real boot provides is not known until the app exists — see the header
 * comment's note on why this is installed from `../app/create-app.ts` rather
 * than carried on each route record.
 */
export function createLegacyRunGuard(
  resolveClient: () => ApiClient,
): NavigationGuardWithThis<undefined> {
  return async (to): Promise<RouteLocationRaw | boolean> => {
    const name = typeof to.name === 'string' ? to.name : '';
    if (!LEGACY_NAMES.has(name)) return true;

    const runId = typeof to.params['runId'] === 'string' ? to.params['runId'] : '';
    if (runId === '') return true;

    let client: ApiClient;
    try {
      client = resolveClient();
    } catch {
      return true;
    }

    try {
      const response = await (
        client as unknown as {
          runs: { ':id': { $get: (a: { param: { id: string } }) => Promise<Response> } };
        }
      ).runs[':id'].$get({ param: { id: runId } });

      if (response.ok) {
        const body = (await response.json()) as RunLookupBody;
        const projectId = typeof body.projectId === 'string' ? body.projectId : null;
        // (b) — a project-less run renders in place at the legacy URL.
        if (projectId === null) return true;
        // (a) — redirect to the project-scoped equivalent.
        const canonical = name.slice('legacy-'.length);
        return {
          name: canonical,
          params: { ...to.params, projectId },
          query: to.query,
          hash: to.hash,
          replace: true,
        };
      }

      if (response.status === 404 && (await safeErrorCode(response)) === 'run_not_found') {
        // (c) — no redirect: the address bar keeps the pasted URL, and the
        // route's own wrapper renders NotFoundView instead of the real view.
        to.meta.runMissing = true;
        return true;
      }

      // Any other refusal is not this guard's to interpret — render in place
      // rather than guess at a redirect or a 404 the daemon did not send.
      return true;
    } catch {
      // A daemon that cannot be reached, or a spec's client that implements
      // no `/api/runs/:id` at all: the honest answer is "unknown", and
      // rendering the legacy route in place is what "unknown" already means
      // for branch (b) above.
      return true;
    }
  };
}
