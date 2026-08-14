/**
 * What a run does *after* `DeFlow run` has submitted it, for the CLI specs that
 * have to watch one.
 *
 * ## Why this file exists at all
 *
 * Not because the daemon cannot drive a run — it can, and does: `boot()` starts
 * the ticker (KAR-19.1), `packages/daemon/src/pipeline/run-chain.ts` is
 * `compilePlanV1`'s one shipped caller (KAR-19.3), `.../run-execution.ts` is
 * `executeRun`'s (KAR-19.4), and both composition roots bind all three ports
 * (KAR-19.5). A `DeFlow run` on a machine with only the bundled agent goes all
 * the way to `run.completed`, and `e2e/smoke/live-run.test.ts` asserts exactly
 * that, end to end, against the built binary.
 *
 * It exists because **that is not what these specs are about**. EPIC-18 is a
 * *client* of the daemon (see the epic's "Out of scope"), and a CLI spec about
 * a resume cursor or a Ctrl-C window needs a run in a *known* state at a known
 * instant — not a run whose timing depends on how long three real agent
 * subprocesses take. So it does what
 * `packages/cli/test/integration/resume-cursor.test.ts` already does for
 * KAR-15.4: append the events a daemon would, through the daemon's own shipped
 * functions, onto the daemon's own write connection, while the CLI watches over
 * a real socket. The CLI cannot tell the difference, because there is none from
 * its side of the stream — which is the whole point of it being a client.
 *
 * Everything here goes through a **shipped** function (`openSpecApprovalGate`)
 * rather than hand-written rows, so a spec cannot quietly assert a shape the
 * daemon does not produce.
 */
import type { Db, NodeId, RunId, TaskSpecDraft } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema, seededRandom } from '@DeFlow/core';
import { createEffectRunner, executeRun, openSpecApprovalGate } from '@DeFlow/daemon';
import { appendEvents, listRunIds, readRange } from '@DeFlow/ledger';
import { TestClock } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The draft an operator reviews at the F1.3 gate. Synthetic, and small. */
export const DRAFT: TaskSpecDraft = {
  schemaId: 'DeFlow.taskspecdraft.v1',
  goal: 'Keep the checkout module compiling.',
  scope: { included: ['src'] },
  nonGoals: ['Do not touch anything outside src.'],
  constraints: [],
  priorDecisions: [],
  acceptanceCriteria: [
    { id: 'ac-1', statement: 'the project typechecks', verifiedBy: ['typecheck'] },
  ],
  knownFailureModes: [],
} as unknown as TaskSpecDraft;

export interface LedgerAt {
  readonly db: Db;
  readonly epoch: number;
  readonly ts: number;
}

/**
 * Opens the F1.3 spec approval gate on `runId`, the way the framing node's
 * completion does — which is what moves the reduced status to
 * `awaiting-spec-approval` and gives `--no-wait` something to exit 4 on.
 */
export function openSpecGate(runId: RunId, at: LedgerAt): void {
  openSpecApprovalGate({ db: at.db, runId, epoch: at.epoch, ts: at.ts, document: DRAFT });
}

/**
 * KAR-19.12 — the framing node's completion, as far as the gate is concerned:
 * `run.created` carrying the sealed spec, and then the gate over the draft.
 *
 * `openSpecGate` alone is enough for a spec that only watches the terminal, and
 * it is *not* enough for one that answers: `approveSpec` reads the run's current
 * spec out of `run.created` and refuses without one — which is what the real
 * chain always appends before opening the gate.
 */
export function framedRun(runId: RunId, at: LedgerAt & { readonly cwd: string }): void {
  appendEvents(at.db, [
    {
      runId,
      ts: at.ts,
      kind: 'run.created',
      v: 1,
      epoch: at.epoch,
      payload: { spec: taskSpec(), cwd: at.cwd, repo: { head: 'e83c516', branch: 'main' } },
    },
  ]);
  openSpecGate(runId, at);
}

/**
 * KAR-19.4 — a run with an approved spec and a one-node plan on it, ready for
 * the daemon's own executor to drive.
 *
 * One agent node, which is the smallest graph that is a plan rather than a
 * sketch. Seeded rather than framed for the reason in this file's header: no
 * provider on a hermetic machine can serve a schema-bearing framing turn yet.
 */
export function plannedRun(
  node: NodeId,
  at: LedgerAt & { readonly cwd: string; readonly runId?: RunId },
): RunId {
  const runId = at.runId ?? runIdFor(at.db);

  const planHash = `sha256-${'d'.repeat(64)}`;
  const specHash = `sha256-${'c'.repeat(64)}`;

  appendEvents(at.db, [
    {
      runId,
      ts: at.ts,
      kind: 'run.created',
      v: 1,
      epoch: at.epoch,
      payload: { spec: taskSpec(), cwd: at.cwd, repo: { head: 'e83c516', branch: 'main' } },
    },
    {
      runId,
      ts: at.ts,
      kind: 'run.spec.approved',
      v: 1,
      epoch: at.epoch,
      payload: { specHash, by: 'cli' },
    },
    {
      runId,
      ts: at.ts,
      kind: 'plan.proposed',
      v: 2,
      epoch: at.epoch,
      payload: {
        version: 1,
        planHash,
        graph: onePlanNode(runId, node, planHash, specHash),
        by: 'planner',
      },
    },
  ]);

  return runId;
}

/* -------------------------------------------------------------------------- *
 * a plan-level `human` node, suspended
 * -------------------------------------------------------------------------- */

/** The gate EPIC-19-S80's second scenario describes: a `human` node the *plan*
 * declared, which is not the F1.3 spec gate and is answered by a different
 * route. */
export const HUMAN_NODE: NodeId = NodeIdSchema.parse('confirm-scope');

export const HUMAN_NODE_PROMPT = 'Recon found two more packages. Keep going?';

/** Exactly the two the scenario names. `effect` is DeFlow's vocabulary about
 * what happens to the node; `continue` completes it and `stop` fails it. */
export const HUMAN_NODE_OPTIONS = [
  { id: 'continue', label: 'Keep going', effect: 'approve' },
  { id: 'stop', label: 'Stop here', effect: 'reject' },
] as const;

/**
 * KAR-19.12 AC4 — a run suspended on a plan `human` node, gate open.
 *
 * Driven to the gate by the **real scheduler** rather than by writing
 * `human.requested` and `node.suspended` by hand: which attempt a suspended
 * node is on is the fact the scenario's second Then clause is about, and a
 * hand-written pair would let the fixture choose the number the assertion then
 * checks. `decide()` returns the `SuspendNode` and `executeRun` commits the two
 * events and the `node_wake` row together, which is the state a real gate
 * leaves behind.
 *
 * `perform` throws because it must never be called: the plan has one node and
 * that node is the gate, so a performer that ran would mean the scheduler had
 * admitted a `human` node as work.
 */
export async function suspendedOnHumanNode(
  at: LedgerAt & { readonly cwd: string; readonly runId: RunId },
): Promise<void> {
  const planHash = `sha256-${'e'.repeat(64)}`;
  const specHash = `sha256-${'c'.repeat(64)}`;
  const { db, epoch, runId } = at;

  appendEvents(db, [
    {
      runId,
      ts: at.ts,
      kind: 'run.created',
      v: 1,
      epoch,
      payload: { spec: taskSpec(), cwd: at.cwd, repo: { head: 'e83c516', branch: 'main' } },
    },
    { runId, ts: at.ts, kind: 'run.spec.approved', v: 1, epoch, payload: { specHash, by: 'cli' } },
    {
      runId,
      ts: at.ts,
      kind: 'plan.proposed',
      v: 2,
      epoch,
      payload: {
        version: 1,
        planHash,
        graph: oneHumanNode(runId, planHash, specHash),
        by: 'planner',
      },
    },
    // The event that promotes a proposed plan to the executing one. Without it
    // the scheduler has nothing to decide about.
    { runId, ts: at.ts, kind: 'run.started', v: 1, epoch, payload: { planHash } },
  ]);

  await executeRun({
    db,
    runId,
    clock: new TestClock(at.ts),
    epoch,
    daemonStartedAt: at.ts,
    random: seededRandom(19),
    tickStepMs: 0,
    tickMs: 1,
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    effects: createEffectRunner({ db, clock: new TestClock(at.ts), daemonStartedAt: at.ts, epoch }),
    perform: () => {
      throw new Error('the human-gate fixture plans one node, and it is the gate');
    },
  });
}

function oneHumanNode(runId: RunId, planHash: string, specHash: string): Record<string, unknown> {
  return {
    schemaId: 'DeFlow.plangraph.v1',
    runId,
    version: 1,
    planHash,
    parent: null,
    taskSpecHash: specHash,
    createdBy: 'planner',
    createdAt: '2026-08-14T10:15:00.000Z',
    nodes: [
      {
        id: HUMAN_NODE,
        title: 'Confirm the widened scope',
        type: 'human',
        deps: [],
        lifecycle: 'active',
        reads: [],
        writes: [],
        permission: 'read',
        pathScopes: { write: [] },
        returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
        retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
        budget: {},
        prompt: HUMAN_NODE_PROMPT,
        options: HUMAN_NODE_OPTIONS.map((option) => ({ ...option })),
      },
    ],
    edges: [],
  };
}

/**
 * The `TaskSpec` `run.created` carries.
 *
 * Read off @DeFlow/core's own fixture rather than written here, for the reason
 * this whole file exists: a hand-built spec that misses a field is appended
 * happily and then **skipped at read time**, so the run reduces with no
 * repository on it and the daemon's executor correctly refuses to drive a run
 * it cannot locate. That failure is invisible until something asks why nothing
 * happened, which is the exact shape of the afternoon EPIC-19 is about.
 */
const TASK_SPEC: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

function taskSpec(): unknown {
  return TASK_SPEC;
}

function onePlanNode(
  runId: RunId,
  node: NodeId,
  planHash: string,
  specHash: string,
): Record<string, unknown> {
  const base = {
    lifecycle: 'active',
    reads: [],
    writes: [],
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
    retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
    budget: {},
  };
  return {
    schemaId: 'DeFlow.plangraph.v1',
    runId,
    version: 1,
    planHash,
    parent: null,
    taskSpecHash: specHash,
    createdBy: 'planner',
    createdAt: '2026-08-13T10:15:00.000Z',
    nodes: [
      {
        ...base,
        id: node,
        title: `Do ${node}`,
        type: 'agent',
        deps: [],
        permission: 'worktree',
        pathScopes: { write: ['src/**'] },
        brief: 'Keep the checkout module compiling.',
        provider: { prefer: ['claude'], requires: ['structuredOutput'] },
        resume: 'always-replay',
      },
    ],
    edges: [],
  };
}

/** The run this data directory already holds, or a fresh id for a fixture that
 * never submitted one. */
function runIdFor(db: Db): RunId {
  const [runId] = listRunIds(db);
  return runId ?? RunIdSchema.parse('run_20260813T101500Z_0a0a0a');
}

/**
 * The one run this data directory holds, once the CLI has created it.
 *
 * Polled rather than returned by the command, because the command is still
 * running: these specs press Ctrl-C at it, drop its socket and read its
 * transcript, all of which need the run id before it has exited.
 */
export async function waitForRun(db: Db, timeoutMs = 10_000): Promise<RunId> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [runId] = listRunIds(db);
    if (runId !== undefined && readRange(db, runId, 0, 1).events.length > 0) return runId;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no run appeared in the ledger within ${timeoutMs} ms`);
}
