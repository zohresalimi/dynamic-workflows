/**
 * KAR-19.10 AC4 — the one sentence a run says about the agent it is running on.
 *
 * ## Why it is in `@DeFlow/core`
 *
 * Three surfaces have to say it: `DeFlow run`'s terminal, `GET /api/runs/:id`,
 * and the UI's run header. `@DeFlow/core` is the only package all three already
 * depend on — the browser bundle takes no dependency on `@DeFlow/adapters`, and
 * a second wording written for the UI would be the drift AC4 exists to stop.
 * So the *facts* are produced by the route reducer in `@DeFlow/adapters`
 * (`providerRoutes`), and the *sentence* is produced here, from data.
 *
 * ## Why the route is in the sentence at all
 *
 * The two routes are not interchangeable, and an operator debugging a run needs
 * to know which one they have. The exec shim is the vendor's own CLI, and it is
 * what can carry a `returns` contract — `structuredOutputFlag` lives on the CLI
 * and not on the ACP bridge (KAR-19.7). The ACP session is what carries
 * streaming, permission negotiation and cancellation. "Which agent" without
 * "by which route" is half an answer, and it is the half that was missing on
 * 2026-08-13.
 *
 * Nothing here names a provider: the id arrives as data, from
 * `provider-registry.ts` by way of admission (AC9).
 */

/**
 * The two ways DeFlow can drive an agent, as a closed set.
 *
 * `acp` spawns the ACP bridge and opens a session; `shim` spawns the vendor's
 * own CLI for one turn. A third would be a change to the adapter layer, not a
 * string added here.
 */
export const PROVIDER_ROUTES = ['acp', 'shim'] as const;

export type ProviderRoute = (typeof PROVIDER_ROUTES)[number];

/**
 * What one route answers, as a closed pair.
 *
 * Two values and not three: *"present but broken"* is a fact about a binary and
 * is carried by `AgentInstallState`, which is what the install sentence is
 * keyed on. A route is either open or it is not, because that is the only
 * question a run can act on.
 */
export const ROUTE_STATES = ['available', 'missing'] as const;

export type RouteState = (typeof ROUTE_STATES)[number];

/** The words the operator reads — the same ones `doctor`'s Agents section uses,
 * because an operator comparing the two reports is comparing strings. */
const ROUTE_LABELS: Readonly<Record<ProviderRoute, string>> = {
  acp: 'ACP adapter',
  shim: 'exec shim',
};

export function routeLabel(route: ProviderRoute): string {
  return ROUTE_LABELS[route];
}

/** True for a member of the closed set — for reading a route back off the wire
 * or out of a ledger payload, where it arrived as an unvalidated string. */
export function isProviderRoute(value: unknown): value is ProviderRoute {
  return typeof value === 'string' && (PROVIDER_ROUTES as readonly string[]).includes(value);
}

/** The three facts AC4 names, and no fourth. */
export interface ProviderChoiceFacts {
  readonly provider: string;
  /** Absolute — the path DeFlow resolved, never a name to look up later. */
  readonly binaryPath: string;
  readonly route: ProviderRoute;
}

/**
 * The announcement, as one line.
 *
 * One line rather than three, because a preamble the length of a paragraph on
 * every run is noise and gets skipped — which would put this sentence back
 * where it started. `--json` carries the same three facts as fields rather than
 * as prose, so nothing has to parse this string.
 */
export function announceProviderChoice(facts: ProviderChoiceFacts): string {
  return `provider ${facts.provider} — ${facts.binaryPath} — ${routeLabel(facts.route)} route`;
}
