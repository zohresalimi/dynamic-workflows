/**
 * KAR-12.5 test plan #4, #10 — the repair loop goes through the patch policy
 * engine like anything else, and the churn breaker sees it
 * (docs/10-verification-gates.md §7, docs/06-planning-and-replanning.md §4.3,
 * §7).
 *
 * Two claims, and neither is provable from `repairPatchesFor` alone — which is
 * the point of testing them here. A repair patch is not special: it is
 * *estimated* by the real estimator, *ruled on* by the real rule table, and
 * *queued* into the real projection. The failure this file exists to catch is a
 * repair path that reaches around any of those three.
 *
 * **AC8** — a fix needing more permission than the run has is queued, never
 * auto-applied, and the run does not stall on it. *"The patch is pending, not
 * the run"* is the half people forget.
 *
 * **AC9** — repair attempts are node attempts, so six identical
 * `(node, requestHash)` completions in the sliding window trip the breaker; the
 * next repair patch is then rejected with a **named rule** and stays in the
 * approval queue, where a human can still approve it. *"A repair loop that has
 * become a churn loop must stop, not accelerate."*
 *
 * A file-backed ledger, not `:memory:`: the queue is a projection over rows
 * SQLite really assigned seqs to, and the ordering it sorts by is one of them.
 *
 * Verifies: EPIC-12-S33, EPIC-12-S34 · AC8, AC9
 */
import {
  type Calibration,
  circuitBreakerOf,
  DEFAULT_PATCH_RULE_SPECS,
  decidePatch,
  type EstimatorInputs,
  EVENT_SCHEMAS,
  type Event,
  type EventKind,
  estimatePatch,
  type GateId,
  type Handle,
  initialRunState,
  type NodeId,
  needsHumanOf,
  noProgress,
  type PlanPatch,
  type ProviderId,
  parseEvent,
  patchDecisionOutcome,
  patchDecisionStateOf,
  type RunId,
  RunIdSchema,
  type RunState,
  reduce,
  type TokenAccounting,
  type VerdictV3,
} from '@DeFlow/core';
import { appendEvents, openLedger, pendingPatchApprovals, readRange } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { repairPatchesFor } from '../../src/index.ts';

const RUN: RunId = RunIdSchema.parse('run_20260808T041500Z_1a2b3c');
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const EVIDENCE = `artifact://${'b'.repeat(64)}` as Handle;
const T0 = 1_754_308_293_000;
const PRODUCER = 'impl-1' as NodeId;
const GATE_NODE = 'gate-typecheck' as NodeId;
const FINDING = 'a13f5c2b1e04';

// ── the failing verdict every patch below is derived from ────────────────────

const failedTypecheck: VerdictV3 = {
  schemaId: 'DeFlow.verdict.v3',
  outcome: 'fail',
  gate: 'typecheck' as GateId,
  evaluatedNode: PRODUCER,
  by: { node: GATE_NODE, provider: 'deflow', model: 'deterministic-gate' },
  criteria: [{ id: 'ac-3', status: 'unsatisfied' }],
  findings: [
    {
      id: FINDING,
      severity: 'blocker',
      message: "ts2345: Argument of type 'string' is not assignable to parameter of type 'Date'",
      evidence: [EVIDENCE],
      location: { file: 'packages/ui/src/DatePicker.vue', line: 88, blobSha: 'b'.repeat(40) },
    },
  ],
  summary: 'the DatePicker passes a string where a Date is required',
  cost: { durationMs: 1200 },
} as unknown as VerdictV3;

/** The one repair patch, at whatever permission the fix is said to need. */
function repairPatch(fixPermission: 'read' | 'worktree' | 'worktree+net' | 'full'): PlanPatch {
  const decision = repairPatchesFor(failedTypecheck, {
    evaluatedNode: PRODUCER,
    ambientPermission: 'worktree',
    replanDepth: 1,
    evidence: [EVIDENCE],
    proposedBy: GATE_NODE,
    fixPermission,
  });
  if (decision.kind !== 'fix') throw new Error('expected a fix node');
  const patch = decision.patches[0];
  if (patch === undefined) throw new Error('expected exactly one patch');
  return patch;
}

// ── the estimator, real ──────────────────────────────────────────────────────

const LEARNED: Calibration = { n: 24, ratio: 1.18 };

const estimatorInputs: EstimatorInputs = {
  tokenizer: {
    count: (text: string) => ({ estimated: Math.ceil(text.length / 4), method: 'heuristic' }),
  },
  accounting: (): TokenAccounting => 'exact',
  family: (): string => 'anthropic',
  calibration: (): Calibration => LEARNED,
  routing: () => ({ provider: 'claude' as ProviderId, model: 'claude-haiku-4-5' }),
};

/** The plan the patch is proposed against: the producer, and nothing else. */
const BASE_GRAPH = {
  nodes: [
    {
      id: PRODUCER,
      title: 'implement the date picker',
      type: 'agent' as const,
      deps: [],
      lifecycle: 'active' as const,
      reads: [],
      writes: [],
      permission: 'worktree' as const,
      pathScopes: { write: ['packages/ui/src/**'] },
      returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
      retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' as const } },
      budget: {},
      brief: 'implement the date picker, which is a long enough brief to count.',
      provider: { prefer: ['claude'], requires: [] },
      resume: 'always-replay' as const,
    },
  ],
} as Parameters<typeof estimatePatch>[1];

// ── a run state, folded from real events ─────────────────────────────────────

interface Row {
  readonly kind: EventKind;
  readonly payload: unknown;
  readonly node?: string;
  readonly attempt?: number;
  readonly ikey?: string;
}

function parse(row: Row, seq: number): Event {
  const result = parseEvent({
    seq,
    runId: RUN,
    ts: T0,
    kind: row.kind,
    v: EVENT_SCHEMAS[row.kind].v,
    epoch: 1,
    ...(row.node === undefined ? {} : { nodeId: row.node }),
    ...(row.attempt === undefined ? {} : { attempt: row.attempt }),
    ...(row.ikey === undefined ? {} : { ikey: row.ikey }),
    payload: row.payload,
  });
  if (result.status !== 'ok') {
    throw new Error(`fixture for ${row.kind} is not an event: ${JSON.stringify(result)}`);
  }
  return result.event;
}

const fold = (rows: readonly Row[]): RunState =>
  rows.reduce((state, row, index) => reduce(state, parse(row, index + 1)), initialRunState());

const planGraph = (nodes: readonly unknown[]) => ({
  schemaId: 'DeFlow.plangraph.v1',
  runId: RUN,
  version: 1,
  planHash: PLAN_HASH,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-08T04:15:00.000Z',
  nodes,
  edges: [],
});

const COMPLETED = {
  status: 'completed',
  output: { summary: 'done' },
  outputSchemaId: 'DeFlow.artifact.v1',
  usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
  costUsd: 0.42,
  producedFacts: [],
  artifacts: [EVIDENCE],
};

/** One completed attempt as the ledger writes it: the effect that names what
 * was asked for, then the completion that closes it. */
const attemptRows = (node: string, attempt: number, requestHash: string): Row[] => [
  {
    kind: 'effect.started',
    node,
    attempt,
    ikey: `${RUN}/${node}/${attempt}/0`,
    payload: { ikey: `${RUN}/${node}/${attempt}/0`, kind: 'agent', requestHash },
  },
  { kind: 'node.completed', node, attempt, payload: { node, attempt, result: COMPLETED } },
];

const startedRows = (rest: readonly Row[] = []): Row[] => [
  { kind: 'run.spec.approved', payload: { specHash: SPEC_HASH, by: 'ui' } },
  {
    kind: 'plan.proposed',
    payload: { version: 1, planHash: PLAN_HASH, graph: planGraph(BASE_GRAPH.nodes), by: 'planner' },
  },
  { kind: 'run.started', payload: { planHash: PLAN_HASH } },
  ...rest,
];

// ── AC8: a repair that wants more permission is queued ───────────────────────

suite('a repair patch that escalates permission (EPIC-12-S33, test plan #10)', () => {
  const clearRun = () => fold(startedRows());

  const rule = (patch: PlanPatch, state: RunState) =>
    decidePatch(
      patch,
      patchDecisionStateOf(state, {
        estimate: estimatePatch(patch, BASE_GRAPH, { ...estimatorInputs, planVersion: 1 }),
        now: T0,
      }),
    );

  it('matches escalates-permission and is queued for a human, never auto-applied', () => {
    const patch = repairPatch('full');
    const ruling = rule(patch, clearRun());

    expect(ruling.ruleId).toBe('escalates-permission');
    expect(ruling.decision).toBe('approve');
    expect(patchDecisionOutcome(ruling.decision)).toBe('queued');
  });

  it('reads the escalation off the node the estimator saw, not off the proposal', () => {
    // The five dimensions come from DeFlow's own estimate. An agent that could
    // declare its own patch cheap could auto-apply anything.
    const estimate = estimatePatch(repairPatch('full'), BASE_GRAPH, {
      ...estimatorInputs,
      planVersion: 1,
    });

    expect(estimate.maxPermission).toBe('full');
    expect(estimate.nodesAdded).toBe(1);
    expect(estimate.blastRadiusFiles).toBeGreaterThan(0);
  });

  it('lands in the approval queue and never as plan.patched { decision: auto }', ({ tmp }) => {
    const patch = repairPatch('full');
    const ruling = rule(patch, clearRun());
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        {
          runId: RUN,
          ts: T0,
          kind: 'plan.patch.proposed',
          v: EVENT_SCHEMAS['plan.patch.proposed'].v,
          epoch: 1,
          payload: { patch, basePlanHash: PLAN_HASH },
        },
        {
          runId: RUN,
          ts: T0,
          kind: 'plan.patch.queued',
          v: EVENT_SCHEMAS['plan.patch.queued'].v,
          epoch: 1,
          payload: {
            patchId: patch.id,
            rule: ruling.ruleId,
            estimate: {
              costUsdDelta: 0,
              blastRadiusFiles: 1,
              maxPermission: 'full',
              replanDepth: 1,
            },
          },
        },
      ]);

      const queue = pendingPatchApprovals(db, RUN);
      expect(queue).toHaveLength(1);
      expect(queue[0]?.patchId).toBe(patch.id);
      expect(queue[0]?.status).toBe('queued');
      expect(queue[0]?.rule).toBe('escalates-permission');
      expect(queue[0]?.patch.reason).toContain('typecheck failed:');

      const kinds = readRange(db, RUN, 0, 100).events.map((event) => event.kind);
      expect(kinds).not.toContain('plan.patched');
    } finally {
      db.close();
    }
  });

  it('leaves the run running: the patch is pending, not the run', () => {
    const patch = repairPatch('full');
    const ruling = rule(patch, clearRun());
    const state = fold([
      ...startedRows(),
      {
        kind: 'plan.patch.proposed',
        payload: { patch, basePlanHash: PLAN_HASH },
      },
      {
        kind: 'plan.patch.queued',
        payload: {
          patchId: patch.id,
          rule: ruling.ruleId,
          estimate: { costUsdDelta: 0, blastRadiusFiles: 1, maxPermission: 'full', replanDepth: 1 },
        },
      },
    ]);

    expect(state.status).toBe('running');
    expect(state.needsHuman).toBeNull();
  });

  it('auto-applies a read-only repair, so the queue means something', () => {
    const ruling = rule(repairPatch('read'), clearRun());

    expect(ruling.ruleId).toBe('read-only-analysis');
    expect(ruling.decision).toBe('auto');
  });
});

// ── AC9: the churn breaker sees repair attempts ──────────────────────────────

suite('a repair loop that became a churn loop (EPIC-12-S34, test plan #4)', () => {
  const SAME = `sha256-${'7'.repeat(64)}`;
  const FIX_NODE = `fix-${FINDING}`;

  /** Six completions of the same node with the same request hash: the window's
   * tolerance is five, so the sixth trips. */
  const churned = (repeats: number, hash: string = SAME): RunState =>
    fold(
      startedRows(
        Array.from({ length: repeats }, (_, index) => attemptRows(FIX_NODE, index, hash)).flat(),
      ),
    );

  it('counts request hashes, not attempts: five identical repeats are tolerated', () => {
    expect(noProgress(churned(5), T0).churn).toBeNull();
  });

  it('trips on the sixth, and names the tuple that did it', () => {
    const churn = noProgress(churned(6), T0).churn;

    expect(churn?.reason).toBe('churn');
    expect(churn?.cause).toBe('repeat');
    expect(churn?.detail).toContain(FIX_NODE);
  });

  it('does not trip on six attempts that asked for different things', () => {
    const state = fold(
      startedRows(
        Array.from({ length: 6 }, (_, index) =>
          attemptRows(FIX_NODE, index, `sha256-${String(index).repeat(64)}`),
        ).flat(),
      ),
    );

    expect(noProgress(state, T0).churn).toBeNull();
  });

  it('stops the engine auto-applying the next repair patch, whatever it costs', () => {
    const tripped = noProgress(churned(6), T0);
    const escalation = needsHumanOf(tripped);
    expect(escalation?.reason).toBe('churn');

    const state = fold([
      ...startedRows(
        Array.from({ length: 6 }, (_, index) => attemptRows(FIX_NODE, index, SAME)).flat(),
      ),
      { kind: 'run.needs_human', payload: escalation },
    ]);
    expect(circuitBreakerOf(state)).toBe('tripped');

    // A read-only repair would otherwise match `read-only-analysis` and apply
    // itself. The breaker is asked *first*, and that ordering is the mechanism:
    // a run that answers churn by replanning harder keeps auto-applying exactly
    // the cheap patches a churning loop emits.
    const patch = repairPatch('read');
    const ruling = decidePatch(
      patch,
      patchDecisionStateOf(state, {
        estimate: estimatePatch(patch, BASE_GRAPH, { ...estimatorInputs, planVersion: 1 }),
        now: T0,
      }),
    );

    expect(ruling.decision).toBe('reject');
    expect(ruling.ruleId).toBe('circuit-breaker-tripped');
    expect(DEFAULT_PATCH_RULE_SPECS.some((spec) => spec.id === ruling.ruleId)).toBe(false);
  });

  it('leaves the refused patch in the approval queue rather than dropping it', ({ tmp }) => {
    const patch = repairPatch('read');
    const db = openLedger(tmp);
    try {
      appendEvents(db, [
        {
          runId: RUN,
          ts: T0,
          kind: 'run.needs_human',
          v: EVENT_SCHEMAS['run.needs_human'].v,
          epoch: 1,
          payload: { reason: 'churn', detail: 'churn: the same request six times' },
        },
        {
          runId: RUN,
          ts: T0,
          kind: 'plan.patch.proposed',
          v: EVENT_SCHEMAS['plan.patch.proposed'].v,
          epoch: 1,
          payload: { patch, basePlanHash: PLAN_HASH },
        },
        {
          runId: RUN,
          ts: T0,
          kind: 'plan.patch.rejected',
          v: EVENT_SCHEMAS['plan.patch.rejected'].v,
          epoch: 1,
          payload: { patchId: patch.id, rule: 'circuit-breaker-tripped', by: 'policy' },
        },
      ]);

      const queue = pendingPatchApprovals(db, RUN);
      expect(queue).toHaveLength(1);
      expect(queue[0]?.status).toBe('rejected');
      expect(queue[0]?.rule).toBe('circuit-breaker-tripped');
      // Not auto-applied, and not silently dropped: an operator can still read
      // which rule refused it and approve it explicitly.
      expect(readRange(db, RUN, 0, 100).events.map((event) => event.kind)).not.toContain(
        'plan.patched',
      );
    } finally {
      db.close();
    }
  });
});
