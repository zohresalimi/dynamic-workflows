/**
 * KAR-22.4 — connectors: the per-project rows, and everything that is a
 * question about the outside world.
 *
 * The division of labour is `../projects/projects.ts`'s, for the same reasons.
 * `@DeFlow/ledger`'s `./connectors.ts` owns the row and performs no I/O; this
 * module owns "is the GitHub CLI installed", "is it authorised", "does its
 * token carry the scope" and "what are this repository's issues" — and answers
 * each of them **by looking, every time it is asked**.
 *
 * **State is derived, never stored.** A `connected` column would be a cache of
 * somebody else's credential store, which changes while nobody is watching: an
 * operator who ran `gh auth logout` in another window would be told their
 * connector is fine right up until a run failed. One child process per request
 * is cheap at the cardinality a person's machine actually has, and it is always
 * true.
 *
 * **DeFlow holds no credential here.** There is no token in this file, no
 * client id, and no read of `gh`'s credential store — it does not know where
 * that store is. `packages/daemon/test/connector-credential-guard.test.ts`
 * walks this module's import graph and fails if that changes.
 */
import type { Clock, Db, ProjectId } from '@DeFlow/core';
import {
  type ConnectorRecord,
  forgetConnector,
  insertConnector,
  readConnector,
} from '@DeFlow/ledger';
import { GITHUB } from './github.ts';
import type {
  ConnectorIssue,
  ConnectorService,
  ConnectorServiceId,
  ConnectorState,
} from './registry.ts';
import { SERVICES, serviceById } from './registry.ts';

export interface ConnectorPorts {
  readonly db: Db;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
}

/** One row of the connectors screen: the consent, the live state, and the words. */
export interface ConnectorView {
  readonly id: ConnectorServiceId;
  readonly label: string;
  readonly connected: boolean;
  readonly connectedAt: string | null;
  readonly state: ConnectorState;
  readonly credential: ConnectorService['credential'];
  readonly authorisation: ConnectorService['authorisation'];
}

/**
 * `service`'s live state on this machine, for a project rooted at `repoPath`.
 *
 * Probed **whether or not the service is connected**, and deliberately: an
 * operator deciding whether to connect needs to know that `gh` is not installed
 * *before* they press the button, not after. The probe reads a state; it does
 * not read a credential, and nothing about it is gated on a project's consent.
 *
 * The work is the descriptor's own (`ConnectorService.probe`), so this module
 * has no `switch` over the service id and KAR-22.6 adds two objects rather than
 * two branches.
 */
const probe = (
  ports: ConnectorPorts,
  service: ConnectorService,
  repoPath: string,
): Promise<ConnectorState> => service.probe({ clock: ports.clock }, repoPath);

const isoOrNull = (record: ConnectorRecord | null): string | null =>
  record === null ? null : new Date(record.createdAt).toISOString();

async function viewOf(
  ports: ConnectorPorts,
  service: ConnectorService,
  projectId: ProjectId,
  repoPath: string,
): Promise<ConnectorView> {
  const record = readConnector(ports.db, projectId, service.id);
  return {
    id: service.id,
    label: service.label,
    connected: record !== null,
    connectedAt: isoOrNull(record),
    state: await probe(ports, service, repoPath),
    credential: service.credential,
    authorisation: service.authorisation,
  };
}

/** Every registered service, as the connectors screen renders it. */
export function connectorViews(
  ports: ConnectorPorts,
  projectId: ProjectId,
  repoPath: string,
): Promise<readonly ConnectorView[]> {
  return Promise.all(SERVICES.map((service) => viewOf(ports, service, projectId, repoPath)));
}

/**
 * Records that this project may use `id`, and reports the state that follows.
 *
 * Note what does **not** happen here: no browser is opened, no authorisation
 * server is called, no token is requested and none is received. Authorising is
 * the operator's own `gh auth login`, against GitHub's own application; this
 * route records consent and then tells them, honestly, whether that command has
 * been run yet. AC1's amendment is this function's whole shape.
 */
export async function connect(
  ports: ConnectorPorts,
  projectId: ProjectId,
  id: ConnectorServiceId,
  repoPath: string,
): Promise<ConnectorView> {
  insertConnector(ports.db, { projectId, service: id, createdAt: ports.clock.now() });
  return viewOf(ports, serviceById(id), projectId, repoPath);
}

export interface DisconnectResult {
  readonly service: ConnectorServiceId;
  readonly removed: boolean;
  /** Always `false`, and said out loud rather than left to be assumed. */
  readonly credentialDeleted: boolean;
  readonly revoke: ConnectorService['credential']['revoke'];
  readonly message: string;
}

/**
 * Removes this project's connector for `id`.
 *
 * **What "removed" means, precisely.** DeFlow's access to GitHub is permission
 * to spawn the operator's own `gh`; it holds no grant of its own, so there is
 * no grant of its own to revoke and no endpoint it could call to revoke one
 * without an OAuth application it does not have. Deleting the row *is* the
 * whole of DeFlow's access ending: nothing is spawned for this project
 * afterwards, which is what
 * `packages/daemon/test/integration/connectors-api.test.ts` asserts.
 *
 * The credential stays the operator's. Running `gh auth logout` on their behalf
 * would sign out every other tool on their machine that uses `gh`, so the
 * command is **named** and not run — the same choice ADR-0003 records for
 * Copilot's login, from the other end.
 */
export function disconnect(
  ports: ConnectorPorts,
  projectId: ProjectId,
  id: ConnectorServiceId,
): DisconnectResult {
  const service = serviceById(id);
  return {
    service: id,
    removed: forgetConnector(ports.db, projectId, id),
    credentialDeleted: false,
    revoke: service.credential.revoke,
    message:
      `DeFlow will no longer use ${service.label} for this project. Your ${service.label} ` +
      'credential was not touched: it is yours, not DeFlow’s.',
  };
}

export type IssueSearch =
  | { readonly outcome: 'issues'; readonly issues: readonly ConnectorIssue[] }
  | { readonly outcome: 'not-connected'; readonly message: string }
  | { readonly outcome: 'unusable'; readonly state: ConnectorState };

/**
 * This project's issues from `id`, matching `query`.
 *
 * Three outcomes and no fourth, because AC4's promise is that a permissions
 * problem is discovered *here* rather than an hour into a run:
 *
 *  - **not-connected** — the row is gone or was never made. Nothing is spawned.
 *  - **unusable** — the service is connected and its state is not `connected`.
 *    The state's own sentence and command travel with the refusal, so the
 *    composer says exactly what the connectors screen says.
 *  - **issues** — the rows, in the one vocabulary.
 *
 * The search term goes to `gh`, not to a filter here: a repository with three
 * hundred issues must not become three hundred rows on the wire.
 */
export async function searchIssues(
  ports: ConnectorPorts,
  projectId: ProjectId,
  id: ConnectorServiceId,
  repoPath: string,
  query: string,
): Promise<IssueSearch> {
  const service = serviceById(id);

  if (readConnector(ports.db, projectId, id) === null) {
    return {
      outcome: 'not-connected',
      message:
        `This project is not connected to ${service.label}. Connect it on the project's ` +
        'connectors screen, or paste an issue reference instead — that never needs a connector.',
    };
  }

  const state = await probe(ports, service, repoPath);
  if (state.state !== 'connected') return { outcome: 'unusable', state };

  return {
    outcome: 'issues',
    issues: await service.listIssues({ clock: ports.clock }, repoPath, query),
  };
}

/** Re-exported so a caller needs one import for the whole framework. */
export { GITHUB, SERVICES };
