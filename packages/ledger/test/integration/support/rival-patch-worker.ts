/**
 * One of two rival proposers, as a real process (KAR-11.3 AC10, EPIC-11-S16's
 * second scenario).
 *
 * *"Two `map` children finishing within the same tick can both propose."* The
 * rule is deliberately crude — one wins, the other re-derives — and the only
 * way to show it is genuinely enforced is two **processes** contending for the
 * same ledger file. SQLite permits exactly one writer, `BEGIN IMMEDIATE` takes
 * that lock up front, and the staleness check is the first statement inside it,
 * so the loser discovers a `run.plan_hash` that is no longer the base it
 * reasoned about. In one process that is a fact about a function; across two it
 * is a fact about the database.
 *
 * The rivals synchronise on a start file rather than on a timer: both are ready
 * and blocked, and the parent releases them together, which is as close to
 * "the same tick" as two processes get.
 */
import type { PlanGraph } from '@DeFlow/core';
import { PlanGraphSchema, planHash } from '@DeFlow/core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { applyPatchedPlanVersion, openLedger } from '../../../src/index.ts';
import { RIVAL_BASE_HASH_FILE, RIVAL_RUN } from './rival-patch-run.ts';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

const dataDir = required('DeFlow_RIVAL_DATA_DIR');
const label = required('DeFlow_RIVAL_LABEL');
const startFile = required('DeFlow_RIVAL_START');
const outFile = required('DeFlow_RIVAL_OUT');
const readyFile = required('DeFlow_RIVAL_READY');

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

const base = readFileSync(join(dataDir, RIVAL_BASE_HASH_FILE), 'utf8').trim();

/** Each rival proposes a *different* successor, so "no merged graph" is
 * checkable: at most one of the two documents may ever exist. */
const parsed = PlanGraphSchema.parse({
  schemaId: 'DeFlow.plangraph.v1',
  runId: RIVAL_RUN,
  version: 2,
  planHash: `sha256-${'0'.repeat(64)}`,
  parent: base,
  taskSpecHash: `sha256-${'1'.repeat(64)}`,
  createdBy: 'planner',
  createdAt: '2026-08-08T12:00:00.000Z',
  nodes: [node('recon'), node(`analyse-${label}`)],
  edges: [],
});
const next: PlanGraph = {
  ...parsed,
  planHash: await planHash(parsed as unknown as Record<string, unknown>),
};

const db = openLedger(dataDir);
writeFileSync(readyFile, next.planHash);

// Both rivals block here; the parent releases them together.
const deadline = Date.now() + 30_000;
while (!existsSync(startFile)) {
  if (Date.now() > deadline) throw new Error(`${label} timed out waiting for the start signal`);
}

const outcome = await applyPatchedPlanVersion(db, {
  runDir: join(dataDir, 'runs', RIVAL_RUN),
  graph: next,
  basePlanHash: base,
  patchId: `patch-${label}`,
  decision: DECISION,
  by: 'planner',
  planner: PLANNER,
  diagnostics: [],
  ts: TS,
  epoch: EPOCH,
});

writeFileSync(outFile, JSON.stringify({ label, planHash: next.planHash, outcome }));
db.close();
