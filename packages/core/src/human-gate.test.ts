/**
 * KAR-13.1 — the pure half of a blocking `human` node: what admitting one
 * costs, what an option's effect means, and what happens when nobody answers.
 *
 * Every state here is folded from **real, parsed events** through `reduce`, for
 * the reason `decide.test.ts` gives: a hand-assembled `RunState` would let this
 * module agree with a shape the reducer cannot produce, which is the one
 * failure a unit test over a plain object is blind to.
 *
 * Verifies: EPIC-13-S1 (ledger half), EPIC-13-S6, EPIC-13-S7 (planning half),
 * EPIC-13-S9 · AC1, AC3, AC7, AC8, AC9, AC10
 */
import { expect, it, describe as suite } from 'vitest';
import type { Command, SuspendNode } from './command.ts';
import { NO_DEADLINE_WAKE_AT } from './command.ts';
import { decide } from './decide.ts';
import type { EventKind } from './event-payloads.ts';
import { EVENT_SCHEMAS } from './event-payloads.ts';
import type { Event } from './events.ts';
import { parseEvent } from './events.ts';
import {
  HUMAN_DECISION_SCHEMA_ID,
  humanDeadlineEvents,
  injectedGuidance,
  openHumanGate,
  planHumanResponse,
} from './human-gate.ts';
import type { NodeId } from './ids.ts';
import { reduce } from './reduce.ts';
import { initialRunState, type RunState } from './run-state.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c';
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const NOW = 1_754_150_000_000;
const hours = (count: number): number => count * 3_600_000;

const GATE = 'approve-scope';
const WRITER = 'implement';
const SIBLING = 'recon';

const OPTIONS = [
  { id: 'yes', label: 'Extend scope', effect: 'approve' },
  { id: 'no', label: 'Keep scope as-is', effect: 'reject' },
  { id: 'amend', label: 'Supply the answer myself', effect: 'edit' },
  { id: 'guide', label: 'Answer with guidance', effect: 'inject' },
];

interface Deadline {
  readonly wakeAt: string;
  readonly onTimeout: 'fail' | 'escalate' | 'default';
  readonly default?: string;
}

const base = (id: string, deps: readonly string[] = []): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  deps: [...deps],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
});

const humanNode = (deadline?: Deadline): Record<string, unknown> => ({
  ...base(GATE),
  type: 'human',
  prompt: 'Recon found 3 extra packages. Extend the migration scope?',
  options: OPTIONS.map((option) => ({ ...option })),
  ...(deadline === undefined ? {} : { deadline }),
});

const agentNode = (id: string, deps: readonly string[] = []): Record<string, unknown> => ({
  ...base(id, deps),
  type: 'agent',
  brief: `brief for ${id}`,
  provider: { prefer: ['claude-code'], requires: [] },
  resume: 'always-replay',
});

function planGraph(nodes: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN_ID,
    version: 1,
    planHash: PLAN_HASH,
    parent: null,
    taskSpecHash: SPEC_HASH,
    createdBy: 'planner',
    createdAt: '2026-08-02T14:11:33.000Z',
    nodes,
    edges: [],
  };
}

interface Row {
  readonly kind: EventKind;
  readonly payload: unknown;
}

function parse(row: Row, seq: number): Event {
  const result = parseEvent({
    seq,
    runId: RUN_ID,
    ts: NOW,
    kind: row.kind,
    v: EVENT_SCHEMAS[row.kind].v,
    epoch: 1,
    payload: row.payload,
  });
  if (result.status !== 'ok') {
    throw new Error(`fixture for ${row.kind} is not a valid event: ${JSON.stringify(result)}`);
  }
  return result.event;
}

function fold(rows: readonly Row[]): RunState {
  let state = initialRunState();
  for (const [index, row] of rows.entries()) state = reduce(state, parse(row, index + 1));
  return state;
}

/** A run executing `nodes`, plus whatever else the scenario needs. */
function started(nodes: readonly Record<string, unknown>[], rest: readonly Row[] = []): RunState {
  return fold([
    { kind: 'run.spec.approved', payload: { specHash: SPEC_HASH, by: 'ui' } },
    {
      kind: 'plan.proposed',
      payload: { version: 1, planHash: PLAN_HASH, graph: planGraph(nodes), by: 'planner' },
    },
    { kind: 'run.started', payload: { planHash: PLAN_HASH } },
    ...rest,
  ]);
}

/** Feeds `decide`'s own commands back through the reducer, as the loop does. */
function apply(state: RunState, commands: readonly Command[], fromSeq: number): RunState {
  let next = state;
  let seq = fromSeq;
  for (const command of commands) {
    const events =
      command.kind === 'SuspendNode'
        ? command.events
        : command.kind === 'EmitEvent'
          ? [command.event]
          : [];
    for (const event of events) {
      next = reduce(next, parse({ kind: event.kind, payload: event.payload }, seq));
      seq += 1;
    }
  }
  return next;
}

const suspendOf = (commands: readonly Command[]): SuspendNode => {
  const found = commands.find((command) => command.kind === 'SuspendNode');
  if (found === undefined) throw new Error(`no SuspendNode in ${JSON.stringify(commands)}`);
  return found;
};

/** The run once its `human` node has been admitted and suspended. */
function suspended(nodes: readonly Record<string, unknown>[], rest: readonly Row[] = []) {
  const state = started(nodes, rest);
  const commands = decide(state, NOW);
  return { before: state, commands, after: apply(state, commands, 100) };
}

suite('admitting a human node is a row, never a timer (AC1, test plan #2)', () => {
  it('returns a SuspendNode carrying the wake row and the two events that explain it', () => {
    const { commands } = suspended([humanNode()]);
    const suspend = suspendOf(commands);

    expect(suspend.node).toBe(GATE);
    expect(suspend.reason).toBe('human_gate');
    expect(suspend.events.map((event) => event.kind)).toEqual([
      'human.requested',
      'node.suspended',
    ]);
    // No deadline declared: the wait is real and its due time is never.
    expect(suspend.wakeAt).toBe(NO_DEADLINE_WAKE_AT);
  });

  it('carries the prompt and every option the plan declared', () => {
    const suspend = suspendOf(suspended([humanNode()]).commands);
    const requested = suspend.events[0];

    expect(requested?.kind).toBe('human.requested');
    expect(requested?.payload).toMatchObject({
      node: GATE,
      prompt: 'Recon found 3 extra packages. Extend the migration scope?',
      options: OPTIONS,
    });
  });

  it('never asks for a StartNode: a human node spawns nothing', () => {
    const { commands } = suspended([humanNode()]);

    expect(commands.filter((command) => command.kind === 'StartNode')).toEqual([]);
  });

  it('uses the declared deadline as the row’s wake_at', () => {
    const wakeAt = NOW + hours(2);
    const suspend = suspendOf(
      suspended([humanNode({ wakeAt: new Date(wakeAt).toISOString(), onTimeout: 'fail' })])
        .commands,
    );

    expect(suspend.wakeAt).toBe(wakeAt);
  });

  it('does not re-admit the node once the suspension is in the log', () => {
    const { after } = suspended([humanNode()]);

    expect(decide(after, NOW).filter((command) => command.kind === 'SuspendNode')).toEqual([]);
  });

  it('restates the row on every later tick, so a crash cannot lose it', () => {
    const { after } = suspended([humanNode()]);
    const wakes = decide(after, NOW).filter((command) => command.kind === 'ScheduleWake');

    expect(wakes).toEqual([
      {
        kind: 'ScheduleWake',
        runId: RUN_ID,
        node: GATE,
        wakeAt: NO_DEADLINE_WAKE_AT,
        reason: 'human_gate',
      },
    ]);
  });
});

suite('a pending approval is not a paused run (EPIC-13-S9, AC10)', () => {
  it('keeps admitting siblings whose deps are satisfied', () => {
    const { after } = suspended([humanNode(), agentNode(SIBLING)]);
    const starts = decide(after, NOW).filter((command) => command.kind === 'StartNode');

    expect(starts.map((command) => command.node)).toEqual([SIBLING]);
  });

  it('withholds only the gate’s own dependents', () => {
    const { after } = suspended([humanNode(), agentNode(WRITER, [GATE]), agentNode(SIBLING)]);
    const starts = decide(after, NOW).filter((command) => command.kind === 'StartNode');

    expect(starts.map((command) => command.node)).toEqual([SIBLING]);
  });

  it('leaves the run running rather than paused', () => {
    const { after } = suspended([humanNode(), agentNode(SIBLING)]);

    expect(after.status).toBe('running');
    expect(after.nodes[GATE]?.status).toBe('suspended');
  });
});

suite('the option effect matrix (EPIC-13-S7, AC8)', () => {
  const answer = (
    optionId: string,
    extra: Record<string, unknown> = {},
  ): ReturnType<typeof planHumanResponse> => {
    const { after } = suspended([humanNode(), agentNode(WRITER, [GATE])]);
    return planHumanResponse(after, {
      node: GATE as NodeId,
      optionId,
      at: NOW + 60_000,
      ...extra,
    });
  };

  it('approve completes the node', () => {
    const plan = answer('yes');
    if (plan.status !== 'ok') throw new Error(`refused: ${JSON.stringify(plan)}`);

    expect(plan.effect).toBe('approve');
    expect(plan.events.map((event) => event.kind)).toEqual(['human.responded', 'node.completed']);
    expect(plan.events[1]?.payload).toMatchObject({
      node: GATE,
      attempt: 0,
      result: { status: 'completed', outputSchemaId: HUMAN_DECISION_SCHEMA_ID, costUsd: 0 },
    });
  });

  it('reject fails the node with a typed reason, which poisons its dependents', () => {
    const plan = answer('no');
    if (plan.status !== 'ok') throw new Error(`refused: ${JSON.stringify(plan)}`);

    expect(plan.events.map((event) => event.kind)).toEqual(['human.responded', 'node.failed']);
    expect(plan.events[1]?.payload).toMatchObject({
      node: GATE,
      failure: { reason: 'gate.failed', class: 'permanent' },
    });
  });

  it('edit replaces the output and claims the node’s own returns.schemaId', () => {
    const plan = answer('amend', { output: { severity: 'low', message: 'fine' } });
    if (plan.status !== 'ok') throw new Error(`refused: ${JSON.stringify(plan)}`);

    expect(plan.events[1]?.payload).toMatchObject({
      result: {
        status: 'completed',
        output: { severity: 'low', message: 'fine' },
        outputSchemaId: 'DeFlow.finding.v1',
      },
    });
  });

  it('refuses an edit with no replacement payload rather than completing on nothing', () => {
    expect(answer('amend').status).toBe('missing_payload');
  });

  it('inject completes the node and carries the operator’s text verbatim', () => {
    const text = "Use the existing useToast composable, don't add a new one.";
    const plan = answer('guide', { text });
    if (plan.status !== 'ok') throw new Error(`refused: ${JSON.stringify(plan)}`);

    expect(plan.events[0]?.payload).toMatchObject({ optionId: 'guide', text });
    expect(plan.events[1]?.payload).toMatchObject({
      result: { output: { effect: 'inject', text } },
    });
  });

  it('carries that text into what a dependent is given, byte for byte', () => {
    const text = "Use the existing useToast composable, don't add a new one.";
    const plan = answer('guide', { text });
    if (plan.status !== 'ok') throw new Error(`refused: ${JSON.stringify(plan)}`);

    const { after } = suspended([humanNode(), agentNode(WRITER, [GATE])]);
    let state = after;
    for (const [index, event] of plan.events.entries()) {
      state = reduce(state, parse({ kind: event.kind, payload: event.payload }, 200 + index));
    }

    expect(injectedGuidance(state, WRITER as NodeId)).toEqual([{ node: GATE, text }]);
  });

  it('refuses an inject with nothing to inject, for the same reason', () => {
    expect(answer('guide').status).toBe('missing_payload');
    expect(answer('guide', { text: '   ' }).status).toBe('missing_payload');
  });

  it('offers nothing for an option the plan never declared', () => {
    expect(answer('maybe').status).toBe('unknown_option');
  });
});

suite('answering twice (EPIC-13-S8, AC9)', () => {
  const answered = (): RunState => {
    const { after } = suspended([humanNode()]);
    const plan = planHumanResponse(after, { node: GATE as NodeId, optionId: 'yes', at: NOW + 1 });
    if (plan.status !== 'ok') throw new Error('the first answer should have been accepted');
    let state = after;
    for (const [index, event] of plan.events.entries()) {
      state = reduce(state, parse({ kind: event.kind, payload: event.payload }, 300 + index));
    }
    return state;
  };

  it('refuses the second answer and echoes the first', () => {
    const second = planHumanResponse(answered(), {
      node: GATE as NodeId,
      optionId: 'no',
      at: NOW + 2,
    });

    expect(second.status).toBe('already_answered');
    if (second.status !== 'already_answered') throw new Error('narrowing');
    expect(second.response).toMatchObject({ optionId: 'yes', by: 'operator' });
  });

  it('refuses an answer to a gate that was never opened', () => {
    const { before } = suspended([humanNode()]);

    expect(
      planHumanResponse(before, { node: GATE as NodeId, optionId: 'yes', at: NOW }).status,
    ).toBe('gate_not_open');
  });

  it('stops restating the wake row once the gate is answered', () => {
    const wakes = decide(answered(), NOW).filter((command) => command.kind === 'ScheduleWake');

    expect(wakes).toEqual([]);
  });
});

suite('the deadline matrix (EPIC-13-S6, AC7)', () => {
  const expire = (deadline: Deadline, now: number) => {
    const { after } = suspended([humanNode(deadline)]);
    return { state: after, events: humanDeadlineEvents(after, GATE as NodeId, now) };
  };

  const twoHoursOut = (onTimeout: Deadline['onTimeout'], fallback?: string): Deadline => ({
    wakeAt: new Date(NOW + hours(2)).toISOString(),
    onTimeout,
    ...(fallback === undefined ? {} : { default: fallback }),
  });

  it('fires nothing before the deadline', () => {
    expect(expire(twoHoursOut('fail'), NOW + hours(1)).events).toEqual([]);
  });

  it('fail fails the node with a typed reason', () => {
    const { events } = expire(twoHoursOut('fail'), NOW + hours(2));

    expect(events.map((event) => event.kind)).toEqual(['node.failed']);
    expect(events[0]?.payload).toMatchObject({
      failure: { reason: 'timeout', class: 'permanent' },
    });
  });

  it('escalate re-asks, more visibly, and stops declaring a deadline', () => {
    const { events } = expire(twoHoursOut('escalate'), NOW + hours(2));

    expect(events.map((event) => event.kind)).toEqual(['human.requested']);
    const payload = events[0]?.payload as { deadline?: unknown } | undefined;
    expect(payload).toMatchObject({ node: GATE, escalated: true });
    // No deadline of its own: an escalation that expired again would either
    // fail a branch on a rule nobody wrote or escalate for ever.
    expect(payload?.deadline).toBeUndefined();
  });

  it('an escalated gate goes back to waiting for ever, on one row', () => {
    const { state, events } = expire(twoHoursOut('escalate'), NOW + hours(2));
    let next = state;
    for (const [index, event] of events.entries()) {
      next = reduce(next, parse({ kind: event.kind, payload: event.payload }, 400 + index));
    }

    expect(decide(next, NOW + hours(3))).toEqual([
      {
        kind: 'ScheduleWake',
        runId: RUN_ID,
        node: GATE,
        wakeAt: NO_DEADLINE_WAKE_AT,
        reason: 'human_gate',
      },
    ]);
  });

  it('default answers on the operator’s behalf, and says who did', () => {
    const { events } = expire(twoHoursOut('default', 'no'), NOW + hours(2));

    expect(events.map((event) => event.kind)).toEqual(['human.responded', 'node.failed']);
    expect(events[0]?.payload).toMatchObject({ optionId: 'no', by: 'policy' });
  });

  it('a gate with no deadline waits thirty days and costs the same one row', () => {
    const { after } = suspended([humanNode()]);

    expect(humanDeadlineEvents(after, GATE as NodeId, NOW + hours(24 * 30))).toEqual([]);
    expect(decide(after, NOW + hours(24 * 30))).toEqual([
      {
        kind: 'ScheduleWake',
        runId: RUN_ID,
        node: GATE,
        wakeAt: NO_DEADLINE_WAKE_AT,
        reason: 'human_gate',
      },
    ]);
  });

  it('says nothing about a gate that has already been answered', () => {
    const { after } = suspended([humanNode(twoHoursOut('fail'))]);
    const plan = planHumanResponse(after, { node: GATE as NodeId, optionId: 'yes', at: NOW + 1 });
    if (plan.status !== 'ok') throw new Error('the answer should have been accepted');
    let state = after;
    for (const [index, event] of plan.events.entries()) {
      state = reduce(state, parse({ kind: event.kind, payload: event.payload }, 500 + index));
    }

    expect(humanDeadlineEvents(state, GATE as NodeId, NOW + hours(9))).toEqual([]);
  });
});

suite('the gate as reduced state (AC1, NF10)', () => {
  it('is a fold of the log, keyed by node, with the seq that opened it', () => {
    const { after } = suspended([humanNode()]);
    const gate = openHumanGate(after, GATE as NodeId);

    expect(gate).toMatchObject({ node: GATE, requestedSeq: 100, escalated: false, response: null });
  });

  it('closes when the response lands', () => {
    const { after } = suspended([humanNode()]);
    const plan = planHumanResponse(after, { node: GATE as NodeId, optionId: 'yes', at: NOW + 1 });
    if (plan.status !== 'ok') throw new Error('the answer should have been accepted');
    let state = after;
    for (const [index, event] of plan.events.entries()) {
      state = reduce(state, parse({ kind: event.kind, payload: event.payload }, 600 + index));
    }

    expect(openHumanGate(state, GATE as NodeId)).toBeNull();
    expect(state.humanGates[GATE]?.response).toMatchObject({ optionId: 'yes', seq: 600 });
  });

  it('completes the node on the attempt it was suspended on (AC3)', () => {
    const { after } = suspended([humanNode()]);
    expect(after.nodes[GATE]).toMatchObject({ attempt: 0, attempts: 0 });

    const plan = planHumanResponse(after, { node: GATE as NodeId, optionId: 'yes', at: NOW + 1 });
    if (plan.status !== 'ok') throw new Error('the answer should have been accepted');
    let state = after;
    for (const [index, event] of plan.events.entries()) {
      state = reduce(state, parse({ kind: event.kind, payload: event.payload }, 700 + index));
    }

    // `attempts` is `attempt + 1` by derivation, so one is the count of
    // attempts that have ever existed for this node — the gate resumed on the
    // one it went to sleep on rather than minting a second idempotency key.
    expect(state.nodes[GATE]).toMatchObject({ status: 'completed', attempt: 0, attempts: 1 });
  });
});
