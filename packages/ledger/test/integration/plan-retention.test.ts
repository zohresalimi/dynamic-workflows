/**
 * KAR-11.5 AC1, AC2 — retention: nothing overwrites, nothing prunes, and
 * content addressing dedups for free (docs/06-planning-and-replanning.md §5,
 * EPIC-11-S26).
 *
 * Integration rather than unit, for the same reason ../integration/patch-apply.test.ts
 * is: the claim is about a real file-backed `plan` table and real `vN.json`
 * files under a real run directory, not about an object a fake `Db` was asked
 * to remember. `persistPlanVersion` and `applyPatchedPlanVersion` already
 * implement both mechanisms (KAR-11.1, KAR-11.3); this file is what proves the
 * retention *story* — three patches produce four versions, none of the four
 * ever move, and a document that repeats deduplicates — because nothing wrote
 * that assertion down before this story.
 *
 * Verifies: EPIC-11-S26 · AC1, AC2 · test plan #1, #2, #5
 */
import type { PlanGraph } from '@DeFlow/core';
import { canonicalJson, PlanGraphSchema, planHash } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  applyPatchedPlanVersion,
  type Db,
  openLedger,
  persistPlanVersion,
  planDirOf,
  planPathOf,
  readPlanDoc,
  readRange,
} from '../../src/index.ts';

const RUN = 'run_20260809T090000Z_ac1105';
const T0 = 1_754_726_400_000;
const EPOCH = 1;
const PLANNER = { model: 'the-planner-model', effort: 'max', tier: 'strongest' } as const;
const DECISION = {
  decision: 'auto',
  by: 'policy',
  rule: 'read-only-analysis',
  at: '2026-08-09T09:00:00.000Z',
} as const;

/** One node with a modest but realistic amount of prose, so a 40-node graph
 * lands near 06 §5's own "~30 KB" figure rather than a few hundred bytes that
 * would pass the size assertion for the wrong reason. */
const node = (id: string) =>
  ({
    id,
    title: `Implement the ${id} slice of the checkout flow`,
    type: 'agent',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'worktree',
    pathScopes: { write: [`packages/${id}/**`] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
    brief:
      `Work through the ${id} module: read the existing implementation, port it to the ` +
      'target API, keep the public surface stable, and leave a finding describing what moved.',
    provider: { prefer: ['claude'], requires: ['structuredOutput'] },
    resume: 'always-replay',
  }) as const;

/** A graph with `count` nodes and a declared `planHash` that really addresses
 * it — 06 §5's "~30 KB for 40 nodes" needs roughly this many to land near it. */
async function graph(count: number, over: Record<string, unknown> = {}): Promise<PlanGraph> {
  const nodes = Array.from({ length: count }, (_unused, index) => node(`n${index}`));
  const parsed = PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: RUN,
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'1'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-09T09:00:00.000Z',
    nodes,
    edges: [],
    ...over,
  });
  return { ...parsed, planHash: await planHash(parsed) };
}

function seedRun(db: Db, planHashValue: string): void {
  db.prepare(
    `INSERT INTO run (run_id, status, plan_hash, last_seq, state_json, checkpoint_version,
        daemon_epoch)
      VALUES (?, 'running', ?, 0, '{}', 1, ?)
      ON CONFLICT(run_id) DO UPDATE SET plan_hash = excluded.plan_hash`,
  ).run(RUN, planHashValue, EPOCH);
}

const planRowCount = (db: Db): number =>
  Number(
    (db.prepare('SELECT COUNT(*) AS n FROM plan WHERE run_id = ?').get(RUN) as { n: number }).n,
  );

async function patch(db: Db, runDir: string, base: PlanGraph, count: number): Promise<PlanGraph> {
  const next = await graph(count, { version: base.version + 1, parent: base.planHash });
  const outcome = await applyPatchedPlanVersion(db, {
    runDir,
    graph: next,
    basePlanHash: base.planHash,
    patchId: `patch-v${next.version}`,
    decision: DECISION,
    diagnostics: [],
    by: 'planner',
    planner: PLANNER,
    ts: T0,
    epoch: EPOCH,
  });
  expect(outcome.outcome).toBe('applied');
  return next;
}

suite('EPIC-11-S26 — three patches produce four versions, and none of them move', () => {
  it('holds four plan rows and four vN.json files, byte-identical to their rows', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    const runDir = join(tmp, 'runs', RUN);
    try {
      const v1 = await graph(6);
      await persistPlanVersion(db, {
        runDir,
        graph: v1,
        diagnostics: [],
        by: 'planner',
        planner: PLANNER,
        ts: T0,
        epoch: EPOCH,
      });
      seedRun(db, v1.planHash);

      const v2 = await patch(db, runDir, v1, 7);
      const v3 = await patch(db, runDir, v2, 8);
      const v4 = await patch(db, runDir, v3, 9);

      expect(planRowCount(db)).toBe(4);
      for (const version of [v1, v2, v3, v4]) {
        const onDisk = JSON.parse(readFileSync(planPathOf(runDir, version.version), 'utf8'));
        expect(onDisk).toEqual(version);
        expect(readPlanDoc(db, version.planHash)).toBe(canonicalJson(version));
      }

      // Nothing overwrote an earlier version: v1 is still exactly what was
      // first written, after three more versions landed on top of it.
      expect(readPlanDoc(db, v1.planHash)).toBe(canonicalJson(v1));

      const proposed = readRange(db, RUN, 0, 100).events.filter(
        (event) => event.kind === 'plan.proposed',
      );
      expect(proposed).toHaveLength(4);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-11-S26 — content addressing deduplicates for free', () => {
  it('does not duplicate a row when the same document is persisted twice, and both resolve', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    const runDir = join(tmp, 'runs', RUN);
    try {
      const v1 = await graph(5);

      const first = await persistPlanVersion(db, {
        runDir,
        graph: v1,
        diagnostics: [],
        by: 'planner',
        planner: PLANNER,
        ts: T0,
        epoch: EPOCH,
      });
      // The same byte-identical document, proposed again — the shape a caller
      // takes when it cannot tell whether an earlier attempt's transaction
      // committed and retries with what it was about to write either way.
      const second = await persistPlanVersion(db, {
        runDir,
        graph: v1,
        diagnostics: [],
        by: 'planner',
        planner: PLANNER,
        ts: T0 + 1,
        epoch: EPOCH,
      });

      expect(first.planHash).toBe(second.planHash);
      expect(planRowCount(db)).toBe(1);
      // Both proposals — two distinct ledger facts — still resolve to the one
      // stored row.
      expect(readPlanDoc(db, first.planHash)).toBe(canonicalJson(v1));
      expect(readPlanDoc(db, second.planHash)).toBe(canonicalJson(v1));

      const proposed = readRange(db, RUN, 0, 100).events.filter(
        (event) => event.kind === 'plan.proposed',
      );
      expect(proposed).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-11-S26 — the storage argument holds for a pathological 12-version run', () => {
  it('keeps total plan storage on disk under 512 KB, with nothing pruned', async ({ tmp }) => {
    const db = openLedger(tmp);
    const runDir = join(tmp, 'runs', RUN);
    try {
      let current = await graph(40);
      await persistPlanVersion(db, {
        runDir,
        graph: current,
        diagnostics: [],
        by: 'planner',
        planner: PLANNER,
        ts: T0,
        epoch: EPOCH,
      });
      seedRun(db, current.planHash);

      const firstOnDisk = statSync(planPathOf(runDir, 1)).size;
      // 06 §5's own figure — "a 40-node plan serialises to roughly 30 KB" —
      // asserted so a future change to the node fixture cannot silently drift
      // this test into measuring a much smaller document.
      expect(firstOnDisk).toBeGreaterThan(20_000);

      for (let version = 2; version <= 12; version += 1) {
        current = await patch(db, runDir, current, 40);
      }

      expect(planRowCount(db)).toBe(12);
      const files = readdirSync(planDirOf(runDir));
      expect(files).toHaveLength(12);

      const totalBytes = files.reduce(
        (sum, file) => sum + statSync(join(planDirOf(runDir), file)).size,
        0,
      );
      expect(totalBytes).toBeLessThan(512 * 1024);
    } finally {
      db.close();
    }
  });
});
