/**
 * The mirror of `dishonest-capabilities.test.ts`: an **honest** agent
 * implements what it advertised.
 *
 * Found by KAR-05.7's own conformance battery, which is the nicest possible
 * way for it to be found: `providerContract(mockAdapter('claude'))` reported
 * assertion 6 failing three times over, naming `session.fork`, `session.list`
 * and `session.delete` — the mock advertised all three from
 * `fixtures/capability-matrix.json` and answered every one of them with
 * `-32601`. It was the exact class of lie the battery exists to catch, told by
 * the reference agent the battery is calibrated against.
 *
 * The methods are registered **only when the selected profile advertises
 * them**, which is what keeps the negative half of assertion 6 real: a gemini
 * run must still answer `session/list` with `-32601`, because gemini's
 * measured `initialize` response has no `sessionCapabilities` at all.
 *
 * Verifies: EPIC-05-S27 (the honest branch) · KAR-04.4 AC4
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { CLIENT_CAPABILITIES, connectClient, spawnMockAgent } from '../support/harness.ts';

let cwd = '';

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'DeFlow-'));
});

afterEach(async () => {
  if (process.env.DeFlow_KEEP_TMP === undefined) await rm(cwd, { recursive: true, force: true });
});

async function openSession(profile: string) {
  const agent = spawnMockAgent(['--capabilities', profile]);
  const client = connectClient(agent);
  const initialized = await client.connection.agent.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: CLIENT_CAPABILITIES,
  });
  const session = await client.connection.agent.request('session/new', { cwd, mcpServers: [] });
  return { agent, client, initialized, session };
}

suite('an advertised capability is one the agent honours', () => {
  it('answers session/list with the sessions it has open', async () => {
    const { agent, client, initialized, session } = await openSession('claude');
    expect(initialized.agentCapabilities?.sessionCapabilities?.list).toBe(true);

    const listed = await client.connection.agent.request('session/list', {});
    // `ListSessionsResponse` requires `sessions`, and each `SessionInfo`
    // requires `sessionId` and `cwd` — a shape Layer A validates, so an answer
    // that merely avoided -32601 would fail there instead.
    expect(listed.sessions.map((info) => info.sessionId)).toContain(session.sessionId);
    expect(listed.sessions.every((info) => typeof info.cwd === 'string')).toBe(true);

    await agent.finish();
  });

  it('answers session/fork with a new session id, leaving the original open', async () => {
    const { agent, client, initialized, session } = await openSession('claude');
    expect(initialized.agentCapabilities?.sessionCapabilities?.fork).toBe(true);

    const forked = await client.connection.agent.request('session/fork', {
      sessionId: session.sessionId,
      cwd,
    });
    expect(forked.sessionId).not.toBe(session.sessionId);

    const listed = await client.connection.agent.request('session/list', {});
    expect(listed.sessions.map((info) => info.sessionId)).toEqual(
      expect.arrayContaining([session.sessionId, forked.sessionId]),
    );

    await agent.finish();
  });

  it('answers session/delete, and the session stops being listed', async () => {
    const { agent, client, session } = await openSession('claude');

    await client.connection.agent.request('session/delete', { sessionId: session.sessionId });
    const listed = await client.connection.agent.request('session/list', {});
    expect(listed.sessions.map((info) => info.sessionId)).not.toContain(session.sessionId);

    await agent.finish();
  });
});

suite('a capability the profile never advertised is still refused', () => {
  it('gemini, whose measured response has no sessionCapabilities, answers -32601', async () => {
    // The negative half of assertion 6. If registration were unconditional,
    // every profile would answer every method and the honesty check would be
    // incapable of failing.
    const { agent, client, initialized } = await openSession('gemini');
    expect(initialized.agentCapabilities?.sessionCapabilities).toBeUndefined();

    for (const method of ['session/list', 'session/fork', 'session/delete']) {
      await expect(
        client.connection.agent.request(method as never, {} as never),
      ).rejects.toMatchObject({ code: -32601 });
    }

    await agent.finish();
  });

  it('opencode advertises fork and list but not delete, and answers accordingly', async () => {
    const { agent, client, initialized, session } = await openSession('opencode');
    expect(initialized.agentCapabilities?.sessionCapabilities?.fork).toBe(true);
    expect(initialized.agentCapabilities?.sessionCapabilities?.delete).toBeUndefined();

    await client.connection.agent.request('session/list', {});
    await expect(
      client.connection.agent.request('session/delete', { sessionId: session.sessionId }),
    ).rejects.toMatchObject({ code: -32601 });

    await agent.finish();
  });
});
