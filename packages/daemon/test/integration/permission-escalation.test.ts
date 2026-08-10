/**
 * KAR-13.4 tests 4–10 — the escalation path, against a real agent, a real
 * ledger and real processes.
 *
 * The unit suite (../../../core/src/permission-escalation.test.ts) proves the
 * *policy*: which requests escalate, what the payload carries, and how long an
 * `_always` lasts. What only a process boundary can prove is that the whole
 * loop closes — the agent asks, DeFlow appends `human.requested` and **waits**,
 * the queue carries enough to decide without a second request, an answer
 * arrives from a completely separate call, and the agent's own turn carries on
 * from the branch it was told to take.
 *
 * Three properties here are observations about the world rather than about
 * DeFlow's memory, and each is why this file exists:
 *
 * - **Nothing is spawned while a gate is outstanding.** The fake binaries
 *   append to a log as their first act, so "no process ran" is a fact about
 *   the filesystem.
 * - **The resolved path is the one recorded.** A real symlink out of a real
 *   worktree, resolved by a real `realpath`, is the only way to test AC3
 *   without asserting on a stub's return value.
 * - **The queue is a projection of the ledger.** Every assertion about what the
 *   operator sees goes through `approvalQueue` over the same database the
 *   agent's request landed in, never through the object the escalation
 *   returned.
 *
 * Verifies: EPIC-13-S22, EPIC-13-S23, EPIC-13-S24, EPIC-13-S25, EPIC-13-S26,
 * EPIC-13-S27 · AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC9
 */
import type { LedgerSink } from '@DeFlow/adapters';
import { runAcpNode } from '@DeFlow/adapters';
import type { ApprovalItem } from '@DeFlow/core';
import {
  approvalsProjection,
  type CommandsConfig,
  type Handle,
  HandleSchema,
  HumanRequestedSchema,
  type NodeId,
  NodeIdSchema,
  type PermissionLevel,
  type ProviderId,
  ProviderIdSchema,
  permissionScopeFrom,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import {
  appendEvents,
  blobHandle,
  openLedger,
  readEpoch,
  readRange,
  replayRun,
  spillBytes,
} from '@DeFlow/ledger';
import { makeTempDir, removeTempDir, TestClock, waitFor } from '@DeFlow/testkit';
import { chmod, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  acpFsHandlers,
  acpPermissionHandlers,
  acpTerminalHandlers,
  buildChildEnv,
  createCommandMediator,
  createFsService,
  createPathMediator,
  createPermissionEscalations,
  createPermissionService,
  createTerminalService,
  expireDueHumanGates,
  ladderDecider,
  type PermissionEscalations,
  respondToHumanNode,
  systemClock,
  worktreeCommandPolicy,
} from '../../src/index.ts';
import { sqliteLedgerSink } from './support/ledger.ts';

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

const RUN_ID: RunId = RunIdSchema.parse('run_20260810T101500Z_ac1304');
const NODE_ID: NodeId = NodeIdSchema.parse('n-impl-3');
const PROVIDER: ProviderId = ProviderIdSchema.parse('mock');
const SESSION = 'sess_kar1304';
const BRIEF = 'Migrate the toast component to the new design system';
const PATH_SCOPES = ['packages/ui/src/**'];
const EPOCH_TS = 1_754_308_400_000;

const COMMANDS: CommandsConfig = {
  allow: ['pnpm', 'node', 'git'],
  readOnly: ['git status'],
  allowDomains: [],
};

let dir = '';
let worktree = '';
let binDir = '';
let spawnLog = '';
let db: ReturnType<typeof openLedger>;
let epoch = 0;
let sink: LedgerSink;
let captureEvidence: (text: string) => Handle;

/** A binary that records the argv it was given, and then says `ok`. */
async function fakeBinary(name: string): Promise<void> {
  const path = join(binDir, name);
  await writeFile(
    path,
    ['#!/bin/sh', `{ printf '%s\\n' "$0" "$@"; } >> ${spawnLog}`, 'echo ok'].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
}

const spawned = async (): Promise<string> => readFile(spawnLog, 'utf8').catch(() => '');

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'r1__n-impl-3');
  binDir = join(dir, 'bin');
  spawnLog = join(dir, 'spawned.log');
  await mkdir(join(worktree, 'src'), { recursive: true });
  await mkdir(join(dir, 'outside'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  for (const name of ['pnpm', 'node', 'git', 'curl']) await fakeBinary(name);

  db = openLedger(dir);
  epoch = readEpoch(db);
  sink = sqliteLedgerSink({ db, runId: RUN_ID, epoch });
  captureEvidence = (text: string): Handle =>
    HandleSchema.parse(blobHandle(spillBytes(dir, Buffer.from(text, 'utf8'), 'text/plain').sha256));

  // A real run in the ledger: the approval queue skips runs that never started
  // and runs that are over, so a spec asserting on the queue has to have one.
  appendEvents(db, [
    {
      runId: RUN_ID,
      ts: EPOCH_TS,
      kind: 'run.created',
      v: 1,
      epoch,
      payload: { spec: { title: 'x' }, cwd: dir, repo: { head: 'e83c516', branch: 'main' } },
    },
    {
      runId: RUN_ID,
      ts: EPOCH_TS,
      kind: 'run.started',
      v: 1,
      epoch,
      payload: { planHash: `sha256-${'a'.repeat(64)}` },
    },
  ]);
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

const testChildEnv = (): Record<string, string> =>
  buildChildEnv({ base: process.env, loginPath: process.env.PATH ?? '', tmpdir: dir }).env;

const bin = (name: string): string => join(binDir, name);

const eventsOf = (kind: string): Record<string, unknown>[] =>
  readRange(db, RUN_ID, 0, 5000)
    .events.filter((event) => event.kind === kind)
    .map((event) => event.payload as Record<string, unknown>);

/** What the Operator sees, projected off the same ledger the agent wrote to —
 * never off the object the escalation returned. */
const queue = (): readonly ApprovalItem[] =>
  approvalsProjection([{ runId: RUN_ID, state: replayRun(db, RUN_ID).state }]).items;

const transcript = (outcome: Awaited<ReturnType<typeof runAcpNode>>): string =>
  outcome.status === 'completed' ? ((outcome.result.output as { text: string }).text ?? '') : '';

// ── the wiring under test ────────────────────────────────────────────────────

interface RunOptions {
  readonly level?: PermissionLevel;
  readonly deadline?: {
    wakeAt: string;
    onTimeout: 'fail' | 'escalate' | 'default';
    default?: string;
  };
}

/** The real escalation service, over the real ledger. */
function escalations(options: RunOptions = {}): PermissionEscalations {
  return createPermissionEscalations({
    db,
    runId: RUN_ID,
    nodeId: NODE_ID,
    attempt: 0,
    epoch,
    clock: systemClock,
    level: options.level ?? 'worktree',
    worktree,
    pathScopes: PATH_SCOPES,
    brief: BRIEF,
    enforcement: 'sandbox-runtime',
    sessionId: SESSION,
    pollMs: 10,
    ...(options.deadline === undefined ? {} : { deadline: options.deadline }),
  });
}

async function runScenario(
  steps: readonly unknown[],
  service: PermissionEscalations,
  options: RunOptions = {},
): Promise<Awaited<ReturnType<typeof runAcpNode>>> {
  const level = options.level ?? 'worktree';
  const scope = permissionScopeFrom(COMMANDS, { worktree, scrubbedEnv: [] });

  const mediator = createCommandMediator({
    level,
    scope,
    escalates: service.escalates,
    escalate: service.askAboutCommand,
    record: service.recordCommand,
  });
  const terminal = createTerminalService({
    root: worktree,
    childEnv: testChildEnv(),
    policy: worktreeCommandPolicy(mediator, { onDenied: () => undefined }),
  });
  const fs = createFsService({
    root: worktree,
    policy: service.pathPolicy(createPathMediator({ level, scope })),
  });
  // The third mediation front: `session/request_permission` itself. It shares
  // the same escalation service, so an `_always` chosen on one surface is read
  // by all three — the run-scoped policy lives in the ledger, not in a closure.
  const permission = createPermissionService(
    ladderDecider({
      level,
      scope,
      pathScope: PATH_SCOPES,
      escalates: service.escalates,
      escalate: service.askAboutRequest,
      record: service.recordLadder,
    }),
  );

  const scenarioPath = join(dir, 'escalation.json');
  await writeFile(scenarioPath, JSON.stringify({ name: 'esc', steps, stopReason: 'end_turn' }));

  return runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: level,
      worktree,
      binary: { path: MOCK_AGENT_BIN, version: '0.0.0', sha256: 'e'.repeat(64) },
      argv: ['--seed', '42', '--scenario', scenarioPath],
      mcpServers: [],
      prompt: 'go',
    },
    {
      clock: new TestClock(EPOCH_TS),
      ledger: sink,
      captureEvidence,
      handlers: {
        ...acpFsHandlers(fs),
        ...acpTerminalHandlers(terminal),
        ...acpPermissionHandlers(permission),
      },
    },
  );
}

const readFileStep = (path: string): unknown => ({
  type: 'clientCall',
  method: 'fs/read_text_file',
  params: { path },
  onError: { steps: [{ type: 'message', text: 'refused-read' }] },
});

const writeFileStep = (path: string): unknown => ({
  type: 'clientCall',
  method: 'fs/write_text_file',
  params: { path, content: 'x' },
  onError: { steps: [{ type: 'message', text: 'refused-write' }] },
});

const runCommand = (command: string, args: readonly string[] = []): unknown[] => [
  {
    type: 'clientCall',
    method: 'terminal/create',
    params: { command, args },
    onError: { steps: [{ type: 'message', text: 'refused-command' }] },
  },
  { type: 'clientCall', method: 'terminal/wait_for_exit', params: {} },
  { type: 'clientCall', method: 'terminal/release', params: {} },
];

/** Answers the one open escalation as soon as it appears, out of band — the
 * operator is a separate call on a separate connection, never a callback. */
function answerWhenAsked(optionId: string, times = 1): Promise<void> {
  return (async () => {
    for (let seen = 0; seen < times; seen += 1) {
      await waitFor(() => eventsOf('human.requested').length > seen, {
        describe: `escalation ${String(seen + 1)}`,
        timeoutMs: 20_000,
      });
      const decision = respondToHumanNode({
        db,
        runId: RUN_ID,
        nodeId: NODE_ID,
        optionId,
        epoch,
        ts: EPOCH_TS + 60_000,
      });
      // A refusal here is a spec bug that would otherwise read as a hang: the
      // agent keeps waiting for an answer nothing appended.
      expect(decision.status).toBe('ok');
    }
  })();
}

/* -------------------------------------------------------------------------- *
 * test 4 — twenty routine reads reach nobody (EPIC-13-S22, AC1, AC9)
 * -------------------------------------------------------------------------- */

suite('EPIC-13-S22 — routine permission requests never reach the Operator (test 4)', () => {
  it('makes twenty in-scope reads with zero human.requested and an empty queue', async () => {
    const service = escalations();
    const paths = Array.from({ length: 20 }, (_unused, index) =>
      join(worktree, 'src', `r${String(index)}.ts`),
    );
    for (const path of paths) await writeFile(path, 'export const a = 1;\n', 'utf8');

    const outcome = await runScenario(paths.map(readFileStep), service);

    expect(outcome.status).toBe('completed');
    expect(transcript(outcome)).not.toContain('refused-read');
    // AC1 — the assertion the whole story is measured by.
    expect(eventsOf('human.requested')).toHaveLength(0);
    expect(queue()).toEqual([]);
  });

  it('still records every auto-response as a ledger event (AC9)', async () => {
    const service = escalations();
    const paths = Array.from({ length: 20 }, (_unused, index) =>
      join(worktree, 'src', `a${String(index)}.ts`),
    );
    for (const path of paths) await writeFile(path, 'x\n', 'utf8');

    await runScenario(paths.map(readFileStep), service);

    const decided = eventsOf('permission.decided');
    expect(decided).toHaveLength(20);
    expect(decided.every((one) => one.outcome === 'allow' && one.answered === 'allow')).toBe(true);
    expect(decided.every((one) => one.by === 'ladder')).toBe(true);
    // The history is reconstructable: each row names what was asked for.
    expect(decided.map((one) => one.requested)).toEqual(paths);
  });
});

/* -------------------------------------------------------------------------- *
 * test 5 — egress escalates, with the rule named (EPIC-13-S23, AC2)
 * -------------------------------------------------------------------------- */

suite('EPIC-13-S23 — an escalation carries enough to decide (test 5)', () => {
  it('escalates curl at worktree level and the queue item carries the context', async () => {
    const service = escalations();
    // The queue is read *while the gate is open*, which is the only moment the
    // claim is about: an item the Operator can act on, carrying enough to
    // decide, before anybody has answered anything.
    let pending: readonly ApprovalItem[] = [];
    const answering = (async () => {
      await waitFor(() => eventsOf('human.requested').length > 0, {
        describe: 'the escalation',
        timeoutMs: 20_000,
      });
      pending = queue();
      respondToHumanNode({
        db,
        runId: RUN_ID,
        nodeId: NODE_ID,
        optionId: 'allow_once',
        epoch,
        ts: EPOCH_TS + 60_000,
      });
    })();

    const outcome = await runScenario(
      runCommand(bin('curl'), ['-sS', 'https://registry.example.com/token']),
      service,
    );
    await answering;

    expect(outcome.status).toBe('completed');

    const [requested] = eventsOf('human.requested');
    expect(requested).toBeDefined();
    expect(HumanRequestedSchema.safeParse(requested).success).toBe(true);
    expect(requested?.reason).toEqual({ code: 'level-no-network' });
    expect(requested?.permission).toMatchObject({
      method: 'terminal/create',
      command: bin('curl'),
      args: ['-sS', 'https://registry.example.com/token'],
      cwd: worktree,
      rule: 'level-no-network',
      level: 'worktree',
      pathScopes: PATH_SCOPES,
      enforcement: 'sandbox-runtime',
      sessionId: SESSION,
    });

    // "The queue item carries it without a second request."
    const item = pending.find((row) => row.kind === 'permission');
    expect(item).toBeDefined();
    expect(item?.node).toBe(NODE_ID);
    expect(item?.kind === 'permission' ? item.permission : null).toMatchObject({
      command: bin('curl'),
      rule: 'level-no-network',
    });
    expect(item?.kind === 'permission' ? item.options.map((one) => one.id) : []).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
      'reject_always',
    ]);
    // And the prompt is a five-second read on its own, with the brief on it.
    expect(item?.summary).toContain(BRIEF);
  });

  it('spawns nothing until the answer arrives, and then runs exactly what was shown', async () => {
    const service = escalations();
    const answering = (async () => {
      await waitFor(() => eventsOf('human.requested').length > 0, {
        describe: 'the escalation',
        timeoutMs: 20_000,
      });
      // While the gate is open, no process exists — a fact about the disk.
      expect(await spawned()).toBe('');
      respondToHumanNode({
        db,
        runId: RUN_ID,
        nodeId: NODE_ID,
        optionId: 'allow_once',
        epoch,
        ts: EPOCH_TS + 60_000,
      });
    })();

    await runScenario(
      runCommand(bin('curl'), ['-sS', 'https://registry.example.com/token']),
      service,
    );
    await answering;

    expect(await spawned()).toBe(`${bin('curl')}\n-sS\nhttps://registry.example.com/token\n`);
  });

  it('records the escalation and its answer as ledger events (AC9)', async () => {
    const service = escalations();
    const answering = answerWhenAsked('reject_once');

    await runScenario(runCommand(bin('curl'), ['https://example.com']), service);
    await answering;

    expect(eventsOf('human.responded')[0]).toMatchObject({
      optionId: 'reject_once',
      by: 'operator',
    });
    expect(eventsOf('permission.decided')[0]).toMatchObject({
      outcome: 'gate',
      answered: 'reject',
      by: 'operator',
      optionId: 'reject_once',
      reason: { code: 'level-no-network' },
    });
    // Answered means gone from the queue.
    expect(queue()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * test 6 — the resolved path (EPIC-13-S23 scenario 2, AC3)
 * -------------------------------------------------------------------------- */

suite('EPIC-13-S23 — the resolved path is what the payload shows (test 6)', () => {
  it('records the realpath target of a symlink that leaves the worktree', async () => {
    // A real symlink, resolved by a real realpath: `<worktree>/tmp` → the
    // tmpdir's `outside/`, so `<worktree>/tmp/x` lands outside.
    await symlink(join(dir, 'outside'), join(worktree, 'tmp'), 'dir');
    const service = escalations();

    const outcome = await runScenario([writeFileStep(join(worktree, 'tmp', 'x'))], service);

    expect(transcript(outcome)).toContain('refused-write');
    const [decided] = eventsOf('permission.decided');
    expect(decided).toMatchObject({
      method: 'fs/write_text_file',
      requested: join(worktree, 'tmp', 'x'),
      outcome: 'deny',
      answered: 'reject',
      reason: { code: 'path-escape', detail: 'symlink' },
    });
    // AC3 — the fact the decision turns on, not only what was asked for.
    expect(decided?.resolved).toContain(join(dir, 'outside'));
    expect(decided?.resolved).not.toBe(decided?.requested);
  });
});

/* -------------------------------------------------------------------------- *
 * test 7 — the option-kind matrix (EPIC-13-S24, AC4)
 * -------------------------------------------------------------------------- */

suite('EPIC-13-S24 — the four kinds, and the run scope of _always (test 7)', () => {
  const twice = (): unknown[] => [
    ...runCommand(bin('curl'), ['https://example.com']),
    ...runCommand(bin('curl'), ['https://example.com']),
  ];

  it('auto-answers the second matching request after allow_always', async () => {
    const service = escalations();
    const answering = answerWhenAsked('allow_always');

    await runScenario(twice(), service);
    await answering;

    // One question for two requests: the second was answered from run policy.
    expect(eventsOf('human.requested')).toHaveLength(1);
    const decided = eventsOf('permission.decided');
    expect(decided).toHaveLength(2);
    expect(decided[0]).toMatchObject({ by: 'operator', answered: 'allow' });
    expect(decided[1]).toMatchObject({
      by: 'run-policy',
      answered: 'allow',
      optionId: 'allow_always',
    });
    expect(queue()).toEqual([]);
  });

  it('auto-denies the second matching request after reject_always', async () => {
    const service = escalations();
    const answering = answerWhenAsked('reject_always');

    await runScenario(twice(), service);
    await answering;

    expect(eventsOf('human.requested')).toHaveLength(1);
    expect(eventsOf('permission.decided')[1]).toMatchObject({
      by: 'run-policy',
      answered: 'reject',
    });
    // Nothing ever ran.
    expect(await spawned()).toBe('');
  });

  it('asks again after allow_once', async () => {
    const service = escalations();
    const answering = answerWhenAsked('allow_once', 2);

    await runScenario(twice(), service);
    await answering;

    expect(eventsOf('human.requested')).toHaveLength(2);
    expect(eventsOf('permission.decided').every((one) => one.by === 'operator')).toBe(true);
  });

  it('matches narrowly: a different host asks again even after allow_always', async () => {
    const service = escalations();
    const answering = answerWhenAsked('allow_always', 2);

    await runScenario(
      [
        ...runCommand(bin('curl'), ['https://example.com']),
        ...runCommand(bin('curl'), ['https://elsewhere.example']),
      ],
      service,
    );
    await answering;

    expect(eventsOf('human.requested')).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- *
 * test 8 — cancelled is an outcome (EPIC-13-S25, AC5)
 * -------------------------------------------------------------------------- */

suite('EPIC-13-S25 — cancelled is an outcome, not an error (test 8)', () => {
  it('withdraws the queue item and records the cancellation, without a protocol error', async () => {
    const abort = new AbortController();
    const service = createPermissionEscalations({
      db,
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      epoch,
      clock: systemClock,
      level: 'worktree',
      worktree,
      pathScopes: PATH_SCOPES,
      sessionId: SESSION,
      pollMs: 10,
      signal: abort.signal,
    });

    const cancelling = (async () => {
      await waitFor(() => eventsOf('human.requested').length > 0, {
        describe: 'the escalation',
        timeoutMs: 20_000,
      });
      abort.abort();
    })();

    const outcome = await runScenario(runCommand(bin('curl'), ['https://example.com']), service);
    await cancelling;

    // The turn ended per the adapter's contract; nothing built a protocol error.
    expect(outcome.status).toBe('completed');
    expect(transcript(outcome)).toContain('refused-command');
    expect(eventsOf('node.failed')).toEqual([]);

    // The queue item is removed rather than left pending.
    expect(queue()).toEqual([]);
    expect(eventsOf('human.responded')[0]).toMatchObject({
      optionId: 'reject_once',
      by: 'policy',
      text: 'cancelled-by-agent',
    });
    expect(eventsOf('permission.decided')[0]).toMatchObject({ answered: 'cancelled' });
  });
});

/* -------------------------------------------------------------------------- *
 * test 9 — the deadline nobody met (EPIC-13-S26, AC6)
 * -------------------------------------------------------------------------- */

suite('EPIC-13-S26 — an escalation nobody answers (test 9)', () => {
  it('answers with reject_once and records human.responded by policy', async () => {
    const service = escalations({
      deadline: {
        wakeAt: new Date(EPOCH_TS + 1_800_000).toISOString(),
        onTimeout: 'default',
        default: 'reject_once',
      },
    });

    // The ticker's half, driven from a spec: the clock passes `wakeAt` with
    // nobody having answered, and the due row is what fires — no timer, at any
    // delay.
    const expiring = (async () => {
      await waitFor(() => eventsOf('human.requested').length > 0, {
        describe: 'the escalation',
        timeoutMs: 20_000,
      });
      await waitFor(
        () =>
          expireDueHumanGates({
            db,
            clock: new TestClock(EPOCH_TS + 1_800_001),
            epoch,
            runId: RUN_ID,
          }).length > 0,
        { describe: 'the deadline to fire', timeoutMs: 20_000 },
      );
    })();

    const outcome = await runScenario(runCommand(bin('curl'), ['https://example.com']), service);
    await expiring;

    expect(outcome.status).toBe('completed');
    expect(eventsOf('human.responded')[0]).toMatchObject({
      optionId: 'reject_once',
      by: 'policy',
    });
    // A refusal, not a failed node: the node is still the agent's to finish.
    expect(eventsOf('node.failed')).toEqual([]);
    expect(eventsOf('permission.decided')[0]).toMatchObject({
      answered: 'reject',
      by: 'deadline',
      optionId: 'reject_once',
    });
    expect(queue()).toEqual([]);
    expect(await spawned()).toBe('');
  });
});

/* -------------------------------------------------------------------------- *
 * test 10 — mediatedExecution: false (EPIC-13-S27, AC7)
 * -------------------------------------------------------------------------- */

suite('EPIC-13-S27 — an unmediated adapter is refused, never escalated (test 10)', () => {
  it('creates no queue item for the refusal the Operator could otherwise approve', async () => {
    // KAR-05.2's `admit` is what refuses it, and EPIC-05's own suite proves the
    // refusal names the adapter and the level. What is KAR-13.4's to assert is
    // the negative: there is no approval to give.
    appendEvents(db, [
      {
        runId: RUN_ID,
        ts: EPOCH_TS,
        kind: 'node.unschedulable',
        v: 1,
        epoch,
        nodeId: NODE_ID,
        payload: {
          node: NODE_ID,
          provider: 'mock',
          version: '1.0.0',
          permission: 'worktree',
          reason: 'mediatedExecution:false',
        },
      },
    ]);

    expect(queue().filter((row) => row.kind === 'permission')).toEqual([]);
    expect(eventsOf('human.requested')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * the third front: session/request_permission itself
 * -------------------------------------------------------------------------- */

/** The ACP permission round trip, with the four kinds DeFlow offers back. */
const askStep = (toolKind: string, path: string): unknown => ({
  type: 'permission',
  title: `may I ${toolKind}`,
  toolKind,
  path,
  options: [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
  ],
  onAllowed: { steps: [{ type: 'message', text: 'allowed' }] },
  onRejected: { steps: [{ type: 'message', text: 'rejected' }] },
  onCancelled: { steps: [{ type: 'message', text: 'cancelled' }], stopReason: 'cancelled' },
});

suite('EPIC-13-S23 — session/request_permission escalates on the same terms', () => {
  it('escalates a fetch below worktree+net and answers with an option the agent offered', async () => {
    const service = escalations();
    const answering = answerWhenAsked('allow_once');

    const outcome = await runScenario([askStep('fetch', 'https://evil.example/payload')], service);
    await answering;

    expect(outcome.status).toBe('completed');
    expect(transcript(outcome)).toContain('allowed');
    expect(eventsOf('human.requested')[0]).toMatchObject({
      reason: { code: 'level-no-network' },
      permission: { method: 'network', requested: 'https://evil.example/payload' },
    });
    expect(eventsOf('permission.decided')[0]).toMatchObject({
      method: 'network',
      outcome: 'gate',
      answered: 'allow',
      by: 'operator',
      optionId: 'allow_once',
    });
  });

  it('auto-answers a read inside the worktree, and records it without asking (AC1, AC9)', async () => {
    const service = escalations();
    await runScenario([askStep('read', join(worktree, 'src', 'a.ts'))], service);

    expect(eventsOf('human.requested')).toEqual([]);
    expect(eventsOf('permission.decided')).toHaveLength(1);
    expect(eventsOf('permission.decided')[0]).toMatchObject({
      method: 'fs/read_text_file',
      outcome: 'allow',
      answered: 'allow',
      by: 'ladder',
    });
  });
});
