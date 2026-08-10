/**
 * KAR-13.4 — the permission escalation, from the ACP boundary to the approval
 * queue and back (docs/09-workspace-and-safety.md §8, §10.5).
 *
 * `@DeFlow/core`'s ./../../../core/src/permission-escalation.ts decides *which*
 * requests reach a human and *what* the request carries. This is the half that
 * touches a ledger and a clock: it appends the `human.requested`, writes the
 * `node_wake` row that makes the wait durable, waits for an answer that will
 * arrive through a completely different call, and answers the agent.
 *
 * Five decisions here are load-bearing.
 *
 * **The queue row is written before anybody is asked, in one transaction with
 * its wake row.** The same rule as KAR-13.1's admission, for the same reason: a
 * crash between the two leaves either a request nothing is waiting on or a wait
 * nothing explains, and both look like a run that simply stopped.
 *
 * **The wait is a poll over the ledger, not a parked promise the answer
 * resolves.** The answer is appended by `respondToHumanNode` — a separate HTTP
 * call, possibly minutes later — and by `expireDueHumanGates` on the ticker.
 * Neither of them knows this promise exists, and neither should: an in-process
 * registry would be a second source of truth for something the ledger already
 * holds, and would answer differently after a replay.
 *
 * **The in-memory wait is exactly as durable as the session it belongs to, and
 * that is correct.** A `human` node survives a restart because it needs nothing
 * but a row; a permission escalation cannot, because the answer has to go back
 * down a pipe to a process the daemon no longer holds. AC8 is the recovery path
 * for that, and it lives in ../recovery.ts because it is a boot-time sweep.
 *
 * **An `_always` is applied before anybody is interrupted.** The run-scoped
 * policy is read off `RunState` on every request, so a second matching request
 * produces no `human.requested` at all — which is the difference between AC4
 * being implemented and being described.
 *
 * **Every decision is a `permission.decided`, including the ones nobody saw.**
 * That is AC9 and it is the whole of NF10 for this surface: a run whose ledger
 * records only the refusals cannot answer *"what was this agent allowed to
 * do"*.
 *
 * Verifies: EPIC-13-S22, EPIC-13-S23, EPIC-13-S24, EPIC-13-S25, EPIC-13-S26 ·
 * AC1, AC2, AC3, AC4, AC5, AC6, AC9
 */
import type {
  Clock,
  Db,
  EventPayloadOf,
  HumanDeadline,
  NodeId,
  PermissionAnswer,
  PermissionContext,
  PermissionDeciderKind,
  PermissionLevel,
  PermissionReason,
  PermissionRequest,
  RunId,
  RunState,
} from '@DeFlow/core';
import {
  ESCALATED_DENY_CODES,
  ESCALATION_DEFAULT_OPTION_ID,
  humanGateWakeAt,
  openHumanGate,
  optionPolarity,
  permissionAutoAnswer,
  permissionContextOf,
  permissionEscalationPayload,
  REQUESTED_PATH_MAX,
} from '@DeFlow/core';
import {
  appendEvents,
  appendEventsConsumingWakes,
  appendEventsSchedulingWakes,
  type EventDraft,
  replayRun,
} from '@DeFlow/ledger';
import type {
  CommandApproval,
  CommandDecision,
  CommandGate,
} from '../services/command-mediation.ts';
import type { PathPolicy } from '../services/fs-service.ts';
import type { MediationDenial, PathMediator } from '../services/path-mediation.ts';
import { PermissionDeniedError } from '../services/path-mediation.ts';
import type { GatedPermissionRequest, LadderDecision } from '../services/permission-ladder.ts';
import type { PermissionDecision } from '../services/permission-service.ts';

/** How often the waiter re-reads the ledger for its answer. */
const DEFAULT_POLL_MS = 100;

export interface EscalationPorts {
  readonly db: Db;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
  readonly epoch: number;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  readonly level: PermissionLevel;
  /**
   * The node's worktree, which is where an `fs/*` or a `fetch` would land and
   * the default cwd of a command that named none.
   *
   * Not optional: `PermissionContext.cwd` is what the queue row renders and
   * what `parseEvent` insists on, and an escalation whose payload the schema
   * rejects is one the projection silently drops.
   */
  readonly worktree: string;
  /** The node's declared write globs, shown beside what it asked for. */
  readonly pathScopes?: readonly string[];
  /** The node's brief, so the queue row reads without opening the plan. */
  readonly brief?: string;
  /** A5-1's version sniff: the sandbox actually in effect for this node. */
  readonly enforcement?: string;
  /** The ACP session the requests arrive on (AC8). */
  readonly sessionId?: string;
  /** Inherited from the node; expiry answers `reject_once` (AC6). */
  readonly deadline?: HumanDeadline;
  readonly pollMs?: number;
  /**
   * Aborts an outstanding wait. The agent cancelled its own turn, or the run
   * was cancelled — either way nobody is going to answer, and that is a
   * first-class outcome rather than an error (AC5).
   */
  readonly signal?: AbortSignal;
}

export interface PermissionEscalations {
  /** `CommandMediatorPorts.escalates` / `LadderPorts.escalates`. */
  readonly escalates: (answer: PermissionAnswer) => boolean;
  /** `CommandMediatorPorts.escalate`. */
  readonly askAboutCommand: (gate: CommandGate) => Promise<CommandApproval | null>;
  /** `CommandMediatorPorts.record` — AC9 for `terminal/create`. */
  readonly recordCommand: (decision: CommandDecision) => void;
  /** `LadderPorts.escalate`. */
  readonly askAboutRequest: (gated: GatedPermissionRequest) => Promise<PermissionDecision | null>;
  /** `LadderPorts.record` — AC9 for `session/request_permission`. */
  readonly recordLadder: (decision: LadderDecision) => void;
  /**
   * A `PathPolicy` over `mediator` that records every `fs/*` decision (AC9).
   *
   * A wrapper rather than a callback on the fs service, because AC9 wants the
   * **allows** too and the service has no hook for them — and because the one
   * place both answers exist is the policy that produced them.
   */
  readonly pathPolicy: (mediator: PathMediator) => PathPolicy;
}

/** AC2 — every ladder `gate`, plus the F5.6 egress boundary §10.5 names. */
export function escalatesPermission(answer: PermissionAnswer): boolean {
  if (answer.outcome === 'allow') return false;
  if (answer.outcome === 'gate') return true;
  return ESCALATED_DENY_CODES.includes(answer.reason.code);
}

export function createPermissionEscalations(ports: EscalationPorts): PermissionEscalations {
  const { db, runId, nodeId, attempt, epoch, clock } = ports;
  const pollMs = ports.pollMs ?? DEFAULT_POLL_MS;

  const stateOf = (): RunState => replayRun(db, runId).state;

  const draft = (kind: string, v: number, payload: unknown): EventDraft => ({
    runId,
    ts: clock.now(),
    kind,
    v,
    epoch,
    nodeId,
    attempt,
    payload,
  });

  /** AC9 — one row per mediated request, whoever answered it. */
  function record(entry: {
    readonly method: PermissionContext['method'];
    readonly requested: string;
    readonly resolved?: string | undefined;
    readonly outcome: PermissionAnswer['outcome'];
    readonly answered: 'allow' | 'reject' | 'cancelled';
    readonly by: PermissionDeciderKind;
    readonly reason?: PermissionReason | null | undefined;
    readonly optionId?: string | undefined;
  }): void {
    const payload = {
      node: nodeId,
      attempt,
      permission: ports.level,
      method: entry.method,
      requested: entry.requested.slice(0, REQUESTED_PATH_MAX),
      ...(entry.resolved === undefined ? {} : { resolved: entry.resolved }),
      outcome: entry.outcome,
      answered: entry.answered,
      by: entry.by,
      ...(entry.reason === null || entry.reason === undefined
        ? {}
        : {
            reason:
              entry.reason.detail === undefined
                ? { code: entry.reason.code }
                : { code: entry.reason.code, detail: entry.reason.detail },
          }),
      ...(entry.optionId === undefined ? {} : { optionId: entry.optionId }),
    };
    appendEvents(db, [draft('permission.decided', 1, payload)]);
  }

  /**
   * Opens the gate, waits for an answer, and returns the option that was
   * chosen — or `null` when nobody is ever going to answer.
   *
   * The `human.requested` and the `node_wake` row commit together, so a restart
   * can never find one without the other (AC1's invariant, borrowed).
   */
  async function ask(
    payload: EventPayloadOf<'human.requested'>,
  ): Promise<{ readonly optionId: string; readonly by: PermissionDeciderKind } | null> {
    appendEventsSchedulingWakes(
      db,
      [draft('human.requested', 5, payload)],
      [
        {
          runId,
          nodeId,
          wakeAt: humanGateWakeAt(payload.deadline ?? null),
          reason: 'human_gate',
        },
      ],
    );

    for (;;) {
      const gate = stateOf().humanGates[nodeId];
      const response = gate?.response ?? null;
      if (response !== null) {
        // `policy` is the deadline path — `expireDueHumanGates` answering on
        // the operator's behalf (AC6) — and it is recorded as its own decider
        // so a timeline can tell a refusal nobody made from one somebody did.
        return {
          optionId: response.optionId,
          by: response.by === 'policy' ? 'deadline' : 'operator',
        };
      }
      if (ports.signal?.aborted === true) return withdraw();
      try {
        await clock.sleep(pollMs, ports.signal);
      } catch {
        return withdraw();
      }
    }
  }

  /**
   * AC5 — the asker went away, so the question goes with it.
   *
   * The gate is *closed*, not abandoned: an item left in the queue attached to
   * a turn that has ended is a decision nothing can act on, and the Operator's
   * panel would show it as still pending for ever. `reject_once` because that
   * is what the request was in fact answered with, and `by: 'policy'` because
   * no person chose it.
   */
  function withdraw(): null {
    const gate = openHumanGate(stateOf(), nodeId);
    if (gate === null) return null;
    appendEventsConsumingWakes(
      db,
      [
        draft('human.responded', 2, {
          node: nodeId,
          optionId: ESCALATION_DEFAULT_OPTION_ID,
          text: 'cancelled-by-agent',
          at: new Date(clock.now()).toISOString(),
          by: 'policy',
        }),
      ],
      [{ runId, nodeId }],
    );
    return null;
  }

  /**
   * The whole escalation, for a request that has already been decided as one.
   *
   * Returns the polarity to answer the agent with, or `null` for a
   * cancellation. The `permission.decided` is written here so that both the
   * run-policy shortcut and the escalation proper record exactly one row.
   */
  async function escalate(
    escalation: Parameters<typeof permissionEscalationPayload>[0],
    requested: string,
  ): Promise<'allow' | 'reject' | null> {
    const context = permissionContextOf(escalation);
    const shared = {
      method: context.method,
      requested,
      resolved: context.resolved,
      outcome: 'gate' as const,
      reason: escalation.reason,
    };

    // AC4 — an `_always` from earlier in this run answers without a prompt.
    const state = stateOf();
    const already = permissionAutoAnswer(state, context);
    if (already !== null) {
      record({
        ...shared,
        answered: already,
        by: 'run-policy',
        optionId: already === 'allow' ? 'allow_always' : 'reject_always',
      });
      return already;
    }

    const chosen = await ask(permissionEscalationPayload(escalation));
    if (chosen === null) {
      record({ ...shared, answered: 'cancelled', by: 'withdrawn' });
      return null;
    }

    // Nothing is remembered here about an `_always`: the run-scoped policy is
    // derived from the ledger on the *next* request (AC4), never held in this
    // closure, so a second agent turn — or a second daemon life — reads the
    // same decision this one did.
    const polarity = optionPolarity(chosen.optionId) ?? 'reject';
    record({ ...shared, answered: polarity, by: chosen.by, optionId: chosen.optionId });
    return polarity;
  }

  const base = {
    node: nodeId,
    level: ports.level,
    cwd: ports.worktree,
    ...(ports.pathScopes === undefined ? {} : { pathScopes: ports.pathScopes }),
    ...(ports.brief === undefined ? {} : { brief: ports.brief }),
    ...(ports.enforcement === undefined ? {} : { enforcement: ports.enforcement }),
    ...(ports.sessionId === undefined ? {} : { sessionId: ports.sessionId }),
    ...(ports.deadline === undefined ? {} : { deadline: ports.deadline }),
  };

  const argvOf = (command: string, args: readonly string[]): string =>
    JSON.stringify({ command, args });

  return {
    escalates: escalatesPermission,

    async askAboutCommand(gate: CommandGate): Promise<CommandApproval | null> {
      const request: PermissionRequest = {
        method: 'terminal/create',
        command: gate.request.command,
        args: gate.request.args,
        cwd: gate.request.cwd,
      };
      const polarity = await escalate(
        { ...base, request, cwd: gate.request.cwd, reason: gate.reason },
        argvOf(gate.request.command, gate.request.args),
      );
      return polarity === null ? null : polarity === 'allow' ? 'approve' : 'reject';
    },

    recordCommand(decision: CommandDecision): void {
      // Escalated decisions record themselves inside `escalate`, where the
      // option and the decider are known. This is the auto-answered rest.
      if (decision.outcome === 'gate') return;
      record({
        method: 'terminal/create',
        requested: argvOf(decision.command, decision.args),
        outcome: decision.outcome,
        answered: decision.answered,
        by: 'ladder',
        reason: decision.reason,
      });
    },

    async askAboutRequest(gated: GatedPermissionRequest): Promise<PermissionDecision | null> {
      const request = gated.request;
      if (request === null) return null;
      const requested = gated.query.locations[0]?.path ?? '';
      const polarity = await escalate({ ...base, request, reason: gated.reason }, requested);
      if (polarity === null) return null;

      const wanted = polarity === 'allow' ? 'allow' : 'reject';
      const option = gated.query.options.find((one) => one.kind.startsWith(wanted));
      // The agent's own option list is authoritative: an agent that offered
      // nothing of the polarity DeFlow decided is answered `cancelled` rather
      // than with an id it never advertised.
      return option === undefined
        ? { outcome: 'cancelled' }
        : { outcome: 'selected', optionId: option.optionId };
    },

    recordLadder(decision: LadderDecision): void {
      if (decision.outcome === 'gate' || decision.method === 'unknown') return;
      record({
        method: decision.method,
        requested: decision.path ?? '',
        outcome: decision.outcome,
        answered: decision.answered,
        by: 'ladder',
        reason: decision.reason,
      });
    },

    pathPolicy(mediator: PathMediator): PathPolicy {
      return {
        async resolve(operation: 'read' | 'write', requested: string) {
          const method = operation === 'read' ? 'fs/read_text_file' : 'fs/write_text_file';
          const mediation = await mediator.mediate(method, requested);
          if (mediation.outcome === 'allow') {
            record({
              method,
              requested,
              resolved: mediation.path === requested ? undefined : mediation.path,
              outcome: 'allow',
              answered: 'allow',
              by: 'ladder',
            });
            return mediation.path;
          }
          const denial: MediationDenial = mediation.denial;
          record({
            method,
            requested,
            resolved: denial.resolved,
            outcome: 'deny',
            answered: 'reject',
            by: 'ladder',
            reason: denial.reason,
          });
          throw new PermissionDeniedError(denial);
        },
      };
    },
  };
}
