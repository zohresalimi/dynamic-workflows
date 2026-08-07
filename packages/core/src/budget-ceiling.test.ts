/**
 * KAR-14.2 — the ceiling check, as a pure question about reduced state.
 *
 * Every state here is folded from **real, parsed events**, for the reason
 * ./decide.test.ts gives at length: a hand-assembled `RunState` would let the
 * ceiling agree with a shape the reducer cannot produce, and the ceiling is the
 * one mechanism whose wrongness costs money in both directions.
 *
 * Verifies: EPIC-14-S10 · KAR-14.2 AC1, AC2, AC3, AC6, AC7 · test plan #1–#5
 */
import { expect, it, describe as suite } from 'vitest';
import {
  budgetTripFailure,
  budgetTrips,
  ceilingHash,
  nodeCeiling,
  resolveCeilings,
} from './budget-ceiling.ts';
import type { Command, EmitEvent } from './command.ts';
import { decide } from './decide.ts';
import { parseDeFlowConfig } from './deflow-config.ts';
import type { EventKind } from './event-payloads.ts';
import { EVENT_SCHEMAS } from './event-payloads.ts';
import type { Event } from './events.ts';
import { parseEvent } from './events.ts';
import { EventSeqSchema } from './ids.ts';
import { reduce } from './reduce.ts';
import { initialRunState, type RunState } from './run-state.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c';
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const CEILING_HASH = `sha256-${'e'.repeat(64)}`;
const T0 = 1_754_150_000_000;
const HOUR = 3_600_000;

interface NodeSpec {
  readonly id: string;
  readonly deps?: readonly string[];
  /** The node's own `budget` block, as the plan document spells it. */
  readonly budget?: Record<string, number>;
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
    retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
    budget: { ...spec.budget },
    brief: `brief for ${spec.id}`,
    provider: { prefer: ['claude'], requires: [] },
    resume: 'always-replay',
  };
}

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
  readonly ts?: number;
}

function parse(row: Row, seq: number): Event {
  const result = parseEvent({
    seq,
    runId: RUN_ID,
    ts: row.ts ?? T0,
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

/** The ceiling as the run-creation path pins it: one event, per scope. */
const ceiling = (
  scope: 'run' | 'node',
  values: { costUsd?: number | null; wallclockMs?: number | null },
  extra: { node?: string; source?: 'request' | 'config' | 'operator' } = {},
): Row => ({
  kind: 'budget.ceiling.set',
  payload: {
    scope,
    ...(extra.node === undefined ? {} : { node: extra.node }),
    costUsd: values.costUsd ?? null,
    wallclockMs: values.wallclockMs ?? null,
    source: extra.source ?? 'request',
    hash: CEILING_HASH,
  },
});

/** One `budget.consumed`, in the tier the caller cares about. */
const consumed = (
  node: string | null,
  costUsd: number,
  source: 'vendor-reported' | 'estimated' = 'vendor-reported',
): Row => ({
  kind: 'budget.consumed',
  payload: {
    ...(node === null ? {} : { node, attempt: 0 }),
    provider: 'claude',
    usage: { inputTokens: 1200, outputTokens: 340, source },
    costUsd,
    authMode: 'subscription',
  },
});

const startedNode = (node: string, ts = T0): Row => ({
  kind: 'node.started',
  ts,
  payload: {
    node,
    attempt: 0,
    ikey: `${RUN_ID}/${node}/0/0`,
    binary: { path: '/usr/bin/DeFlow-mock-agent', version: '1.0.0', sha256: 'd'.repeat(64) },
  },
});

const COMPLETED = {
  status: 'completed',
  output: { summary: 'done' },
  outputSchemaId: 'DeFlow.artifact.v1',
  usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
  costUsd: 0.42,
  producedFacts: [],
  artifacts: [],
};

const completed = (node: string): Row => ({
  kind: 'node.completed',
  payload: { node, attempt: 0, result: COMPLETED },
});

/** A run of `nodes`, started, with `rest` folded on top. */
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

const emitted = (commands: readonly Command[], kind: string): EmitEvent[] =>
  commands.filter(
    (command): command is EmitEvent => command.kind === 'EmitEvent' && command.event.kind === kind,
  );

const starts = (commands: readonly Command[]): string[] =>
  commands.filter((command) => command.kind === 'StartNode').map((command) => command.node);

const CHAIN: readonly NodeSpec[] = [{ id: 'recon' }, { id: 'impl', deps: ['recon'] }];

suite('EPIC-14-S10 — a run ceiling stops admission everywhere (test plan #1)', () => {
  it('returns the pause commands and admits nothing', () => {
    const state = started(CHAIN, [ceiling('run', { costUsd: 0.5 }), consumed('recon', 0.51)]);

    const commands = decide(state, T0);

    expect(starts(commands)).toEqual([]);
    const exceeded = emitted(commands, 'budget.exceeded');
    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]?.event.payload).toMatchObject({
      scope: 'run',
      dimension: 'cost',
      limit: 0.5,
      actual: 0.51,
      failureClass: 'gate',
      firedBy: 'deflow',
    });
    expect(emitted(commands, 'run.paused')[0]?.event.payload).toMatchObject({ by: 'policy' });
    expect(emitted(commands, 'run.needs_human')[0]?.event.payload).toMatchObject({
      reason: 'budget',
    });
  });

  it('emits the three in the order S8 names, so the pause is what the projection keeps', () => {
    const state = started(CHAIN, [ceiling('run', { costUsd: 0.5 }), consumed('recon', 0.51)]);

    const kinds = decide(state, T0)
      .filter((command) => command.kind === 'EmitEvent')
      .map((command) => command.event.kind);

    expect(kinds).toEqual(['budget.exceeded', 'run.paused', 'run.needs_human']);
  });

  it('says nothing at all while the run is under its ceiling', () => {
    const state = started(CHAIN, [ceiling('run', { costUsd: 0.5 }), consumed('recon', 0.49)]);

    expect(emitted(decide(state, T0), 'budget.exceeded')).toEqual([]);
    expect(starts(decide(state, T0))).toEqual(['recon']);
  });

  it('trips on nothing when no ceiling was ever set', () => {
    const state = started(CHAIN, [consumed('recon', 4200)]);

    expect(emitted(decide(state, T0), 'budget.exceeded')).toEqual([]);
  });

  it('does not restate the trip once the pause is folded (one trip per episode)', () => {
    const state = started(CHAIN, [
      ceiling('run', { costUsd: 0.5 }),
      consumed('recon', 0.51),
      { kind: 'budget.exceeded', payload: tripPayload() },
      { kind: 'run.paused', payload: { by: 'policy', reason: 'budget' } },
      { kind: 'run.needs_human', payload: { reason: 'budget', detail: 'run cost ceiling' } },
    ]);

    expect(emitted(decide(state, T0), 'budget.exceeded')).toEqual([]);
    expect(starts(decide(state, T0))).toEqual([]);
  });

  it('trips again after a resume that did not raise the ceiling', () => {
    const paused = [
      ceiling('run', { costUsd: 0.5 }),
      consumed('recon', 0.51),
      { kind: 'budget.exceeded' as const, payload: tripPayload() },
      { kind: 'run.paused' as const, payload: { by: 'policy', reason: 'budget' } },
      { kind: 'run.resumed' as const, payload: { by: 'user' } },
    ];

    expect(emitted(decide(started(CHAIN, paused), T0), 'budget.exceeded')).toHaveLength(1);
  });

  it('admits again once the operator raises the ceiling and resumes', () => {
    const state = started(CHAIN, [
      ceiling('run', { costUsd: 0.5 }),
      consumed('recon', 0.51),
      { kind: 'budget.exceeded', payload: tripPayload() },
      { kind: 'run.paused', payload: { by: 'policy', reason: 'budget' } },
      { kind: 'run.needs_human', payload: { reason: 'budget', detail: 'run cost ceiling' } },
      ceiling('run', { costUsd: 5 }, { source: 'operator' }),
      { kind: 'run.resumed', payload: { by: 'user' } },
    ]);

    expect(emitted(decide(state, T0), 'budget.exceeded')).toEqual([]);
    expect(starts(decide(state, T0))).toEqual(['recon']);
  });
});

function tripPayload(): Record<string, unknown> {
  return {
    scope: 'run',
    dimension: 'cost',
    limit: 0.5,
    actual: 0.51,
    failureClass: 'gate',
    firedBy: 'deflow',
  };
}

suite('EPIC-14-S10 — the scope/dimension outline (test plan #3)', () => {
  it('run/cost: nothing is admitted anywhere', () => {
    const state = started(CHAIN, [ceiling('run', { costUsd: 25 }), consumed('recon', 25.4)]);
    const commands = decide(state, T0);

    expect(emitted(commands, 'budget.exceeded')[0]?.event.payload).toMatchObject({
      scope: 'run',
      dimension: 'cost',
      limit: 25,
      actual: 25.4,
    });
    expect(starts(commands)).toEqual([]);
  });

  it('run/wallclock: nothing is admitted anywhere', () => {
    const state = started(CHAIN, [ceiling('run', { wallclockMs: 14_400_000 })]);
    const commands = decide(state, T0 + 14_400_001);

    expect(emitted(commands, 'budget.exceeded')[0]?.event.payload).toMatchObject({
      scope: 'run',
      dimension: 'wallclock',
      limit: 14_400_000,
      actual: 14_400_001,
    });
    expect(starts(commands)).toEqual([]);
  });

  it('node/cost: that node is suspended and escalated, and its siblings are not', () => {
    const state = started(
      [{ id: 'recon' }, { id: 'n-a', deps: ['recon'] }, { id: 'n-b', deps: ['recon'] }],
      [
        ceiling('node', { costUsd: 2 }),
        completed('recon'),
        consumed('n-a', 2.05),
        consumed('n-b', 0.02),
      ],
    );

    const commands = decide(state, T0);
    const exceeded = emitted(commands, 'budget.exceeded');

    expect(exceeded).toHaveLength(1);
    expect(exceeded[0]?.event.payload).toMatchObject({
      scope: 'node',
      node: 'n-a',
      dimension: 'cost',
      limit: 2,
      actual: 2.05,
    });
    expect(emitted(commands, 'node.suspended')[0]?.event.payload).toMatchObject({
      node: 'n-a',
      until: { kind: 'human' },
    });
    // The run itself keeps going: this is the whole of AC6.
    expect(emitted(commands, 'run.paused')).toEqual([]);
    expect(starts(commands)).toEqual(['n-b']);
  });

  it('node/wallclock: the same, measured from the attempt that is running', () => {
    const state = started(
      [{ id: 'n-a', budget: { maxWallClockMs: 600_000 } }, { id: 'n-b' }],
      [
        startedNode('n-a'),
        { kind: 'node.failed', payload: failedTransiently('n-a') },
        {
          kind: 'node.retry.scheduled',
          payload: { node: 'n-a', nextAttempt: 1, wakeAt: T0 + 2000 },
        },
      ],
    );

    const commands = decide(state, T0 + 600_001);
    const exceeded = emitted(commands, 'budget.exceeded');

    expect(exceeded[0]?.event.payload).toMatchObject({
      scope: 'node',
      node: 'n-a',
      dimension: 'wallclock',
      limit: 600_000,
      actual: 600_001,
    });
    expect(starts(commands)).toEqual(['n-b']);
  });

  it('leaves a node alone while its own attempt is still in flight', () => {
    const state = started(
      [{ id: 'n-a', budget: { maxCostUsd: 0.1 } }],
      [startedNode('n-a'), consumed('n-a', 0.5)],
    );

    // Admission is the lever: tearing down a node most of the way through a
    // build to save a few cents turns a pause into a partial failure.
    expect(emitted(decide(state, T0), 'budget.exceeded')).toEqual([]);
  });

  it("takes a node's own plan budget over the run-wide node default", () => {
    const state = started(
      [{ id: 'n-a', budget: { maxCostUsd: 4 } }],
      [ceiling('node', { costUsd: 0.1 }), consumed('n-a', 2)],
    );

    expect(nodeCeiling(state, 'n-a').costUsd).toBe(4);
    expect(emitted(decide(state, T0), 'budget.exceeded')).toEqual([]);
  });

  it('takes an explicitly raised node ceiling over both', () => {
    const state = started(
      [{ id: 'n-a', budget: { maxCostUsd: 4 } }],
      [ceiling('node', { costUsd: 9 }, { node: 'n-a', source: 'operator' })],
    );

    expect(nodeCeiling(state, 'n-a').costUsd).toBe(9);
  });
});

function failedTransiently(node: string): Record<string, unknown> {
  return {
    node,
    attempt: 0,
    failure: {
      reason: 'adapter.spawn-failed',
      class: 'transient',
      message: `${node} could not be spawned`,
      evidence: [],
      occurredAtEvent: 1,
      attempt: 0,
    },
  };
}

suite('a breach is a gate, and the taxonomy is what says so (test plan #2)', () => {
  for (const dimension of ['cost', 'wallclock'] as const) {
    for (const scope of ['run', 'node'] as const) {
      it(`${scope}/${dimension} classifies as gate, never permanent and never transient`, () => {
        const failure = budgetTripFailure(
          { scope, dimension, limit: 1, actual: 2, firedBy: 'deflow' },
          { occurredAtEvent: EventSeqSchema.parse(1), attempt: 0 },
        );

        expect(failure.class).toBe('gate');
        expect(failure.class).not.toBe('permanent');
        expect(failure.class).not.toBe('transient');
      });
    }
  }

  it('refuses a budget.exceeded that claims any other class', () => {
    for (const failureClass of ['permanent', 'transient'] as const) {
      const result = parseEvent({
        seq: 1,
        runId: RUN_ID,
        ts: T0,
        kind: 'budget.exceeded',
        v: EVENT_SCHEMAS['budget.exceeded'].v,
        epoch: 1,
        payload: { ...tripPayload(), failureClass },
      });

      expect(result.status).toBe('invalid-payload');
    }
  });
});

suite('the trip carries its provenance (test plan #5, AC7)', () => {
  it('labels a trip driven wholly by estimates as estimate-driven', () => {
    const state = started(CHAIN, [
      ceiling('run', { costUsd: 0.5 }),
      consumed('recon', 0.51, 'estimated'),
    ]);

    const trip = emitted(decide(state, T0), 'budget.exceeded')[0]?.event.payload;

    expect(trip).toMatchObject({
      basis: { vendorReported: null, estimated: 0.51, estimateDriven: true, unaccounted: [] },
    });
  });

  it('does not label a trip a vendor-reported figure contributed to', () => {
    const state = started(CHAIN, [
      ceiling('run', { costUsd: 0.5 }),
      consumed('recon', 0.4, 'vendor-reported'),
      consumed('recon', 0.2, 'estimated'),
    ]);

    expect(emitted(decide(state, T0), 'budget.exceeded')[0]?.event.payload).toMatchObject({
      basis: { vendorReported: 0.4, estimated: 0.2, estimateDriven: false },
    });
  });

  it('names the providers whose spend nobody could price', () => {
    const state = started(CHAIN, [
      ceiling('run', { costUsd: 0.5 }),
      consumed('recon', 0.51),
      {
        kind: 'budget.consumed',
        payload: {
          node: 'recon',
          attempt: 0,
          provider: 'gemini',
          usage: { inputTokens: 900, outputTokens: 100, source: 'estimated' },
          costUsd: null,
          authMode: 'subscription',
        },
      },
    ]);

    expect(emitted(decide(state, T0), 'budget.exceeded')[0]?.event.payload).toMatchObject({
      basis: { unaccounted: ['gemini'] },
    });
  });
});

suite('the effective ceiling is resolved once, and pinned (AC1)', () => {
  const config = {
    budget: { run: { costUsd: 10, wallclockMs: 14_400_000 }, node: { costUsd: 2 } },
  };

  it('takes the request over the config default, per dimension', () => {
    const effective = resolveCeilings({
      requested: { costUsd: 25 },
      config: parseDeFlowConfig(config),
    });

    expect(effective.run).toEqual({ costUsd: 25, wallclockMs: 14_400_000 });
    expect(effective.node).toEqual({ costUsd: 2, wallclockMs: null });
  });

  it('falls back to the config when the request names no budget at all', () => {
    const effective = resolveCeilings({ config: parseDeFlowConfig(config) });

    expect(effective.run).toEqual({ costUsd: 10, wallclockMs: 14_400_000 });
  });

  it('is no ceiling at all when neither names one — never a zero', () => {
    const effective = resolveCeilings({});

    expect(effective.run).toEqual({ costUsd: null, wallclockMs: null });
    expect(effective.node).toEqual({ costUsd: null, wallclockMs: null });
  });

  it('hashes the effective values, so a later config edit is visible as drift', async () => {
    const pinned = await ceilingHash(resolveCeilings({ config: parseDeFlowConfig(config) }));
    const edited = await ceilingHash(
      resolveCeilings({
        config: parseDeFlowConfig({ budget: { run: { costUsd: 500 }, node: { costUsd: 2 } } }),
      }),
    );

    expect(pinned).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(edited).not.toBe(pinned);
  });

  it('hashes the values and not the key order they were written in', async () => {
    const one = await ceilingHash({
      run: { costUsd: 1, wallclockMs: 2 },
      node: { wallclockMs: 4, costUsd: 3 },
    });
    const other = await ceilingHash({
      node: { costUsd: 3, wallclockMs: 4 },
      run: { wallclockMs: 2, costUsd: 1 },
    });

    expect(one).toBe(other);
  });

  it('is what the run folds, so editing the file mid-run moves nothing', () => {
    // The event carries the effective values; nothing re-reads the file.
    const state = started(CHAIN, [ceiling('run', { costUsd: 0.5 })]);

    expect(state.ceilings.run).toEqual({ costUsd: 0.5, wallclockMs: null });
    expect(state.ceilings.hash).toBe(CEILING_HASH);
  });
});

suite('wall-clock is a question about the injected instant (AC10)', () => {
  it('trips six hours in with no timer anywhere, from `now` alone', () => {
    const state = started(CHAIN, [ceiling('run', { wallclockMs: 6 * HOUR })]);

    expect(budgetTrips(state, T0 + 6 * HOUR)).toEqual([]);
    const trips = budgetTrips(state, T0 + 6 * HOUR + 1);

    expect(trips).toHaveLength(1);
    expect(trips[0]?.breach).toMatchObject({ dimension: 'wallclock', actual: 6 * HOUR + 1 });
  });
});
