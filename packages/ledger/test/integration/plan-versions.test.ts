/**
 * KAR-11.1 AC5 — the plan row, the file on disk and `plan.proposed`, or none of
 * the three (EPIC-11-S1, second scenario).
 *
 * Integration rather than unit because every claim is about a real boundary: a
 * file-backed SQLite database with real transaction semantics, and a real
 * `plan/v1.json` under a real run directory. A fake db would let the "same
 * transaction" clause pass while the two writes were independent — which is
 * exactly the failure the test plan names ("the three writes are not one
 * transaction").
 *
 * The failure direction is the one worth spending a test on. A `plan` row
 * without its event is a plan nobody can explain the provenance of; an event
 * without its row is a `run.plan_hash` pointing at a document that does not
 * exist. Both are unrecoverable by replay, because the ledger is append-only.
 *
 * Verifies: EPIC-11-S1 (second and third scenarios) · AC4, AC5, AC6
 */
import type { PlanGraph } from '@DeFlow/core';
import { canonicalJson, PlanGraphSchema, planHash } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  openLedger,
  PlanHashMismatch,
  PlanNotValidated,
  persistPlanVersion,
  planPathOf,
  readPlanDoc,
  readRange,
} from '../../src/index.ts';

const RUN = 'run_20260807T101500Z_ac1101';
const ENV = { ts: 1_754_380_800_000, epoch: 1 } as const;
const PLANNER = { model: 'the-model-the-plan-ran-on', effort: 'max', tier: 'strongest' } as const;

const NODE = {
  id: 'implement',
  title: 'Implement the migration',
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [{ kind: 'spec', section: 'goal' }],
  writes: [],
  permission: 'worktree',
  pathScopes: { write: ['packages/ui/**'] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  brief: 'Migrate the components named in the spec.',
  provider: { prefer: ['claude'], requires: ['structuredOutput'] },
  resume: 'always-replay',
} as const;

/** A graph whose declared `planHash` really does address it. */
async function graph(over: Record<string, unknown> = {}): Promise<PlanGraph> {
  const draft = {
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'1'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-07T10:15:00.000Z',
    nodes: [NODE],
    edges: [],
    ...over,
  };
  // Parsed *first*, because the schema fills in `retry`, `budget` and
  // `returns.maxTokens`: hashing the draft would address a document nobody
  // stores. The content address is of what is persisted.
  const parsed = PlanGraphSchema.parse(draft);
  return { ...parsed, planHash: await planHash(parsed) };
}

const openAt = (tmp: string) => openLedger(tmp);

suite('AC5 — one plan version lands in three places or in none', () => {
  it('writes the row, the file and the event, all agreeing on the hash', async ({ tmp }) => {
    const db = openAt(tmp);
    const runDir = join(tmp, 'runs', RUN);
    try {
      const plan = await graph();
      const persisted = await persistPlanVersion(db, {
        runDir,
        graph: plan,
        by: 'planner',
        planner: PLANNER,
        diagnostics: [],
        ...ENV,
      });

      expect(persisted.planHash).toBe(plan.planHash);
      expect(readPlanDoc(db, plan.planHash)).toBe(canonicalJson(plan));
      expect(JSON.parse(readFileSync(planPathOf(runDir, 1), 'utf8'))).toEqual(plan);

      const proposed = readRange(db, RUN, 0, 100).events.filter(
        (row) => row.kind === 'plan.proposed',
      );
      expect(proposed).toHaveLength(1);
      const payload = proposed[0]?.payload as Record<string, unknown>;
      expect(payload.planHash).toBe(plan.planHash);
      expect(payload.version).toBe(1);
      expect(payload.by).toBe('planner');
    } finally {
      db.close();
    }
  });

  it('AC6 — the proposal carries planner.model, planner.effort and planner.tier', async ({
    tmp,
  }) => {
    const db = openAt(tmp);
    try {
      const plan = await graph();
      await persistPlanVersion(db, {
        runDir: join(tmp, 'runs', RUN),
        graph: plan,
        by: 'planner',
        planner: PLANNER,
        diagnostics: [],
        ...ENV,
      });

      const [proposed] = readRange(db, RUN, 0, 100).events.filter(
        (row) => row.kind === 'plan.proposed',
      );
      expect((proposed?.payload as Record<string, unknown>).planner).toEqual(PLANNER);
    } finally {
      db.close();
    }
  });

  it('rolls the plan row back when the append is refused — never a half-written version', async ({
    tmp,
  }) => {
    const db = openAt(tmp);
    const runDir = join(tmp, 'runs', RUN);
    try {
      const plan = await graph();
      // A stale epoch is the append fence: the row insert has already run when
      // this throws, which is precisely why it must be inside the transaction.
      await expect(
        persistPlanVersion(db, {
          runDir,
          graph: plan,
          by: 'planner',
          planner: PLANNER,
          diagnostics: [],
          ts: ENV.ts,
          epoch: -1,
        }),
      ).rejects.toThrow();

      expect(readPlanDoc(db, plan.planHash)).toBeNull();
      expect(
        readRange(db, RUN, 0, 100).events.filter((row) => row.kind === 'plan.proposed'),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('AC4 — a document is stored under the hash that addresses it, or not at all', () => {
  it('refuses a graph whose declared planHash does not address its content', async ({ tmp }) => {
    const db = openAt(tmp);
    const runDir = join(tmp, 'runs', RUN);
    try {
      const plan = await graph();
      const lying = { ...plan, planHash: `sha256-${'e'.repeat(64)}` } as PlanGraph;

      await expect(
        persistPlanVersion(db, {
          runDir,
          graph: lying,
          by: 'planner',
          planner: PLANNER,
          diagnostics: [],
          ...ENV,
        }),
      ).rejects.toThrow(PlanHashMismatch);

      expect(existsSync(planPathOf(runDir, 1))).toBe(false);
      expect(readRange(db, RUN, 0, 100).events).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('stores the canonical encoding, so a re-read hashes to the same value', async ({ tmp }) => {
    const db = openAt(tmp);
    try {
      const plan = await graph();
      await persistPlanVersion(db, {
        runDir: join(tmp, 'runs', RUN),
        graph: plan,
        by: 'planner',
        planner: PLANNER,
        diagnostics: [],
        ...ENV,
      });

      const doc = readPlanDoc(db, plan.planHash);
      if (doc === null) throw new Error('unreachable');
      await expect(planHash(JSON.parse(doc))).resolves.toBe(plan.planHash);
    } finally {
      db.close();
    }
  });
});

suite('NF8 — every version is on disk, and nothing prunes it', () => {
  it('names the file after the version, so v1 and v2 coexist', async ({ tmp }) => {
    const db = openAt(tmp);
    const runDir = join(tmp, 'runs', RUN);
    try {
      const v1 = await graph();
      await persistPlanVersion(db, {
        runDir,
        graph: v1,
        by: 'planner',
        planner: PLANNER,
        diagnostics: [],
        ...ENV,
      });
      const v2 = await graph({ version: 2, parent: v1.planHash, createdBy: 'human' });
      await persistPlanVersion(db, {
        runDir,
        graph: v2,
        by: 'human',
        planner: PLANNER,
        diagnostics: [],
        ...ENV,
      });

      expect(planPathOf(runDir, 1).endsWith(join('plan', 'v1.json'))).toBe(true);
      expect(existsSync(planPathOf(runDir, 1))).toBe(true);
      expect(existsSync(planPathOf(runDir, 2))).toBe(true);
      expect(readPlanDoc(db, v1.planHash)).not.toBeNull();
      expect(readPlanDoc(db, v2.planHash)).not.toBeNull();
    } finally {
      db.close();
    }
  });
});

/**
 * KAR-11.2 AC9 / EPIC-11-S12, second scenario — there is exactly one entry
 * point to plan persistence, and it will not run without a `Diagnostic[]`.
 *
 * `diagnostics` is a **required** option rather than an optional one, and that
 * is the load-bearing detail: a caller that has not validated cannot satisfy
 * the type, so "somebody added a quick second write path six months from now"
 * is a compile error rather than a silently unvalidated plan. The runtime
 * refusal below is the other half — a caller *can* type `diagnostics: []`, but
 * it cannot hand over a blocking one and still get a row.
 */
suite('AC9 — a plan row is never written without diagnostics that permit it', () => {
  it('refuses a blocking diagnostic, and writes neither the row, the file nor the event', async ({
    tmp,
  }) => {
    const db = openAt(tmp);
    const runDir = join(tmp, 'runs', RUN);
    try {
      const plan = await graph();

      await expect(
        persistPlanVersion(db, {
          runDir,
          graph: plan,
          by: 'planner',
          planner: PLANNER,
          diagnostics: [
            {
              severity: 'error',
              code: 'READ_UNREACHABLE',
              node: 'implement',
              key: 'finding/db-schema',
              message:
                "node 'implement' reads 'finding/db-schema' but no ancestor writes it and it " +
                'is not in the pinned spec',
            },
          ],
          ...ENV,
        }),
      ).rejects.toBeInstanceOf(PlanNotValidated);

      expect(readPlanDoc(db, plan.planHash)).toBeNull();
      expect(existsSync(planPathOf(runDir, 1))).toBe(false);
      expect(readRange(db, RUN, 0, 100).events).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('persists a plan carrying only warnings — a warning never blocks (§3.1)', async ({ tmp }) => {
    const db = openAt(tmp);
    const runDir = join(tmp, 'runs', RUN);
    try {
      const plan = await graph();

      await persistPlanVersion(db, {
        runDir,
        graph: plan,
        by: 'planner',
        planner: PLANNER,
        diagnostics: [
          {
            severity: 'warning',
            code: 'ORPHAN_WRITE',
            node: 'implement',
            key: 'finding/unused',
            message:
              "node 'implement' writes 'finding/unused' and no node reads it. Usually a " +
              'leftover from a patch, occasionally deliberate — the run is not blocked.',
          },
        ],
        ...ENV,
      });

      expect(readPlanDoc(db, plan.planHash)).not.toBeNull();
    } finally {
      db.close();
    }
  });
});
