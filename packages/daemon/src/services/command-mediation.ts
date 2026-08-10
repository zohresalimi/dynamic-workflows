/**
 * KAR-08.3 — command mediation at the ACP `terminal/create` boundary
 * (docs/09-workspace-and-safety.md §§10.3–10.5).
 *
 * @DeFlow/core's `decidePermission` decides; it may not touch a filesystem and
 * it may not ask a human. This is the half that does both, and everything in
 * it exists because of one argument from §10.5:
 *
 * > **A gate that fires 200 times in a run is auto-clicked, and is worse than
 * > no gate.**
 *
 * So the design is default-deny on the *binary* — cheap, per repository, and
 * matched on the resolved name so `./node_modules/.bin/vitest` is `vitest` —
 * plus a small syntactic layer, and nothing else. Everything the repository
 * actually does runs free inside its worktree, and the questions that reach
 * the operator are the ones at the identity and network boundary.
 *
 * Four decisions here are load-bearing.
 *
 * **A gate suspends the request; it does not pre-authorise it.** `mediate`
 * emits `human.requested` and then awaits, and the terminal service has no way
 * to spawn anything until it resolves. Creating the terminal optimistically
 * and killing it on a rejection is a different, wrong design: the process has
 * already run by then.
 *
 * **The command shown is the command run.** The escalation carries the argv as
 * data and the prompt renders it as JSON on its own line — not as a shell
 * command line, because a queue that shows a normalised or re-quoted form and
 * then runs a different string is an approval of something the operator did
 * not see. Nothing between here and `spawn` re-joins or re-splits it.
 *
 * **A gate with nowhere to go is a rejection.** EPIC-13 owns the approval
 * queue; until it is wired up, `escalate` is absent and this fails closed.
 *
 * **The cwd is contained the same way a path is.** An allowlisted `git` with a
 * cwd outside the worktree is a full escape with no exotic syntax at all, and
 * it is the check that gets omitted because the command and args get all the
 * attention. It reuses KAR-08.2's `contain`, so it inherits route 4 — the
 * lexically-inside, `realpath`-outside case — rather than re-deriving it.
 *
 * Verifies: EPIC-08-S12, EPIC-08-S13, EPIC-08-S14, EPIC-08-S15 · AC1–AC8
 */
import type {
  PermissionAnswer,
  PermissionLevel,
  PermissionReason,
  PermissionScope,
} from '@DeFlow/core';
import { decidePermission, type NodeId } from '@DeFlow/core';
import {
  createPathMediator,
  type MediationDenial,
  type PathFs,
  type PathMediator,
  PermissionDeniedError,
} from './path-mediation.ts';
import type { CommandPolicy, CreateTerminalRequest } from './terminal-service.ts';

/** The agent's request, before anything is resolved. */
export interface CommandRequest {
  readonly command: string;
  readonly args?: readonly string[];
  /** `null` and absent both mean "the node's worktree" — ACP sends the former. */
  readonly cwd?: string | null;
}

/** The same request with its cwd resolved: what the operator is shown and what
 * `spawn` is given, and there is exactly one of it. */
export interface ResolvedCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/** A refused `terminal/create`, in the shape `permission.denied` records. */
export interface CommandDenial extends MediationDenial {
  readonly method: 'terminal/create';
}

/** A `terminal/create` on its way to whoever asks the operator. */
export interface CommandGate {
  readonly level: PermissionLevel;
  readonly request: ResolvedCommand;
  readonly reason: PermissionReason;
}

/** What came back. `null` from an `escalate` means nobody is ever going to
 * answer — the run was cancelled while the request was outstanding — which is
 * a first-class outcome and not an error. */
export type CommandApproval = 'approve' | 'reject';

/**
 * What the ladder said and what happened, as a record.
 *
 * `outcome` is the ladder's; `answered` is the operator's. Collapsing the two
 * loses one of them, and both are needed: §10.5's budget counts gates whether
 * or not they were approved, and the audit trail needs to know the answer.
 */
export interface CommandDecision {
  readonly level: PermissionLevel;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly outcome: PermissionAnswer['outcome'];
  readonly reason: PermissionReason | null;
  readonly answered: 'allow' | 'reject' | 'cancelled';
}

export type CommandMediation =
  | { readonly outcome: 'allow'; readonly cwd: string }
  | { readonly outcome: 'deny'; readonly denial: CommandDenial };

export interface CommandMediatorPorts {
  readonly level: PermissionLevel;
  readonly scope: PermissionScope;
  /** The containment half of KAR-08.2, for the cwd. Defaults to a mediator
   * over the real filesystem and this node's own scope. */
  readonly paths?: PathMediator;
  /** Only to build the default `paths`; ignored when one is supplied. */
  readonly fs?: PathFs;
  /**
   * Asks a human. Absent means no approval queue is wired up yet, and a gate
   * fails closed — see ./permission-ladder.ts, which fails closed the same
   * way for `session/request_permission`.
   */
  readonly escalate?: (gate: CommandGate) => Promise<CommandApproval | null>;
  /**
   * KAR-13.4 — which ladder answers are questions rather than verdicts.
   *
   * Defaults to `gate` and nothing else, which is what KAR-08.3 shipped and
   * what EPIC-08-S14 asserts. EPIC-13 supplies `@DeFlow/core`'s
   * `escalationDecision`-shaped predicate, which additionally widens
   * `level-no-network` — [09 §10.5](../../../../docs/09-workspace-and-safety.md)
   * puts human gates at the network-egress boundary, and EPIC-13-S22's outline
   * has `worktree` + `curl` as an escalation. A predicate rather than a
   * hard-coded set, because *which* boundary needs a human is the epic's
   * decision to make and this file's job is only to route it.
   */
  readonly escalates?: (answer: PermissionAnswer) => boolean;
  /** Every decision, gated or not: this is what a gate-budget assertion
   * counts, and what a node inspector renders. */
  readonly record?: (decision: CommandDecision) => void;
}

export interface CommandMediator {
  mediate(request: CommandRequest): Promise<CommandMediation>;
}

/**
 * The whole request, verbatim, as the `requested` field of a
 * `permission.denied`.
 *
 * JSON rather than a shell line for the same reason the prompt is: a command
 * is an argv, and the audit trail of a refused one has to be able to answer
 * "what exactly was asked for" without anybody having to un-quote it.
 */
const rendered = (request: ResolvedCommand): string =>
  JSON.stringify({ command: request.command, args: request.args, cwd: request.cwd });

export function createCommandMediator(ports: CommandMediatorPorts): CommandMediator {
  const paths =
    ports.paths ??
    createPathMediator({
      level: ports.level,
      scope: ports.scope,
      ...(ports.fs === undefined ? {} : { fs: ports.fs }),
    });

  return {
    async mediate(request) {
      const args = request.args ?? [];
      const requestedCwd =
        request.cwd === undefined || request.cwd === null ? ports.scope.worktree : request.cwd;

      const record = (
        resolved: ResolvedCommand,
        outcome: PermissionAnswer['outcome'],
        reason: PermissionReason | null,
        answered: CommandDecision['answered'],
      ): void =>
        ports.record?.({
          level: ports.level,
          command: resolved.command,
          args: resolved.args,
          cwd: resolved.cwd,
          outcome,
          reason,
          answered,
        });

      /** Allowed — by the ladder outright, or by the operator after a gate. The
       * gate's reason survives the approval: §10.5's budget counts questions
       * asked, not questions refused. */
      const allowed = (
        resolved: ResolvedCommand,
        reason: PermissionReason | null,
      ): CommandMediation => {
        record(resolved, reason === null ? 'allow' : 'gate', reason, 'allow');
        return { outcome: 'allow', cwd: resolved.cwd };
      };

      /** Refused — whether by the ladder or by the operator. The reason is the
       * ladder's own code either way, because that is the only information a
       * refusal carries. */
      const refused = (
        resolved: ResolvedCommand,
        outcome: 'deny' | 'gate',
        reason: PermissionReason,
        answered: 'reject' | 'cancelled',
      ): CommandMediation => {
        record(resolved, outcome, reason, answered);
        return {
          outcome: 'deny',
          denial: {
            level: ports.level,
            method: 'terminal/create',
            requested: rendered(resolved),
            reason,
          },
        };
      };

      // The cwd first, and as a *denial* rather than a question: a path escape
      // is refused, not negotiated, and escalating one would put the operator
      // in the position of being able to approve it.
      const contained = await paths.contain(requestedCwd);
      if (contained.outcome === 'outside') {
        return refused(
          { command: request.command, args, cwd: requestedCwd },
          'deny',
          { code: 'path-escape', detail: 'cwd' },
          'reject',
        );
      }

      const resolved: ResolvedCommand = { command: request.command, args, cwd: contained.path };
      const answer = decidePermission(
        ports.level,
        { method: 'terminal/create', command: resolved.command, args, cwd: resolved.cwd },
        ports.scope,
      );

      if (answer.outcome === 'allow') return allowed(resolved, null);

      // KAR-13.4: a `deny` the escalation policy has widened into a question is
      // recorded as the `gate` it became, because that is what happened — the
      // §10.5 budget counts questions asked, and an approved egress that read
      // back as a denial would be unauditable.
      const escalated = ports.escalates?.(answer) ?? answer.outcome === 'gate';
      if (!escalated) return refused(resolved, answer.outcome, answer.reason, 'reject');

      // A gate with nowhere to go is a rejection: no queue is wired up, and
      // the one thing this must never do is fail open.
      if (ports.escalate === undefined) {
        return refused(resolved, 'gate', answer.reason, 'reject');
      }

      const approval = await ports.escalate({
        level: ports.level,
        request: resolved,
        reason: answer.reason,
      });
      if (approval === null) return refused(resolved, 'gate', answer.reason, 'cancelled');
      return approval === 'approve'
        ? allowed(resolved, answer.reason)
        : refused(resolved, 'gate', answer.reason, 'reject');
    },
  };
}

// ── the escalation ───────────────────────────────────────────────────────────

/**
 * What DeFlow offers the operator on a gated command.
 *
 * Two options, in the `human` node's own vocabulary (§3), because this lands
 * in the same approval queue as every other human gate and a second vocabulary
 * there would be a second thing to render.
 */
export const COMMAND_GATE_OPTIONS = [
  { id: 'approve', label: 'Run it', effect: 'approve' },
  { id: 'reject', label: 'Do not run it', effect: 'reject' },
] as const;

export interface CommandGatePayload {
  readonly node: NodeId;
  readonly prompt: string;
  readonly options: typeof COMMAND_GATE_OPTIONS;
  readonly reason: { readonly code: string; readonly detail?: string };
}

/**
 * The `human.requested` payload a gated command writes.
 *
 * The prompt's last line is the argv as JSON, and that is deliberate: it is
 * unambiguous, it needs no shell quoting to read, and a test — and a UI — can
 * hold it against what `spawn` received without either of them having to parse
 * a command line. The reason travels beside it as a code, because that is what
 * the queue groups by and what the gate budget counts; the prose is for the
 * human and the code is for everything else.
 */
export function commandGatePayload(gate: CommandGate, node: NodeId): CommandGatePayload {
  const { code, detail } = gate.reason;
  const rendering = detail === undefined ? code : `${code}:${detail}`;
  return {
    node,
    prompt: [
      `The agent asked to run a command DeFlow does not allow on its own (${rendering}).`,
      `It would run at ${gate.request.cwd} with the node's ${gate.level} permission.`,
      '',
      rendered(gate.request),
    ].join('\n'),
    options: COMMAND_GATE_OPTIONS,
    reason: detail === undefined ? { code } : { code, detail },
  };
}

export interface HumanCommandGatePorts {
  readonly node: NodeId;
  /** Appends the `human.requested` event. Called **before** anybody is asked,
   * so the queue can never be behind the wait. */
  readonly emit: (payload: CommandGatePayload) => void;
  /** Waits for the operator. Resolving `null` means nobody will answer. */
  readonly ask: (gate: CommandGate) => Promise<CommandApproval | null>;
}

/** The `escalate` port, as the daemon builds it: emit, then wait. */
export function humanCommandGate(
  ports: HumanCommandGatePorts,
): (gate: CommandGate) => Promise<CommandApproval | null> {
  return (gate) => {
    ports.emit(commandGatePayload(gate, ports.node));
    return ports.ask(gate);
  };
}

// ── what the terminal service sees ───────────────────────────────────────────

export interface WorktreeCommandPolicyOptions {
  /**
   * Called once per denial, before it is thrown — where the
   * `permission.denied` event is appended. Absent means nothing is recorded,
   * which is honest for a spec and wrong for a run.
   */
  readonly onDenied?: (denial: CommandDenial) => void;
}

/**
 * The `CommandPolicy` ./terminal-service.ts takes, backed by the mediator.
 *
 * It answers with the **cwd to use**, for the same reason KAR-08.2's path
 * policy answers with the path to use: a service that resolved the cwd itself
 * and then asked whether the policy liked the result would have two
 * resolutions of the same string, and the one the kernel saw would be the one
 * nobody checked.
 */
export function worktreeCommandPolicy(
  mediator: CommandMediator,
  options: WorktreeCommandPolicyOptions = {},
): CommandPolicy {
  return {
    async authorize(request: CreateTerminalRequest) {
      const mediation = await mediator.mediate(request);
      if (mediation.outcome === 'allow') return mediation.cwd;
      options.onDenied?.(mediation.denial);
      throw new PermissionDeniedError(mediation.denial);
    },
  };
}
