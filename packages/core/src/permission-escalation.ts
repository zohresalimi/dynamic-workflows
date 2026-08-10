/**
 * KAR-13.4 — which permission requests reach the Operator, and what they carry
 * (docs/09-workspace-and-safety.md §8, §10.5).
 *
 * DeFlow is the ACP *client*, so it sits in the path of every file access and
 * every command execution. That is a lot of questions, and the story is the
 * *split*: the policy table answers almost all of them by itself, and the
 * handful in the F5.6 categories reach a human. A system that asks about
 * everything is a system whose _allow_ button gets pressed reflexively, which
 * is exactly the ambient-authority failure the Kiro incident turned on.
 *
 * Four decisions carry this file, and three of them are readings of the plan
 * that a reasonable implementer would get wrong.
 *
 * **Escalation is a layer *above* the ladder, never a change to it.**
 * `decidePermission` is unchanged and still owns `allow`/`deny`/`gate`; this
 * maps that answer onto `allow`/`reject`/`escalate`. Every ladder `gate`
 * escalates, and so does one family of denials — see the next paragraph — but
 * nothing here can turn a `deny` into an `allow`.
 *
 * **Network egress escalates rather than being auto-denied.**
 * [09 §10.5](../../../docs/09-workspace-and-safety.md) is explicit that *human
 * gates belong at the network-egress and identity boundary, not at the command
 * boundary*, and EPIC-13-S22's own outline has `worktree` +
 * `curl https://example.com` as an **escalate** while EPIC-08-S2 has the same
 * row as the ladder's `deny`. Both are right about their own layer: the ladder
 * says "this level does not grant network", and the escalation policy says
 * "that is precisely the question a human is for". So `level-no-network` is the
 * one deny code this file widens.
 *
 * **A path escape is refused, not negotiated.** It is the other category
 * KAR-13.4 AC2 lists, and it is deliberately *not* widened: EPIC-13-S22's
 * outline has an out-of-worktree write as a `reject`, its third scenario says a
 * symlink pointing outside is *rejected*, and offering an operator a button
 * that writes into `/etc` is how that button comes to be pressed. AC3's
 * requirement — that the **resolved** path is what is shown — is satisfied by
 * the payload below, which is built for a refusal exactly as it is for an
 * escalation, because AC9 records both.
 *
 * **`_always` is scoped to the run, and the scope is structural.** A run-scoped
 * decision is not a field somebody remembered to clear: it is read off
 * `RunState`, which is folded per run from that run's own events, so a second
 * run cannot see it and nothing is written to `.DeFlow/config.yaml` for it to
 * leak through. A permission decision that outlives its context is ambient
 * authority by another name.
 *
 * Verifies: EPIC-13-S22, EPIC-13-S23, EPIC-13-S24 · AC2, AC3, AC4
 */
import type { EventPayloadOf, PermissionContext } from './event-payloads.ts';
import type { NodeId } from './ids.ts';
import type { PermissionReason, PermissionRequest, PermissionScope } from './permission.ts';
import { decidePermission, reasonCode } from './permission.ts';
import type { HumanDeadline, HumanOption, PermissionLevel } from './plan-graph.ts';
import type { RunState } from './run-state.ts';

/**
 * What DeFlow does with a mediated request before anybody is interrupted.
 *
 * Three values rather than the ladder's three, and the difference is the point:
 * `gate` is *"nothing here can answer this"* and `escalate` is *"a person is
 * going to"*, which are the same fact only when a queue exists to put it in.
 */
export type EscalationDecision = 'allow' | 'reject' | 'escalate';

export interface EscalationAnswer {
  readonly decision: EscalationDecision;
  /** The rule that matched; `null` only on a plain allow. */
  readonly reason: PermissionReason | null;
}

/**
 * The deny codes the F5.6 categories widen into questions.
 *
 * One entry, and it is a list rather than a comparison so that adding the
 * second one is a diff a reviewer can see. `path-escape`, `level-read` and
 * `scope-violation` are deliberately absent — see the header.
 */
export const ESCALATED_DENY_CODES: readonly string[] = ['level-no-network'];

/**
 * The whole escalate/auto split, as one total function of the ladder's answer.
 *
 * Pure, like the ladder it wraps: no clock, no filesystem, no configuration
 * read. The caller supplies the already-resolved request — this cannot call
 * `realpath` and must not pretend to.
 */
export function escalationDecision(
  level: PermissionLevel,
  request: PermissionRequest,
  scope: PermissionScope,
): EscalationAnswer {
  const answer = decidePermission(level, request, scope);
  if (answer.outcome === 'allow') return { decision: 'allow', reason: null };
  if (answer.outcome === 'gate') return { decision: 'escalate', reason: answer.reason };
  return {
    decision: ESCALATED_DENY_CODES.includes(answer.reason.code) ? 'escalate' : 'reject',
    reason: answer.reason,
  };
}

/**
 * ACP's four `PermissionOptionKind` values, in the `human` node's own
 * vocabulary (§3).
 *
 * The ids **are** the kinds, so the option the operator picked, the option the
 * ledger records and the option the agent is answered with are one string all
 * the way through. An opaque id would make the run's permission history
 * unreadable for no gain, and the mapping would be a second table to keep
 * right.
 */
export const PERMISSION_ESCALATION_OPTIONS: readonly HumanOption[] = Object.freeze([
  Object.freeze({ id: 'allow_once', label: 'Allow once', effect: 'approve' as const }),
  Object.freeze({ id: 'allow_always', label: 'Allow for this run', effect: 'approve' as const }),
  Object.freeze({ id: 'reject_once', label: 'Reject once', effect: 'reject' as const }),
  Object.freeze({ id: 'reject_always', label: 'Reject for this run', effect: 'reject' as const }),
]);

/**
 * AC6 — what a deadline nobody met answers with.
 *
 * `reject_once` rather than `reject_always`: nobody decided anything about
 * this category, so the run must not behave as though somebody had. A silent
 * hang is a worse answer than a recorded refusal; a silent *policy* is worse
 * than both.
 */
export const ESCALATION_DEFAULT_OPTION_ID = 'reject_once';

/** The option ids that establish a run-scoped policy, by polarity. */
const ALWAYS: Readonly<Record<string, 'allow' | 'reject'>> = {
  allow_always: 'allow',
  reject_always: 'reject',
};

/** Everything the escalation payload is built from. */
export interface PermissionEscalationRequest {
  readonly node: NodeId;
  readonly level: PermissionLevel;
  /** The request as the mediating layer saw it, already resolved. */
  readonly request: PermissionRequest;
  /**
   * Where the command would run, or the node's worktree for an `fs/*`.
   *
   * **Required**, and the requirement is load-bearing rather than tidy:
   * `PermissionContextSchema.cwd` is `min(1)`, and a payload the schema rejects
   * is one `parseEvent` drops on the floor during replay. The escalation would
   * then be written to the ledger, never appear in the projection, never reach
   * the queue, and never be answerable — a hang with no error anywhere. Making
   * it a compile error is the only version of that guarantee that holds.
   */
  readonly cwd: string;
  /** Post-`realpath`, when the mediating layer resolved one (AC3). */
  readonly resolved?: string;
  /** The rule that matched. */
  readonly reason: PermissionReason;
  /** The node's declared write globs. */
  readonly pathScopes?: readonly string[];
  /** The node's brief, so the row reads without opening the plan. */
  readonly brief?: string;
  /** A5-1's version sniff: the sandbox actually in effect for this node. */
  readonly enforcement?: string;
  /** The ACP session the request arrived on (AC8). */
  readonly sessionId?: string;
  /** Inherited from the node, and answered with `reject_once` on expiry (AC6). */
  readonly deadline?: HumanDeadline;
}

/** The requested string, verbatim: an argv is JSON, a path is the path. */
function requestedOf(request: PermissionRequest): string {
  if (request.method === 'terminal/create') {
    return JSON.stringify({ command: request.command, args: request.args ?? [] });
  }
  return request.method === 'network' ? request.url : request.path;
}

/**
 * AC2, AC3 — the six-and-more facts the decision turns on, each as itself.
 *
 * Never a sentence. A UI cannot render the resolved path beside the requested
 * one out of prose, and a test that asserted on the prose would be asserting on
 * its wording.
 */
export function permissionContextOf(escalation: PermissionEscalationRequest): PermissionContext {
  const { request } = escalation;
  const requested = requestedOf(request);

  return {
    method: request.method,
    ...(request.method === 'terminal/create'
      ? { command: request.command, args: [...(request.args ?? [])] }
      : {}),
    cwd: escalation.cwd,
    ...(request.method === 'terminal/create' ? {} : { requested }),
    ...(escalation.resolved === undefined ? {} : { resolved: escalation.resolved }),
    rule: reasonCode(escalation.reason),
    level: escalation.level,
    ...(escalation.pathScopes === undefined ? {} : { pathScopes: [...escalation.pathScopes] }),
    ...(escalation.enforcement === undefined ? {} : { enforcement: escalation.enforcement }),
    ...(escalation.sessionId === undefined ? {} : { sessionId: escalation.sessionId }),
  };
}

/**
 * The prose half, for the person. Everything a test or a UI needs is in the
 * context above; this is the five-second read.
 *
 * The last line is the argv as JSON on purpose — unambiguous, needing no shell
 * quoting to read, and holdable against what `spawn` actually received. A queue
 * that shows a re-quoted command line and then runs a different string is an
 * approval of something the operator did not see.
 */
export function escalationPrompt(escalation: PermissionEscalationRequest): string {
  const { request } = escalation;
  const rule = reasonCode(escalation.reason);
  const subject =
    request.method === 'terminal/create'
      ? `run ${request.command}`
      : request.method === 'network'
        ? `reach ${request.url}`
        : `${request.method === 'fs/write_text_file' ? 'write' : 'read'} ${request.path}`;

  const lines = [
    `The agent asked to ${subject}, which DeFlow does not decide on its own (${rule}).`,
    `Node ${escalation.node} holds ${escalation.level} permission${
      escalation.pathScopes === undefined || escalation.pathScopes.length === 0
        ? ''
        : ` and may write ${escalation.pathScopes.join(', ')}`
    }.`,
  ];
  if (escalation.brief !== undefined) lines.push(`Its brief: ${escalation.brief}`);
  if (escalation.resolved !== undefined) {
    lines.push(`It resolves to ${escalation.resolved}.`);
  }
  if (escalation.enforcement !== undefined) {
    lines.push(`Sandbox enforcement in effect: ${escalation.enforcement}.`);
  }
  lines.push('');
  lines.push(
    request.method === 'terminal/create'
      ? JSON.stringify(request.args ?? [])
      : requestedOf(request),
  );
  return lines.join('\n');
}

/**
 * AC2 — the `human.requested` an escalation appends.
 *
 * A permission escalation is a `human` node like any other: same event, same
 * suspension, same queue, same `human.responded`. What tells it apart is the
 * presence of `reason` and `permission`, which is what
 * `approvalsProjection` already keys the `permission` kind off — so answering
 * one is answering the other, and this story needs no second respond path.
 */
export function permissionEscalationPayload(
  escalation: PermissionEscalationRequest,
): EventPayloadOf<'human.requested'> {
  return {
    node: escalation.node,
    prompt: escalationPrompt(escalation),
    options: PERMISSION_ESCALATION_OPTIONS.map((option) => ({ ...option })),
    ...(escalation.deadline === undefined ? {} : { deadline: { ...escalation.deadline } }),
    reason:
      escalation.reason.detail === undefined
        ? { code: escalation.reason.code }
        : { code: escalation.reason.code, detail: escalation.reason.detail },
    permission: permissionContextOf(escalation),
  };
}

/**
 * AC4 — what "matching" means, and it is deliberately narrow.
 *
 * The exact request, not its category: an `allow_always` for
 * `curl https://registry.example.com/token` does not authorise `curl` against
 * a different host, and EPIC-13-S24's last scenario is precisely that case. A
 * signature computed from the reason code instead would authorise an entire
 * category from one decision, which is the ambient authority the run scope
 * exists to bound.
 *
 * `cwd` is out of it on purpose: the same command approved at the worktree root
 * and then run from a subdirectory is the same decision, and the cwd is already
 * contained by the ladder before this is ever consulted.
 */
export function permissionSignature(context: PermissionContext): string {
  return JSON.stringify([
    context.method,
    context.command ?? null,
    context.args ?? null,
    context.resolved ?? context.requested ?? null,
  ]);
}

/**
 * AC4 — every `_always` chosen **in this run**, as a signature → polarity map.
 *
 * Derived, never accumulated. `RunState.humanGates` already holds every gate
 * and its answer, so this is a fold over a projection rather than a second
 * store that a restart would lose and a replay could disagree with.
 */
export function runPermissionPolicy(state: RunState): ReadonlyMap<string, 'allow' | 'reject'> {
  const policy = new Map<string, 'allow' | 'reject'>();
  for (const gate of Object.values(state.humanGates)) {
    if (gate.permission === null || gate.response === null) continue;
    const polarity = ALWAYS[gate.response.optionId];
    if (polarity === undefined) continue;
    policy.set(permissionSignature(gate.permission), polarity);
  }
  return policy;
}

/**
 * AC4 — the answer a run-scoped `_always` already gave, or `null` to ask.
 *
 * `null` is the common case and the safe one: nothing about "no policy matched"
 * implies anything about what the ladder will say next.
 */
export function permissionAutoAnswer(
  state: RunState,
  context: PermissionContext,
): 'allow' | 'reject' | null {
  return runPermissionPolicy(state).get(permissionSignature(context)) ?? null;
}

/** Whether an option id establishes a run-scoped policy, and which polarity. */
export function alwaysPolarity(optionId: string): 'allow' | 'reject' | null {
  return ALWAYS[optionId] ?? null;
}

/** The polarity an option id answers the *current* call with. */
export function optionPolarity(optionId: string): 'allow' | 'reject' | null {
  if (optionId.startsWith('allow')) return 'allow';
  if (optionId.startsWith('reject')) return 'reject';
  return null;
}
