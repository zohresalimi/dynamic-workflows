/**
 * EPIC-05-S22 — the MCP server is injected through `session/new`, and the
 * user's own configuration is never touched.
 *
 * A real turn against the real `DeFlow-mock-agent` over a real pipe, with the
 * transport tee on: the assertion is about **what arrived at the agent**, and
 * the only honest source for that is the bytes on the wire. The tee lives in
 * the transport (KAR-05.7 AC1), so what it records is the frame as sent, not
 * the client's idea of it.
 *
 * The second half is the one that would go unnoticed if it broke. Every vendor
 * CLI keeps a global MCP configuration — `~/.claude.json`, `~/.codex/`,
 * `~/.gemini/` — and writing DeFlow's tools into one of them would work
 * beautifully right up to the moment it outlived the run. Injection through
 * `session/new` is the ACP-native alternative, and "the user's HOME is
 * byte-identical afterwards" is what proves the alternative was taken.
 *
 * Verifies: EPIC-05-S22 (scenarios 1 and 2) · AC1, AC2 · test plan #1, #2
 */

import { RECORD_CASE_ENV, RECORD_DIR_ENV, RECORD_ENV, runAcpNode } from '@DeFlow/adapters';
import {
  type Handle,
  type HandleRefusal,
  HandleSchema,
  type NodeId,
  NodeIdSchema,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import { blobHandle, spillBytes } from '@DeFlow/ledger';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { MCP_SERVER_NAME, type McpHost, RUN_TOKEN_ENV, startMcpHost } from '../../src/index.ts';
import { openTestLedger, type TestLedger } from './support/ledger.ts';

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

const RUN_ID: RunId = RunIdSchema.parse('run_20260805T101500Z_ac0506');
const NODE_ID: NodeId = NodeIdSchema.parse('n1');

/** These specs never resolve a handle; the port has to be supplied, and a
 * refusal is the honest thing for a host with no artifact store behind it. */
const NO_ARTIFACTS: HandleRefusal = {
  code: 'artifact-unknown',
  message: 'this spec wired no artifact store',
};

const PROVIDER: ProviderId = ProviderIdSchema.parse('mock');

/**
 * The stand-in vendor configuration files, at the paths the five real CLIs
 * actually use. They are fixtures, but the paths are not invented: if DeFlow
 * ever grew code that wrote a global MCP config, these are the files it would
 * write.
 */
const VENDOR_CONFIG_FILES = [
  '.claude.json',
  '.codex/config.toml',
  '.config/opencode/opencode.json',
  '.gemini/settings.json',
  '.copilot/config.json',
] as const;

let dir = '';
let home = '';
let worktree = '';
let corpus = '';
let ledger: TestLedger;
let host: McpHost;

beforeEach(async () => {
  dir = await makeTempDir();
  home = join(dir, 'home');
  worktree = join(dir, 'wt', 'n1');
  corpus = join(dir, 'recordings');
  await mkdir(worktree, { recursive: true });
  for (const file of VENDOR_CONFIG_FILES) {
    const path = join(home, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, `{"mcpServers":{},"file":"${file}"}\n`, 'utf8');
  }
  ledger = openTestLedger(dir, RUN_ID);
  host = await startMcpHost({
    dataDir: dir,
    clock: new TestClock(),
    ledger: ledger.sink,
    facts: { read: () => null },
    artifacts: { resolve: () => Promise.resolve({ ok: false, refusal: NO_ARTIFACTS }) },
  });
});

afterEach(async () => {
  await host.close();
  ledger.close();
  await removeTempDir(dir);
});

/** Every file under `root`, repo-relative, with the sha256 of its bytes. */
function hashTree(root: string): Record<string, string> {
  const hashes: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      hashes[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root);
  return hashes;
}

const captureEvidence = (evidence: string | Uint8Array): Handle =>
  HandleSchema.parse(
    blobHandle(
      spillBytes(
        dir,
        typeof evidence === 'string' ? Buffer.from(evidence, 'utf8') : Buffer.from(evidence),
        'text/plain',
      ).sha256,
    ),
  );

interface RecordedLine {
  readonly dir?: string;
  readonly msg?: { readonly method?: string; readonly params?: Record<string, unknown> };
}

/** The `session/new` params as they arrived at the agent, off the wire. */
function sessionNewParams(kase: string): Record<string, unknown> {
  const lines = readFileSync(join(corpus, `${PROVIDER}@0.0.0`, `${kase}.ndjson`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RecordedLine);
  const frame = lines.find((line) => line.dir === 'in' && line.msg?.method === 'session/new');
  if (frame?.msg?.params === undefined) throw new Error('no session/new frame was recorded');
  return frame.msg.params;
}

async function runNode(kase: string): Promise<Record<string, unknown>> {
  const grant = host.grant({ runId: RUN_ID, nodeId: NODE_ID, attempt: 0, phase: 'analysis' });
  const outcome = await runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: 'worktree',
      worktree,
      binary: {
        path: MOCK_AGENT_BIN,
        version: '0.0.0',
        sha256: createHash('sha256').update(readFileSync(MOCK_AGENT_BIN)).digest('hex'),
      },
      mcpServers: [grant.mcpServer],
      // HOME is the fixture's, so any global-config write the daemon or the
      // agent made would land where this spec can see it.
      env: { ...process.env, HOME: home },
      prompt: 'summarise the repository',
    },
    {
      clock: new TestClock(),
      ledger: ledger.sink,
      captureEvidence,
      record: {
        [RECORD_ENV]: '1',
        [RECORD_DIR_ENV]: corpus,
        [RECORD_CASE_ENV]: kase,
      },
    },
  );
  expect(outcome.status).toBe('completed');
  return (outcome.newSessionRequest ?? {}) as unknown as Record<string, unknown>;
}

suite('the stdio variant is chosen (AC1)', () => {
  it('sends an untagged stdio entry naming the shim, the socket and the run', async () => {
    const sent = await runNode('session-new');
    const params = sessionNewParams('session-new');
    const servers = params.mcpServers as Record<string, unknown>[];

    expect(servers).toHaveLength(1);
    const entry = servers[0] ?? {};
    expect(Object.keys(entry)).not.toContain('type');
    expect(entry.name).toBe(MCP_SERVER_NAME);

    // The recording is scrubbed before it is written — `recordings/` is public
    // — so an absolute path under HOME comes back placeheld. The unredacted
    // frame is the one the client kept, and it is where `command` is checked
    // byte-for-byte.
    expect(String(entry.command)).toMatch(/node$/);
    const sentEntry = (sent.mcpServers as Record<string, unknown>[])[0] ?? {};
    expect(sentEntry.command).toBe(process.execPath);
    expect(Object.keys(sentEntry)).not.toContain('type');

    const args = entry.args as string[];
    expect(args[0]).toMatch(/DeFlow-mcp/);
    expect(args).toContain('--socket');
    expect(args[args.indexOf('--run') + 1]).toBe(RUN_ID);

    const env = entry.env as { name: string; value: string }[];
    const token = env.find((variable) => variable.name === RUN_TOKEN_ENV);
    expect(token?.value).toMatch(/^[0-9a-f]{32,}$/);
  });

  it('scopes the token to one run: a second node gets a different one', () => {
    const first = host.grant({ runId: RUN_ID, nodeId: NODE_ID, attempt: 0, phase: 'analysis' });
    const second = host.grant({
      runId: RUN_ID,
      nodeId: NodeIdSchema.parse('n2'),
      attempt: 0,
      phase: 'analysis',
    });
    expect(first.token).not.toBe(second.token);
  });
});

suite("the user's global MCP configuration is never written (AC2)", () => {
  it('leaves every vendor config file byte-identical across a full run', async () => {
    const before = hashTree(home);
    expect(Object.keys(before).sort()).toEqual([...VENDOR_CONFIG_FILES].sort());

    await runNode('untouched-home');

    expect(hashTree(home)).toEqual(before);
  });

  it('creates no file at all under the fixture HOME', async () => {
    const before = statSync(home).mtimeMs;
    await runNode('no-new-files');
    expect(Object.keys(hashTree(home)).sort()).toEqual([...VENDOR_CONFIG_FILES].sort());
    expect(statSync(home).mtimeMs).toBe(before);
  });
});
