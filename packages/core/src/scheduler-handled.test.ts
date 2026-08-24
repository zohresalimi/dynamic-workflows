/**
 * KAR-23.9 — `SCHEDULER_HANDLED_NODE_TYPES` is pinned to what `decide()`
 * actually does, node type by node type.
 *
 * The constant exists so plan validation can refuse a node type nothing
 * composes a performer for **without** refusing the one type that is answered
 * rather than performed. Get it wrong in either direction and something quiet
 * breaks: name too much, and a real gap in the executor stops being reported;
 * name too little, and every plan carrying a `human` node is refused at compile
 * time, which is KAR-13.1's whole feature.
 *
 * So the list is not asserted against memory. Every one of the seven node types
 * is folded into a started run and handed to `decide()`, and the claim is the
 * biconditional: a `StartNode` is emitted **iff** the type is not on the list.
 *
 * Every state here is built by folding real, parsed events through `reduce`,
 * for the reason `./decide.test.ts` gives: a hand-assembled projection lets
 * `decide` agree with a shape the reducer cannot produce.
 *
 * Verifies: KAR-23.9 · KAR-13.1 AC10
 */
import { expect, it, describe as suite } from 'vitest';
import { decide } from './decide.ts';
import type { EventKind } from './event-payloads.ts';
import { EVENT_SCHEMAS } from './event-payloads.ts';
import type { Event } from './events.ts';
import { parseEvent } from './events.ts';
import { SCHEDULER_HANDLED_NODE_TYPES } from './human-gate.ts';
import { NODE_TYPES, type NodeType } from './plan-graph.ts';
import { reduce } from './reduce.ts';
import { initialRunState, type RunState } from './run-state.ts';

const RUN_ID = 'run_20260824T101500Z_9f2a1c';
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const NOW = 1_787_500_000_000;

/** `NodeBase`, which every one of the seven branches spreads. */
const base = (id: string) => ({
  id,
  title: `do ${id}`,
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
});

/** One ready node of each type, with the minimum its branch requires. */
function nodeOf(type: NodeType): Record<string, unknown> {
  const id = `the-${type}`;
  switch (type) {
    case 'agent':
      return {
        ...base(id),
        type,
        brief: 'do the work',
        provider: { prefer: ['claude'], requires: [] },
        resume: 'always-replay',
      };
    case 'tool':
      return {
        ...base(id),
        type,
        tool: { kind: 'script', run: 'pnpm build' },
        effectClass: 'pure',
      };
    case 'gate':
      return {
        ...base(id),
        type,
        gate: { kind: 'deterministic', gateId: 'typecheck' },
        criteria: [],
        independence: { notSessionOf: [], preferDifferentProvider: true },
      };
    case 'human':
      return {
        ...base(id),
        type,
        prompt: 'Approve the scope?',
        options: [{ id: 'yes', label: 'Approve', effect: 'approve' }],
      };
    case 'map':
      return {
        ...base(id),
        type,
        over: { kind: 'glob', pattern: 'services/*' },
        concurrency: 2,
        body: 'the-agent',
      };
    case 'loop':
      return {
        ...base(id),
        type,
        body: 'the-agent',
        maxRounds: 3,
        goal: { kind: 'gate', gate: 'the-gate' },
        noProgress: { sameFailureSignatureLimit: 2, diffSimilarityThreshold: 0.9 },
      };
    case 'subgraph':
      return {
        ...base(id),
        type,
        graph: { kind: 'template', templateId: 'library-upgrade', params: {} },
      };
  }
}

function parse(kind: EventKind, payload: unknown, seq: number): Event {
  const result = parseEvent({
    seq,
    runId: RUN_ID,
    ts: NOW,
    kind,
    v: EVENT_SCHEMAS[kind].v,
    epoch: 1,
    payload,
  });
  if (result.status !== 'ok') {
    throw new Error(`fixture for ${kind} is not a valid event: ${JSON.stringify(result)}`);
  }
  return result.event;
}

/** A started run whose plan holds exactly one node, of `type`. */
function startedWith(type: NodeType): RunState {
  const rows: readonly (readonly [EventKind, unknown])[] = [
    ['run.spec.approved', { specHash: SPEC_HASH, by: 'ui' }],
    [
      'plan.proposed',
      {
        version: 1,
        planHash: PLAN_HASH,
        graph: {
          schemaId: 'DeFlow.plangraph.v1',
          runId: RUN_ID,
          version: 1,
          planHash: PLAN_HASH,
          parent: null,
          taskSpecHash: SPEC_HASH,
          createdBy: 'planner',
          createdAt: '2026-08-24T10:15:00.000Z',
          nodes: [nodeOf(type)],
          edges: [],
        },
        by: 'planner',
      },
    ],
    ['run.started', { planHash: PLAN_HASH }],
  ];

  let state = initialRunState();
  for (const [index, [kind, payload]] of rows.entries()) {
    state = reduce(state, parse(kind, payload, index + 1));
  }
  return state;
}

suite('KAR-23.9 — the scheduler-handled set is what decide() really does', () => {
  it('names only `human`, and says so out loud', () => {
    expect([...SCHEDULER_HANDLED_NODE_TYPES]).toEqual(['human']);
  });

  for (const type of NODE_TYPES) {
    const handled = (SCHEDULER_HANDLED_NODE_TYPES as readonly string[]).includes(type);

    it(`${type}: decide() emits a StartNode ${handled ? 'never' : 'when it is ready'}`, () => {
      const commands = decide(startedWith(type), NOW);
      const starts = commands.filter((command) => command.kind === 'StartNode');

      expect(starts.length > 0, JSON.stringify(commands.map((one) => one.kind))).toBe(!handled);
      // …and the one type that is never started is suspended instead, rather
      // than being a node the run silently forgets.
      if (handled) {
        expect(commands.map((one) => one.kind)).toContain('SuspendNode');
      }
    });
  }
});
