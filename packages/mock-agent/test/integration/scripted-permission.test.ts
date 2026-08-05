/**
 * EPIC-04-S6 — `session/request_permission` round trip, including the outcome
 * everybody forgets.
 *
 * `RequestPermissionOutcome` is `{ outcome: 'cancelled' } | { outcome:
 * 'selected'; optionId }`, and an agent that destructures `optionId`
 * unconditionally hangs on the first variant. A hung agent inside a node is a
 * hung run, so the `cancelled` row is the reason this scenario is typed
 * "edge case" rather than "happy path" — and the last suite here is the
 * stimulus for EPIC-13's approval-queue timeout.
 *
 * Verifies: EPIC-04-S6 · AC4 · test plan rows 4, 5
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  CLIENT_CAPABILITIES,
  connectClient,
  type SpawnedAgent,
  scenarioPath,
  spawnMockAgent,
} from '../support/harness.ts';

let cwd = '';
const running: SpawnedAgent[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'DeFlow-'));
});

afterEach(async () => {
  for (const agent of running.splice(0)) {
    agent.child.kill('SIGKILL');
  }
  if (process.env.DeFlow_KEEP_TMP === undefined) await rm(cwd, { recursive: true, force: true });
});

function start(
  answer: (params: acp.RequestPermissionRequest) => Promise<acp.RequestPermissionOutcome>,
) {
  const agent = spawnMockAgent([
    '--seed',
    '42',
    '--scenario',
    scenarioPath('permission-branches.jsonc'),
  ]);
  running.push(agent);
  return { agent, client: connectClient(agent, { permission: answer }) };
}

/** The declared branch texts, so a spec asserts on the branch, not the prose. */
const BRANCH_MARKER = /^branch:(\w+)/;

function branchesTaken(updates: readonly acp.SessionNotification[]): string[] {
  return updates.flatMap((notification) => {
    if (notification.update.sessionUpdate !== 'agent_message_chunk') return [];
    const content = notification.update.content;
    if (content.type !== 'text') return [];
    return BRANCH_MARKER.exec(content.text)?.[1] ?? [];
  });
}

const outcomes = [
  [{ outcome: 'selected', optionId: 'allow_once' }, 'onAllowed', 'end_turn'],
  [{ outcome: 'selected', optionId: 'allow_always' }, 'onAllowed', 'end_turn'],
  [{ outcome: 'selected', optionId: 'reject_once' }, 'onRejected', 'refusal'],
  [{ outcome: 'selected', optionId: 'reject_always' }, 'onRejected', 'refusal'],
  [{ outcome: 'cancelled' }, 'onCancelled', 'cancelled'],
] as const;

suite.each(outcomes)('EPIC-04-S6 — %j', (outcome, branch, stopReason) => {
  it(`takes ${branch} and stops with ${stopReason}`, async () => {
    let request: acp.RequestPermissionRequest | null = null;
    const { agent, client } = start(async (params) => {
      request = params;
      return outcome as acp.RequestPermissionOutcome;
    });

    await client.connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await client.connection.agent.request('session/new', { cwd, mcpServers: [] });
    const prompted = await client.connection.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'may I' }],
    });

    // The four options the scenario declares reach the client verbatim — a
    // permission request the client cannot answer meaningfully is not a
    // stimulus for the ladder.
    expect(
      (request as acp.RequestPermissionRequest | null)?.options.map((o) => o.optionId),
    ).toEqual(['allow_once', 'allow_always', 'reject_once', 'reject_always']);

    expect(branchesTaken(client.updates)).toEqual([branch]);
    expect(prompted.stopReason).toBe(stopReason);

    // The turn terminates on its own: the harness closes stdin and the process
    // leaves, without anybody having to kill it.
    expect(await agent.finish()).toEqual({ code: 0, signal: null });
  });
});

suite('EPIC-04-S6 — the client never answers', () => {
  it('waits, emits nothing further, and can still be cancelled cleanly', async () => {
    let asked: (() => void) | null = null;
    const askedOnce = new Promise<void>((resolve) => {
      asked = resolve;
    });

    const { agent, client } = start(
      async () =>
        new Promise<acp.RequestPermissionOutcome>(() => {
          asked?.();
          // Deliberately never settles.
        }),
    );

    await client.connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await client.connection.agent.request('session/new', { cwd, mcpServers: [] });
    const prompted = client.connection.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'may I' }],
    });
    void prompted.catch(() => undefined);

    await askedOnce;
    const before = client.updates.length;
    // Two seconds on the real clock. Fake timers are not an option here: the
    // child is alive, and freezing the loop's timers would stop its I/O from
    // ever being read (docs/14-testing-strategy.md §8).
    await new Promise((resolve) => setTimeout(resolve, 2_000));

    expect(client.updates.length).toBe(before);
    expect(agent.child.exitCode).toBeNull();

    client.connection.agent.notify('session/cancel', { sessionId: session.sessionId });
    // Cancelling a wedged permission request is KAR-04.3's story; all this
    // asserts is that the harness gets its process back.
    agent.child.kill('SIGTERM');
    const exit = await agent.exited();
    expect(exit.code === 0 || exit.signal === 'SIGTERM').toBe(true);
  });
});
