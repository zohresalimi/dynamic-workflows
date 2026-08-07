/**
 * KAR-10.2 AC1 — the framing agent is `read`-only, and a refusal does not kill
 * the interview.
 *
 * A real mock agent over a real pipe, a real repository on disk, a real ledger,
 * no vendor CLI and no credential — which is the ACP-client dividend
 * [14 §10](../../../../docs/14-testing-strategy.md) describes: because DeFlow
 * implements `fs/*` and `terminal/*` itself, the whole ladder is *"one policy
 * function in DeFlow's own code"* and this scenario needs no vendor at all. The
 * epic's own note is the reason it is built this way rather than on a flag:
 * `--permission-prompt-tool` has already vanished from Claude Code's `--help`.
 *
 * **The rule under test is that the interview continues.** A framing agent that
 * probes and is told no is behaving correctly — it is reading a repository it
 * has never seen — and killing the node on the first refusal would make `read`
 * unusable in practice. So the assertion is not only "the write was denied" but
 * "the turn reached its own end, having been denied".
 *
 * The document half of the story is ./framing-interview.test.ts, where the
 * return contract, the bounded repair and `run.created` are exercised against a
 * real ledger. What only a process boundary can prove is this file's claim.
 *
 * Verifies: EPIC-10-S8 · AC1 · test plan #5
 */
import type { LedgerSink } from '@DeFlow/adapters';
import { runAcpNode } from '@DeFlow/adapters';
import {
  buildFramingPacket,
  FRAMING_PERMISSION,
  type Handle,
  HandleSchema,
  type NodeId,
  NodeIdSchema,
  type PermissionScope,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
  renderPacket,
} from '@DeFlow/core';
import { blobHandle, openLedger, readEpoch, readRange, spillBytes } from '@DeFlow/ledger';
import { makeRepo, makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  acpFsHandlers,
  acpTerminalHandlers,
  buildChildEnv,
  createCommandMediator,
  createFsService,
  createPathMediator,
  createTerminalService,
  permissionDeniedPayload,
  worktreeCommandPolicy,
  worktreePathPolicy,
} from '../../src/index.ts';
import { sqliteLedgerSink } from './support/ledger.ts';

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

const RUN_ID: RunId = RunIdSchema.parse('run_20260807T101500Z_ac1008');
const FRAMING: NodeId = NodeIdSchema.parse('framing');
const PROVIDER: ProviderId = ProviderIdSchema.parse('mock');

const RAW_TASK = 'Migrate the design system to Vue 3.';

let dir = '';
let repoDir = '';
let db: ReturnType<typeof openLedger>;
let sink: LedgerSink;
let captureEvidence: (text: string) => Handle;

beforeEach(async () => {
  dir = await makeTempDir();
  repoDir = join(dir, 'repo');
  await makeRepo({ dir: repoDir, files: { 'package.json': '{"name":"ui"}\n' } });
  db = openLedger(dir);
  sink = sqliteLedgerSink({ db, runId: RUN_ID, epoch: readEpoch(db) });
  captureEvidence = (text: string): Handle =>
    HandleSchema.parse(blobHandle(spillBytes(dir, Buffer.from(text, 'utf8'), 'text/plain').sha256));
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

const scopeFor = (): PermissionScope => ({
  worktree: repoDir,
  allowlist: ['git', 'pnpm', 'node'],
  readOnlyCommands: ['git status', 'git log', 'ls', 'cat'],
  allowedDomains: [],
  scrubbedEnv: [],
});

const childEnv = (): Record<string, string> =>
  buildChildEnv({ base: process.env, loginPath: process.env.PATH ?? '', tmpdir: dir }).env;

/** The framing packet, as the node is actually prompted with it — so the level
 * the boundary enforces and the level the prompt states cannot drift. */
async function framingPrompt(): Promise<string> {
  const packet = await buildFramingPacket({
    runId: RUN_ID,
    nodeId: FRAMING,
    attempt: 0,
    builtAtEvent: 1,
    target: { provider: PROVIDER, model: 'mock-1', maxContext: 200_000 },
    task: { text: RAW_TASK, sourceEvent: 1 },
    constraints: [{ form: 'require', statement: 'never commit a credential' }],
  });
  return renderPacket(packet);
}

interface Observed {
  readonly denials: string[];
  readonly commands: string[];
}

/**
 * The framing turn: read `package.json`, try to write, try to install, and
 * carry on to the end of the turn in every case.
 *
 * `onError` on each `clientCall` is what makes "the interview continues" an
 * assertion rather than a hope — without it a denied call would end the
 * scenario and the test would pass for the wrong reason.
 */
async function scenarioFile(): Promise<string> {
  const path = join(dir, 'framing.json');
  await writeFile(
    path,
    JSON.stringify({
      name: 'framing-read-only',
      steps: [
        {
          type: 'clientCall',
          method: 'fs/read_text_file',
          params: { path: join(repoDir, 'package.json') },
          onError: { steps: [{ type: 'message', text: 'read-denied {{error}}' }] },
        },
        {
          type: 'clientCall',
          method: 'fs/write_text_file',
          params: { path: join(repoDir, 'NOTES.md'), content: 'the agent wrote this\n' },
          onError: { steps: [{ type: 'message', text: 'write-denied {{error}}' }] },
        },
        {
          type: 'clientCall',
          method: 'terminal/create',
          params: { command: 'pnpm', args: ['install'] },
          onError: { steps: [{ type: 'message', text: 'terminal-denied {{error}}' }] },
        },
        { type: 'message', text: 'interview continues' },
      ],
      stopReason: 'end_turn',
    }),
  );
  return path;
}

async function runFramingTurn(): Promise<{
  readonly outcome: Awaited<ReturnType<typeof runAcpNode>>;
  readonly observed: Observed;
}> {
  const clock = new TestClock();
  const scope = scopeFor();
  const observed: Observed = { denials: [], commands: [] };

  const record = (denial: { reason: { code: string; detail?: string } }) => {
    observed.denials.push(denial.reason.code);
    void sink.append({
      kind: 'permission.denied',
      v: 1,
      ts: clock.now(),
      nodeId: FRAMING,
      attempt: 0,
      payload: permissionDeniedPayload(denial as never, { node: FRAMING, attempt: 0 }),
    });
  };

  const fs = createFsService({
    root: repoDir,
    policy: worktreePathPolicy(createPathMediator({ level: FRAMING_PERMISSION, scope }), {
      onDenied: record,
    }),
  });
  const terminal = createTerminalService({
    root: repoDir,
    childEnv: childEnv(),
    policy: worktreeCommandPolicy(createCommandMediator({ level: FRAMING_PERMISSION, scope }), {
      onDenied: (denial) => {
        // The agent's own string, before any resolution — "the command shown
        // is the command run" (KAR-08.3), read back verbatim.
        observed.commands.push(denial.requested);
        record(denial);
      },
    }),
  });

  const outcome = await runAcpNode(
    {
      runId: RUN_ID,
      nodeId: FRAMING,
      attempt: 0,
      provider: PROVIDER,
      // AC1 — the level the packet pins is the level the node is scheduled at.
      permission: FRAMING_PERMISSION,
      worktree: repoDir,
      binary: { path: MOCK_AGENT_BIN, version: '0.0.0', sha256: 'd'.repeat(64) },
      argv: ['--seed', '42', '--scenario', await scenarioFile()],
      mcpServers: [],
      prompt: await framingPrompt(),
    },
    {
      clock,
      ledger: sink,
      captureEvidence,
      handlers: { ...acpFsHandlers(fs), ...acpTerminalHandlers(terminal) },
    },
  );

  return { outcome, observed };
}

const deniedPayloads = () =>
  readRange(db, RUN_ID, 0, 500)
    .events.filter((event) => event.kind === 'permission.denied')
    .map((event) => event.payload as Record<string, unknown>);

suite('EPIC-10-S8 — the framing agent is read-only (test plan #5)', () => {
  it('runs at read, refuses the write and the install, and still finishes its turn', async () => {
    const { outcome, observed } = await runFramingTurn();

    // The interview continues: a refusal is an answer, not a crash.
    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.stopReason).toBe('end_turn');
    const text = (outcome.result.output as { text: string }).text;
    expect(text).toContain('write-denied');
    expect(text).toContain('terminal-denied');
    expect(text).toContain('interview continues');
    // The read was allowed, so the agent really can interrogate the repository.
    expect(text).not.toContain('read-denied');

    // No bytes reached the repository.
    await expect(stat(join(repoDir, 'NOTES.md'))).rejects.toThrow();
    expect(await readFile(join(repoDir, 'package.json'), 'utf8')).toBe('{"name":"ui"}\n');

    // Both refusals are recorded, at the level that made them, so the node
    // inspector can show what the agent tried.
    expect(observed.denials).toEqual(['level-read', 'level-read']);
    const denied = deniedPayloads();
    expect(denied).toHaveLength(2);
    expect(denied.every((payload) => payload.permission === FRAMING_PERMISSION)).toBe(true);
    // The attempted command, verbatim — the agent's own request object, before
    // any resolution, so the inspector shows what was asked for rather than a
    // normalised restatement of it. Parsed rather than string-compared: the
    // `cwd` in it is this machine's tmpdir.
    expect(observed.commands).toHaveLength(1);
    const attempted = JSON.parse(observed.commands[0] as string) as Record<string, unknown>;
    expect(attempted.command).toBe('pnpm');
    expect(attempted.args).toEqual(['install']);
    expect(attempted.cwd).toBe(repoDir);
  });
});
