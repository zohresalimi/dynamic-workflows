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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import type { Command } from './command.ts';
import { WAKE_REASONS } from './command.ts';
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
  /**
   * `pathScopes.write` — F5.3's positive write scope, and the thing KAR-06.2
   * reads to decide whether a node *declares a repository write*. Empty (the
   * default) means it writes no files, so it never contends for the repo lock.
   */
  readonly writes?: readonly string[];
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
    pathScopes: { write: [...(spec.writes ?? [])] },
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

/**
 * The two rows every scenario starts from: a proposed plan, then a started run.
 *
 * `head` goes in front of both, which is where `run.created` belongs — it is
 * the row that tells the projection which repository the run is executing
 * against, and therefore what the repo lock's key is.
 */
function started(
  nodes: readonly NodeSpec[],
  rest: readonly Row[] = [],
  head: readonly Row[] = [],
): RunState {
  return fold([
    ...head,
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

/** The repository the fixtures' run executes in, and the key its lock is under. */
const REPO = '/home/u/proj';
const REPO_LOCK = `repo:${REPO}`;

/**
 * A `run.created` for `cwd`. The spec is the committed TaskSpec fixture
 * because `RunCreatedSchema` embeds a whole one and a hand-written stub would
 * only prove that the stub parses.
 */
const TASK_SPEC: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../test/fixtures/specs/vue3-migration.json', import.meta.url)),
    'utf8',
  ),
);

const createdIn = (cwd: string = REPO): Row => ({
  kind: 'run.created',
  payload: { spec: TASK_SPEC, cwd, repo: { head: 'e83c516', branch: 'main' } },
});

/**
 * `node.scheduled` — the event that records the scheduler's resolution of a
 * node's execution parameters, including the worktree it was assigned.
 */
const scheduled = (node: string, worktree?: string): Row => ({
  kind: 'node.scheduled',
  payload: {
    node,
    provider: 'claude-code',
    permission: 'worktree',
    ...(worktree === undefined ? {} : { worktree }),
  },
});

const lockAcquired = (node: string, lock: 'repo' | 'worktree', key: string): Row => ({
  kind: 'node.lock.acquired',
  payload: { node, lock, key },
});

const lockReleased = (node: string, lock: 'repo' | 'worktree', key: string): Row => ({
  kind: 'node.lock.released',
  payload: { node, lock, key },
});

const suspendedNode = (node: string): Row => ({
  kind: 'node.suspended',
  payload: { node, until: { kind: 'human' } },
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
      worktree: null,
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
      reason: 'reclaimed',
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

// ── EPIC-06-S5 — two write nodes contend for the repository lock ─────────────

/** Every command of one kind, in the order `decide` returned them. */
const of = <K extends Command['kind']>(
  state: RunState,
  kind: K,
  now = NOW,
): Extract<Command, { kind: K }>[] =>
  decide(state, now).filter(
    (command): command is Extract<Command, { kind: K }> => command.kind === kind,
  );

suite('EPIC-06-S5 — two write nodes contend for the repository lock', () => {
  /** Both write the repository, so both claim `repo:/home/u/proj`. */
  const WRITERS: readonly NodeSpec[] = [
    { id: 'impl-auth', permission: 'worktree', writes: ['src/auth/**'] },
    { id: 'impl-router', permission: 'worktree', writes: ['src/router/**'] },
  ];

  const contending = (rest: readonly Row[] = []): RunState => started(WRITERS, rest, [createdIn()]);

  it('AC2: admits exactly one of them, and asks for the lock once', () => {
    const state = contending();

    expect(of(state, 'AcquireLock')).toEqual([
      { kind: 'AcquireLock', runId: RUN_ID, node: 'impl-auth', lock: 'repo', key: REPO_LOCK },
    ]);
    expect(startNodes(state)).toEqual(['impl-auth']);
  });

  it('AC2: withholds the loser entirely — no lock command, no start, still pending', () => {
    const commands = decide(contending(), NOW);

    expect(
      commands.filter((command) => 'node' in command && command.node === 'impl-router'),
    ).toEqual([]);
  });

  it('AC2: admits the withheld node once a release for that key is reduced', () => {
    const afterRelease = contending([
      lockAcquired('impl-auth', 'repo', REPO_LOCK),
      startedNode('impl-auth'),
      completed('impl-auth'),
      lockReleased('impl-auth', 'repo', REPO_LOCK),
    ]);

    expect(startNodes(afterRelease)).toEqual(['impl-router']);
    expect(of(afterRelease, 'AcquireLock')).toEqual([
      { kind: 'AcquireLock', runId: RUN_ID, node: 'impl-router', lock: 'repo', key: REPO_LOCK },
    ]);
  });

  it('does not re-acquire a lock the admitted node already holds', () => {
    // The crash-between-lock-and-start window: the acquisition landed, the
    // start did not. The node is still ready and still holds the lock.
    const held = contending([lockAcquired('impl-auth', 'repo', REPO_LOCK)]);

    expect(of(held, 'AcquireLock')).toEqual([]);
    expect(startNodes(held)).toEqual(['impl-auth']);
  });

  for (const outcome of ['completed', 'failed'] as const) {
    it(`AC5: gives the lock back when its holder reduces to ${outcome}`, () => {
      // There is no `node.cancelled` in the §9 registry: a cancelled node
      // reduces to `failed`, so these two are every terminal outcome there is.
      const terminal =
        outcome === 'completed' ? completed('impl-auth') : failed('impl-auth', 'permanent');
      const state = contending([
        lockAcquired('impl-auth', 'repo', REPO_LOCK),
        startedNode('impl-auth'),
        terminal,
      ]);

      expect(of(state, 'ReleaseLock')).toEqual([
        {
          kind: 'ReleaseLock',
          runId: RUN_ID,
          node: 'impl-auth',
          lock: 'repo',
          key: REPO_LOCK,
          reason: 'reclaimed',
        },
      ]);
    });
  }

  it('AC6: read-only nodes never ask for the repo lock, so slots are the only bound', () => {
    const analysts: NodeSpec[] = Array.from({ length: 8 }, (_unused, index) => ({
      id: `read-${index}`,
      permission: 'read',
      // A read node with a write scope is a contradiction the schema does not
      // forbid; `permission` is what the lock consults, and it must win.
      writes: ['src/**'],
    }));
    const state = started(analysts, [], [createdIn()]);

    expect(of(state, 'AcquireLock')).toEqual([]);
    expect(startNodes(state)).toHaveLength(3);
  });

  it('a write node that declares no write scope does not contend', () => {
    const state = started(
      [
        { id: 'plan-a', permission: 'worktree' },
        { id: 'plan-b', permission: 'worktree' },
      ],
      [],
      [createdIn()],
    );

    expect(of(state, 'AcquireLock')).toEqual([]);
    expect(startNodes(state)).toEqual(['plan-a', 'plan-b']);
  });

  it('takes no repo lock at all when the ledger never said which repository', () => {
    // No `run.created`, so `repoRoot` is null. Inventing a key here would put a
    // lock over a path nothing in the system agrees on.
    const state = started(WRITERS);

    expect(of(state, 'AcquireLock')).toEqual([]);
    expect(startNodes(state)).toEqual(['impl-auth', 'impl-router']);
  });
});

// ── EPIC-06-S6 — the lock lives in the ledger, so a restart cannot lose it ───

suite('EPIC-06-S6 — a held lock is state, not bookkeeping', () => {
  const WRITERS: readonly NodeSpec[] = [
    { id: 'impl-auth', permission: 'worktree', writes: ['src/auth/**'] },
    { id: 'impl-router', permission: 'worktree', writes: ['src/router/**'] },
  ];

  it('withholds the competitor for a hundred ticks while the lock is unreleased', () => {
    const state = started(
      WRITERS,
      [lockAcquired('impl-auth', 'repo', REPO_LOCK), startedNode('impl-auth')],
      [createdIn()],
    );

    for (let tick = 0; tick < 100; tick += 1) {
      expect(startNodes(state, NOW + tick * 1_000)).toEqual([]);
    }
  });

  it('AC5: reclaims a lock whose owner failed, and admits the competitor on that tick', () => {
    const state = started(
      WRITERS,
      [
        lockAcquired('impl-auth', 'repo', REPO_LOCK),
        startedNode('impl-auth'),
        failed('impl-auth', 'permanent', 0),
      ],
      [createdIn()],
    );

    expect(decide(state, NOW).map((command) => command.kind)).toEqual([
      'ReleaseLock',
      'AcquireLock',
      'StartNode',
    ]);
    expect(of(state, 'ReleaseLock')[0]).toMatchObject({ node: 'impl-auth', reason: 'reclaimed' });
    expect(startNodes(state)).toEqual(['impl-router']);
  });

  it('AC5: names the node that held it, not the node taking it', () => {
    const state = started(
      WRITERS,
      [
        lockAcquired('impl-auth', 'repo', REPO_LOCK),
        startedNode('impl-auth'),
        completed('impl-auth'),
      ],
      [createdIn()],
    );

    expect(of(state, 'ReleaseLock')[0]?.node).toBe('impl-auth');
  });
});

// ── EPIC-06-S7 — one agent per worktree, always ─────────────────────────────

suite('EPIC-06-S7 — one agent per worktree, always', () => {
  const SHARED = `.DeFlow/wt/${RUN_ID}__implement`;
  const FIXES: readonly NodeSpec[] = [
    { id: 'fix-1', permission: 'worktree' },
    { id: 'fix-2', permission: 'worktree' },
  ];

  it('AC7: two nodes in one worktree take one lock, and only one starts', () => {
    const state = started(
      FIXES,
      [scheduled('fix-1', SHARED), scheduled('fix-2', SHARED)],
      [createdIn()],
    );

    expect(of(state, 'AcquireLock')).toEqual([
      { kind: 'AcquireLock', runId: RUN_ID, node: 'fix-1', lock: 'worktree', key: SHARED },
    ]);
    expect(startNodes(state)).toEqual(['fix-1']);
  });

  it('AC7: distinct worktrees do not contend', () => {
    const state = started(
      FIXES,
      [scheduled('fix-1', `${SHARED}-a`), scheduled('fix-2', `${SHARED}-b`)],
      [createdIn()],
    );

    expect(of(state, 'AcquireLock').map((command) => command.node)).toEqual(['fix-1', 'fix-2']);
    expect(startNodes(state)).toEqual(['fix-1', 'fix-2']);
  });

  it('carries the assigned worktree on the StartNode, so the runner needs no lookup', () => {
    const state = started(FIXES, [scheduled('fix-1', SHARED)], [createdIn()]);

    expect(of(state, 'StartNode')[0]).toMatchObject({ node: 'fix-1', worktree: SHARED });
  });

  it('a suspended node holds neither a slot nor its worktree lock', () => {
    const state = started(
      FIXES,
      [
        scheduled('fix-1', SHARED),
        scheduled('fix-2', SHARED),
        lockAcquired('fix-1', 'worktree', SHARED),
        startedNode('fix-1'),
        suspendedNode('fix-1'),
      ],
      [createdIn()],
    );

    expect(of(state, 'ReleaseLock')).toEqual([
      {
        kind: 'ReleaseLock',
        runId: RUN_ID,
        node: 'fix-1',
        lock: 'worktree',
        key: SHARED,
        reason: 'reclaimed',
      },
    ]);
    expect(startNodes(state)).toEqual(['fix-2']);
  });

  it('the repo lock and the worktree lock over one path are two different locks', () => {
    const state = started(
      [{ id: 'fix-1', permission: 'worktree', writes: ['src/**'] }],
      [scheduled('fix-1', REPO)],
      [createdIn()],
    );

    expect(of(state, 'AcquireLock')).toEqual([
      { kind: 'AcquireLock', runId: RUN_ID, node: 'fix-1', lock: 'repo', key: REPO_LOCK },
      { kind: 'AcquireLock', runId: RUN_ID, node: 'fix-1', lock: 'worktree', key: REPO },
    ]);
  });
});

// ── EPIC-06-S21, EPIC-06-S22 — every wait is a node_wake row ─────────────────

/** Durations, spelled the way the flow scenarios spell them. */
const hours = (count: number): number => count * 3_600_000;
const days = (count: number): number => count * 86_400_000;

/** Node's ceiling: `setTimeout(2**31)` fires after ~1 ms instead of clamping. */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

/**
 * A human gate with a deadline. The instant is carried as ISO-8601 inside the
 * payload and as an integer ms epoch in the projection — `wakeAt` is an
 * instant, never a duration, because a duration is only meaningful relative to
 * a process that is still running.
 */
const suspendedUntil = (node: string, wakeAt: number): Row => ({
  kind: 'node.suspended',
  payload: { node, until: { kind: 'human', wakeAt: new Date(wakeAt).toISOString() } },
});

const backoffTo = (node: string, wakeAt: number): readonly Row[] => [
  startedNode('recon'),
  failed(node, 'transient'),
  retryScheduled(node, 1, wakeAt),
];

suite('EPIC-06-S22 — a suspended node waits as a row, not a timer (KAR-06.6)', () => {
  it('AC4: the reason vocabulary is the closed set the node_wake column stores', () => {
    expect(WAKE_REASONS).toEqual(['backoff', 'human_gate', 'poll']);
  });

  it('AC4: a six-hour human gate asks for exactly one row, with reason human_gate', () => {
    const wakeAt = NOW + hours(6);
    const state = started(CHAIN, [startedNode('recon'), suspendedUntil('recon', wakeAt)]);

    expect(of(state, 'ScheduleWake')).toEqual([
      { kind: 'ScheduleWake', runId: RUN_ID, node: 'recon', wakeAt, reason: 'human_gate' },
    ]);
  });

  it('AC7: and it holds no slot and no lock while it sleeps', () => {
    const wakeAt = NOW + hours(6);
    const state = started(
      [{ id: 'gate', permission: 'worktree', writes: ['src/**'] }, { id: 'analysis' }],
      [
        lockAcquired('gate', 'repo', REPO_LOCK),
        startedNode('gate'),
        suspendedUntil('gate', wakeAt),
      ],
      [createdIn()],
    );

    // The lock goes back on the same tick the suspension is observed …
    expect(of(state, 'ReleaseLock').map((command) => command.node)).toEqual(['gate']);
    // … and the slot it was occupying is spent on unrelated work, not held.
    expect(startNodes(state)).toEqual(['analysis']);
  });

  it('AC4: a backoff and a poll are told apart in the row, not in the reader’s head', () => {
    const backoff = started(CHAIN, backoffTo('recon', NOW + 4_000));
    expect(of(backoff, 'ScheduleWake')[0]?.reason).toBe('backoff');

    const external = started(CHAIN, [
      startedNode('recon'),
      {
        kind: 'node.suspended',
        payload: {
          node: 'recon',
          until: { kind: 'external', wakeAt: new Date(NOW + 4_000).toISOString() },
        },
      },
    ]);
    expect(of(external, 'ScheduleWake')[0]?.reason).toBe('poll');
  });
});

suite('EPIC-06-S21 — a 30-day gate is a row, because a 30-day timer is a lie', () => {
  const wakeAt = NOW + days(30);

  it('AC5: the wake is a plain integer ms epoch, and it is one no timer could hold', () => {
    const state = started(CHAIN, backoffTo('recon', wakeAt));
    const [wake] = of(state, 'ScheduleWake');

    expect(wake).toEqual({
      kind: 'ScheduleWake',
      runId: RUN_ID,
      node: 'recon',
      wakeAt,
      reason: 'backoff',
    });
    expect(Number.isSafeInteger(wake?.wakeAt)).toBe(true);
    // The whole reason the row exists: as a *delay* this overflows Node's
    // timer, and Node does not clamp — it fires after ~1 ms.
    expect(wakeAt - NOW).toBeGreaterThan(MAX_TIMER_DELAY);
  });

  it('AC5: and it is honoured exactly — nothing at 29 days, once at 30', () => {
    const state = started(CHAIN, backoffTo('recon', wakeAt));

    expect(startNodes(state, NOW + days(29))).toEqual([]);
    expect(startNodes(state, wakeAt)).toEqual(['recon']);
  });

  it('AC8: a clock that jumps backwards skips nothing and fires nothing twice', () => {
    const state = started(CHAIN, backoffTo('recon', NOW + hours(2)));

    // now moves BACKWARDS by an hour, as laptop sleep and NTP correction do.
    expect(startNodes(state, NOW - hours(1))).toEqual([]);
    // The row is restated unchanged — the same instant, not a recomputed delay.
    expect(of(state, 'ScheduleWake', NOW - hours(1))[0]?.wakeAt).toBe(NOW + hours(2));
    // And then forward across it: exactly one start, at the instant on the row.
    expect(startNodes(state, NOW + hours(2))).toEqual(['recon']);
  });
});
