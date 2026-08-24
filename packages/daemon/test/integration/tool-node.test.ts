/**
 * KAR-23.9 — a `tool` node of kind `script` is a node this daemon can perform.
 *
 * **The test that reproduces the second half of the 2026-08-24 incident.**
 * `run_20260824T110147Z_f21769` reached execution with a correctly-routed
 * daemon and died in under a second: its `branch-off-main` tool node failed
 * `internal`/`permanent` with *"nothing in this daemon knows how to perform a
 * tool node"*, and the other fifteen nodes followed it down as
 * `dependency.failed`. `byNodeType` composed `agent` and `gate` and nothing
 * else, so a whole node type the planner is free to emit — and does — had no
 * performer at all.
 *
 * Everything below the performer is real, for the reason
 * `./live-execution-route.test.ts` states: every symptom of that incident is a
 * claim about a **process**. `perform` comes from `createLiveRunExecution`, the
 * production composition; the worktree is a real git worktree; the ledger is
 * file-backed; the script is a real child. Only the three pre-execution turns
 * are scripted, because what is under test is the node.
 *
 * The wrapper on `PATH` is a stub that validates its own argv and then execs
 * (`./support/fake-srt.ts`), which is deliberately a claim about the
 * *invocation* and not about the operating system. Real confinement —
 * out-of-worktree writes denied, `~/.ssh` unreadable, egress refused — is
 * `./tool-node-sandbox.test.ts`, against the pinned wrapper.
 *
 * Verifies: KAR-23.9 — a script tool node runs, streams and completes; an
 * unperformable tool kind is refused before a worktree exists; a `mutating`
 * non-zero exit is never retried.
 */

import { shimCapabilityRow } from '@DeFlow/adapters';
import type {
  Db,
  EventSeq,
  Handle,
  NodeFailure,
  NodeId,
  PermissionLevel,
  RunId,
  StartNode,
} from '@DeFlow/core';
import {
  HandleSchema,
  initialRunState,
  NodeIdSchema,
  parsePlanGraph,
  RunIdSchema,
  seededRandom,
  toNodeFailure,
} from '@DeFlow/core';
import {
  blobHandle,
  bumpEpoch,
  openLedger,
  readEffect,
  readIoChunks,
  readProcesses,
  readRange,
  recordProviderCapabilities,
  replayRun,
  spillBytes,
} from '@DeFlow/ledger';
import { GIT_ENV, it, makeRepo } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { systemClock } from '../../src/clock.ts';
import { createRunDriver, type RunDriver } from '../../src/drive.ts';
import { createEffectRunner } from '../../src/effects/durable.ts';
import type { FramingAgent } from '../../src/framing/interview.ts';
import { nodeBranch, runRef } from '../../src/git/branch-name.ts';
import { Git } from '../../src/git/git.ts';
import { RefFormatChecker } from '../../src/git/ref-format.ts';
import { WorkspaceManager } from '../../src/git/worktree-manager.ts';
import { submitTask } from '../../src/intake/intake.ts';
import { createLiveRunExecution } from '../../src/pipeline/live-nodes.ts';
import {
  createRunChain,
  type RunChainContext,
  type RunChainResolver,
} from '../../src/pipeline/run-chain.ts';
import { toolNodePerformer } from '../../src/pipeline/tool-node.ts';
import type { PlannerAgent } from '../../src/plan/compile.ts';
import { resetConnectorServerCache } from '../../src/providers/connector-servers.ts';
import type { ReconAgent } from '../../src/recon/recon.ts';
import { loadSchemaDirectory } from '../../src/schema-store.ts';
import { approveSpec } from '../../src/spec/gate.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';
import { installStubSandboxRuntime, type SrtInvocation } from './support/fake-srt.ts';
import { installFakeVendorCli } from './support/fake-vendor.ts';

const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));

const T0 = 1_754_470_000_000;
const PROVIDER = 'claude';
const VERSION = '2.1.220';
const RANDOM = seededRandom(919);
const NODE: NodeId = NodeIdSchema.parse('branch-off-main');

const RAW_TASK = 'Cut the feature branch this work will land on.';

const present = (value: unknown) => ({ present: true as const, value });

/**
 * A framed spec whose criteria are both `unverifiable` with reasons, so the
 * plan needs no gate node and this file stays about the tool node rather than
 * about running a gate command inside a fixture repository.
 */
const DRAFT = {
  schemaId: 'DeFlow.taskspecdraft.v1',
  goal: 'Create the feature branch and report which branch is checked out.',
  scope: { included: ['.'], paths: ['**'] },
  nonGoals: ['Do not push anything.'],
  constraints: ['Local only.'],
  priorDecisions: [],
  acceptanceCriteria: [
    {
      id: 'ac-1',
      statement: 'A feature branch exists and is checked out in the node worktree.',
      unverifiable: true,
      reason: 'The branch is asserted by the run itself; no gate in this repository judges it.',
    },
  ],
  knownFailureModes: [
    {
      id: 'fm-1',
      description: 'The branch is cut from the wrong base.',
      detection: 'The reported branch name does not match the requested one.',
    },
  ],
};

const RECON_SURVEY = present({
  schemaId: 'DeFlow.reconsurvey.v1',
  toolchain: { language: 'typescript', packageManager: 'pnpm' },
  commands: { test: 'pnpm test', build: 'pnpm build' },
});

/** The node the incident actually died on, minus its `git` verbs — what is
 * under test is that a script node *runs at all*, in its own worktree. */
function toolNode(tool: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    id: NODE,
    title: 'Cut the feature branch',
    type: 'tool',
    deps: [],
    lifecycle: 'active',
    reads: [{ kind: 'spec', section: 'goal' }],
    writes: [],
    permission: 'worktree',
    pathScopes: { write: ['**'] },
    returns: { schemaId: 'DeFlow.toolresult.v1', maxTokens: 1500 },
    retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
    budget: {},
    tool,
    effectClass: 'mutating',
    ...over,
  };
}

const planOf = (node: Record<string, unknown>) => ({
  schemaId: 'DeFlow.plangraph.v1',
  runId: 'run_00000000T000000Z_000000',
  version: 1,
  planHash: `sha256-${'0'.repeat(64)}`,
  parent: null,
  taskSpecHash: `sha256-${'1'.repeat(64)}`,
  createdBy: 'planner',
  createdAt: '2026-08-24T00:15:00.000Z',
  nodes: [node],
  edges: [],
});

/** Builtins only: the child's `PATH` is DeFlow's replacement, and this file
 * puts only the fixture's own root and the system's on it. */
const WRITES_A_FILE = 'printf \'hello\' > out.txt && echo "ran-in $(pwd)"';

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

function chainResolver(input: {
  readonly db: Db;
  readonly dataDir: string;
  readonly repoDir: string;
  readonly epoch: number;
  readonly binaryPath: string;
  readonly agents: ReturnType<typeof scriptedChain>;
}): RunChainResolver {
  const schemas = loadSchemaDirectory(SCHEMAS_DIR);
  const wrapped = new Git(input.repoDir, { env: GIT_ENV });

  return ({ runId }): Promise<RunChainContext | null> =>
    Promise.resolve({
      provider: PROVIDER,
      model: 'provider-default',
      maxContext: 200_000,
      capabilityRow: shimCapabilityRow({
        provider: PROVIDER,
        version: VERSION,
        binaryPath: input.binaryPath,
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

// ── the scene ────────────────────────────────────────────────────────────────

interface Scene {
  readonly db: Db;
  readonly epoch: number;
  readonly dataDir: string;
  readonly binDir: string;
  readonly repoDir: string;
  readonly srtLog: string;
  readonly runId: RunId;
  readonly driver: RunDriver;
  close(): void;
}

async function scene(tmp: string, node: Record<string, unknown>): Promise<Scene> {
  resetConnectorServerCache();

  const repoDir = join(tmp, 'repo');
  await makeRepo({
    dir: repoDir,
    files: { 'README.md': '# fixture\n' },
  });

  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const binDir = join(tmp, 'bin');
  const srtLog = join(tmp, 'srt.log');

  const binaryPath = await installFakeVendorCli({
    binDir,
    name: 'claude',
    scenario: '',
    nowMs: T0,
  });
  await installStubSandboxRuntime({ binDir, log: srtLog });
  // The Linux prerequisites, so this spec asserts the tool performer rather
  // than the platform it happens to be running on. `checkSandboxDependencies`
  // looks for an executable file by name on the roots and never runs one; on
  // macOS it looks for nothing at all.
  for (const dependency of ['bwrap', 'socat']) {
    const path = join(binDir, dependency);
    await writeFile(path, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }

  const db = openLedger(dataDir);
  const epoch = bumpEpoch(db);

  recordProviderCapabilities(
    db,
    shimCapabilityRow({
      provider: PROVIDER,
      version: VERSION,
      binaryPath,
      binarySha256: 'b'.repeat(64),
      probedAt: T0,
    }),
  );

  const agents = scriptedChain(planOf(node));
  const chain = createRunChain({
    resolve: chainResolver({ db, dataDir, repoDir, epoch, binaryPath, agents }),
  });

  const submitted = await submitTask(
    {
      body: { input: { kind: 'text', text: RAW_TASK }, cwd: repoDir, permission: 'worktree' },
      by: 'cli',
    },
    { db, epoch, clock: systemClock, dataDir, randomHex: () => '0b0b0b' },
  );
  if (submitted.outcome !== 'created') throw new Error('the submission was refused');

  const execution = createLiveRunExecution({
    dataDir,
    clock: systemClock,
    // The fixture's own root first, then the system's: a script node runs with
    // the environment `buildChildEnv` builds, whose `PATH` is exactly this.
    providerRoots: [binDir, '/bin', '/usr/bin'],
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
    srtLog,
    runId: submitted.runId,
    driver,
    close: () => db.close(),
  };
}

/** Submits, frames, approves and compiles — everything the chain already does. */
async function driveToPlan(s: Scene): Promise<void> {
  await s.driver.tick(systemClock.now());
  await approveSpec({ db: s.db, runId: s.runId, epoch: s.epoch, ts: systemClock.now(), by: 'cli' });
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

const srtInvocations = async (path: string): Promise<SrtInvocation[]> => {
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as SrtInvocation);
};

// ── (a) a script tool node runs its script ───────────────────────────────────

suite('KAR-23.9 — a script tool node runs', () => {
  it('starts, streams its output, writes in its own worktree and completes', async ({ tmp }) => {
    const s = await scene(tmp, toolNode({ kind: 'script', run: WRITES_A_FILE, cwd: '.' }));
    try {
      await driveToPlan(s);

      // The incident's regression, first: the node reached a performer at all.
      const failures = eventsOf(s.db, s.runId, 'node.failed').map(
        (event) => (event.payload as { failure: { message: string } }).failure.message,
      );
      expect(failures.join('\n')).not.toContain('nothing in this daemon knows how to perform');

      const started = eventsOf(s.db, s.runId, 'node.started').find((e) => e.nodeId === NODE);
      expect(
        started,
        `the tool node never started: ${kinds(s.db, s.runId).join(' → ')}`,
      ).toBeDefined();
      // A bare sha256 — `parseEvent` refuses anything else on read, and an
      // event the ledger stores and the reader drops is the 2026-08-12 symptom.
      expect((started?.payload as { binary: { sha256: string } }).binary.sha256).toMatch(
        /^[0-9a-f]{64}$/,
      );
      // A tool node holds no session, and absence is the answer rather than a
      // gap (`NodeStartedSchema` documents exactly that).
      expect(started?.payload).not.toHaveProperty('session');

      // The transcript reached the data plane, under the 1-based attempt the
      // data plane counts in.
      const page = readIoChunks(s.db, { runId: s.runId, nodeId: NODE, attempt: 1 }, 0, 200);
      const transcript = page.chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join('');
      expect(transcript).toContain('ran-in');

      const completed = eventsOf(s.db, s.runId, 'node.completed').find((e) => e.nodeId === NODE);
      expect(
        completed,
        `the tool node never completed: ${kinds(s.db, s.runId).join(' → ')}`,
      ).toBeDefined();
      expect(
        (completed?.payload as { result: { output: { exitCode: number } } }).result.output.exitCode,
      ).toBe(0);

      // The script ran in the node's own worktree, not in the operator's
      // checkout. The worktree is gone by now — `remove` salvaged its dirt onto
      // the node branch — so the file is asserted where it landed.
      expect(existsSync(join(s.repoDir, 'out.txt'))).toBe(false);
      const git = new Git(s.repoDir, { env: GIT_ENV });
      const branch = nodeBranch(runRef(s.runId), NODE);
      const shown = await git.run(['show', `${branch}:out.txt`]);
      expect(shown.stdout).toBe('hello');

      // One journalled `shell` effect at ordinal 0 — the position `closeEffect`
      // looks at, so the executor and the performer agree by construction.
      expect(kinds(s.db, s.runId)).toContain('effect.started');
      const ikey = `${s.runId}/${NODE}/0/0`;
      expect(readEffect(s.db, ikey)?.kind).toBe('shell');
      expect(readEffect(s.db, ikey)?.state).toBe('done');

      // Nothing is left holding a process row.
      expect(readProcesses(s.db).filter((row) => row.state === 'live')).toEqual([]);
      expect(replayRun(s.db, s.runId).state.status).toBe('completed');
    } finally {
      s.close();
    }
  });

  it('wraps the script in the sandbox runtime, at the level the node declared', async ({ tmp }) => {
    const s = await scene(tmp, toolNode({ kind: 'script', run: WRITES_A_FILE, cwd: '.' }));
    try {
      await driveToPlan(s);

      const [invocation, ...rest] = await srtInvocations(s.srtLog);
      expect(invocation, 'the wrapper was never invoked').toBeDefined();
      expect(rest).toEqual([]);
      if (invocation === undefined) return;

      // One shell, chosen by DeFlow, with the plan's run line as a **single**
      // argv element — never interpolated into a second command line.
      expect(invocation.wrapped).toEqual(['/bin/sh', '-c', WRITES_A_FILE]);
      // `worktree`: the node's own tree is the only writable root, credentials
      // are denied by path, and nothing may leave the machine.
      expect(invocation.settings.filesystem.allowWrite).toHaveLength(1);
      expect(invocation.settings.filesystem.allowWrite[0]).toContain(NODE);
      expect(invocation.settings.filesystem.denyRead).toContain('~/.ssh/**');
      expect(invocation.settings.network.allowedDomains).toEqual([]);
      // The child's cwd is the worktree it may write — compared by suffix
      // because macOS resolves `/var` to `/private/var` under the child's feet
      // and `process.cwd()` reports the resolved form.
      expect(invocation.cwd.endsWith(invocation.settings.filesystem.allowWrite[0] ?? 'x')).toBe(
        true,
      );
      // DeFlowd's own environment never reaches it: `buildChildEnv`'s allowlist
      // is what the child sees, and this daemon's `PATH` is not the operator's.
      expect(invocation.envNames).not.toContain('DeFlow_FAKE_SCENARIO');
      expect(invocation.envNames).toContain('TMPDIR');
    } finally {
      s.close();
    }
  });
});

// ── (b) a non-zero exit, and what a mutating one may not do ──────────────────

suite('KAR-23.9 — a script that fails', () => {
  it('fails the node with its exit code, and a mutating one is never retried', async ({ tmp }) => {
    const s = await scene(
      tmp,
      toolNode({ kind: 'script', run: 'echo nope >&2; exit 3', cwd: '.' }),
    );
    try {
      await driveToPlan(s);

      const failed = eventsOf(s.db, s.runId, 'node.failed').find((e) => e.nodeId === NODE);
      expect(failed, `the node never failed: ${kinds(s.db, s.runId).join(' → ')}`).toBeDefined();
      const failure = (
        failed?.payload as {
          failure: { reason: string; class: string; detail?: { exitCode?: number } };
        }
      ).failure;
      expect(failure.reason).toBe('agent.nonzero-exit');
      expect(failure.detail?.exitCode).toBe(3);
      // `mutating`: a half-applied command must not be re-run by a ladder, so
      // the class is permanent and no backoff row is scheduled.
      expect(failure.class).toBe('permanent');
      expect(kinds(s.db, s.runId)).not.toContain('node.retry.scheduled');
      expect(eventsOf(s.db, s.runId, 'node.started').filter((e) => e.nodeId === NODE)).toHaveLength(
        1,
      );
      expect(readProcesses(s.db).filter((row) => row.state === 'live')).toEqual([]);
    } finally {
      s.close();
    }
  });
});

// ── (c) the run-time backstop, driven at the performer ───────────────────────

/**
 * The performer, entered directly with a hand-written plan.
 *
 * Deliberately not through the chain: from KAR-23.9 on, an `http` tool node and
 * a `full` one are refused at **plan time** (`TOOL_KIND_UNPERFORMABLE`), so a
 * planner can no longer produce one to drive. The run-time refusal still has to
 * exist and still has to be tested, because `byNodeType` routes on node *type*:
 * a plan compiled by an older build, a patch path, or a hand-written document
 * would otherwise fall into the script spawn path. Entering the performer is
 * the only way to ask that question at all.
 */
async function refusal(
  tmp: string,
  node: Record<string, unknown>,
): Promise<{ readonly failure: NodeFailure; readonly created: number }> {
  const repoDir = join(tmp, 'repo');
  await makeRepo({ dir: repoDir, files: { 'README.md': '# fixture\n' } });
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const binDir = join(tmp, 'bin');
  await installStubSandboxRuntime({ binDir, log: join(tmp, 'srt.log') });

  const db = openLedger(dataDir);
  try {
    const epoch = bumpEpoch(db);
    const runId = RunIdSchema.parse('run_20260824T110147Z_f21769');
    const parsed = parsePlanGraph({ ...planOf(node), runId });
    if (!parsed.success) throw new Error(JSON.stringify(parsed.issues, null, 2));

    const perform = toolNodePerformer(
      {
        dataDir,
        clock: systemClock,
        providerRoots: [binDir, '/bin', '/usr/bin'],
        daemonEnv: process.env,
      },
      repoDir,
    );

    const command: StartNode = {
      kind: 'StartNode',
      runId,
      node: NODE,
      attempt: 0,
      nodeType: 'tool',
      title: 'Cut the feature branch',
      provider: null,
      model: null,
      permission: (node.permission ?? 'worktree') as PermissionLevel,
      pathScopes: { write: ['**'] },
      worktree: null,
      retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
    };

    let thrown: unknown = null;
    try {
      await perform(command, {
        db,
        runId,
        clock: systemClock,
        epoch,
        daemonStartedAt: systemClock.now(),
        effects: createEffectRunner({
          db,
          clock: systemClock,
          daemonStartedAt: systemClock.now(),
          epoch,
        }),
        state: { ...initialRunState(), runId, plan: parsed.data },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown, 'the performer accepted a node it cannot perform').not.toBeNull();

    return {
      failure: toNodeFailure(thrown, {
        occurredAtEvent: 1 as EventSeq,
        attempt: 0,
        captureEvidence: () => `artifact://${'0'.repeat(64)}` as Handle,
      }),
      created: eventsOf(db, runId, 'workspace.worktree_created').length,
    };
  } finally {
    db.close();
  }
}

suite('KAR-23.9 — the run-time backstop refuses before a worktree exists', () => {
  it('refuses an http tool node as a missing capability, and provisions nothing', async ({
    tmp,
  }) => {
    const { failure, created } = await refusal(
      tmp,
      toolNode({ kind: 'http', method: 'POST', url: 'https://example.com/hook' }),
    );
    expect(failure.reason).toBe('adapter.capability-missing');
    expect(failure.class).toBe('permanent');
    expect(failure.message).toContain('http');
    expect(created).toBe(0);
  });

  it('refuses an mcp tool node the same way', async ({ tmp }) => {
    const { failure, created } = await refusal(
      tmp,
      toolNode({ kind: 'mcp', server: 'linear', tool: 'create_issue', args: {} }),
    );
    expect(failure.reason).toBe('adapter.capability-missing');
    expect(created).toBe(0);
  });

  it('refuses a `full` tool node outright — nothing authorises it', async ({ tmp }) => {
    // `fullPermissionIssues` has no production caller, so F5.4's per-run opt-in
    // authorises nothing today: a `full` script would be arbitrary shell as the
    // operator on the strength of a sentence a planner wrote.
    const { failure, created } = await refusal(
      tmp,
      toolNode({ kind: 'script', run: WRITES_A_FILE, cwd: '.' }, { permission: 'full' }),
    );
    expect(failure.reason).toBe('safety.permission-unschedulable');
    expect(failure.class).toBe('permanent');
    expect(failure.message).toContain('full is not a sandbox');
    expect(created).toBe(0);
  });

  it('refuses a cwd that escapes the worktree', async ({ tmp }) => {
    const { failure } = await refusal(
      tmp,
      toolNode({ kind: 'script', run: 'echo hi', cwd: '../../elsewhere' }),
    );
    expect(failure.reason).toBe('safety.pathscope-violation');
    expect(failure.class).toBe('permanent');
  });

  it('refuses a run line the F5.6 deny list turns away', async ({ tmp }) => {
    const { failure, created } = await refusal(
      tmp,
      toolNode({ kind: 'script', run: 'terraform apply -auto-approve', cwd: '.' }),
    );
    expect(failure.reason).toBe('safety.execution-boundary');
    expect(failure.class).toBe('permanent');
    expect(created).toBe(0);
  });

  it('refuses a force-push, which the sandbox alone cannot tell from a fetch', async ({ tmp }) => {
    // The sandbox gates by write-root and by domain. A push to a remote the
    // node is already allowed to reach looks exactly like a fetch to it, so
    // the deny list is the only layer that can refuse this — and it must be
    // reached for `git`, not just for the binaries in `DESTRUCTIVE_COMMANDS`.
    const { failure, created } = await refusal(
      tmp,
      toolNode({ kind: 'script', run: 'git push --force origin main', cwd: '.' }),
    );
    expect(failure.reason).toBe('safety.execution-boundary');
    expect(failure.class).toBe('permanent');
    expect(failure.detail).toMatchObject({ rule: 'git-push-force' });
    expect(created).toBe(0);
  });

  it('types a spawn that never happened as adapter.spawn-failed, not internal', async ({ tmp }) => {
    // A `cwd` inside the worktree that the worktree does not have: it passes
    // the path-scope check (it really is inside) and then `spawn` answers
    // `ENOENT` because there is nowhere to run. Permanent — the same directory
    // is missing on a retry — and untyped it would be `internal`, which puts
    // the fault on DeFlow rather than on the plan and tells the operator
    // nothing.
    const { failure } = await refusal(
      tmp,
      toolNode({ kind: 'script', run: 'echo hi', cwd: 'no-such-directory' }),
    );

    expect(failure.reason).toBe('adapter.spawn-failed');
    expect(failure.class).toBe('permanent');
  });
});

/**
 * KAR-23.13 — defence in depth, stated as a test rather than as a comment.
 *
 * Plan validation now refuses all three of these before a run starts, which is
 * where the 2026-08-24 incident should have ended. The performer's own copies
 * stay, because a plan reaches `perform()` by paths validation does not gate: a
 * resumed run, a plan document compiled by an older build, a hand-written
 * graph. Every assertion above this suite is the unmodified KAR-23.9 battery
 * and is the real regression guard on the refactor; this suite is the sentence
 * those assertions are proving.
 */
suite('KAR-23.13 — the performer still refuses, after the rules moved to core', () => {
  it('still refuses a full node at execution, before a worktree exists', async ({ tmp }) => {
    const { failure, created } = await refusal(
      tmp,
      toolNode({ kind: 'script', run: 'git checkout -b feature' }, { permission: 'full' }),
    );

    expect(failure.reason).toBe('safety.permission-unschedulable');
    expect(failure.class).toBe('permanent');
    expect(failure.message).toContain('full is not a sandbox');
    expect(created).toBe(0);
  });

  it('still refuses an unperformable kind at execution', async ({ tmp }) => {
    const { failure, created } = await refusal(
      tmp,
      toolNode({ kind: 'http', method: 'POST', url: 'https://example.com/hook' }),
    );

    expect(failure.reason).toBe('adapter.capability-missing');
    expect(created).toBe(0);
  });

  it('still refuses a deny-listed run line at execution', async ({ tmp }) => {
    const { failure, created } = await refusal(
      tmp,
      toolNode({ kind: 'script', run: 'terraform apply -auto-approve' }),
    );

    expect(failure.reason).toBe('safety.execution-boundary');
    expect(created).toBe(0);
  });

  it('reports the first refusal a two-fault node earns, in perform() order', async ({ tmp }) => {
    // `toolNodeRefusals` returns every refusal so the planner can repair a
    // two-fault node in one turn; a `NodeFailure` names one reason, and it is
    // the one this performer has always thrown.
    const { failure } = await refusal(
      tmp,
      toolNode({ kind: 'script', run: 'terraform apply' }, { permission: 'full' }),
    );

    expect(failure.reason).toBe('safety.permission-unschedulable');
  });
});
