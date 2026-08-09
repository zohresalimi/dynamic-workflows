/**
 * EPIC-11-S20, EPIC-11-S21 — the two decisions the policy engine cannot make
 * alone: queueing a patch for a human, and refusing one
 * (docs/06-planning-and-replanning.md §4.3).
 *
 * Integration rather than unit, and for a reason each scenario states in its
 * own words. S20's claim is an **absence** — *"the run does not stall on it if
 * other branches are runnable; the patch is pending, not the run"* — and an
 * absence in the scheduler can only be asserted against a state folded from a
 * real ledger, because that is `decide()`'s only input. S21's claim is that the
 * refusal is *on the log*: a rejected patch that left no event is the state
 * NF10 forbids, and *"the run silently decided not to do the thing it decided
 * to do"* is unanswerable afterwards.
 *
 * Verifies: EPIC-11-S20, EPIC-11-S21 · KAR-11.4 AC2, AC5, AC6 · test plan #8, #9
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

const RUN: RunId = RunIdSchema.parse('run_20260808T101500Z_b4c2d1');
const T0 = 1_754_640_000_000;
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

const node = (
  id: string,
  over: { permission?: string; writes?: string[]; deps?: string[] } = {},
): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  type: 'agent',
  deps: over.deps ?? [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: over.permission ?? 'read',
  pathScopes: { write: over.writes ?? [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `brief for ${id}`,
  provider: { prefer: ['claude'], requires: [] },
  model: 'claude-sonnet-4-5',
  resume: 'always-replay',
});

const draft = (kind: string, payload: unknown, v = 1): EventDraft =>
  ({ runId: RUN, ts: T0, kind, v, epoch: 1, payload }) as EventDraft;

/**
 * EPIC-11-S20's patch: *"an adversarial review demands a codemod"*. One `agent`
 * write node at `worktree` permission over `packages/ui/**` plus a follow-up
 * gate, on a run whose ambient permission is `read`.
 */
const CODEMOD_PATCH = {
  schemaId: 'DeFlow.planpatch.v1',
  id: 'patch-codemod',
  proposedBy: 'n-review',
  reason: 'the v2 API migration needs a codemod across the design-system package',
  ops: [
    {
      op: 'insert-nodes',
      nodes: [
        node('n-codemod', { permission: 'worktree', writes: ['packages/ui/**'] }),
        node('n-codemod-gate', { deps: ['n-codemod'] }),
      ],
      edges: [],
    },
  ],
  policy: {
    estimatedCostDeltaUsd: 6.2,
    estimatedWallClockDeltaMs: 900_000,
    blastRadius: { paths: ['packages/ui/**'], nodeCount: 2 },
    replanDepth: 2,
    escalatesPermission: { from: 'read', to: 'worktree' },
    addsWriteCapability: true,
  },
} as const;

/** EPIC-11-S21's patch: the fourth replan of a bug hunt that has already
 * replanned three times. */
const FOURTH_REPLAN_PATCH = {
  ...CODEMOD_PATCH,
  id: 'patch-hunt-4',
  proposedBy: 'n-hunt',
  reason: 'two more hypotheses: the cache layer and the router guard',
  ops: [
    {
      op: 'insert-nodes',
      nodes: [node('n-hypothesis-4'), node('n-hypothesis-5')],
      edges: [],
    },
  ],
  policy: {
    estimatedCostDeltaUsd: 1.1,
    estimatedWallClockDeltaMs: 0,
    blastRadius: { paths: [], nodeCount: 2 },
    replanDepth: 4,
    escalatesPermission: null,
    addsWriteCapability: false,
  },
} as const;

/**
 * A running, `read`-permission run with three independent branches and a
 * proposal on the log.
 *
 * `planVersion` is how a run *has already replanned three times*: the replan
 * depth the rule table predicates on is the distance from v1, read off the run's
 * own lineage rather than off the proposer's claim about itself. A patch that
 * could declare its own depth could declare it `1` for ever.
 */
function seed(dataDir: string, patch: unknown, planVersion = 1): void {
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
          version: planVersion,
          planHash: PLAN_HASH,
          graph: {
            schemaId: 'DeFlow.plangraph.v1',
            runId: RUN,
            version: planVersion,
            planHash: PLAN_HASH,
            parent: planVersion === 1 ? null : `sha256-${'9'.repeat(64)}`,
            taskSpecHash: SPEC_HASH,
            createdBy: 'planner',
            createdAt: '2026-08-08T10:15:00.000Z',
            nodes: [node('n-recon'), node('n-analyse'), node('n-review')],
            edges: [],
          },
          by: 'planner',
        },
        2,
      ),
      draft('run.started', { planHash: PLAN_HASH }),
      draft('plan.patch.proposed', { patch, basePlanHash: PLAN_HASH }, 3),
    ]);
  } finally {
    db.close();
  }
}

async function seeded(
  tmp: string,
  patch: unknown,
  name = 'data',
  planVersion = 1,
): Promise<string> {
  const dataDir = join(tmp, name);
  await mkdir(dataDir, { recursive: true });
  seed(dataDir, patch, planVersion);
  return dataDir;
}

const estimator = () => ({
  tokenizer: o200kTokenizer(),
  accounting: () => 'exact' as const,
  family: () => 'anthropic',
  calibration: () => ({ n: 24, ratio: 1.18 }),
  // The blast radius is a plan-time prediction expanded against the worktree —
  // 140 files under `packages/ui/**`, as the worked example states it. Injected
  // rather than measured here: the point of this test is the decision, and a
  // real glob expansion would make it a test of the filesystem.
  countFiles: (paths: readonly string[]) => (paths.length === 0 ? 0 : 140),
});

suite('EPIC-11-S20 — the patch adds write capability, so it is queued', () => {
  it('matches escalates-permission first and records the queue entry', async ({ tmp }) => {
    const dataDir = await seeded(tmp, CODEMOD_PATCH);
    const db = openLedger(dataDir);
    try {
      const ruling = rulePatch(db, {
        runId: RUN,
        state: replayRun(db, RUN).state,
        patch: CODEMOD_PATCH,
        estimator: estimator(),
        now: T0 + 60_000,
      });

      // The ruleId, not merely the decision: `expensive` (6.20 > 5.00) and
      // `wide-blast-radius` (140 > 25) would both have produced `approve`, and
      // asserting the decision alone cannot tell an ordered table from a set.
      expect(ruling).toMatchObject({ decision: 'approve', ruleId: 'escalates-permission' });
      expect(ruling.estimate.blastRadiusFiles).toBe(140);
    } finally {
      db.close();
    }

    const after = openLedger(dataDir);
    try {
      const events = readRange(after, RUN, 0, 1000).events;
      const queued = events.filter((event) => event.kind === 'plan.patch.queued');
      expect(queued).toHaveLength(1);
      expect(queued[0]?.payload).toMatchObject({
        patchId: 'patch-codemod',
        rule: 'escalates-permission',
      });

      // AC5 — the entry carries the estimate, the ops that make up the plan
      // diff, and the reason that motivated it.
      const [item] = pendingPatchApprovals(after, RUN);
      expect(item).toMatchObject({
        patchId: 'patch-codemod',
        status: 'queued',
        rule: 'escalates-permission',
        basePlanHash: PLAN_HASH,
      });
      expect(item?.estimate).toMatchObject({
        costUsdDelta: expect.any(Number),
        blastRadiusFiles: 140,
        maxPermission: 'worktree',
      });
      expect(item?.patch.reason).toBe(
        'the v2 API migration needs a codemod across the design-system package',
      );
      expect(item?.patch.ops).toHaveLength(1);
    } finally {
      after.close();
    }
  });

  it('leaves the patch pending rather than the run: other branches still schedule', async ({
    tmp,
  }) => {
    const dataDir = await seeded(tmp, CODEMOD_PATCH, 'pending');
    const db = openLedger(dataDir);
    try {
      rulePatch(db, {
        runId: RUN,
        state: replayRun(db, RUN).state,
        patch: CODEMOD_PATCH,
        estimator: estimator(),
        now: T0 + 60_000,
      });

      const state = replayRun(db, RUN).state;
      expect(state.status).toBe('running');
      expect(state.needsHuman).toBeNull();

      // The unrelated branches are still admissible — the whole of "the patch
      // is pending, not the run".
      const scheduled = decide(state, T0 + 60_000)
        .filter((command) => command.kind === 'StartNode')
        .map((command) => command.node);
      expect(scheduled).toContain('n-analyse');

      // And nothing was provisioned for the write node the patch proposes: it
      // is not in any plan version yet, so there is nothing to give a worktree
      // to.
      const events = readRange(db, RUN, 0, 1000).events;
      expect(events.filter((event) => event.kind === 'workspace.worktree_created')).toHaveLength(0);
      expect(events.filter((event) => event.kind === 'plan.patched')).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-11-S21 — the fourth replan is refused, and the refusal is not a dead end', () => {
  it('rejects on replan-depth-exceeded and asks for a human', async ({ tmp }) => {
    const dataDir = await seeded(tmp, FOURTH_REPLAN_PATCH, 'reject', 4);
    const db = openLedger(dataDir);
    try {
      const ruling = rulePatch(db, {
        runId: RUN,
        state: replayRun(db, RUN).state,
        patch: FOURTH_REPLAN_PATCH,
        estimator: estimator(),
        now: T0 + 60_000,
      });
      expect(ruling).toMatchObject({ decision: 'reject', ruleId: 'replan-depth-exceeded' });

      const events = readRange(db, RUN, 0, 1000).events;
      const rejected = events.filter((event) => event.kind === 'plan.patch.rejected');
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.payload).toMatchObject({
        patchId: 'patch-hunt-4',
        rule: 'replan-depth-exceeded',
        by: 'policy',
      });

      const asked = events.filter((event) => event.kind === 'run.needs_human');
      expect(asked).toHaveLength(1);
      expect(asked[0]?.payload).toMatchObject({ reason: 'patch-rejected' });
      expect(String((asked[0]?.payload as { detail: string }).detail)).toContain(
        'replan-depth-exceeded',
      );

      const state = replayRun(db, RUN).state;
      expect(state.status).toBe('needs-human');

      // "A rejection is a 'not without you', not a dead end": the patch is
      // still in the queue, with the rule that refused it, so a human can
      // approve it explicitly.
      const [item] = pendingPatchApprovals(db, RUN);
      expect(item).toMatchObject({
        patchId: 'patch-hunt-4',
        status: 'rejected',
        rule: 'replan-depth-exceeded',
      });
      expect(item?.patch.reason).toBe('two more hypotheses: the cache layer and the router guard');
    } finally {
      db.close();
    }
  });

  it('asks once: a run already waiting on a human is not asked again', async ({ tmp }) => {
    const dataDir = await seeded(tmp, FOURTH_REPLAN_PATCH, 'once', 4);
    const db = openLedger(dataDir);
    try {
      const first = replayRun(db, RUN).state;
      rulePatch(db, {
        runId: RUN,
        state: first,
        patch: FOURTH_REPLAN_PATCH,
        estimator: estimator(),
        now: T0 + 60_000,
      });
      rulePatch(db, {
        runId: RUN,
        state: replayRun(db, RUN).state,
        patch: FOURTH_REPLAN_PATCH,
        estimator: estimator(),
        now: T0 + 120_000,
      });

      const events = readRange(db, RUN, 0, 1000).events;
      // Both refusals are recorded — no patch is dropped without an event —
      // but the run asks for a human once.
      expect(events.filter((event) => event.kind === 'plan.patch.rejected')).toHaveLength(2);
      expect(events.filter((event) => event.kind === 'run.needs_human')).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('drops nothing silently: an applied patch leaves the queue empty', async ({ tmp }) => {
    const dataDir = await seeded(tmp, CODEMOD_PATCH, 'applied');
    const db = openLedger(dataDir);
    try {
      appendEvents(db, [
        draft(
          'plan.patched',
          {
            version: 2,
            fromHash: PLAN_HASH,
            toHash: `sha256-${'b'.repeat(64)}`,
            patchId: 'patch-codemod',
            decision: {
              decision: 'approved',
              by: 'human',
              rule: 'escalates-permission',
              at: '2026-08-08T10:20:00.000Z',
            },
            proposedBy: 'human',
          },
          2,
        ),
      ]);

      expect(pendingPatchApprovals(db, RUN)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
