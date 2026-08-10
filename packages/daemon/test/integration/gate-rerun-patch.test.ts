/**
 * KAR-12.5 AC5 — the fix node landed, so the gate set re-runs from the
 * deterministic tier, as a **committed plan version**.
 *
 * `rerunGatePatch` is pure and decides the shape. This is the half that has to
 * be integration: the patch goes through the same policy ruling and the same
 * single plan-write seam a planner's does, against a real file-backed ledger
 * with a real `run` row — so *"the gate re-runs"* is a property of the plan the
 * scheduler is executing rather than of a return value.
 *
 * The assertion that matters is the pair: the fresh gate node is `active` and
 * depends on the fix node, and the answered one is `abandoned`. Either alone is
 * a run that either never re-checks or re-checks for ever.
 *
 * Verifies: EPIC-12-S29 (re-run half) · AC5
 */
import type { PlanGraph, PlanTimeCapability, TaskSpec } from '@DeFlow/core';
import { DEFAULT_PATCH_RULE_SPECS, PlanGraphSchema, planHash, TaskSpecSchema } from '@DeFlow/core';
import {
  appendEvents,
  openLedger,
  persistPlanVersion,
  readPlanDoc,
  readRange,
} from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { applyGateRerun } from '../../src/gates/repair-loop.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';

const RUN = 'run_20260810T150000Z_b71e34';
const T0 = 1_754_390_000_000;
const EPOCH = 2;
const PLANNER = { model: 'a-model', effort: 'max', tier: 'strongest' } as const;
const POLICY_HASH = `sha256-${'e'.repeat(64)}`;

const CAPS: readonly PlanTimeCapability[] = [
  {
    provider: 'claude',
    version: '2.1.220',
    structuredOutput: true,
    resume: true,
    permissionLevels: ['read', 'worktree', 'worktree+net', 'full'],
    maxContext: 200_000,
  },
];

const SPEC: TaskSpec = TaskSpecSchema.parse({
  schemaId: 'DeFlow.taskspec.v1',
  goal: 'Repair one typecheck finding.',
  scope: { included: ['src'] },
  nonGoals: [],
  constraints: [],
  priorDecisions: [],
  acceptanceCriteria: [
    {
      id: 'ac-1',
      statement: 'the codebase typechecks',
      check: { kind: 'gate', gate: 'typecheck' },
    },
  ],
  knownFailureModes: [],
  approvedBy: { at: '2026-08-10T15:00:00.000Z', via: 'ui' },
  specHash: `sha256-${'d'.repeat(64)}`,
});

/** The same opted-in table the repair patch is ruled under: a re-run that
 * needed an operator's approval would stall every repair on a click. */
const REPAIR_POLICY = [
  ...DEFAULT_PATCH_RULE_SPECS.filter((rule) => rule.id !== 'default'),
  {
    id: 'surgical-repair',
    when: { costDeltaUsd: '<= 5.00', blastRadiusFiles: '<= 5' },
    decision: 'auto',
  },
  { id: 'default', decision: 'approve' },
];

const estimator = () => ({
  tokenizer: o200kTokenizer(),
  accounting: () => 'exact' as const,
  family: () => 'anthropic',
  calibration: () => ({ n: 24, ratio: 1.18 }),
  countFiles: (paths: readonly string[]) => (paths.length === 0 ? 0 : 1),
  routing: () => ({ provider: 'claude' as const, model: 'claude-sonnet-4-5' }),
});

const node = (over: Record<string, unknown>): Record<string, unknown> => ({
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  pathScopes: { write: [] },
  permission: 'worktree',
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  ...over,
});

/** The plan as it stands after the repair patch: producer, gate, fix node. */
async function baseGraph(): Promise<PlanGraph> {
  const draft = {
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version: 2,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: SPEC.specHash,
    createdBy: 'planner',
    createdAt: '2026-08-10T15:00:00.000Z',
    nodes: [
      node({
        id: 'impl-1',
        title: 'Implement the change',
        type: 'agent',
        brief: 'Implement the change.',
        provider: { prefer: ['claude'], requires: [] },
        resume: 'always-replay',
        pathScopes: { write: ['src/**', 'test/**'] },
      }),
      node({
        id: 'gate-typecheck',
        title: 'Typecheck',
        type: 'gate',
        deps: ['impl-1'],
        permission: 'read',
        returns: { schemaId: 'DeFlow.verdict.v3', maxTokens: 600 },
        retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
        gate: { kind: 'deterministic', gateId: 'typecheck' },
        criteria: ['ac-1'],
        independence: { notSessionOf: [], preferDifferentProvider: false },
      }),
      node({
        id: 'fix-a13f0c2b91e4',
        title: 'Repair typecheck finding a13f0c2b91e4',
        type: 'agent',
        deps: ['impl-1'],
        brief: 'Repair the finding.',
        provider: { prefer: ['claude'], requires: [] },
        resume: 'always-replay',
        pathScopes: { write: ['src/date-picker.ts', 'test/**'] },
      }),
    ],
    edges: [
      { from: 'impl-1', to: 'gate-typecheck', kind: 'control' },
      { from: 'impl-1', to: 'fix-a13f0c2b91e4', kind: 'control' },
    ],
  };
  const parsed = PlanGraphSchema.parse(draft);
  return PlanGraphSchema.parse({
    ...draft,
    planHash: await planHash(parsed as unknown as Record<string, unknown>),
  });
}

suite('a landed fix reopens the deterministic tier as a plan version (S29, AC5)', () => {
  it('commits a successor whose fresh gate depends on the fix and whose old gate is retired', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const base = await baseGraph();
      await persistPlanVersion(db, {
        runId: RUN,
        runDir: join(tmp, 'runs', RUN),
        graph: base,
        by: 'planner',
        planner: PLANNER,
        diagnostics: [],
        ts: T0,
        epoch: EPOCH,
      });
      appendEvents(db, [
        {
          runId: RUN,
          ts: T0,
          kind: 'policy.patch.loaded',
          v: 1,
          epoch: EPOCH,
          payload: { source: 'config', hash: POLICY_HASH, rules: REPAIR_POLICY },
        },
        {
          runId: RUN,
          ts: T0,
          kind: 'run.spec.approved',
          v: 1,
          epoch: EPOCH,
          payload: { specHash: SPEC.specHash, by: 'ui' },
        },
        {
          runId: RUN,
          ts: T0,
          kind: 'plan.proposed',
          v: 2,
          epoch: EPOCH,
          payload: { version: 2, planHash: base.planHash, graph: base, by: 'planner' },
        },
        {
          runId: RUN,
          ts: T0,
          kind: 'run.started',
          v: 1,
          epoch: EPOCH,
          payload: { planHash: base.planHash },
        },
      ]);
      db.prepare(
        `INSERT INTO run (run_id, status, plan_hash, last_seq, state_json, checkpoint_version,
            daemon_epoch)
          VALUES (?, 'running', ?, 0, '{}', 1, ?)`,
      ).run(RUN, base.planHash, EPOCH);

      const outcome = await applyGateRerun(db, {
        runId: RUN,
        base,
        after: ['fix-a13f0c2b91e4'],
        round: 2,
        detail: 'test 1a2b3c4, fix 5d6e7f8',
        runDir: join(tmp, 'runs', RUN),
        spec: SPEC,
        caps: CAPS,
        estimatePacketTokens: () => 0,
        refs: { isValidRef: () => Promise.resolve(true) },
        estimator: estimator(),
        planner: PLANNER,
        proposedBy: 'scheduler',
        replanDepth: 2,
        ts: T0 + 1_000,
        epoch: EPOCH,
      });

      expect(outcome.applied).toBe(true);
      expect(outcome.decision).toBe('auto');
      expect(outcome.scheduled).toEqual(['gate-typecheck-r2']);

      const patched = readRange(db, RUN, 0, 500).events.filter(
        (event) => event.kind === 'plan.patched',
      );
      expect(patched).toHaveLength(1);
      const event = patched[0]?.payload as { fromHash: string; toHash: string };
      expect(event.fromHash).toBe(base.planHash);

      const successor = PlanGraphSchema.parse(JSON.parse(readPlanDoc(db, event.toHash) ?? '{}'));
      const byId = Object.fromEntries(successor.nodes.map((entry) => [entry.id, entry]));

      expect(byId['gate-typecheck']?.lifecycle).toBe('abandoned');
      const fresh = byId['gate-typecheck-r2'];
      expect(fresh?.lifecycle).toBe('active');
      expect(fresh?.deps).toEqual(['fix-a13f0c2b91e4']);
      // The definition travels: a re-run against a different check would be a
      // green about something nobody asked for.
      expect(fresh?.type === 'gate' ? fresh.gate : null).toEqual({
        kind: 'deterministic',
        gateId: 'typecheck',
      });
    } finally {
      db.close();
    }
  });

  it('does nothing, and says so, when the plan has no deterministic gate to re-run', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      const base = await baseGraph();
      const stripped = PlanGraphSchema.parse({
        ...base,
        nodes: base.nodes.filter((entry) => entry.type !== 'gate'),
        edges: base.edges.filter((edge) => edge.to !== 'gate-typecheck'),
      });

      const outcome = await applyGateRerun(db, {
        runId: RUN,
        base: stripped,
        after: ['fix-a13f0c2b91e4'],
        round: 2,
        runDir: join(tmp, 'runs', RUN),
        spec: SPEC,
        caps: CAPS,
        estimatePacketTokens: () => 0,
        refs: { isValidRef: () => Promise.resolve(true) },
        estimator: estimator(),
        planner: PLANNER,
        proposedBy: 'scheduler',
        replanDepth: 2,
        ts: T0 + 1_000,
        epoch: EPOCH,
      });

      expect(outcome.applied).toBe(false);
      expect(outcome.scheduled).toEqual([]);
      // No plan version, because nothing changed: a successor with no change in
      // it is a row in the plan history nobody can be told the meaning of.
      expect(readRange(db, RUN, 0, 500).events).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
