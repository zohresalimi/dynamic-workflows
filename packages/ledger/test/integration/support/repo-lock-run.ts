/**
 * The two-write-node run KAR-06.2's restart scenario is about (EPIC-06-S6).
 *
 * Shared by the spec and by the child process it kills, so the run the parent
 * makes assertions about and the run the child writes cannot drift apart.
 */

import { type RunId, RunIdSchema } from '@DeFlow/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EventDraft } from '../../../src/index.ts';

export const LOCK_RUN: RunId = RunIdSchema.parse('run_20260805T091500Z_7d3e11');

/** The repository the run executes in, and the key its write lock is under. */
export const REPO = '/home/u/proj';
export const REPO_LOCK = `repo:${REPO}`;

export const HOLDER = 'impl-auth';
export const COMPETITOR = 'impl-router';

const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const TS = 1_754_308_293_000;

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

/** One `agent` node that writes the repository, so it claims the repo lock. */
const writeNode = (id: string, scope: string): Record<string, unknown> => ({
  id,
  title: `implement ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'worktree',
  pathScopes: { write: [scope] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `implement ${id}`,
  provider: { prefer: ['claude-code'], requires: [] },
  resume: 'always-replay',
});

const graph = {
  schemaId: 'DeFlow.plangraph.v1',
  runId: LOCK_RUN,
  version: 1,
  planHash: PLAN_HASH,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-05T09:15:00.000Z',
  nodes: [writeNode(HOLDER, 'src/auth/**'), writeNode(COMPETITOR, 'src/router/**')],
  edges: [],
};

const draft = (kind: string, payload: unknown, extra: Partial<EventDraft> = {}): EventDraft => ({
  runId: LOCK_RUN,
  ts: TS,
  kind,
  v: 1,
  epoch: 1,
  payload,
  ...extra,
});

/**
 * The ledger up to the moment the daemon dies: a run in a known repository,
 * two nodes that both write it, and one of them holding the repo lock with no
 * matching release.
 */
export function heldLockRun(): EventDraft[] {
  return [
    draft('run.created', { spec: taskSpec, cwd: REPO, repo: { head: 'e83c516', branch: 'main' } }),
    // KAR-10.3 AC3 — F1.3's gate. `decide()` admits nothing until the ledger
    // carries an approval, so a fixture for a run that is genuinely executing
    // has to carry the row every executing run has.
    draft('run.spec.approved', { specHash: SPEC_HASH, by: 'ui' }),
    draft('plan.proposed', { version: 1, planHash: PLAN_HASH, graph, by: 'planner' }),
    draft('run.started', { planHash: PLAN_HASH }),
    draft(
      'node.lock.acquired',
      { node: HOLDER, lock: 'repo', key: REPO_LOCK },
      { nodeId: HOLDER, attempt: 0 },
    ),
    draft(
      'node.started',
      {
        node: HOLDER,
        attempt: 0,
        ikey: `${LOCK_RUN}/${HOLDER}/0/0`,
        binary: { path: '/usr/bin/DeFlow-mock-agent', version: '1.0.0', sha256: 'd'.repeat(64) },
      },
      { nodeId: HOLDER, attempt: 0, ikey: `${LOCK_RUN}/${HOLDER}/0/0` },
    ),
  ];
}

/** The holder dying without releasing anything — the reclaim scenario. */
export function holderFailed(): EventDraft {
  return draft(
    'node.failed',
    {
      node: HOLDER,
      attempt: 0,
      failure: {
        reason: 'adapter.spawn-failed',
        class: 'permanent',
        message: 'the agent died with the lock in hand',
        evidence: [],
        occurredAtEvent: 4,
        attempt: 0,
      },
    },
    { nodeId: HOLDER, attempt: 0 },
  );
}
