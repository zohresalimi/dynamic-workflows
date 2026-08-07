/**
 * KAR-08.7 AC2, AC6 — EPIC-08-S11: `ToolCallLocation.path` rejects an
 * out-of-scope write at request time, over a real mock agent and a real
 * ledger.
 *
 * The unit suite (../../src/services/permission-ladder.test.ts) proves the
 * check itself against a `PermissionQuery` port. What only a real ACP round
 * trip proves is the thing the scenario actually asks for: that the rejection
 * reaches the agent as an ordinary `reject_once` and the turn continues, that
 * the write it would have made never lands on disk, and that a
 * `permission.denied` event carrying `requested` and `declared` as separate
 * structured fields is on the ledger afterwards — not a message string, and
 * not something a caller has to reconstruct from `reason.detail`.
 *
 * Verifies: EPIC-08-S11 · AC2, AC6
 */
import type { EventRecord, IoRecord, LedgerSink } from '@DeFlow/adapters';
import { runAcpNode } from '@DeFlow/adapters';
import {
  type EventSeq,
  type Handle,
  HandleSchema,
  type NodeId,
  NodeIdSchema,
  type PermissionScope,
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
  readRange,
  spillBytes,
} from '@DeFlow/ledger';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  acpPermissionHandlers,
  createPermissionService,
  ladderDecider,
  ladderDeniedPayload,
} from '../../src/index.ts';

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

const RUN_ID: RunId = RunIdSchema.parse('run_20260807T090000Z_ac0807');
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
  await mkdir(join(worktree, 'src'), { recursive: true });
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

/** Built fresh per call, never captured at module load: `worktree` is only
 * assigned inside `beforeEach`, and a `SCOPE` constant built at module scope
 * would close over the empty string it starts as. */
const scopeFor = (): PermissionScope => ({
  worktree,
  allowlist: [],
  readOnlyCommands: [],
  allowedDomains: [],
  scrubbedEnv: [],
});

/** A `session/request_permission` for an out-of-scope edit, with both
 * polarities offered — the agent's own option list decides which `optionId`
 * comes back, and the branch it takes is what the transcript proves. */
async function scenario(path: string): Promise<string> {
  const scenarioPath = join(dir, 'scope-violation.json');
  await writeFile(
    scenarioPath,
    JSON.stringify({
      name: 'scope-violation',
      steps: [
        {
          type: 'permission',
          title: 'Rewrite the infra config',
          toolKind: 'edit',
          path,
          options: [
            { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'r1', name: 'Reject once', kind: 'reject_once' },
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
  return scenarioPath;
}

async function runWith(scenarioPath: string) {
  const clock = new TestClock();
  const permission = createPermissionService(
    ladderDecider({
      level: 'worktree',
      scope: scopeFor(),
      pathScope: ['src/**'],
      record: (decision) => {
        const payload = ladderDeniedPayload(decision, { node: NODE_ID, attempt: 0 });
        if (payload === null) return;
        void sink.append({
          kind: 'permission.denied',
          v: 1,
          ts: clock.now(),
          nodeId: NODE_ID,
          attempt: 0,
          payload,
        });
      },
    }),
  );

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
    {
      clock,
      ledger: sink,
      captureEvidence,
      handlers: acpPermissionHandlers(permission),
    },
  );
}

const denials = () =>
  readRange(db, RUN_ID, 0, 500).events.filter((event) => event.kind === 'permission.denied');

suite('EPIC-08-S11 — an in-worktree but out-of-scope write is rejected before it happens', () => {
  it('answers reject_once, the node continues, and the file is never written', async () => {
    const target = join(worktree, 'infra', 'main.tf');

    const outcome = await runWith(await scenario(target));

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.stopReason).toBe('refusal');
    expect((outcome.result.output as { text: string }).text).toContain('branch:onRejected');

    await expect(stat(target)).rejects.toThrow();
  });

  it('records requested and declared as separate structured fields, not a sentence', async () => {
    const target = join(worktree, 'infra', 'main.tf');

    await runWith(await scenario(target));

    expect(denials()).toHaveLength(1);
    expect(denials()[0]?.payload).toEqual({
      node: 'n1',
      attempt: 0,
      permission: 'worktree',
      method: 'fs/write_text_file',
      requested: target,
      reason: { code: 'scope-violation', detail: 'infra/main.tf' },
      declared: ['src/**'],
    });
  });

  it('allows an in-scope edit through, with no denial recorded at all', async () => {
    const target = join(worktree, 'src', 'a.ts');

    const outcome = await runWith(await scenario(target));

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;
    expect(outcome.stopReason).toBe('end_turn');
    expect((outcome.result.output as { text: string }).text).toContain('branch:onAllowed');
    expect(denials()).toEqual([]);
  });
});
