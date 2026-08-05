/**
 * KAR-05.5 — the mock implements exactly the session lifecycle it advertises.
 *
 * A resume spec needs an agent that behaves like the vendor it is standing in
 * for: one that advertises `sessionCapabilities.resume` accepts a
 * `session/resume` for a session **this process never created** — that is what
 * a restarted vendor CLI does, reading its own session file — and one that
 * does not advertise it answers -32601. Without that, `ResumeByReplay` could
 * only be exercised against an installed, authenticated Copilot or Gemini CLI
 * and a real multi-minute turn; with it, it is a fast test on every commit.
 *
 * Verifies: EPIC-05-S19, EPIC-05-S21 (support)
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { connectClient, spawnMockAgent } from '../support/harness.ts';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'DeFlow-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const HANDSHAKE = {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: {},
  clientInfo: { name: 'DeFlow-test', version: '0.0.0' },
} as const;

suite('session/resume, on an agent that advertises it', () => {
  it('accepts a session id this process never created, and prompts on it', async () => {
    const agent = spawnMockAgent(['--capabilities', 'claude', '--seed', '7']);
    const client = connectClient(agent);
    const cx = client.connection;

    await cx.agent.request('initialize', HANDSHAKE);
    // The id a previous daemon life journalled. This process has no memory of
    // it, exactly as a restarted vendor CLI has none until it reads its file.
    const sessionId = 'sess_from_a_previous_daemon' as acp.SessionId;
    await cx.agent.request('session/resume', { sessionId, cwd: dir });

    const response = await cx.agent.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'carry on' }],
    });
    expect(response.stopReason).toBe('end_turn');
    expect(client.updates.map((update) => update.sessionId)).toContain(sessionId);

    await agent.finish();
  });
});

suite('session/resume, on an agent that does not advertise it', () => {
  it('answers "method not found" rather than pretending', async () => {
    const agent = spawnMockAgent(['--capabilities', 'gemini', '--seed', '7']);
    const cx = connectClient(agent).connection;
    await cx.agent.request('initialize', HANDSHAKE);

    await expect(
      cx.agent.request('session/resume', {
        sessionId: 'sess_anything' as acp.SessionId,
        cwd: dir,
      }),
    ).rejects.toMatchObject({ code: -32601 });

    await agent.finish();
  });
});

suite('session/load replays the whole history back at the client', () => {
  it('streams one session/update per recorded notification', async () => {
    const agent = spawnMockAgent(['--capabilities', 'gemini', '--load-history', '12']);
    const client = connectClient(agent);
    const cx = client.connection;
    await cx.agent.request('initialize', HANDSHAKE);

    const sessionId = 'sess_days_long' as acp.SessionId;
    await cx.agent.request('session/load', { sessionId, cwd: dir, mcpServers: [] });

    // This is the flood the design rule warns about, in miniature: twelve
    // frames arrived without anyone prompting for anything.
    expect(client.updates).toHaveLength(12);
    expect(client.updates.every((update) => update.sessionId === sessionId)).toBe(true);

    await agent.finish();
  });
});

suite('--wire-log records what arrived at the agent', () => {
  it('writes one line per frame the client sent', async () => {
    const wireLog = join(dir, 'wire.ndjson');
    const agent = spawnMockAgent(['--capabilities', 'claude', '--wire-log', wireLog]);
    const cx = connectClient(agent).connection;

    await cx.agent.request('initialize', HANDSHAKE);
    await cx.agent.request('session/resume', { sessionId: 'sess_x' as acp.SessionId, cwd: dir });
    await agent.finish();

    const methods = readFileSync(wireLog, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => (JSON.parse(line) as { method?: string }).method);
    expect(methods).toEqual(['initialize', 'session/resume']);
  });
});
