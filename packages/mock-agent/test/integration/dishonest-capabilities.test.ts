/**
 * EPIC-04-S14 — a profile that advertises what it will not honour.
 *
 * `--dishonest-capabilities <capability>` is the deliberate lie AC4 asks for:
 * the block still says the capability is supported, but the corresponding
 * method answers JSON-RPC `-32601 Method not found` — the exact shape
 * assertion 6 of the conformance battery (adapter layer §11.3) exists to
 * catch. The message is the literal string "Method not found", not the
 * SDK's own unregistered-method fallback (`"Method not found": <method>`),
 * because that distinction is what tells apart "this was refused on purpose"
 * from "this was never implemented".
 *
 * Verifies: EPIC-04-S14 · KAR-04.4 AC4 · test plan row 5
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

suite('Advertised resume, unimplemented resume', () => {
  it('advertises resume: true, then answers session/resume with -32601', async () => {
    const agent = spawnMockAgent([
      '--capabilities',
      'claude',
      '--dishonest-capabilities',
      'session.resume',
    ]);
    const client = connectClient(agent);

    const initialized = await client.connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    expect(initialized.agentCapabilities?.sessionCapabilities?.resume).toBe(true);

    const session = await client.connection.agent.request('session/new', { cwd, mcpServers: [] });

    await expect(
      client.connection.agent.request('session/resume', {
        sessionId: session.sessionId,
        cwd,
      }),
    ).rejects.toMatchObject({ code: -32601, message: 'Method not found' });

    await agent.finish();
  });
});

suite('Scenario Outline — dishonesty across capabilities', () => {
  it('session.fork advertised, session/fork refused', async () => {
    const agent = spawnMockAgent([
      '--capabilities',
      'claude',
      '--dishonest-capabilities',
      'session.fork',
    ]);
    const client = connectClient(agent);
    await client.connection.agent.request('initialize', { protocolVersion: 1 });
    const session = await client.connection.agent.request('session/new', { cwd, mcpServers: [] });

    await expect(
      client.connection.agent.request('session/fork', { sessionId: session.sessionId, cwd }),
    ).rejects.toMatchObject({ code: -32601, message: 'Method not found' });

    await agent.finish();
  });

  it('session.list advertised, session/list refused', async () => {
    const agent = spawnMockAgent([
      '--capabilities',
      'claude',
      '--dishonest-capabilities',
      'session.list',
    ]);
    const client = connectClient(agent);
    await client.connection.agent.request('initialize', { protocolVersion: 1 });

    await expect(client.connection.agent.request('session/list', {})).rejects.toMatchObject({
      code: -32601,
      message: 'Method not found',
    });

    await agent.finish();
  });

  it('session.delete advertised, session/delete refused', async () => {
    const agent = spawnMockAgent([
      '--capabilities',
      'claude',
      '--dishonest-capabilities',
      'session.delete',
    ]);
    const client = connectClient(agent);
    await client.connection.agent.request('initialize', { protocolVersion: 1 });
    const session = await client.connection.agent.request('session/new', { cwd, mcpServers: [] });

    await expect(
      client.connection.agent.request('session/delete', { sessionId: session.sessionId }),
    ).rejects.toMatchObject({ code: -32601, message: 'Method not found' });

    await agent.finish();
  });

  it('additionalDirectories advertised, session/new refused', async () => {
    const agent = spawnMockAgent([
      '--capabilities',
      'claude',
      '--dishonest-capabilities',
      'additionalDirectories',
    ]);
    const client = connectClient(agent);
    const initialized = await client.connection.agent.request('initialize', { protocolVersion: 1 });
    expect(initialized.agentCapabilities?.sessionCapabilities?.additionalDirectories).toBe(true);

    await expect(
      client.connection.agent.request('session/new', { cwd, mcpServers: [] }),
    ).rejects.toMatchObject({ code: -32601, message: 'Method not found' });

    await agent.finish();
  });
});

suite('honesty is the default', () => {
  it('without --dishonest-capabilities, session/new still works normally', async () => {
    const agent = spawnMockAgent(['--capabilities', 'claude']);
    const client = connectClient(agent);
    await client.connection.agent.request('initialize', { protocolVersion: 1 });

    const session = await client.connection.agent.request('session/new', { cwd, mcpServers: [] });
    expect(session.sessionId).toBeTruthy();

    await agent.finish();
  });
});
