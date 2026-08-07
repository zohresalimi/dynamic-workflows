/**
 * KAR-06.5 — what `decide()` does with each of the three classes, over states
 * folded from real events (EPIC-06-S18, EPIC-06-S20 scenario 3).
 *
 * The unit under test is still the pure scheduler; what these cases add on top
 * of `retry.test.ts` is that the *events the ladder writes* reduce into a state
 * `decide()` reads the way the ladder intended. A planner that returns the right
 * answer and a reducer that projects it differently is a bug neither file would
 * catch alone.
 *
 * Verifies: EPIC-06-S18 (scenario 1), EPIC-06-S20 (scenario 3) · AC2, AC3, AC4
 */
import { expect, it, describe as suite } from 'vitest';
import type { Command, StartNode } from '../src/command.ts';
import { decide } from '../src/decide.ts';
import type { EventKind } from '../src/event-payloads.ts';
import { EVENT_SCHEMAS } from '../src/event-payloads.ts';
import type { Event } from '../src/events.ts';
import { parseEvent } from '../src/events.ts';
import type { EventSeq } from '../src/ids.ts';
import type { NodeFailure, NodeFailureReason } from '../src/node-failure.ts';
import { reduce } from '../src/reduce.ts';
import { initialRunState, type RunState } from '../src/run-state.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c';
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const NOW = 1_754_150_000_000;

interface NodeSpec {
  readonly id: string;
  readonly deps?: readonly string[];
}

const agentNode = (spec: NodeSpec): Record<string, unknown> => ({
  id: spec.id,
  title: `do ${spec.id}`,
  type: 'agent',
  deps: [...(spec.deps ?? [])],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `brief for ${spec.id}`,
  provider: { prefer: ['claude-code'], requires: [] },
  resume: 'always-replay',
});

const planGraph = (nodes: readonly NodeSpec[]): Record<string, unknown> => ({
  schemaId: 'DeFlow.plangraph.v1',
  runId: RUN_ID,
  version: 1,
  planHash: PLAN_HASH,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-02T14:11:33.000Z',
  nodes: nodes.map(agentNode),
  edges: nodes.flatMap((node) =>
    (node.deps ?? []).map((from) => ({ from, to: node.id, kind: 'control' })),
  ),
});

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

function started(nodes: readonly NodeSpec[], rest: readonly Row[] = []): RunState {
  const rows: Row[] = [
    // KAR-10.3 AC3 — F1.3's gate. `decide()` admits nothing until the ledger
    // carries an approval, so a fixture for a *started* run has to carry the
    // one every real started run has.
    { kind: 'run.spec.approved', payload: { specHash: SPEC_HASH, by: 'ui' } },
    {
      kind: 'plan.proposed',
      payload: { version: 1, planHash: PLAN_HASH, graph: planGraph(nodes), by: 'planner' },
    },
    { kind: 'run.started', payload: { planHash: PLAN_HASH } },
    ...rest,
  ];
  let state = initialRunState();
  for (const [index, row] of rows.entries()) state = reduce(state, parse(row, index + 1));
  return state;
}

const failure = (
  reason: NodeFailureReason,
  failureClass: NodeFailure['class'],
  attempt = 0,
): NodeFailure => ({
  reason,
  class: failureClass,
  message: `${reason} on attempt ${attempt}`,
  evidence: [],
  occurredAtEvent: 2 as EventSeq,
  attempt,
});

const failedRow = (
  node: string,
  reason: NodeFailureReason,
  failureClass: NodeFailure['class'],
  attempt = 0,
): Row => ({
  kind: 'node.failed',
  payload: { node, attempt, failure: failure(reason, failureClass, attempt) },
});

const starts = (commands: readonly Command[]): StartNode[] =>
  commands.filter((command): command is StartNode => command.kind === 'StartNode');

// ── transient ────────────────────────────────────────────────────────────────

suite('transient — the backoff is a wake row, and the retry is a new attempt (AC2)', () => {
  /** Attempt 0 failed at NOW; the ladder scheduled attempt 1 for NOW + 240 s. */
  const WAKE_AT = NOW + 240_000;

  const backingOff = (): RunState =>
    started(
      [{ id: 'implement' }],
      [
        failedRow('implement', 'provider.rate-limited', 'transient'),
        {
          kind: 'node.retry.scheduled',
          payload: { node: 'implement', nextAttempt: 1, wakeAt: WAKE_AT },
        },
      ],
    );

  it('asks for one node_wake row with reason backoff, and starts nothing yet', () => {
    const commands = decide(backingOff(), NOW + 5_000);
    expect(starts(commands)).toEqual([]);
    expect(commands).toEqual([
      {
        kind: 'ScheduleWake',
        runId: RUN_ID,
        node: 'implement',
        wakeAt: WAKE_AT,
        reason: 'backoff',
      },
    ]);
  });

  it('starts exactly one attempt when the wake comes due, at the next attempt index', () => {
    const commands = decide(backingOff(), WAKE_AT);
    const admitted = starts(commands);
    expect(admitted.map((command) => command.node)).toEqual(['implement']);
    // 0-based: `attempt: 1` is the second attempt, and it mints a new ikey.
    expect(admitted[0]?.attempt).toBe(1);
  });

  it('and it stays asleep for every instant before that, however many ticks', () => {
    const state = backingOff();
    for (let tick = 0; tick < 240; tick += 1) {
      expect(starts(decide(state, NOW + tick * 1_000))).toEqual([]);
    }
  });
});

// ── permanent ────────────────────────────────────────────────────────────────

suite('permanent — dependency.failed propagates transitively (AC3)', () => {
  /**
   * `recon` has two dependents, and one of those has a dependent of its own.
   * The failure that is only one level deep is the red this shape catches.
   */
  const poisoned = (): RunState =>
    started(
      [
        { id: 'recon' },
        { id: 'implement', deps: ['recon'] },
        { id: 'document', deps: ['recon'] },
        { id: 'gate-typecheck', deps: ['implement'] },
      ],
      [failedRow('recon', 'adapter.spawn-failed', 'permanent')],
    );

  it('fails every node downstream, not just the immediate dependents', () => {
    const commands = decide(poisoned(), NOW);
    const emitted = commands.filter((command) => command.kind === 'EmitEvent');
    // All three are enabled by the same event, so the tie breaks on node id
    // (KAR-06.1 AC6) — never on the order `plan.nodes` happens to be written in.
    expect(emitted.map((command) => command.node)).toEqual([
      'document',
      'gate-typecheck',
      'implement',
    ]);
    for (const command of emitted) {
      expect(command.event.kind).toBe('node.failed');
      const payload = command.event.payload as { failure: NodeFailure };
      expect(payload.failure.class).toBe('permanent');
      expect(payload.failure.reason).toBe('dependency.failed');
    }
  });

  it('asks for no wake row: a permanent failure is not waiting for anything', () => {
    expect(decide(poisoned(), NOW).filter((command) => command.kind === 'ScheduleWake')).toEqual(
      [],
    );
  });

  it('starts nothing on the poisoned branch, ever', () => {
    const state = poisoned();
    for (let tick = 0; tick < 100; tick += 1) {
      expect(starts(decide(state, NOW + tick * 1_000))).toEqual([]);
    }
  });
});

// ── gate ─────────────────────────────────────────────────────────────────────

suite('gate — the run stops and asks, and stays stopped (AC4)', () => {
  const gated = (extra: readonly Row[] = []): RunState =>
    started(
      [{ id: 'migrate' }, { id: 'unrelated' }],
      [
        failedRow('migrate', 'effect.reconcile-unknown', 'gate'),
        { kind: 'node.suspended', payload: { node: 'migrate', until: { kind: 'human' } } },
        {
          kind: 'run.needs_human',
          payload: {
            reason: 'reconcile-unknown',
            detail: 'reconcile returned unknown for migrate',
          },
        },
        ...extra,
      ],
    );

  it('projects the node as suspended and the run as needing a human', () => {
    const state = gated();
    expect(state.nodes.migrate?.status).toBe('suspended');
    expect(state.status).toBe('needs-human');
    expect(state.needsHuman?.reason).toBe('reconcile-unknown');
  });

  it('produces no StartNode across a thousand ticks — for any node in the run', () => {
    const state = gated();
    for (let tick = 0; tick < 1_000; tick += 1) {
      expect(starts(decide(state, NOW + tick * 1_000))).toEqual([]);
    }
  });

  it('does not poison the branch: a gate is a pause, not a permanent failure', () => {
    expect(decide(gated(), NOW).filter((command) => command.kind === 'EmitEvent')).toEqual([]);
  });

  it('lifts the node’s suspension only once human.responded is reduced', () => {
    expect(gated().nodes.migrate?.suspension).toEqual({ kind: 'human' });
    const answered = gated([
      {
        kind: 'human.responded',
        payload: { node: 'migrate', optionId: 'approve', at: '2026-08-02T15:11:33.000Z' },
      },
    ]);
    expect(answered.nodes.migrate?.suspension).toBeNull();
    expect(answered.nodes.migrate?.status).not.toBe('suspended');
  });
});
