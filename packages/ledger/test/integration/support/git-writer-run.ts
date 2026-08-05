/**
 * The two-write-node run behind EPIC-06-S5's fourth scenario, rooted in a
 * **real** git repository.
 *
 * The sibling `./repo-lock-run.ts` describes the same shape over an imaginary
 * `/home/u/proj`, which is all its restart spec needs. This one takes the
 * repository path as an argument because its spec runs two real processes
 * inside it: `run.created.cwd` is what `reduce()` folds into `RunState.repoRoot`
 * and therefore what the repo write lock is keyed on, so the key the scheduler
 * computes has to be the directory `git add` actually runs in — otherwise the
 * spec would serialise a lock over one path while the agents fight over
 * another, and pass for the wrong reason.
 */

import { type RunId, RunIdSchema } from '@DeFlow/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { EventDraft } from '../../../src/index.ts';

export const WRITER_RUN: RunId = RunIdSchema.parse('run_20260805T140200Z_4c9a02');

/** Both write the repository, so both claim the one repo lock (F5.2). */
export const FIRST = 'impl-auth';
export const SECOND = 'impl-router';

const PLAN_HASH = `sha256-${'e'.repeat(64)}`;
const TS = 1_754_402_400_000;

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

/**
 * One `agent` node that writes the repository.
 *
 * `permission: 'worktree'` and a non-empty `pathScopes.write` are exactly the
 * two things `lockClaims()` reads to decide a node contends for the git index,
 * and both nodes are otherwise identical: nothing but the enablement order
 * distinguishes them, so whichever is admitted first is the scheduler's answer
 * rather than an accident of the fixture.
 */
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

/**
 * A run that is `running`, with both writers ready on the very first tick and
 * no locks held by anyone.
 *
 * There is no `node.scheduled` for either node on purpose: neither is assigned
 * a worktree, so the only lock in play is the repository write lock and the
 * spec cannot pass by accidentally serialising on something else.
 */
export function twoWritersReady(repoDir: string): EventDraft[] {
  const graph = {
    schemaId: 'DeFlow.plangraph.v1',
    runId: WRITER_RUN,
    version: 1,
    planHash: PLAN_HASH,
    parent: null,
    taskSpecHash: `sha256-${'c'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-05T14:02:00.000Z',
    nodes: [writeNode(FIRST, 'first/**'), writeNode(SECOND, 'second/**')],
    edges: [],
  };

  const draft = (kind: string, payload: unknown): EventDraft => ({
    runId: WRITER_RUN,
    ts: TS,
    kind,
    v: 1,
    epoch: 1,
    payload,
  });

  return [
    draft('run.created', {
      spec: taskSpec,
      cwd: repoDir,
      repo: { head: 'e83c516', branch: 'main' },
    }),
    draft('plan.proposed', { version: 1, planHash: PLAN_HASH, graph, by: 'planner' }),
    draft('run.started', { planHash: PLAN_HASH }),
  ];
}
