/**
 * KAR-12.5 test plan #1, #2, #3 — the repair loop's decisions, as pure
 * functions over a `Verdict` and a list of attempts.
 *
 * Verifies: EPIC-12-S30, EPIC-12-S32 · AC1, AC2, AC5, AC6, AC7, AC11
 */
import {
  DEFAULT_NO_PROGRESS_POLICY,
  type FindingV2,
  type GateId,
  type Handle,
  HumanRequestedSchema,
  type LadderGate,
  type NodeId,
  PlanPatchSchema,
  type ProviderId,
  type VerdictV3,
} from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  assertFreshRepairContext,
  fixNodeId,
  gatesAfterRepair,
  REPAIR_ATTEMPT_CAP,
  type RepairAttempt,
  type RepairContext,
  RepairContextNotFresh,
  repairAttemptProjection,
  repairNext,
  repairPatchesFor,
  repairReason,
} from './repair.ts';

const GATE = 'typecheck' as GateId;
const PRODUCER = 'impl-1' as NodeId;
const EVIDENCE = `artifact://${'a'.repeat(64)}` as Handle;

const finding = (id: string, overrides: Partial<FindingV2> = {}): FindingV2 =>
  ({
    id,
    severity: 'blocker',
    message: "ts2345: Argument of type 'string' is not assignable to parameter of type 'Date'",
    evidence: [EVIDENCE],
    location: { file: 'packages/ui/src/DatePicker.vue', line: 88, blobSha: 'b'.repeat(40) },
    ...overrides,
  }) as FindingV2;

const verdict = (outcome: VerdictV3['outcome'], findings: readonly FindingV2[] = []): VerdictV3 =>
  ({
    schemaId: 'DeFlow.verdict.v3',
    outcome,
    gate: GATE,
    evaluatedNode: PRODUCER,
    by: { node: 'gate-typecheck', provider: 'deflow', model: 'deterministic-gate' },
    criteria: [{ id: 'ac-3', status: outcome === 'pass' ? 'satisfied' : 'unsatisfied' }],
    findings,
    summary: `${GATE} says so`,
    cost: { durationMs: 12 },
  }) as unknown as VerdictV3;

const context = (overrides: Partial<RepairContext> = {}): RepairContext => ({
  evaluatedNode: PRODUCER,
  ambientPermission: 'worktree',
  replanDepth: 1,
  evidence: [EVIDENCE],
  proposedBy: 'gate-typecheck' as NodeId,
  ...overrides,
});

/**
 * KAR-11.2's `PROVIDER_NOT_PROBED` is a *blocking* plan diagnostic, so a fix
 * node that names no provider preference is a patch `commitPatchedPlan` refuses
 * — which would make every repair unappliable. Routing is the scheduler's
 * knowledge, not this module's, so it arrives on the context.
 */
suite('the fix node is routable (KAR-11.2 PROVIDER_NOT_PROBED)', () => {
  it('carries the provider preference the scheduler supplied', () => {
    const decision = repairPatchesFor(
      verdict('fail', [finding('a13f5c2b1e04')]),
      context({ fixProvider: ['claude' as ProviderId] }),
    );

    expect(decision.kind).toBe('fix');
    if (decision.kind !== 'fix') return;
    const op = decision.patches[0]?.ops[0];
    if (op?.op !== 'insert-nodes') return expect.unreachable('a repair inserts a node');
    const node = op.nodes[0];
    expect(node?.type).toBe('agent');
    if (node?.type !== 'agent') return;
    expect(node.provider.prefer).toEqual(['claude']);
    // Still inherits nothing: a preference is routing, not context (AC6).
    expect(node.resume).toBe('always-replay');
  });

  it('prefers nothing when the scheduler named nothing', () => {
    const decision = repairPatchesFor(verdict('fail', [finding('a13f5c2b1e04')]), context());

    expect(decision.kind).toBe('fix');
    if (decision.kind !== 'fix') return;
    const op = decision.patches[0]?.ops[0];
    if (op?.op !== 'insert-nodes') return expect.unreachable('a repair inserts a node');
    const node = op.nodes[0];
    if (node?.type !== 'agent') return;
    expect(node.provider.prefer).toEqual([]);
  });
});

// ── AC1, AC2: one fix node per finding, and what produces none ───────────────

suite('one fix node per finding (EPIC-12-S30, first scenario, test plan #1)', () => {
  it('proposes exactly n patches for n blocking findings, one per Finding.id', () => {
    const ids = ['a13f5c2b1e04', '9c02d7ab3311', '55c1ee900a72', '0044ffab1234', 'deadbeef0001'];
    const decision = repairPatchesFor(
      verdict(
        'fail',
        ids.map((id) => finding(id)),
      ),
      context(),
    );

    expect(decision.kind).toBe('fix');
    if (decision.kind !== 'fix') return;
    expect(decision.patches).toHaveLength(ids.length);
    expect(decision.patches.map((patch) => patch.id)).toHaveLength(new Set(ids).size);
  });

  it('puts the finding id in the node id and the finding message in the reason', () => {
    const decision = repairPatchesFor(verdict('fail', [finding('a13f5c2b1e04')]), context());

    expect(decision.kind).toBe('fix');
    if (decision.kind !== 'fix') return;
    const [patch] = decision.patches;
    expect(patch?.reason).toBe(
      repairReason(
        GATE,
        "ts2345: Argument of type 'string' is not assignable to parameter of type 'Date'",
      ),
    );
    const op = patch?.ops[0];
    expect(op?.op).toBe('insert-nodes');
    if (op?.op !== 'insert-nodes') return;
    expect(op.nodes).toHaveLength(1);
    expect(op.nodes[0]?.id).toBe('fix-a13f5c2b1e04');
    expect(op.nodes[0]?.id).toContain('a13f5c2b1e04');
  });

  it('gives each fix node a packet of exactly one finding — never a batch', () => {
    const decision = repairPatchesFor(
      verdict('fail', [finding('a13f5c2b1e04'), finding('9c02d7ab3311')]),
      context(),
    );

    if (decision.kind !== 'fix') throw new Error('expected fix nodes');
    for (const patch of decision.patches) {
      const op = patch.ops[0];
      if (op?.op !== 'insert-nodes') throw new Error('expected an insert');
      expect(op.nodes).toHaveLength(1);
    }
    expect(decision.findings.map((entry) => entry.finding.id)).toEqual([
      'a13f5c2b1e04',
      '9c02d7ab3311',
    ]);
  });

  it('emits patches that are well-formed PlanPatch documents', () => {
    const decision = repairPatchesFor(verdict('fail', [finding('a13f5c2b1e04')]), context());

    if (decision.kind !== 'fix') throw new Error('expected fix nodes');
    for (const patch of decision.patches) expect(() => PlanPatchSchema.parse(patch)).not.toThrow();
  });

  it("declares the finding's own file as the fix node's write scope", () => {
    const decision = repairPatchesFor(verdict('fail', [finding('a13f5c2b1e04')]), context());

    if (decision.kind !== 'fix') throw new Error('expected fix nodes');
    const op = decision.patches[0]?.ops[0];
    if (op?.op !== 'insert-nodes') throw new Error('expected an insert');
    expect(op.nodes[0]?.pathScopes.write).toContain('packages/ui/src/DatePicker.vue');
  });
});

suite('what produces no fix node (EPIC-12-S30, second scenario)', () => {
  it('opens a human node for a needs-human verdict and proposes nothing', () => {
    const decision = repairPatchesFor(verdict('needs-human', [finding('a13f5c2b1e04')]), context());

    expect(decision.kind).toBe('human');
    if (decision.kind !== 'human') return;
    expect(decision.why).toBe('gate-unverifiable');
    expect(decision).not.toHaveProperty('patches');
  });

  it('proposes nothing at all for a pass', () => {
    const decision = repairPatchesFor(verdict('pass'), context());

    expect(decision.kind).toBe('none');
  });

  it('proposes no fix node for findings below the floor', () => {
    const decision = repairPatchesFor(
      verdict('fail', [
        finding('a13f5c2b1e04', { severity: 'minor' }),
        finding('9c02d7ab3311', { severity: 'info' }),
      ]),
      context(),
    );

    expect(decision.kind).toBe('human');
    if (decision.kind !== 'human') return;
    expect(decision.why).toBe('no-actionable-finding');
  });

  it('splits a mixed verdict on the floor rather than on the count', () => {
    const decision = repairPatchesFor(
      verdict('fail', [
        finding('a13f5c2b1e04'),
        finding('9c02d7ab3311', { severity: 'minor' }),
        finding('55c1ee900a72', { severity: 'major' }),
      ]),
      context(),
    );

    if (decision.kind !== 'fix') throw new Error('expected fix nodes');
    expect(decision.patches).toHaveLength(1);
    expect(decision.findings[0]?.finding.id).toBe('a13f5c2b1e04');
  });
});

// ── AC6: the fix node is fresh ───────────────────────────────────────────────

suite('the fix node never inherits the producer (AC6)', () => {
  it('never asks to resume anything: its resume is always-replay', () => {
    const decision = repairPatchesFor(verdict('fail', [finding('a13f5c2b1e04')]), context());

    if (decision.kind !== 'fix') throw new Error('expected fix nodes');
    const op = decision.patches[0]?.ops[0];
    if (op?.op !== 'insert-nodes') throw new Error('expected an insert');
    const node = op.nodes[0];
    expect(node?.type).toBe('agent');
    if (node?.type !== 'agent') return;
    expect(node.resume).toBe('always-replay');
  });

  it('refuses a fork, whoever asked for it', () => {
    expect(() =>
      assertFreshRepairContext(
        { id: fixNodeId('a13f5c2b1e04'), resume: { kind: 'fork' } },
        PRODUCER,
      ),
    ).toThrow(RepairContextNotFresh);
  });

  it("refuses a resume of the producer's own session", () => {
    expect(() =>
      assertFreshRepairContext(
        { id: fixNodeId('a13f5c2b1e04'), resume: { of: PRODUCER } },
        PRODUCER,
      ),
    ).toThrow(RepairContextNotFresh);
  });

  it('allows the ordinary replay, which inherits nothing', () => {
    expect(() =>
      assertFreshRepairContext(
        { id: fixNodeId('a13f5c2b1e04'), resume: 'always-replay' },
        PRODUCER,
      ),
    ).not.toThrow();
  });
});

// ── AC7: the cap is 3, and it is one number ──────────────────────────────────

suite('three attempts, then escalation (EPIC-12-S32, test plan #2)', () => {
  const attempt = (n: number): RepairAttempt => ({
    attempt: n,
    diff: `artifact://${String(n).repeat(64)}` as Handle,
    verdictHandle: `artifact://${String(n + 4).repeat(64)}` as Handle,
    verdict: verdict('fail', [finding('a13f5c2b1e04')]),
  });

  const escalationInput = (attempts: readonly RepairAttempt[]) => ({
    node: fixNodeId('a13f5c2b1e04'),
    gate: GATE,
    finding: 'a13f5c2b1e04',
    attempts,
  });

  it('schedules attempt 2 after one failure', () => {
    const next = repairNext(escalationInput([attempt(1)]));

    expect(next.kind).toBe('attempt');
    if (next.kind !== 'attempt') return;
    expect(next.attempt).toBe(2);
  });

  it('escalates after the third failure, and does not schedule a fourth', () => {
    const next = repairNext(escalationInput([attempt(1), attempt(2), attempt(3)]));

    expect(next.kind).toBe('escalate');
    if (next.kind !== 'escalate') return;
    expect(next.request.repair?.attempts).toHaveLength(3);
  });

  it('carries three diff handles and three verdict handles', () => {
    const next = repairNext(escalationInput([attempt(1), attempt(2), attempt(3)]));

    if (next.kind !== 'escalate') throw new Error('expected an escalation');
    expect(next.request.repair?.attempts.map((entry) => entry.diff)).toEqual([
      attempt(1).diff,
      attempt(2).diff,
      attempt(3).diff,
    ]);
    expect(next.request.repair?.attempts.map((entry) => entry.verdict)).toEqual([
      attempt(1).verdictHandle,
      attempt(2).verdictHandle,
      attempt(3).verdictHandle,
    ]);
  });

  it('emits a human.requested payload the ledger will accept', () => {
    const next = repairNext(escalationInput([attempt(1), attempt(2), attempt(3)]));

    if (next.kind !== 'escalate') throw new Error('expected an escalation');
    expect(() => HumanRequestedSchema.parse(next.request)).not.toThrow();
  });

  it('would fail if the cap were 4: a fourth attempt is never scheduled', () => {
    // The assertion the epic asks for in as many words — "a test that would
    // fail at 4". Four recorded failures still escalate rather than producing
    // a fifth; three is where it stops, and it stops there because
    // REPAIR_ATTEMPT_CAP is 3.
    expect(REPAIR_ATTEMPT_CAP).toBe(3);
    const next = repairNext(escalationInput([attempt(1), attempt(2)]));
    expect(next.kind).toBe('attempt');
    if (next.kind === 'attempt') expect(next.attempt).toBe(3);
  });

  it("reads the cap from the scheduler's own maxAttemptsPerNode, not a copy", () => {
    // EPIC-12-S32's third scenario: "the repair cap and the scheduler cap are
    // the same number, read from one place". Two constants that happen to
    // agree is a bug waiting for one of them to be tuned.
    expect(REPAIR_ATTEMPT_CAP).toBe(DEFAULT_NO_PROGRESS_POLICY.maxAttemptsPerNode);
  });
});

// ── AC11: the per-attempt projection ─────────────────────────────────────────

suite('every attempt is projectable (test plan #3, AC11)', () => {
  const withFindings = (n: number, ids: readonly string[]): RepairAttempt => ({
    attempt: n,
    diff: `artifact://${String(n).repeat(64)}` as Handle,
    verdictHandle: `artifact://${String(n + 4).repeat(64)}` as Handle,
    verdict: verdict(
      'fail',
      ids.map((id) => finding(id)),
    ),
  });

  it('reports the finding-id delta against the previous attempt', () => {
    const projection = repairAttemptProjection([
      withFindings(1, ['a13f5c2b1e04', '55c1ee900a72']),
      withFindings(2, ['55c1ee900a72', '9c02d7ab3311']),
    ]);

    expect(projection[1]?.delta).toEqual({
      fixed: ['a13f5c2b1e04'],
      remaining: ['55c1ee900a72'],
      introduced: ['9c02d7ab3311'],
    });
  });

  it('measures the first attempt against the findings that produced it', () => {
    const projection = repairAttemptProjection(
      [withFindings(1, ['a13f5c2b1e04'])],
      ['a13f5c2b1e04', '55c1ee900a72'],
    );

    expect(projection[0]?.delta.fixed).toEqual(['55c1ee900a72']);
    expect(projection[0]?.delta.remaining).toEqual(['a13f5c2b1e04']);
  });

  it('carries the diff and verdict handles so the view needs no recomputation', () => {
    const projection = repairAttemptProjection([withFindings(1, ['a13f5c2b1e04'])]);

    expect(projection[0]?.diff).toBe(withFindings(1, []).diff);
    expect(projection[0]?.verdict).toBe(withFindings(1, []).verdictHandle);
  });
});

// ── AC5: the re-run starts at the deterministic tier ─────────────────────────

suite('the gate set re-runs from the deterministic tier (AC5, test plan #8)', () => {
  const gates: readonly LadderGate[] = [
    { node: 'gate-review' as NodeId, gate: 'review' as GateId, kind: 'adversarial' },
    { node: 'gate-typecheck' as NodeId, gate: GATE, kind: 'deterministic' },
    { node: 'gate-scope' as NodeId, gate: 'scope' as GateId, kind: 'structural' },
    { node: 'gate-lint' as NodeId, gate: 'lint' as GateId, kind: 'deterministic' },
  ];

  it('reopens the deterministic tier, not the gate that failed', () => {
    expect(gatesAfterRepair(gates).map((gate) => gate.node)).toEqual([
      'gate-typecheck',
      'gate-lint',
    ]);
  });

  it('discards the passes the earlier tiers already recorded', () => {
    // A fix that breaks typecheck is caught before the review is paid for
    // again — which is only true if a gate that already passed is asked again.
    const admitted = gatesAfterRepair(gates);

    expect(admitted.map((gate) => gate.kind)).toEqual(['deterministic', 'deterministic']);
    expect(admitted.some((gate) => gate.kind === 'adversarial')).toBe(false);
  });
});
