/**
 * EPIC-05-S24 — a new phase unlocks tools without a new session.
 *
 * The alternative to `sendToolListChanged()` is tearing the ACP session down
 * and building a new one every time the plan phase changes, which throws away
 * the vendor's own session context and turns a cheap transition into an
 * expensive one. So what this asserts is a *negative* as much as a positive:
 * the tool list changed, and the same shim process on the same socket
 * connection served both lists — nothing was rebuilt.
 *
 * Verifies: EPIC-05-S24 · AC6 · test plan #6
 */
import { type NodeId, NodeIdSchema, type RunId, RunIdSchema } from '@DeFlow/core';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type McpGrant,
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

/** KAR-02.4's three-op fixture: a patch the domain model already agrees is
 * well-formed, so a rejection here is about the tool and not about the data. */
const PATCH: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../core/test/fixtures/patches/three-ops.json', import.meta.url)),
    'utf8',
  ),
);

const TOOL_LIST_CHANGED = 'notifications/tools/list_changed';

let dir = '';
let ledger: TestLedger;
let host: McpHost;
let grant: McpGrant;
let agent: McpChild;

beforeEach(async () => {
  dir = await makeTempDir();
  ledger = openTestLedger(dir, RUN_ID);
  host = await startMcpHost({
    dataDir: dir,
    clock: new TestClock(),
    ledger: ledger.sink,
    facts: { read: () => null },
    artifacts: { read: () => null },
  });
  grant = host.grant({ runId: RUN_ID, nodeId: NODE_ID, attempt: 0, phase: 'analysis' });
  const spawned = spawnMcpServer(grant.mcpServer);
  agent = await spawned.ready;
});

afterEach(async () => {
  agent.kill();
  await host.close();
  ledger.close();
  await removeTempDir(dir);
});

const toolNames = async (): Promise<string[]> =>
  (await agent.listTools()).map((tool) => tool.name).sort();

suite('tools appear when the plan advances (AC6)', () => {
  it('pushes list_changed and serves the unlocked tool on the same connection', async () => {
    expect(await toolNames()).toEqual([READ_ARTIFACT, READ_FACT].sort());
    const pidBefore = agent.pid;

    grant.setPhase('implementation');
    await agent.waitForNotification(TOOL_LIST_CHANGED);

    expect(await toolNames()).toEqual([READ_ARTIFACT, READ_FACT, PROPOSE_PLAN_PATCH].sort());
    // Nothing was torn down and rebuilt: same process, same socket connection.
    expect(agent.pid).toBe(pidBefore);
    expect(host.connections).toBe(1);
  });

  it('lets the unlocked tool through to DeFlowd', async () => {
    grant.setPhase('implementation');
    await agent.waitForNotification(TOOL_LIST_CHANGED);

    const result = await agent.request('tools/call', {
      name: PROPOSE_PLAN_PATCH,
      arguments: { patch: PATCH },
    });

    expect(result.isError).not.toBe(true);
    const proposed = ledger.eventsOf('plan.patch.proposed');
    expect(proposed).toHaveLength(1);
    expect((proposed[0]?.patch as { id: string }).id).toBe((PATCH as { id: string }).id);
  });
});

suite('a tool a phase withdraws is no longer callable (AC6)', () => {
  it('returns a tool error and records the attempt', async () => {
    grant.setPhase('implementation');
    await agent.waitForNotification(TOOL_LIST_CHANGED, 1);

    grant.setPhase('analysis');
    await agent.waitForNotification(TOOL_LIST_CHANGED, 2);

    expect(await toolNames()).not.toContain(PROPOSE_PLAN_PATCH);

    // A tool error inside the result, not a JSON-RPC failure: the agent is
    // still in its loop and the refusal is something it can read and act on.
    const refused = await agent.request('tools/call', {
      name: PROPOSE_PLAN_PATCH,
      arguments: { patch: PATCH },
    });
    expect(refused.isError).toBe(true);

    await expect
      .poll(() =>
        ledger
          .eventsOf('node.progress')
          .some((payload) => String(payload.message).includes(PROPOSE_PLAN_PATCH)),
      )
      .toBe(true);
    expect(ledger.eventsOf('plan.patch.proposed')).toEqual([]);
  });
});
