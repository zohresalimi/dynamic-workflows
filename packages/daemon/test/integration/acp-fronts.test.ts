/**
 * EPIC-05-S5 — `session/request_permission` reaches the client, and the `fs/*`
 * and `terminal/*` fronts reach real services.
 *
 * The policy itself is EPIC-08. What this locks down is the *shape*:
 * transport-neutral services with thin fronts, wired into the ACP client as
 * data, so that when ACP v2 removes these methods from the client the MCP
 * front is re-pointed and the ACP one is deleted.
 *
 * A real mock agent over a real pipe, a real worktree on disk and a real
 * ledger: the round trip under test is "the agent asked, the client answered,
 * the agent took the corresponding branch", and every step of it is on the
 * other side of a process boundary.
 *
 * Verifies: EPIC-05-S5 · AC6
 */

import type { EventRecord, IoRecord, LedgerSink } from '@DeFlow/adapters';
import { runAcpNode } from '@DeFlow/adapters';
import {
  type EventSeq,
  type Handle,
  HandleSchema,
  type NodeId,
  NodeIdSchema,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import {
  appendEvents,
  appendIoChunk,
  blobHandle,
  openLedger,
  readEpoch,
  spillBytes,
} from '@DeFlow/ledger';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  acpFsHandlers,
  acpPermissionHandlers,
  acpTerminalHandlers,
  buildChildEnv,
  createFsService,
  createPermissionService,
  createTerminalService,
  type PermissionDecision,
  type PermissionQuery,
} from '../../src/index.ts';

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

/** KAR-08.4: `createTerminalService` requires a built `childEnv`. This suite
 * is not exercising the scrubbing itself (see
 * test/integration/env-scrubbing.test.ts for that) — `process.env.PATH` is
 * enough for these fixtures' bare `echo`. */
const testChildEnv = (tmp: string): Record<string, string> =>
  buildChildEnv({ base: process.env, loginPath: process.env.PATH ?? '', tmpdir: tmp }).env;

const RUN_ID: RunId = RunIdSchema.parse('run_20260805T101500Z_ac0505');
const NODE_ID: NodeId = NodeIdSchema.parse('n1');
const PROVIDER: ProviderId = ProviderIdSchema.parse('mock');

let dir = '';
let worktree = '';
let db: ReturnType<typeof openLedger>;
let sink: LedgerSink;
let captureEvidence: (text: string) => Handle;

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  await mkdir(worktree, { recursive: true });
  db = openLedger(dir);
  const epoch = readEpoch(db);
  sink = {
    append: (event: EventRecord) =>
      Promise.resolve(
        appendEvents(db, [
          {
            runId: RUN_ID,
            ts: event.ts,
            kind: event.kind,
            v: event.v,
            epoch,
            nodeId: event.nodeId,
            attempt: event.attempt,
            ...(event.ikey === undefined ? {} : { ikey: event.ikey }),
            payload: event.payload,
          },
        ])[0] as EventSeq,
      ),
    appendIo: (chunk: IoRecord) =>
      Promise.resolve(
        appendIoChunk(db, {
          runId: RUN_ID,
          nodeId: chunk.nodeId,
          attempt: chunk.attempt + 1,
          stream: chunk.stream,
          ts: chunk.ts,
          data: chunk.data,
        }),
      ),
  };
  captureEvidence = (text: string): Handle =>
    HandleSchema.parse(blobHandle(spillBytes(dir, Buffer.from(text, 'utf8'), 'text/plain').sha256));
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

/** The permission policy EPIC-08 owns, stubbed to one fixed answer so this
 * spec is about the round trip and not about the ladder. */
function decider(decision: PermissionDecision): {
  decide: (query: PermissionQuery) => Promise<PermissionDecision>;
  seen: PermissionQuery[];
} {
  const seen: PermissionQuery[] = [];
  return {
    seen,
    decide: (query) => {
      seen.push(query);
      return Promise.resolve(decision);
    },
  };
}

/** A scenario written into the worktree's own tmpdir, so the tool-call
 * location is genuinely a path inside the worktree. */
async function permissionScenario(): Promise<string> {
  const path = join(dir, 'permission.json');
  await writeFile(
    path,
    JSON.stringify({
      name: 'execute-permission',
      steps: [
        {
          type: 'permission',
          title: 'Run the tests',
          toolKind: 'execute',
          path: join(worktree, 'package.json'),
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject_always', name: 'Always reject', kind: 'reject_always' },
          ],
          onAllowed: {
            steps: [{ type: 'message', text: 'branch:onAllowed' }],
            stopReason: 'end_turn',
          },
          onRejected: {
            steps: [{ type: 'message', text: 'branch:onRejected' }],
            stopReason: 'refusal',
          },
          onCancelled: {
            steps: [{ type: 'message', text: 'branch:onCancelled' }],
            stopReason: 'cancelled',
          },
        },
      ],
      stopReason: 'end_turn',
    }),
  );
  return path;
}

async function runWith(
  handlers: Record<string, (params: never) => unknown>,
  scenarioPath: string,
): Promise<Awaited<ReturnType<typeof runAcpNode>>> {
  return runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: 'worktree',
      worktree,
      binary: { path: MOCK_AGENT_BIN, version: '0.0.0', sha256: 'b'.repeat(64) },
      argv: ['--seed', '42', '--scenario', scenarioPath],
      mcpServers: [],
      prompt: 'go',
    },
    { clock: new TestClock(), ledger: sink, captureEvidence, handlers },
  );
}

suite('the client is actually asked', () => {
  it('receives the request params and the agent follows the returned optionId', async () => {
    const policy = decider({ outcome: 'selected', optionId: 'allow_once' });
    const outcome = await runWith(
      acpPermissionHandlers(createPermissionService(policy.decide)),
      await permissionScenario(),
    );

    expect(policy.seen).toHaveLength(1);
    const query = policy.seen[0];
    expect(query?.toolKind).toBe('execute');
    expect(query?.locations).toEqual([{ path: join(worktree, 'package.json') }]);
    expect(query?.options.map((option) => option.optionId)).toEqual([
      'allow_once',
      'reject_always',
    ]);

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.stopReason).toBe('end_turn');
    expect((outcome.result.output as { text: string }).text).toContain('branch:onAllowed');
  });
});

suite('every outcome shape is handled', () => {
  const cases: { decision: PermissionDecision; branch: string; stopReason: string }[] = [
    {
      decision: { outcome: 'selected', optionId: 'allow_once' },
      branch: 'branch:onAllowed',
      stopReason: 'end_turn',
    },
    {
      decision: { outcome: 'selected', optionId: 'reject_always' },
      branch: 'branch:onRejected',
      stopReason: 'refusal',
    },
    // The variant implementations forget: `{ outcome: 'cancelled' }` has no
    // optionId, and an agent that destructures one unconditionally wedges.
    { decision: { outcome: 'cancelled' }, branch: 'branch:onCancelled', stopReason: 'cancelled' },
  ];

  it.for(cases)(
    '$decision.outcome $decision.optionId',
    async ({ decision, branch, stopReason }) => {
      const policy = decider(decision);
      const outcome = await runWith(
        acpPermissionHandlers(createPermissionService(policy.decide)),
        await permissionScenario(),
      );

      // The turn reaches a terminal stop reason without the harness killing the
      // process: a permission round trip that wedges is a node that never ends.
      expect(outcome.exit).toEqual({ code: 0, signal: null });
      if (outcome.status === 'completed') {
        expect(outcome.stopReason).toBe(stopReason);
        expect((outcome.result.output as { text: string }).text).toContain(branch);
        return;
      }
      expect(outcome.status).toBe('cancelled');
      if (outcome.status !== 'cancelled') return;
      expect(outcome.stopReason).toBe(stopReason);
    },
  );
});

suite('the fs and terminal fronts reach real services', () => {
  it('reads and writes real files in the worktree, and runs a real command', async () => {
    await writeFile(join(worktree, 'input.txt'), 'from disk\n');
    const scenarioPath = join(dir, 'callbacks.json');
    await writeFile(
      scenarioPath,
      JSON.stringify({
        name: 'callbacks',
        steps: [
          {
            type: 'clientCall',
            method: 'fs/read_text_file',
            params: { path: join(worktree, 'input.txt') },
          },
          {
            type: 'clientCall',
            method: 'fs/write_text_file',
            params: { path: join(worktree, 'output.txt'), content: 'written by the agent\n' },
          },
          {
            type: 'clientCall',
            method: 'terminal/create',
            params: { command: 'echo', args: ['hello from the terminal service'] },
          },
          { type: 'clientCall', method: 'terminal/wait_for_exit', params: {} },
          { type: 'clientCall', method: 'terminal/output', params: {} },
          { type: 'clientCall', method: 'terminal/release', params: {} },
        ],
        stopReason: 'end_turn',
      }),
    );

    const fs = createFsService({ root: worktree });
    const terminal = createTerminalService({ root: worktree, childEnv: testChildEnv(dir) });
    const outcome = await runWith(
      { ...acpFsHandlers(fs), ...acpTerminalHandlers(terminal) },
      scenarioPath,
    );

    expect(outcome.status).toBe('completed');
    // The write went to the real filesystem, through the service.
    expect(await readFile(join(worktree, 'output.txt'), 'utf8')).toBe('written by the agent\n');
    // And the terminal service really ran the command.
    expect(terminal.snapshot()).toContain('hello from the terminal service');
  });
});
