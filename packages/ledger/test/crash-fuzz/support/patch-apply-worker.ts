/**
 * One real process applying one real `PlanPatch`, with a real window inside the
 * apply transaction for the harness to put a knife into (KAR-11.3 AC4,
 * EPIC-11-S15).
 *
 * The whole file exists to make the transaction *observable from outside*.
 * better-sqlite3 is synchronous, so a `BEGIN IMMEDIATE … COMMIT` over three
 * statements is a handful of microseconds — far too narrow for a parent process
 * polling a file to land a `SIGKILL` inside it. So the transaction gets a
 * `crashPoint`, called after `UPDATE run SET plan_hash` and before
 * `INSERT INTO event`, which publishes a marker and then **busy-waits** on a
 * real clock. Busy, not `await`: the transaction is synchronous, an
 * `await` would leave it and a `setTimeout` inside it would never fire.
 *
 * That is a window widened for the test, and the widening is honest because the
 * *shape* under test is not the window: it is that all three statements are one
 * transaction. A kill anywhere inside it must leave either the old plan and no
 * event, or the new plan, the updated `run.plan_hash` and the event — and the
 * window only decides how often the fuzzer gets to check.
 *
 * Configuration arrives in the environment so the process's own argv stays
 * empty, exactly as `support/scripted-run.ts` does it.
 */
import type { PlanGraph } from '@DeFlow/core';
import { canonicalJson, PlanGraphSchema, planHash } from '@DeFlow/core';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { applyPatchedPlanVersion, openLedger, persistPlanVersion } from '../../../src/index.ts';
import { PATCH_RUN } from './patch-run.ts';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

const dataDir = required('DeFlow_PATCH_DATA_DIR');
const phaseFile = required('DeFlow_PATCH_PHASE');
const holdMs = Number.parseInt(process.env.DeFlow_PATCH_HOLD_MS ?? '250', 10);

const TS = 1_754_640_000_000;
const EPOCH = 1;
const PLANNER = { model: 'a-model', effort: 'max', tier: 'strongest' } as const;
const DECISION = {
  decision: 'auto',
  by: 'policy',
  rule: 'read-only-analysis',
  at: '2026-08-08T12:00:00.000Z',
} as const;

const node = (id: string) => ({
  id,
  title: `Do ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'worktree',
  pathScopes: { write: ['packages/ui/**'] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  brief: `Do ${id}, carefully.`,
  provider: { prefer: ['claude'], requires: [] },
  resume: 'always-replay',
});

async function graph(over: Record<string, unknown>): Promise<PlanGraph> {
  const parsed = PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: PATCH_RUN,
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'1'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-08T12:00:00.000Z',
    nodes: [node('recon')],
    edges: [],
    ...over,
  });
  return { ...parsed, planHash: await planHash(parsed) };
}

/** To a file rather than to stdout: the reader is a parent polling a process it
 * is about to SIGKILL, and a line still in a pipe buffer when the signal lands
 * is a line that never existed. */
const phase = (marker: string): void => {
  writeFileSync(phaseFile, marker);
};

const runDir = join(dataDir, 'runs', PATCH_RUN);
const db = openLedger(dataDir);

const base = await graph({});
const next = await graph({
  version: 2,
  parent: base.planHash,
  nodes: [node('recon'), node('analyse-ui')],
});

// ── the world before the patch, committed and durable ────────────────────────
await persistPlanVersion(db, {
  runDir,
  graph: base,
  by: 'planner',
  planner: PLANNER,
  diagnostics: [],
  ts: TS,
  epoch: EPOCH,
});
db.prepare(
  `INSERT INTO run (run_id, status, plan_hash, last_seq, state_json, checkpoint_version,
      daemon_epoch)
    VALUES (?, 'running', ?, 0, ?, 1, ?)
    ON CONFLICT(run_id) DO UPDATE SET plan_hash = excluded.plan_hash`,
).run(PATCH_RUN, base.planHash, canonicalJson({ base: base.planHash }), EPOCH);

// The hashes the harness checks against, written before the window opens so a
// kill can never take them with it.
writeFileSync(
  join(dataDir, 'hashes.json'),
  JSON.stringify({ base: base.planHash, next: next.planHash, doc: canonicalJson(next) }),
);

phase('seeded');

const outcome = await applyPatchedPlanVersion(db, {
  runDir,
  graph: next,
  basePlanHash: base.planHash,
  patchId: 'patch-crash-fuzz',
  decision: DECISION,
  by: 'planner',
  planner: PLANNER,
  diagnostics: [],
  ts: TS,
  epoch: EPOCH,
  crashPoint: () => {
    phase('inside-transaction');
    const until = Date.now() + holdMs;
    // Busy, on a real clock. Leaving this function is leaving the transaction.
    while (Date.now() < until) {
      // Spin.
    }
  },
});

phase(`done:${outcome.outcome}`);
db.close();
