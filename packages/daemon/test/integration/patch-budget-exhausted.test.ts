/**
 * EPIC-14-S17 — a run that has spent its budget does not get to spend more by
 * replanning (KAR-14.3 AC6).
 *
 * Integration rather than unit, because the claim is about a *state the ledger
 * reduces to*: the fraction is computed from KAR-14.1's rollup against
 * KAR-14.2's ceiling, and both of those are folds over real events. A
 * hand-assembled state would let the gate agree with a run the reducer cannot
 * produce, which is the one thing this check must not do — it is the mechanism
 * that stands between a paused run and it quietly spending more.
 *
 * **One deviation from the scenario's wording, stated out loud.** The scenario
 * says the rejection is appended as `plan.patched { decision: 'rejected',
 * ruleId }`. The shipped ledger vocabulary (KAR-02.4, `event-payloads.ts`) has a
 * dedicated `plan.patch.rejected { patchId, rule, by }` kind, and `plan.patched`
 * requires the `fromHash`/`toHash` of a plan that was actually written. A
 * rejection writes no plan, so recording it as `plan.patched` would mean
 * inventing a `toHash` for a document that does not exist. The observable claim
 * — a rejection on the log, naming the rule that fired, with the proposal still
 * addressable — is what is asserted here.
 *
 * Verifies: EPIC-14-S17 · KAR-14.3 AC5, AC6 · test plan #5
 */
import { type RunId, RunIdSchema } from '@DeFlow/core';
import { appendEvents, type EventDraft, openLedger, readRange, replayRun } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { rulePatch } from '../../src/budget/patch-gate.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';

const RUN: RunId = RunIdSchema.parse('run_20260807T113000Z_c41d90');
const T0 = 1_754_566_000_000;
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const CEILING_HASH = `sha256-${'e'.repeat(64)}`;

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

const node = (id: string, permission = 'read'): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission,
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `brief for ${id}`,
  provider: { prefer: ['claude'], requires: [] },
  model: 'claude-sonnet-4-5',
  resume: 'always-replay',
});

const draft = (kind: string, payload: unknown, v = 1): EventDraft => ({
  runId: RUN,
  ts: T0,
  kind,
  v,
  epoch: 1,
  payload,
});

const PATCH = {
  schemaId: 'DeFlow.planpatch.v1',
  id: 'patch-7',
  proposedBy: 'n-impl',
  reason: 'the migration needs two more analysis passes',
  ops: [{ op: 'insert-nodes', nodes: [node('n-more-1'), node('n-more-2')], edges: [] }],
  policy: {
    estimatedCostDeltaUsd: 0.3,
    estimatedWallClockDeltaMs: 0,
    blastRadius: { paths: [], nodeCount: 2 },
    replanDepth: 1,
    escalatesPermission: null,
    addsWriteCapability: false,
  },
} as const;

/**
 * A run at 25.40 against a 25.00 ceiling: the ceiling tripped, the run paused
 * for a human, and a node proposed a patch anyway.
 */
function seed(dataDir: string): void {
  const db = openLedger(dataDir);
  try {
    appendEvents(db, [
      draft('run.created', {
        spec: taskSpec,
        cwd: '/home/u/proj',
        repo: { head: 'e83c516', branch: 'main' },
      }),
      draft('budget.ceiling.set', {
        scope: 'run',
        costUsd: 25,
        wallclockMs: null,
        source: 'request',
        hash: CEILING_HASH,
      }),
      draft('plan.proposed', {
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
          createdAt: '2026-08-07T11:30:00.000Z',
          nodes: [node('n-impl'), node('n-review')],
          edges: [],
        },
        by: 'planner',
      }),
      draft('run.started', { planHash: PLAN_HASH }),
      draft(
        'budget.consumed',
        {
          node: 'n-impl',
          attempt: 0,
          provider: 'claude',
          usage: { inputTokens: 900_000, outputTokens: 40_000, source: 'vendor-reported' },
          costUsd: 25.4,
          authMode: 'subscription',
        },
        2,
      ),
      draft(
        'budget.exceeded',
        {
          scope: 'run',
          dimension: 'cost',
          limit: 25,
          actual: 25.4,
          failureClass: 'gate',
          firedBy: 'deflow',
        },
        2,
      ),
      draft('run.paused', { by: 'policy', reason: 'budget' }),
      draft('plan.patch.proposed', { patch: PATCH }),
    ]);
  } finally {
    db.close();
  }
}

async function seeded(tmp: string): Promise<string> {
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  seed(dataDir);
  return dataDir;
}

const estimator = () => ({
  tokenizer: o200kTokenizer(),
  accounting: () => 'exact' as const,
  family: () => 'anthropic',
  calibration: () => ({ n: 24, ratio: 1.18 }),
});

suite('a patch proposed after the ceiling was reached', () => {
  it('is rejected by the budget-exhausted rule and says so on the ledger', async ({ tmp }) => {
    const dataDir = await seeded(tmp);
    const db = openLedger(dataDir);
    try {
      const ruling = rulePatch(db, {
        runId: RUN,
        state: replayRun(db, RUN).state,
        patch: PATCH,
        estimator: estimator(),
        now: T0 + 60_000,
      });

      expect(ruling.elapsedBudgetFraction).toBeCloseTo(25.4 / 25, 6);
      expect(ruling.decision).toBe('reject');
      expect(ruling.ruleId).toBe('budget-exhausted');
    } finally {
      db.close();
    }

    const after = openLedger(dataDir);
    try {
      const events = readRange(after, RUN, 0, 1000).events;
      const rejected = events.filter((event) => event.kind === 'plan.patch.rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.payload).toEqual({
        patchId: 'patch-7',
        rule: 'budget-exhausted',
        by: 'policy',
      });

      // A rejection is a "not without you", not a dead end: the proposal is
      // still on the log, addressable, and approvable by a human later.
      expect(events.filter((event) => event.kind === 'plan.patch.proposed')).toHaveLength(1);

      // …and the run is paused, exactly as it was. Rejecting a patch does not
      // abort the run that proposed it.
      expect(replayRun(after, RUN).state.status).toBe('paused');
    } finally {
      after.close();
    }
  });

  it('takes the greater of the two dimensions rather than their mean', async ({ tmp }) => {
    const dataDir = await seeded(tmp);
    const db = openLedger(dataDir);
    try {
      // The cost fraction is 1.016 and the wall-clock ceiling is unset, so the
      // answer is the cost fraction — an averaged pair would be 0.508 and would
      // let the patch through.
      const ruling = rulePatch(db, {
        runId: RUN,
        state: replayRun(db, RUN).state,
        patch: PATCH,
        estimator: estimator(),
        now: T0 + 60_000,
      });
      expect(ruling.elapsedBudgetFraction).toBeGreaterThan(1);
    } finally {
      db.close();
    }
  });

  it('records nothing and auto-applies a cheap read-only patch when the budget is intact', async ({
    tmp,
  }) => {
    const dataDir = join(tmp, 'ok');
    await mkdir(dataDir, { recursive: true });
    const db = openLedger(dataDir);
    try {
      appendEvents(db, [
        draft('run.created', {
          spec: taskSpec,
          cwd: '/home/u/proj',
          repo: { head: 'e83c516', branch: 'main' },
        }),
        draft('budget.ceiling.set', {
          scope: 'run',
          costUsd: 25,
          wallclockMs: null,
          source: 'request',
          hash: CEILING_HASH,
        }),
        draft('plan.proposed', {
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
            createdAt: '2026-08-07T11:30:00.000Z',
            nodes: [node('n-impl')],
            edges: [],
          },
          by: 'planner',
        }),
        draft('run.started', { planHash: PLAN_HASH }),
        draft('plan.patch.proposed', { patch: PATCH }),
      ]);

      const ruling = rulePatch(db, {
        runId: RUN,
        state: replayRun(db, RUN).state,
        patch: PATCH,
        estimator: estimator(),
        now: T0 + 60_000,
      });

      expect(ruling).toMatchObject({ decision: 'auto', ruleId: 'read-only-analysis' });
      expect(
        readRange(db, RUN, 0, 1000).events.filter((event) => event.kind === 'plan.patch.rejected'),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});
