/**
 * KAR-12.1 / KAR-12.5 — the daemon-side half of the repair loop: a failing
 * verdict becomes a *committed plan version* carrying the fix node.
 *
 * `@DeFlow/gates` decides what a verdict earns (`repairPatchesFor`) and which
 * tier re-opens afterwards (`gatesAfterRepair`); both are pure. This is the
 * part that has to be integration: the patch goes through the same policy
 * ruling and the same single plan-write seam as a planner-proposed one, against
 * a real file-backed ledger with a real `run` row, so *"the swap appears in the
 * visualisation"* is a property of the ledger rather than of a return value.
 *
 * Verifies: EPIC-12-S29 (first scenario) · KAR-12.5 AC1, AC2
 */
import type { PlanGraph, PlanNode, PlanTimeCapability, TaskSpec, VerdictV3 } from '@DeFlow/core';
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
import { applyGateRepair } from '../../src/gates/repair-loop.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';

const RUN = 'run_20260809T121500Z_b71e33';
const T0 = 1_754_390_000_000;
const EPOCH = 2;
const PLANNER = { model: 'a-model', effort: 'max', tier: 'strongest' } as const;

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
  approvedBy: { at: '2026-08-09T12:00:00.000Z', via: 'ui' },
  specHash: `sha256-${'d'.repeat(64)}`,
});

/** The tier-2 estimator the policy engine costs a patch with. Injected here
 * rather than measured, because what is under test is the decision. */
const estimator = () => ({
  tokenizer: o200kTokenizer(),
  accounting: () => 'exact' as const,
  family: () => 'anthropic',
  calibration: () => ({ n: 24, ratio: 1.18 }),
  countFiles: (paths: readonly string[]) => (paths.length === 0 ? 0 : 1),
  // What the scheduler resolved for the node. A repair patch's fix node
  // inherits no provider preference by design (§7 — the fix node inherits
  // nothing), so without this the cost estimate is `null` and every rule that
  // names `costDeltaUsd` silently never matches.
  routing: () => ({ provider: 'claude' as const, model: 'claude-sonnet-4-5' }),
});

/**
 * The rule table this run pins, as a project's `.DeFlow/config.yaml` would.
 *
 * DeFlow's **shipped** defaults queue a repair for approval: the only `auto`
 * arms are `read-only-analysis` and the quota reroute, and a fix node that
 * edits code is neither. S29's *"the patch policy engine decides auto because
 * the node adds no permission and costs under $5.00"* is therefore a statement
 * about a project that has opted into surgical repairs — so it is written down
 * here rather than assumed, and the arm sits **below** every escalate and
 * reject arm the defaults ship, so nothing it says can carry a patch past a
 * permission escalation or the execution boundary.
 */
const REPAIR_POLICY = [
  ...DEFAULT_PATCH_RULE_SPECS.filter((rule) => rule.id !== 'default'),
  {
    id: 'surgical-repair',
    when: { costDeltaUsd: '<= 5.00', blastRadiusFiles: '<= 5' },
    decision: 'auto',
  },
  { id: 'default', decision: 'approve' },
];

const POLICY_HASH = `sha256-${'e'.repeat(64)}`;

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

async function baseGraph(): Promise<PlanGraph> {
  const draft = {
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: SPEC.specHash,
    createdBy: 'planner',
    createdAt: '2026-08-09T12:00:00.000Z',
    nodes: [
      node({
        id: 'impl-1',
        title: 'Implement the change',
        type: 'agent',
        brief: 'Implement the change.',
        provider: { prefer: ['claude'], requires: ['structuredOutput'] },
        resume: 'always-replay',
        // Wide enough that the fix node's scope — the one file it names, plus
        // the tests it is required to write — adds no write capability. That is
        // what makes S29's ruling `auto` rather than S33's queue.
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
    ],
    edges: [{ from: 'impl-1', to: 'gate-typecheck', kind: 'control' }],
  };
  const parsed = PlanGraphSchema.parse(draft);
  return PlanGraphSchema.parse({
    ...draft,
    planHash: await planHash(parsed as unknown as Record<string, unknown>),
  });
}

const FAILED: VerdictV3 = {
  schemaId: 'DeFlow.verdict.v3',
  outcome: 'fail',
  gate: 'typecheck',
  evaluatedNode: 'impl-1',
  by: { node: 'gate-typecheck', provider: 'deflow', model: 'deterministic-gate' },
  specHash: SPEC.specHash,
  criteria: [{ id: 'ac-1', status: 'unsatisfied' }],
  findings: [
    {
      id: 'a13f0c2b91e4',
      severity: 'blocker',
      criterion: 'ac-1',
      location: { file: 'src/router/guards.ts', line: 88, blobSha: 'b'.repeat(40) },
      message: "Argument of type 'string' is not assignable to parameter of type 'Date'",
      evidence: [`artifact://${'1'.repeat(64)}`],
    },
  ],
  summary: 'typecheck failed with 1 finding(s)',
  cost: { durationMs: 2410 },
};

suite('one blocking finding becomes one committed fix node (S29)', () => {
  it('rules the patch auto and writes a plan version the run is executing', async ({ tmp }) => {
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
      // The run as the ledger has it: the policy engine reads the reduced
      // state, so a plan that exists only as a document would make every path
      // the patch names look like new write capability.
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
          payload: { version: 1, planHash: base.planHash, graph: base, by: 'planner' },
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

      const outcome = await applyGateRepair(db, {
        runId: RUN,
        verdict: FAILED,
        base,
        runDir: join(tmp, 'runs', RUN),
        spec: SPEC,
        caps: CAPS,
        estimatePacketTokens: (_node: PlanNode) => 0,
        refs: { isValidRef: () => Promise.resolve(true) },
        estimator: estimator(),
        planner: PLANNER,
        ts: T0 + 1_000,
        epoch: EPOCH,
        context: {
          evaluatedNode: 'impl-1',
          ambientPermission: 'worktree',
          replanDepth: 1,
          evidence: [`artifact://${'1'.repeat(64)}`],
          proposedBy: 'scheduler',
          testScopes: ['test/**'],
          // Routing, not inheritance: without it the fix node prefers no
          // provider and `commitPatchedPlan` refuses it with
          // `PROVIDER_NOT_PROBED`.
          fixProvider: ['claude'],
        },
      });

      expect(outcome.kind).toBe('fix');
      expect(outcome.applied).toEqual(['fix-a13f0c2b91e4']);
      expect(outcome.decisions.map((entry) => entry.decision)).toEqual(['auto']);

      // The successor plan is what the run is executing, and it carries the fix
      // node — not a return value that says it would have.
      const patched = readRange(db, RUN, 0, 500).events.filter(
        (event) => event.kind === 'plan.patched',
      );
      expect(patched).toHaveLength(1);
      const event = patched[0]?.payload as {
        fromHash: string;
        toHash: string;
        decision: { decision: string; rule: string };
      };
      expect(event.fromHash).toBe(base.planHash);
      expect(event.decision).toMatchObject({ decision: 'auto', rule: 'surgical-repair' });
      const doc = readPlanDoc(db, event.toHash);
      expect(doc).not.toBeNull();
      const successor = PlanGraphSchema.parse(JSON.parse(doc ?? '{}'));
      expect(successor.nodes.map((entry) => entry.id)).toContain('fix-a13f0c2b91e4');

      // AC5 — the re-run starts at the bottom of the ladder, not at the gate
      // that failed.
      expect(outcome.rerun.map((gate) => gate.node)).toEqual(['gate-typecheck']);
    } finally {
      db.close();
    }
  });

  it('earns no fix node from a passing verdict', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const base = await baseGraph();
      const outcome = await applyGateRepair(db, {
        runId: RUN,
        verdict: { ...FAILED, outcome: 'pass', findings: [] },
        base,
        runDir: join(tmp, 'runs', RUN),
        spec: SPEC,
        caps: CAPS,
        estimatePacketTokens: () => 0,
        refs: { isValidRef: () => Promise.resolve(true) },
        estimator: estimator(),
        planner: PLANNER,
        ts: T0 + 1_000,
        epoch: EPOCH,
        context: {
          evaluatedNode: 'impl-1',
          ambientPermission: 'worktree',
          replanDepth: 1,
          evidence: [],
          proposedBy: 'scheduler',
        },
      });

      expect(outcome.kind).toBe('none');
      expect(outcome.applied).toEqual([]);
      expect(readRange(db, RUN, 0, 500).events).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});
