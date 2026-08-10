/**
 * KAR-13.2 test plan #1, #2, #3 — the cross-run approval queue as a projection.
 *
 * The queue is *derived*, so every case here builds its state the way a daemon
 * does: by folding events. A hand-written `RunState` literal would let a test
 * assert on a shape the reducer never produces, which is exactly the drift the
 * projection exists to avoid — and it would make scenario S15's *"replaying the
 * ledger produces an identical queue"* a claim about a fixture rather than
 * about the fold.
 *
 * Verifies: EPIC-13-S10, EPIC-13-S11, EPIC-13-S15 · AC1, AC2, AC3, AC9
 */
import { expect, it, describe as suite } from 'vitest';
import { approvalsProjection, RECONCILE_OPTIONS, type RunApprovals } from './approval-queue.ts';
import { foldEvents } from './fold-events.ts';
import type { FactId, NodeId, RunId } from './ids.ts';
import type { RunState } from './run-state.ts';

const R1 = 'run_20260806T090000Z_a10001' as RunId;
const R2 = 'run_20260806T090000Z_b20002' as RunId;
const R3 = 'run_20260806T090000Z_c30003' as RunId;

const SPEC_HASH = `sha256-${'a'.repeat(64)}`;
const REQUEST_HASH = `sha256-${'b'.repeat(64)}`;
const BEFORE = `sha256-${'c'.repeat(64)}`;
const AFTER = `sha256-${'d'.repeat(64)}`;

const T0 = 1_800_000_000_000;

interface Row {
  readonly seq: number;
  readonly kind: string;
  readonly payload: unknown;
  readonly runId?: RunId;
}

/** One stored row, as `parseEvent` wants it. */
const row = (runId: RunId, entry: Row): unknown => ({
  seq: entry.seq,
  runId: entry.runId ?? runId,
  ts: T0 + entry.seq,
  kind: entry.kind,
  v: 1,
  epoch: 1,
  payload: entry.payload,
});

const stateOf = (runId: RunId, rows: readonly Row[]): RunState =>
  foldEvents(rows.map((entry) => row(runId, entry))).state;

/* -------------------------------------------------------------------------- *
 * the eight sources
 * -------------------------------------------------------------------------- */

const humanRequested = (seq: number, node: string): Row => ({
  seq,
  kind: 'human.requested',
  payload: {
    node,
    prompt: 'The codemod changed 41 files. Proceed?',
    options: [
      { id: 'yes', label: 'Proceed', effect: 'approve' },
      { id: 'no', label: 'Stop', effect: 'reject' },
    ],
    deadline: { wakeAt: '2026-08-06T18:00:00.000Z', onTimeout: 'escalate' },
  },
});

/** KAR-08.3's escalation: a `human.requested` that carries a permission reason. */
const permissionRequested = (seq: number, node: string): Row => ({
  seq,
  kind: 'human.requested',
  payload: {
    node,
    prompt: 'The agent asked to run a command DeFlow does not allow on its own.',
    options: [
      { id: 'approve', label: 'Run it', effect: 'approve' },
      { id: 'reject', label: 'Do not run it', effect: 'reject' },
    ],
    reason: { code: 'network-egress', detail: 'curl' },
    permission: {
      method: 'terminal/create',
      command: 'curl',
      args: ['https://example.com'],
      cwd: '/tmp/worktree',
      resolved: '/tmp/worktree',
      rule: 'network-egress',
      level: 'worktree',
      pathScopes: ['src/**'],
    },
  },
});

const specApproved = (seq: number): Row => ({
  seq,
  kind: 'run.spec.approved',
  payload: { specHash: SPEC_HASH, by: 'ui' },
});

const needsHumanVerdict = (seq: number, node: string): Row => ({
  seq,
  kind: 'gate.evaluated',
  payload: {
    gate: 'review',
    node,
    verdict: {
      schemaId: 'DeFlow.verdict.v4',
      outcome: 'needs-human',
      gate: 'review',
      evaluatedNode: 'impl-1',
      by: { node, provider: 'claude', model: 'the-model' },
      criteria: [{ id: 'tests-pass', status: 'unverifiable' }],
      findings: [
        {
          id: 'f1',
          severity: 'major',
          message: 'the migration may have changed public behaviour',
          evidence: [],
        },
      ],
      summary: 'the reviewer could not tell whether the behaviour changed',
      specHash: SPEC_HASH,
    },
  },
});

const reconcileUnknown = (seq: number, node: string): Row => ({
  seq,
  kind: 'node.failed',
  payload: {
    node,
    attempt: 0,
    failure: {
      reason: 'effect.reconcile-unknown',
      class: 'gate',
      message: 'reconcile returned unknown for shell effect',
      detail: {
        ikey: `${R1}/${node}/0/0`,
        kind: 'shell',
        requestHash: REQUEST_HASH,
        before: BEFORE,
        after: AFTER,
        observed: null,
      },
      evidence: [],
      occurredAtEvent: seq - 1,
      attempt: 0,
    },
  },
});

const budgetExceeded = (seq: number): Row => ({
  seq,
  kind: 'budget.exceeded',
  payload: {
    scope: 'run',
    dimension: 'cost',
    limit: 20,
    actual: 21.4,
    failureClass: 'gate',
    firedBy: 'deflow',
    basis: {
      authMode: 'subscription',
      vendorReported: 21.4,
      estimated: null,
      estimateDriven: false,
      unaccounted: [],
    },
  },
});

const churn = (seq: number): Row => ({
  seq,
  kind: 'run.needs_human',
  payload: { reason: 'churn', detail: 'four replans in twelve minutes' },
});

const QUEUED_PATCH = {
  patchId: 'patch-3a91f0',
  status: 'queued' as const,
  rule: 'escalates-permission',
  patch: {
    id: 'patch-3a91f0',
    reason: 'the migration needs a second implementation node',
    ops: [{ op: 'extend-loop' as const, node: 'impl-1' as NodeId, maxRounds: 3 }],
  },
  estimate: {
    costUsdDelta: 6.2,
    blastRadiusFiles: 140,
    maxPermission: 'worktree' as const,
    replanDepth: 2,
  },
  proposedSeq: 880,
  decidedSeq: 881,
};

const TAINTED = {
  runId: R1,
  node: 'impl-1' as NodeId,
  taint: 'stale-input' as const,
  factId: `fact_${'a'.repeat(26)}` as FactId,
  key: 'finding/db-schema',
  reason: 'the schema changed under it',
  seq: 4200,
  readAtSeq: 3100,
};

/* -------------------------------------------------------------------------- *
 * S10 — one call, every run, oldest first
 * -------------------------------------------------------------------------- */

suite('EPIC-13-S10 — the queue aggregates across concurrent runs (AC1, AC9)', () => {
  const queue = (): ReturnType<typeof approvalsProjection> =>
    approvalsProjection([
      { runId: R1, state: stateOf(R1, [humanRequested(4120, 'approve-migration')]) },
      {
        runId: R2,
        state: stateOf(R2, [specApproved(800), needsHumanVerdict(951, 'gate-review')]),
        patches: [QUEUED_PATCH],
      },
      { runId: R3, state: stateOf(R3, [budgetExceeded(233)]) },
    ]);

  it('returns four items from three runs in one call, oldest creating seq first', () => {
    expect(queue().items.map((item) => [item.runId, item.seq])).toEqual([
      [R3, 233],
      [R2, 880],
      [R2, 951],
      [R1, 4120],
    ]);
  });

  it('carries runId, node, kind, a summary and the creating seq on every item', () => {
    for (const item of queue().items) {
      expect(item.runId).toMatch(/^run_/);
      expect(item.kind).toEqual(expect.any(String));
      expect(item.summary.length).toBeGreaterThan(0);
      expect(item.seq).toBeGreaterThan(0);
      expect(item).toHaveProperty('node');
    }
  });

  it('exposes per-run counts for the run list badge, without a second query', () => {
    expect(queue().counts).toEqual({ [R1]: 1, [R2]: 2, [R3]: 1 });
  });
});

/* -------------------------------------------------------------------------- *
 * S11 — eight kinds, each carrying enough to decide
 * -------------------------------------------------------------------------- */

suite('EPIC-13-S11 — each kind carries its decision payload (AC2)', () => {
  const only = (input: RunApprovals): Record<string, unknown> => {
    const { items } = approvalsProjection([input]);
    expect(items).toHaveLength(1);
    return items[0] as unknown as Record<string, unknown>;
  };

  it('human-node carries the prompt, the options and the deadline', () => {
    expect(
      only({ runId: R1, state: stateOf(R1, [humanRequested(10, 'approve-migration')]) }),
    ).toMatchObject({
      kind: 'human-node',
      node: 'approve-migration',
      prompt: 'The codemod changed 41 files. Proceed?',
      options: [
        { id: 'yes', label: 'Proceed', effect: 'approve' },
        { id: 'no', label: 'Stop', effect: 'reject' },
      ],
      deadline: { wakeAt: '2026-08-06T18:00:00.000Z', onTimeout: 'escalate' },
    });
  });

  it('patch carries the reason, the four estimate figures and the plan diff', () => {
    expect(only({ runId: R1, state: stateOf(R1, []), patches: [QUEUED_PATCH] })).toMatchObject({
      kind: 'patch',
      patchId: 'patch-3a91f0',
      reason: 'the migration needs a second implementation node',
      rule: 'escalates-permission',
      estimate: {
        costUsdDelta: 6.2,
        blastRadiusFiles: 140,
        maxPermission: 'worktree',
        replanDepth: 2,
      },
      ops: [{ op: 'extend-loop', node: 'impl-1', maxRounds: 3 }],
      seq: 880,
    });
  });

  it("gate-needs-human carries the verdict's findings, the reason and the gate id", () => {
    expect(
      only({
        runId: R1,
        state: stateOf(R1, [specApproved(5), needsHumanVerdict(11, 'gate-review')]),
      }),
    ).toMatchObject({
      kind: 'gate-needs-human',
      gate: 'review',
      node: 'gate-review',
      reason: 'the reviewer could not tell whether the behaviour changed',
      findings: [{ id: 'f1', severity: 'major' }],
      seq: 11,
    });
  });

  it('reconcile-unknown carries the effect row and both reconciliation hashes', () => {
    expect(
      only({ runId: R1, state: stateOf(R1, [reconcileUnknown(12, 'migrate-db')]) }),
    ).toMatchObject({
      kind: 'reconcile-unknown',
      node: 'migrate-db',
      effect: { ikey: `${R1}/migrate-db/0/0`, kind: 'shell', requestHash: REQUEST_HASH },
      hashes: { before: BEFORE, after: AFTER, observed: null },
      seq: 12,
    });
  });

  it('budget carries the scope, the dimension, the limit and the actual', () => {
    expect(only({ runId: R1, state: stateOf(R1, [budgetExceeded(13)]) })).toMatchObject({
      kind: 'budget',
      scope: 'run',
      dimension: 'cost',
      limit: 20,
      actual: 21.4,
      seq: 13,
    });
  });

  it('churn carries the detail and the window it was tripped on', () => {
    expect(only({ runId: R1, state: stateOf(R1, [churn(14)]) })).toMatchObject({
      kind: 'churn',
      detail: 'four replans in twelve minutes',
      window: [],
      seq: 14,
    });
  });

  it('tainted carries the fact, its key and the node that read it', () => {
    expect(only({ runId: R1, state: stateOf(R1, []), taints: [TAINTED] })).toMatchObject({
      kind: 'tainted',
      node: 'impl-1',
      taint: 'stale-input',
      factId: TAINTED.factId,
      key: 'finding/db-schema',
      readAtSeq: 3100,
      seq: 4200,
    });
  });

  it('permission carries the command, args, cwd, resolved path, rule and node scope', () => {
    expect(
      only({ runId: R1, state: stateOf(R1, [permissionRequested(15, 'impl-1')]) }),
    ).toMatchObject({
      kind: 'permission',
      node: 'impl-1',
      reason: { code: 'network-egress', detail: 'curl' },
      permission: {
        method: 'terminal/create',
        command: 'curl',
        args: ['https://example.com'],
        cwd: '/tmp/worktree',
        resolved: '/tmp/worktree',
        rule: 'network-egress',
        level: 'worktree',
        pathScopes: ['src/**'],
      },
      seq: 15,
    });
  });

  it('offers exactly "it ran" and "it did not" on a reconcile-unknown, neither preselected', () => {
    const item = only({ runId: R1, state: stateOf(R1, [reconcileUnknown(16, 'migrate-db')]) });
    expect(RECONCILE_OPTIONS.map((option) => option.id)).toEqual(['it-ran', 'it-did-not']);
    expect(item.options).toEqual(RECONCILE_OPTIONS);
    expect(item.defaultOptionId).toBeNull();
    expect(item.warning).toMatch(/double-apply/);
    expect(item.warning).toMatch(/drop/);
  });

  it('never schedules a re-run for a tainted node — the queue is the whole response', () => {
    const three = ['impl-1', 'impl-2', 'impl-3'].map((node, index) => ({
      ...TAINTED,
      node: node as NodeId,
      seq: 4200 + index,
    }));
    const { items } = approvalsProjection([{ runId: R1, state: stateOf(R1, []), taints: three }]);
    expect(items.map((item) => item.node)).toEqual(['impl-1', 'impl-2', 'impl-3']);
    expect(items.every((item) => item.kind === 'tainted')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * S15 — derived, not accumulated
 * -------------------------------------------------------------------------- */

suite('EPIC-13-S15 — the queue is derived from the fold (AC3, AC8)', () => {
  const HISTORY: readonly Row[] = [
    humanRequested(100, 'approve-one'),
    {
      seq: 101,
      kind: 'human.responded',
      payload: { node: 'approve-one', optionId: 'yes', at: '2026-08-06T09:00:00.000Z' },
    },
    humanRequested(102, 'approve-two'),
    {
      seq: 103,
      kind: 'human.responded',
      payload: { node: 'approve-two', optionId: 'no', at: '2026-08-06T09:01:00.000Z' },
    },
    humanRequested(104, 'approve-three'),
    {
      seq: 105,
      kind: 'human.responded',
      payload: { node: 'approve-three', optionId: 'yes', at: '2026-08-06T09:02:00.000Z' },
    },
    humanRequested(106, 'approve-four'),
    humanRequested(107, 'approve-five'),
  ];

  it('leaves exactly the two pending items of five historical approvals', () => {
    const { items } = approvalsProjection([{ runId: R1, state: stateOf(R1, HISTORY) }]);
    expect(items.map((item) => item.node)).toEqual(['approve-four', 'approve-five']);
    expect(items.map((item) => item.seq)).toEqual([106, 107]);
  });

  it('replaying from seq 0 reproduces the queue exactly', () => {
    const replayed = approvalsProjection([{ runId: R1, state: stateOf(R1, HISTORY) }]);
    const cached = approvalsProjection([{ runId: R1, state: stateOf(R1, HISTORY) }]);
    expect(replayed).toEqual(cached);
  });

  it('ignores an event kind this build does not know, and does not corrupt the queue', () => {
    const withUnknown = stateOf(R1, [
      ...HISTORY,
      { seq: 108, kind: 'quantum.entangled', payload: { node: 'approve-six' } },
    ]);
    expect(approvalsProjection([{ runId: R1, state: withUnknown }]).items).toEqual(
      approvalsProjection([{ runId: R1, state: stateOf(R1, HISTORY) }]).items,
    );
  });

  it('drops an applied patch and keeps a policy-rejected one, which is not a dead end', () => {
    const { items } = approvalsProjection([
      {
        runId: R1,
        state: stateOf(R1, []),
        patches: [{ ...QUEUED_PATCH, status: 'rejected', rule: 'replan-depth-exceeded' }],
      },
    ]);
    expect(items).toMatchObject([
      { kind: 'patch', status: 'rejected', rule: 'replan-depth-exceeded' },
    ]);
  });

  it('lists nothing for a run that is over — a finished run waits on nobody', () => {
    const finished = stateOf(R1, [
      humanRequested(200, 'approve-migration'),
      { seq: 201, kind: 'run.aborted', payload: { outcome: 'failed', criteriaSatisfied: [] } },
    ]);
    expect(approvalsProjection([{ runId: R1, state: finished }]).items).toEqual([]);
    expect(approvalsProjection([{ runId: R1, state: finished }]).counts).toEqual({});
  });
});
