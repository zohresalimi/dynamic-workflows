/**
 * KAR-06.1 — `decide(state, now)`: the whole scheduling policy as a pure
 * function (docs/05-durable-execution.md §4, primitive 3 of §3).
 *
 * Every state in this file is built by folding **real, parsed events** through
 * `reduce`, never by hand-assembling a `RunState`. That is deliberate: the
 * flows say "the state is rebuilt by reduce() over those events", and a
 * hand-written projection would let `decide` agree with a shape the reducer
 * cannot actually produce — which is the one failure mode a unit test over a
 * plain object is otherwise blind to.
 *
 * Verifies: EPIC-06-S1, EPIC-06-S2, EPIC-06-S3, EPIC-06-S4 ·
 * AC1, AC3, AC4, AC5, AC6, AC7, AC8
 */
import { expect, it, describe as suite } from 'vitest';
import { decide } from './decide.ts';
import type { EventKind } from './event-payloads.ts';
import { EVENT_SCHEMAS } from './event-payloads.ts';
import type { Event } from './events.ts';
import { parseEvent } from './events.ts';
import { reduce } from './reduce.ts';
import { initialRunState, type RunState } from './run-state.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c';
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const HANDLE = `artifact://${'b'.repeat(64)}`;
const NOW = 1_754_150_000_000;

/** A `node.completed` result that satisfies `CompletedNodeResultSchema`. */
const COMPLETED = {
  status: 'completed',
  output: { summary: 'done' },
  outputSchemaId: 'DeFlow.artifact.v1',
  usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
  costUsd: 0.42,
  producedFacts: [],
  artifacts: [HANDLE],
};

interface NodeSpec {
  readonly id: string;
  readonly deps?: readonly string[];
  readonly lifecycle?: 'active' | 'superseded' | 'abandoned';
  readonly maxAttempts?: number;
  readonly permission?: 'read' | 'worktree' | 'worktree+net' | 'full';
  readonly provider?: readonly string[];
  readonly model?: string;
}

/** One `agent` node, spelled out because every field of `NodeBase` is required. */
function agentNode(spec: NodeSpec): Record<string, unknown> {
  return {
    id: spec.id,
    title: `do ${spec.id}`,
    type: 'agent',
    deps: [...(spec.deps ?? [])],
    lifecycle: spec.lifecycle ?? 'active',
    reads: [],
    writes: [],
    permission: spec.permission ?? 'read',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
    retry: {
      maxAttempts: spec.maxAttempts ?? 3,
      backoff: { base: 2000, cap: 300_000, jitter: 'full' },
    },
    budget: {},
    brief: `brief for ${spec.id}`,
    provider: { prefer: [...(spec.provider ?? ['claude-code'])], requires: [] },
    ...(spec.model === undefined ? {} : { model: spec.model }),
    resume: 'always-replay',
  };
}

function planGraph(nodes: readonly NodeSpec[]): Record<string, unknown> {
  return {
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
  };
}

interface Row {
  readonly kind: EventKind;
  readonly payload: unknown;
}

/**
 * Folds a ledger. `seq` is assigned here — one per row, from 1 — because the
 * ordering `decide` is asked for is derived from `seq`, so a fixture that
 * fakes it would be testing nothing.
 */
function fold(rows: readonly Row[]): RunState {
  let state = initialRunState();
  for (const [index, row] of rows.entries()) {
    state = reduce(state, parse(row, index + 1));
  }
  return state;
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

/** The two rows every scenario starts from: a proposed plan, then a started run. */
function started(nodes: readonly NodeSpec[], rest: readonly Row[] = []): RunState {
  return fold([
    {
      kind: 'plan.proposed',
      payload: { version: 1, planHash: PLAN_HASH, graph: planGraph(nodes), by: 'planner' },
    },
    { kind: 'run.started', payload: { planHash: PLAN_HASH } },
    ...rest,
  ]);
}

const completed = (node: string, attempt = 0): Row => ({
  kind: 'node.completed',
  payload: { node, attempt, result: COMPLETED },
});

const failed = (node: string, failureClass: 'transient' | 'permanent', attempt = 0): Row => ({
  kind: 'node.failed',
  payload: {
    node,
    attempt,
    failure: {
      reason: 'adapter.spawn-failed',
      class: failureClass,
      message: `${node} could not be spawned`,
      evidence: [],
      occurredAtEvent: 1,
      attempt,
    },
  },
});

const startedNode = (node: string, attempt = 0): Row => ({
  kind: 'node.started',
  payload: {
    node,
    attempt,
    ikey: `${RUN_ID}/${node}/${attempt}/0`,
    binary: { path: '/usr/bin/DeFlow-mock-agent', version: '1.0.0', sha256: 'd'.repeat(64) },
  },
});

const retryScheduled = (node: string, nextAttempt: number, wakeAt: number): Row => ({
  kind: 'node.retry.scheduled',
  payload: { node, nextAttempt, wakeAt },
});

const CHAIN: readonly NodeSpec[] = [
  { id: 'recon' },
  { id: 'implement', deps: ['recon'] },
  { id: 'gate-typecheck', deps: ['implement'] },
];

const startNodes = (state: RunState, now = NOW): string[] =>
  decide(state, now)
    .filter((command) => command.kind === 'StartNode')
    .map((command) => command.node);

/** Recursively frozen, so a single bookkeeping write anywhere throws. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

// ── EPIC-06-S1 — the ready set admits an unblocked node ──────────────────────

suite('EPIC-06-S1 — the ready set admits an unblocked node', () => {
  it('AC8: an empty ledger yields no commands rather than throwing', () => {
    expect(decide(initialRunState(), 0)).toEqual([]);
  });

  it('admits only the root at the start of a run', () => {
    expect(startNodes(started(CHAIN))).toEqual(['recon']);
  });

  it('releases the next node when its dependency completes', () => {
    const state = started(CHAIN, [startedNode('recon'), completed('recon')]);
    expect(startNodes(state, NOW + 60_000)).toEqual(['implement']);
  });

  it('carries the provider, model and permission from the plan, so the runner never consults state', () => {
    const state = started([
      { id: 'recon', provider: ['codex'], model: 'gpt-5', permission: 'worktree' },
    ]);
    const [command] = decide(state, NOW);

    expect(command).toEqual({
      kind: 'StartNode',
      runId: RUN_ID,
      node: 'recon',
      attempt: 0,
      nodeType: 'agent',
      title: 'do recon',
      provider: 'codex',
      model: 'gpt-5',
      permission: 'worktree',
      pathScopes: { write: [] },
      retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
    });
  });

  it('orders the command list by the enabling event seq, then node id', () => {
    // b, a and c all become ready on the same `node.completed`, so the
    // enabling seq ties and the node id is what breaks it.
    const siblings: NodeSpec[] = [
      { id: 'root' },
      { id: 'b', deps: ['root'] },
      { id: 'a', deps: ['root'] },
      { id: 'c', deps: ['root'] },
    ];
    const state = started(siblings, [startedNode('root'), completed('root')]);

    expect(startNodes(state)).toEqual(['a', 'b', 'c']);
  });
});

// ── EPIC-06-S2 — decide() is pure ────────────────────────────────────────────

suite('EPIC-06-S2 — decide() is pure: no clock, no I/O, no mutation', () => {
  const mixed = (): RunState =>
    started(
      [
        { id: 'recon' },
        { id: 'implement', deps: ['recon'] },
        { id: 'gate-typecheck', deps: ['implement'] },
        { id: 'docs', deps: ['recon'] },
        { id: 'bench', deps: ['recon'] },
        { id: 'stale', deps: ['recon'], lifecycle: 'superseded' },
      ],
      [
        startedNode('recon'),
        completed('recon'),
        startedNode('implement'),
        failed('implement', 'transient'),
        retryScheduled('implement', 1, NOW + 5_000),
        startedNode('docs'),
      ],
    );

  it('AC1: the same input produces the same output, 100 times over', () => {
    const state = mixed();
    const first = decide(state, NOW);
    for (let call = 0; call < 100; call += 1) {
      expect(decide(state, NOW)).toEqual(first);
    }
  });

  it('AC1: a deeply frozen state is not mutated', () => {
    const state = deepFreeze(mixed());
    const before = JSON.stringify(state);

    expect(() => decide(state, NOW)).not.toThrow();
    expect(JSON.stringify(state)).toBe(before);
  });

  it('AC6: shuffling the node map and the plan node array changes nothing', () => {
    const state = mixed();
    const baseline = decide(state, NOW);

    const reversedNodes = Object.fromEntries(Object.entries(state.nodes).reverse());
    const plan = state.plan;
    if (plan === null) throw new Error('the fixture must have an active plan');
    const shuffled: RunState = {
      ...state,
      nodes: reversedNodes,
      plan: { ...plan, nodes: [...plan.nodes].reverse() },
    };

    expect(decide(shuffled, NOW)).toEqual(baseline);
  });
});

// ── EPIC-06-S3 — five reasons a node is withheld ─────────────────────────────

suite('EPIC-06-S3 — a node with satisfied-looking preconditions is still withheld', () => {
  const ready = (rest: readonly Row[], nodes: readonly NodeSpec[] = CHAIN): string[] =>
    startNodes(started(nodes, [startedNode('recon'), completed('recon'), ...rest]));

  it('because it is already running', () => {
    expect(ready([startedNode('implement')])).toEqual([]);
  });

  it('because its attempt budget is spent', () => {
    const spent = [
      startedNode('implement'),
      failed('implement', 'transient'),
      retryScheduled('implement', 3, NOW - 1),
    ];
    expect(ready(spent)).toEqual([]);
    // …and it is the budget, not the status: one more attempt and it is ready.
    const roomier = CHAIN.map((node) =>
      node.id === 'implement' ? { ...node, maxAttempts: 4 } : node,
    );
    expect(ready(spent, roomier)).toEqual(['implement']);
  });

  it('because its wakeAt is one millisecond in the future', () => {
    const state = started(CHAIN, [
      startedNode('recon'),
      completed('recon'),
      startedNode('implement'),
      failed('implement', 'transient'),
      retryScheduled('implement', 1, NOW + 1),
    ]);
    expect(startNodes(state)).toEqual([]);
  });

  it('AC3: the wakeAt boundary is inclusive, so a wake due now IS admitted', () => {
    const state = started(CHAIN, [
      startedNode('recon'),
      completed('recon'),
      startedNode('implement'),
      failed('implement', 'transient'),
      retryScheduled('implement', 1, NOW),
    ]);
    const [command] = decide(state, NOW);

    expect(command?.kind).toBe('StartNode');
    expect(command?.kind === 'StartNode' && command.node).toBe('implement');
    expect(command?.kind === 'StartNode' && command.attempt).toBe(1);
  });

  it.each(['superseded', 'abandoned'] as const)('AC4: because its lifecycle is %s', (lifecycle) => {
    const nodes = CHAIN.map((node) => (node.id === 'implement' ? { ...node, lifecycle } : node));
    expect(ready([], nodes)).toEqual([]);
  });

  it('because the run is paused', () => {
    const state = started(CHAIN, [{ kind: 'run.paused', payload: { by: 'user' } }]);
    expect(startNodes(state)).toEqual([]);
  });

  it('because the run needs a human', () => {
    const state = started(CHAIN, [
      { kind: 'run.needs_human', payload: { reason: 'churn', detail: 'the same work five times' } },
    ]);
    expect(startNodes(state)).toEqual([]);
  });

  it('AC5: because a dependency failed permanently — and the failure propagates transitively', () => {
    const state = started(CHAIN, [startedNode('recon'), failed('recon', 'permanent')]);
    const commands = decide(state, NOW);

    expect(startNodes(state)).toEqual([]);

    const propagated = commands.filter((command) => command.kind === 'EmitEvent');
    expect(propagated.map((command) => command.node)).toEqual(['gate-typecheck', 'implement']);
    for (const command of propagated) {
      expect(command.event.kind).toBe('node.failed');
      const payload = command.event.payload as { failure: { reason: string; class: string } };
      expect(payload.failure.reason).toBe('dependency.failed');
      expect(payload.failure.class).toBe('permanent');
    }
  });

  it('AC5: a transiently failed dependency poisons nothing — it is going to be retried', () => {
    const state = started(CHAIN, [startedNode('recon'), failed('recon', 'transient')]);
    expect(decide(state, NOW).filter((command) => command.kind === 'EmitEvent')).toEqual([]);
  });

  it('AC5: a node already failed is not told again on the next tick', () => {
    const state = started(CHAIN, [
      startedNode('recon'),
      failed('recon', 'permanent'),
      failed('implement', 'permanent'),
    ]);
    const told = decide(state, NOW)
      .filter((command) => command.kind === 'EmitEvent')
      .map((command) => command.node);

    expect(told).toEqual(['gate-typecheck']);
  });
});

// ── AC7 — a paused run still tidies up after work in flight ──────────────────

suite('AC7 — a paused run returns no StartNode but still tidies work in flight', () => {
  const heldAndWaiting: readonly Row[] = [
    { kind: 'node.lock.acquired', payload: { node: 'recon', lock: 'repo', key: 'repo:/tmp/proj' } },
    startedNode('recon'),
    completed('recon'),
    startedNode('implement'),
    failed('implement', 'transient'),
    retryScheduled('implement', 1, NOW + 5_000),
    { kind: 'run.paused', payload: { by: 'user' } },
  ];

  it('returns ScheduleWake and ReleaseLock, and no StartNode', () => {
    const commands = decide(started(CHAIN, heldAndWaiting), NOW);

    expect(commands.map((command) => command.kind)).toEqual(['ReleaseLock', 'ScheduleWake']);
    expect(commands[0]).toEqual({
      kind: 'ReleaseLock',
      runId: RUN_ID,
      node: 'recon',
      lock: 'repo',
      key: 'repo:/tmp/proj',
    });
    expect(commands[1]).toEqual({
      kind: 'ScheduleWake',
      runId: RUN_ID,
      node: 'implement',
      wakeAt: NOW + 5_000,
      reason: 'backoff',
    });
  });

  it('leaves a lock alone while its holder is still running', () => {
    const state = started(CHAIN, [
      {
        kind: 'node.lock.acquired',
        payload: { node: 'recon', lock: 'repo', key: 'repo:/tmp/proj' },
      },
      startedNode('recon'),
    ]);
    expect(decide(state, NOW).filter((command) => command.kind === 'ReleaseLock')).toEqual([]);
  });
});

// ── EPIC-06-S4 — global agent slots cap admission ────────────────────────────

suite('EPIC-06-S4 — global agent slots cap admission at three', () => {
  const FIVE: readonly NodeSpec[] = [
    { id: 'a' },
    { id: 'b' },
    { id: 'c' },
    { id: 'd' },
    { id: 'e' },
  ];

  it('admits three of five ready nodes and leaves the other two alone', () => {
    expect(startNodes(started(FIVE))).toEqual(['a', 'b', 'c']);
  });

  it('frees a slot on completion, not on scheduling', () => {
    const running = started(FIVE, [startedNode('a'), startedNode('b'), startedNode('c')]);
    expect(startNodes(running)).toEqual([]);

    const afterCompletion = started(FIVE, [
      startedNode('a'),
      startedNode('b'),
      startedNode('c'),
      completed('a'),
    ]);
    expect(startNodes(afterCompletion)).toEqual(['d']);
  });

  it('reads the slot count from state, so an operator can raise it mid-run', () => {
    const running = started(FIVE, [startedNode('a'), startedNode('b'), startedNode('c')]);
    const roomier: RunState = { ...running, policy: { ...running.policy, globalAgentSlots: 5 } };

    expect(startNodes(roomier)).toEqual(['d', 'e']);
  });
});
