/**
 * KAR-22.4 — the connector framework: what a connectable service has to be able
 * to say about itself before it may be registered.
 *
 * ## The type is the ADR
 *
 * `CredentialStatement` is five required strings, and that is the whole design
 * of this file. ADR-0003's amendment of 2026-08-16 says DeFlow never possesses
 * a credential belonging to a third-party service — model provider or issue
 * tracker — and the way that rule survives the *next* service being added is
 * that a service which cannot answer "who holds the token" does not compile.
 * KAR-22.6 adds Linear and Jira against this type; if either of them can only
 * be connected by DeFlow holding something, the honest answer is a service that
 * says so on the screen, not a field to paste into.
 *
 * There is no `token`, `clientId`, `secret` or `refreshToken` anywhere in this
 * module's types, and `packages/daemon/test/connector-credential-guard.test.ts`
 * reads this file's import graph to keep it that way.
 *
 * ## Why the state is derived and never stored
 *
 * For the same reason `../projects/projects.ts` derives a project's health: a
 * stored `connected` column is a cache of somebody else's credential store,
 * which changes while nobody is watching. The failure it produces is a screen
 * that is confidently wrong about whether a run will work. One child process
 * per request is cheap at the cardinality a person's machine actually has.
 */
import type { Clock } from '@DeFlow/core';
import { GITHUB } from './github.ts';

/** Every service this build can connect. KAR-22.6 adds `linear` and `jira`. */
export type ConnectorServiceId = 'github';

/**
 * The six answers a connector may give about itself.
 *
 * `unreachable` earns its place: without it a failed DNS lookup is reported as
 * an authorisation failure, and the operator re-runs a login about a network
 * cable. It is the one state where DeFlow admits it does not know.
 */
export type ConnectorStateName =
  | 'connected'
  | 'not-installed'
  | 'not-authorised'
  | 'expired'
  | 'missing-scope'
  | 'unreachable';

/**
 * Where this service's credential lives and who holds it — required of every
 * registered service, in prose, because the next reader of ADR-0003 will
 * reasonably read it as "no tokens" and needs this paragraph to hand.
 */
export interface CredentialStatement {
  /** Whose OAuth application performs the authorisation. Never DeFlow's. */
  readonly authorisedBy: string;
  /** The process or store that ends up holding the credential. */
  readonly holder: string;
  /** Where on the operator's machine it is written. */
  readonly livesIn: string;
  /** What DeFlow itself persists. For every service so far: no credential. */
  readonly deflowStores: string;
  /** The operator's own command to revoke it, and what else that affects. */
  readonly revoke: { readonly command: string; readonly affects: string };
}

/** How an operator authorises this service, and — honestly — how far a button gets. */
export interface AuthorisationRoute {
  /** The one command that performs the authorisation. */
  readonly command: string;
  /** The service's own authorisation page, which the command opens. */
  readonly url: string;
  /** Why connecting is not a single button. Rendered on the screen, not hidden here. */
  readonly whyNotOneClick: string;
}

/**
 * What a service needs in order to look at the world: a clock, and nothing
 * else.
 *
 * Deliberately narrower than `ConnectorPorts` — no database. A service may ask
 * the outside world what it knows; it may not read or write DeFlow's own state,
 * and the type is what says so.
 */
export interface ProbePorts {
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
}

export interface ConnectorService {
  readonly id: ConnectorServiceId;
  readonly label: string;
  /** Scopes DeFlow needs to read issues. Anything absent is named by name. */
  readonly requiredScopes: readonly string[];
  readonly credential: CredentialStatement;
  readonly authorisation: AuthorisationRoute;
  /**
   * This service's state on this machine, right now, for a project rooted at
   * `repoPath`.
   *
   * On the descriptor rather than in a `switch` over the id, so KAR-22.6's two
   * services arrive as two objects rather than as two more cases in somebody
   * else's function — which is the difference between a framework and a file
   * that happens to have three branches.
   */
  probe(ports: ProbePorts, repoPath: string): Promise<ConnectorState>;
  /** This repository's issues matching `query`. Called only when `probe` said `connected`. */
  listIssues(
    ports: ProbePorts,
    repoPath: string,
    query: string,
  ): Promise<readonly ConnectorIssue[]>;
}

/** What a connector reports right now. Derived per request; never persisted. */
export interface ConnectorState {
  readonly state: ConnectorStateName;
  /** The account the credential belongs to, when the service told us. */
  readonly account: string | null;
  readonly scopes: readonly string[];
  readonly missingScopes: readonly string[];
  /** One sentence saying what is true, in the service's own words where it spoke. */
  readonly message: string;
  /** The one command that changes the state, or `null` when there is none. */
  readonly action: string | null;
}

/** One issue, in the vocabulary every service is reduced to (AC3). */
export interface ConnectorIssue {
  /** `owner/repo#123` for GitHub; a tracker key for KAR-22.6's services. */
  readonly key: string;
  readonly title: string;
  readonly state: string;
  /** The reference an operator could have pasted instead — the paste path's twin. */
  readonly url: string;
}

/**
 * `raw` as a `ConnectorServiceId`, or `null`.
 *
 * The one place a path parameter becomes a service, so an unknown service is a
 * 404 rather than a lookup that returns `undefined` three frames later.
 */
export function asServiceId(raw: string): ConnectorServiceId | null {
  return SERVICES.some((service) => service.id === raw) ? (raw as ConnectorServiceId) : null;
}

export function serviceById(id: ConnectorServiceId): ConnectorService {
  const found = BY_ID.get(id);
  // Unreachable by construction — `asServiceId` is the only way to obtain one —
  // and a throw rather than a `!` so a future registry edit fails loudly.
  if (found === undefined) throw new Error(`no connector service '${id}' is registered`);
  return found;
}

/**
 * Every registered service, in the order the screen lists them.
 *
 * One array. KAR-22.6 AC1's "a second screen is a defect" is enforced by there
 * being one of these and one route family over it.
 */
export const SERVICES: readonly ConnectorService[] = [GITHUB];

const BY_ID = new Map<ConnectorServiceId, ConnectorService>(
  SERVICES.map((service) => [service.id, service]),
);
