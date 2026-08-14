/**
 * The run EPIC-06-S23 and EPIC-06-S24 are about, as a real ledger on disk.
 *
 * Two agent nodes that both declare a repository write, so they contend for
 * F5.2's single repo lock — which is what makes "resume re-admits under the
 * *same* semaphores" an observable claim rather than a restatement of "resume
 * admits". A run with one node could not tell the two apart.
 *
 * Shared by the specs and by the child process one of them SIGKILLs, so the run
 * the parent asserts about and the run the child wrote cannot drift.
 */
import { type Command, decide, initialRunState, type RunState } from '@DeFlow/core';
import type { Db, EventDraft } from '@DeFlow/ledger';
import { appendEvents, replayAll } from '@DeFlow/ledger';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CANCEL_RUN = 'run_20260805T130000Z_c41f9b';

export const AUTH = 'impl-auth';
export const ROUTER = 'impl-router';

/** The instant every fixture in this file is anchored to. */
export const T0 = 1_754_312_000_000;

export const REPO = '/home/u/proj';
/** The key F5.2's per-repository write lock is held under. */
export const REPO_LOCK = `repo:${REPO}`;

/** `node.started` records what was spawned; the schema requires all three
 * fields, and an event that fails to parse is one `replayAll` silently skips —
 * which would leave a "running" node looking `scheduled` to the scheduler. */
const BINARY = { path: '/usr/bin/deflow-mock-agent', version: '0.0.0', sha256: 'd'.repeat(64) };

const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

const writer = (id: string, scope: string): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  // A write permission plus a declared write scope is what makes a node
  // contend for the repository lock (KAR-06.2).
  permission: 'worktree',
  pathScopes: { write: [scope] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `implement ${id}`,
  provider: { prefer: ['mock'], requires: [] },
  resume: 'always-replay',
});

const graph = {
  schemaId: 'DeFlow.plangraph.v1',
  runId: CANCEL_RUN,
  version: 1,
  planHash: PLAN_HASH,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-05T13:00:00.000Z',
  nodes: [writer(AUTH, 'src/auth/**'), writer(ROUTER, 'src/router/**')],
  edges: [],
};

export const draft = (
  kind: string,
  payload: unknown,
  extra: Partial<EventDraft> = {},
): EventDraft => ({
  runId: CANCEL_RUN,
  ts: T0,
  kind,
  v: 1,
  epoch: 1,
  payload,
  ...extra,
});

/**
 * The ledger up to the instant `impl-auth` is mid-flight holding the repo lock.
 *
 * `impl-router` is ready and withheld, which is the state both stories start
 * from: a pause that admits nothing has to be distinguishable from a run with
 * nothing to admit.
 */
export function seedRunningRun(db: Db): void {
  appendEvents(db, [
    draft('run.created', { spec: taskSpec, cwd: REPO, repo: { head: 'e83c516', branch: 'main' } }),
    // KAR-10.3 AC3 — F1.3's gate. `decide()` admits nothing until the ledger
    // carries an approval, so a fixture for a run that is genuinely executing
    // has to carry the row every executing run has.
    draft('run.spec.approved', { specHash: SPEC_HASH, by: 'ui' }),
    draft('plan.proposed', { version: 1, planHash: PLAN_HASH, graph, by: 'planner' }),
    draft('run.started', { planHash: PLAN_HASH }),
    draft('node.lock.acquired', { node: AUTH, lock: 'repo', key: REPO_LOCK }, { nodeId: AUTH }),
    draft(
      'node.started',
      { node: AUTH, attempt: 0, ikey: `${CANCEL_RUN}/${AUTH}/0/0`, binary: BINARY },
      { nodeId: AUTH, attempt: 0 },
    ),
  ]);
}

export const pause = (by: 'user' | 'policy' = 'user'): EventDraft =>
  draft('run.paused', { by, reason: 'stepping away' });

export const resume = (): EventDraft => draft('run.resumed', { by: 'user' });

export const completeAuth = (): readonly EventDraft[] => [
  draft(
    'node.completed',
    {
      node: AUTH,
      attempt: 0,
      result: {
        status: 'completed',
        output: { summary: 'auth done' },
        outputSchemaId: 'DeFlow.artifact.v1',
        usage: { inputTokens: 10, outputTokens: 5, source: 'vendor-reported' },
        costUsd: 0.01,
        producedFacts: [],
        artifacts: [],
      },
    },
    { nodeId: AUTH, attempt: 0 },
  ),
  draft(
    'node.lock.released',
    { node: AUTH, lock: 'repo', key: REPO_LOCK },
    { nodeId: AUTH, attempt: 0 },
  ),
];

/** What one tick of the real loop did. */
export interface Tick {
  readonly now: number;
  readonly commands: readonly Command[];
}

/**
 * One tick: replay the ledger, `decide()` over it, and **perform** the lock and
 * start commands by appending the events they imply.
 *
 * Performing them rather than only counting them is what makes a pause a real
 * claim: a loop that never acted could not tell "nothing was admitted" from
 * "the loop was not running".
 */
export function makeLoop(db: Db) {
  const ticks: Tick[] = [];

  function tick(now: number): readonly Command[] {
    const state: RunState = replayAll(db).runs.get(CANCEL_RUN) ?? initialRunState();
    const commands = decide(state, now);
    const drafts: EventDraft[] = [];

    for (const command of commands) {
      if (command.kind === 'AcquireLock') {
        drafts.push(
          draft(
            'node.lock.acquired',
            { node: command.node, lock: command.lock, key: command.key },
            { nodeId: command.node, ts: now },
          ),
        );
      } else if (command.kind === 'ReleaseLock') {
        drafts.push(
          draft(
            'node.lock.released',
            { node: command.node, lock: command.lock, key: command.key, reason: command.reason },
            { nodeId: command.node, ts: now },
          ),
        );
      } else if (command.kind === 'StartNode') {
        drafts.push(
          draft(
            'node.started',
            {
              node: command.node,
              attempt: command.attempt,
              ikey: `${CANCEL_RUN}/${command.node}/${command.attempt}/0`,
              binary: BINARY,
            },
            { nodeId: command.node, attempt: command.attempt, ts: now },
          ),
        );
      }
    }

    if (drafts.length > 0) appendEvents(db, drafts);
    ticks.push({ now, commands });
    return commands;
  }

  return {
    tick,
    ticks,
    started: (): string[] =>
      ticks.flatMap((one) =>
        one.commands
          .filter((command) => command.kind === 'StartNode')
          .map((command) => command.node),
      ),
    state: (): RunState => replayAll(db).runs.get(CANCEL_RUN) ?? initialRunState(),
  };
}
