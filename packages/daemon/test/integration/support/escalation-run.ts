/**
 * KAR-13.4 AC8 / EPIC-13-S28 — the run that has both kinds of waiting in it.
 *
 * A `human` node suspended on a question nobody has answered, and an `agent`
 * node **running** with a permission escalation outstanding against a live ACP
 * session. That pairing is the entire scenario: after a `SIGKILL` the first must
 * still be pending and the second must not, because a human gate needs nothing
 * but a row and a permission escalation is bound to a process that is gone.
 *
 * Seeded as events rather than driven through the scheduler, because what is
 * under test is `recover()` — a function of the ledger state a crash left
 * behind — and the shortest honest way to state that state is to write it. Every
 * event here is one a real daemon appends, in the shape and at the version it
 * appends it.
 *
 * Shared by the spec and by the child process it `SIGKILL`s, so the run the
 * parent asserts about and the run the child wrote cannot drift apart.
 */
import type { Db, NodeId, RunId } from '@DeFlow/core';
import {
  NO_DEADLINE_WAKE_AT,
  NodeIdSchema,
  permissionEscalationPayload,
  RunIdSchema,
} from '@DeFlow/core';
import { appendEvents, appendEventsSchedulingWakes } from '@DeFlow/ledger';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ESCALATION_RUN: RunId = RunIdSchema.parse('run_20260810T110000Z_e5c413');

/** The blocking `human` node — durable, and must survive the crash. */
export const GATE: NodeId = NodeIdSchema.parse('approve-scope');
/** The running `agent` node whose escalation cannot survive it. */
export const AGENT: NodeId = NodeIdSchema.parse('implement');

export const T0 = 1_754_308_400_000;
export const EPOCH = 3;
export const SESSION_ID = 'sess_e5c413';
export const WORKTREE = '/tmp/deflow/wt/r1__implement';

const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const REPO = '/home/u/proj';

export const GATE_PROMPT = 'Recon found 3 extra packages. Extend the migration scope?';

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
  permission: 'worktree',
  pathScopes: { write: ['packages/ui/src/**'] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
});

function plan(): Record<string, unknown> {
  return {
    schemaId: 'DeFlow.plangraph.v1',
    runId: ESCALATION_RUN,
    version: 1,
    planHash: PLAN_HASH,
    parent: null,
    taskSpecHash: SPEC_HASH,
    createdBy: 'planner',
    createdAt: '2026-08-10T11:00:00.000Z',
    nodes: [
      {
        ...base(GATE),
        permission: 'read',
        type: 'human',
        prompt: GATE_PROMPT,
        options: [
          { id: 'yes', label: 'Extend scope', effect: 'approve' },
          { id: 'no', label: 'Keep scope as-is', effect: 'reject' },
        ],
      },
      {
        ...base(AGENT),
        type: 'agent',
        brief: 'Migrate the toast component to the new design system',
        provider: { prefer: ['mock'], requires: [] },
        resume: 'always-replay',
      },
    ],
    edges: [],
  };
}

/** The escalation payload the agent's `curl` produced, exactly as the daemon
 * would have written it — including the session id AC8's failure has to name. */
export const escalationPayload = (): ReturnType<typeof permissionEscalationPayload> =>
  permissionEscalationPayload({
    node: AGENT,
    level: 'worktree',
    request: {
      method: 'terminal/create',
      command: 'curl',
      args: ['-sS', 'https://registry.example.com/token'],
      cwd: WORKTREE,
    },
    cwd: WORKTREE,
    reason: { code: 'level-no-network' },
    pathScopes: ['packages/ui/src/**'],
    brief: 'Migrate the toast component to the new design system',
    enforcement: 'sandbox-runtime',
    sessionId: SESSION_ID,
  });

/**
 * The ledger a crashed daemon left behind: one suspended `human` node, one
 * `running` agent node, and a permission escalation open against the latter.
 */
export function seedEscalationRun(db: Db): void {
  appendEvents(db, [
    {
      runId: ESCALATION_RUN,
      ts: T0,
      kind: 'run.created',
      v: 1,
      epoch: EPOCH,
      payload: { spec: taskSpec, cwd: REPO, repo: { head: 'e83c516', branch: 'main' } },
    },
    {
      runId: ESCALATION_RUN,
      ts: T0,
      kind: 'run.spec.approved',
      v: 1,
      epoch: EPOCH,
      payload: { specHash: SPEC_HASH, by: 'ui' },
    },
    {
      runId: ESCALATION_RUN,
      ts: T0,
      kind: 'plan.proposed',
      v: 2,
      epoch: EPOCH,
      payload: { version: 1, planHash: PLAN_HASH, graph: plan(), by: 'planner' },
    },
    {
      runId: ESCALATION_RUN,
      ts: T0,
      kind: 'run.started',
      v: 1,
      epoch: EPOCH,
      payload: { planHash: PLAN_HASH },
    },
    {
      runId: ESCALATION_RUN,
      ts: T0,
      kind: 'node.scheduled',
      v: 1,
      epoch: EPOCH,
      nodeId: AGENT,
      attempt: 0,
      payload: { node: AGENT, attempt: 0, provider: 'mock', permission: 'worktree' },
    },
    {
      runId: ESCALATION_RUN,
      ts: T0,
      kind: 'node.started',
      v: 2,
      epoch: EPOCH,
      nodeId: AGENT,
      attempt: 0,
      payload: {
        node: AGENT,
        attempt: 0,
        ikey: `${ESCALATION_RUN}/${AGENT}/0/0`,
      },
    },
  ]);

  // The `human` node's own suspension: request, suspension and row together,
  // exactly as KAR-13.1's admission commits them.
  appendEventsSchedulingWakes(
    db,
    [
      {
        runId: ESCALATION_RUN,
        ts: T0,
        kind: 'human.requested',
        v: 5,
        epoch: EPOCH,
        nodeId: GATE,
        attempt: 0,
        payload: {
          node: GATE,
          prompt: GATE_PROMPT,
          options: [
            { id: 'yes', label: 'Extend scope', effect: 'approve' },
            { id: 'no', label: 'Keep scope as-is', effect: 'reject' },
          ],
        },
      },
      {
        runId: ESCALATION_RUN,
        ts: T0,
        kind: 'node.suspended',
        v: 1,
        epoch: EPOCH,
        nodeId: GATE,
        attempt: 0,
        payload: { node: GATE, until: { kind: 'wake', wakeAt: NO_DEADLINE_WAKE_AT } },
      },
    ],
    [
      {
        runId: ESCALATION_RUN,
        nodeId: GATE,
        wakeAt: NO_DEADLINE_WAKE_AT,
        reason: 'human_gate',
      },
    ],
  );

  // The escalation. No `node.suspended`: the agent node is still *running* —
  // its process is alive and its turn is parked on this answer, which is the
  // whole reason the answer cannot outlive the daemon.
  appendEventsSchedulingWakes(
    db,
    [
      {
        runId: ESCALATION_RUN,
        ts: T0,
        kind: 'human.requested',
        v: 5,
        epoch: EPOCH,
        nodeId: AGENT,
        attempt: 0,
        payload: escalationPayload(),
      },
    ],
    [
      {
        runId: ESCALATION_RUN,
        nodeId: AGENT,
        wakeAt: NO_DEADLINE_WAKE_AT,
        reason: 'human_gate',
      },
    ],
  );
}
