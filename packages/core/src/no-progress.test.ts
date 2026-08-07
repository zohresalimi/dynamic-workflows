/**
 * KAR-06.8 — the stall detector and the churn circuit breaker
 * (docs/05-durable-execution.md §11, F4.7).
 *
 * Every state here is folded from **real, parsed events** through `reduce`,
 * for the reason decide.test.ts gives: the detectors read fields the reducer
 * maintains — `watermarkSeq`, `watermarkTs`, the churn window, the replan
 * streak — and a hand-assembled `RunState` would let them agree with a shape
 * the reducer cannot actually produce. That is precisely the failure this
 * story exists to catch, since the whole design rests on "the watermark moves
 * only when the projection does".
 *
 * Nothing in this file touches a clock, a database or a process: a 40-minute
 * stall and a 20-attempt churn window are both plain arithmetic over `now`.
 *
 * Verifies: EPIC-06-S26, EPIC-06-S27, EPIC-06-S28 · AC1–AC9
 */
import { expect, it, describe as suite } from 'vitest';
import type { Command, EmitEvent, EmittedEvent, StartNode } from './command.ts';
import { decide } from './decide.ts';
import type { EventKind } from './event-payloads.ts';
import { EVENT_KINDS, EVENT_SCHEMAS } from './event-payloads.ts';
import type { Event } from './events.ts';
import { parseEvent } from './events.ts';
import type { NoProgressPolicy } from './no-progress.ts';
import { CHURN_WINDOW, DEFAULT_NO_PROGRESS_POLICY, noProgress } from './no-progress.ts';
import { reduce } from './reduce.ts';
import { initialRunState, type RunState } from './run-state.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c';
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const HANDLE = `artifact://${'b'.repeat(64)}`;

/** The instant every fixture's ledger is written at. */
const T0 = 1_754_150_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

/** A `sha256-<64 hex>` request hash whose first hex digits are `seed`. */
const hash = (seed: string): string => `sha256-${seed.padEnd(64, '0')}`;

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
  readonly maxAttempts?: number;
}

function agentNode(spec: NodeSpec): Record<string, unknown> {
  return {
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
    retry: {
      maxAttempts: spec.maxAttempts ?? 3,
      backoff: { base: 2000, cap: 300_000, jitter: 'full' },
    },
    budget: {},
    brief: `brief for ${spec.id}`,
    provider: { prefer: ['claude-code'], requires: [] },
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
  /** ms epoch on the envelope. Defaults to `T0`. */
  readonly at?: number;
  readonly node?: string;
  readonly attempt?: number;
  readonly ikey?: string;
}

function parse(row: Row, seq: number): Event {
  const result = parseEvent({
    seq,
    runId: RUN_ID,
    ts: row.at ?? T0,
    kind: row.kind,
    v: EVENT_SCHEMAS[row.kind].v,
    epoch: 1,
    ...(row.node === undefined ? {} : { nodeId: row.node }),
    ...(row.attempt === undefined ? {} : { attempt: row.attempt }),
    ...(row.ikey === undefined ? {} : { ikey: row.ikey }),
    payload: row.payload,
  });
  if (result.status !== 'ok') {
    throw new Error(`fixture for ${row.kind} is not a valid event: ${JSON.stringify(result)}`);
  }
  return result.event;
}

function fold(rows: readonly Row[], from: RunState = initialRunState()): RunState {
  let state = from;
  for (const [index, row] of rows.entries()) {
    state = reduce(state, parse(row, index + 1));
  }
  return state;
}

/** Folds `rows` on top of `state`, continuing the seq counter past its watermark. */
function foldOnto(state: RunState, rows: readonly Row[]): RunState {
  let next = state;
  let seq = state.watermarkSeq;
  for (const row of rows) {
    seq += 1;
    next = reduce(next, parse(row, seq));
  }
  return next;
}

function started(nodes: readonly NodeSpec[], rest: readonly Row[] = []): RunState {
  return fold([
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
  ]);
}

const startNode = (node: string, attempt = 0, at?: number): Row => ({
  kind: 'node.started',
  node,
  attempt,
  ...(at === undefined ? {} : { at }),
  payload: {
    node,
    attempt,
    ikey: `${RUN_ID}/${node}/${attempt}/0`,
    binary: { path: '/usr/bin/DeFlow-mock-agent', version: '1.0.0', sha256: 'd'.repeat(64) },
  },
});

const effectStarted = (node: string, attempt: number, requestHash: string, at?: number): Row => ({
  kind: 'effect.started',
  node,
  attempt,
  ikey: `${RUN_ID}/${node}/${attempt}/0`,
  ...(at === undefined ? {} : { at }),
  payload: { ikey: `${RUN_ID}/${node}/${attempt}/0`, kind: 'agent', requestHash },
});

const completed = (node: string, attempt = 0, at?: number): Row => ({
  kind: 'node.completed',
  node,
  attempt,
  ...(at === undefined ? {} : { at }),
  payload: { node, attempt, result: COMPLETED },
});

const progress = (node: string, attempt = 0, at?: number): Row => ({
  kind: 'node.progress',
  node,
  attempt,
  ...(at === undefined ? {} : { at }),
  payload: { node, attempt, phase: 'thinking' },
});

const retryScheduled = (node: string, nextAttempt: number, wakeAt: number): Row => ({
  kind: 'node.retry.scheduled',
  node,
  payload: { node, nextAttempt, wakeAt },
});

const patched = (version: number, toHash: string, at?: number): Row => ({
  kind: 'plan.patched',
  ...(at === undefined ? {} : { at }),
  payload: {
    version,
    fromHash: PLAN_HASH,
    toHash,
    patchId: `patch-${version}`,
    decision: { decision: 'auto', by: 'policy', at: '2026-08-02T14:11:33.000Z' },
  },
});

/** One completed attempt, as the ledger writes it: the effect that names what
 * was asked for, then the completion that closes the attempt. */
const attemptRows = (node: string, attempt: number, requestHash: string): Row[] => [
  effectStarted(node, attempt, requestHash),
  completed(node, attempt),
];

function withPolicy(state: RunState, patch: Partial<NoProgressPolicy>): RunState {
  return {
    ...state,
    policy: { ...state.policy, noProgress: { ...state.policy.noProgress, ...patch } },
  };
}

/** The caps raised out of the way, so a churn fixture trips the *detector*. */
const DETECTORS_ONLY: Partial<NoProgressPolicy> = {
  maxAttemptsPerNode: 1000,
  maxTotalNodeExecutions: 10_000,
};

/** An `EmitEvent` whose payload the compiler has narrowed to `kind`'s. */
type EmittedOf<K extends EventKind> = EmitEvent & {
  readonly event: Extract<EmittedEvent, { kind: K }>;
};

const emitted = <K extends EventKind>(commands: readonly Command[], kind: K): EmittedOf<K>[] =>
  commands.filter(
    (command): command is EmittedOf<K> =>
      command.kind === 'EmitEvent' && command.event.kind === kind,
  );

const startNodes = (commands: readonly Command[]): StartNode[] =>
  commands.filter((command): command is StartNode => command.kind === 'StartNode');

// ── EPIC-06-S26: the progress watermark ──────────────────────────────────────

suite('the data plane cannot advance the watermark (AC1)', () => {
  it('has no io_chunk event kind at all, so the reducer structurally cannot read one', () => {
    expect(EVENT_KINDS as readonly string[]).not.toContain('io_chunk');
  });

  it('leaves the watermark and its instant where they were after 10,000 progress events', () => {
    const running = started([{ id: 'a' }, { id: 'b', deps: ['a'] }], [startNode('a')]);

    const noise: Row[] = [];
    for (let index = 0; index < 10_000; index += 1) {
      noise.push(progress('a', 0, T0 + index));
    }
    const noisy = foldOnto(running, noise);

    expect(noisy.watermarkSeq).toBe(running.watermarkSeq);
    expect(noisy.watermarkTs).toBe(running.watermarkTs);
    expect(noisy).toBe(running);
  });

  it('advances on the completion the silent agent finally reaches', () => {
    const running = started([{ id: 'a' }, { id: 'b', deps: ['a'] }], [startNode('a')]);
    const done = foldOnto(running, [completed('a', 0, T0 + 8 * MINUTE)]);

    expect(done.watermarkSeq).toBeGreaterThan(running.watermarkSeq);
    expect(done.watermarkTs).toBe(T0 + 8 * MINUTE);
  });
});

// ── EPIC-06-S26: the stall detector ──────────────────────────────────────────

/** One node running, one node asleep on a backoff — so every tick has a
 * standing `ScheduleWake` and "the commands are unchanged" is not vacuous. */
function stalledRun(): RunState {
  return started(
    [{ id: 'a' }, { id: 'b', deps: ['a'] }, { id: 'c' }],
    [startNode('a'), retryScheduled('c', 1, T0 + 24 * 60 * MINUTE)],
  );
}

suite('the stall detector reports and never acts (AC2, AC3, AC4, AC9)', () => {
  it('says nothing at 9 minutes 59 seconds of silence', () => {
    const state = stalledRun();
    const commands = decide(state, T0 + 9 * MINUTE + 59 * SECOND);

    expect(emitted(commands, 'run.stalled')).toEqual([]);
  });

  it('emits exactly one run.stalled carrying the watermark, the idle time and the running nodes', () => {
    const state = stalledRun();
    const commands = decide(state, T0 + 10 * MINUTE + SECOND);
    const reports = emitted(commands, 'run.stalled');

    expect(reports).toHaveLength(1);
    expect(reports[0]?.event.payload).toEqual({
      watermarkSeq: state.watermarkSeq,
      idleMs: 10 * MINUTE + SECOND,
      runningNodes: ['a'],
    });
  });

  it('does not report the same episode twice, however long it lasts', () => {
    const state = stalledRun();
    const report = emitted(decide(state, T0 + 10 * MINUTE + SECOND), 'run.stalled')[0];
    if (report === undefined) throw new Error('expected a stall report');

    const reported = foldOnto(state, [{ kind: 'run.stalled', payload: report.event.payload }]);

    expect(emitted(decide(reported, T0 + 20 * MINUTE), 'run.stalled')).toEqual([]);
    expect(emitted(decide(reported, T0 + 40 * MINUTE), 'run.stalled')).toEqual([]);
  });

  it('reports again once the run makes progress and then goes quiet a second time', () => {
    const state = stalledRun();
    const report = emitted(decide(state, T0 + 10 * MINUTE + SECOND), 'run.stalled')[0];
    if (report === undefined) throw new Error('expected a stall report');

    const moved = foldOnto(state, [
      { kind: 'run.stalled', payload: report.event.payload },
      completed('a', 0, T0 + 12 * MINUTE),
      startNode('b', 0, T0 + 12 * MINUTE),
    ]);

    expect(emitted(decide(moved, T0 + 23 * MINUTE), 'run.stalled')).toHaveLength(1);
  });

  it('kills, fails and reschedules nothing — the scheduling commands are unchanged', () => {
    const state = stalledRun();
    const before = decide(state, T0 + 9 * MINUTE + 59 * SECOND);

    const stalledTick = decide(state, T0 + 10 * MINUTE + SECOND);
    const report = emitted(stalledTick, 'run.stalled')[0];
    if (report === undefined) throw new Error('expected a stall report');

    // The only difference the stall makes to a tick is the report itself.
    expect(stalledTick.filter((command) => command !== report)).toEqual(before);

    // And once the episode is on the log, the tick is deeply equal again —
    // including forty minutes into a stall nobody has resolved.
    const reported = foldOnto(state, [{ kind: 'run.stalled', payload: report.event.payload }]);
    expect(decide(reported, T0 + 40 * MINUTE)).toEqual(before);

    for (const commands of [before, stalledTick]) {
      expect(commands.some((command) => command.kind === 'CancelNode')).toBe(false);
      expect(emitted(commands, 'node.failed')).toEqual([]);
    }
  });

  it('says nothing when no node is running, however quiet the run is', () => {
    const idle = started([{ id: 'a' }, { id: 'b', deps: ['a'] }], [retryScheduled('a', 1, T0 + 1)]);

    expect(emitted(decide(idle, T0 + 40 * MINUTE), 'run.stalled')).toEqual([]);
  });

  it('takes its threshold from config', () => {
    const state = withPolicy(stalledRun(), { stallThresholdMs: 30 * MINUTE });

    expect(emitted(decide(state, T0 + 20 * MINUTE), 'run.stalled')).toEqual([]);
    expect(emitted(decide(state, T0 + 30 * MINUTE + SECOND), 'run.stalled')).toHaveLength(1);
  });

  it('defaults that threshold to ten minutes', () => {
    expect(DEFAULT_NO_PROGRESS_POLICY.stallThresholdMs).toBe(10 * MINUTE);
  });
});

// ── EPIC-06-S27: the churn circuit breaker ───────────────────────────────────

const REPAIR = 'repair-auth';
const REPAIR_HASH = hash('9f2a1c');

/** `count` completed attempts of `repair-auth`, all asking for the same work. */
function repeats(count: number, from = 0): Row[] {
  return Array.from({ length: count }, (_unused, index) =>
    attemptRows(REPAIR, from + index, REPAIR_HASH),
  ).flat();
}

/** `count` completed attempts of distinct nodes, none of them the same work. */
function filler(count: number, from = 0): Row[] {
  return Array.from({ length: count }, (_unused, index) =>
    attemptRows(`filler-${from + index}`, 0, hash(`f${from + index}`)),
  ).flat();
}

/** A run whose plan still has `next` ready to go, so "no further StartNode" is
 * a claim about a node that would otherwise start this very tick. */
function churnRun(rows: readonly Row[]): RunState {
  return withPolicy(
    started([{ id: REPAIR, maxAttempts: 1000 }, { id: 'next' }], rows),
    DETECTORS_ONLY,
  );
}

suite('the churn breaker trips on the same work redone (AC5, AC7)', () => {
  it('is a window of the last twenty completed attempts', () => {
    expect(CHURN_WINDOW).toBe(20);
    expect(DEFAULT_NO_PROGRESS_POLICY.churnRepeats).toBe(5);
  });

  it('does not trip on the fifth occurrence', () => {
    const state = churnRun([...filler(14), ...repeats(5)]);

    expect(state.churnWindow).toHaveLength(19);
    expect(noProgress(state, T0).churn).toBeNull();
    expect(emitted(decide(state, T0), 'run.needs_human')).toEqual([]);
    expect(startNodes(decide(state, T0)).map((command) => command.node)).toEqual(['next']);
  });

  it('trips on the sixth, naming the tuples that produced it', () => {
    const state = churnRun([...filler(14), ...repeats(6)]);
    const trip = noProgress(state, T0).churn;

    expect(trip?.reason).toBe('churn');
    expect(trip?.detail).toContain(REPAIR);
    expect(trip?.detail).toContain('9f2a1c');
    // The (attempt, seq) of each of the six attempts that produced the trip.
    for (const entry of state.churnWindow.filter((row) => row.node === REPAIR)) {
      expect(trip?.detail).toContain(`${entry.attempt}/${entry.seq}`);
    }
  });

  it('appends run.needs_human { reason: churn } and starts nothing more', () => {
    const state = churnRun([...filler(14), ...repeats(6)]);
    const commands = decide(state, T0);
    const asks = emitted(commands, 'run.needs_human');

    expect(asks).toHaveLength(1);
    expect(asks[0]?.event.payload.reason).toBe('churn');
    expect(startNodes(commands)).toEqual([]);
  });

  it('keeps asking nobody twice: once the run needs a human the request is not restated', () => {
    const state = churnRun([...filler(14), ...repeats(6)]);
    const ask = emitted(decide(state, T0), 'run.needs_human')[0];
    if (ask === undefined) throw new Error('expected a needs_human request');

    const flagged = foldOnto(state, [{ kind: 'run.needs_human', payload: ask.event.payload }]);

    expect(flagged.status).toBe('needs-human');
    for (let tick = 0; tick < 1000; tick += 1) {
      const commands = decide(flagged, T0 + tick * SECOND);
      expect(startNodes(commands)).toEqual([]);
      expect(emitted(commands, 'run.needs_human')).toEqual([]);
    }
  });

  it('ages old churn out of a bounded window', () => {
    const state = churnRun([...repeats(6), ...filler(21)]);

    expect(state.churnWindow).toHaveLength(CHURN_WINDOW);
    expect(noProgress(state, T0).churn).toBeNull();
  });

  it('does not call eight different requests from one node churn', () => {
    const rows = Array.from({ length: 8 }, (_unused, index) =>
      attemptRows(REPAIR, index, hash(`d${index}`)),
    ).flat();

    expect(noProgress(churnRun(rows), T0).churn).toBeNull();
  });

  it('lets in-flight work finish: nothing is cancelled and nothing new is started', () => {
    // `next` is ready and would start on this very tick; `busy` and `other` are
    // the two attempts already in flight the breaker must leave alone.
    const inFlight = [startNode('busy', 0), startNode('other', 0)];
    const healthy = churnRun([...filler(14), ...repeats(5), ...inFlight]);
    const tripped = churnRun([...filler(14), ...repeats(6), ...inFlight]);

    expect(startNodes(decide(healthy, T0)).map((command) => command.node)).toEqual(['next']);

    const commands = decide(tripped, T0);
    expect(emitted(commands, 'run.needs_human')).toHaveLength(1);
    expect(commands.some((command) => command.kind === 'CancelNode')).toBe(false);
    expect(startNodes(commands)).toEqual([]);
    expect(tripped.nodes.busy?.status).toBe('running');
    expect(tripped.nodes.other?.status).toBe('running');
  });
});

// ── EPIC-06-S28: the planner rearranging deck chairs ─────────────────────────

suite('three flat replans trip the breaker (AC6)', () => {
  const sevenDone = (): Row[] => filler(7);

  it('trips on the third consecutive replan with the completed count flat', () => {
    const state = churnRun([
      ...sevenDone(),
      patched(2, hash('b2')),
      patched(3, hash('b3')),
      patched(4, hash('b4')),
    ]);
    const trip = noProgress(state, T0).churn;

    expect(trip?.reason).toBe('churn');
    expect(trip?.detail).toContain('2');
    expect(trip?.detail).toContain('3');
    expect(trip?.detail).toContain('4');
    expect(trip?.detail).toContain('7');
    expect(emitted(decide(state, T0), 'run.needs_human')).toHaveLength(1);
  });

  it('does not trip on two', () => {
    const state = churnRun([...sevenDone(), patched(2, hash('b2')), patched(3, hash('b3'))]);

    expect(noProgress(state, T0).churn).toBeNull();
  });

  it('restarts the counter from the replan that followed real progress', () => {
    const state = churnRun([
      ...sevenDone(),
      patched(2, hash('b2')),
      patched(3, hash('b3')),
      ...attemptRows('eighth', 0, hash('e8')),
      patched(4, hash('b4')),
    ]);

    expect(state.replans.flat).toBe(1);
    expect(noProgress(state, T0).churn).toBeNull();
  });

  it('takes the number of flat replans from config', () => {
    const rows = [...sevenDone(), patched(2, hash('b2')), patched(3, hash('b3'))];
    const state = withPolicy(churnRun(rows), { flatReplans: 2 });

    expect(noProgress(state, T0).churn?.reason).toBe('churn');
  });
});

// ── EPIC-06-S28: the hard caps ───────────────────────────────────────────────

suite('hard caps back the detectors rather than replacing them (AC8)', () => {
  const OFF: Partial<NoProgressPolicy> = { detectors: false };

  it('defaults maxAttemptsPerNode to three, matching F7.5', () => {
    expect(DEFAULT_NO_PROGRESS_POLICY.maxAttemptsPerNode).toBe(3);
  });

  it('fires maxAttemptsPerNode with the detectors switched off', () => {
    const state = withPolicy(churnRun([...filler(14), ...repeats(6)]), {
      ...OFF,
      maxAttemptsPerNode: DEFAULT_NO_PROGRESS_POLICY.maxAttemptsPerNode,
    });
    const breach = noProgress(state, T0);

    expect(breach.churn).toBeNull();
    expect(breach.cap).toEqual({
      cap: 'maxAttemptsPerNode',
      limit: 3,
      actual: 6,
      node: REPAIR,
    });
    expect(emitted(decide(state, T0), 'run.needs_human')).toHaveLength(1);
    expect(startNodes(decide(state, T0))).toEqual([]);
  });

  it('fires maxRunWallClock with the detectors switched off', () => {
    const state = withPolicy(started([{ id: 'a' }], [startNode('a')]), {
      ...OFF,
      maxRunWallClockMs: 30 * MINUTE,
    });
    const breach = noProgress(state, T0 + 31 * MINUTE);

    expect(breach.stall).toBeNull();
    expect(breach.cap).toEqual({
      cap: 'maxRunWallClock',
      limit: 30 * MINUTE,
      actual: 31 * MINUTE,
      node: null,
    });
  });

  it('fires maxTotalNodeExecutions with the detectors switched off', () => {
    const state = withPolicy(churnRun([...filler(14), ...repeats(6)]), {
      ...OFF,
      maxAttemptsPerNode: 1000,
      maxTotalNodeExecutions: 15,
    });
    const breach = noProgress(state, T0);

    expect(breach.cap).toEqual({
      cap: 'maxTotalNodeExecutions',
      limit: 15,
      actual: 20,
      node: null,
    });
  });

  it('names which cap fired in the run.needs_human detail', () => {
    const state = withPolicy(started([{ id: 'a' }], [startNode('a')]), {
      ...OFF,
      maxRunWallClockMs: 30 * MINUTE,
    });
    const ask = emitted(decide(state, T0 + 31 * MINUTE), 'run.needs_human')[0];

    expect(ask?.event.payload.detail).toContain('maxRunWallClock');
    expect(ask?.event.payload.reason).toBe('budget');
  });

  it('lets the detectors win when a detector and a cap both fire', () => {
    const state = withPolicy(churnRun([...filler(14), ...repeats(6)]), {
      maxAttemptsPerNode: 3,
    });
    const breach = noProgress(state, T0);

    expect(breach.churn?.reason).toBe('churn');
    expect(emitted(decide(state, T0), 'run.needs_human')[0]?.event.payload.reason).toBe('churn');
  });
});

// ── AC9: purity ──────────────────────────────────────────────────────────────

suite('both detectors are pure functions of state and now (AC9)', () => {
  /**
   * "In microseconds" is not asserted with a stopwatch — measuring elapsed time
   * inside the pure core is a clock read wearing a different name, and the lint
   * rule says so. What makes it true is structural and is enforced elsewhere:
   * ../test/purity.test.ts fails the build if a clock, a timer or a random
   * source appears anywhere under packages/core/src, so a forty-minute stall
   * *cannot* be exercised by waiting. All that is left to assert is that it
   * trips from `(state, now)` alone.
   */
  it('exercises a forty-minute stall and a twenty-attempt window with no wait at all', () => {
    const stalled = stalledRun();
    const churning = churnRun([...filler(14), ...repeats(6)]);

    expect(noProgress(stalled, T0 + 40 * MINUTE).stall?.idleMs).toBe(40 * MINUTE);
    expect(churning.churnWindow).toHaveLength(CHURN_WINDOW);
    expect(noProgress(churning, T0).churn?.reason).toBe('churn');
  });

  it('returns a deeply equal answer for the same state and the same instant', () => {
    const state = churnRun([...filler(14), ...repeats(6)]);

    expect(noProgress(state, T0)).toEqual(noProgress(state, T0));
    expect(decide(state, T0)).toEqual(decide(state, T0));
  });
});
