/**
 * KAR-12.5 test plan #12 / EPIC-12-S29 — builds
 * `test/fixtures/runs/gate-failure-repair/` by **running the repair loop**.
 *
 * The fixture is what EPIC-16 and EPIC-17 develop their diff and verdict views
 * against, and §7's whole shape has to be visible in it: a gate that failed, the
 * fix node the failure earned, the two commits that fix node made, the gate
 * re-run from the deterministic tier, and the pass. A hand-authored ledger could
 * be made to *look* like that, and would stop resembling what DeFlow writes the
 * first time any of those payloads changed — which is the drift
 * `packages/ledger/scripts/build-compaction-fixture.ts` exists to prevent, and
 * this file follows it deliberately.
 *
 * So everything here is the production path. A real `git` repository with a real
 * type error in it; a real `tsc` behind a real gate definition discovered from
 * `.DeFlow/gates/`; DeFlowd's own `executeRun` loop; `applyGateRepair` and
 * `applyGateRerun` through the same policy engine and the same single plan-write
 * seam every other patch goes through; and a real agent process on the other
 * side of an ACP pipe, writing through the daemon's own `fs` and `terminal`
 * services. The only stand-in is the agent's *judgement* — the fix node is
 * driven by a scripted mock agent rather than a vendor model, because a fixture
 * that needed a paid API key would be a fixture nobody could rebuild.
 *
 * **The work happens under `/tmp`, and that is not incidental.** Every absolute
 * path a run records — the worktree, the gate command, the agent binary — ends
 * up in the committed ledger, and a fixture carrying a developer's home
 * directory is a privacy leak with a long half-life. Building under a fixed,
 * synthetic root makes every recorded path `/tmp/deflow-gate-failure-repair/…`,
 * which is portable, readable, and nobody's.
 *
 * Usage:
 *   node packages/daemon/scripts/build-gate-repair-fixture.ts [outDir] [workDir]
 */
import {
  DEFAULT_PATCH_RULE_SPECS,
  HandleSchema,
  type NodeId,
  type PlanGraph,
  PlanGraphSchema,
  type PlanTimeCapability,
  type ProviderId,
  planHash,
  type RunId,
  RunIdSchema,
  sealTaskSpec,
  seededRandom,
  type TaskSpec,
  type TaskSpecDraft,
} from '@DeFlow/core';
import {
  discoverGateDefinitions,
  type GateDefinition,
  gateVerdictsFromEvents,
  loadGateDefinition,
  milestoneStatus,
} from '@DeFlow/gates';
import {
  appendEvents,
  blobHandle,
  openLedger,
  persistPlanVersion,
  readEpoch,
  readRange,
  replayRun,
  spillBytes,
} from '@DeFlow/ledger';
import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { systemClock } from '../src/clock.ts';
import { createEffectRunner } from '../src/effects/durable.ts';
import { sqliteLedgerSink } from '../src/exec/ledger-sink.ts';
import { executeRun } from '../src/exec/run-executor.ts';
import { runFixNode } from '../src/gates/fix-node.ts';
import { byNodeType, gateNodePerformer } from '../src/gates/gate-performer.ts';
import { applyGateRepair, applyGateRerun } from '../src/gates/repair-loop.ts';
import { buildChildEnv } from '../src/proc/env.ts';
import { acpFsHandlers } from '../src/services/fronts/acp-fs.ts';
import { acpTerminalHandlers } from '../src/services/fronts/acp-terminal.ts';
import { createFsService } from '../src/services/fs-service.ts';
import { createTerminalService } from '../src/services/terminal-service.ts';
import { o200kTokenizer } from '../src/tokens/tokenizer.ts';

const exec = promisify(execFile);

/** The run every event in the fixture belongs to. Fixed, so a consumer can read
 * the fixture without discovering the id first. */
export const GATE_REPAIR_FIXTURE_RUN: RunId = RunIdSchema.parse('run_20260810T090000Z_9f31ab');

/** Where the committed copy lives, relative to this file. */
export const GATE_REPAIR_FIXTURE_DIR = fileURLToPath(
  new URL('../../../test/fixtures/runs/gate-failure-repair/', import.meta.url),
);

/**
 * Where the run is built. Synthetic and fixed: see the header — every absolute
 * path this run records ends up in the committed ledger.
 */
export const GATE_REPAIR_WORK_DIR = '/tmp/deflow-gate-failure-repair';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The compiler's own `bin/tsc`, not the workspace's `.bin/tsc` shim.
 *
 * pnpm's shim is a shell script that resolves `typescript` relative to *its
 * own* directory, so a link to it from another tree resolves nothing. The
 * package's real entry point is two lines of `require('../lib/tsc.js')`, and
 * Node resolves that against the link's realpath — which is what makes a
 * symlinked compiler work at all.
 */
const WORKSPACE_TSC = join(
  dirname(createRequire(import.meta.url).resolve('typescript')),
  '..',
  'bin',
  'tsc',
);
const MOCK_AGENT_BIN = join(REPO_ROOT, 'packages', 'mock-agent', 'bin', 'mock-agent.ts');

const PRODUCER: NodeId = 'impl-1' as NodeId;
const GATE_NODE: NodeId = 'gate-typecheck' as NodeId;
/**
 * The provider the fix node is routed onto.
 *
 * A real provider id with DeFlow's **mock agent binary** standing in for its
 * CLI — the fake-binary convention every adapter spec in this repository uses
 * (`linkFakeAgent`), and the reason is not convenience: the price table can
 * price `claude`, and a patch DeFlow cannot price is one it refuses to read as
 * cheap (KAR-14.3 AC7). Routing the fixture's repair onto an unpriceable
 * provider would make S29's *"decides auto because the node adds no permission
 * and costs under $5.00"* unreachable for a reason that has nothing to do with
 * repair. Nothing here talks to a vendor: the binary is the mock, and its
 * sha256 is in the ledger.
 */
const PROVIDER: ProviderId = 'claude' as ProviderId;
const MODEL = 'claude-sonnet-4-5';
const PLANNER = { model: 'a-model', effort: 'max', tier: 'strongest' } as const;
const POLICY_HASH = `sha256-${'e'.repeat(64)}`;

/** A fixed instant for the seeded prologue. The run itself is on the system
 * clock — there are live child processes, and a gate's timeout is measured on
 * the same clock the loop advances. */
const T0 = 1_754_812_800_000;

/** The hermetic `git` environment. Committed to by the fixture: a commit id
 * that moved with the wall clock would make every rebuild a different fixture. */
const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'DeFlow fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'DeFlow fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_AUTHOR_DATE: '2026-08-10T09:00:00Z',
  GIT_COMMITTER_DATE: '2026-08-10T09:00:00Z',
};

/** The producer's bug: a day count that returns the date it was given. */
const BUGGY = 'export function daysUntil(target: Date): number {\n  return target;\n}\n';

const FIXED =
  'export function daysUntil(target: Date): number {\n' +
  '  return Math.round(target.getTime() / 86_400_000);\n}\n';

/** The regression test the fix node writes **before** the fix. */
const REGRESSION =
  "import { daysUntil } from '../src/date-picker.ts';\n\n" +
  'export const days: number = daysUntil(new Date());\n';

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: 'es2024',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      allowImportingTsExtensions: true,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['src', 'test'],
  },
  null,
  2,
)}\n`;

/** The gate definition the repository ships, discovered and hashed like any
 * other. The command is **relative**: an absolute one would put this checkout's
 * path in the committed fixture. */
const TYPECHECK_YAML = `id: typecheck
kind: deterministic
title: TypeScript project check
run: node_modules/.bin/tsc -p tsconfig.json --noEmit --pretty false
cwd: worktree
timeout: 300s
effect: pure
permission: worktree
expect:
  exitCode: 0
findings:
  parser: tsc
satisfies: [ac-1]
severityFloor: error
`;

const SPEC_DRAFT = {
  schemaId: 'DeFlow.taskspecdraft.v1',
  goal: 'Return a day count from daysUntil, and keep the project compiling.',
  scope: { included: ['src', 'test'] },
  nonGoals: ['Do not touch anything outside src and test.'],
  constraints: [],
  priorDecisions: [],
  acceptanceCriteria: [
    { id: 'ac-1', statement: 'the project typechecks', verifiedBy: ['typecheck'] },
  ],
  knownFailureModes: [],
} as unknown as TaskSpecDraft;

/**
 * The rule table this run pins, as a project's `.DeFlow/config.yaml` would.
 *
 * DeFlow's shipped defaults queue a repair for approval; S29's *"the patch
 * policy engine decides auto because the node adds no permission and costs
 * under $5.00"* is a statement about a project that has opted into surgical
 * repairs. The arm sits **below** every escalate and reject arm the defaults
 * ship, so nothing it says can carry a patch past a permission escalation or
 * the execution boundary.
 */
const REPAIR_POLICY = [
  ...DEFAULT_PATCH_RULE_SPECS.filter((rule) => rule.id !== 'default'),
  {
    id: 'surgical-repair',
    when: { costDeltaUsd: '<= 5.00', blastRadiusFiles: '<= 5' },
    decision: 'auto',
  },
  { id: 'default', decision: 'approve' },
];

const CAPS: readonly PlanTimeCapability[] = [
  {
    provider: PROVIDER,
    version: '2.1.220',
    structuredOutput: true,
    resume: true,
    permissionLevels: ['read', 'worktree', 'worktree+net', 'full'],
    maxContext: 200_000,
  },
];

const git = async (cwd: string, args: readonly string[]): Promise<string> => {
  const { stdout } = await exec('git', ['-C', cwd, ...args], {
    env: { ...process.env, ...GIT_ENV },
  });
  return stdout.trim();
};

const node = (over: Record<string, unknown>): Record<string, unknown> => ({
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  pathScopes: { write: [] },
  permission: 'worktree',
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  ...over,
});

async function planV1(spec: TaskSpec): Promise<PlanGraph> {
  const draft = {
    schemaId: 'DeFlow.plangraph.v1',
    runId: GATE_REPAIR_FIXTURE_RUN,
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: spec.specHash,
    createdBy: 'planner',
    createdAt: '2026-08-10T09:00:00.000Z',
    nodes: [
      node({
        id: PRODUCER,
        title: 'Implement daysUntil',
        type: 'agent',
        brief: 'Implement daysUntil.',
        provider: { prefer: [PROVIDER], requires: [] },
        resume: 'always-replay',
        // Wide enough that the fix node's scope adds no write capability,
        // which is what makes S29's ruling `auto` rather than S33's queue.
        pathScopes: { write: ['src/**', 'test/**'] },
      }),
      node({
        id: GATE_NODE,
        title: 'Typecheck',
        type: 'gate',
        deps: [PRODUCER],
        permission: 'read',
        returns: { schemaId: 'DeFlow.verdict.v3', maxTokens: 600 },
        retry: { maxAttempts: 1, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
        gate: { kind: 'deterministic', gateId: 'typecheck' },
        criteria: ['ac-1'],
        independence: { notSessionOf: [], preferDifferentProvider: false },
      }),
    ],
    edges: [{ from: PRODUCER, to: GATE_NODE, kind: 'control' }],
  };
  const parsed = PlanGraphSchema.parse(draft);
  return PlanGraphSchema.parse({
    ...draft,
    planHash: await planHash(parsed as unknown as Record<string, unknown>),
  });
}

/** The tier-2 estimator the policy engine costs a patch with. */
const estimator = () => ({
  tokenizer: o200kTokenizer(),
  accounting: () => 'exact' as const,
  family: () => 'anthropic',
  calibration: () => ({ n: 24, ratio: 1.18 }),
  countFiles: (paths: readonly string[]) => (paths.length === 0 ? 0 : 1),
  routing: () => ({ provider: PROVIDER, model: MODEL }),
});

/** A repository with the bug in it, and the gate that catches it. */
async function makeRepo(dir: string): Promise<void> {
  await mkdir(join(dir, 'src'), { recursive: true });
  await mkdir(join(dir, 'test'), { recursive: true });
  await mkdir(join(dir, '.DeFlow', 'gates'), { recursive: true });
  await writeFile(join(dir, 'src', 'date-picker.ts'), BUGGY);
  await writeFile(join(dir, 'test', '.keep'), '');
  // The compiler is linked in rather than installed, and it is not the
  // repository's content: without this the fix node's first commit picks up
  // `node_modules/.bin/tsc` and the ordering check reads a diff nobody made.
  await writeFile(join(dir, '.gitignore'), 'node_modules/\n');
  await writeFile(join(dir, 'tsconfig.json'), TSCONFIG);
  await writeFile(join(dir, '.DeFlow', 'gates', 'typecheck.yaml'), TYPECHECK_YAML);

  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'the work under review']);
}

/**
 * Links the workspace's own `tsc` in where the gate's relative command expects
 * it.
 *
 * A symlink rather than a copy, and the recorded path is the link's: the gate
 * command's provenance then names `/tmp/…/node_modules/.bin/tsc` while the
 * sha256 is the compiler's real bytes — the identity of what ran, with none of
 * the identity of whose machine ran it.
 */
async function linkTsc(worktree: string): Promise<void> {
  const binDir = join(worktree, 'node_modules', '.bin');
  await mkdir(binDir, { recursive: true });
  await rm(join(binDir, 'tsc'), { force: true });
  await symlink(WORKSPACE_TSC, join(binDir, 'tsc'));
}

/**
 * Links the mock agent in under the vendor's own name, and describes it the way
 * `node.started` records a binary: resolved path, version, digest of its bytes.
 *
 * The link lives under the work directory, so the path the ledger keeps is
 * synthetic; the digest is the mock agent's real bytes, so the provenance still
 * identifies exactly what ran.
 */
async function linkAgent(binDir: string): Promise<{
  path: string;
  version: string;
  sha256: string;
}> {
  await mkdir(binDir, { recursive: true });
  const path = join(binDir, 'claude');
  await rm(path, { force: true });
  await symlink(MOCK_AGENT_BIN, path);
  const digest = createHash('sha256')
    .update(await readFile(MOCK_AGENT_BIN))
    .digest('hex');
  return { path, version: '2.1.220', sha256: digest };
}

/** The three scripted client calls one shell command takes. */
const shell = (command: string, args: readonly string[]) => [
  { type: 'clientCall', method: 'terminal/create', params: { command, args } },
  { type: 'clientCall', method: 'terminal/wait_for_exit', params: {} },
  { type: 'clientCall', method: 'terminal/release', params: {} },
];

const writeStep = (path: string, content: string) => ({
  type: 'clientCall',
  method: 'fs/write_text_file',
  params: { path, content },
});

/**
 * The fix node's turn, as a scenario file.
 *
 * The three steps of §7 in order, each committed separately — which is the
 * whole thing `repairOrdering` then checks against the branch rather than
 * against this file.
 */
async function writeRepairScenario(path: string, worktree: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      name: 'surgical-repair',
      steps: [
        writeStep(join(worktree, 'test', 'days-until.test.ts'), REGRESSION),
        ...shell('git', ['add', '-A']),
        ...shell('git', ['commit', '-m', 'repair: reproduce the finding with a failing test']),
        writeStep(join(worktree, 'src', 'date-picker.ts'), FIXED),
        ...shell('git', ['add', '-A']),
        ...shell('git', ['commit', '-m', 'repair: return a day count']),
      ],
      stopReason: 'end_turn',
    }),
  );
}

/** What the fixture says about itself, for a reader that cannot open SQLite. */
export interface GateRepairFixtureSummary {
  readonly runId: RunId;
  readonly status: string;
  readonly finding: string;
  readonly fixNode: string;
  readonly rerunNode: string;
  /** `[fail, pass]` — the gate before the repair and after it. */
  readonly verdicts: readonly { gate: string; outcome: string; seq: number }[];
  /** The fix node's two commits, oldest first, with the gate's answer at each. */
  readonly commits: readonly { sha: string; paths: readonly string[]; outcome: string }[];
  /** The `seq` of the fix node's `node.completed` — the run's last write. */
  readonly lastWriteSeq: number;
  readonly milestoneAdvanced: boolean;
}

/**
 * Runs the repair loop end to end and writes the fixture into `outDir`.
 *
 * Exported so the e2e can build into a directory of its own and assert on what
 * came out; the committed copy is this same function with the default target.
 */
export async function buildGateRepairFixture(options: {
  readonly outDir: string;
  readonly workDir: string;
}): Promise<GateRepairFixtureSummary> {
  const { outDir, workDir } = options;
  await rm(workDir, { recursive: true, force: true });
  const dataDir = join(workDir, 'data');
  const repo = join(workDir, 'repo');
  const runDir = join(workDir, 'runs', GATE_REPAIR_FIXTURE_RUN);
  await mkdir(dataDir, { recursive: true });
  await mkdir(repo, { recursive: true });

  await makeRepo(repo);
  await linkTsc(repo);
  const agentBinary = await linkAgent(join(workDir, 'bin'));

  const spec = await sealTaskSpec(structuredClone(SPEC_DRAFT));
  const plan = await planV1(spec);

  const discovered = await discoverGateDefinitions({
    gatesDir: join(repo, '.DeFlow', 'gates'),
  });
  const definitions = new Map<string, { definition: GateDefinition; sha256: string }>(
    discovered.map((gate) => [gate.definition.id, gate]),
  );

  const db = openLedger(dataDir);
  const epoch = readEpoch(db);
  const startedAt = systemClock.now();

  /** Where each node worked. The re-run gate judges the fix node's worktree —
   * a gate re-run against the producer's tree is §5.2's stale green. */
  const worktrees = new Map<NodeId, string>([[PRODUCER, repo]]);
  const baseShas = new Map<NodeId, string>();
  const commitsByNode = new Map<
    NodeId,
    readonly { sha: string; paths: readonly string[]; outcome: string }[]
  >();
  let finding = '';
  let fixNode = '';
  let rerunNode = '';
  let lastWriteSeq = 0;

  try {
    // ── the prologue: the producer's turn is the scenario's *Given* ──────────
    appendEvents(db, [
      {
        runId: GATE_REPAIR_FIXTURE_RUN,
        ts: T0,
        kind: 'run.created',
        v: 1,
        epoch,
        payload: {
          spec,
          cwd: repo,
          repo: { head: await git(repo, ['rev-parse', '--short', 'HEAD']), branch: 'main' },
        },
      },
      {
        runId: GATE_REPAIR_FIXTURE_RUN,
        ts: T0,
        kind: 'policy.patch.loaded',
        v: 1,
        epoch,
        payload: { source: 'config', hash: POLICY_HASH, rules: REPAIR_POLICY },
      },
      {
        runId: GATE_REPAIR_FIXTURE_RUN,
        ts: T0,
        kind: 'run.spec.approved',
        v: 1,
        epoch,
        payload: { specHash: spec.specHash, by: 'ui' },
      },
    ]);

    // `persistPlanVersion` writes the `plan` row *and* its `plan.proposed`:
    // one seam, so the document the run executes and the event that announced
    // it can never disagree.
    await persistPlanVersion(db, {
      runId: GATE_REPAIR_FIXTURE_RUN,
      runDir,
      graph: plan,
      by: 'planner',
      planner: PLANNER,
      diagnostics: [],
      ts: T0,
      epoch,
    });

    appendEvents(db, [
      {
        runId: GATE_REPAIR_FIXTURE_RUN,
        ts: T0,
        kind: 'run.started',
        v: 1,
        epoch,
        payload: { planHash: plan.planHash },
      },
      {
        runId: GATE_REPAIR_FIXTURE_RUN,
        ts: T0 + 1_000,
        kind: 'node.started',
        v: 1,
        epoch,
        nodeId: PRODUCER,
        attempt: 0,
        payload: { node: PRODUCER, attempt: 0 },
      },
      {
        runId: GATE_REPAIR_FIXTURE_RUN,
        ts: T0 + 2_000,
        kind: 'node.completed',
        v: 1,
        epoch,
        nodeId: PRODUCER,
        attempt: 0,
        payload: {
          node: PRODUCER,
          attempt: 0,
          result: {
            status: 'completed',
            output: { text: 'implemented daysUntil' },
            outputSchemaId: 'DeFlow.finding.v1',
            usage: { inputTokens: 900, outputTokens: 120, source: 'vendor-reported' },
            costUsd: 0.02,
            producedFacts: [],
            artifacts: [],
          },
        },
      },
    ]);
    db.prepare(
      `INSERT INTO run (run_id, status, plan_hash, last_seq, state_json, checkpoint_version,
          daemon_epoch)
        VALUES (?, 'running', ?, 0, '{}', 1, ?)
        ON CONFLICT(run_id) DO UPDATE SET status = 'running'`,
    ).run(GATE_REPAIR_FIXTURE_RUN, plan.planHash, epoch);

    const patchRequest = () => ({
      runId: GATE_REPAIR_FIXTURE_RUN,
      runDir,
      spec,
      caps: CAPS,
      estimatePacketTokens: () => 0,
      refs: { isValidRef: () => Promise.resolve(true) },
      estimator: estimator(),
      planner: PLANNER,
      epoch,
      configPolicyHash: POLICY_HASH,
    });

    const currentPlan = (): PlanGraph => {
      const graph = replayRun(db, GATE_REPAIR_FIXTURE_RUN).state.plan;
      if (graph === null) throw new Error('the run has no active plan');
      return graph;
    };

    // ── the gate performer: a failing verdict earns a fix node ───────────────
    const gatePerformer = gateNodePerformer({
      dataDir,
      scrubbedEnv: [],
      resolve: (nodeId, state) => {
        const planned = state.plan?.nodes.find((entry) => entry.id === nodeId);
        if (planned === undefined || planned.type !== 'gate') return null;
        if (planned.gate.kind !== 'deterministic') return null;
        const found = definitions.get(planned.gate.gateId);
        if (found === undefined) return null;
        const judged = (planned.deps[0] ?? planned.id) as NodeId;
        return {
          definition: found.definition,
          worktree: worktrees.get(judged) ?? repo,
          repoRoot: worktrees.get(judged) ?? repo,
          evaluatedNode: judged,
          specHash: state.specApproved?.specHash ?? spec.specHash,
          definitionSha256: found.sha256,
        };
      },
      onVerdict: async (nodeId, outcome) => {
        if (outcome.status !== 'completed' || outcome.verdict.outcome === 'pass') return;
        const evidence = outcome.run.evidence === null ? [] : [outcome.run.evidence.handle];
        const repair = await applyGateRepair(db, {
          ...patchRequest(),
          verdict: outcome.verdict,
          base: currentPlan(),
          ts: systemClock.now(),
          context: {
            evaluatedNode: (currentPlan().nodes.find((entry) => entry.id === nodeId)?.deps[0] ??
              PRODUCER) as NodeId,
            ambientPermission: 'worktree',
            replanDepth: 1,
            evidence,
            proposedBy: 'scheduler',
            testScopes: ['test/**'],
            // Routing, not inheritance: without it the fix node prefers no
            // provider and `commitPatchedPlan` refuses it.
            fixProvider: [PROVIDER],
          },
        });
        if (repair.applied.length === 0) {
          throw new Error(
            `the fixture's gate failure earned no fix node (${String(repair.why)}): ` +
              repair.decisions.map((entry) => `${entry.decision} by ${entry.ruleId}`).join(', '),
          );
        }
        fixNode = String(repair.applied[0]);
        finding = fixNode.replace(/^fix-/, '');
      },
    });

    // ── the fix performer: a real agent, on its own branch, then the re-run ──
    const fixPerformer = async (
      command: { node: NodeId; attempt: number },
      ctx: { db: typeof db },
    ): Promise<void> => {
      const planned = currentPlan().nodes.find((entry) => entry.id === command.node);
      if (planned === undefined) throw new Error(`${command.node} is not in the plan`);

      const worktree = join(workDir, 'wt', `${GATE_REPAIR_FIXTURE_RUN}__${command.node}`);
      const branch = `DeFlow/${GATE_REPAIR_FIXTURE_RUN}__${command.node}`;
      await git(repo, ['worktree', 'add', '-b', branch, worktree, 'HEAD']);
      await linkTsc(worktree);
      const baseSha = await git(worktree, ['rev-parse', 'HEAD']);
      worktrees.set(command.node, worktree);
      baseShas.set(command.node, baseSha);

      const scenario = join(workDir, 'scenarios', `${command.node}.json`);
      await writeRepairScenario(scenario, worktree);

      const childEnv = buildChildEnv({
        base: { ...process.env, ...GIT_ENV },
        loginPath: process.env.PATH ?? '',
        tmpdir: dataDir,
        // `buildChildEnv` starts from `{}` and keeps only what §4.1 allows, so
        // the fix node has to **declare** the variables its own commands need.
        // Without that its `git commit` inherits the developer's global
        // config — an identity, a signing key and the wall clock — and the
        // fixture's commit ids stop being reproducible.
        declared: Object.keys(GIT_ENV),
      }).env;

      const outcome = await runFixNode(
        {
          runId: GATE_REPAIR_FIXTURE_RUN,
          nodeId: command.node,
          attempt: command.attempt,
          provider: PROVIDER,
          model: MODEL,
          permission: 'worktree',
          worktree,
          baseSha,
          binary: agentBinary,
          argv: ['--seed', '42', '--scenario', scenario],
          prompt: planned.type === 'agent' ? planned.brief : 'repair the finding',
          gate: loadGateDefinition('.DeFlow/gates/typecheck.yaml', TYPECHECK_YAML),
          specHash: spec.specHash,
          evaluatedNode: PRODUCER,
          declared: [...planned.pathScopes.write],
        },
        {
          clock: systemClock,
          dataDir,
          ledger: sqliteLedgerSink({ db: ctx.db, runId: GATE_REPAIR_FIXTURE_RUN, epoch, dataDir }),
          captureEvidence: (evidence) =>
            HandleSchema.parse(
              blobHandle(
                spillBytes(
                  dataDir,
                  typeof evidence === 'string'
                    ? Buffer.from(evidence, 'utf8')
                    : Buffer.from(evidence),
                  'text/plain',
                ).sha256,
              ),
            ),
          handlers: {
            ...acpFsHandlers(createFsService({ root: worktree })),
            ...acpTerminalHandlers(createTerminalService({ root: worktree, childEnv })),
          },
          gitEnv: GIT_ENV,
        },
      );

      if (outcome.status !== 'repaired') {
        throw new Error(
          `the fixture's fix node did not demonstrate its repair: ${JSON.stringify(outcome)}`,
        );
      }
      commitsByNode.set(command.node, outcome.commits);
      lastWriteSeq = readRange(db, GATE_REPAIR_FIXTURE_RUN, 0, 5_000).events.reduce(
        (held, event) =>
          event.kind === 'node.completed' && event.nodeId === command.node ? event.seq : held,
        lastWriteSeq,
      );

      const rerun = await applyGateRerun(db, {
        ...patchRequest(),
        base: currentPlan(),
        after: [command.node],
        round: 2,
        proposedBy: 'scheduler',
        replanDepth: 2,
        ts: systemClock.now(),
        detail:
          `test ${outcome.ordering.testCommit.slice(0, 7)}, ` +
          `fix ${outcome.ordering.fixCommit.slice(0, 7)}`,
      });
      if (rerun.scheduled.length === 0) throw new Error('the re-run patch scheduled no gate');
      rerunNode = String(rerun.scheduled[0]);
    };

    await executeRun({
      db,
      runId: GATE_REPAIR_FIXTURE_RUN,
      clock: systemClock,
      epoch,
      daemonStartedAt: startedAt,
      random: seededRandom(1),
      effects: createEffectRunner({ db, clock: systemClock, daemonStartedAt: startedAt, epoch }),
      perform: byNodeType({ gate: gatePerformer, agent: fixPerformer }),
      // Real ticks against real child processes; the clock is the system one.
      tickStepMs: 0,
      tickMs: 20,
      // A ref'd timer: in this process the loop is the only work there is.
      sleep: (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
      budgetMs: 300_000,
    });

    // ── what came out ───────────────────────────────────────────────────────
    const events = readRange(db, GATE_REPAIR_FIXTURE_RUN, 0, 5_000).events;
    const verdicts = gateVerdictsFromEvents(events);
    const milestone = milestoneStatus(
      { id: 'm1', requires: ['typecheck'], scope: ['src/**', 'test/**'] },
      verdicts,
      [{ seq: lastWriteSeq, paths: ['src/date-picker.ts', 'test/days-until.test.ts'] }],
    );

    const summary: GateRepairFixtureSummary = {
      runId: GATE_REPAIR_FIXTURE_RUN,
      status: replayRun(db, GATE_REPAIR_FIXTURE_RUN).state.status,
      finding,
      fixNode,
      rerunNode,
      verdicts: verdicts.map((verdict) => ({
        gate: verdict.gate,
        outcome: verdict.outcome,
        seq: verdict.seq,
      })),
      commits: commitsByNode.get(fixNode as NodeId) ?? [],
      lastWriteSeq,
      milestoneAdvanced: milestone.advanced,
    };

    db.close();

    await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });
    await cp(dataDir, outDir, { recursive: true });
    // An artefact of opening a fresh ledger, not part of the fixture: it is a
    // copy of an *empty* database, which is noise that looks like data.
    await rm(join(outDir, 'pre-migrate-0.db'), { force: true });
    await writeFile(join(outDir, 'repair.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    await writeFile(join(outDir, 'README.md'), readme(summary), 'utf8');

    return summary;
  } finally {
    if (db.open) db.close();
  }
}

function readme(summary: GateRepairFixtureSummary): string {
  return `# \`gate-failure-repair\`

A real run of the surgical repair loop (docs/10-verification-gates.md §7): a
deterministic gate fails, the failure earns one fix node, the fix node writes a
failing regression test and then the fix, and the gate set re-runs from the
deterministic tier and passes.

**Produced by \`packages/daemon/scripts/build-gate-repair-fixture.ts\`, never by
hand.** Rebuild it with:

\`\`\`
node packages/daemon/scripts/build-gate-repair-fixture.ts
\`\`\`

- run: \`${summary.runId}\`, final status \`${summary.status}\`
- finding \`${summary.finding}\` → fix node \`${summary.fixNode}\` → re-run gate
  \`${summary.rerunNode}\`
- verdicts, in ledger order: ${summary.verdicts
    .map((verdict) => `\`${verdict.gate}\` ${verdict.outcome} @ ${String(verdict.seq)}`)
    .join(', ')}

\`repair.json\` is the same story as JSON, for a consumer that cannot open
SQLite — a browser spec, above all. The run was built under
\`${GATE_REPAIR_WORK_DIR}\`, so every absolute path recorded in the ledger is
synthetic and portable; a fixture carrying a developer's home directory is a
privacy leak with a long half-life.
`;
}

// Run only when invoked as a script, exactly as `build-compaction-fixture.ts`
// guards itself: an import that drove a run as a side effect would make a
// passing spec indistinguishable from one that had just executed a plan.
if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const summary = await buildGateRepairFixture({
    outDir: process.argv[2] ?? GATE_REPAIR_FIXTURE_DIR,
    workDir: process.argv[3] ?? GATE_REPAIR_WORK_DIR,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
