/**
 * KAR-08.1 AC6, AC7 — the `PermissionDecider` that answers the agent from
 * @DeFlow/core's ladder.
 *
 * Everything that is a *decision* lives in `decidePermission`, which is pure
 * and has no idea ACP exists. What lives here is the translation either side
 * of it: ACP's `ToolKind` and `ToolCallLocation` into a `PermissionRequest`,
 * and the ladder's three outcomes back into a `RequestPermissionOutcome`. That
 * split is the point of the story — when ACP v2 moves permission requests into
 * a different envelope, this file changes and the safety model does not.
 *
 * Three rules are worth stating because each one is a place a plausible
 * implementation goes wrong.
 *
 * **The agent's option list is authoritative.** DeFlow answers with an
 * `optionId` the agent offered, chosen by *kind*. Inventing an id — or
 * assuming `allow_once` is always present — is a protocol error wearing the
 * costume of a permission grant. When the agent offers nothing of the polarity
 * the ladder decided, the honest answer is `cancelled`, not a guess.
 *
 * **A request the ladder cannot see the subject of is gated, not allowed.** An
 * adapter that populates no `ToolCallLocation` leaves nothing to check a path
 * against; default-deny means that reaches a human. KAR-08.7 is the other half
 * of that story — the completion-time diff for the same adapters.
 *
 * **A gate with nowhere to go is a rejection.** KAR-08.3 and EPIC-13 own the
 * approval queue; until they land, `escalate` is absent and this fails closed.
 * The one thing it must never do is fail open.
 *
 * Verifies: EPIC-08-S5, EPIC-08-S6 · AC6, AC7
 */
import type {
  PermissionAnswer,
  PermissionLevel,
  PermissionReason,
  PermissionRequest,
  PermissionScope,
} from '@DeFlow/core';
import { decidePermission, optionIdFor } from '@DeFlow/core';
import type {
  PermissionDecider,
  PermissionDecision,
  PermissionQuery,
} from './permission-service.ts';

/** A gated request, on its way to whoever asks the operator. */
export interface GatedPermissionRequest {
  readonly query: PermissionQuery;
  readonly request: PermissionRequest | null;
  readonly reason: PermissionReason;
}

/**
 * What the ladder decided and what DeFlow answered, as a record.
 *
 * Structured rather than a message: the node inspector renders it, KAR-08.3's
 * gate budget counts it, and `permission.denied`'s payload is built from it.
 */
export interface LadderDecision {
  readonly query: PermissionQuery;
  readonly level: PermissionLevel;
  readonly method: PermissionRequest['method'] | 'unknown';
  readonly path: string | null;
  readonly outcome: PermissionAnswer['outcome'];
  readonly reason: PermissionReason | null;
  /** What went back on the wire — `allow`/`reject` name the polarity of the
   * option selected, and `cancelled` is the other arm of the union entirely. */
  readonly answered: 'allow' | 'reject' | 'cancelled';
}

export interface LadderPorts {
  readonly level: PermissionLevel;
  readonly scope: PermissionScope;
  /**
   * Asks a human. Resolving `null` means nobody is going to answer — the run
   * was cancelled while the request was outstanding — and that is a first-class
   * outcome, not an error. Absent means no queue is wired up yet, and a gate
   * fails closed.
   */
  readonly escalate?: (request: GatedPermissionRequest) => Promise<PermissionDecision | null>;
  readonly record?: (decision: LadderDecision) => void;
}

/**
 * ACP's `ToolKind` onto the ladder's methods.
 *
 * Almost one-to-one, as §8.2 says. `think` and `switch_mode` touch nothing
 * outside the agent, so there is nothing for the ladder to decide and they are
 * allowed; `other` is the honest unknown and is gated.
 */
const METHOD_FOR: Readonly<
  Record<PermissionQuery['toolKind'], PermissionRequest['method'] | null>
> = {
  read: 'fs/read_text_file',
  search: 'fs/read_text_file',
  edit: 'fs/write_text_file',
  delete: 'fs/write_text_file',
  move: 'fs/write_text_file',
  execute: 'terminal/create',
  fetch: 'network',
  think: null,
  switch_mode: null,
  other: null,
};

/** `think` and `switch_mode`: nothing leaves the agent, so nothing is decided. */
const FREE_KINDS: readonly PermissionQuery['toolKind'][] = ['think', 'switch_mode'];

function requestOf(query: PermissionQuery): PermissionRequest | null {
  const method = METHOD_FOR[query.toolKind];
  if (method === null) return null;
  const path = query.locations[0]?.path;
  if (path === undefined) return null;

  if (method === 'fs/read_text_file' || method === 'fs/write_text_file') return { method, path };
  if (method === 'network') return { method, url: path };
  // `session/request_permission` for an `execute` tool carries a location, not
  // an argv — the argv arrives at `terminal/create` itself, which KAR-08.3
  // mediates. What can be checked here is where it would run.
  return { method, command: 'sh', cwd: path };
}

export function ladderDecider(ports: LadderPorts): PermissionDecider {
  return async (query: PermissionQuery): Promise<PermissionDecision> => {
    const request = requestOf(query);
    const answer: PermissionAnswer =
      request !== null
        ? decidePermission(ports.level, request, ports.scope)
        : FREE_KINDS.includes(query.toolKind)
          ? { outcome: 'allow' }
          : { outcome: 'gate', reason: { code: 'not-allowlisted', detail: query.toolKind } };

    const reason = answer.outcome === 'allow' ? null : answer.reason;

    const finish = (decision: PermissionDecision, answered: LadderDecision['answered']) => {
      ports.record?.({
        query,
        level: ports.level,
        method: request?.method ?? 'unknown',
        path: query.locations[0]?.path ?? null,
        outcome: answer.outcome,
        reason,
        answered,
      });
      return decision;
    };

    const respond = (polarity: 'allow' | 'reject'): PermissionDecision => {
      const optionId = optionIdFor(polarity === 'allow' ? 'allow' : 'deny', query.options);
      return optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId };
    };

    if (answer.outcome !== 'gate') {
      const polarity = answer.outcome === 'allow' ? 'allow' : 'reject';
      const decision = respond(polarity);
      return finish(decision, decision.outcome === 'cancelled' ? 'cancelled' : polarity);
    }

    if (ports.escalate === undefined) {
      const decision = respond('reject');
      return finish(decision, decision.outcome === 'cancelled' ? 'cancelled' : 'reject');
    }

    const chosen = await ports.escalate({ query, request, reason: answer.reason });
    if (chosen === null) return finish({ outcome: 'cancelled' }, 'cancelled');
    if (chosen.outcome === 'cancelled') return finish(chosen, 'cancelled');

    const kind = query.options.find((option) => option.optionId === chosen.optionId)?.kind;
    return finish(chosen, kind !== undefined && kind.startsWith('allow') ? 'allow' : 'reject');
  };
}
