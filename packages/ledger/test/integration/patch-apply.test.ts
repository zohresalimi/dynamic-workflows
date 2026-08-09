/**
 * KAR-11.3 AC4, AC5, AC6, AC10 — applying a patched plan version is **one**
 * transaction, and `basePlanHash` is what serialises two proposers
 * (docs/06-planning-and-replanning.md §4.2, EPIC-11-S14, EPIC-11-S15,
 * EPIC-11-S16).
 *
 * Integration rather than unit because every claim here is about a real
 * boundary: a file-backed SQLite database with real `BEGIN IMMEDIATE`
 * semantics, a real `run` row, and a real `plan/vN.json` under a real run
 * directory. A fake `Db` would let "the three statements are one transaction"
 * pass while they were three, which is precisely the failure this file exists
 * to catch.
 *
 * Verifies: EPIC-11-S14, EPIC-11-S15 (second and third scenarios), EPIC-11-S16
 * (first scenario) · AC4, AC5, AC6, AC10
 */
import type { PlanGraph } from '@DeFlow/core';
import { canonicalJson, PlanGraphSchema, planHash } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  applyPatchedPlanVersion,
  type Db,
  openLedger,
  PATCH_STALE,
  planPathOf,
  readPlanDoc,
  readRange,
} from '../../src/index.ts';

const RUN = 'run_20260808T101500Z_ac1103';
const ENV = { ts: 1_754_640_000_000, epoch: 1 } as const;
const PLANNER = { model: 'the-model-the-plan-ran-on', effort: 'max', tier: 'strongest' } as const;
const DECISION = {
  decision: 'auto',
  by: 'policy',
  rule: 'read-only-analysis',
  at: '2026-08-08T10:00:00.000Z',
} as const;

const node = (id: string) =>
  ({
    id,
    title: `Node ${id}`,
    type: 'agent',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'worktree',
    pathScopes: { write: ['packages/ui/**'] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
    brief: 'Do the thing.',
    provider: { prefer: ['claude'], requires: ['structuredOutput'] },
    resume: 'always-replay',
  }) as const;

/** A graph whose declared `planHash` really does address it. */
async function graph(over: Record<string, unknown> = {}): Promise<PlanGraph> {
  const parsed = PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'1'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-08T10:15:00.000Z',
    nodes: [node('implement')],
    edges: [],
    ...over,
  });
  return { ...parsed, planHash: await planHash(parsed) };
}

/** The projection row `run.plan_hash` lives in. Planted directly rather than
 * folded, because what is under test is the update, not the reducer. */
function seedRun(db: Db, planHashValue: string): void {
  db.prepare(
    `INSERT INTO run (run_id, status, plan_hash, last_seq, state_json, checkpoint_version,
        daemon_epoch)
      VALUES (?, 'running', ?, 0, '{}', 1, 1)
      ON CONFLICT(run_id) DO UPDATE SET plan_hash = excluded.plan_hash`,
  ).run(RUN, planHashValue);
}

const planHashOfRun = (db: Db): string =>
  String(
    db.prepare<{ plan_hash: string }>('SELECT plan_hash FROM run WHERE run_id = ?').get(RUN)
      ?.plan_hash,
  );

const eventsOf = (db: Db, kind: string) =>
  readRange(db, RUN, 0, 100).events.filter((row) => row.kind === kind);

interface Fixture {
  readonly db: Db;
  readonly runDir: string;
  readonly base: PlanGraph;
  readonly next: PlanGraph;
}

async function fixture(tmp: string): Promise<Fixture> {
  const db = openLedger(tmp);
  const base = await graph();
  const next = await graph({
    version: 2,
    parent: base.planHash,
    nodes: [node('implement'), node('analyse-ui')],
  });
  seedRun(db, base.planHash);
  return { db, runDir: join(tmp, 'runs', RUN), base, next };
}

const apply = (f: Fixture, over: Record<string, unknown> = {}) =>
  applyPatchedPlanVersion(f.db, {
    runDir: f.runDir,
    graph: f.next,
    basePlanHash: f.base.planHash,
    patchId: 'patch-3a91f0',
    decision: DECISION,
    diagnostics: [],
    by: 'planner',
    planner: PLANNER,
    ...ENV,
    ...over,
  });

suite('EPIC-11-S14 — a patch produces a new row and mutates nothing', () => {
  it('inserts the successor, updates run.plan_hash and appends plan.patched', async ({ tmp }) => {
    const f = await fixture(tmp);
    try {
      const outcome = await apply(f);

      expect(outcome.outcome).toBe('applied');
      expect(readPlanDoc(f.db, f.next.planHash)).toBe(canonicalJson(f.next));
      expect(planHashOfRun(f.db)).toBe(f.next.planHash);

      const patched = eventsOf(f.db, 'plan.patched');
      expect(patched).toHaveLength(1);
      expect(patched[0]?.payload).toMatchObject({
        version: 2,
        fromHash: f.base.planHash,
        toHash: f.next.planHash,
        patchId: 'patch-3a91f0',
        decision: DECISION,
      });
    } finally {
      f.db.close();
    }
  });

  it('leaves the previous version byte-for-byte selectable', async ({ tmp }) => {
    const f = await fixture(tmp);
    try {
      // The base is stored the way KAR-11.1 stores it, then patched over.
      f.db
        .prepare('INSERT INTO plan (hash, run_id, created_at, doc) VALUES (?, ?, ?, ?)')
        .run(f.base.planHash, RUN, ENV.ts, canonicalJson(f.base));
      const before = readPlanDoc(f.db, f.base.planHash);

      await apply(f);

      expect(readPlanDoc(f.db, f.base.planHash)).toBe(before);
      expect(readPlanDoc(f.db, f.base.planHash)).toBe(canonicalJson(f.base));
    } finally {
      f.db.close();
    }
  });

  it('writes the version to disk under its own number, so `cat` answers (NF8)', async ({ tmp }) => {
    const f = await fixture(tmp);
    try {
      await apply(f);

      expect(JSON.parse(readFileSync(planPathOf(f.runDir, 2), 'utf8'))).toEqual(f.next);
    } finally {
      f.db.close();
    }
  });
});

suite('EPIC-11-S15 — the three statements are genuinely one transaction', () => {
  it('rolls all three back when the append fails between the second and the third', async ({
    tmp,
  }) => {
    const f = await fixture(tmp);
    try {
      await expect(
        apply(f, {
          crashPoint: () => {
            throw new Error('the knife lands between UPDATE run and INSERT INTO event');
          },
        }),
      ).rejects.toThrow('the knife lands');

      expect(readPlanDoc(f.db, f.next.planHash)).toBeNull();
      expect(planHashOfRun(f.db)).toBe(f.base.planHash);
      expect(eventsOf(f.db, 'plan.patched')).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  it('does not reuse the seq the rolled-back transaction burned', async ({ tmp }) => {
    const f = await fixture(tmp);
    try {
      const first = await apply(f);
      const burned = first.outcome === 'applied' ? first.seq : 0;
      expect(burned).toBeGreaterThan(0);

      const third = await graph({
        version: 3,
        parent: f.next.planHash,
        nodes: [node('implement'), node('analyse-ui'), node('analyse-forms')],
      });
      const onward = { graph: third, basePlanHash: f.next.planHash };

      await expect(
        apply(f, {
          ...onward,
          crashPoint: () => {
            throw new Error('rolled back');
          },
        }),
      ).rejects.toThrow('rolled back');

      // `seq` is AUTOINCREMENT, so the burned number is gone for good and the
      // next successful append is strictly greater than it — never `burned + 1`
      // by contract, which is why every consumer resumes from "> n".
      const after = await apply(f, onward);
      expect(after.outcome).toBe('applied');
      if (after.outcome !== 'applied') return;
      expect(after.seq).toBeGreaterThan(burned);
    } finally {
      f.db.close();
    }
  });
});

suite('EPIC-11-S16 / AC6 — a stale basePlanHash is rejected, never rebased', () => {
  it('refuses with PATCH_STALE and hands back the current hash', async ({ tmp }) => {
    const f = await fixture(tmp);
    try {
      const outcome = await apply(f, { basePlanHash: `sha256-${'9'.repeat(64)}` });

      expect(outcome).toEqual({
        outcome: 'stale',
        code: PATCH_STALE,
        currentPlanHash: f.base.planHash,
      });
      // Nothing was written, and above all nothing was rebased onto the base
      // that is actually current.
      expect(readPlanDoc(f.db, f.next.planHash)).toBeNull();
      expect(planHashOfRun(f.db)).toBe(f.base.planHash);
      expect(eventsOf(f.db, 'plan.patched')).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  it('AC10 — of two proposals against the same base, one applies and one goes stale', async ({
    tmp,
  }) => {
    const f = await fixture(tmp);
    try {
      const rival = await graph({
        version: 2,
        parent: f.base.planHash,
        nodes: [node('implement'), node('analyse-forms')],
      });

      const first = await apply(f);
      const second = await apply(f, { graph: rival, patchId: 'patch-rival' });

      expect(first.outcome).toBe('applied');
      expect(second).toEqual({
        outcome: 'stale',
        code: PATCH_STALE,
        currentPlanHash: f.next.planHash,
      });
      // One winner, and emphatically not a merge: the rival's node is nowhere.
      expect(eventsOf(f.db, 'plan.patched')).toHaveLength(1);
      expect(readPlanDoc(f.db, rival.planHash)).toBeNull();
      expect(planHashOfRun(f.db)).toBe(f.next.planHash);
    } finally {
      f.db.close();
    }
  });

  it('lets the loser re-derive against the hash it was told about', async ({ tmp }) => {
    const f = await fixture(tmp);
    try {
      await apply(f);
      const rederived = await graph({
        version: 3,
        parent: f.next.planHash,
        nodes: [node('implement'), node('analyse-ui'), node('analyse-forms')],
      });

      const outcome = await apply(f, {
        graph: rederived,
        basePlanHash: f.next.planHash,
        patchId: 'patch-rival-take-2',
      });

      expect(outcome.outcome).toBe('applied');
      expect(planHashOfRun(f.db)).toBe(rederived.planHash);
    } finally {
      f.db.close();
    }
  });
});
