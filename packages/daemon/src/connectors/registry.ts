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

/**
 * Every service this build registers.
 *
 * `linear` is registered and **not connectable**, deliberately: KAR-22.6 found
 * that Linear publishes no first-party tool that would hold a credential on the
 * operator's behalf, so connecting it would mean DeFlow holding one. A service
 * DeFlow cannot reach is still a row that says so — "not yet, and here is why"
 * is a state of the product rather than an absence from it — which is why it is
 * in this union rather than left out of it.
 */
export type ConnectorServiceId = 'github' | 'linear' | 'jira';

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
  /**
   * The operator's own command to revoke it, and what else that affects.
   *
   * `command` is `null` when there is nothing to revoke because nothing was
   * ever granted. Said rather than filled in with a plausible incantation: a
   * revocation command for a grant that does not exist is an instruction that
   * fails in a terminal, and the operator has no way to know it was DeFlow's
   * mistake rather than theirs.
   */
  readonly revoke: { readonly command: string | null; readonly affects: string };
}

/**
 * How an operator authorises this service, and — honestly — how far a button
 * gets.
 *
 * A union rather than an optional field, because the two cases are different
 * answers to the same question rather than one answer with a hole in it, and
 * the screen has to render them differently: `command` gets the command, the
 * link and the paragraph about why there is no single button; `unavailable`
 * gets the paragraph and **no button at all**. KAR-22.6 AC2 is this type.
 */
export type Authorisation = AuthorisationRoute | NoAuthorisation;

export interface AuthorisationRoute {
  readonly kind: 'command';
  /** The one command that performs the authorisation. */
  readonly command: string;
  /**
   * The service's own authorisation page, which the command opens, or `null`
   * when DeFlow does not know its address.
   *
   * Nullable because of `acli`: `acli jira auth login --web` opens Atlassian's
   * own consent page and DeFlow is not part of that conversation. A plausible
   * URL here would be a guess rendered as a link, and a link that 404s is worse
   * than no link.
   */
  readonly url: string | null;
  /** Why connecting is not a single button. Rendered on the screen, not hidden here. */
  readonly whyNotOneClick: string;
}

/**
 * There is no route: DeFlow cannot connect this service without holding a
 * credential of its own, and does not.
 *
 * The temptation this case exists to defeat is a button that opens something
 * plausible, or a field to paste an API key into. Both make the product look
 * finished; the second one ends ADR-0003. A sentence saying the truth is the
 * shipped answer (KAR-22.6 AC2).
 */
export interface NoAuthorisation {
  readonly kind: 'unavailable';
  /** What is missing, why it is missing, and what would have to change. */
  readonly whyNotConnectable: string;
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
  readonly authorisation: Authorisation;
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

/**
 * How many issues one search may return, for every service.
 *
 * Shared rather than per service, because it is a decision about *the picker* —
 * how many rows a person can usefully choose between — and not about any
 * tracker. Two services with two different limits would make the merged list
 * KAR-22.6 AC3 asks for lopsided for no reason anybody could explain.
 */
export const ISSUE_SEARCH_LIMIT = 25;

/** One issue, in the vocabulary every service is reduced to (AC3). */
export interface ConnectorIssue {
  /** `owner/repo#123` for GitHub; `TEAM-41` for Jira. */
  readonly key: string;
  readonly title: string;
  readonly state: string;
  /** The reference an operator could have pasted instead — the paste path's twin. */
  readonly url: string;
}

/**
 * Whether an operator can connect `service` at all.
 *
 * The one place that question is answered, so the connect route's refusal and
 * the screen's missing button cannot disagree about which services they are
 * talking about.
 */
export const isConnectable = (service: ConnectorService): boolean =>
  service.authorisation.kind === 'command';
