/**
 * KAR-04.1 — the mock agent completes an ACP turn as a real child process.
 *
 * Nothing here mocks `child_process`. Mocking the process boundary would test
 * the mock: the spawn, the argv, the ndjson framing, the `session/update` pull
 * loop and the teardown all live on the other side of it, and that is precisely
 * the surface EPIC-05 has to build against.
 *
 * The scenario file named in EPIC-04-S1's `Given` is KAR-04.2's; this story
 * ships the binary's built-in turn, so the spawn here carries `--seed` alone.
 *
 * Verifies: EPIC-04-S1 · AC2, AC3, AC6
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
  // DeFlow_KEEP_TMP is honoured so a failed run leaves the worktree behind.
  if (process.env.DeFlow_KEEP_TMP === undefined) await rm(cwd, { recursive: true, force: true });
});

suite('EPIC-04-S1 — initialize, session/new, prompt, stop', () => {
  it('completes a full prompt cycle and exits 0 with a whole final frame', async () => {
    const agent = spawnMockAgent(['--seed', '42']);
    const { connection, updates } = connectClient(agent);

    const initialized = await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });

    // The integer 1, not the string '1'. MCP's protocol version is a date
    // string and the two look similar enough that a shared negotiation helper
    // is a real temptation — §2.2 forbids it, so assert the type as well as
    // the value.
    expect(initialized.protocolVersion).toBe(1);
    expect(typeof initialized.protocolVersion).toBe('number');
    expect(initialized.agentCapabilities).toBeTypeOf('object');
    // Mirrors what claude-agent-acp@0.64.1 actually returned: the mock needs
    // nothing from DeFlow, and says so rather than omitting the key.
    expect(initialized.authMethods).toEqual([]);

    const session = await connection.agent.request('session/new', { cwd, mcpServers: [] });
    expect(session.sessionId).toBeTruthy();

    const prompted = await connection.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    const chunks = updates.filter(
      (notification) => notification.update.sessionUpdate === 'agent_message_chunk',
    );
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.every((chunk) => chunk.sessionId === session.sessionId)).toBe(true);
    expect(prompted.stopReason).toBe('end_turn');

    await connection.agent.request('session/close', { sessionId: session.sessionId });

    const exit = await agent.finish();
    expect(exit).toEqual({ code: 0, signal: null });
    // A truncated final frame is the failure this catches: the child must not
    // be killed by its own teardown mid-write.
    expect(agent.stdout().at(-1)).toBe(0x0a);
    expect(agent.stderr()).toBe('');
  });

  it('refuses a prompt for a session it never opened', async () => {
    const agent = spawnMockAgent(['--seed', '42']);
    const { connection } = connectClient(agent);
    await connection.agent.request('initialize', { protocolVersion: 1 });

    await expect(
      connection.agent.request('session/prompt', {
        sessionId: 'no-such-session',
        prompt: [{ type: 'text', text: 'hello' }],
      }),
    ).rejects.toMatchObject({ code: -32602 });

    await agent.finish();
  });
});

suite('AC2 — version negotiation fails loudly', () => {
  it('rejects protocolVersion 2 rather than silently downgrading to 1', async () => {
    const agent = spawnMockAgent(['--seed', '42']);
    const { connection } = connectClient(agent);

    // A downgrade here would be worse than an error: the client would carry on
    // believing it had negotiated 2 and would only find out at the first frame
    // whose shape changed between versions.
    const rejection = await connection.agent.request('initialize', { protocolVersion: 2 }).then(
      (response: unknown) => ({ ok: true as const, response }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    expect(rejection.ok).toBe(false);
    expect(rejection).toMatchObject({ error: { code: -32602 } });
    expect(String((rejection as { error: Error }).error.message)).toMatch(/protocol version/i);

    await agent.finish();
  });
});
