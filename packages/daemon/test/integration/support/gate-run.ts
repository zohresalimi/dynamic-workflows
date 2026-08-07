/**
 * The six-hour human gate EPIC-06-S22 is about, as a real ledger on disk.
 *
 * Shared by the spec and by the child process it SIGKILLs, so the run the
 * parent makes assertions about and the run the child wrote cannot drift apart.
 *
 * One `human` node with a six-hour deadline, and one independent `agent` node
 * beside it. The second one is not decoration: AC7's claim is that a suspended
 * node holds no slot, and a run with only the gate in it cannot tell the
 * difference between "the slot was released" and "there was nothing to admit".
 */
import type { Db, EventDraft } from '@DeFlow/ledger';
import { appendEvents } from '@DeFlow/ledger';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const GATE_RUN = 'run_20260805T120000Z_a41f9b';

export const GATE = 'approve-scope';
export const SIDEKICK = 'recon';

/** The instant every fixture in this file is anchored to. */
export const T0 = 1_754_308_400_000;

export const hours = (count: number): number => count * 3_600_000;

/** Six hours out — the gate's deadline, and the only wait in the run. */
export const GATE_AT = T0 + hours(6);

const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const REPO = '/home/u/proj';

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

const base = (id: string): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
});

const graph = {
  schemaId: 'DeFlow.plangraph.v1',
  runId: GATE_RUN,
  version: 1,
  planHash: PLAN_HASH,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-04T12:00:00.000Z',
  nodes: [
    {
      ...base(GATE),
      type: 'human',
      prompt: 'Approve the migration scope?',
      options: [
        { id: 'approve', label: 'Approve', effect: 'approve' },
        { id: 'reject', label: 'Reject', effect: 'reject' },
      ],
      deadline: { wakeAt: new Date(GATE_AT).toISOString(), onTimeout: 'escalate' },
    },
    {
      ...base(SIDEKICK),
      type: 'agent',
      brief: 'survey the auth surface',
      provider: { prefer: ['claude-code'], requires: [] },
      resume: 'always-replay',
    },
  ],
  edges: [],
};

const draft = (kind: string, payload: unknown, extra: Partial<EventDraft> = {}): EventDraft => ({
  runId: GATE_RUN,
  ts: T0,
  kind,
  v: 1,
  epoch: 1,
  payload,
  ...extra,
});

/** The ledger up to the instant the gate goes to sleep for six hours. */
export function seedGateRun(db: Db): void {
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
    draft(
      'node.started',
      { node: GATE, attempt: 0, ikey: `${GATE_RUN}/${GATE}/0/0` },
      { nodeId: GATE, attempt: 0 },
    ),
    draft(
      'human.requested',
      {
        node: GATE,
        prompt: 'Approve the migration scope?',
        options: [
          { id: 'approve', label: 'Approve', effect: 'approve' },
          { id: 'reject', label: 'Reject', effect: 'reject' },
        ],
      },
      { nodeId: GATE },
    ),
    draft(
      'node.suspended',
      { node: GATE, until: { kind: 'human', wakeAt: new Date(GATE_AT).toISOString() } },
      { nodeId: GATE },
    ),
  ]);
}

/** The event the human eventually appends — the one that consumes the wake. */
export const respondedAt = (at: number): EventDraft =>
  draft(
    'human.responded',
    { node: GATE, optionId: 'approve', at: new Date(at).toISOString() },
    { nodeId: GATE, ts: at },
  );
