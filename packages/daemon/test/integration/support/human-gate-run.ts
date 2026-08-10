/**
 * KAR-13.1 — the run EPIC-13-S1 describes, as a real ledger on disk.
 *
 * Three branches and one gate, which is the minimum shape that can tell the
 * story apart from a paused run: `approve-scope` is the blocking `human` node,
 * `implement` depends on it and must not be admitted, and `recon` depends on
 * nothing and must keep going. A fixture with only the gate in it cannot
 * distinguish *"the branch was blocked"* from *"there was nothing else to do"*.
 *
 * Shared by the spec and by the child process it `SIGKILL`s, so the run the
 * parent asserts about and the run the child wrote cannot drift apart.
 */
import type { Clock, Db, NodeId, RunId, RunState, StartNode } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema, seededRandom } from '@DeFlow/core';
import { appendEvents, type EventDraft } from '@DeFlow/ledger';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createEffectRunner } from '../../../src/effects/durable.ts';
import { executeRun } from '../../../src/exec/run-executor.ts';

export const HUMAN_RUN: RunId = RunIdSchema.parse('run_20260810T090000Z_b71c04');

export const GATE: NodeId = NodeIdSchema.parse('approve-scope');
export const WRITER: NodeId = NodeIdSchema.parse('implement');
export const SIBLING: NodeId = NodeIdSchema.parse('recon');

/** The instant every fixture here is anchored to. */
export const T0 = 1_754_308_400_000;
export const EPOCH = 3;

export const hours = (count: number): number => count * 3_600_000;
export const days = (count: number): number => count * 86_400_000;

const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
/** Exported because a gate verdict is only admitted against the hash the run is
 * currently judged against, so a spec asserting about verdicts has to pin the
 * same one this fixture approved. */
export const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const REPO = '/home/u/proj';

export const PROMPT = 'Recon found 3 extra packages. Extend the migration scope?';

export const OPTIONS = [
  { id: 'yes', label: 'Extend scope', effect: 'approve' },
  { id: 'no', label: 'Keep scope as-is', effect: 'reject' },
  { id: 'amend', label: 'Supply the finding myself', effect: 'edit' },
  { id: 'guide', label: 'Answer with guidance', effect: 'inject' },
] as const;

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

const base = (id: string, deps: readonly string[] = []): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  deps: [...deps],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
});

/** A tool the performer never actually runs — the spec's performer completes
 * these nodes itself, because what is under test is admission, not execution. */
const TOOL = { kind: 'script', run: 'true' } as const;

export interface Deadline {
  readonly wakeAt: string;
  readonly onTimeout: 'fail' | 'escalate' | 'default';
  readonly default?: string;
}

export function humanPlan(deadline?: Deadline): Record<string, unknown> {
  return {
    schemaId: 'DeFlow.plangraph.v1',
    runId: HUMAN_RUN,
    version: 1,
    planHash: PLAN_HASH,
    parent: null,
    taskSpecHash: SPEC_HASH,
    createdBy: 'planner',
    createdAt: '2026-08-10T09:00:00.000Z',
    nodes: [
      {
        ...base(GATE),
        type: 'human',
        prompt: PROMPT,
        options: OPTIONS.map((option) => ({ ...option })),
        ...(deadline === undefined ? {} : { deadline }),
      },
      { ...base(WRITER, [GATE]), type: 'tool', tool: TOOL, effectClass: 'pure' },
      { ...base(SIBLING), type: 'tool', tool: TOOL, effectClass: 'pure' },
    ],
    edges: [{ from: GATE, to: WRITER, kind: 'control' }],
  };
}

/**
 * The ledger up to the instant the plan starts: approved spec, proposed plan,
 * started run. Everything after this is produced by the real scheduler.
 */
export function seedHumanRun(db: Db, deadline?: Deadline): void {
  appendEvents(db, [
    {
      runId: HUMAN_RUN,
      ts: T0,
      kind: 'run.created',
      v: 1,
      epoch: EPOCH,
      payload: { spec: taskSpec, cwd: REPO, repo: { head: 'e83c516', branch: 'main' } },
    },
    {
      runId: HUMAN_RUN,
      ts: T0,
      kind: 'run.spec.approved',
      v: 1,
      epoch: EPOCH,
      payload: { specHash: SPEC_HASH, by: 'ui' },
    },
    {
      runId: HUMAN_RUN,
      ts: T0,
      kind: 'plan.proposed',
      v: 2,
      epoch: EPOCH,
      payload: { version: 1, planHash: PLAN_HASH, graph: humanPlan(deadline), by: 'planner' },
    },
    {
      runId: HUMAN_RUN,
      ts: T0,
      kind: 'run.started',
      v: 1,
      epoch: EPOCH,
      payload: { planHash: PLAN_HASH },
    },
  ]);
}

export const RANDOM = seededRandom(13);

/**
 * Runs the plan until the gate blocks it, on the injected clock.
 *
 * Shared by the spec and by the child process it `SIGKILL`s, so both reach the
 * *same* ledger state by the same code path — the real `decide()`, the real run
 * executor, the real `node_wake` write.
 *
 * The performer completes every non-`human` node itself. What is under test is
 * admission and suspension rather than what a tool node does, and a real child
 * process here would forbid advancing the clock at all: node timeouts are
 * measured on the same injected clock, so a loop advancing it would time out a
 * command that was still working (docs/14-testing-strategy.md §8).
 */
export async function driveToTheGate(
  db: Db,
  clock: Clock,
  /** This daemon life's epoch. A restart stamps a higher one, and the reducer
   * skips events carrying an older one — so a second life driving the same run
   * has to say which life it is. */
  epoch: number = EPOCH,
  /** Where the crash harness aims its knife: the executor's own phase markers,
   * published as it performs each command (KAR-13.1 AC1). */
  phase?: (marker: string) => void,
): Promise<{ readonly started: readonly NodeId[]; readonly state: RunState }> {
  const started: NodeId[] = [];
  const result = await executeRun({
    db,
    runId: HUMAN_RUN,
    clock,
    epoch,
    daemonStartedAt: T0,
    random: RANDOM,
    // The clock is driven by the spec, never by the loop.
    tickStepMs: 0,
    tickMs: 1,
    sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
    effects: createEffectRunner({ db, clock, daemonStartedAt: T0, epoch }),
    ...(phase === undefined ? {} : { phase }),
    perform: (command: StartNode) => {
      started.push(command.node);
      completeNode(db, clock, command, epoch);
      return Promise.resolve();
    },
  });
  return { started, state: result.state };
}

/** The two events a performed node appends, without performing anything. */
function completeNode(db: Db, clock: Clock, command: StartNode, epoch: number): void {
  const ledger = { runId: HUMAN_RUN, epoch, ts: clock.now() };
  appendEvents(db, [
    {
      ...ledger,
      kind: 'node.started',
      v: 2,
      nodeId: command.node,
      attempt: command.attempt,
      payload: {
        node: command.node,
        attempt: command.attempt,
        ikey: `${HUMAN_RUN}/${command.node}/${String(command.attempt)}/0`,
      },
    },
    {
      ...ledger,
      kind: 'node.completed',
      v: 1,
      nodeId: command.node,
      attempt: command.attempt,
      payload: {
        node: command.node,
        attempt: command.attempt,
        result: {
          status: 'completed',
          output: { summary: `${command.node} done` },
          outputSchemaId: 'DeFlow.finding.v1',
          usage: { inputTokens: 0, outputTokens: 0, source: 'vendor-reported' },
          costUsd: 0,
          producedFacts: [],
          artifacts: [],
        },
      },
    },
  ] as EventDraft[]);
}
