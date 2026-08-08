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
import { putBlob, recordRunArtifact } from '@DeFlow/ledger';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type McpHost,
  PROPOSE_PLAN_PATCH,
  READ_ARTIFACT,
  READ_FACT,
  runArtifactStore,
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
const runDirOf = (runId: string): string => join(dir, 'runs', runId);
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
    // The daemon's real resolver over the real content-addressed blob store,
    // which verifies each blob against its own digest on read.
    artifacts: runArtifactStore({ dataDir: dir, runDirOf }),
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
    const body = 'the report body';
    const handle = putBlob(dir, Buffer.from(body, 'utf8'), 'text/plain');
    // KAR-09.5: the bytes are global, but the permission to reach them through
    // this tool is per run, so the run has to have recorded the handle.
    recordRunArtifact(runDirOf(RUN_ID), {
      v: 1,
      sha256: handle.slice('artifact://'.length),
      handle,
      bytes: Buffer.byteLength(body, 'utf8'),
      lines: 1,
      mime: 'text/plain',
      description: 'the report',
      node: NODE_ID,
      segment: 'report',
      reason: 'inline-threshold',
    });

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

/**
 * KAR-14.3 AC4 — a patch reaches the policy engine with a populated estimate
 * block or it does not reach it at all.
 *
 * The block is what the F2.5 rule table predicates over, so a patch that cannot
 * fill it in is a patch nothing can rule on — and the tempting failure is to
 * default it, which would file every unfillable patch under `costDeltaUsd: 0`
 * and `escalatesPermission: null`, the two values that reach `auto`. Refusing at
 * the tool boundary is also the kinder failure: the agent is still inside its
 * own tool loop and can answer the error, which it cannot do if the patch is
 * accepted now and rejected by a policy engine ten minutes later.
 *
 * Verifies: KAR-14.3 AC4 · test plan #7
 */
/** KAR-11.3 AC6 — a proposal names the plan version it was derived against. */
const BASE_PLAN_HASH = `sha256-${'4'.repeat(64)}`;

suite('a patch with no estimate block is refused at the tool boundary (KAR-14.3 AC4)', () => {
  const ops = [
    {
      op: 'insert-nodes',
      nodes: [
        {
          id: 'n-extra',
          title: 'analyse the three packages recon found',
          type: 'agent',
          deps: [],
          lifecycle: 'active',
          reads: [],
          writes: [],
          permission: 'read',
          pathScopes: { write: [] },
          returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1200 },
          retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
          budget: {},
          brief: 'read the three packages and report what they import',
          provider: { prefer: ['claude'], requires: [] },
          model: 'claude-sonnet-4-5',
          resume: 'always-replay',
        },
      ],
      edges: [],
    },
  ];

  const patch = (policy: Record<string, unknown> | undefined) => ({
    schemaId: 'DeFlow.planpatch.v1',
    id: 'patch-1',
    proposedBy: NODE_ID,
    reason: 'recon found three more packages importing the v2 API',
    ops,
    ...(policy === undefined ? {} : { policy }),
  });

  const FULL_POLICY = {
    estimatedCostDeltaUsd: 0.4,
    estimatedWallClockDeltaMs: 60_000,
    blastRadius: { paths: [], nodeCount: 1 },
    replanDepth: 1,
    escalatesPermission: null,
    addsWriteCapability: false,
  };

  it('names the missing block in the error and appends nothing', async () => {
    const { agent } = await connect();

    const result = await agent.request('tools/call', {
      name: PROPOSE_PLAN_PATCH,
      arguments: { patch: patch(undefined), basePlanHash: BASE_PLAN_HASH },
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('policy');
    expect(ledger.eventsOf('plan.patch.proposed')).toEqual([]);
  });

  it('refuses a half-populated block rather than filling in the rest', async () => {
    const { agent } = await connect();

    const result = await agent.request('tools/call', {
      name: PROPOSE_PLAN_PATCH,
      arguments: {
        patch: patch({ estimatedCostDeltaUsd: 0.4, replanDepth: 1 }),
        basePlanHash: BASE_PLAN_HASH,
      },
    });

    expect(result.isError).toBe(true);
    expect(ledger.eventsOf('plan.patch.proposed')).toEqual([]);
  });

  it('records the proposal once the block is complete, so the rule is not simply a wall', async () => {
    const { agent } = await connect();

    const result = await agent.request('tools/call', {
      name: PROPOSE_PLAN_PATCH,
      arguments: { patch: patch(FULL_POLICY), basePlanHash: BASE_PLAN_HASH },
    });

    expect(result.isError).toBeFalsy();
    // Proposing is not applying: the tool says so, and the policy engine is
    // what decides afterwards.
    expect(result.structuredContent).toMatchObject({ patchId: 'patch-1', accepted: false });
    await expect.poll(() => ledger.eventsOf('plan.patch.proposed').length).toBe(1);
  });
});

/**
 * KAR-11.3 AC1, AC3, AC6, AC9 — the proposal boundary (EPIC-11-S13).
 *
 * 06 §4.1: the tool *"takes the patch as structured input validated against the
 * same schema, so a malformed proposal fails at the tool boundary rather than
 * in the policy engine"*. The two halves of that sentence are separate
 * guarantees and both are asserted here: the refusal is a **tool error the
 * agent can act on** while it is still inside its own tool loop, and **nothing
 * is appended** — a `plan.patch.proposed` carrying a body that does not parse
 * is an event every later reader has to defend against for ever.
 *
 * Verifies: EPIC-11-S13 · AC1, AC3, AC6, AC9 · test plan #4, #10
 */
suite('EPIC-11-S13 — a malformed proposal dies at the tool boundary (KAR-11.3)', () => {
  const node = {
    id: 'n-extra',
    title: 'analyse the three packages recon found',
    type: 'agent',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1200 },
    retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
    budget: {},
    brief: 'read the three packages and report what they import',
    provider: { prefer: ['claude'], requires: [] },
    resume: 'always-replay',
  };

  const POLICY = {
    estimatedCostDeltaUsd: 0.4,
    estimatedWallClockDeltaMs: 60_000,
    blastRadius: { paths: [], nodeCount: 1 },
    replanDepth: 1,
    escalatesPermission: null,
    addsWriteCapability: false,
  };

  const REASON = 'recon found @acme/ui, @acme/forms and @acme/charts also import the v2 API';

  const patch = (over: Record<string, unknown> = {}) => ({
    schemaId: 'DeFlow.planpatch.v1',
    id: 'patch-11-3',
    proposedBy: NODE_ID,
    reason: REASON,
    ops: [{ op: 'insert-nodes', nodes: [node], edges: [] }],
    policy: POLICY,
    ...over,
  });

  const call = (
    agent: { request: (m: string, p: unknown) => Promise<Record<string, unknown>> },
    args: unknown,
  ) => agent.request('tools/call', { name: PROPOSE_PLAN_PATCH, arguments: args });

  it('refuses ops that are missing their edges, and appends nothing', async () => {
    const { agent } = await connect();

    const result = await call(agent, {
      patch: patch({ ops: [{ op: 'insert-nodes', nodes: [node] }] }),
      basePlanHash: BASE_PLAN_HASH,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('edges');
    expect(ledger.eventsOf('plan.patch.proposed')).toEqual([]);
  });

  it('AC9 — refuses an empty reason rather than recording a change nobody explained', async () => {
    const { agent } = await connect();

    const result = await call(agent, {
      patch: patch({ reason: '' }),
      basePlanHash: BASE_PLAN_HASH,
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('reason');
    expect(ledger.eventsOf('plan.patch.proposed')).toEqual([]);
  });

  it('AC6 — refuses a proposal that does not say which plan it was derived against', async () => {
    const { agent } = await connect();

    const result = await call(agent, { patch: patch() });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('basePlanHash');
    expect(ledger.eventsOf('plan.patch.proposed')).toEqual([]);
  });

  it('AC3, AC6, AC9 — records a well-formed proposal with its base and its reason verbatim', async () => {
    const { agent } = await connect();

    const result = await call(agent, { patch: patch(), basePlanHash: BASE_PLAN_HASH });

    expect(result.isError).toBeFalsy();
    await expect.poll(() => ledger.eventsOf('plan.patch.proposed').length).toBe(1);

    const [proposed] = ledger.eventsOf('plan.patch.proposed');
    expect(proposed).toMatchObject({ basePlanHash: BASE_PLAN_HASH });
    // Verbatim, byte for byte: F10.2 answers "why is there a step here that I
    // didn't ask for?" with the sentence the proposer wrote, and a summary of
    // it is a different sentence.
    expect((proposed?.patch as { reason: string }).reason).toBe(REASON);
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
