/**
 * EPIC-05-S23 — a workflow tool call reaches DeFlowd over the UDS.
 *
 * Integration, and every boundary in it is real: a real `DeFlow-mcp` child
 * process spawned exactly as an agent would spawn it (same `command`, same
 * `args`, same `env` as the `mcpServers` entry `session/new` carried), real
 * MCP frames over its stdio, a real Unix domain socket back to a real host,
 * and a real file-backed ledger on the other side. Nothing here is a double:
 * the claim is "the request crossed two process boundaries and the event is
 * durable", and a mocked socket proves none of it.
 *
 * Verifies: EPIC-05-S23 · AC3, AC5, AC7 · test plan #3, #5, #7
 */
import {
  type Fact,
  FactSchema,
  type NodeId,
  NodeIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import { getBlob, putBlob } from '@DeFlow/ledger';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type McpHost,
  PROPOSE_PLAN_PATCH,
  READ_ARTIFACT,
  READ_FACT,
  startMcpHost,
} from '../../src/index.ts';
import { openTestLedger, type TestLedger } from './support/ledger.ts';
import { type McpChild, spawnMcpServer } from './support/mcp-client.ts';

const RUN_ID: RunId = RunIdSchema.parse('run_20260805T101500Z_ac0506');
const NODE_ID: NodeId = NodeIdSchema.parse('n1');

const FACT: Fact = FactSchema.parse({
  id: 'fact_01jq9v3m0000000000000000zz',
  key: 'finding/auth-uses-jwt',
  kind: 'finding',
  schemaId: 'DeFlow.finding.v1',
  value: { detail: 'sessions are signed JWTs' },
  provenance: {
    byNode: 'n0',
    byProvider: 'mock',
    byModel: 'mock-1',
    fromEvidence: [],
    atEvent: 4,
    at: '2026-08-05T10:15:00.000Z',
    confidence: 'verified',
  },
});

let dir = '';
let ledger: TestLedger;
let host: McpHost;
let logLines: string[] = [];
const children: McpChild[] = [];

beforeEach(async () => {
  dir = await makeTempDir();
  ledger = openTestLedger(dir, RUN_ID);
  logLines = [];
  host = await startMcpHost({
    dataDir: dir,
    clock: new TestClock(),
    ledger: ledger.sink,
    facts: { read: (key: string) => (key === FACT.key ? FACT : null) },
    artifacts: {
      read(handle: string): Uint8Array | null {
        // The daemon's real content-addressed blob store, which verifies each
        // blob against its own digest on read.
        try {
          return getBlob(dir, handle);
        } catch {
          return null;
        }
      },
    },
    destination: {
      write(line: string): void {
        logLines.push(line);
      },
    },
  });
});

afterEach(async () => {
  for (const child of children) child.kill();
  children.length = 0;
  await host.close();
  ledger.close();
  await removeTempDir(dir);
});

async function connect(phase: 'analysis' | 'implementation' = 'implementation') {
  const grant = host.grant({ runId: RUN_ID, nodeId: NODE_ID, attempt: 0, phase });
  const { started, ready } = spawnMcpServer(grant.mcpServer);
  children.push(started);
  return { grant, agent: await ready };
}

suite('a tool round-trips (AC5)', () => {
  it('crosses the UDS, appends fact.read and answers with the fact', async () => {
    const { agent } = await connect();

    const result = await agent.request('tools/call', {
      name: READ_FACT,
      arguments: { key: FACT.key },
    });

    expect(result.structuredContent).toMatchObject({
      factId: FACT.id,
      key: FACT.key,
      kind: 'finding',
      value: { detail: 'sessions are signed JWTs' },
    });

    const reads = ledger.eventsOf('fact.read');
    expect(reads).toEqual([{ factId: FACT.id, key: FACT.key, by: NODE_ID }]);
  });

  it('declares both schemas on every tool it lists', async () => {
    const { agent } = await connect();
    const tools = await agent.listTools();
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.inputSchema, `${tool.name} inputSchema`).toBeDefined();
      expect(tool.outputSchema, `${tool.name} outputSchema`).toBeDefined();
    }
  });

  it('pulls an artifact by handle through the same socket', async () => {
    const handle = putBlob(dir, Buffer.from('the report body', 'utf8'), 'text/plain');

    const { agent } = await connect();
    const result = await agent.request('tools/call', {
      name: READ_ARTIFACT,
      arguments: { handle },
    });

    expect(result.structuredContent).toMatchObject({ handle, text: 'the report body' });
  });

  it('reports a missing fact as a tool error rather than a protocol error', async () => {
    const { agent } = await connect();
    const result = await agent.request('tools/call', {
      name: READ_FACT,
      arguments: { key: 'finding/not-written-yet' },
    });
    expect(result.isError).toBe(true);
    expect(ledger.eventsOf('fact.read')).toEqual([]);
  });
});

suite('the socket is filesystem-protected, not port-protected (AC3)', () => {
  it('puts the socket in a directory the owner alone can enter', () => {
    expect(statSync(dirname(host.socketPath)).mode & 0o777).toBe(0o700);
  });

  it('leaves the socket itself owner-only rather than at whatever umask said', () => {
    expect(statSync(host.socketPath).mode & 0o777).toBe(0o600);
  });

  it('binds a path, never a TCP port', () => {
    expect(typeof host.listeningOn()).toBe('string');
    expect(host.listeningOn()).toBe(host.socketPath);
  });
});

suite('a bad token is refused (AC3)', () => {
  it('refuses the connection, logs the presented run and serves no tool', async () => {
    const grant = host.grant({
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      phase: 'implementation',
    });
    const forged = {
      ...grant.mcpServer,
      env: [{ name: 'DeFlow_RUN_TOKEN', value: 'f'.repeat(64) }],
    };

    const { started } = spawnMcpServer(forged, { handshake: false });
    children.push(started);
    const exit = await started.exited();

    expect(exit.code).not.toBe(0);
    expect(started.stderr()).toMatch(/refus/i);
    expect(logLines.join('\n')).toContain(RUN_ID);
    expect(logLines.join('\n')).toMatch(/refus/i);
    expect(host.connections).toBe(0);
  });

  it('refuses a token that has already been spent — it is one-time (AC1)', async () => {
    const { grant } = await connect();
    const { started } = spawnMcpServer(grant.mcpServer, { handshake: false });
    children.push(started);

    const exit = await started.exited();
    expect(exit.code).not.toBe(0);
    expect(started.stderr()).toMatch(/refus/i);
  });
});

suite('the shim dies with its agent (AC7)', () => {
  it('exits on stdin EOF and releases the socket', async () => {
    const { agent } = await connect();
    expect(host.connections).toBe(1);

    agent.closeStdin();
    const exit = await agent.exited();

    expect(exit.code).toBe(0);
    // The host observes the close on its side, so no shim is left holding a
    // connection to a socket nobody will use again.
    await expect.poll(() => host.connections, { timeout: 2_000 }).toBe(0);
  });

  it('exits when the grant is revoked, so an ended node keeps no shim alive', async () => {
    const { grant, agent } = await connect();
    grant.revoke();

    const exit = await agent.exited();
    expect(exit.code).toBe(0);
    await expect.poll(() => host.connections, { timeout: 2_000 }).toBe(0);
  });

  it('exits within two seconds of the agent being killed', async () => {
    const { agent } = await connect();
    const started = Date.now();
    agent.kill();
    const exit = await agent.exited();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(exit.signal).toBe('SIGKILL');
    await expect.poll(() => host.connections, { timeout: 2_000 }).toBe(0);
  });
});

suite('a tool the phase does not include is not served (AC6)', () => {
  it('refuses proposePlanPatch during analysis and records the attempt', async () => {
    const { agent } = await connect('analysis');

    expect((await agent.listTools()).map((tool) => tool.name)).not.toContain(PROPOSE_PLAN_PATCH);

    // A tool error, not a protocol error: MCP reports a refusal inside the
    // result so the model can read it and choose something else.
    const result = await agent.request('tools/call', {
      name: PROPOSE_PLAN_PATCH,
      arguments: { patch: {} },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain(PROPOSE_PLAN_PATCH);

    await expect
      .poll(() =>
        ledger
          .eventsOf('node.progress')
          .some((payload) => String(payload.message).includes(PROPOSE_PLAN_PATCH)),
      )
      .toBe(true);
  });
});
