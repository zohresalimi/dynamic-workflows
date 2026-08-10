/**
 * KAR-13.1 — a blocking `human` node, as a value
 * (docs/05-durable-execution.md §10.1, docs/11-api-and-realtime.md §11).
 *
 * Everything a human gate *is* lives in the ledger, and this module is the pure
 * reading of it: which gates are open, what answering one appends, and what a
 * deadline nobody met produces. There is no pending-approvals map anywhere in
 * the daemon, and there cannot be one — NF10 requires every state the UI shows
 * to trace to a named event, and a `Map` evaporates on the restart the gate
 * exists to survive.
 *
 * Three decisions carry the file.
 *
 * **The wait is a row, and the row is written with the events that explain it.**
 * Admitting a `human` node returns a single `SuspendNode` command carrying
 * `human.requested`, `node.suspended` and the `node_wake` write together, so the
 * effect boundary commits all three or none (AC1). Three separate commands would
 * make the transaction a convention that a future reordering could quietly
 * break, and the crash that broke it would look like a run that simply never
 * came back.
 *
 * **The response is an event, and it is what advances the node.** A flag on an
 * object survives neither a restart nor a timeline. `human.responded` plus the
 * terminal `node.completed` / `node.failed` are appended in one batch, so the
 * decision, its author and its consequence are one atom in the log.
 *
 * **The deadline is derived, never held.** `humanDeadlineEvents` is a function of
 * `(state, node, now)` — the ticker asks it about a row it found due, and the
 * answer is the same whether the daemon has been up for six hours or six
 * seconds. No timer, at any delay: `setTimeout(fn, 2 ** 31)` fires after about a
 * millisecond (verified 2026-08-02, asserted in
 * `packages/daemon/test/timer-overflow.test.ts`).
 *
 * Verifies: EPIC-13-S1, EPIC-13-S2, EPIC-13-S6, EPIC-13-S7, EPIC-13-S8,
 * EPIC-13-S9 · AC1, AC3, AC7, AC8, AC9, AC10
 */
import { z } from 'zod';
import { type EmittedEvent, NO_DEADLINE_WAKE_AT } from './command.ts';
import type { EventPayloadOf, HumanResponder } from './event-payloads.ts';
import { HUMAN_RESPONDERS } from './event-payloads.ts';
import { type EventSeq, type NodeId, NodeIdSchema, type SchemaId } from './ids.ts';
import type { NodeFailure } from './node-failure.ts';
import {
  HUMAN_OPTION_EFFECTS,
  type HumanDeadline,
  HumanDeadlineSchema,
  type HumanNode,
  type HumanOption,
  type HumanOptionEffect,
  HumanOptionSchema,
  type PlanNode,
} from './plan-graph.ts';
import type { RunState } from './run-state.ts';
import { toSingleLine } from './text.ts';

/**
 * What a `human` node returns when the operator chose rather than supplied.
 *
 * A separate contract from the node's own `returns.schemaId`, and the
 * distinction is the honest one: `edit` is the effect where the operator
 * *supplies the value the node was supposed to produce*, so an `edit` output is
 * validated against the node's declared schema. `approve`, `reject` and
 * `inject` produce a decision, not a domain value, and claiming the node's
 * return contract for one would be a claim nothing checked.
 */
export const HUMAN_DECISION_SCHEMA_ID = 'DeFlow.humandecision.v1';

export const HumanDecisionSchema = z.strictObject({
  node: NodeIdSchema,
  optionId: z.string().min(1),
  effect: z.enum(HUMAN_OPTION_EFFECTS),
  /** The operator's words, for `inject`. Absent for every other effect. */
  text: z.string().optional(),
});

export type HumanDecision = z.infer<typeof HumanDecisionSchema>;

/** The response as the projection holds it, with the `seq` that recorded it. */
export const HumanResponseStateSchema = z.strictObject({
  optionId: z.string().min(1),
  text: z.string().nullable(),
  by: z.enum(HUMAN_RESPONDERS),
  /** Display only — ordering is by `seq`, never by this timestamp. */
  at: z.iso.datetime(),
  seq: z.int().positive(),
});

export type HumanResponseState = z.infer<typeof HumanResponseStateSchema>;

/**
 * One gate, open or answered, folded from `human.requested` / `human.responded`.
 *
 * Kept after it is answered rather than deleted, because *"the operator approved
 * this at 14:12"* is exactly the state somebody asks about three days later, and
 * because it is what lets a second `respond` echo the original decision instead
 * of applying a second one (AC9).
 */
export const HumanGateStateSchema = z.strictObject({
  node: NodeIdSchema,
  prompt: z.string().min(1),
  options: z.array(HumanOptionSchema),
  deadline: HumanDeadlineSchema.nullable(),
  /** True once a `deadline.onTimeout: 'escalate'` has re-asked (AC7). */
  escalated: z.boolean(),
  /** The `seq` of the `human.requested` that opened it — F10.3's deep link. */
  requestedSeq: z.int().positive(),
  response: HumanResponseStateSchema.nullable(),
});

export type HumanGateState = z.infer<typeof HumanGateStateSchema>;

/** The gate on `node` while it is still waiting for an answer; `null` after. */
export function openHumanGate(state: RunState, node: NodeId): HumanGateState | null {
  const gate = state.humanGates[node];
  if (gate === undefined || gate.response !== null) return null;
  return gate;
}

/** Every gate waiting on somebody, oldest first by the seq that opened it. */
export function openHumanGates(state: RunState): readonly HumanGateState[] {
  return Object.values(state.humanGates)
    .filter((gate) => gate.response === null)
    .toSorted((left, right) => left.requestedSeq - right.requestedSeq);
}

/** The `human.requested` payload a plan node asks for, verbatim from the plan. */
export function humanRequestPayload(node: HumanNode): EventPayloadOf<'human.requested'> {
  return {
    node: node.id,
    prompt: node.prompt,
    options: node.options.map((option) => ({ ...option })),
    ...(node.deadline === undefined ? {} : { deadline: { ...node.deadline } }),
  };
}

/**
 * The instant a gate's row is due, as `node_wake.wake_at`.
 *
 * A gate with no declared deadline still gets a row — it is what makes the
 * suspension durable and what answers *"why is this node asleep"* — due at an
 * instant no clock will ever reach (`NO_DEADLINE_WAKE_AT` in ./command.ts).
 */
export function humanGateWakeAt(deadline: HumanDeadline | null): number {
  if (deadline === null) return NO_DEADLINE_WAKE_AT;
  const at = Date.parse(deadline.wakeAt);
  return Number.isSafeInteger(at) ? at : NO_DEADLINE_WAKE_AT;
}

/** What the operator (or the deadline) submitted. */
export interface HumanResponseRequest {
  readonly node: NodeId;
  readonly optionId: string;
  /** `inject`'s guidance, and the note an operator may attach to any option. */
  readonly text?: string | undefined;
  /** `edit`'s replacement payload, already validated by the caller (AC8). */
  readonly output?: unknown;
  /** Defaults to `operator`; the deadline path passes `policy`. */
  readonly by?: HumanResponder | undefined;
  /** ms epoch, from the injected `Clock` — never `Date.now()`. */
  readonly at: number;
}

/** Everything the caller appends, and the effect it is appending it for. */
export interface HumanResponseAccepted {
  readonly status: 'ok';
  readonly effect: HumanOptionEffect;
  readonly events: readonly EmittedEvent[];
}

export type HumanResponseRefusal =
  | { readonly status: 'gate_not_open'; readonly message: string }
  | {
      readonly status: 'already_answered';
      readonly message: string;
      readonly response: HumanResponseState;
    }
  | { readonly status: 'unknown_option'; readonly message: string }
  | { readonly status: 'missing_payload'; readonly message: string };

export type HumanResponseOutcome = HumanResponseAccepted | HumanResponseRefusal;

/**
 * AC3, AC8, AC9 — what answering a gate appends, or why it may not be answered.
 *
 * Total, and a value rather than a throw: every refusal here is something a
 * client did, and the API turns each into its own status code
 * (docs/11-api-and-realtime.md §11). `already_answered` carries the original
 * decision so the `409` can echo what actually happened rather than leaving the
 * UI to double-apply.
 *
 * Nothing here mints an attempt. A human gate is not a retry — the node resumes
 * on the attempt it was suspended on, and the idempotency key of every effect
 * that ran before the gate is unchanged.
 */
export function planHumanResponse(
  state: RunState,
  request: HumanResponseRequest,
): HumanResponseOutcome {
  const answered = state.humanGates[request.node];
  if (answered !== undefined && answered.response !== null) {
    return {
      status: 'already_answered',
      message: toSingleLine(
        `node '${request.node}' was already answered with option '${answered.response.optionId}' ` +
          `at ${answered.response.at}; a human gate is answered once, and the first answer stands`,
      ),
      response: answered.response,
    };
  }

  const gate = openHumanGate(state, request.node);
  if (gate === null) {
    return {
      status: 'gate_not_open',
      message: toSingleLine(
        `node '${request.node}' has no open human gate: nothing is waiting for an answer, so an ` +
          'answer would be a decision about a question nobody asked',
      ),
    };
  }

  const option = gate.options.find((candidate) => candidate.id === request.optionId);
  if (option === undefined) {
    return {
      status: 'unknown_option',
      message: toSingleLine(
        `node '${request.node}' offers ${gate.options.map((one) => `'${one.id}'`).join(', ')}; ` +
          `'${request.optionId}' is not one of them`,
      ),
    };
  }

  if (option.effect === 'edit' && request.output === undefined) {
    return {
      status: 'missing_payload',
      message: toSingleLine(
        `option '${option.id}' on node '${request.node}' replaces the node's output, so a ` +
          'replacement payload is required; completing on nothing would hand the dependents a ' +
          'node that claims a return contract it never satisfied',
      ),
    };
  }

  // The same rule for the other effect that carries something. An `inject` with
  // nothing to inject completes the node and silently delivers no guidance,
  // which is the failure mode the whole option exists to avoid — and it is
  // indistinguishable afterwards from guidance that was dropped.
  if (option.effect === 'inject' && (request.text ?? '').trim() === '') {
    return {
      status: 'missing_payload',
      message: toSingleLine(
        `option '${option.id}' on node '${request.node}' carries the operator's words into the ` +
          'dependents, so text is required; an empty injection is a completed node that ' +
          'delivered nothing, and nobody could tell that apart from guidance that was lost',
      ),
    };
  }

  const attempt = state.nodes[request.node]?.attempt ?? 0;
  const responded: EmittedEvent = {
    kind: 'human.responded',
    payload: {
      node: request.node,
      optionId: option.id,
      ...(request.text === undefined ? {} : { text: request.text }),
      at: new Date(request.at).toISOString(),
      by: request.by ?? 'operator',
    },
  };

  return {
    status: 'ok',
    effect: option.effect,
    events: [responded, outcomeEvent(state, gate, option, request, attempt)],
  };
}

/** The terminal event the chosen effect implies. */
function outcomeEvent(
  state: RunState,
  gate: HumanGateState,
  option: HumanOption,
  request: HumanResponseRequest,
  attempt: number,
): EmittedEvent {
  if (option.effect === 'reject') {
    return {
      kind: 'node.failed',
      payload: { node: gate.node, attempt, failure: rejectedFailure(gate, option, attempt) },
    };
  }

  const supplied = option.effect === 'edit';
  const decision: HumanDecision = {
    node: gate.node,
    optionId: option.id,
    effect: option.effect,
    ...(request.text === undefined ? {} : { text: request.text }),
  };

  return {
    kind: 'node.completed',
    payload: {
      node: gate.node,
      attempt,
      result: {
        status: 'completed',
        output: supplied ? request.output : decision,
        outputSchemaId: (supplied
          ? returnsSchemaId(state, gate.node)
          : HUMAN_DECISION_SCHEMA_ID) as SchemaId,
        // Zero, from a measurement rather than a guess: a human gate spawns no
        // process and spends no vendor token, so there is nothing to estimate.
        usage: { inputTokens: 0, outputTokens: 0, source: 'vendor-reported' },
        costUsd: 0,
        producedFacts: [],
        artifacts: [],
      },
    },
  };
}

/** The node's own declared return contract, which `edit` fills in. */
function returnsSchemaId(state: RunState, node: NodeId): string {
  const planned = (state.plan?.nodes ?? []).find((candidate) => candidate.id === node);
  return planned?.returns.schemaId ?? HUMAN_DECISION_SCHEMA_ID;
}

/**
 * AC8 — `reject` fails the branch, and it says so in the taxonomy's vocabulary.
 *
 * `gate.failed`, because a `human` node is the last rung of the verification
 * ladder (docs/10-verification-gates.md §1) and a rejection is that gate
 * returning red. `permanent`, because retrying it would re-ask a question that
 * has been answered — which is what makes the dependents `dependency.failed`
 * rather than merely stuck.
 */
function rejectedFailure(gate: HumanGateState, option: HumanOption, attempt: number): NodeFailure {
  return {
    reason: 'gate.failed',
    class: 'permanent',
    message: toSingleLine(`the operator chose '${option.label}' on ${gate.node}`),
    detail: { optionId: option.id },
    evidence: [],
    occurredAtEvent: gate.requestedSeq as EventSeq,
    attempt,
  };
}

/**
 * AC7 — what a deadline that has passed with nobody answering produces.
 *
 * Asked by the ticker about a `node_wake` row it found due, and appended in the
 * same transaction as that row is deleted. Empty means *nothing is owed*: the
 * gate is closed, has no deadline, or the deadline has not arrived — so calling
 * it on every tick is safe and calling it twice on the same tick is a no-op.
 *
 * The `default` branch reuses `planHumanResponse` rather than restating it. A
 * policy answer and an operator answer must be the *same* transition with a
 * different author, or the two paths drift and only one of them ends up
 * completing the node.
 */
export function humanDeadlineEvents(
  state: RunState,
  node: NodeId,
  now: number,
): readonly EmittedEvent[] {
  const gate = openHumanGate(state, node);
  if (gate === null || gate.deadline === null) return [];
  if (humanGateWakeAt(gate.deadline) > now) return [];

  const deadline = gate.deadline;
  if (deadline.onTimeout === 'escalate') return [escalatedRequest(gate)];
  if (deadline.onTimeout === 'default') {
    const answered = planHumanResponse(state, {
      node,
      optionId: deadline.default ?? '',
      by: 'policy',
      at: now,
    });
    // Plan validation refuses a `default` naming an option that does not exist
    // (AC7), so this is unreachable from a plan this build admitted. It is still
    // answered rather than thrown on: a ledger written by another build must not
    // be able to wedge a run, and failing the node names the fault out loud.
    return answered.status === 'ok'
      ? answered.events
      : [expiredFailure(state, gate, now, answered.message)];
  }

  return [expiredFailure(state, gate, now, expiredMessage(gate, deadline))];
}

const expiredMessage = (gate: HumanGateState, deadline: HumanDeadline): string =>
  toSingleLine(`nobody answered ${gate.node} by its deadline of ${deadline.wakeAt}`);

function expiredFailure(
  state: RunState,
  gate: HumanGateState,
  now: number,
  message: string,
): EmittedEvent {
  const attempt = state.nodes[gate.node]?.attempt ?? 0;
  return {
    kind: 'node.failed',
    payload: {
      node: gate.node,
      attempt,
      failure: {
        reason: 'timeout',
        class: 'permanent',
        message,
        detail: { deadline: gate.deadline?.wakeAt ?? null, expiredAt: new Date(now).toISOString() },
        evidence: [],
        occurredAtEvent: gate.requestedSeq as EventSeq,
        attempt,
      },
    },
  };
}

/**
 * The second, more visible ask. It declares **no deadline of its own**: an
 * escalation that expired again would either fail a branch on a rule nobody
 * wrote or escalate for ever, and the operator has already been told once.
 */
function escalatedRequest(gate: HumanGateState): EmittedEvent {
  return {
    kind: 'human.requested',
    payload: {
      node: gate.node,
      prompt: gate.prompt,
      options: gate.options.map((option) => ({ ...option })),
      escalated: true,
    },
  };
}

/** One operator interjection, as a dependent is given it. */
export interface InjectedGuidance {
  readonly node: NodeId;
  readonly text: string;
}

/**
 * AC8 — the text an `inject` response carries into a dependent's packet.
 *
 * Read off the *dependency's* completed result rather than off the response
 * event, because the result is what every other upstream value reaches a
 * dependent through: the guidance travels the edge the plan already draws, and
 * a node that is not downstream of the gate is not handed somebody else's
 * answer. Byte-identical to what was submitted — nothing here trims, wraps or
 * summarises it.
 */
export function injectedGuidance(state: RunState, node: NodeId): readonly InjectedGuidance[] {
  const planned = (state.plan?.nodes ?? []).find((candidate) => candidate.id === node);
  if (planned === undefined) return [];

  return planned.deps.flatMap((dep) => {
    const text = injectedTextOf(state, dep);
    return text === null ? [] : [{ node: dep, text }];
  });
}

function injectedTextOf(state: RunState, node: NodeId): string | null {
  const result = state.nodes[node]?.result;
  if (result === null || result === undefined) return null;
  if (result.outputSchemaId !== HUMAN_DECISION_SCHEMA_ID) return null;

  const decision = HumanDecisionSchema.safeParse(result.output);
  if (!decision.success || decision.data.effect !== 'inject') return null;
  return decision.data.text ?? null;
}

/** Whether a plan node is the `human` kind, narrowed. */
export const isHumanNode = (node: PlanNode): node is HumanNode => node.type === 'human';
