/**
 * KAR-16.1 — the route table.
 *
 * A **plain object table**, not file-based routing: `vue-router@5` merged
 * `unplugin-vue-router` into core, and it is worth exactly nothing for roughly
 * a dozen routes (docs/12-frontend-architecture.md §2.2). Coming from v4 without
 * that plugin, v5 is a version bump only.
 *
 * `createWebHistory`, not `createWebHashHistory`, and that is load-bearing
 * rather than taste: the bootstrap token arrives in the *fragment*
 * (`#token=<t>`), and a router that owned the fragment would either consume the
 * handoff or break every route the moment one arrived. `../api/token.ts`'s
 * pattern is anchored for the same reason from the other side.
 *
 * **What is eager and what is lazy is the bundle budget** (AC9,
 * docs/12 §10). The plan graph is the run landing view, so `@vue-flow/core` is
 * statically imported and lives in the initial chunk on purpose. Everything
 * that arrives with its own multi-megabyte dependency — the terminal
 * (`@xterm/*`), the diff surface (`@git-diff-view/*`), the cross-run dashboard
 * (`echarts`) — is a lazy route, and `packages/web/test/integration/bundle-budget.test.ts`
 * fails the build if one of them creeps into the first chunk. Doubling every
 * run view into a canonical and a legacy record (KAR-25.1 AC7) doubles the
 * surface that rule inspects rather than the rule itself: `RUN_VIEWS` below
 * names each view's loader once, and both records for a view are built from
 * that one loader, so a route that is lazy stays lazy on both paths in.
 *
 * ## KAR-25.1 — Runs and Workflows moved under a project
 *
 * `/` used to be the global run list (`runs`). It is now a redirect to
 * `/projects` — the project chooser — because "which runs" stopped being a
 * question this application can answer without a project the moment Runs
 * became project-scoped (`/projects/:projectId/runs`, `project-runs`). The
 * `runs` name is gone outright rather than aliased, so a reference the rename
 * missed is a type error, not a dead row nobody notices until they click it
 * (EPIC-25-S05).
 *
 * The nine run-*detail* views (the plan graph and its eight siblings) move
 * under a project too — `/projects/:projectId/runs/:runId…` — and every one of
 * them keeps its old `/runs/:runId…` path alive as well, because a run
 * predates this rename the moment it was submitted before projects existed,
 * or from a terminal that named none. `../router/legacy-run.ts` is the whole
 * of that: `RUN_VIEWS` below is read once to build both halves of the table,
 * and `createLegacyRunGuard` (installed in `../app/create-app.ts`) decides at
 * navigation time whether a `/runs/:runId…` request redirects to its
 * project-scoped twin, renders in place, or renders `NotFoundView` — see that
 * module's header comment for the three-way branch in full.
 */
import { createRouter, createWebHistory, type Router, type RouterHistory } from 'vue-router';
import PlanGraphView from '../views/PlanGraphView.vue';
import RunListView from '../views/RunListView.vue';
import { lazyWithLegacyRunGuard, type RunViewName, withLegacyRunGuard } from './legacy-run.ts';

/**
 * The eight run-detail views, named once.
 *
 * `canonicalSuffix` and `legacySuffix` are almost always identical — the path
 * *after* `:runId` does not change shape when a project prefix is added in
 * front of it. `run-plan` is the one exception: its legacy path is the bare
 * `/runs/:runId` that has always named the plan graph, so its canonical
 * counterpart needs a segment (`/plan`) the legacy one does not, to stay
 * distinct from `project-run` (`/projects/:projectId/runs/:runId`, the
 * workflows view opened on a past run) which now occupies the path the plan
 * graph used to.
 */
interface RunViewDef {
  readonly name: RunViewName;
  readonly canonicalSuffix: string;
  readonly legacySuffix: string;
  readonly eager: boolean;
  readonly load: () => Promise<{ default: unknown }>;
}

const RUN_VIEWS: readonly RunViewDef[] = [
  {
    name: 'run-plan',
    canonicalSuffix: '/plan',
    legacySuffix: '',
    eager: true,
    load: () => Promise.resolve({ default: PlanGraphView }),
  },
  {
    name: 'plan-evolution',
    canonicalSuffix: '/evolution',
    legacySuffix: '/evolution',
    eager: false,
    load: () => import('../views/PlanEvolutionView.vue'),
  },
  {
    name: 'run-context',
    canonicalSuffix: '/context',
    legacySuffix: '/context',
    eager: false,
    load: () => import('../views/ContextBudgetView.vue'),
  },
  {
    name: 'run-diff',
    canonicalSuffix: '/diff',
    legacySuffix: '/diff',
    eager: false,
    load: () => import('../views/DiffReviewView.vue'),
  },
  {
    name: 'run-criteria',
    canonicalSuffix: '/criteria',
    legacySuffix: '/criteria',
    eager: false,
    load: () => import('../views/AcceptanceCriteriaView.vue'),
  },
  {
    name: 'run-timeline',
    canonicalSuffix: '/timeline',
    legacySuffix: '/timeline',
    eager: false,
    load: () => import('../views/RunTimelineView.vue'),
  },
  {
    name: 'run-node-output',
    canonicalSuffix: '/nodes/:nodeId/output',
    legacySuffix: '/nodes/:nodeId/output',
    eager: false,
    load: () => import('../views/NodeOutputView.vue'),
  },
  {
    name: 'run-memory',
    canonicalSuffix: '/memory',
    legacySuffix: '/memory',
    eager: false,
    load: () => import('../views/MemoryGraphView.vue'),
  },
];

/** Both records for one `RUN_VIEWS` entry: canonical first, legacy second. */
function runViewRoutes(view: RunViewDef) {
  const canonical = view.eager
    ? { component: PlanGraphView }
    : { component: view.load as () => Promise<{ default: unknown }> };
  const legacy = view.eager
    ? { component: withLegacyRunGuard(PlanGraphView) }
    : { component: lazyWithLegacyRunGuard(view.load as () => Promise<{ default: object }>) };

  return [
    {
      path: `/projects/:projectId/runs/:runId${view.canonicalSuffix}`,
      name: view.name,
      ...canonical,
      props: true,
    },
    {
      path: `/runs/:runId${view.legacySuffix}`,
      name: `legacy-${view.name}`,
      ...legacy,
      props: true,
    },
  ];
}

export const routes = [
  {
    // KAR-25.1 AC1 — `/` is the project chooser: a redirect with no component
    // and no name of its own, so `/projects` is the one route that ever
    // renders it. `../app/token.ts`'s handoff runs before this router ever
    // resolves a location (`main.ts` calls `acquireToken()` first), so this
    // redirect cannot eat a `#token=…` fragment on the way in.
    path: '/',
    redirect: { name: 'projects' },
  },
  {
    // KAR-22.1 — projects, and now the landing screen. Lazy, because it is not
    // shared with the graph: its whole dependency is the typed client the
    // shell already has.
    path: '/projects',
    name: 'projects',
    component: () => import('../views/ProjectsView.vue'),
  },
  {
    // KAR-25.2 — one global page for everything that applies to this machine.
    // Lazy like `/projects`, and a placeholder until KAR-25.2 fills it: see
    // `../views/SettingsView.vue`'s own header comment.
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
  },
  {
    // KAR-25.1 — this project's live graph, its task board and its history.
    // Renamed from `project-workspace`: "Workspace" is not user-visible
    // anywhere in this application any more (EPIC-25-S05). What the view
    // renders is unchanged; only its file name and this route's name are.
    path: '/projects/:projectId',
    name: 'project-workflows',
    component: () => import('../views/ProjectWorkflowsView.vue'),
    props: true,
  },
  {
    // KAR-25.1 — this project's run list, project-scoped where it used to be
    // global. Eager like the graph it sits beside in the rail's order,
    // and just as cheap: the transport it opens is behind a dynamic import in
    // `../app/useRunList.ts`, for the reason the run feed's is.
    path: '/projects/:projectId/runs',
    name: 'project-runs',
    component: RunListView,
    props: true,
  },
  {
    // KAR-22.4 — the project's connectors. No longer a nav row (KAR-25.1 AC1,
    // AC2 name the rail's item set exactly, and Connectors is in neither
    // list) — reached from `ProjectWorkflowsView`'s own link instead, until
    // KAR-25.4 moves the screen into `/settings`.
    path: '/projects/:projectId/connectors',
    name: 'project-connectors',
    component: () => import('../views/ConnectorsView.vue'),
    props: true,
  },
  {
    // The same workflows view, on a run from this project's history. A
    // *route* rather than a query parameter or a piece of component state,
    // because "send me what you are looking at" has to survive being pasted
    // into a message — and because the address bar is then somewhere a run id
    // is *read from*, never somewhere one has to be typed.
    path: '/projects/:projectId/runs/:runId',
    name: 'project-run',
    component: () => import('../views/ProjectWorkflowsView.vue'),
    props: true,
  },
  ...RUN_VIEWS.flatMap(runViewRoutes),
  // KAR-24.3. Dev-only, and dev-only two ways at once: the route is only
  // *registered* under `import.meta.env.DEV`, and — because Vite substitutes
  // `false` for that expression in a production build and dead-code
  // elimination removes an unreachable `?` branch's contents — the dynamic
  // `import()` inside it is never even parsed into that build's module graph.
  // `../app/create-app.ts`'s dev-only leak assertion is the precedent this
  // follows: a runtime guard around a static import only stops the route from
  // being *reached*, and would leave every one of the fifteen `ui/`
  // components, plus lucide, riding along in a chunk nothing production ever
  // opens. `packages/web/test/integration/bundle-budget.test.ts` is the proof
  // that stays true — it is unchanged by this route precisely because the
  // production build it inspects never has this array entry to begin with.
  ...(import.meta.env.DEV
    ? [
        {
          path: '/gallery',
          name: 'gallery',
          component: () => import('../views/GalleryView.vue'),
        },
      ]
    : []),
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('../views/NotFoundView.vue'),
  },
];

/**
 * The application's router.
 *
 * `history` is a parameter so specs can drive a memory history: a browser
 * history in a test iframe rewrites the runner's own URL, and the failure that
 * causes reads as anything but "the spec navigated".
 *
 * The legacy-run guard is **not** installed here — it needs the API client the
 * running application was given, which does not exist until `createDeFlowApp`
 * has an `app` to resolve it from. See `../router/legacy-run.ts`'s header
 * comment and `../app/create-app.ts`'s `router.beforeEach` call.
 */
export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  return createRouter({ history, routes: [...routes] });
}
