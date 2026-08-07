/**
 * The run KAR-14.2's ceiling specs execute: one recon node, a fan-out of three
 * that can each be admitted independently, and one dependent under each.
 *
 * The shape is chosen so both scopes are observable. A run ceiling has to stop
 * *every* branch, and a node ceiling has to stop exactly one while its siblings
 * reach `node.completed` — neither claim can be made about a chain, and neither
 * can be made about a plan whose branches share a lock, so nothing here writes
 * the repository.
 *
 * Shared by the specs and by the child process one of them SIGKILLs, so the run
 * the parent asserts about and the run the child wrote cannot drift.
 */
import type { NodeId, RunId } from '@DeFlow/core';
import { appendEvents, type Db, type EventDraft } from '@DeFlow/ledger';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const BUDGET_RUN = 'run_20260806T101500Z_71c3ab' as RunId;

export const RECON = 'recon' as NodeId;
export const BRANCHES = ['branch-a', 'branch-b', 'branch-c'] as const;
/** One dependent per branch, so "the dependents of the tripped node are not
 * admitted, and the others' are" is a claim a spec can actually make. */
export const LEAVES = ['leaf-a', 'leaf-b', 'leaf-c'] as const;

/** The leaf that hangs off `branch`. */
export const leafOf = (branch: string): string => `leaf-${branch.slice('branch-'.length)}`;

export const REPO = '/home/u/proj';

/** The instant every fixture here is anchored to. */
export const T0 = 1_754_467_200_000;

export const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
/** The sha256 of the effective ceiling document, as the creation path pins it. */
export const CEILING_HASH = `sha256-${'e'.repeat(64)}`;

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

/**
 * A read-only agent node: no declared write, so it takes no repository lock and
 * two siblings really can run at once.
 */
const node = (id: string, deps: readonly string[] = []): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  type: 'agent',
  deps: [...deps],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 20, cap: 200, jitter: 'full' } },
  budget: {},
  brief: `brief for ${id}`,
  provider: { prefer: ['claude-code'], requires: [] },
  resume: 'always-replay',
});

const graph: Record<string, unknown> = {
  schemaId: 'DeFlow.plangraph.v1',
  runId: BUDGET_RUN,
  version: 1,
  planHash: PLAN_HASH,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-06T10:15:00.000Z',
  nodes: [
    node(RECON),
    ...BRANCHES.map((id) => node(id, [RECON])),
    ...BRANCHES.map((id) => node(leafOf(id), [id])),
  ],
  edges: [
    ...BRANCHES.map((id) => ({ from: RECON, to: id, kind: 'control' })),
    ...BRANCHES.map((id) => ({ from: id, to: leafOf(id), kind: 'control' })),
  ],
};

export const draft = (
  kind: string,
  payload: unknown,
  extra: Partial<EventDraft> = {},
): EventDraft => ({
  runId: BUDGET_RUN,
  ts: T0,
  kind,
  v: 1,
  epoch: 1,
  payload,
  ...extra,
});

/** The ceiling as `POST /api/runs` pins it, at whatever scope the spec wants. */
export const ceilingSet = (
  scope: 'run' | 'node',
  values: { costUsd?: number | null; wallclockMs?: number | null },
  extra: { node?: string; source?: 'request' | 'config' | 'operator' } = {},
): EventDraft =>
  draft(
    'budget.ceiling.set',
    {
      scope,
      ...(extra.node === undefined ? {} : { node: extra.node }),
      costUsd: values.costUsd ?? null,
      wallclockMs: values.wallclockMs ?? null,
      source: extra.source ?? 'request',
      hash: CEILING_HASH,
    },
    // The version the build writes, rather than a literal: `budget.ceiling.set`
    // is v1 today and the fixture must follow it up rather than pin it.
    { v: 1 },
  );

/**
 * A run created with a ceiling and started, exactly as the creation path would
 * write it: the ceiling is appended **in the same transaction** as
 * `run.created`, so there is no instant at which the run exists unbounded.
 */
export function seedBudgetRun(db: Db, ceilings: readonly EventDraft[]): void {
  appendEvents(db, [
    draft('run.created', {
      spec: taskSpec,
      cwd: REPO,
      repo: { head: 'e83c516', branch: 'main' },
    }),
    ...ceilings,
    draft('plan.proposed', { version: 1, planHash: PLAN_HASH, graph, by: 'planner' }),
    draft('run.started', { planHash: PLAN_HASH }),
  ]);
}
