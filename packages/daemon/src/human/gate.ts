/**
 * KAR-13.1 — answering a blocking `human` node, and letting its deadline pass
 * (docs/05-durable-execution.md §10.1, docs/11-api-and-realtime.md §6, §11).
 *
 * These are the two writes that *close* a gate. Opening one is the scheduler's:
 * `decide()` returns a `SuspendNode` and the run executor commits its two events
 * and its `node_wake` row together. What lives here is everything that happens
 * afterwards, and both halves obey the same rule as the opening — **the event
 * and the row move in one transaction**. `appendEventsConsumingWakes` is what
 * enforces it: a restart must never find an answered node still holding a wait,
 * and must never find a wait whose answer was lost.
 *
 * Nothing here holds anything. No promise is parked, no timer is set, no
 * connection is kept open. The operator's answer arrives minutes or days later,
 * through a separate call, quite possibly on a daemon that is a different
 * process from the one that asked. That is the whole reason the gate is a row
 * rather than a `setTimeout`, and it is why this module reads its state by
 * folding the ledger rather than by consulting anything in memory.
 *
 * The service functions are written to be mounted by EPIC-15 rather than to be
 * an HTTP layer themselves: `POST /api/runs/:id/nodes/:nodeId/respond` is
 * `respondToHumanNode` plus a status code, and the status code is on the result
 * so the two cannot drift.
 *
 * Verifies: EPIC-13-S1, EPIC-13-S5, EPIC-13-S6, EPIC-13-S7, EPIC-13-S8 ·
 * AC3, AC7, AC8, AC9
 */
import type {
  Clock,
  Db,
  EmittedEvent,
  EventSeq,
  HumanOptionEffect,
  HumanResponder,
  HumanResponseState,
  NodeId,
  RunId,
  RunState,
} from '@DeFlow/core';
import {
  EVENT_CURRENT_VERSIONS,
  humanDeadlineEvents,
  initialRunState,
  NO_DEADLINE_WAKE_AT,
  openHumanGate,
  planHumanResponse,
} from '@DeFlow/core';
import {
  appendEventsConsumingWakes,
  appendEventsSchedulingWakes,
  dueWakes,
  type EventDraft,
  replayAll,
} from '@DeFlow/ledger';
import { loadSchemaDirectory, type SchemaDirectory } from '../schema-store.ts';

const versionOf = (kind: string): number =>
  (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)[kind] ?? 1;

const stateOf = (db: Db, runId: RunId): RunState =>
  replayAll(db).runs.get(runId) ?? initialRunState();

/** The envelope columns every event this module appends carries. */
function draft(
  runId: RunId,
  nodeId: NodeId,
  attempt: number,
  ts: number,
  epoch: number,
  event: EmittedEvent,
): EventDraft {
  return {
    runId,
    ts,
    kind: event.kind,
    v: versionOf(event.kind),
    epoch,
    nodeId,
    attempt,
    payload: event.payload,
  };
}

/* -------------------------------------------------------------------------- *
 * answering
 * -------------------------------------------------------------------------- */

export interface RespondOptions {
  readonly db: Db;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly optionId: string;
  /** `inject`'s guidance, and the note an operator may attach to any option. */
  readonly text?: string | undefined;
  /** `edit`'s replacement payload, validated here against `returns.schemaId`. */
  readonly output?: unknown;
  /** Defaults to `operator`. The deadline path passes `policy`. */
  readonly by?: HumanResponder | undefined;
  readonly epoch: number;
  /** ms epoch, from the injected `Clock` — never `Date.now()`. */
  readonly ts: number;
  /**
   * Where `edit` payloads are checked. Defaults to the shipped `.DeFlow/schemas`
   * directory; a caller holding a store passes it rather than paying for a
   * recompile per answer.
   */
  readonly schemas?: SchemaDirectory;
}

/** The codes the API turns into status lines (docs/11 §11). */
export type RespondRefusalCode =
  | 'gate_not_open'
  | 'unknown_option'
  | 'missing_payload'
  | 'schema_violation';

export type RespondResult =
  | {
      readonly status: 'ok';
      readonly http: 200;
      readonly seq: EventSeq;
      readonly effect: HumanOptionEffect;
    }
  | {
      readonly status: 'conflict';
      readonly http: 409;
      readonly code: 'already_answered';
      readonly message: string;
      /** The original decision, echoed so the UI shows what actually happened. */
      readonly response: HumanResponseState;
    }
  | {
      readonly status: 'refused';
      readonly http: 404 | 422;
      readonly code: RespondRefusalCode;
      readonly message: string;
      /** The schema violations, for `schema_violation`. */
      readonly issues?: readonly string[];
    };

/**
 * AC3, AC8, AC9 — the operator's answer, as the ledger records it.
 *
 * Three properties are load-bearing and all three are asserted in
 * `packages/daemon/test/integration/human-gate.test.ts`.
 *
 * **The response and the wake row's delete are one transaction.** A restart must
 * never find an answered node still holding a `node_wake` row, because the next
 * tick would fire a wait for a question that has been answered.
 *
 * **A refusal appends nothing at all.** An `edit` payload that fails validation
 * leaves the node suspended so the operator can correct it — somebody who
 * mistypes JSON at 23:00 should get another go, not a failed branch, and because
 * the node's whole state is in the ledger, another go costs nothing.
 *
 * **The second answer never wins.** It returns `409` carrying the first
 * decision, so the UI can render what happened rather than double-applying.
 */
export function respondToHumanNode(options: RespondOptions): RespondResult {
  const { db, runId, nodeId } = options;
  const state = stateOf(db, runId);

  const planned = planHumanResponse(state, {
    node: nodeId,
    optionId: options.optionId,
    text: options.text,
    output: options.output,
    by: options.by,
    at: options.ts,
  });

  if (planned.status === 'already_answered') {
    return {
      status: 'conflict',
      http: 409,
      code: 'already_answered',
      message: planned.message,
      response: planned.response,
    };
  }
  if (planned.status !== 'ok') {
    return {
      status: 'refused',
      http: planned.status === 'gate_not_open' ? 404 : 422,
      code: planned.status,
      message: planned.message,
    };
  }

  if (planned.effect === 'edit') {
    const violation = validateEdit(state, nodeId, options);
    if (violation !== null) return violation;
  }

  const attempt = state.nodes[nodeId]?.attempt ?? 0;
  const seqs = appendEventsConsumingWakes(
    db,
    planned.events.map((event) => draft(runId, nodeId, attempt, options.ts, options.epoch, event)),
    [{ runId, nodeId }],
  );

  const first = seqs[0];
  if (first === undefined) throw new Error('the responder appended no events, which cannot happen');
  return { status: 'ok', http: 200, seq: first, effect: planned.effect };
}

/**
 * AC8 — an `edit` supplies the value the node was supposed to produce, so it is
 * checked against the node's own `returns.schemaId` and against nothing else.
 *
 * A node whose declared contract has no compiled schema is refused rather than
 * waved through: *"we could not check it"* and *"it is fine"* are different
 * answers, and only one of them is honest about a payload a dependent is about
 * to be handed as the node's output.
 */
function validateEdit(
  state: RunState,
  nodeId: NodeId,
  options: RespondOptions,
): Extract<RespondResult, { status: 'refused' }> | null {
  const planned = (state.plan?.nodes ?? []).find((node) => node.id === nodeId);
  const schemaId = planned?.returns.schemaId;
  if (schemaId === undefined) {
    return {
      status: 'refused',
      http: 422,
      code: 'schema_violation',
      message: `node '${nodeId}' is not in the executing plan, so its return contract is unknown`,
    };
  }

  const store = options.schemas ?? loadSchemaDirectory();
  if (!store.has(schemaId)) {
    return {
      status: 'refused',
      http: 422,
      code: 'schema_violation',
      message:
        `node '${nodeId}' returns '${schemaId}', which ${store.location} has no schema for; ` +
        'an edited output nothing could check is not the same as one that passed',
    };
  }

  const issues = store.validate(schemaId, options.output);
  if (issues.length === 0) return null;

  return {
    status: 'refused',
    http: 422,
    code: 'schema_violation',
    message: `the supplied payload does not satisfy '${schemaId}', so node '${nodeId}' stays suspended`,
    issues: issues.map((issue) => `${issue.pointer || '/'}: ${issue.message}`),
  };
}

/* -------------------------------------------------------------------------- *
 * deadlines
 * -------------------------------------------------------------------------- */

export interface ExpireOptions {
  readonly db: Db;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  readonly epoch: number;
  /** One run, or every run in the ledger when omitted. */
  readonly runId?: RunId | undefined;
}

/** One gate whose deadline this tick answered, and what it answered with. */
export interface ExpiredHumanGate {
  readonly runId: RunId;
  readonly node: NodeId;
  readonly onTimeout: 'fail' | 'escalate' | 'default';
  readonly kinds: readonly string[];
}

/**
 * AC7 — the ticker's half of the deadline: read the due rows, ask
 * `humanDeadlineEvents` what each one owes, append it with the row's delete.
 *
 * A read followed by a decision followed by one transaction, with nothing
 * remembered between ticks. That is what makes the six-hour case and the
 * crash-and-restart case the same code path: a daemon that has been up for four
 * seconds finds exactly the rows a daemon that has been up for four hours would,
 * because the question is `wake_at <= now` and the answer is in the table.
 *
 * A due row whose gate owes nothing — the F1.3 spec gate, a suspension with no
 * deadline, a gate somebody answered a millisecond ago — is **left alone**. It
 * is not this function's row to consume, and deleting it would silently retire a
 * wait another module is holding.
 */
export function expireDueHumanGates(options: ExpireOptions): readonly ExpiredHumanGate[] {
  const { db, clock, epoch } = options;
  const now = clock.now();
  const due = dueWakes(db, now).filter(
    (row) =>
      row.reason === 'human_gate' && (options.runId === undefined || row.runId === options.runId),
  );
  if (due.length === 0) return [];

  const runs = replayAll(db).runs;
  const expired: ExpiredHumanGate[] = [];

  for (const row of due) {
    const runId = row.runId as RunId;
    const node = row.nodeId as NodeId;
    const state = runs.get(runId) ?? initialRunState();
    const gate = openHumanGate(state, node);
    if (gate === null || gate.deadline === null) continue;

    const events = humanDeadlineEvents(state, node, now);
    if (events.length === 0) continue;

    const attempt = state.nodes[node]?.attempt ?? 0;
    const drafts = events.map((event) => draft(runId, node, attempt, now, epoch, event));

    // `escalate` re-asks rather than answering, so the gate is still open when
    // this transaction commits and it still needs a row — written here, with
    // the request, for exactly the reason admission writes them together (AC1).
    // Its due time is never: the escalated request declares no deadline, and a
    // row left at the old one would come due on every tick for ever.
    const reopened = events.some((event) => event.kind === 'human.requested');
    const indefinite = {
      runId,
      nodeId: node,
      wakeAt: NO_DEADLINE_WAKE_AT,
      reason: 'human_gate' as const,
    };
    if (reopened) {
      appendEventsSchedulingWakes(db, drafts, [indefinite]);
    } else {
      appendEventsConsumingWakes(db, drafts, [{ runId, nodeId: node }]);
    }
    expired.push({
      runId,
      node,
      onTimeout: gate.deadline.onTimeout,
      kinds: events.map((event) => event.kind),
    });
  }

  return expired;
}
