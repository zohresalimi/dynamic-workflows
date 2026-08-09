/**
 * EPIC-11-S25 — `fact.invalidated` routes **through** the policy engine, not
 * around it (docs/08-context-and-memory.md §8.2, docs/04-domain-model.md §5.2).
 *
 * The rule is one sentence and it is the twin of S23's: *"do not auto-re-run
 * them. Flag them, surface them in the approval queue, and let the patch policy
 * engine decide. Automatic re-running on invalidation is a very efficient way
 * to build a loop that never terminates."* Both are cases where the reflexive
 * automated response is the one that burns the budget.
 *
 * The taint arithmetic itself — `event_seq < invalidation seq`, and a reader
 * that read *after* the invalidation is not tainted — is KAR-09.8's and is
 * covered against a real ledger in
 * `packages/ledger/test/integration/blackboard-invalidation.test.ts`. What is
 * asserted here is the half that belongs to this story: nothing re-schedules
 * itself, nothing proposes a patch on its own, and the patch that *does* propose
 * the re-run is ruled on by the same table as every other patch.
 *
 * Verifies: EPIC-11-S25 · KAR-11.4 AC1, AC2
 */
import {
  type Db,
  decide,
  type FactSchemaRegistry,
  type NodeId,
  NodeIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import {
  appendEvents,
  type EventDraft,
  invalidateFact,
  openLedger,
  pendingPatchApprovals,
  readRange,
  readTaintedNodes,
  replayRun,
  resolveDeclaredReads,
  writeFact,
} from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { rulePatch } from '../../src/budget/patch-gate.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';

const RUN: RunId = RunIdSchema.parse('run_20260808T150000Z_1122aa');
const T0 = 1_754_658_000_000;
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const KEY = 'finding/auth-uses-jwt';
const FACT_ID = `fact_${createHash('sha256').update(KEY).digest('hex').slice(0, 26)}`;

const ANALYSE = NodeIdSchema.parse('analyse');
const IMPL_A = NodeIdSchema.parse('impl-a');
const IMPL_B = NodeIdSchema.parse('impl-b');
const IMPL_C = NodeIdSchema.parse('impl-c');
const GATE = NodeIdSchema.parse('gate-security');

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

/** A registry double: it answers `has` and `validate` from a table, so this
 * spec says what is registered by data rather than by arranging calls. */
const REGISTRY: FactSchemaRegistry = {
  has: (schemaId: string) => schemaId === 'DeFlow.finding.v1',
  validate: () => [],
};

const FACT = {
  id: FACT_ID,
  key: KEY,
  kind: 'finding',
  schemaId: 'DeFlow.finding.v1',
  value: { claim: 'auth uses jwt' },
  provenance: {
    byNode: ANALYSE,
    byProvider: 'claude-code',
    byModel: 'claude-sonnet-4-5',
    fromEvidence: [`artifact://${'b'.repeat(64)}`],
    atEvent: 7,
    at: '2026-08-08T15:00:00.000Z',
    confidence: 'asserted' as const,
  },
};

const node = (id: string, deps: string[] = []): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  type: 'agent',
  deps,
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

/** The patch a human or a planner might propose in response to the taint: run
 * the two tainted analyses again, against the corrected premise. */
const RERUN_PATCH = {
  schemaId: 'DeFlow.planpatch.v1',
  id: 'patch-rerun-tainted',
  proposedBy: 'planner',
  reason: 'impl-a and impl-b were built on a finding gate-security has since invalidated',
  ops: [{ op: 'insert-nodes', nodes: [node('impl-a-2'), node('impl-b-2')], edges: [] }],
  policy: {
    estimatedCostDeltaUsd: 0.5,
    estimatedWallClockDeltaMs: 0,
    blastRadius: { paths: [], nodeCount: 2 },
    replanDepth: 1,
    escalatesPermission: null,
    addsWriteCapability: false,
  },
} as const;

const draft = (kind: string, payload: unknown, v = 1, over: Partial<EventDraft> = {}): EventDraft =>
  ({ runId: RUN, ts: T0, kind, v, epoch: 1, payload, ...over }) as EventDraft;

const ENV = { runId: RUN, ts: T0, epoch: 1 } as const;

const readFact = (db: Db, by: NodeId): void => {
  const resolved = resolveDeclaredReads(db, { ...ENV, by, reads: [{ kind: 'fact', key: KEY }] });
  if (resolved.length !== 1) throw new Error(`${by} resolved ${resolved.length} facts`);
};

/**
 * The scenario's background: `analyse` wrote the finding, `impl-a` and `impl-b`
 * read it, `gate-security` invalidated it, and only *then* did `impl-c` read it.
 *
 * The order is what a real ledger assigned rather than what a fixture asserts,
 * which is the point of doing this against SQLite at all.
 */
function seed(db: Db): void {
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
          createdAt: '2026-08-08T15:00:00.000Z',
          nodes: [node('analyse'), node('impl-a'), node('impl-b'), node('impl-c')],
          edges: [],
        },
        by: 'planner',
      },
      2,
    ),
    draft('run.started', { planHash: PLAN_HASH }),
  ]);

  const written = writeFact(db, REGISTRY, FACT, ENV);
  if (!written.ok) throw new Error('the fixture fact was refused');

  readFact(db, IMPL_A);
  readFact(db, IMPL_B);
  // Both readers finished their attempt before the invalidation.
  for (const id of [IMPL_A, IMPL_B]) {
    appendEvents(db, [
      draft('node.completed', {
        node: id,
        attempt: 0,
        result: {
          status: 'completed',
          output: { summary: `${id} done` },
          outputSchemaId: 'DeFlow.finding.v1',
          usage: { inputTokens: 100, outputTokens: 50, source: 'vendor-reported' },
          costUsd: 0.01,
          producedFacts: [],
          artifacts: [],
        },
      }),
    ]);
  }

  invalidateFact(db, {
    ...ENV,
    factId: FACT_ID,
    by: GATE,
    reason: 'the token is opaque, not a jwt — the whole auth analysis rests on a wrong premise',
  });

  readFact(db, IMPL_C);
}

const estimator = () => ({
  tokenizer: o200kTokenizer(),
  accounting: () => 'exact' as const,
  family: () => 'anthropic',
  calibration: () => ({ n: 24, ratio: 1.18 }),
  countFiles: () => 0,
});

suite('an invalidated fact flags its earlier readers and re-runs nothing', () => {
  it('taints only the readers that came before it, and surfaces them for a human', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seed(db);

      const tainted = readTaintedNodes(db, RUN);
      expect(tainted.map((item) => item.node).toSorted()).toEqual([IMPL_A, IMPL_B]);
      // The approval queue's `tainted` items carry what a human needs to judge
      // them: which fact, why it was invalidated, and where.
      expect(tainted[0]).toMatchObject({ kind: 'tainted', taint: 'stale-input', key: KEY });
      expect(tainted[0]?.reason).toContain('opaque');

      // `impl-c` read the fact after the invalidation and is not tainted: the
      // fact is stale, not deleted, and a later reader saw it knowing that.
      expect(tainted.map((item) => item.node)).not.toContain(IMPL_C);
    } finally {
      db.close();
    }
  });

  it('re-schedules nothing on its own and proposes no patch of its own', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seed(db);

      const state = replayRun(db, RUN).state;
      const started = decide(state, T0 + 60_000)
        .filter((command) => command.kind === 'StartNode')
        .map((command) => command.node);

      // The two tainted nodes have completed, and an invalidation does not undo
      // a completion. Nothing puts them back on the ready set.
      expect(started).not.toContain(IMPL_A);
      expect(started).not.toContain(IMPL_B);

      const events = readRange(db, RUN, 0, 1000).events;
      expect(events.filter((event) => event.kind === 'plan.patch.proposed')).toHaveLength(0);
      expect(events.filter((event) => event.kind === 'plan.patched')).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('rules on a patch that proposes the re-run like any other patch', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seed(db);
      appendEvents(db, [
        draft('plan.patch.proposed', { patch: RERUN_PATCH, basePlanHash: PLAN_HASH }, 3),
      ]);

      const ruling = rulePatch(db, {
        runId: RUN,
        state: replayRun(db, RUN).state,
        patch: RERUN_PATCH,
        estimator: estimator(),
        now: T0 + 60_000,
      });

      // Cheap, read-only, shallow, in budget: the ordinary table auto-applies
      // it. The claim is not *which* rule fired — it is that a rule fired at
      // all, by name, rather than the invalidation re-running anything itself.
      expect(ruling).toMatchObject({ decision: 'auto', ruleId: 'read-only-analysis' });
      expect(pendingPatchApprovals(db, RUN)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('queues rather than applies the same re-run when it escalates permission', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seed(db);
      const escalating = {
        ...RERUN_PATCH,
        id: 'patch-rerun-write',
        ops: [
          {
            op: 'insert-nodes',
            nodes: [
              { ...node('impl-a-3'), permission: 'worktree', pathScopes: { write: ['src/**'] } },
            ],
            edges: [],
          },
        ],
        policy: {
          ...RERUN_PATCH.policy,
          escalatesPermission: { from: 'read', to: 'worktree' },
          addsWriteCapability: true,
        },
      };
      appendEvents(db, [
        draft('plan.patch.proposed', { patch: escalating, basePlanHash: PLAN_HASH }, 3),
      ]);

      const ruling = rulePatch(db, {
        runId: RUN,
        state: replayRun(db, RUN).state,
        patch: escalating,
        estimator: estimator(),
        now: T0 + 60_000,
      });

      expect(ruling).toMatchObject({ decision: 'approve', ruleId: 'escalates-permission' });
      expect(pendingPatchApprovals(db, RUN)).toMatchObject([
        { patchId: 'patch-rerun-write', status: 'queued', rule: 'escalates-permission' },
      ]);
    } finally {
      db.close();
    }
  });
});
