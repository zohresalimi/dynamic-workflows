/**
 * KAR-28.5 — `runPhases(state)`: the run's own shape, folded from the ledger.
 *
 * The definition under test is [ADR
 * 0018](../../../docs/adr/0018-a-phase-is-a-top-level-step-of-the-executing-plan.md)'s: a phase is a
 * top-level step of the executing plan, its work items are the nodes the plan
 * materialises from it, and every figure it reports is a count of node ids that
 * exist. The record is what makes the negative assertions in this file the
 * important ones — a `map` that has not fanned out must not report the width
 * its `over` collection might turn out to have, a `body` template must not be
 * counted beside the children it was cut from, and a run with no adopted plan
 * must answer *nothing* rather than the stages of its own lifecycle.
 *
 * Every state here is built by folding real, parsed events through `reduce`,
 * for the reason `decide.test.ts` states: a hand-assembled `RunState` would let
 * this projection agree with a shape the reducer cannot produce.
 *
 * Verifies: EPIC-28-S20, EPIC-28-S21 · KAR-28.5 AC1, AC2
 */
import { afterEach, expect, it, describe as suite, vi } from 'vitest';
import type { EventKind } from './event-payloads.ts';
import { EVENT_SCHEMAS } from './event-payloads.ts';
import type { Event } from './events.ts';
import { parseEvent } from './events.ts';
import { reduce } from './reduce.ts';
import { runPhases } from './run-phases.ts';
import { initialRunState, type RunState } from './run-state.ts';

const RUN_ID = 'run_20260826T090000Z_1c2d3e';
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const HANDLE = `artifact://${'b'.repeat(64)}`;
const TS = 1_787_000_000_000;

const RETRY = {
  maxAttempts: 3,
  backoff: { base: 2000, cap: 300_000, jitter: 'full' },
} as const;

const BASE = {
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: RETRY,
  budget: {},
} as const;

interface Common {
  readonly id: string;
  readonly title?: string;
  readonly deps?: readonly string[];
  readonly lifecycle?: 'active' | 'superseded' | 'abandoned';
}

type NodeDoc = Record<string, unknown>;

function common(spec: Common): NodeDoc {
  return {
    ...BASE,
    id: spec.id,
    title: spec.title ?? `step ${spec.id}`,
    deps: [...(spec.deps ?? [])],
    ...(spec.lifecycle === undefined ? {} : { lifecycle: spec.lifecycle }),
  };
}

function agent(spec: Common): NodeDoc {
  return {
    ...common(spec),
    type: 'agent',
    brief: `brief for ${spec.id}`,
    provider: { prefer: ['claude-code'], requires: [] },
    resume: 'always-replay',
  };
}

function gate(spec: Common): NodeDoc {
  return {
    ...common(spec),
    type: 'gate',
    gate: { kind: 'deterministic', gateId: 'typecheck' },
    criteria: [],
    independence: { notSessionOf: [], preferDifferentProvider: true },
  };
}

function mapNode(spec: Common & { readonly body: string }): NodeDoc {
  return {
    ...common(spec),
    type: 'map',
    over: { kind: 'fact', key: 'finding/items' },
    concurrency: 4,
    body: spec.body,
    itemIdFrom: 'value-hash',
  };
}

function subgraph(spec: Common & { readonly nodes: readonly NodeDoc[] }): NodeDoc {
  return {
    ...common(spec),
    type: 'subgraph',
    graph: { kind: 'inline', nodes: [...spec.nodes], edges: [] },
  };
}

function planGraph(nodes: readonly NodeDoc[]): NodeDoc {
  return {
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN_ID,
    version: 1,
    planHash: PLAN_HASH,
    parent: null,
    taskSpecHash: SPEC_HASH,
    createdBy: 'planner',
    createdAt: '2026-08-26T09:00:00.000Z',
    nodes: [...nodes],
    edges: nodes.flatMap((node) =>
      ((node.deps as readonly string[] | undefined) ?? []).map((from) => ({
        from,
        to: node.id as string,
        kind: 'control',
      })),
    ),
  };
}

interface Row {
  readonly kind: EventKind;
  readonly payload: unknown;
}

function parse(row: Row, seq: number): Event {
  const parsed = parseEvent({
    seq,
    runId: RUN_ID,
    ts: TS + seq,
    kind: row.kind,
    v: EVENT_SCHEMAS[row.kind].v,
    epoch: 1,
    payload: row.payload,
  });
  if (parsed.status !== 'ok') {
    throw new Error(`fixture for ${row.kind} is not a valid event: ${JSON.stringify(parsed)}`);
  }
  return parsed.event;
}

function fold(rows: readonly Row[]): RunState {
  let state = initialRunState();
  for (const [index, row] of rows.entries()) state = reduce(state, parse(row, index + 1));
  return state;
}

const COMPLETED = {
  status: 'completed',
  output: { summary: 'done' },
  outputSchemaId: 'DeFlow.artifact.v1',
  usage: { inputTokens: 10, outputTokens: 10, source: 'vendor-reported' },
  costUsd: 0.01,
  producedFacts: [],
  artifacts: [HANDLE],
} as const;

const scheduled = (node: string): Row => ({
  kind: 'node.scheduled',
  payload: { node, provider: 'claude-code', model: 'claude-sonnet-4.5', permission: 'read' },
});

const started = (node: string): Row => ({
  kind: 'node.started',
  payload: {
    node,
    attempt: 0,
    ikey: `${RUN_ID}/${node}/0/0`,
    binary: { path: '/usr/bin/claude', version: '2.1.220', sha256: 'd'.repeat(64) },
  },
});

const completed = (node: string): Row => ({
  kind: 'node.completed',
  payload: { node, attempt: 0, result: COMPLETED },
});

const failed = (node: string): Row => ({
  kind: 'node.failed',
  payload: {
    node,
    attempt: 0,
    failure: {
      reason: 'agent.nonzero-exit',
      class: 'permanent',
      message: 'exit 1',
      detail: {},
      evidence: [],
      occurredAtEvent: 1,
      attempt: 0,
    },
  },
});

const cancelled = (node: string): Row => ({
  kind: 'node.cancelled',
  payload: { node, attempt: 0, result: { status: 'cancelled', by: 'user' } },
});

/** A run that adopted `nodes` as its plan, then whatever `after` records. */
function running(nodes: readonly NodeDoc[], after: readonly Row[] = []): RunState {
  return fold([
    { kind: 'run.spec.approved', payload: { specHash: SPEC_HASH, by: 'ui' } },
    {
      kind: 'plan.proposed',
      payload: { version: 1, planHash: PLAN_HASH, graph: planGraph(nodes), by: 'planner' },
    },
    { kind: 'run.started', payload: { planHash: PLAN_HASH } },
    ...after,
  ]);
}

afterEach(() => {
  vi.restoreAllMocks();
});

suite('EPIC-28-S20 — phases are read from the ledger', () => {
  /** Three steps, the middle one a 4-way fan-out: two done, one running, one untouched. */
  const FANOUT = [
    agent({ id: 'recon', title: 'Survey the repository' }),
    mapNode({ id: 'migrate', title: 'Migrate every view', deps: ['recon'], body: 'migrate-one' }),
    agent({ id: 'migrate-one', title: 'Migrate one view', deps: ['recon'] }),
    agent({ id: 'migrate--a', title: 'Migrate a.vue', deps: ['migrate'] }),
    agent({ id: 'migrate--b', title: 'Migrate b.vue', deps: ['migrate'] }),
    agent({ id: 'migrate--c', title: 'Migrate c.vue', deps: ['migrate'] }),
    agent({ id: 'migrate--d', title: 'Migrate d.vue', deps: ['migrate'] }),
    gate({ id: 'gate-typecheck', title: 'The project typechecks', deps: ['migrate'] }),
  ];

  const MID_RUN = running(FANOUT, [
    scheduled('recon'),
    started('recon'),
    completed('recon'),
    scheduled('migrate--a'),
    started('migrate--a'),
    completed('migrate--a'),
    scheduled('migrate--b'),
    started('migrate--b'),
    completed('migrate--b'),
    scheduled('migrate--c'),
    started('migrate--c'),
  ]);

  it('answers the ordered phases, each phase state, and completed/total counts (AC1)', () => {
    const projection = runPhases(MID_RUN);

    expect(projection.basis).toBe('plan');
    expect(projection.phases.map((phase) => phase.id)).toEqual([
      'recon',
      'migrate',
      'gate-typecheck',
    ]);
    expect(
      projection.phases.map((phase) => ({
        title: phase.title,
        state: phase.state,
        completed: phase.completed,
        total: phase.total,
      })),
    ).toEqual([
      { title: 'Survey the repository', state: 'complete', completed: 1, total: 1 },
      { title: 'Migrate every view', state: 'running', completed: 2, total: 4 },
      { title: 'The project typechecks', state: 'pending', completed: 0, total: 1 },
    ]);
  });

  it('names the work items so the band can show a phase without a second model (AC1)', () => {
    const migrate = runPhases(MID_RUN).phases.find((phase) => phase.id === 'migrate');
    expect(migrate?.nodes).toEqual(['migrate--a', 'migrate--b', 'migrate--c', 'migrate--d']);
  });

  it("does not count the map's body template beside the children it was cut from (AC1)", () => {
    const projection = runPhases(MID_RUN);
    // The template stays in the graph and never runs. It is inside the map, so
    // it is neither a phase of its own nor a fifth item of the fan-out.
    expect(projection.phases.map((phase) => phase.id)).not.toContain('migrate-one');
    expect(projection.phases.find((phase) => phase.id === 'migrate')?.total).toBe(4);
  });

  it('orders phases by the plan dependencies, not by the document order (AC1)', () => {
    const shuffled = running([
      gate({ id: 'gate-typecheck', deps: ['impl'] }),
      agent({ id: 'impl', deps: ['recon'] }),
      agent({ id: 'recon' }),
    ]);
    expect(runPhases(shuffled).phases.map((phase) => phase.id)).toEqual([
      'recon',
      'impl',
      'gate-typecheck',
    ]);
  });

  it('reads no clock — a phase state is folded, never elapsed (AC1)', () => {
    const now = vi.spyOn(Date, 'now');
    runPhases(MID_RUN);
    expect(now).not.toHaveBeenCalled();
  });

  it('reports a failed phase as failed and a cancelled one as cancelled, never as each other', () => {
    const state = running(
      [agent({ id: 'impl' }), agent({ id: 'review', deps: ['impl'] })],
      [
        scheduled('impl'),
        started('impl'),
        failed('impl'),
        scheduled('review'),
        started('review'),
        cancelled('review'),
      ],
    );
    expect(runPhases(state).phases.map((phase) => [phase.id, phase.state])).toEqual([
      ['impl', 'failed'],
      ['review', 'cancelled'],
    ]);
  });

  it('a phase with work done and nothing live is still running, not complete', () => {
    const state = running(
      [
        mapNode({ id: 'fan', body: 'fan-body' }),
        agent({ id: 'fan-body' }),
        agent({ id: 'fan--x', deps: ['fan'] }),
        agent({ id: 'fan--y', deps: ['fan'] }),
      ],
      [scheduled('fan--x'), started('fan--x'), completed('fan--x')],
    );
    const [phase] = runPhases(state).phases;
    expect(phase?.state).toBe('running');
    expect([phase?.completed, phase?.total]).toEqual([1, 2]);
  });

  it('folds an inline subgraph into one phase whose items are its own nodes', () => {
    const state = running(
      [
        subgraph({
          id: 'verify',
          title: 'Verify the migration',
          nodes: [agent({ id: 'verify-lint' }), agent({ id: 'verify-tests' })],
        }),
      ],
      [scheduled('verify-lint'), started('verify-lint'), completed('verify-lint')],
    );
    expect(runPhases(state).phases).toEqual([
      {
        id: 'verify',
        title: 'Verify the migration',
        type: 'subgraph',
        state: 'running',
        completed: 1,
        total: 2,
        nodes: ['verify-lint', 'verify-tests'],
      },
    ]);
  });

  it('leaves out the nodes a replan superseded — they are not this plan’s work', () => {
    const state = running([
      agent({ id: 'impl-old', lifecycle: 'superseded' }),
      agent({ id: 'impl-cart' }),
      agent({ id: 'impl-payment' }),
    ]);
    expect(runPhases(state).phases.map((phase) => phase.id)).toEqual(['impl-cart', 'impl-payment']);
  });
});

suite('EPIC-28-S21 — a run with no phase structure is not given one', () => {
  it('answers nothing at all for a run that has adopted no plan (AC2)', () => {
    const framing = fold([
      { kind: 'run.spec.approved', payload: { specHash: SPEC_HASH, by: 'ui' } },
    ]);
    expect(runPhases(framing)).toEqual({ basis: 'no-plan', phases: [] });
  });

  it('answers a flat plan with its own steps rather than a shape it does not have (AC2)', () => {
    const flat = running([
      agent({ id: 'recon', title: 'Survey' }),
      agent({ id: 'impl', title: 'Implement', deps: ['recon'] }),
      gate({ id: 'gate-typecheck', title: 'Typecheck', deps: ['impl'] }),
    ]);
    const projection = runPhases(flat);
    expect(projection.basis).toBe('plan');
    expect(projection.phases.map((phase) => [phase.id, phase.completed, phase.total])).toEqual([
      ['recon', 0, 1],
      ['impl', 0, 1],
      ['gate-typecheck', 0, 1],
    ]);
  });

  it('never invents a fan-out width: a map that has not fanned out counts what exists (AC1, AC2)', () => {
    const state = running([
      agent({ id: 'recon' }),
      mapNode({ id: 'fan', title: 'Fan out', deps: ['recon'], body: 'fan-body' }),
      agent({ id: 'fan-body', deps: ['recon'] }),
    ]);
    const fan = runPhases(state).phases.find((phase) => phase.id === 'fan');
    // The `over` collection has not been read, so the only node that exists is
    // the template. One is the honest total; anything larger is a guess.
    expect([fan?.completed, fan?.total]).toEqual([0, 1]);
    expect(fan?.nodes).toEqual(['fan-body']);
  });

  it('never reports a phase the plan does not contain', () => {
    const state = running([agent({ id: 'only' })], [scheduled('only'), started('only')]);
    const projection = runPhases(state);
    expect(projection.phases).toHaveLength(1);
    expect(projection.phases[0]?.id).toBe('only');
    expect(projection.phases[0]?.state).toBe('running');
  });

  it('keeps the plan document order when the graph is not sortable, rather than throwing', () => {
    // A cycle cannot be adopted by a validating daemon, so this is defence
    // against an older ledger — the projection degrades to the document's own
    // order and still answers.
    const cyclic = running([
      agent({ id: 'a', deps: ['b'] }),
      agent({ id: 'b', deps: ['a'] }),
      agent({ id: 'c' }),
    ]);
    expect(runPhases(cyclic).phases.map((phase) => phase.id)).toEqual(['a', 'b', 'c']);
  });
});
