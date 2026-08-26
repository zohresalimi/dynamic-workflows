/**
 * KAR-28.3 — which routes show a run, and where the run's facts are drawn.
 *
 * **The question this module answers is "does this route show a run".**
 * `AppTopBar.vue` used to ask a different one — "does this view draw its own
 * run header" — and render `RunProviderBanner`, `RunTaskBanner` and
 * `RunStatusPill` for every route that answered no. That is two categories
 * where the application has three, and the third is the one an operator ran
 * into on 2026-08-25: `/projects/:id/new-run` is not a run view at all, so the
 * composer for a run that had not been submitted yet carried the *previous*
 * run's provider, bin, route, prompt and an `aborted` status pill. Nothing
 * clears the global run store on navigation — nothing should, a tab following
 * a run keeps following it — so the fix is on the reading side: a route that
 * shows no run asks the store nothing.
 *
 * **One set of names, three categories, no default.** Every named route in
 * `./index.ts` belongs to exactly one of the three arrays below, and
 * `packages/web/src/app/topbar-run-scope.test.ts`'s S16 guard fails — naming
 * the route — the moment one is added to neither. An unrecognised name
 * classifies as `null` and therefore shows no run: the safe direction, since
 * the failure it produces is a missing banner on a new route rather than a
 * stale run silently following an operator around the application.
 *
 * **Why the run-view list is derived rather than typed out.** The eight run
 * views and their eight `legacy-*` twins are built from one array in
 * `./legacy-run.ts` (`RUN_VIEW_NAMES`) and registered from that same array by
 * `./index.ts`. Re-listing them here would be a second place to forget a view,
 * which is the class of bug this module exists to end.
 */
import { RUN_VIEW_NAMES } from './legacy-run.ts';

/**
 * Routes that show a run **and draw its facts themselves**, in
 * `../components/RunHeader.vue`.
 *
 * System law 4 — a status is said once per surface — is why the bar stays
 * quiet on these two: the same task, provider and status are the header's, as
 * a heading and a row of labelled pairs, and a second copy in the bar is a
 * second thing to keep in step.
 */
export const RUN_HEADER_ROUTE_NAMES: readonly string[] = ['project-workflows', 'project-run'];

/**
 * Routes that show a run with **no header of their own** — its plan, its
 * evolution, its context, its diff, its criteria, its timeline, a node's
 * output, its memory — at both their project-scoped and their legacy
 * addresses.
 *
 * These are where the three banners live, and KAR-24.4 AC4's "every element
 * survives" contract says they render there exactly as they always have.
 */
export const RUN_IN_BAR_ROUTE_NAMES: readonly string[] = [
  ...RUN_VIEW_NAMES,
  ...RUN_VIEW_NAMES.map((name) => `legacy-${name}`),
];

/**
 * Routes that show **no run at all**: the composer for a run that does not
 * exist yet, the project chooser, this machine's settings, a project's run
 * *list* (which is about many runs and singles out none), the component
 * gallery and the not-found page.
 *
 * `gallery` is registered under `import.meta.env.DEV` only (`./index.ts`); it
 * is named here regardless, because a route's category is a fact about the
 * route rather than about the build it ships in.
 */
export const RUNLESS_ROUTE_NAMES: readonly string[] = [
  'new-run',
  'projects',
  'settings',
  'project-runs',
  'gallery',
  'not-found',
];

/**
 * What a route does with the open run:
 *
 * - `own-header` — shows it, and draws the facts itself.
 * - `in-the-bar` — shows it, and reads the facts off the topbar.
 * - `no-run` — shows no run.
 *
 * `null` for a name this module has never heard of. See the header comment for
 * why that is not a fourth category but the absence of an answer.
 */
export type RunRouteScope = 'own-header' | 'in-the-bar' | 'no-run';

const OWN_HEADER = new Set<string>(RUN_HEADER_ROUTE_NAMES);
const IN_THE_BAR = new Set<string>(RUN_IN_BAR_ROUTE_NAMES);
const NO_RUN = new Set<string>(RUNLESS_ROUTE_NAMES);

/** Takes `route.name` as it comes — `string | symbol | null | undefined` — so
 * no caller has to stringify a route name before asking. */
export function classifyRunRoute(name: unknown): RunRouteScope | null {
  if (typeof name !== 'string') return null;
  if (OWN_HEADER.has(name)) return 'own-header';
  if (IN_THE_BAR.has(name)) return 'in-the-bar';
  if (NO_RUN.has(name)) return 'no-run';
  return null;
}

/** Does this route show a run at all — in a header of its own or in the bar? */
export function routeShowsRun(name: unknown): boolean {
  const scope = classifyRunRoute(name);
  return scope === 'own-header' || scope === 'in-the-bar';
}

/** Does this route draw the run's facts itself? */
export function routeDrawsOwnRunHeader(name: unknown): boolean {
  return classifyRunRoute(name) === 'own-header';
}

/**
 * The topbar's own question: this route shows a run, and has no header of its
 * own to show it in. Both halves matter — the first is what KAR-28.3 added,
 * the second is what KAR-24.4 already had.
 */
export function topBarShowsRun(name: unknown): boolean {
  return classifyRunRoute(name) === 'in-the-bar';
}
