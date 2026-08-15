/**
 * KAR-09.5 AC4, AC5 — `DeFlow_read_artifact` end to end: a real `deflow-mcp`
 * child process, real MCP frames over its stdio, a real Unix domain socket, a
 * real file-backed ledger, a real content-addressed store and a real worktree
 * on disk.
 *
 * Integration for the reason the whole story exists: the claim is that an agent
 * can pull back a body DeFlow offloaded, and that it cannot pull back a file its
 * permission level forbids. Both are claims about what crosses two process
 * boundaries, and a mocked store proves neither.
 *
 * The artifact under test is produced the way a run produces one — `buildPacket`
 * offloads it because it is over the inline threshold, `persistContextPacket`
 * stores the bytes and indexes them under the run — rather than planted by the
 * spec, so what is resolved here is what a node would really have been handed.
 *
 * Verifies: EPIC-09-S26 (second and third scenarios), EPIC-09-S27 (third
 * scenario), EPIC-09-S29 · AC4, AC5 · test plan #4, #5, #6
 */
import type { PermissionScope, Segment, TaskSpec } from '@DeFlow/core';
import {
  buildPacket,
  contextSegment,
  type NodeHandleAccess,
  type NodeId,
  NodeIdSchema,
  type RunId,
  RunIdSchema,
  TaskSpecSchema,
} from '@DeFlow/core';
import { persistContextPacket, putBlob } from '@DeFlow/ledger';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { type McpHost, READ_ARTIFACT, runArtifactStore, startMcpHost } from '../../src/index.ts';
import { openTestLedger, type TestLedger } from './support/ledger.ts';
import { type McpChild, spawnMcpServer } from './support/mcp-client.ts';

const RUN_ID: RunId = RunIdSchema.parse('run_20260807T101500Z_ac0905');
const OTHER_RUN: RunId = RunIdSchema.parse('run_20260807T101500Z_ff0905');
const NODE_ID: NodeId = NodeIdSchema.parse('review');

const specFixture = fileURLToPath(
  new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
);

function approvedSpec(): TaskSpec {
  const draft: Record<string, unknown> = JSON.parse(readFileSync(specFixture, 'utf8'));
  draft.approvedBy = { at: '2026-08-06T09:00:00Z', via: 'ui' };
  return TaskSpecSchema.parse(draft);
}

/** EPIC-09-S26's background: 412 lines, 38.4 KB, from a failed `pnpm -r build`. */
function fixedSizeLog(lines: number, bytes: number): string {
  const content = bytes - (lines - 1);
  const per = Math.floor(content / lines);
  const rows = Array.from({ length: lines }, (_, index) => `${index + 1} `.padEnd(per, 'x'));
  rows[lines - 1] += 'x'.repeat(content - per * lines);
  return rows.join('\n');
}

const BUILD_LOG = fixedSizeLog(412, 39_322);
const CART = Array.from({ length: 60 }, (_, index) => `// cart line ${index + 1}`).join('\n');
const SECRETS = Array.from({ length: 30 }, (_, index) => `secret_line_${index + 1}`).join('\n');

let dir = '';
let worktree = '';
let ledger: TestLedger;
let host: McpHost;
const children: McpChild[] = [];

const runDirOf = (runId: string): string => join(dir, 'runs', runId);

function permissionScope(): PermissionScope {
  return {
    worktree,
    allowlist: ['git', 'pnpm'],
    readOnlyCommands: ['git status'],
    allowedDomains: [],
    scrubbedEnv: [],
  };
}

/** The review node of EPIC-09-S29: level `read`, read scope `src/checkout/**`. */
function readNodeAccess(): NodeHandleAccess {
  return { level: 'read', scope: permissionScope(), readScope: ['src/checkout/**'] };
}

/** Offloads `BUILD_LOG` the way a run does, and returns its handle. */
async function offloadBuildLog(runId: RunId, nodeId: string): Promise<string> {
  const segments: Segment[] = [
    await contextSegment({
      id: 'build-log',
      kind: 'tool.output',
      text: BUILD_LOG,
      sourceEvent: 23,
    }),
  ];
  const built = await buildPacket({
    runId,
    nodeId,
    attempt: 0,
    builtAtEvent: 60,
    target: { provider: 'claude-code', model: 'sonnet-4-6', maxContext: 200_000 },
    pinned: {
      spec: approvedSpec(),
      node: { pathScopes: ['src/checkout/**'], permission: 'read' },
      sourceEvent: 9,
    },
    segments,
    descriptions: { 'build-log': 'build-log for `pnpm -r build` (fail)' },
  });
  // The spec's own ledger connection: SQLite permits exactly one writer, and
  // the host is already holding it.
  persistContextPacket(ledger.db, {
    dataDir: dir,
    runDir: runDirOf(runId),
    packet: built.packet,
    demotion: built.demotion,
    ts: 1_754_557_200_000,
    epoch: 1,
  });
  const handle = built.demotion.demotedToHandles[0];
  if (handle === undefined) throw new Error('the build offloaded nothing');
  return handle;
}

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'worktrees', 'review');
  mkdirSync(join(worktree, 'src', 'checkout'), { recursive: true });
  mkdirSync(join(worktree, 'infra'), { recursive: true });
  writeFileSync(join(worktree, 'src', 'checkout', 'cart.ts'), CART, 'utf8');
  writeFileSync(join(worktree, 'infra', 'secrets.tf'), SECRETS, 'utf8');

  ledger = openTestLedger(dir, RUN_ID);
  host = await startMcpHost({
    dataDir: dir,
    clock: new TestClock(),
    ledger: ledger.sink,
    facts: { read: () => null },
    artifacts: runArtifactStore({ dataDir: dir, runDirOf }),
  });
});

afterEach(async () => {
  for (const child of children) child.kill();
  children.length = 0;
  await host.close();
  ledger.close();
  await removeTempDir(dir);
});

/** `{ access: null }` is a grant that carried none — distinct from the default,
 * which is EPIC-09-S29's `read`-level review node. */
async function connect(options: { readonly access?: NodeHandleAccess | null } = {}) {
  const access = options.access === undefined ? readNodeAccess() : options.access;
  const grant = host.grant({
    runId: RUN_ID,
    nodeId: NODE_ID,
    attempt: 0,
    phase: 'implementation',
    ...(access === null ? {} : { access }),
  });
  const { started, ready } = spawnMcpServer(grant.mcpServer);
  children.push(started);
  return { grant, agent: await ready };
}

const call = (agent: McpChild, handle: string) =>
  agent.request('tools/call', { name: READ_ARTIFACT, arguments: { handle } });

const errorTextOf = (result: Record<string, unknown>): string =>
  JSON.stringify(result.content ?? '');

suite('the agent pulls the full body back (EPIC-09-S26, AC4, test plan #4)', () => {
  it('resolves an artifact:// handle to the complete 412-line body', async () => {
    const handle = await offloadBuildLog(RUN_ID, 'implement');
    const { agent } = await connect();

    const result = await call(agent, handle);

    expect(result.isError).toBeFalsy();
    const output = result.structuredContent as Record<string, unknown>;
    expect(output.handle).toBe(handle);
    expect(output.truncated).toBe(false);
    expect(output.bytes).toBe(39_322);
    expect(output.text).toBe(BUILD_LOG);
    expect(String(output.text).split('\n').length).toBe(412);
  });

  it('names the tool the handle line told the agent to call', async () => {
    const { agent } = await connect();
    const names = (await agent.listTools()).map((tool) => tool.name);
    expect(names).toContain('DeFlow_read_artifact');
  });

  it('was reachable because session/new carried the untagged stdio variant', async () => {
    const { grant } = await connect();
    expect(Object.keys(grant.mcpServer)).not.toContain('type');
    expect(grant.mcpServer.args).toContain('--socket');
  });
});

suite('a file:// handle addresses a line range (EPIC-09-S27, AC4)', () => {
  it('returns exactly lines 12 to 40 of a file inside the declared scope', async () => {
    const { agent } = await connect();

    const result = await call(agent, 'file://src/checkout/cart.ts#L12-L40');

    expect(result.isError).toBeFalsy();
    const text = String((result.structuredContent as Record<string, unknown>).text);
    expect(text.split('\n').length).toBe(29);
    expect(text.startsWith('// cart line 12')).toBe(true);
    expect(text.endsWith('// cart line 40')).toBe(true);
  });

  it('refuses a range that starts past the end rather than returning nothing', async () => {
    const { agent } = await connect();

    const result = await call(agent, 'file://src/checkout/cart.ts#L900-L920');

    expect(result.isError).toBe(true);
    expect(errorTextOf(result)).toContain('line-range-empty');
  });
});

suite('the tool is not a permission bypass (EPIC-09-S29, AC4, test plan #5)', () => {
  it('refuses a read-level node reaching outside its scope, and records it', async () => {
    const { agent } = await connect();

    const result = await call(agent, 'file://infra/secrets.tf#L1-L20');

    expect(result.isError).toBe(true);
    const message = errorTextOf(result);
    // Names the level and the scope (EPIC-09-S29's first scenario).
    expect(message).toContain('read');
    expect(message).toContain('src/checkout/**');
    // And no file content came back with it.
    expect(message).not.toContain('secret_line_1');
    expect(result.structuredContent).toBeUndefined();

    const denials = ledger.eventsOf('permission.denied');
    expect(denials).toEqual([
      {
        node: NODE_ID,
        attempt: 0,
        permission: 'read',
        method: 'fs/read_text_file',
        requested: 'file://infra/secrets.tf#L1-L20',
        reason: { code: 'scope-violation', detail: 'infra/secrets.tf' },
        declared: ['src/checkout/**'],
      },
    ]);
  });

  it('refuses a path that escapes the worktree entirely', async () => {
    const { agent } = await connect();

    const result = await call(agent, 'file://../../etc/passwd#L1-L2');

    expect(result.isError).toBe(true);
    expect(errorTextOf(result)).toContain('path-escape');
    expect(ledger.eventsOf('permission.denied').length).toBe(1);
  });

  it('refuses every file handle when the node’s scope was never wired up', async () => {
    const { agent } = await connect({ access: null });

    const result = await call(agent, 'file://src/checkout/cart.ts#L12-L40');

    expect(result.isError).toBe(true);
    expect(errorTextOf(result)).toContain('permission-denied');
  });
});

suite('an unresolvable handle fails typed, never empty (AC5, test plan #6)', () => {
  it('names the digest it could not find', async () => {
    const missing = `artifact://${'b'.repeat(64)}`;
    const { agent } = await connect();

    const result = await call(agent, missing);

    expect(result.isError).toBe(true);
    const message = errorTextOf(result);
    expect(message).toContain('artifact-unknown');
    expect(message).toContain('b'.repeat(64));
    expect(result.structuredContent).toBeUndefined();
  });

  it('refuses a handle another run recorded, naming the run boundary', async () => {
    const handle = await offloadBuildLog(OTHER_RUN, 'implement');
    const { agent } = await connect();

    const result = await call(agent, handle);

    expect(result.isError).toBe(true);
    const message = errorTextOf(result);
    expect(message).toContain('artifact-foreign-run');
    expect(message).toContain(RUN_ID);
    expect(message).toContain(handle.slice('artifact://'.length));
    expect(result.structuredContent).toBeUndefined();
  });

  it('refuses a handle that is not a handle', async () => {
    const { agent } = await connect();

    const result = await call(agent, 'artifact://not-a-digest');

    expect(result.isError).toBe(true);
    expect(errorTextOf(result)).toContain('handle-malformed');
  });

  it('refuses bytes the store lost, rather than answering with an empty body', async () => {
    // Indexed under the run, but never written to the store: the failure a
    // content-addressed store cannot repair by itself, and the one place an
    // empty success would look most plausible.
    const handle = await offloadBuildLog(RUN_ID, 'implement');
    const sha = handle.slice('artifact://'.length);
    const orphan = putBlob(dir, Buffer.from('unrelated', 'utf8'), 'text/plain');
    expect(orphan).not.toBe(handle);
    writeFileSync(join(dir, 'blobs', sha.slice(0, 2), sha), 'tampered', 'utf8');

    const { agent } = await connect();
    const result = await call(agent, handle);

    expect(result.isError).toBe(true);
    expect(errorTextOf(result)).toContain(sha);
  });
});
