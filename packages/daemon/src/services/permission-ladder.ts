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
 * **KAR-08.7 AC2 layers one more check on top, after the ladder, never
 * instead of it.** A node's declared `pathScope` is checked only once the
 * ladder itself has said `allow` to a write — a denial for level or
 * containment reasons is the more specific answer and must not be
 * overwritten by a less specific one — and only for `fs/write_text_file`,
 * because a declared *write* scope has nothing to say about a read. The
 * result is `scope-violation`, added to @DeFlow/core's own closed deny-code
 * vocabulary rather than invented here, so a denial is one shape whichever
 * check produced it. The other half of AC2 — an adapter that never populates
 * `ToolCallLocation` at all, so this check never runs — is `./scope-diff.ts`'s
 * completion-time backstop (AC3).
 *
 * Verifies: EPIC-08-S5, EPIC-08-S6, EPIC-08-S11 · AC6, AC7 (KAR-08.1);
 * AC2, AC6 (KAR-08.7)
 */
import type {
  NodeId,
  PermissionAnswer,
  PermissionLevel,
  PermissionReason,
  PermissionRequest,
  PermissionScope,
} from '@DeFlow/core';
import {
  decidePermission,
  optionIdFor,
  pathScopeMatches,
  REQUESTED_PATH_MAX,
  relativeToWorktree,
} from '@DeFlow/core';
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
  /**
   * KAR-08.7 AC2 — the node's declared write globs, present only when
   * `reason.code` is `scope-violation`. Its own field rather than folded into
   * `reason.detail`: the node inspector renders `requested` beside `declared`,
   * and neither is a sentence (EPIC-08-S11 scenario 2).
   */
  readonly declared: readonly string[] | null;
  /** What went back on the wire — `allow`/`reject` name the polarity of the
   * option selected, and `cancelled` is the other arm of the union entirely. */
  readonly answered: 'allow' | 'reject' | 'cancelled';
}

export interface LadderPorts {
  readonly level: PermissionLevel;
  readonly scope: PermissionScope;
  /**
   * KAR-08.7 AC2 — the node's declared write globs (`pathScopes.write`).
   * Absent or empty means there is nothing to check here: AC1's plan-time
   * validation is what refuses an empty scope on a real write node, and this
   * port does not re-police that — it only ever *narrows* an `allow` the
   * ladder already gave.
   */
  readonly pathScope?: readonly string[];
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

/**
 * KAR-08.7 AC2, AC6 — whether `request` (already established, by the ladder,
 * to land inside the worktree) also lands inside the node's declared scope.
 *
 * Normalized through the same `relativeToWorktree` KAR-08.2's `contain()`
 * resolves against, so `./src/a.ts`, `src/a.ts` and `<worktree>/src/a.ts`
 * agree with request-time enforcement about what "in scope" means (AC6).
 * `null` means no violation — including "nothing declared", which is a
 * plan-validation question (AC1) this port does not re-ask.
 */
function scopeViolationOf(
  request: PermissionRequest | null,
  pathScope: readonly string[] | undefined,
  worktree: string,
): { readonly relative: string; readonly declared: readonly string[] } | null {
  if (request === null || request.method !== 'fs/write_text_file') return null;
  if (pathScope === undefined || pathScope.length === 0) return null;
  const relative = relativeToWorktree(worktree, request.path);
  return pathScopeMatches(pathScope, relative) ? null : { relative, declared: pathScope };
}

export function ladderDecider(ports: LadderPorts): PermissionDecider {
  return async (query: PermissionQuery): Promise<PermissionDecision> => {
    const request = requestOf(query);
    let answer: PermissionAnswer =
      request !== null
        ? decidePermission(ports.level, request, ports.scope)
        : FREE_KINDS.includes(query.toolKind)
          ? { outcome: 'allow' }
          : { outcome: 'gate', reason: { code: 'not-allowlisted', detail: query.toolKind } };

    // Only narrows an `allow`: a denial the ladder already made — for the
    // level, for containment — is the more specific answer, and AC2 never
    // overwrites it with a less specific one.
    let declared: readonly string[] | null = null;
    if (answer.outcome === 'allow') {
      const violation = scopeViolationOf(request, ports.pathScope, ports.scope.worktree);
      if (violation !== null) {
        answer = {
          outcome: 'deny',
          reason: { code: 'scope-violation', detail: violation.relative },
        };
        declared = violation.declared;
      }
    }

    const reason = answer.outcome === 'allow' ? null : answer.reason;

    const finish = (decision: PermissionDecision, answered: LadderDecision['answered']) => {
      ports.record?.({
        query,
        level: ports.level,
        method: request?.method ?? 'unknown',
        path: query.locations[0]?.path ?? null,
        outcome: answer.outcome,
        reason,
        declared,
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

// ── the ledger event a denial produces ───────────────────────────────────────

/**
 * KAR-08.7 AC2 — the `permission.denied` payload a deny `LadderDecision`
 * produces, in the shape `@DeFlow/core`'s `PermissionDeniedSchema` accepts.
 * Mirrors `path-mediation.ts`'s `permissionDeniedPayload` — one shape across
 * both mediation layers — but built from a `LadderDecision` rather than a
 * `MediationDenial`, because `session/request_permission` is answered here,
 * not there.
 *
 * `null` for anything that is not a plain, communicated denial: a `gate`
 * left unhandled by an approval queue (KAR-08.3/EPIC-13) is a rejection of a
 * *different* question and is not this function's to record; a decision the
 * agent never actually saw as a rejection (`answered !== 'reject'` —
 * `cancelled` is its own outcome, KAR-08.1 AC7) never happened from the
 * agent's point of view either; and a request the ladder could not see the
 * subject of (`method: 'unknown'`) has no `method` this schema accepts.
 */
export function ladderDeniedPayload(
  decision: LadderDecision,
  node: { readonly node: NodeId; readonly attempt: number },
): {
  node: NodeId;
  attempt: number;
  permission: PermissionLevel;
  method: PermissionRequest['method'];
  requested: string;
  reason: { code: string; detail?: string };
  declared?: string[];
} | null {
  if (
    decision.outcome !== 'deny' ||
    decision.answered !== 'reject' ||
    decision.reason === null ||
    decision.path === null ||
    decision.method === 'unknown'
  ) {
    return null;
  }

  return {
    node: node.node,
    attempt: node.attempt,
    permission: decision.level,
    method: decision.method,
    requested: decision.path.slice(0, REQUESTED_PATH_MAX),
    reason:
      decision.reason.detail === undefined
        ? { code: decision.reason.code }
        : { code: decision.reason.code, detail: decision.reason.detail },
    ...(decision.declared === null ? {} : { declared: [...decision.declared] }),
  };
}
