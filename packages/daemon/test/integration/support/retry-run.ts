/**
 * The run KAR-06.5's integration specs fail a node in, as a real ledger on disk.
 *
 * Shared by the specs and by the child process one of them SIGKILLs, so the run
 * the parent asserts about and the run the child wrote cannot drift apart.
 *
 * Nine nodes: `implement` — the one that fails — plus eight others, six of which
 * are already completed. The completed six are not decoration: EPIC-06-S31's
 * claim is that hitting a ceiling pauses the run *with its work intact*, and a
 * run with nothing finished cannot tell "preserved" from "there was nothing to
 * preserve".
 */
import type { EventSeq, NodeFailure, NodeFailureReason, NodeId, RunId } from '@DeFlow/core';
import type { Db, EventDraft } from '@DeFlow/ledger';
import { appendEvents } from '@DeFlow/ledger';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const RETRY_RUN = 'run_20260805T090000Z_5c1d27' as RunId;

/** The node every spec in this family fails. */
export const IMPLEMENT = 'implement' as NodeId;

/** The six that finished before it did, and must still be finished afterwards. */
export const COMPLETED_NODES = [
  'recon',
  'survey',
  'inventory',
  'design',
  'scaffold',
  'wire',
] as const;

/** The two that had not started, and are what a pause is measured against. */
export const PENDING_NODES = ['document', 'verify'] as const;

/** The instant every fixture here is anchored to. */
export const T0 = 1_754_380_800_000;

const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
export const REPO = '/home/u/proj';

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

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
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `brief for ${id}`,
  provider: { prefer: ['claude-code', 'codex'], requires: [] },
  resume: 'always-replay',
});

const graph = {
  schemaId: 'DeFlow.plangraph.v1',
  runId: RETRY_RUN,
  version: 1,
  planHash: PLAN_HASH,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-05T09:00:00.000Z',
  nodes: [
    ...COMPLETED_NODES.map((id) => node(id)),
    node(IMPLEMENT),
    ...PENDING_NODES.map((id) => node(id, [IMPLEMENT])),
  ],
  edges: PENDING_NODES.map((id) => ({ from: IMPLEMENT, to: id, kind: 'control' })),
};

/** The plan node `implement` is, so a spec can hand its `retry` policy on. */
export const IMPLEMENT_NODE = graph.nodes.find((entry) => entry.id === IMPLEMENT) as {
  retry: { maxAttempts: number; backoff: { base: number; cap: number; jitter: 'full' } };
  provider: { prefer: string[] };
};

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
  runId: RETRY_RUN,
  ts: T0,
  kind,
  v: 1,
  epoch: 1,
  payload,
  ...extra,
});

/** The ledger up to the instant `implement`'s first attempt is in flight. */
export function seedRetryRun(db: Db): void {
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
    draft('plan.proposed', { version: 1, planHash: PLAN_HASH, graph, by: 'planner' }),
    draft('run.started', { planHash: PLAN_HASH }),
    ...COMPLETED_NODES.flatMap((id) => [
      draft(
        'node.started',
        { node: id, attempt: 0, ikey: `${RETRY_RUN}/${id}/0/0` },
        { nodeId: id, attempt: 0 },
      ),
      draft(
        'node.completed',
        { node: id, attempt: 0, result: COMPLETED_RESULT },
        { nodeId: id, attempt: 0 },
      ),
    ]),
    draft(
      'node.started',
      { node: IMPLEMENT, attempt: 0, ikey: `${RETRY_RUN}/${IMPLEMENT}/0/0` },
      { nodeId: IMPLEMENT, attempt: 0 },
    ),
  ]);
}

/** A failure as the classifier hands it over: `class` is already a field. */
export function classified(
  reason: NodeFailureReason,
  failureClass: NodeFailure['class'],
  attempt = 0,
  detail?: Record<string, unknown>,
): NodeFailure {
  return {
    reason,
    class: failureClass,
    message: `${reason} while running ${IMPLEMENT}`,
    ...(detail === undefined ? {} : { detail }),
    evidence: [],
    occurredAtEvent: 1 as EventSeq,
    attempt,
  };
}
