/**
 * A whole daemon, from `submitTask` to a node on a real process — the harness
 * `./live-execution-route.test.ts` established and `../live-permission-mediation.test.ts`
 * now shares.
 *
 * Shared rather than copied because both files are about the **production**
 * performer: `perform` comes from `createLiveRunExecution`, over a real fake
 * vendor CLI on a real `PATH` root, spawned with the environment
 * `buildChildEnv` really builds. A second copy of that assembly would drift,
 * and the thing it would drift away from is the only place either spec is
 * actually driving shipped code.
 *
 * The three pre-execution turns stay scripted. What is under test in both
 * callers is the node, not the chain.
 */

import { shimCapabilityRow } from '@DeFlow/adapters';
import type { Db, Handle, NodeId, RunId } from '@DeFlow/core';
import { HandleSchema, NodeIdSchema, seededRandom } from '@DeFlow/core';
import {
  blobHandle,
  bumpEpoch,
  openLedger,
  readRange,
  recordProviderCapabilities,
  spillBytes,
} from '@DeFlow/ledger';
import { GIT_ENV, makeRepo } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { systemClock } from '../../../src/clock.ts';
import { createRunDriver, type RunDriver } from '../../../src/drive.ts';
import type { FramingAgent } from '../../../src/framing/interview.ts';
import { Git } from '../../../src/git/git.ts';
import { RefFormatChecker } from '../../../src/git/ref-format.ts';
import { WorkspaceManager } from '../../../src/git/worktree-manager.ts';
import { submitTask } from '../../../src/intake/intake.ts';
import { createLiveRunExecution } from '../../../src/pipeline/live-nodes.ts';
import {
  createRunChain,
  type RunChainContext,
  type RunChainResolver,
} from '../../../src/pipeline/run-chain.ts';
import type { PlannerAgent } from '../../../src/plan/compile.ts';
import { resetConnectorServerCache } from '../../../src/providers/connector-servers.ts';
import type { ReconAgent } from '../../../src/recon/recon.ts';
import { loadSchemaDirectory } from '../../../src/schema-store.ts';
import { approveSpec } from '../../../src/spec/gate.ts';
import { o200kTokenizer } from '../../../src/tokens/tokenizer.ts';
import { installFakeVendorCli } from './fake-vendor.ts';

/** The repository's own emitted documents — the bytes `deflow init` copies. */
const SCHEMAS_DIR = fileURLToPath(new URL('../../../../../schemas/', import.meta.url));

export const T0 = 1_754_470_000_000;
export const PROVIDER = 'claude';
export const VERSION = '2.1.220';
export const RANDOM = seededRandom(235);
export const NODE: NodeId = NodeIdSchema.parse('survey-the-cookie');

export const RAW_TASK = 'Audit the session cookie flags. Report what you find; change nothing.';

const present = (value: unknown) => ({ present: true as const, value });

/** A `DeFlow.taskspecdraft.v1` the criteria contract accepts. */
export const DRAFT = {
  schemaId: 'DeFlow.taskspecdraft.v1',
  goal: 'Report every session cookie set without the Secure attribute.',
  scope: { included: ['packages/ui'], paths: ['packages/ui/src/**'] },
  nonGoals: ['Do not change any file.'],
  constraints: ['Read-only.'],
  priorDecisions: [],
  // Both criteria are `unverifiable`, with reasons — so the plan needs no gate
  // node, and these specs stay about the *agent* node rather than about running
  // `pnpm run typecheck` inside a fixture repository.
  acceptanceCriteria: [
    {
      id: 'ac-1',
      statement: 'Every cookie assignment under packages/ui is listed.',
      unverifiable: true,
      reason: 'Completeness of a survey has no automated harness in this repository.',
    },
    {
      id: 'ac-2',
      statement: 'No file under packages/ui changed.',
      unverifiable: true,
      reason: 'The read-only claim is enforced by the permission level, not by a gate.',
    },
  ],
  knownFailureModes: [
    {
      id: 'fm-1',
      description: 'A cookie set through a helper is missed.',
      detection: 'The helper appears in the report with no call sites.',
    },
  ],
};

const RECON_SURVEY = present({
  schemaId: 'DeFlow.reconsurvey.v1',
  toolchain: { language: 'typescript', packageManager: 'pnpm' },
  commands: { test: 'pnpm test', build: 'pnpm build' },
});

/**
 * The plan: one `read` agent node.
 *
 * `read` rather than `worktree` because that is the level the shim route is
 * *allowed* to serve — `shimCapabilityRow` says `mediatedExecution: false`
 * about itself and everything above `read` is refused before a process exists
 * (F5.4). A plan that asked for more on a shim-only machine would be testing
 * the refusal.
 */
export const READ_NODE = {
  id: NODE,
  title: 'Survey the cookie flags',
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [{ kind: 'spec', section: 'goal' }],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: 'List every cookie assignment under packages/ui.',
  provider: { prefer: [PROVIDER], requires: [] },
  resume: 'always-replay',
};

export const ONE_NODE_PLAN = {
  schemaId: 'DeFlow.plangraph.v1',
  runId: 'run_00000000T000000Z_000000',
  version: 1,
  planHash: `sha256-${'0'.repeat(64)}`,
  parent: null,
  taskSpecHash: `sha256-${'1'.repeat(64)}`,
  createdBy: 'planner',
  createdAt: '2026-08-24T00:15:00.000Z',
  nodes: [READ_NODE],
  edges: [],
};

/** The same plan, asking for a level the shim route may not serve. */
export const WRITE_NODE_PLAN = {
  ...ONE_NODE_PLAN,
  nodes: [{ ...READ_NODE, permission: 'worktree', pathScopes: { write: ['packages/ui/**'] } }],
};

/** What the shim fake answers with — a `DeFlow.finding.v1`-shaped document. */
export const FINDING = {
  id: 'f-1',
  severity: 'major',
  message: 'packages/ui/src/session.ts sets the session cookie without Secure',
  evidence: [],
};

/** One completed vendor turn: three streamed lines and a verified envelope. */
export const COMPLETING_SCENARIO = JSON.stringify({
  name: 'shim-execution-node',
  description: 'An ordinary headless turn that answers with the contracted document.',
  steps: [
    { type: 'chunks', count: 3, delayMs: 1, text: 'reading packages/ui' },
    { type: 'message', text: 'done' },
  ],
  result: {
    subtype: 'success',
    stopReason: 'end_turn',
    text: 'done',
    totalCostUsd: 0.0123,
    structuredOutput: FINDING,
  },
});

// ── the chain's three agents, scripted ───────────────────────────────────────

function scriptedChain(plan: unknown): {
  framing: FramingAgent;
  recon: ReconAgent;
  planner: PlannerAgent;
} {
  return {
    framing: {
      open: () =>
        Promise.resolve({
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
        }),
    },
    recon: {
      open: () =>
        Promise.resolve({
          session: {
            repair: () => {
              throw new Error('no recon repair was scripted');
            },
          },
          turn: { structuredOutput: RECON_SURVEY },
        }),
    },
    planner: { plan: () => Promise.resolve({ structuredOutput: present(plan) }) },
  };
}

/**
 * The row this daemon holds for the provider.
 *
 * Two shapes, and the difference is the whole of the 2026-08-24 incident's
 * third act. The shim row says `mediatedExecution: false` about itself; the
 * bridge row — what a real `claude-agent-acp` probe leaves — advertises no such
 * key at all, and KAR-05.2 reads an absent one as "not advertised", which is
 * admitted at every level. So which row is in the ledger decides what
 * *planning* will compile, and it says nothing whatever about which binary is
 * on this machine.
 */
export function capabilityRowFor(binaryPath: string, kind: SceneOptions['capabilities']) {
  if (kind === 'acp-bridge') {
    return {
      provider: PROVIDER,
      version: VERSION,
      binaryPath,
      binarySha256: 'b'.repeat(64),
      probedAt: T0,
      capsJson: JSON.stringify({
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: true } },
      }),
    };
  }
  return shimCapabilityRow({
    provider: PROVIDER,
    version: VERSION,
    binaryPath,
    binarySha256: 'b'.repeat(64),
    probedAt: T0,
  });
}

function chainResolver(input: {
  readonly db: Db;
  readonly dataDir: string;
  readonly repoDir: string;
  readonly epoch: number;
  readonly binaryPath: string;
  readonly capabilities: SceneOptions['capabilities'];
  readonly agents: ReturnType<typeof scriptedChain>;
}): RunChainResolver {
  const schemas = loadSchemaDirectory(SCHEMAS_DIR);
  const wrapped = new Git(input.repoDir, { env: GIT_ENV });

  return ({ runId }): Promise<RunChainContext | null> =>
    Promise.resolve({
      provider: PROVIDER,
      model: 'provider-default',
      maxContext: 200_000,
      capabilityRow: capabilityRowFor(input.binaryPath, input.capabilities),
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

// ── the scene ────────────────────────────────────────────────────────────────

export interface Scene {
  readonly db: Db;
  readonly epoch: number;
  readonly dataDir: string;
  readonly binDir: string;
  readonly repoDir: string;
  readonly runId: RunId;
  readonly driver: RunDriver;
  close(): void;
}

export interface SceneOptions {
  /** The plan the scripted planner returns. */
  readonly plan?: unknown;
  /** The vendor CLI's scripted invocation. */
  readonly scenario?: string;
  /** Install a second executable under `spec.bin`, so the ACP route opens. */
  readonly withAdapter?: 'mock-agent';
  /**
   * The scenario file the ACP mock agent is pointed at, when one is installed.
   *
   * The file need not exist yet: the wrapper only carries the path, and a spec
   * whose scenario mentions the node's worktree cannot know that path until the
   * run id exists. Write the file before driving.
   */
  readonly mockScenarioPath?: string;
  /**
   * Record the row an **ACP bridge** probe leaves — no `mediatedExecution`
   * key, so KAR-05.2 reads it as "not advertised" and admits every level.
   */
  readonly capabilities?: 'acp-bridge';
  /** Extra PATH roots after the fixture's own, for a scenario needing `sleep`. */
  readonly extraRoots?: readonly string[];
  /** The permission the task is submitted at. */
  readonly permission?: 'read' | 'worktree' | 'worktree+net' | 'full';
  /** Extra files in the fixture repository, beside the two every scene has. */
  readonly repoFiles?: Readonly<Record<string, string>>;
}

export async function scene(tmp: string, options: SceneOptions = {}): Promise<Scene> {
  // Every daemon life asks the vendor once; a fixture that inherited a previous
  // spec's answer would be reading a binary that no longer exists.
  resetConnectorServerCache();

  const repoDir = join(tmp, 'repo');
  await makeRepo({
    dir: repoDir,
    files: {
      'package.json': '{"name":"ui","scripts":{"test":"vitest run","build":"vite build"}}\n',
      'packages/ui/src/session.ts': 'export const cookie = "sid=1";\n',
      ...(options.repoFiles ?? {}),
    },
  });

  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const binDir = join(tmp, 'bin');

  const binaryPath = await installFakeVendorCli({
    binDir,
    name: 'claude',
    scenario: options.scenario ?? COMPLETING_SCENARIO,
    nowMs: T0,
  });
  if (options.withAdapter === 'mock-agent') {
    await installMockAcpAdapter(binDir, options.mockScenarioPath);
  }

  const db = openLedger(dataDir);
  const epoch = bumpEpoch(db);

  recordProviderCapabilities(db, capabilityRowFor(binaryPath, options.capabilities));

  const agents = scriptedChain(options.plan ?? ONE_NODE_PLAN);
  const chain = createRunChain({
    resolve: chainResolver({
      db,
      dataDir,
      repoDir,
      epoch,
      binaryPath,
      capabilities: options.capabilities,
      agents,
    }),
  });

  const submitted = await submitTask(
    {
      body: {
        input: { kind: 'text', text: RAW_TASK },
        cwd: repoDir,
        permission: options.permission ?? 'worktree',
      },
      by: 'cli',
    },
    { db, epoch, clock: systemClock, dataDir, randomHex: () => '0a0a0a' },
  );
  if (submitted.outcome !== 'created') throw new Error('the submission was refused');

  const execution = createLiveRunExecution({
    dataDir,
    clock: systemClock,
    providerRoots: [binDir, ...(options.extraRoots ?? [])],
    daemonEnv: process.env,
  });

  const driver = createRunDriver({
    db,
    clock: systemClock,
    epoch,
    runFraming: chain.runFraming,
    advanceRun: chain.advanceRun,
    executeNodes: execution.executeNodes,
    random: RANDOM,
  });

  return {
    db,
    epoch,
    dataDir,
    binDir,
    repoDir,
    runId: submitted.runId,
    driver,
    close: () => db.close(),
  };
}

/** The mock ACP agent, under the name `spec.bin` resolves — a different file. */
async function installMockAcpAdapter(binDir: string, mockScenarioPath?: string): Promise<string> {
  const bin = fileURLToPath(new URL('../../../../mock-agent/bin/mock-agent.ts', import.meta.url));
  return await installFakeVendorCli({
    binDir,
    name: 'claude-agent-acp',
    // With no scenario the mock serves its own default ACP conversation, which
    // is all the route case needs: the claim there is *which file was spawned*,
    // not what it said.
    scenario: '',
    ...(mockScenarioPath === undefined ? {} : { mockScenarioPath }),
    dialect: 'claude-stream-json',
    // A wrapper around the mock's own bin, not around the exec-shim fake.
    seed: '42',
    execTarget: bin,
  });
}

/** Submits, frames, approves and compiles — everything the chain already does. */
export async function driveToPlan(s: Scene): Promise<void> {
  await s.driver.tick(systemClock.now());
  await approveSpec({
    db: s.db,
    runId: s.runId,
    epoch: s.epoch,
    ts: systemClock.now(),
    by: 'cli',
  });
  await s.driver.tick(systemClock.now());
  if (!kinds(s.db, s.runId).includes('plan.proposed')) {
    throw new Error(
      `no plan was compiled: ${kinds(s.db, s.runId).join(' → ')}\n${JSON.stringify(
        eventsOf(s.db, s.runId, 'plan.validation_failed').map((event) => event.payload),
        null,
        2,
      )}`,
    );
  }
  await s.driver.settle();
}

export const kinds = (db: Db, runId: RunId): string[] =>
  readRange(db, runId, 0, 2_000).events.map((event) => event.kind);

export const eventsOf = (db: Db, runId: RunId, kind: string) =>
  readRange(db, runId, 0, 2_000).events.filter((event) => event.kind === kind);
