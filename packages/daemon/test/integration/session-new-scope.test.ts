/**
 * KAR-08.2 AC6 — `additionalDirectories: []` on the `session/new` frame that
 * actually goes out.
 *
 * Defence in depth, and the cheapest kind there is: even a vendor that honours
 * the field and bypasses DeFlow's own mediation has been told that nothing
 * outside the worktree is in scope. Omitting the field means the same thing to
 * a compliant agent and nothing at all to a reader of the transcript, so it is
 * sent explicitly and empty.
 *
 * Asserted on the **recorded wire bytes** rather than on the request object the
 * builder returns: the object is what DeFlow intended to send, and the only
 * thing that can prove what it sent is the frame. Then held against the
 * vendored ACP schema with ajv, so a field name that drifts from the SDK is a
 * failure here rather than a silently ignored key at the vendor.
 *
 * Verifies: EPIC-08-S9 (scenario 3) · AC6
 */

import type { LedgerSink } from '@DeFlow/adapters';
import { runAcpNode } from '@DeFlow/adapters';
import {
  type Handle,
  HandleSchema,
  type NodeId,
  NodeIdSchema,
  type PermissionLevel,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import { blobHandle, openLedger, readEpoch, spillBytes } from '@DeFlow/ledger';
import { acpSchema, makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { sqliteLedgerSink } from './support/ledger.ts';

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

const RUN_ID: RunId = RunIdSchema.parse('run_20260806T101500Z_ac0806');
const NODE_ID: NodeId = NodeIdSchema.parse('n1');
const PROVIDER: ProviderId = ProviderIdSchema.parse('mock');

const ajv = new Ajv2020.default({ allErrors: true, strict: false, logger: false });
ajv.addSchema(acpSchema(), 'acp');
const validateNewSession: ValidateFunction = ajv.compile({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $ref: 'acp#/$defs/NewSessionRequest',
});
const explain = (validate: ValidateFunction): string =>
  (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ''}`).join('; ');

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
  sink = sqliteLedgerSink({ db, runId: RUN_ID, epoch });
  captureEvidence = (text: string): Handle =>
    HandleSchema.parse(blobHandle(spillBytes(dir, Buffer.from(text, 'utf8'), 'text/plain').sha256));
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

/** The `session/new` params as they left the process, read back off the tee. */
async function sessionNewFrame(level: PermissionLevel): Promise<Record<string, unknown>> {
  const recordings = join(dir, 'recordings');
  const outcome = await runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: level,
      worktree,
      binary: { path: MOCK_AGENT_BIN, version: '0.0.0', sha256: 'd'.repeat(64) },
      argv: ['--seed', '42'],
      mcpServers: [],
      prompt: 'go',
    },
    {
      clock: new TestClock(),
      ledger: sink,
      captureEvidence,
      record: { DeFlow_RECORD: '1', DeFlow_RECORD_DIR: recordings, DeFlow_RECORD_CASE: 'new' },
    },
  );
  expect(outcome.status).toBe('completed');

  const lines = (await readFile(join(recordings, 'mock@0.0.0', 'new.ndjson'), 'utf8'))
    .split('\n')
    .filter((line) => line !== '');
  const frames = lines
    .map((line) => JSON.parse(line) as { msg?: { method?: string; params?: unknown } })
    .filter((entry) => entry.msg?.method === 'session/new');

  expect(frames, 'no session/new frame was recorded').toHaveLength(1);
  return (frames[0]?.msg?.params ?? {}) as Record<string, unknown>;
}

suite('EPIC-08-S9 — session/new declares no additional directories', () => {
  it.each(['read', 'worktree'] as const)(
    'carries additionalDirectories: [] at %s',
    async (level) => {
      const params = await sessionNewFrame(level);

      // The request's cwd is the node's worktree path. Matched on the tail
      // because the tee redacts machine-varying roots on the way to disk —
      // `<tmp>` is exactly what a recording is supposed to say.
      expect(String(params.cwd)).toMatch(/\/wt\/n1$/);
      // …and the field is *present* and empty, not absent.
      expect(Object.keys(params)).toContain('additionalDirectories');
      expect(params.additionalDirectories).toEqual([]);
      expect(validateNewSession(params), explain(validateNewSession)).toBe(true);
    },
  );
});
