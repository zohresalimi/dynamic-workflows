/**
 * KAR-19.4 — the plan's nodes actually execute, driven off the ticker.
 *
 * `executeRun` has been a complete, tested loop since KAR-06.9 and its only
 * callers were a test harness and two fixture scripts. KAR-19.3 gave the
 * pre-execution chain a shipped caller and stopped one step short: a run was
 * framed, gated, pinned, surveyed and compiled into a validated `PlanGraph`,
 * and then nothing happened to it. So what is asserted here is never *"does
 * `executeRun` schedule correctly"* — EPIC-06's suite settles that — but
 * *"does anything call it, off the ticker, over the plan the previous step
 * compiled, and does the run end saying which end it reached"*.
 *
 * Integration and file-backed, because every claim is about a boundary: a real
 * `submitTask`, the real run driver consuming its own wake, the real framing →
 * recon → planner chain, a real SQLite file that can be closed and reopened
 * between two daemon lives, real `io_chunk` rows on the data plane.
 *
 * The three chain agents are **ports**, scripted, exactly as
 * `./live-chain.test.ts` scripts them, and so is the node performer. What a
 * scripted performer cannot prove — that a vendor CLI streams — is EPIC-05's
 * conformance battery and is not re-litigated here; what it does prove is that
 * the daemon drives one, that the events land in the order an operator watches,
 * and that the run reaches exactly one terminal statement.
 *
 * Verifies: EPIC-19-S24, EPIC-19-S27, EPIC-19-S28, EPIC-19-S29, EPIC-19-S30,
 * EPIC-19-S31, EPIC-19-S32 · KAR-19.4 AC1, AC2, AC5, AC6, AC7, AC8, AC9 ·
 * test plan #1, #4, #5, #6, #7, #8
 */

import { shimCapabilityRow } from '@DeFlow/adapters';
import type {
  Db,
  Handle,
  NodeId,
  RunId,
  RunState,
  StartNode,
  StructuredOutput,
} from '@DeFlow/core';
import {
  EVENT_CURRENT_VERSIONS,
  HandleSchema,
  ikey as makeIkey,
  NodeFailureError,
  NodeIdSchema,
  openHumanGates,
  seededRandom,
} from '@DeFlow/core';
import {
  appendEvents,
  appendIoChunk,
  blobHandle,
  bumpEpoch,
  type EventDraft,
  openLedger,
  readIoChunks,
  readRange,
  recordProviderCapabilities,
  replayRun,
  spillBytes,
} from '@DeFlow/ledger';
import { GIT_ENV, it, makeRepo, TestClock } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { systemClock } from '../../src/clock.ts';
import { createRunDriver, type RunDriver } from '../../src/drive.ts';
import { createEffectRunner } from '../../src/effects/durable.ts';
import type { ExecContext } from '../../src/exec/run-executor.ts';
import type { FramingAgent } from '../../src/framing/interview.ts';
import { Git } from '../../src/git/git.ts';
import { RefFormatChecker } from '../../src/git/ref-format.ts';
import { WorkspaceManager } from '../../src/git/worktree-manager.ts';
import { respondToHumanNode } from '../../src/human/gate.ts';
import { submitTask } from '../../src/intake/intake.ts';
import {
  createRunChain,
  type RunChainContext,
  type RunChainResolver,
} from '../../src/pipeline/run-chain.ts';
import { createRunExecution, type RunExecutionContext } from '../../src/pipeline/run-execution.ts';
import type { PlannerAgent } from '../../src/plan/compile.ts';
import type { ReconAgent } from '../../src/recon/recon.ts';
import { loadSchemaDirectory } from '../../src/schema-store.ts';
import { approveSpec } from '../../src/spec/gate.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';

/** The repository's own emitted documents — the bytes `DeFlow init` copies. */
const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));

const T0 = 1_754_470_000_000;
const PROVIDER = 'claude';
const RANDOM = seededRandom(19);

const RAW_TASK = 'Migrate the design system to Vue 3. Keep the public component API stable.';

const present = (value: unknown): StructuredOutput => ({ present: true, value });

const eventVersionOf = (kind: string): number =>
  (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)[kind] ?? 1;

/** A `DeFlow.taskspecdraft.v1` the criteria contract accepts. */
const DRAFT = {
  schemaId: 'DeFlow.taskspecdraft.v1',
  goal: 'Migrate every component under packages/ui to Vue 3 with no public API change.',
  scope: { included: ['packages/ui'], paths: ['packages/ui/src/**'] },
  nonGoals: ['Do not touch packages/legacy.'],
  constraints: ['No new runtime dependency.'],
  priorDecisions: [],
  acceptanceCriteria: [
    { id: 'ac-1', statement: 'pnpm typecheck passes.', verifiedBy: ['typecheck'] },
    { id: 'ac-2', statement: 'pnpm build passes.', verifiedBy: ['build'] },
  ],
  knownFailureModes: [
    {
      id: 'fm-1',
      description: 'A component silently loses its default slot.',
      detection: 'The snapshot suite for that component changes.',
    },
  ],
};

const RECON_SURVEY = present({
  schemaId: 'DeFlow.reconsurvey.v1',
  toolchain: { language: 'typescript', packageManager: 'pnpm' },
  commands: { test: 'pnpm test', build: 'pnpm build' },
});

const agentNode = (id: string, deps: readonly string[] = []) => ({
  id,
  title: `Do ${id}`,
  type: 'agent',
  deps: [...deps],
  lifecycle: 'active',
  reads: [{ kind: 'spec', section: 'goal' }],
  writes: [],
  permission: 'worktree',
  pathScopes: { write: ['packages/ui/**'] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `Do ${id}, carefully.`,
  provider: { prefer: ['claude'], requires: ['structuredOutput'] },
  resume: 'always-replay',
});

/** The gate that covers the draft's two criteria, so the plan validates. */
const gateNode = (deps: readonly string[]) => ({
  id: 'gate-acceptance',
  title: 'Check the acceptance criteria',
  type: 'gate',
  deps: [...deps],
  lifecycle: 'active',
  reads: [{ kind: 'spec', section: 'criteria' }],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.verdict.v2', maxTokens: 1500 },
  gate: { kind: 'deterministic', gateId: 'typecheck' },
  criteria: ['ac-1', 'ac-2'],
  independence: { notSessionOf: ['implement-a'], preferDifferentProvider: true },
});

/**
 * The four-node plan EPIC-19-S24 describes: three agent nodes that may run
 * together, and the gate that judges what they produced.
 */
const FOUR_NODE_PLAN = {
  schemaId: 'DeFlow.plangraph.v1',
  runId: 'run_00000000T000000Z_000000',
  version: 1,
  planHash: `sha256-${'0'.repeat(64)}`,
  parent: null,
  taskSpecHash: `sha256-${'1'.repeat(64)}`,
  createdBy: 'planner',
  createdAt: '2026-08-13T10:15:00.000Z',
  nodes: [
    agentNode('implement-a'),
    agentNode('implement-b'),
    agentNode('implement-c', ['implement-a']),
    gateNode(['implement-a', 'implement-b', 'implement-c']),
  ],
  edges: [],
};

const PLAN_NODES: readonly NodeId[] = ['implement-a', 'implement-b', 'implement-c'].map((id) =>
  NodeIdSchema.parse(id),
);
const GATE_NODE: NodeId = NodeIdSchema.parse('gate-acceptance');

/** The blocking `human` node EPIC-19-S30 puts between two agent nodes. */
const HUMAN_NODE: NodeId = NodeIdSchema.parse('approve-scope');

/**
 * EPIC-19-S30's plan: a `human` node with an agent node on either side of it.
 *
 * The sibling matters as much as the gate. A plan with only the gate in it
 * cannot tell *"the branch was blocked"* apart from *"there was nothing else to
 * do"*, and it is the second of those that the executor must not conclude on.
 */
const HUMAN_GATE_PLAN = {
  ...FOUR_NODE_PLAN,
  nodes: [
    agentNode('implement-before'),
    {
      id: HUMAN_NODE,
      title: 'Extend the migration scope?',
      type: 'human',
      deps: ['implement-before'],
      lifecycle: 'active',
      reads: [],
      writes: [],
      permission: 'read',
      pathScopes: { write: [] },
      returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
      prompt: 'Recon found 3 extra packages. Extend the migration scope?',
      options: [
        { id: 'yes', label: 'Extend scope', effect: 'approve' },
        { id: 'no', label: 'Keep scope as-is', effect: 'reject' },
      ],
    },
    agentNode('implement-after', [HUMAN_NODE]),
    gateNode(['implement-after']),
  ],
};

// ── the chain's three agents, scripted ───────────────────────────────────────

function scriptedChain(plan: unknown = FOUR_NODE_PLAN): {
  framing: FramingAgent;
  recon: ReconAgent;
  planner: PlannerAgent;
} {
  let framed = false;
  return {
    framing: {
      open() {
        if (framed) throw new Error('the framing agent was opened more than once');
        framed = true;
        return Promise.resolve({
          session: {
            steerable: false,
            answer: () => {
              throw new Error('no steering was scripted');
            },
            repair: () => {
              throw new Error('no repair was scripted');
            },
          },
          turn: { question: null, structuredOutput: present(DRAFT) },
        });
      },
    },
    recon: {
      open() {
        return Promise.resolve({
          session: {
            repair: () => {
              throw new Error('no recon repair was scripted');
            },
          },
          turn: { structuredOutput: RECON_SURVEY },
        });
      },
    },
    planner: {
      plan: () => Promise.resolve({ structuredOutput: present(plan) }),
    },
  };
}

// ── the node performer, scripted ─────────────────────────────────────────────

interface PerformerScript {
  /** Nodes whose every attempt fails permanently, with this taxonomy reason. */
  readonly failsPermanently?: ReadonlyMap<string, string>;
  /** What each node's completion reports having spent, in USD. */
  readonly costUsd?: number;
  /** The verdict the gate node records. Omitted means the gate says nothing,
   * which is what most scenarios here want. */
  readonly gateOutcome?: 'pass' | 'fail';
  /** Called as each node starts, with the run's state at that instant. */
  readonly onNodeStarted?: (node: NodeId, state: RunState) => void;
  /** Held by a node before it completes, so a spec can assert what the rest of
   * the daemon is doing while one is genuinely in flight. */
  readonly holdUntil?: Promise<void>;
}

interface Performed {
  readonly node: NodeId;
  readonly attempt: number;
}

/**
 * A performer that writes what a real one writes: `node.started`, the agent's
 * bytes on the **data plane**, then `node.completed` and the spend, in the
 * transaction KAR-14.1 requires them in.
 *
 * The events are the performer's because only the performer knows what the node
 * was — the same rule `run-executor.ts` states. What is under test above it is
 * that a shipped caller drives one at all.
 */
function scriptedPerformer(
  db: Db,
  runId: RunId,
  epoch: number,
  script: PerformerScript,
  performed: Performed[],
): (command: StartNode, ctx: ExecContext) => Promise<void> {
  return (command: StartNode, ctx: ExecContext): Promise<void> => {
    // Stamped with **this daemon life's** epoch, exactly as a real performer's
    // sink does. An event carrying an older one is skipped by the reducer
    // (@DeFlow/ledger's fencing), so a second life writing the first life's
    // epoch would produce a node that never appears to start.
    const append = (...drafts: readonly Omit<EventDraft, 'runId' | 'ts' | 'epoch'>[]): void => {
      appendEvents(
        db,
        drafts.map((draft) => ({ runId, ts: ctx.clock.now(), epoch, ...draft })),
      );
    };

    const { node, attempt } = command;
    performed.push({ node, attempt });
    const key = makeIkey(runId, node, attempt, 0);

    // The same two events, in the same order, as `runAcpNode` writes: the
    // scheduler's resolution of provider and permission, and then the start.
    append(
      {
        kind: 'node.scheduled',
        v: eventVersionOf('node.scheduled'),
        nodeId: node,
        attempt,
        payload: { node, provider: PROVIDER, model: 'claude-sonnet-4-6', permission: 'worktree' },
      },
      {
        kind: 'node.started',
        v: eventVersionOf('node.started'),
        nodeId: node,
        attempt,
        ikey: key,
        payload: {
          node,
          attempt,
          ikey: key,
          // Required by `node.started` v2. Omitting it appends happily and is
          // then **skipped at read time**, so the node never appears to have
          // started and every projection above this is quietly wrong.
          binary: { path: '/opt/DeFlow/claude', version: '2.1.220', sha256: 'b'.repeat(64) },
        },
      },
    );

    script.onNodeStarted?.(node, replayRun(db, runId).state);

    // The data plane, as it is produced: agent stdout never enters the `event`
    // table (KAR-03.4), so this is `io_chunk` and nothing else.
    appendIoChunk(db, {
      runId,
      nodeId: node,
      attempt: attempt + 1,
      stream: 'stdout',
      ts: ctx.clock.now(),
      data: new TextEncoder().encode(`${node}: working\n`),
    });

    // A gate node records its verdict as it resolves, before anything ends the
    // run — which is the whole of EPIC-19-S28's *"the verdict is live"*.
    if (node === GATE_NODE && script.gateOutcome !== undefined) {
      append({
        kind: 'gate.evaluated',
        v: eventVersionOf('gate.evaluated'),
        nodeId: node,
        attempt,
        payload: {
          gate: 'typecheck',
          node,
          verdict: {
            schemaId: 'DeFlow.verdict.v4',
            outcome: script.gateOutcome,
            gate: 'typecheck',
            evaluatedNode: PLAN_NODES[0] ?? node,
            by: { node, provider: PROVIDER, model: 'claude-sonnet-4-6' },
            // Read off the run rather than invented: `reduce` treats a verdict
            // whose `specHash` is not the run's current one as **void** — it
            // cannot be shown to have judged this contract — so a made-up hash
            // records a verdict the projection silently drops.
            specHash: replayRun(db, runId).state.specApproved?.specHash ?? '',
            criteria: [
              { id: 'ac-1', status: script.gateOutcome === 'pass' ? 'satisfied' : 'unsatisfied' },
              { id: 'ac-2', status: script.gateOutcome === 'pass' ? 'satisfied' : 'unsatisfied' },
            ],
            findings: [],
            summary:
              script.gateOutcome === 'pass' ? 'typecheck passed' : 'typecheck reported 3 errors',
          },
        },
      });
    }

    const reason = script.failsPermanently?.get(node);
    if (reason !== undefined) {
      return Promise.reject(
        new NodeFailureError(`${node} cannot be completed`, {
          reason,
          class: 'permanent',
          detail: { node },
        }),
      );
    }

    const costUsd = script.costUsd ?? 0;
    const spend: Omit<EventDraft, 'runId' | 'ts' | 'epoch'>[] =
      costUsd === 0
        ? []
        : [
            {
              kind: 'budget.consumed',
              v: eventVersionOf('budget.consumed'),
              nodeId: node,
              attempt,
              payload: {
                node,
                attempt,
                provider: PROVIDER,
                usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
                costUsd,
                authMode: 'subscription',
              },
            },
          ];

    const complete = (): void => {
      append(
        {
          kind: 'node.completed',
          v: eventVersionOf('node.completed'),
          nodeId: node,
          attempt,
          payload: {
            node,
            attempt,
            result: {
              status: 'completed',
              output: { summary: `${node} done` },
              outputSchemaId: 'DeFlow.finding.v1',
              usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
              costUsd,
              producedFacts: [],
              artifacts: [],
            },
          },
        },
        ...spend,
      );
    };

    // A node that is genuinely still working, when a spec asks for one. This is
    // what makes "the tick returned while the run was in flight" a claim rather
    // than a coincidence of a performer that finished before it was asked.
    if (script.holdUntil !== undefined) return script.holdUntil.then(complete);

    complete();
    return Promise.resolve();
  };
}

// ── the scene ────────────────────────────────────────────────────────────────

interface Scene {
  db: Db;
  /** This daemon life's epoch, as `bumpEpoch` handed it out. */
  epoch: number;
  readonly dataDir: string;
  readonly repoDir: string;
  readonly runId: RunId;
  readonly clock: TestClock;
  driver: RunDriver;
  readonly performed: Performed[];
  /**
   * A second daemon life over the same data directory.
   *
   * Closes this life's connection and opens a fresh one at a higher epoch, with
   * a driver and an executor that inherited nothing — which is the only honest
   * way to ask whether resume is a property of the ledger or of a process.
   */
  restart(): void;
  close(): void;
}

/** 12 files under packages/ui, plus a manifest recon can recognise. */
function uiFiles(): Record<string, string> {
  const files: Record<string, string> = {
    'package.json': '{"name":"ui","scripts":{"test":"vitest run","build":"vite build"}}\n',
  };
  for (let at = 1; at <= 12; at += 1) {
    files[`packages/ui/src/components/C${at}.vue`] = `<template><div>${at}</div></template>\n`;
  }
  return files;
}

function seedCapabilities(db: Db): void {
  recordProviderCapabilities(db, {
    provider: PROVIDER,
    version: '2.1.220',
    binarySha256: 'b'.repeat(64),
    binaryPath: '/opt/DeFlow/claude',
    capsJson: JSON.stringify({
      agentCapabilities: { loadSession: true, sessionCapabilities: { resume: true } },
    }),
    probedAt: T0,
  });
}

function chainResolver(input: {
  readonly db: Db;
  readonly dataDir: string;
  readonly repoDir: string;
  readonly epoch: number;
  readonly agents: ReturnType<typeof scriptedChain>;
}): RunChainResolver {
  const schemas = loadSchemaDirectory(SCHEMAS_DIR);
  const wrapped = new Git(input.repoDir, { env: GIT_ENV });

  return ({ runId }): Promise<RunChainContext | null> =>
    Promise.resolve({
      provider: PROVIDER,
      model: 'claude-sonnet-4-6',
      maxContext: 200_000,
      capabilityRow: shimCapabilityRow({
        provider: PROVIDER,
        version: '2.1.220',
        binaryPath: '/opt/DeFlow/claude',
        binarySha256: 'b'.repeat(64),
        probedAt: T0,
      }),
      agents: input.agents,
      schemas,
      registry: schemas,
      schemasDir: SCHEMAS_DIR,
      tokenizer: o200kTokenizer(),
      workspace: new WorkspaceManager({
        git: { run: (args, opts) => wrapped.run(args, opts) },
        db: input.db,
        clock: systemClock,
        epoch: input.epoch,
      }),
      refs: new RefFormatChecker(wrapped),
      runDir: join(input.dataDir, 'runs', runId),
      putSurvey: (bytes: Uint8Array): Handle =>
        HandleSchema.parse(
          blobHandle(spillBytes(input.dataDir, Buffer.from(bytes), 'application/json').sha256),
        ),
      readTaskSource: () => {
        throw new Error('every task in this file is inline; nothing should read the blob store');
      },
      captureEvidence: (text: string): Handle =>
        HandleSchema.parse(
          blobHandle(spillBytes(input.dataDir, Buffer.from(text, 'utf8'), 'text/plain').sha256),
        ),
    });
}

interface SceneOptions extends PerformerScript {
  readonly plan?: unknown;
  /**
   * A run cost ceiling, pinned before the run is framed.
   *
   * Before, rather than after the plan: the driver compiles and executes on the
   * same tick, and a ceiling set afterwards would be a ceiling the run had
   * already finished under. Which is also how it works in production —
   * `.DeFlow/config.yaml`'s ceiling is pinned when the run is created (KAR-14.2
   * AC1), not once the first node is in flight.
   */
  readonly runCeilingUsd?: number;
}

async function scene(tmp: string, options: SceneOptions = {}): Promise<Scene> {
  const repoDir = join(tmp, 'repo');
  await makeRepo({ dir: repoDir, files: uiFiles() });
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });

  const db = openLedger(dataDir);
  // The epoch comes from the ledger's own counter, as `boot()` takes it: a
  // constant here would be a first life stamping a number the second life's
  // `bumpEpoch` cannot exceed, and every event the second life wrote would be
  // fenced out — which is a property of the harness and not of the daemon.
  const epoch = bumpEpoch(db);
  seedCapabilities(db);
  const clock = new TestClock(T0);
  const agents = scriptedChain(options.plan ?? FOUR_NODE_PLAN);
  const chain = createRunChain({
    resolve: chainResolver({ db, dataDir, repoDir, epoch, agents }),
  });
  const performed: Performed[] = [];

  const submitted = await submitTask(
    {
      body: { input: { kind: 'text', text: RAW_TASK }, cwd: repoDir, permission: 'worktree' },
      by: 'cli',
    },
    { db, epoch, clock, dataDir, randomHex: () => '0a0a0a' },
  );
  if (submitted.outcome !== 'created') throw new Error('the submission was refused');
  const runId = submitted.runId;

  if (options.runCeilingUsd !== undefined) {
    appendCeiling(db, runId, clock.now(), epoch, options.runCeilingUsd);
  }

  const built: Scene = {
    db,
    epoch,
    dataDir,
    repoDir,
    runId,
    clock,
    driver: buildDriver({ db, clock, epoch, runId, options, performed, chain }),
    performed,
    restart(): void {
      built.db.close();
      const reopened = openLedger(dataDir);
      const next = bumpEpoch(reopened);
      built.db = reopened;
      built.epoch = next;
      built.driver = buildDriver({
        db: reopened,
        clock,
        epoch: next,
        runId,
        options,
        performed,
        // A fresh chain over the reopened connection, for the same reason the
        // driver is fresh: the second life shares nothing with the first.
        chain: createRunChain({
          resolve: chainResolver({ db: reopened, dataDir, repoDir, epoch: next, agents }),
        }),
      });
    },
    close: () => built.db.close(),
  };
  return built;
}

/**
 * One daemon life's driver over an already-open ledger.
 *
 * Factored out because AC9 needs a **second** one: a spec that reopens the same
 * data directory has to reach the run through a driver that inherited nothing
 * from the first, which is the whole claim.
 */
function buildDriver(input: {
  readonly db: Db;
  readonly clock: TestClock;
  readonly epoch: number;
  readonly runId: RunId;
  readonly options: SceneOptions;
  readonly performed: Performed[];
  readonly chain: ReturnType<typeof createRunChain>;
}): RunDriver {
  const { db, clock, epoch, runId } = input;
  const execution = createRunExecution({
    resolve: (): Promise<RunExecutionContext | null> =>
      Promise.resolve({
        perform: scriptedPerformer(db, runId, epoch, input.options, input.performed),
        effects: createEffectRunner({ db, clock, daemonStartedAt: T0, epoch }),
        random: RANDOM,
        // The clock is driven by the spec, never by the loop.
        tickStepMs: 0,
        tickMs: 1,
      }),
  });

  return createRunDriver({
    db,
    clock,
    epoch,
    runFraming: input.chain.runFraming,
    advanceRun: input.chain.advanceRun,
    executeNodes: execution.executeNodes,
  });
}

/**
 * Waits until this driver has no run in flight.
 *
 * The execution turn is deliberately **not** awaited by `tick()` — see
 * `EPIC-19-S24 — a running node does not stop the daemon` — so a spec that
 * asserted straight after a tick would be asserting about a run that had barely
 * started. `settle()` is the same call `boot()`'s shutdown makes, and for the
 * same reason: everything below it closes something a turn is holding.
 */
const untilIdle = (s: Scene): Promise<void> => s.driver.settle();

/** Submits, frames, approves and compiles — everything KAR-19.3 already does. */
async function driveToPlan(s: Scene, settle = true): Promise<void> {
  await s.driver.tick(s.clock.now());
  s.clock.advance(1_000);
  await approveSpec({ db: s.db, runId: s.runId, epoch: s.epoch, ts: s.clock.now(), by: 'cli' });
  s.clock.advance(1_000);
  await s.driver.tick(s.clock.now());
  if (!kinds(s.db, s.runId).includes('plan.proposed')) {
    throw new Error(`no plan was compiled: ${kinds(s.db, s.runId).join(' → ')}`);
  }
  // That same tick launched the run (`executeRuns` runs after `advanceRuns`),
  // and the launch is not awaited — so a caller that asserted here would be
  // asserting about a run that had barely started.
  if (settle) await untilIdle(s);
}

const kinds = (db: Db, runId: RunId): string[] =>
  readRange(db, runId, 0, 1_000).events.map((event) => event.kind);

const eventsOf = (db: Db, runId: RunId, kind: string) =>
  readRange(db, runId, 0, 1_000).events.filter((event) => event.kind === kind);

/**
 * What the run has spent so far, in the one cell this file's performer bills to.
 *
 * `costUsd` is four cells rather than a number on purpose (EPIC-14-S4):
 * subscription quota and real currency are different substances and adding them
 * would report a figure nobody is charged. Everything here is `subscription`.
 */
const spentSoFar = (state: RunState): number => state.budget.run.costUsd.subscription ?? 0;

const seqOf = (db: Db, runId: RunId, kind: string): number =>
  readRange(db, runId, 0, 1_000).events.find((event) => event.kind === kind)?.seq ?? -1;

/**
 * KAR-14.2 AC1 — the run's cost ceiling, as the ledger pins it.
 *
 * An event rather than a config read, and the same event sets it at creation
 * and raises it afterwards, because both are the same fact: what a running run
 * is measured against must survive the restart that so often follows the pause
 * it answered.
 */
function appendCeiling(db: Db, runId: RunId, ts: number, epoch: number, costUsd: number): void {
  appendEvents(db, [
    {
      runId,
      ts,
      kind: 'budget.ceiling.set',
      v: eventVersionOf('budget.ceiling.set'),
      epoch,
      payload: {
        scope: 'run',
        costUsd,
        wallclockMs: null,
        source: 'operator',
        hash: `sha256-${'e'.repeat(64)}`,
      },
    },
  ]);
}

/** The operator raising the ceiling that paused their run. */
const raiseRunCeiling = (s: Scene, costUsd: number): void =>
  appendCeiling(s.db, s.runId, s.clock.now(), s.epoch, costUsd);

/**
 * The operator's answer at the mid-plan human gate, through the shipped
 * responder.
 *
 * The result is asserted rather than discarded: a refusal appends nothing at
 * all by design, so a spec that ignored it would go on to prove that a run
 * nobody answered stayed blocked — which is true and is not the claim.
 */
function answerTheGate(s: Scene): void {
  const answered = respondToHumanNode({
    db: s.db,
    runId: s.runId,
    nodeId: HUMAN_NODE,
    optionId: 'yes',
    by: 'cli',
    epoch: s.epoch,
    ts: s.clock.now(),
  });
  expect(answered).toMatchObject({ status: 'ok' });
}

/** F4.4's other half: the operator says continue. */
function resumeRun(s: Scene): void {
  appendEvents(s.db, [
    {
      runId: s.runId,
      ts: s.clock.now(),
      kind: 'run.resumed',
      v: eventVersionOf('run.resumed'),
      epoch: s.epoch,
      payload: { by: 'user' },
    },
  ]);
}

// ── EPIC-19-S24 ──────────────────────────────────────────────────────────────

suite('EPIC-19-S24 — the plan executes and the run completes (AC1, AC2)', () => {
  it('drives every node to node.completed and appends one terminal event', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      await driveToPlan(s);

      // The tick that follows the plan is the one this story adds: before it,
      // a compiled plan sat there for ever.
      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());
      await untilIdle(s);

      const order = kinds(s.db, s.runId);
      expect(order).toContain('run.started');
      for (const node of [...PLAN_NODES, GATE_NODE]) {
        expect(eventsOf(s.db, s.runId, 'node.scheduled').map((e) => e.nodeId)).toContain(node);
        expect(eventsOf(s.db, s.runId, 'node.started').map((e) => e.nodeId)).toContain(node);
        expect(eventsOf(s.db, s.runId, 'node.completed').map((e) => e.nodeId)).toContain(node);
      }

      // AC1 — no node is started twice, including across a tick that arrived
      // before the performer's own `node.started` landed.
      expect(s.performed).toHaveLength(4);
      expect(new Set(s.performed.map((one) => one.node)).size).toBe(4);

      // AC2 — exactly one terminal statement, and it is a completion.
      expect(order.filter((kind) => kind === 'run.completed')).toHaveLength(1);
      expect(order).not.toContain('run.aborted');
      expect(replayRun(s.db, s.runId).state.status).toBe('completed');
    } finally {
      s.close();
    }
  });

  it('orders each node scheduled → started → completed', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      await driveToPlan(s);
      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());
      await untilIdle(s);

      for (const node of PLAN_NODES) {
        const scheduled = eventsOf(s.db, s.runId, 'node.scheduled').find((e) => e.nodeId === node);
        const started = eventsOf(s.db, s.runId, 'node.started').find((e) => e.nodeId === node);
        const completed = eventsOf(s.db, s.runId, 'node.completed').find((e) => e.nodeId === node);
        expect(scheduled?.seq).toBeLessThan(started?.seq ?? -1);
        expect(started?.seq).toBeLessThan(completed?.seq ?? -1);
      }
      // The terminal event is last, by construction rather than by luck.
      expect(seqOf(s.db, s.runId, 'run.completed')).toBeGreaterThan(
        Math.max(...eventsOf(s.db, s.runId, 'node.completed').map((e) => e.seq)),
      );
    } finally {
      s.close();
    }
  });

  it('writes the agent bytes to the data plane rather than to the ledger', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      await driveToPlan(s);
      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());
      await untilIdle(s);

      const page = readIoChunks(
        s.db,
        { runId: s.runId, nodeId: PLAN_NODES[0] ?? GATE_NODE, attempt: 1 },
        0,
        100,
      );
      const decoder = new TextDecoder();
      expect(page.chunks.map((chunk) => decoder.decode(chunk.data)).join('')).toContain(
        'implement-a: working',
      );
      // KAR-03.4 — and none of it reached the control plane.
      expect(kinds(s.db, s.runId).filter((kind) => kind === 'io_chunk')).toEqual([]);
    } finally {
      s.close();
    }
  });
});

// ── EPIC-19-S27 ──────────────────────────────────────────────────────────────

suite('EPIC-19-S27 — cost arrives as it happens, not at the end (AC5)', () => {
  it('reports a cost above zero and below the final one while nodes are still running', async ({
    tmp,
  }) => {
    const costs: number[] = [];
    const s = await scene(tmp, {
      costUsd: 0.25,
      onNodeStarted: (_node, state) => costs.push(spentSoFar(state)),
    });
    try {
      await driveToPlan(s);
      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());
      await untilIdle(s);

      const final = spentSoFar(replayRun(s.db, s.runId).state);
      expect(final).toBeCloseTo(1.0, 6);

      // Somewhere in the middle of the run the figure was already moving: the
      // ceiling in EPIC-14 can only pause a run it is watching.
      const midRun = costs.filter((cost) => cost > 0 && cost < final);
      expect(midRun.length).toBeGreaterThan(0);
      // `run.completed` is not the first frame that carries a number.
      expect(seqOf(s.db, s.runId, 'budget.consumed')).toBeLessThan(
        seqOf(s.db, s.runId, 'run.completed'),
      );
    } finally {
      s.close();
    }
  });
});

// ── EPIC-19-S29 ──────────────────────────────────────────────────────────────

suite('EPIC-19-S29 — a permanent failure ends the run with a named reason (AC7)', () => {
  it('carries the taxonomy reason on node.failed and never an empty one', async ({ tmp }) => {
    const s = await scene(tmp, {
      failsPermanently: new Map([['implement-b', 'safety.pathscope-violation']]),
    });
    try {
      await driveToPlan(s);
      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());
      await untilIdle(s);

      const failed = eventsOf(s.db, s.runId, 'node.failed');
      const reasons = failed.map(
        (event) => (event.payload as { failure?: { reason?: string } }).failure?.reason,
      );
      // The node that actually failed carries the reason the performer
      // classified, from the closed taxonomy (KAR-02.10) — not `internal`,
      // which is what `toNodeFailure`'s fallback would have written.
      expect(reasons).toContain('safety.pathscope-violation');
      // S29's real clause: **no** surface gets an empty reason. Every failure
      // on this run — including the ones a poisoned branch produces — is
      // answerable, because "run failed:" with nothing after it is silence
      // wearing a different hat.
      for (const reason of reasons) {
        expect(typeof reason).toBe('string');
        expect(reason).not.toBe('');
      }

      const state = replayRun(s.db, s.runId).state;
      expect(['completed', 'aborted']).toContain(state.status);
      expect(state.nodes['implement-b']?.failure?.reason).toBe('safety.pathscope-violation');
      // AC2 — one terminal statement, and it is not a completion.
      expect(kinds(s.db, s.runId).filter((kind) => kind === 'run.aborted')).toHaveLength(1);
    } finally {
      s.close();
    }
  });
});

// ── EPIC-19-S31 ──────────────────────────────────────────────────────────────

suite('EPIC-19-S31 — a budget ceiling pauses rather than fails (AC8)', () => {
  it('halts on run.needs_human with reason budget and leaves the run resumable', async ({
    tmp,
  }) => {
    // Below the plan's scripted spend: four nodes at $0.25 is a dollar, and the
    // ceiling is crossed somewhere in the middle.
    const s = await scene(tmp, { costUsd: 0.25, runCeilingUsd: 0.4 });
    try {
      await driveToPlan(s);

      const halted = replayRun(s.db, s.runId).state;
      // A pause, not an outcome: no terminal event at all, which is exactly
      // what makes the work already done still there to resume onto.
      expect(kinds(s.db, s.runId)).not.toContain('run.completed');
      expect(kinds(s.db, s.runId)).not.toContain('run.aborted');
      expect(halted.status).toBe('paused');
      expect(halted.needsHuman?.reason).toBe('budget');
      expect(kinds(s.db, s.runId)).toContain('budget.exceeded');

      const doneWhenPaused = eventsOf(s.db, s.runId, 'node.completed').map((e) => e.nodeId);
      expect(doneWhenPaused.length).toBeGreaterThan(0);
      expect(doneWhenPaused.length).toBeLessThan(4);

      // A tick that changes nothing does not re-drive a halted run: a fold a
      // second for as long as nobody answers is how a paused run becomes the
      // daemon's busiest one.
      s.clock.advance(1_000);
      const idle = await s.driver.tick(s.clock.now());
      expect(idle.executed).toEqual([]);

      // The operator raises the ceiling and says continue. The run continues
      // from where it stopped rather than restarting.
      const performedWhenPaused = s.performed.length;
      raiseRunCeiling(s, 10);
      resumeRun(s);
      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());
      await untilIdle(s);

      expect(replayRun(s.db, s.runId).state.status).toBe('completed');
      expect(s.performed).toHaveLength(4);
      // No completed node was executed a second time.
      expect(new Set(s.performed.map((one) => one.node)).size).toBe(4);
      expect(s.performed.length).toBeGreaterThan(performedWhenPaused);
    } finally {
      s.close();
    }
  });
});

// ── the ticker is not the run ────────────────────────────────────────────────

suite('EPIC-19-S24 — a running node does not stop the daemon (AC1)', () => {
  it('returns from the tick while the node is still working', async ({ tmp }) => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });

    const s = await scene(tmp, { holdUntil: held });
    try {
      // `driveToPlan`'s last tick compiles the plan *and* starts the run, so it
      // is the tick under test: it must come back while `implement-a` is still
      // inside its turn. Deliberately not settled — settling is the thing this
      // spec is asserting the tick does *not* do.
      await driveToPlan(s, false);

      // The claim. `startTicker` schedules the next tick only once this one has
      // settled (`src/ticker.ts`), so a driver that awaited `executeRun` would
      // freeze the whole daemon for the length of a node — no framing wake
      // dispatched, no stall reported, and KAR-19.6's cancel never carried out —
      // on a run that can legitimately take hours.
      expect(s.driver.executing).toBeGreaterThan(0);
      expect(kinds(s.db, s.runId)).not.toContain('run.completed');

      // And the daemon is still answering: another tick runs, and declines to
      // start the same run a second time.
      s.clock.advance(1_000);
      const second = await s.driver.tick(s.clock.now());
      expect(second.executed).toEqual([]);

      release();
      await untilIdle(s);
      expect(replayRun(s.db, s.runId).state.status).toBe('completed');
      // AC1 — one attempt per node, across both ticks.
      expect(s.performed).toHaveLength(4);
    } finally {
      release();
      await untilIdle(s);
      s.close();
    }
  });
});

// ── EPIC-19-S28 ──────────────────────────────────────────────────────────────

suite('EPIC-19-S28 — a failing gate is live, and the run says so (AC6)', () => {
  it('appends the verdict before the terminal event and classifies as exit 1', async ({ tmp }) => {
    const s = await scene(tmp, { gateOutcome: 'fail' });
    try {
      await driveToPlan(s);

      // The verdict is appended as the gate resolves, not summarised at the
      // end: both surfaces can show it before the run is over.
      const verdict = seqOf(s.db, s.runId, 'gate.evaluated');
      expect(verdict).toBeGreaterThan(0);
      expect(verdict).toBeLessThan(seqOf(s.db, s.runId, 'run.completed'));

      // The projection the CLI's one derivation reads. `classifyRun` itself is
      // `@DeFlow/cli`'s and is asserted there (`test/one-run-verdict.test.ts`
      // and `src/run/exit-codes.test.ts`); the daemon must not import the CLI,
      // and a second copy of the mapping here would be the fourth derivation
      // AC6 exists to forbid.
      const state = replayRun(s.db, s.runId).state;
      expect(state.status).toBe('completed');
      expect(state.gateVerdicts[GATE_NODE]).toMatchObject({ gate: 'typecheck', outcome: 'fail' });
      expect(state.gateVerdicts[GATE_NODE]?.summary).not.toBe('');
    } finally {
      s.close();
    }
  });

  it('records a pass as a pass on the same plan', async ({ tmp }) => {
    // The control. Without it, a fixture that wrote `fail` unconditionally
    // would satisfy the assertion above.
    const s = await scene(tmp, { gateOutcome: 'pass' });
    try {
      await driveToPlan(s);
      const state = replayRun(s.db, s.runId).state;
      expect(state.status).toBe('completed');
      expect(state.gateVerdicts[GATE_NODE]?.outcome).toBe('pass');
    } finally {
      s.close();
    }
  });
});

// ── EPIC-19-S30 ──────────────────────────────────────────────────────────────

suite('EPIC-19-S30 — a human gate mid-plan halts rather than concluding (AC2)', () => {
  it('stops at needs-human with the gate open and finishes once it is answered', async ({
    tmp,
  }) => {
    const s = await scene(tmp, { plan: HUMAN_GATE_PLAN });
    try {
      await driveToPlan(s);
      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());
      await untilIdle(s);

      // The executor's `HALTED_STATUSES` is what stops "nothing to do and
      // nothing in flight" from concluding a run whose plan is half unexecuted.
      const waiting = replayRun(s.db, s.runId).state;
      expect(kinds(s.db, s.runId)).not.toContain('run.completed');
      expect(kinds(s.db, s.runId)).toContain('human.requested');
      expect(openHumanGates(waiting)).toHaveLength(1);
      // The node behind the gate has not run.
      expect(s.performed.map((one) => one.node)).not.toContain('implement-after');

      s.clock.advance(1_000);
      answerTheGate(s);

      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());
      await untilIdle(s);

      expect(s.performed.map((one) => one.node)).toContain('implement-after');
      expect(replayRun(s.db, s.runId).state.status).toBe('completed');
    } finally {
      s.close();
    }
  });
});

// ── EPIC-19-S32 ──────────────────────────────────────────────────────────────

suite('EPIC-19-S32 — a second daemon life resumes the run (AC9)', () => {
  it('does not re-execute a completed node and reaches the same terminal state', async ({
    tmp,
  }) => {
    const s = await scene(tmp, { plan: HUMAN_GATE_PLAN });
    try {
      await driveToPlan(s);
      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());
      await untilIdle(s);

      const doneBefore = eventsOf(s.db, s.runId, 'node.completed').map((e) => e.nodeId);
      const performedBefore = [...s.performed];
      expect(doneBefore.length).toBeGreaterThan(0);
      expect(replayRun(s.db, s.runId).state.status).not.toBe('completed');

      // The daemon goes. A new one opens the same file at a higher epoch and
      // knows nothing at all about what the last one was doing.
      s.restart();
      expect(replayRun(s.db, s.runId).state.status).not.toBe('completed');

      s.clock.advance(1_000);
      answerTheGate(s);
      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());
      await untilIdle(s);

      // The run reaches the terminal state it would have reached uninterrupted…
      expect(replayRun(s.db, s.runId).state.status).toBe('completed');
      // …and the nodes the first life completed were not run again.
      const reRun = s.performed
        .slice(performedBefore.length)
        .filter((one) => doneBefore.includes(one.node));
      expect(reRun).toEqual([]);
      expect(eventsOf(s.db, s.runId, 'node.completed').map((e) => e.nodeId)).toEqual(
        expect.arrayContaining(doneBefore),
      );
    } finally {
      s.close();
    }
  });
});
