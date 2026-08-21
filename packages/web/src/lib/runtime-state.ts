/**
 * KAR-26.4 — the runtime state word: the short word a settings runtime row
 * shows beside its status dot, resolved from the fields the daemon already
 * sends and from nothing else.
 *
 * Verifies: EPIC-26-S25 · AC1
 *
 * ## The rule this table exists to keep
 *
 * The epic's standing rule is "no invented facts": the word is a *total
 * mapping* from `enabled` (the operator's own setting, `GET /providers`),
 * `available` and `routes.acp` (`GET /providers/routes`' row), and what
 * actually became of the route report itself — never a claim composed in the
 * browser. The blueprint's own words (`healthy`, `warm`) are deliberately not
 * used: `available` is documented on `ProviderOption` as "whether a run may be
 * started on it", which is not a health assertion, and nothing on the wire
 * backs `warm` at all. Each word below restates one daemon fact — or names an
 * absence as an absence:
 *
 * - `disabled` — `enabled: false`. Checked first and unconditionally, copying
 *   `providerVerdict()`'s own precedence (its comment: "so an installed
 *   provider the operator disabled never renders the 'installed' sentence").
 * - `ready` — `available: true` with `routes.acp === 'available'`: every turn
 *   kind is served.
 * - `partial` — `available: true` with `routes.acp === 'missing'`: exactly the
 *   condition under which the daemon composes its own `limitation` sentence
 *   (`renderRouteLimitation`'s `unservedTurns.length > 0`). `acp` is typed as
 *   the closed `RouteState` set, `null`-able: a report whose `acp` field is
 *   absent or unreadable resolves to `unknown` below, never to `partial` —
 *   "node execution is unserved" is a positive claim, and an absent field is
 *   not evidence for it.
 * - `unusable` — `available: false`. `providerRoutes()` cannot open `acp`
 *   while `shim` is closed (`acp: 'available'` requires `shim === 'available'`),
 *   so the unavailable-yet-acp-open combination is unreachable on the wire —
 *   it still resolves here, through this same row, rather than crashing or
 *   being special-cased.
 * - `unreported` / `unknown` — both are *client* facts. `unreported` means a
 *   report **arrived**, said `known: true`, and carried no row for this
 *   provider — a real absence inside a real report (unreachable from today's
 *   daemon, whose two routes iterate one registry, but the table answers it
 *   rather than crashing the day they drift). `unknown` covers every state in
 *   which no per-row verdict exists at all: the daemon itself said
 *   `known: false` because it booted without `providerRoots`
 *   (`'machine-unknown'`), or no report reached this tab in the first place —
 *   a failed or still-outstanding `GET /providers/routes`
 *   (`'unavailable'`). Both honestly read "cannot say whether … is installed
 *   or usable"; conflating either with `unreported` would put an affirmative
 *   claim about a report's contents on a report that does not exist, which is
 *   the exact composed-in-the-browser claim this module forbids.
 *
 * `route` (the `'shim' | 'acp' | null` field) is deliberately not an input:
 * `routeForNextTurn()` returns non-null exactly when `available` is true, so
 * it carries no bit `available` does not. `state` (`AgentInstallState`) is
 * not read either — it is a second producer of the same claim, and two
 * producers of one word is the drift this table exists to prevent.
 *
 * Shaped like `./connector-status.ts` — a pure, total table beside its own
 * `it.each` spec — for the same reason that file gives: an input this
 * function has no answer for must not exist.
 */

/** One per-turn route's state — the closed set `providerRoutes()` emits. */
export type RouteState = 'available' | 'missing';

/** The slice of one `GET /providers/routes` row this module reads. */
export interface RuntimeRouteReport {
  /** "Whether a run may be started on it" — the daemon's own field. */
  readonly available: boolean;
  /** `routes.acp` — `'available'` when the node-execution turn is served,
   *  `null` when the row carried no readable value at all. */
  readonly acp: RouteState | null;
}

/**
 * What became of `GET /providers/routes` itself — the client-side fact the
 * per-row `report` cannot carry:
 *
 * - `'reported'` — a report arrived and said `known: true`;
 * - `'machine-unknown'` — a report arrived and said `known: false` (the
 *   daemon booted without `providerRoots`);
 * - `'unavailable'` — no report reached this tab: the request failed,
 *   rejected, or has not answered yet.
 */
export type RouteReportStatus = 'reported' | 'machine-unknown' | 'unavailable';

export interface RuntimeStateInput {
  /** `GET /providers` — the operator's own setting. */
  readonly enabled: boolean;
  /** The route report's row for this provider, or `null` when it carried
   *  none (which is every provider when `reportStatus` is not `'reported'`). */
  readonly report: RuntimeRouteReport | null;
  /** What became of the report itself. Only read when `report` is null. */
  readonly reportStatus: RouteReportStatus;
}

export type RuntimeStateWord =
  | 'disabled'
  | 'ready'
  | 'partial'
  | 'unusable'
  | 'unreported'
  | 'unknown';

export interface ResolvedRuntimeState {
  readonly word: RuntimeStateWord;
  /** `UiChip`'s existing vocabulary — presentation, derived from the word. */
  readonly tone: 'ok' | 'warn' | 'neutral';
}

/**
 * The one word and tone a runtime row's status chip renders. Pure and total:
 * every combination of the three inputs has exactly one row in the table the
 * header comment lays out.
 */
export function resolveRuntimeState(input: RuntimeStateInput): ResolvedRuntimeState {
  // `providerVerdict()`'s own precedence, copied rather than invented: the
  // operator's `enabled: false` wins before any probe result is read.
  if (!input.enabled) return { word: 'disabled', tone: 'neutral' };

  if (input.report === null) {
    // Only a report that actually arrived and claimed to know this machine
    // can be said to have "not reported" a provider; every other absence is
    // an absence of information, worded as one.
    return input.reportStatus === 'reported'
      ? { word: 'unreported', tone: 'neutral' }
      : { word: 'unknown', tone: 'neutral' };
  }

  if (input.report.available) {
    if (input.report.acp === 'available') return { word: 'ready', tone: 'ok' };
    if (input.report.acp === 'missing') return { word: 'partial', tone: 'warn' };
    // `acp: null` — the row carried no readable per-turn value. "partial" is
    // a positive claim (`limitation` exists, turns go unserved) and cannot be
    // made from a missing field.
    return { word: 'unknown', tone: 'neutral' };
  }

  return { word: 'unusable', tone: 'warn' };
}
