/**
 * KAR-23.5 — an execution node is driven down the route this machine can
 * actually serve.
 *
 * **The test that would have caught the 2026-08-24 incident.** On the first
 * real end-to-end execution, `chooseProvider` resolved claude with the *shim*
 * route and `liveAgentPerformer` spoke ACP JSON-RPC at the plain vendor CLI
 * anyway. The children never handshook: no `provider.session_opened`, no
 * terminal event, `run.stalled` as a false positive, and — because no `process`
 * row was ever written — a cooperative cancel that could not reach them, so
 * they outlived the run.
 *
 * Every one of those symptoms is a claim about a **process**, which is why
 * nothing here is scripted below the performer. `perform` comes from
 * `createLiveRunExecution` — the production performer, which no daemon spec
 * drove before this one — over a real fake vendor CLI on a real `PATH` root,
 * spawned with the environment `buildChildEnv` really builds. The three
 * pre-execution turns stay scripted, exactly as `./live-execution.test.ts`
 * scripts them: what is under test is the node, not the chain.
 *
 * The fake validates its own argv (`decideCli`), so a wrongly-shaped
 * `--session-id` or a `--json-schema` carrying a path where the vendor wants a
 * document exits non-zero before a byte of transcript. Completion is therefore
 * evidence about the invocation and not only about the parser.
 *
 * Verifies: KAR-23.5 — the shim route reaches `runShimNode`, the ACP route
 * spawns the *adapter* binary, an unservable route refuses in the ledger, and a
 * shim child dies with its run.
 */

import { shimCapabilityRow } from '@DeFlow/adapters';
import type { Db, Handle, NodeId, RunId } from '@DeFlow/core';
import { HandleSchema, NodeIdSchema, seededRandom } from '@DeFlow/core';
import {
  blobHandle,
  bumpEpoch,
  openLedger,
  readIoChunks,
  readProcesses,
  readRange,
  recordProviderCapabilities,
  replayRun,
  spillBytes,
} from '@DeFlow/ledger';
import { GIT_ENV, it, makeRepo, waitFor } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { systemClock } from '../../src/clock.ts';
import { createRunDriver, type RunDriver } from '../../src/drive.ts';
import type { FramingAgent } from '../../src/framing/interview.ts';
import { Git } from '../../src/git/git.ts';
import { RefFormatChecker } from '../../src/git/ref-format.ts';
import { WorkspaceManager } from '../../src/git/worktree-manager.ts';
import { submitTask } from '../../src/intake/intake.ts';
import { killRun } from '../../src/kill-switch.ts';
import { createLiveRunExecution } from '../../src/pipeline/live-nodes.ts';
import {
  createRunChain,
  type RunChainContext,
  type RunChainResolver,
} from '../../src/pipeline/run-chain.ts';
import type { PlannerAgent } from '../../src/plan/compile.ts';
import { resetConnectorServerCache } from '../../src/providers/connector-servers.ts';
import type { ReconAgent } from '../../src/recon/recon.ts';
import { loadSchemaDirectory } from '../../src/schema-store.ts';
import { approveSpec } from '../../src/spec/gate.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';
import { installFakeVendorCli } from './support/fake-vendor.ts';

/** The repository's own emitted documents — the bytes `deflow init` copies. */
const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));

const T0 = 1_754_470_000_000;
const PROVIDER = 'claude';
const VERSION = '2.1.220';
const RANDOM = seededRandom(235);
const NODE: NodeId = NodeIdSchema.parse('survey-the-cookie');

const RAW_TASK = 'Audit the session cookie flags. Report what you find; change nothing.';

const present = (value: unknown) => ({ present: true as const, value });

/** A `DeFlow.taskspecdraft.v1` the criteria contract accepts. */
const DRAFT = {
  schemaId: 'DeFlow.taskspecdraft.v1',
  goal: 'Report every session cookie set without the Secure attribute.',
  scope: { included: ['packages/ui'], paths: ['packages/ui/src/**'] },
  nonGoals: ['Do not change any file.'],
  constraints: ['Read-only.'],
  priorDecisions: [],
  // Both criteria are `unverifiable`, with reasons — so the plan needs no gate
  // node, and this spec stays about the *agent* node's route rather than about
  // running `pnpm run typecheck` inside a fixture repository.
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
 * the refusal, which the third case below does deliberately.
 */
const READ_NODE = {
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

const ONE_NODE_PLAN = {
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
const WRITE_NODE_PLAN = {
  ...ONE_NODE_PLAN,
  nodes: [{ ...READ_NODE, permission: 'worktree', pathScopes: { write: ['packages/ui/**'] } }],
};

/** What the fake answers with — a `DeFlow.finding.v1`-shaped document. */
const FINDING = {
  id: 'f-1',
  severity: 'major',
  message: 'packages/ui/src/session.ts sets the session cookie without Secure',
  evidence: [],
};

/** One completed vendor turn: three streamed lines and a verified envelope. */
const COMPLETING_SCENARIO = JSON.stringify({
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

/** A turn that ignores SIGTERM and never ends on its own. */
const WEDGED_SCENARIO = JSON.stringify({
  name: 'shim-execution-wedged',
  description: 'Installs a no-op SIGTERM handler and then never exits, so only SIGKILL ends it.',
  ignoreSigterm: true,
  hangForever: true,
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
 * Two shapes, and the difference is the whole of the incident's third act. The
 * shim row says `mediatedExecution: false` about itself; the bridge row — what
 * a real `claude-agent-acp` probe leaves — advertises no such key at all, and
 * KAR-05.2 reads an absent one as "not advertised", which is admitted at every
 * level. So which row is in the ledger decides what *planning* will compile,
 * and it says nothing whatever about which binary is on this machine.
 */
function capabilityRowFor(binaryPath: string, kind: SceneOptions['capabilities']) {
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

interface Scene {
  readonly db: Db;
  readonly epoch: number;
  readonly dataDir: string;
  readonly binDir: string;
  readonly runId: RunId;
  readonly driver: RunDriver;
  close(): void;
}

interface SceneOptions {
  /** The plan the scripted planner returns. */
  readonly plan?: unknown;
  /** The vendor CLI's scripted invocation. */
  readonly scenario?: string;
  /** Install a second executable under `spec.bin`, so the ACP route opens. */
  readonly withAdapter?: 'mock-agent';
  /**
   * Record the row an **ACP bridge** probe leaves — no `mediatedExecution`
   * key, so KAR-05.2 reads it as "not advertised" and admits every level.
   *
   * The incident's own machine: the probed row was the bridge's and the only
   * open route was the shim. Planning is validated against that row, so a
   * `worktree` node compiles — and the refusal has to happen at the node.
   */
  readonly capabilities?: 'acp-bridge';
  /** Extra PATH roots after the fixture's own, for a scenario needing `sleep`. */
  readonly extraRoots?: readonly string[];
}

async function scene(tmp: string, options: SceneOptions = {}): Promise<Scene> {
  // Every daemon life asks the vendor once; a fixture that inherited a previous
  // spec's answer would be reading a binary that no longer exists.
  resetConnectorServerCache();

  const repoDir = join(tmp, 'repo');
  await makeRepo({
    dir: repoDir,
    files: {
      'package.json': '{"name":"ui","scripts":{"test":"vitest run","build":"vite build"}}\n',
      'packages/ui/src/session.ts': 'export const cookie = "sid=1";\n',
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
  if (options.withAdapter === 'mock-agent') await installMockAcpAdapter(binDir);

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
      body: { input: { kind: 'text', text: RAW_TASK }, cwd: repoDir, permission: 'worktree' },
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

  return { db, epoch, dataDir, binDir, runId: submitted.runId, driver, close: () => db.close() };
}

/** The mock ACP agent, under the name `spec.bin` resolves — a different file. */
async function installMockAcpAdapter(binDir: string): Promise<string> {
  const bin = fileURLToPath(new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url));
  return await installFakeVendorCli({
    binDir,
    name: 'claude-agent-acp',
    // The mock agent reads no scenario here — with none it serves its own
    // default ACP conversation, which is all this case needs: the claim is
    // *which file was spawned*, not what it said.
    scenario: '',
    dialect: 'claude-stream-json',
    // A wrapper around the mock's own bin, not around the exec-shim fake.
    seed: '42',
    execTarget: bin,
  });
}

/** Submits, frames, approves and compiles — everything the chain already does. */
async function driveToPlan(s: Scene): Promise<void> {
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

const kinds = (db: Db, runId: RunId): string[] =>
  readRange(db, runId, 0, 2_000).events.map((event) => event.kind);

const eventsOf = (db: Db, runId: RunId, kind: string) =>
  readRange(db, runId, 0, 2_000).events.filter((event) => event.kind === kind);

// ── (a) the shim route reaches runShimNode ───────────────────────────────────

suite('KAR-23.5 — a shim-routed execution node runs through the shim', () => {
  it('opens a minted session, streams io and completes the node', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      await driveToPlan(s);

      const started = eventsOf(s.db, s.runId, 'node.started').find((e) => e.nodeId === NODE);
      expect(
        started,
        `the execution node never started: ${kinds(s.db, s.runId).join(' → ')}`,
      ).toBeDefined();

      // The uuid DeFlow minted, on the path where DeFlow mints it. `origin` is
      // what tells a reader which of the two adapter paths produced the id.
      expect(started?.payload).toMatchObject({
        session: { origin: 'minted' },
        binary: { path: join(s.binDir, 'claude') },
      });
      expect((started?.payload as { session: { id: string } }).session.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      // The transcript reached the data plane, under the 1-based attempt the
      // data plane counts in.
      const page = readIoChunks(s.db, { runId: s.runId, nodeId: NODE, attempt: 1 }, 0, 200);
      const transcript = page.chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join('');
      expect(transcript).toContain('reading packages/ui');

      // …and the control plane carries the shim's own phases, which only
      // `runShimNode` writes.
      const phases = eventsOf(s.db, s.runId, 'node.progress').map(
        (event) => (event.payload as { phase?: string }).phase,
      );
      expect(phases).toContain('shim.assistant');
      expect(phases).toContain('shim.result');

      // The node concluded, the spend landed, and the run said which end it
      // reached — the three things the incident's ledger never got.
      expect(eventsOf(s.db, s.runId, 'node.completed').map((e) => e.nodeId)).toContain(NODE);
      expect(kinds(s.db, s.runId)).toContain('budget.consumed');
      expect(replayRun(s.db, s.runId).state.status).toBe('completed');

      // Nothing is left holding a process row.
      expect(readProcesses(s.db).filter((row) => row.state === 'live')).toEqual([]);
    } finally {
      s.close();
    }
  });
});

// ── (b) the shim child dies with its run ─────────────────────────────────────

suite('KAR-23.5 — the kill switch reaches a shim child', () => {
  it('records the process group and kills it', async ({ tmp }) => {
    const s = await scene(tmp, { scenario: WEDGED_SCENARIO });
    try {
      // Not awaited: the child never exits on its own, so the claim is about
      // what the rest of the daemon can do while it is genuinely in flight.
      const driving = driveToPlan(s);

      await waitFor(
        () => readProcesses(s.db).some((row) => row.runId === s.runId && row.state === 'live'),
        { describe: 'a live process row for the shim child', timeoutMs: 20_000 },
      );
      const live = readProcesses(s.db).find((row) => row.runId === s.runId);
      expect(live?.nodeId).toBe(NODE);

      const report = await killRun(s.runId, {
        db: s.db,
        clock: systemClock,
        epoch: s.epoch,
        termGraceMs: 250,
        killGraceMs: 250,
      });
      // Not `nothing-running`: that is exactly what the incident's kill switch
      // answered while three vendor children were alive.
      expect(report.outcome).toBe('stopped');
      expect(report.survivors).toEqual([]);

      await driving;

      // The node is terminal — which of `node.cancelled` and a
      // `node.failed`-by-signal wins is a race between the canceller and the
      // runner's own `exited`, and both are honest terminals.
      const terminal = kinds(s.db, s.runId).filter(
        (kind) => kind === 'node.cancelled' || kind === 'node.failed',
      );
      expect(terminal.length).toBeGreaterThan(0);
      expect(readProcesses(s.db).filter((row) => row.state === 'live')).toEqual([]);
    } finally {
      s.close();
    }
  });
});

// ── (c) the shim route refuses a level DeFlow cannot enforce ─────────────────

suite('KAR-23.5 — the shim route refuses what it may not mediate', () => {
  it('fails a write node before a process exists, on the row the shim mints', async ({ tmp }) => {
    // The incident's exact machine: the probed row is the ACP bridge's — no
    // `mediatedExecution` key, so planning admits a `worktree` node — while the
    // only route this machine can open is the shim.
    const s = await scene(tmp, { plan: WRITE_NODE_PLAN, capabilities: 'acp-bridge' });
    try {
      await driveToPlan(s);

      const failed = eventsOf(s.db, s.runId, 'node.failed').find((e) => e.nodeId === NODE);
      expect(
        failed,
        `a write node on a shim-only machine must not run: ${kinds(s.db, s.runId).join(' → ')}`,
      ).toBeDefined();
      // On the shim, DeFlow is not in front of the vendor's file access at all,
      // so the row it mints says `mediatedExecution: false` and every level
      // above `read` is refused. Passing the permissive probed row here instead
      // would be the silent escalation KAR-05.8 AC8 forbids.
      expect((failed?.payload as { failure: { reason: string } }).failure.reason).toBe(
        'safety.permission-unschedulable',
      );
      // Refused before a spawn: no start, no bytes, no process.
      expect(eventsOf(s.db, s.runId, 'node.started').map((e) => e.nodeId)).not.toContain(NODE);
      expect(
        readIoChunks(s.db, { runId: s.runId, nodeId: NODE, attempt: 1 }, 0, 10).chunks,
      ).toEqual([]);
      expect(readProcesses(s.db).filter((row) => row.state === 'live')).toEqual([]);
      // And the run said which end it reached, rather than wedging.
      expect(replayRun(s.db, s.runId).state.status).not.toBe('running');
    } finally {
      s.close();
    }
  });
});

// ── (d) the ACP route spawns the adapter, not the vendor CLI ─────────────────

suite('KAR-23.5 — the ACP route spawns the ACP binary', () => {
  it('starts the node on claude-agent-acp and never on the vendor CLI', async ({ tmp }) => {
    const s = await scene(tmp, { withAdapter: 'mock-agent' });
    try {
      await driveToPlan(s);

      const started = eventsOf(s.db, s.runId, 'node.started').find((e) => e.nodeId === NODE);
      expect(
        started,
        `the execution node never started: ${kinds(s.db, s.runId).join(' → ')}`,
      ).toBeDefined();
      expect((started?.payload as { binary: { path: string } }).binary.path).toBe(
        join(s.binDir, 'claude-agent-acp'),
      );
      // …and the shim runner was not what ran it: its phases are absent.
      const phases = eventsOf(s.db, s.runId, 'node.progress').map(
        (event) => (event.payload as { phase?: string }).phase ?? '',
      );
      expect(phases.filter((phase) => phase.startsWith('shim.'))).toEqual([]);
      // The attempt concluded rather than hanging, and left no process behind.
      expect(
        kinds(s.db, s.runId).filter((kind) => kind === 'node.completed' || kind === 'node.failed')
          .length,
      ).toBeGreaterThan(0);
      expect(readProcesses(s.db).filter((row) => row.state === 'live')).toEqual([]);
    } finally {
      s.close();
    }
  });
});
