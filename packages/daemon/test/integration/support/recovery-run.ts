/**
 * The five-node run KAR-06.9's recovery specs restart (EPIC-06-S11, S29).
 *
 * Three nodes finished before the daemon died, two never started, and — in the
 * `interrupted` variant — a fourth was in flight with the repository write lock
 * in hand and an `effect` row still `pending`. That is the shape the whole story
 * is about: what a `kill -9` leaves on disk, and what the next daemon may
 * conclude from it.
 *
 * Shared by the specs and by the crash-fuzz worker, so the run the parent
 * asserts about and the run a child process writes cannot drift apart.
 */
import type { EventSeq, NodeFailure, NodeId, RunId } from '@DeFlow/core';
import { appendEvents, type Db, type EventDraft } from '@DeFlow/ledger';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RECOVERY_RUN = 'run_20260805T091500Z_9a4f02' as RunId;

/** The three that finished. F4.2 says they are never executed again. */
export const DONE_NODES = ['recon', 'survey', 'design'] as const;

/** The two that had not started when the daemon died. */
export const REMAINING_NODES = ['document', 'verify'] as const;

/** The one that was in flight, holding the repository write lock. */
export const INTERRUPTED = 'implement' as NodeId;

export const REPO = '/home/u/proj';
/** The key `lockClaims` derives for `REPO`, and the key the ledger records. */
export const REPO_LOCK = `repo:${REPO}`;

export const T0 = 1_754_380_800_000;

const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const BINARY_SHA = 'd'.repeat(64);

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

/**
 * A node that writes the repository, so it claims the repo lock, with the
 * attempt ceiling a caller asks for.
 */
const node = (id: string, maxAttempts = 3): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'worktree',
  pathScopes: { write: [`src/${id}/**`] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts, backoff: { base: 20, cap: 200, jitter: 'full' } },
  budget: {},
  brief: `brief for ${id}`,
  provider: { prefer: ['claude-code'], requires: [] },
  resume: 'always-replay',
});

export interface SeedOptions {
  /** The attempt ceiling on `implement`; 1 leaves it no retry at all. */
  readonly maxAttempts?: number;
}

const graph = (maxAttempts: number): Record<string, unknown> => ({
  schemaId: 'DeFlow.plangraph.v1',
  runId: RECOVERY_RUN,
  version: 1,
  planHash: PLAN_HASH,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-05T09:15:00.000Z',
  nodes: [
    ...DONE_NODES.map((id) => node(id)),
    node(INTERRUPTED, maxAttempts),
    ...REMAINING_NODES.map((id) => node(id)),
  ],
  edges: [],
});

/** The retry policy `implement` carries, for a spec that has to hand it on. */
export const retryPolicy = (maxAttempts = 3): Record<string, unknown> =>
  node(INTERRUPTED, maxAttempts).retry as Record<string, unknown>;

const COMPLETED_RESULT = {
  status: 'completed',
  output: { summary: 'done' },
  outputSchemaId: 'DeFlow.finding.v1',
  usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
  costUsd: 0.42,
  producedFacts: [],
  artifacts: [],
};

const draft = (kind: string, payload: unknown, extra: Partial<EventDraft> = {}): EventDraft => ({
  runId: RECOVERY_RUN,
  ts: T0,
  kind,
  v: 1,
  epoch: 1,
  payload,
  ...extra,
});

const started = (id: string, attempt = 0): EventDraft =>
  draft(
    'node.started',
    {
      node: id,
      attempt,
      ikey: `${RECOVERY_RUN}/${id}/${attempt}/0`,
      binary: { path: '/usr/bin/deflow-mock-agent', version: '1.0.0', sha256: BINARY_SHA },
    },
    { nodeId: id, attempt, ikey: `${RECOVERY_RUN}/${id}/${attempt}/0` },
  );

/**
 * The ledger a dead daemon left behind: three nodes completed, two untouched.
 *
 * Everything here carries `epoch: 1`, which is the previous daemon life — the
 * one that is gone.
 */
export function seedRecoveryRun(db: Db, options: SeedOptions = {}): void {
  appendEvents(db, [
    draft('run.created', {
      spec: taskSpec,
      cwd: REPO,
      repo: { head: 'e83c516', branch: 'main' },
    }),
    // KAR-10.3 AC3 — F1.3's gate. `decide()` admits nothing until the ledger
    // carries an approval, so a fixture for a run that is genuinely executing
    // has to carry the row every executing run has.
    draft('run.spec.approved', { specHash: SPEC_HASH, by: 'ui' }),
    draft('plan.proposed', {
      version: 1,
      planHash: PLAN_HASH,
      graph: graph(options.maxAttempts ?? 3),
      by: 'planner',
    }),
    draft('run.started', { planHash: PLAN_HASH }),
    ...DONE_NODES.flatMap((id) => [
      started(id),
      draft(
        'node.completed',
        { node: id, attempt: 0, result: COMPLETED_RESULT },
        { nodeId: id, attempt: 0 },
      ),
    ]),
  ]);
}

/**
 * `implement` in flight when the knife landed: the lock it took, the attempt it
 * started, and no terminal event of any kind.
 */
export function seedInterruptedAttempt(db: Db, attempt = 0): void {
  appendEvents(db, [
    draft(
      'node.lock.acquired',
      { node: INTERRUPTED, lock: 'repo', key: REPO_LOCK },
      { nodeId: INTERRUPTED, attempt },
    ),
    started(INTERRUPTED, attempt),
  ]);
}

/** A failure shaped as the classifier hands one over. */
export const classified = (
  reason: NodeFailure['reason'],
  failureClass: NodeFailure['class'],
  attempt = 0,
): NodeFailure => ({
  reason,
  class: failureClass,
  message: `${reason} while running ${INTERRUPTED}`,
  evidence: [],
  occurredAtEvent: 1 as EventSeq,
  attempt,
});
