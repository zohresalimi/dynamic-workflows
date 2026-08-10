/**
 * A data directory holding one run parked at the F1.3 approval gate, seeded
 * before any daemon is started over it (KAR-10.3, EPIC-10-S18).
 *
 * The run is seeded rather than driven through a real framing interview because
 * what EPIC-10-S18 is about is the *approval*, not how the spec got there:
 * driving framing would need a real vendor CLI on this machine, and the
 * interview has its own suite against a real spawned agent
 * (`packages/daemon/test/integration/framing-*.test.ts`). Everything after this
 * point is real — a real DeFlowd process, a real HTTP request, the real CLI
 * client — which is the part two surfaces can disagree about.
 *
 * The write happens with no daemon running, and the connection is closed before
 * one is spawned: `boot()` takes an exclusive lease on the directory, and two
 * writers is the failure EPIC-03-S21 exists to prevent, not one to reproduce
 * here by accident.
 */
import type { TaskSpecDraft } from '@DeFlow/core';
import {
  NO_DEADLINE_WAKE_AT,
  PlanGraphSchema,
  RunIdSchema,
  renderSpecForReview,
  SPEC_APPROVAL_OPTIONS,
  SPEC_GATE_NODE,
  sealTaskSpec,
} from '@DeFlow/core';
import { appendEvents, openLedger, scheduleWake } from '@DeFlow/ledger';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SPEC_RUN = RunIdSchema.parse('run_20260807T113000Z_c92a17');

const T0 = 1_754_561_400_000;

const PLAN_HASH = `sha256-${'a'.repeat(64)}`;

const FRAMED = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../packages/core/test/fixtures/specs/vue3-migration.framed.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as TaskSpecDraft;

/**
 * The plan a mid-run re-approval is judged against (EPIC-12-S24): one gate node
 * that covers `ac-1` and nothing else, so `ac-2` — which the framed fixture does
 * not mark unverifiable — reaches no gate at all.
 *
 * Spelled out here for the same reason the gate below is: this is a fixture, and
 * `@DeFlow/daemon` is a leaf `e2e/` does not import from. Run through
 * `PlanGraphSchema` before it is appended, because the append boundary validates
 * the *envelope* and not the payload: a graph with a typo in it would be skipped
 * at read time and this spec would pass for the wrong reason.
 */
function uncoveredPlan(taskSpecHash: string): Record<string, unknown> {
  const node = (over: Record<string, unknown>) => ({
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    pathScopes: { write: [] },
    ...over,
  });
  return {
    schemaId: 'DeFlow.plangraph.v1',
    runId: SPEC_RUN,
    version: 1,
    planHash: PLAN_HASH,
    parent: null,
    taskSpecHash,
    createdBy: 'planner',
    createdAt: '2026-08-07T11:30:00.000Z',
    nodes: [
      node({
        id: 'implement',
        title: 'Migrate the checkout module',
        type: 'agent',
        permission: 'worktree',
        returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
        retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
        budget: {},
        brief: 'Migrate the checkout module, carefully.',
        provider: { prefer: ['claude'], requires: ['structuredOutput'] },
        resume: 'always-replay',
      }),
      node({
        id: 'gate-unit-tests',
        title: 'Run the checkout unit tests',
        type: 'gate',
        deps: ['implement'],
        permission: 'read',
        returns: { schemaId: 'DeFlow.verdict.v3', maxTokens: 600 },
        retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
        budget: {},
        gate: { kind: 'deterministic', gateId: 'unit-tests' },
        criteria: ['ac-1'],
        independence: { notSessionOf: [], preferDifferentProvider: false },
      }),
    ],
    edges: [{ from: 'implement', to: 'gate-unit-tests', kind: 'control' }],
  } as Record<string, unknown>;
}

/**
 * A run that is **already approved and running** on a plan that does not cover
 * every criterion, with the approval gate re-opened — the state a mid-run spec
 * re-confirmation is answered from (KAR-12.4 AC1, EPIC-12-S24).
 *
 * The plan is seeded rather than compiled for the same reason the spec is: what
 * this scenario is about is the answer `POST /api/runs/:id/spec/approve` gives,
 * not how the plan got there. A plan this shape can never come *out* of
 * compilation — `compilePlanV1` refuses it (see
 * `packages/daemon/test/integration/plan-compile.test.ts`) — which is exactly
 * why the approval surface has to refuse it too rather than assume.
 */
export async function seedRunAtSpecGateOnUncoveredPlan(dataDir: string): Promise<string> {
  const specHash = await seedRunAtSpecGate(dataDir);
  const db = openLedger(dataDir);
  try {
    appendEvents(db, [
      {
        runId: SPEC_RUN,
        ts: T0,
        kind: 'run.spec.approved',
        v: 1,
        epoch: 1,
        payload: { specHash, by: 'ui' },
      },
      {
        runId: SPEC_RUN,
        ts: T0,
        kind: 'plan.proposed',
        v: 2,
        epoch: 1,
        payload: {
          version: 1,
          planHash: PLAN_HASH,
          graph: PlanGraphSchema.parse(uncoveredPlan(specHash)),
          by: 'planner',
        },
      },
      {
        runId: SPEC_RUN,
        ts: T0,
        kind: 'run.started',
        v: 1,
        epoch: 1,
        payload: { planHash: PLAN_HASH },
      },
      // The gate, re-opened: the operator is being asked to confirm the spec
      // again while the run is on a plan that no longer covers all of it.
      {
        runId: SPEC_RUN,
        ts: T0,
        kind: 'human.requested',
        v: 1,
        epoch: 1,
        nodeId: SPEC_GATE_NODE,
        payload: {
          node: SPEC_GATE_NODE,
          prompt: renderSpecForReview(structuredClone(FRAMED)),
          options: SPEC_APPROVAL_OPTIONS.map((option) => ({ ...option })),
        },
      },
    ]);
    return specHash;
  } finally {
    db.close();
  }
}

/** Seeds `dataDir` and closes the connection again. */
export async function seedRunAtSpecGate(dataDir: string): Promise<string> {
  const spec = await sealTaskSpec(structuredClone(FRAMED));
  const db = openLedger(dataDir);
  try {
    appendEvents(db, [
      {
        runId: SPEC_RUN,
        ts: T0,
        kind: 'task.submitted',
        v: 1,
        epoch: 1,
        payload: {
          sha256: 'a'.repeat(64),
          raw: 'Migrate the checkout module from Vue 2 to Vue 3.',
          provenance: { kind: 'text', by: 'cli', submittedAt: T0 },
        },
      },
      {
        runId: SPEC_RUN,
        ts: T0,
        kind: 'run.created',
        v: 1,
        epoch: 1,
        payload: { spec, cwd: '/tmp/repo', repo: { head: 'e83c516', branch: 'main' } },
      },
    ]);
    // The gate itself, spelled out rather than imported: R2 keeps
    // `@DeFlow/daemon` a leaf that only `packages/cli` may depend on, and this
    // is a fixture rather than the thing under test. If it ever drifts from
    // `openSpecApprovalGate`, the spec fails loudly with `gate_not_open` on the
    // very first request rather than passing against the wrong shape.
    db.transaction(() => {
      appendEvents(db, [
        {
          runId: SPEC_RUN,
          ts: T0,
          kind: 'human.requested',
          v: 1,
          epoch: 1,
          nodeId: SPEC_GATE_NODE,
          payload: {
            node: SPEC_GATE_NODE,
            prompt: renderSpecForReview(structuredClone(FRAMED)),
            options: SPEC_APPROVAL_OPTIONS.map((option) => ({ ...option })),
          },
        },
      ]);
      scheduleWake(db, {
        runId: SPEC_RUN,
        nodeId: SPEC_GATE_NODE,
        wakeAt: NO_DEADLINE_WAKE_AT,
        reason: 'human_gate',
      });
    });
    return spec.specHash;
  } finally {
    db.close();
  }
}
