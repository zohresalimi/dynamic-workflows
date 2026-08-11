/**
 * KAR-16.1 — the route table.
 *
 * A **plain object table**, not file-based routing: `vue-router@5` merged
 * `unplugin-vue-router` into core, and it is worth exactly nothing for roughly
 * ten routes (docs/12-frontend-architecture.md §2.2). Coming from v4 without
 * that plugin, v5 is a version bump only.
 *
 * `createWebHistory`, not `createWebHashHistory`, and that is load-bearing
 * rather than taste: the bootstrap token arrives in the *fragment*
 * (`#token=<t>`), and a router that owned the fragment would either consume the
 * handoff or break every route the moment one arrived. `../api/token.ts`'s
 * pattern is anchored for the same reason from the other side.
 *
 * **What is eager and what is lazy is the bundle budget** (AC9,
 * docs/12 §10). The plan graph is the landing view, so `@vue-flow/core` is
 * statically imported and lives in the initial chunk on purpose. Everything
 * that arrives with its own multi-megabyte dependency — the terminal
 * (`@xterm/*`), the diff surface (`@git-diff-view/*`), the cross-run dashboard
 * (`echarts`) — is a lazy route, and `packages/web/test/integration/bundle-budget.test.ts`
 * fails the build if one of them creeps into the first chunk.
 */
import { createRouter, createWebHistory, type Router, type RouterHistory } from 'vue-router';
import PlanGraphView from '../views/PlanGraphView.vue';

export const routes = [
  {
    path: '/',
    name: 'plan',
    component: PlanGraphView,
  },
  {
    path: '/runs/:runId',
    name: 'run-plan',
    component: PlanGraphView,
    props: true,
  },
  {
    // F10.2. Lazy because it is not the landing view — not because it is heavy:
    // it shares the `--state-*` palette and the version rail with the graph,
    // and its one extra dependency is the diff renderer it asks the daemon for.
    path: '/runs/:runId/evolution',
    name: 'plan-evolution',
    component: () => import('../views/PlanEvolutionView.vue'),
    props: true,
  },
  {
    // F10.5. Lazy for the same reason the scrubber is — it is not the landing
    // view — and additionally because it is the first route to pull
    // `@DeFlow/core`'s compaction module in as a *value*: `compactionChart()`
    // is KAR-09.6's rendering contract, and the boot chunk has no use for it.
    path: '/runs/:runId/context',
    name: 'run-context',
    component: () => import('../views/ContextBudgetView.vue'),
    props: true,
  },
  {
    // F10.7. The route the lazy-loading rule was written for: `@git-diff-view/*`
    // and the Shiki instance behind it are the heaviest thing in the frontend
    // that is not the plan graph, and neither belongs in the initial chunk —
    // `packages/web/test/integration/bundle-budget.test.ts` fails the build if
    // either creeps in (KAR-17.6 AC8, docs/12 §10).
    path: '/runs/:runId/diff',
    name: 'run-diff',
    component: () => import('../views/DiffReviewView.vue'),
    props: true,
  },
  {
    // F10.8. Lazy for the same reason the scrubber and the context view are —
    // not the landing view — though the board itself pulls in nothing heavier
    // than the plan graph: it is built from `../ledger/projections/gates.ts`,
    // which every route already loads.
    path: '/runs/:runId/criteria',
    name: 'run-criteria',
    component: () => import('../views/AcceptanceCriteriaView.vue'),
    props: true,
  },
  {
    // F10.9. Lazy like the rest of the non-landing views, and cheap besides:
    // the Gantt's whole dependency is the arithmetic half of d3 — four small
    // modules of pure functions — and `d3-selection` is not in the graph at all
    // (KAR-17.8 AC10, `test/no-d3-selection-in-web.test.ts`).
    path: '/runs/:runId/timeline',
    name: 'run-timeline',
    component: () => import('../views/RunTimelineView.vue'),
    props: true,
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../views/NotFoundView.vue'),
  },
] as const;

/**
 * The application's router.
 *
 * `history` is a parameter so specs can drive a memory history: a browser
 * history in a test iframe rewrites the runner's own URL, and the failure that
 * causes reads as anything but "the spec navigated".
 */
export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  return createRouter({ history, routes: [...routes] });
}
