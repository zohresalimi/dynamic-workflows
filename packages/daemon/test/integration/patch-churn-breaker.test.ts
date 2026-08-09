/**
 * EPIC-11-S23 — the churn circuit-breaker trip stops replanning rather than
 * causing more of it (docs/06-planning-and-replanning.md §7, KAR-11.4 AC8).
 *
 * The unit half — that `decidePatch` short-circuits before it consults the rule
 * table — lives in `packages/core/src/decide-patch.test.ts`. This is the half a
 * unit test cannot make: the breaker is **reduced state**, folded from
 * KAR-06.8's `run.needs_human { reason: 'churn' }`, so a hand-built state could
 * agree with a run the reducer cannot produce — which is the one thing this
 * check must not do, because it is what stands between a churning run and the
 * fourth, fifth and sixth replan it wants to make.
 *
 * The scenario's fourth clause is the sharpest and it is an absence: *"when the
 * tick loop runs for 30 simulated minutes, zero patches were auto-applied, zero
 * additional planner invocations were spawned, and the run is still
 * needs_human, waiting."*
 *
 * Verifies: EPIC-11-S23 (integration half) · KAR-11.4 AC8
 */
import { decide, type RunId, RunIdSchema } from '@DeFlow/core';
import {
  appendEvents,
  type EventDraft,
  openLedger,
  pendingPatchApprovals,
  readRange,
  replayRun,
} from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { rulePatch } from '../../src/budget/patch-gate.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';

const RUN: RunId = RunIdSchema.parse('run_20260808T140000Z_ee33ff');
const T0 = 1_754_654_400_000;
const MINUTE = 60_000;
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const NEXT_HASH = `sha256-${'b'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

const node = (id: string): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `brief for ${id}`,
  provider: { prefer: ['claude'], requires: [] },
  model: 'claude-sonnet-4-5',
  resume: 'always-replay',
});

/**
 * The patch from the scenario: *"a read-permission node proposes insert-nodes
 * of read-only analysis nodes"* — cheap, shallow, read-only. With the breaker
 * clear it matches `read-only-analysis` and auto-applies, which is precisely
 * why it is the patch this test uses.
 */
const ANALYSIS_PATCH = {
  schemaId: 'DeFlow.planpatch.v1',
  id: 'patch-analysis-9',
  proposedBy: 'n-recon',
  reason: 'recon found @acme/ui, @acme/forms and @acme/charts also import the v2 API',
  ops: [
    {
      op: 'insert-nodes',
      nodes: [node('n-analyse-ui'), node('n-analyse-forms')],
      edges: [],
    },
  ],
  policy: {
    estimatedCostDeltaUsd: 0.4,
    estimatedWallClockDeltaMs: 0,
    blastRadius: { paths: [], nodeCount: 2 },
    replanDepth: 1,
    escalatesPermission: null,
    addsWriteCapability: false,
  },
} as const;

const HUMAN_PATCH = {
  ...ANALYSIS_PATCH,
  id: 'patch-human-1',
  proposedBy: 'human',
  reason: 'the v2 API was never shipped for @acme/charts — stop looking for its adapter',
} as const;

const draft = (kind: string, payload: unknown, v = 1, ts = T0): EventDraft =>
  ({ runId: RUN, ts, kind, v, epoch: 1, payload }) as EventDraft;

/** A run whose planner replanned three times without completing a node, so
 * KAR-06.8's detector tripped and appended `run.needs_human { churn }`. */
function seed(dataDir: string): void {
  const db = openLedger(dataDir);
  try {
    appendEvents(db, [
      draft('run.created', {
        spec: taskSpec,
        cwd: '/home/u/proj',
        repo: { head: 'e83c516', branch: 'main' },
      }),
      draft('run.spec.approved', { specHash: SPEC_HASH, by: 'ui' }),
      draft(
        'plan.proposed',
        {
          version: 1,
          planHash: PLAN_HASH,
          graph: {
            schemaId: 'DeFlow.plangraph.v1',
            runId: RUN,
            version: 1,
            planHash: PLAN_HASH,
            parent: null,
            taskSpecHash: SPEC_HASH,
            createdBy: 'planner',
            createdAt: '2026-08-08T14:00:00.000Z',
            nodes: [node('n-hunt'), node('n-analyse')],
            edges: [],
          },
          by: 'planner',
        },
        2,
      ),
      draft('run.started', { planHash: PLAN_HASH }),
      draft('run.needs_human', {
        reason: 'churn',
        detail:
          'churn: 3 consecutive replans (plan versions 2, 3, 4) with the completed-node count flat at 0',
      }),
      draft('plan.patch.proposed', { patch: ANALYSIS_PATCH, basePlanHash: PLAN_HASH }, 3),
    ]);
  } finally {
    db.close();
  }
}

async function seeded(tmp: string, name = 'data'): Promise<string> {
  const dataDir = join(tmp, name);
  await mkdir(dataDir, { recursive: true });
  seed(dataDir);
  return dataDir;
}

const estimator = () => ({
  tokenizer: o200kTokenizer(),
  accounting: () => 'exact' as const,
  family: () => 'anthropic',
  calibration: () => ({ n: 24, ratio: 1.18 }),
  countFiles: () => 0,
});

suite('with the breaker tripped, the run does not replan its way out', () => {
  it('rejects a patch that would otherwise auto-apply, and says which rule refused it', async ({
    tmp,
  }) => {
    const dataDir = await seeded(tmp);
    const db = openLedger(dataDir);
    try {
      const state = replayRun(db, RUN).state;
      expect(state.needsHuman).toMatchObject({ reason: 'churn' });

      const ruling = rulePatch(db, {
        runId: RUN,
        state,
        patch: ANALYSIS_PATCH,
        estimator: estimator(),
        now: T0 + MINUTE,
      });

      expect(ruling).toMatchObject({ decision: 'reject', ruleId: 'circuit-breaker-tripped' });

      const events = readRange(db, RUN, 0, 1000).events;
      // Each rejected patch has its own record — nothing is dropped silently.
      expect(
        events
          .filter((event) => event.kind === 'plan.patch.rejected')
          .map((event) => (event.payload as { rule: string }).rule),
      ).toEqual(['circuit-breaker-tripped']);
      // And the run is not asked twice: it is already waiting for the same
      // person, about the same thing.
      expect(events.filter((event) => event.kind === 'run.needs_human')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('applies nothing and spawns nothing across thirty simulated minutes', async ({ tmp }) => {
    const dataDir = await seeded(tmp, 'thirty');
    const db = openLedger(dataDir);
    try {
      // One patch proposal per minute for half an hour — the shape a churning
      // run actually has. Time is a number handed in, never a timer: nothing
      // here sleeps.
      for (let minute = 1; minute <= 30; minute += 1) {
        const state = replayRun(db, RUN).state;
        rulePatch(db, {
          runId: RUN,
          state,
          patch: { ...ANALYSIS_PATCH, id: `patch-${minute}` },
          estimator: estimator(),
          now: T0 + minute * MINUTE,
        });
        // The scheduler is asked at the same instants and admits nothing: the
        // breaker halts admission, so no node is started and no planner is
        // invoked.
        expect(decide(state, T0 + minute * MINUTE).filter((c) => c.kind === 'StartNode')).toEqual(
          [],
        );
      }

      const events = readRange(db, RUN, 0, 5000).events;
      expect(events.filter((event) => event.kind === 'plan.patched')).toHaveLength(0);
      expect(events.filter((event) => event.kind === 'plan.patch.rejected')).toHaveLength(30);
      expect(replayRun(db, RUN).state.status).toBe('needs-human');
    } finally {
      db.close();
    }
  });
});

suite('the human patch is how the run is rescued', () => {
  it('is evaluated against the ordinary table rather than short-circuited', async ({ tmp }) => {
    const dataDir = await seeded(tmp, 'rescue');
    const db = openLedger(dataDir);
    try {
      const ruling = rulePatch(db, {
        runId: RUN,
        state: replayRun(db, RUN).state,
        patch: HUMAN_PATCH,
        estimator: estimator(),
        now: T0 + MINUTE,
      });

      expect(ruling).toMatchObject({ decision: 'auto', ruleId: 'read-only-analysis' });
      // Nothing was rejected and nobody was asked again: an `auto` decision is
      // recorded by the applier, in the same transaction as the plan it writes.
      const events = readRange(db, RUN, 0, 1000).events;
      expect(events.filter((event) => event.kind === 'plan.patch.rejected')).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('resets the breaker and clears the window when it is applied', async ({ tmp }) => {
    const dataDir = await seeded(tmp, 'reset');
    const db = openLedger(dataDir);
    try {
      appendEvents(db, [
        draft(
          'plan.patched',
          {
            version: 2,
            fromHash: PLAN_HASH,
            toHash: NEXT_HASH,
            patchId: HUMAN_PATCH.id,
            decision: {
              decision: 'auto',
              by: 'policy',
              rule: 'read-only-analysis',
              at: '2026-08-08T14:01:00.000Z',
            },
            proposedBy: 'human',
          },
          2,
          T0 + MINUTE,
        ),
      ]);

      const state = replayRun(db, RUN).state;
      expect(state.needsHuman).toBeNull();
      expect(state.churnWindow).toEqual([]);
      expect(state.replans).toEqual({ flat: 0, completed: 0, versions: [] });

      // And the next patch is judged on its merits again.
      const ruling = rulePatch(db, {
        runId: RUN,
        state,
        patch: ANALYSIS_PATCH,
        estimator: estimator(),
        now: T0 + 2 * MINUTE,
      });
      expect(ruling).toMatchObject({ decision: 'auto', ruleId: 'read-only-analysis' });
    } finally {
      db.close();
    }
  });

  it('leaves every refused patch approvable from the queue', async ({ tmp }) => {
    const dataDir = await seeded(tmp, 'queue');
    const db = openLedger(dataDir);
    try {
      rulePatch(db, {
        runId: RUN,
        state: replayRun(db, RUN).state,
        patch: ANALYSIS_PATCH,
        estimator: estimator(),
        now: T0 + MINUTE,
      });

      expect(pendingPatchApprovals(db, RUN)).toMatchObject([
        { patchId: ANALYSIS_PATCH.id, status: 'rejected', rule: 'circuit-breaker-tripped' },
      ]);
    } finally {
      db.close();
    }
  });
});
