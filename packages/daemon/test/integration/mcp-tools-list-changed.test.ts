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
import {
  type HandleRefusal,
  type NodeId,
  NodeIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
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

/** These specs never resolve a handle; the port has to be supplied, and a
 * refusal is the honest thing for a host with no artifact store behind it. */
const NO_ARTIFACTS: HandleRefusal = {
  code: 'artifact-unknown',
  message: 'this spec wired no artifact store',
};

/** KAR-02.4's three-op fixture: a patch the domain model already agrees is
 * well-formed, so a rejection here is about the tool and not about the data. */
const PATCH: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../core/test/fixtures/patches/three-ops.json', import.meta.url)),
    'utf8',
  ),
);

/** KAR-11.3 AC6 — the plan version the proposal was derived against, which the
 * tool requires and never defaults. */
const BASE_PLAN_HASH = `sha256-${'4'.repeat(64)}`;

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
    artifacts: { resolve: () => Promise.resolve({ ok: false, refusal: NO_ARTIFACTS }) },
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

    const unlocked = agent.nextNotification(TOOL_LIST_CHANGED);
    grant.setPhase('implementation');
    await unlocked;

    expect(await toolNames()).toEqual([READ_ARTIFACT, READ_FACT, PROPOSE_PLAN_PATCH].sort());

    // One push per transition, not one per tool the transition moved.
    //
    // This is not decoration: it is what makes an announcement a barrier. A
    // transition that announced twice would let the *next* `nextNotification`
    // be satisfied by this transition's leftover, which is exactly the bug the
    // withdrawal spec below used to have.
    //
    // Counted after the `tools/list` above rather than straight after the
    // await, and that ordering is the whole of its reliability. Awaiting the
    // announcement says only that the first frame arrived; a second one may
    // still be in flight, and counting there measures which of two writes won
    // a race — this assertion was itself flaky, one run in five, before it was
    // moved. `tools/list` is a full round trip through the shim's stdin and
    // back out of its stdout, and a stream writes in order, so everything the
    // shim emitted for this transition is already read by the time the reply
    // is.
    expect(agent.notifications.filter((n) => n.method === TOOL_LIST_CHANGED)).toHaveLength(1);
    // Nothing was torn down and rebuilt: same process, same socket connection.
    expect(agent.pid).toBe(pidBefore);
    expect(host.connections).toBe(1);
  });

  it('lets the unlocked tool through to DeFlowd', async () => {
    const unlocked = agent.nextNotification(TOOL_LIST_CHANGED);
    grant.setPhase('implementation');
    await unlocked;

    const result = await agent.request('tools/call', {
      name: PROPOSE_PLAN_PATCH,
      arguments: { patch: PATCH, basePlanHash: BASE_PLAN_HASH },
    });

    expect(result.isError).not.toBe(true);
    const proposed = ledger.eventsOf('plan.patch.proposed');
    expect(proposed).toHaveLength(1);
    expect((proposed[0]?.patch as { id: string }).id).toBe((PATCH as { id: string }).id);
  });
});

suite('a tool a phase withdraws is no longer callable (AC6)', () => {
  it('returns a tool error and records the attempt', async () => {
    // Each barrier is taken *before* the change it is a barrier for, and each
    // waits for the push that change causes rather than for a running total.
    //
    // The running total was the bug. `setPhase` is synchronous and pushes over
    // the daemon's socket; `tools/list` below travels over the agent's stdin,
    // which is a different pipe with no ordering relation to it. So the only
    // thing that says the withdrawal has been applied is the shim's own
    // announcement of it — and `waitForNotification(TOOL_LIST_CHANGED, 2)` was
    // not that. The first transition announced twice (the SDK announces from
    // inside `enable()`, and the shim announced the set as well), both frames
    // arrived in one read, and the count was already 2 before the second
    // `setPhase` frame had left the daemon. The wait returned immediately and
    // the spec then raced the socket against stdin, which it lost whenever the
    // box was busy enough to service them out of order.
    //
    // The shim now announces a set exactly once, after the whole set is
    // applied, so one announcement is one transition and the announcement is
    // evidence the state behind it is already in place.
    const unlocked = agent.nextNotification(TOOL_LIST_CHANGED);
    grant.setPhase('implementation');
    await unlocked;

    const withdrawn = agent.nextNotification(TOOL_LIST_CHANGED);
    grant.setPhase('analysis');
    await withdrawn;

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
