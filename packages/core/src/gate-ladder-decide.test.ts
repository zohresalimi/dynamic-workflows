/**
 * KAR-12.1 test plan #1, #2 — the ladder as a property of `decide()`.
 *
 * Every state here is built by folding **real, parsed events** through
 * `reduce`, never by hand-assembling a `RunState`: a hand-written projection
 * would let `decide` agree with a shape the reducer cannot produce, which is
 * the one failure mode a unit test over a plain object is blind to.
 *
 * The assertion that matters in the short-circuit suite is the **cost delta**,
 * not the absence of a log line. A red typecheck must leave `budget.consumed`
 * byte-identical, and it does — because no `StartNode` for the review gate is
 * ever returned, so no attempt is ever launched to spend anything.
 *
 * Verifies: EPIC-12-S2, EPIC-12-S3, EPIC-12-S27 (the ladder clause) · AC1,
 * AC2, KAR-12.4 AC6
 */
import { expect, it, describe as suite } from 'vitest';
import type { Command, StartNode } from './command.ts';
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
const NOW = 1_754_150_000_000;

interface GateSpec {
  readonly id: string;
  readonly kind: 'deterministic' | 'adversarial';
  readonly deps?: readonly string[];
}

function gateNode(spec: GateSpec): Record<string, unknown> {
  return {
    id: spec.id,
    title: `gate ${spec.id}`,
    type: 'gate',
    deps: [...(spec.deps ?? [])],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'worktree',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.verdict.v2', maxTokens: 600 },
    retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
    budget: {},
    gate:
      spec.kind === 'deterministic'
        ? { kind: 'deterministic', gateId: spec.id.replace(/^gate-/, '') }
        : { kind: 'adversarial', brief: `review the work for ${spec.id}` },
    criteria: ['ac-1'],
    independence: { notSessionOf: ['impl-1'], preferDifferentProvider: true },
  };
}

function planGraph(nodes: readonly GateSpec[]): Record<string, unknown> {
  return {
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN_ID,
    version: 1,
    planHash: PLAN_HASH,
    parent: null,
    taskSpecHash: SPEC_HASH,
    createdBy: 'planner',
    createdAt: '2026-08-02T14:11:33.000Z',
    nodes: nodes.map(gateNode),
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

function started(nodes: readonly GateSpec[], rest: readonly Row[] = []): RunState {
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

/** A `gate.evaluated` for `node`, carrying the run's current specHash so the
 * verdict is not void — a void verdict is deliberately not evidence. */
const evaluated = (node: string, gate: string, outcome: 'pass' | 'fail'): Row => ({
  kind: 'gate.evaluated',
  payload: {
    gate,
    node: 'impl-1',
    verdict: {
      schemaId: 'DeFlow.verdict.v2',
      outcome,
      gate,
      evaluatedNode: 'impl-1',
      by: { node, provider: 'deflow', model: 'deterministic-gate' },
      criteria: [{ id: 'ac-1', status: outcome === 'pass' ? 'satisfied' : 'unsatisfied' }],
      findings: [],
      summary: `${gate} ${outcome}`,
      specHash: SPEC_HASH,
    },
  },
});

const startsOf = (commands: readonly Command[]): string[] =>
  commands
    .filter((command): command is StartNode => command.kind === 'StartNode')
    .map((c) => c.node);

/** The gate set of S3, inserted in an order that is not the ladder's. */
const SHUFFLED: readonly GateSpec[] = [
  { id: 'gate-review', kind: 'adversarial' },
  { id: 'gate-typecheck', kind: 'deterministic' },
];

suite('the ladder is derived, not incidental (S3, second scenario)', () => {
  it('admits the deterministic gate first even when the plan lists it second', () => {
    expect(startsOf(decide(started(SHUFFLED), NOW))).toEqual(['gate-typecheck']);
  });

  it('admits the adversarial gate once the deterministic one has passed (AC1)', () => {
    const state = started(SHUFFLED, [evaluated('gate-typecheck', 'typecheck', 'pass')]);
    expect(startsOf(decide(state, NOW))).toEqual(['gate-review']);
  });

  it('admits every deterministic gate at once, and no adversarial one', () => {
    const state = started([
      { id: 'gate-review', kind: 'adversarial' },
      { id: 'gate-typecheck', kind: 'deterministic' },
      { id: 'gate-lint', kind: 'deterministic' },
    ]);
    expect(startsOf(decide(state, NOW)).sort()).toEqual(['gate-lint', 'gate-typecheck']);
  });
});

suite('a red typecheck never buys a review (S2, AC2)', () => {
  const red = started(SHUFFLED, [evaluated('gate-typecheck', 'typecheck', 'fail')]);

  it('returns no command at all for the review gate', () => {
    expect(startsOf(decide(red, NOW))).toEqual([]);
  });

  it('leaves the run cost byte-identical, which is the assertion that matters', () => {
    const before = JSON.stringify(started(SHUFFLED).budget);
    expect(JSON.stringify(red.budget)).toBe(before);
    // …and nothing `decide` returns could change it: there is no attempt to run.
    expect(decide(red, NOW).filter((command) => command.kind === 'StartNode')).toEqual([]);
  });

  it('does not admit the review on a needs-human either — that is a stop, not a pass', () => {
    const unanswered = started(SHUFFLED, [
      {
        kind: 'gate.evaluated',
        payload: {
          ...(evaluated('gate-typecheck', 'typecheck', 'pass').payload as Record<string, unknown>),
          verdict: {
            schemaId: 'DeFlow.verdict.v2',
            outcome: 'needs-human',
            gate: 'typecheck',
            evaluatedNode: 'impl-1',
            by: { node: 'gate-typecheck', provider: 'deflow', model: 'deterministic-gate' },
            criteria: [{ id: 'ac-1', status: 'unverifiable' }],
            findings: [],
            summary: 'typecheck could not answer',
            specHash: SPEC_HASH,
          },
        },
      },
    ]);
    expect(startsOf(decide(unanswered, NOW))).toEqual([]);
  });
});

suite('a void verdict re-opens the gate rather than the tier (docs/10 §5.2)', () => {
  it('leaves the deterministic gate admissible and the review withheld', () => {
    const otherHash = `sha256-${'d'.repeat(64)}`;
    const voided = started(SHUFFLED, [
      {
        kind: 'gate.evaluated',
        payload: {
          gate: 'typecheck',
          node: 'impl-1',
          verdict: {
            schemaId: 'DeFlow.verdict.v2',
            outcome: 'pass',
            gate: 'typecheck',
            evaluatedNode: 'impl-1',
            by: { node: 'gate-typecheck', provider: 'deflow', model: 'deterministic-gate' },
            criteria: [{ id: 'ac-1', status: 'satisfied' }],
            findings: [],
            summary: 'typecheck passed against a spec nobody approved',
            specHash: otherHash,
          },
        },
      },
    ]);
    expect(voided.gateVerdicts).toEqual({});
    expect(startsOf(decide(voided, NOW))).toEqual(['gate-typecheck']);
  });

  /**
   * KAR-12.4 AC6, EPIC-12-S27 — the same rule with the two rows the other way
   * round, which is the order a mid-run spec edit actually arrives in: the
   * verdict was honest when it was recorded, and the contract moved underneath
   * it afterwards. Dropping only the verdicts that arrive *after* a move
   * catches the impostor and misses the far commoner case, so the gate stays
   * answered by a green about a contract nobody holds the run to.
   */
  it('re-opens a gate whose pass predates a spec edit', () => {
    const editedHash = `sha256-${'e'.repeat(64)}`;
    const edited = started(SHUFFLED, [
      evaluated('gate-typecheck', 'typecheck', 'pass'),
      { kind: 'run.spec.approved', payload: { specHash: editedHash, by: 'ui' } },
    ]);
    expect(edited.gateVerdicts).toEqual({});
    expect(startsOf(decide(edited, NOW))).toEqual(['gate-typecheck']);
  });

  it('keeps the pass when the spec is re-approved at the same hash', () => {
    const reapproved = started(SHUFFLED, [
      evaluated('gate-typecheck', 'typecheck', 'pass'),
      { kind: 'run.spec.approved', payload: { specHash: SPEC_HASH, by: 'cli' } },
    ]);
    expect(reapproved.gateVerdicts['gate-typecheck']?.outcome).toBe('pass');
  });
});

suite('the fold', () => {
  it('records the outcome against the gate node, keyed by verdict.by.node', () => {
    const state = started(SHUFFLED, [evaluated('gate-typecheck', 'typecheck', 'pass')]);
    expect(state.gateVerdicts['gate-typecheck']).toMatchObject({
      gate: 'typecheck',
      outcome: 'pass',
      seq: 4,
    });
  });

  it('takes the later verdict when a gate is evaluated twice', () => {
    const state = started(SHUFFLED, [
      evaluated('gate-typecheck', 'typecheck', 'fail'),
      evaluated('gate-typecheck', 'typecheck', 'pass'),
    ]);
    expect(state.gateVerdicts['gate-typecheck']?.outcome).toBe('pass');
    expect(startsOf(decide(state, NOW))).toEqual(['gate-review']);
  });
});
