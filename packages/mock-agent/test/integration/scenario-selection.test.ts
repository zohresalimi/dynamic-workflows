/**
 * KAR-04.2 AC1 — the scenario is selected by flag or environment, and a
 * scenario that cannot be understood stops the process before it speaks.
 *
 * "Emits no ACP frames" is the load-bearing half. An agent that writes a
 * handshake and *then* discovers its script is broken leaves the client with a
 * half-open session to reason about, and the resulting test failure points at
 * the client. Failing before the first byte makes the diagnosis local.
 *
 * Verifies: KAR-04.2 · AC1
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  CLIENT_CAPABILITIES,
  connectClient,
  scenarioPath,
  spawnMockAgent,
} from '../support/harness.ts';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'DeFlow-'));
});

afterEach(async () => {
  if (process.env.DeFlow_KEEP_TMP === undefined) await rm(dir, { recursive: true, force: true });
});

suite('AC1 — selecting a scenario', () => {
  it('accepts $DeFlow_MOCK_SCENARIO as well as --scenario', async () => {
    const agent = spawnMockAgent([], {
      env: {
        ...process.env,
        DeFlow_MOCK_SCENARIO: scenarioPath('streaming-cadence.jsonc'),
      },
    });
    const client = connectClient(agent);

    await client.connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await client.connection.agent.request('session/new', {
      cwd: dir,
      mcpServers: [],
    });
    await client.connection.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    });

    expect(client.updates[0]?.update.sessionUpdate).toBe('plan');
    expect(await agent.finish()).toEqual({ code: 0, signal: null });
  });

  it('lets --scenario win over the environment', async () => {
    const agent = spawnMockAgent(['--scenario', scenarioPath('minimal-turn.jsonc')], {
      env: { ...process.env, DeFlow_MOCK_SCENARIO: join(dir, 'does-not-exist.jsonc') },
    });
    expect((await agent.finish()).code).toBe(0);
    expect(agent.stderr()).toBe('');
  });
});

suite('AC1 — an unusable scenario exits non-zero and says one thing', () => {
  it('refuses a path that does not exist, with no frames on stdout', async () => {
    const missing = join(dir, 'nope.jsonc');
    const agent = spawnMockAgent(['--scenario', missing]);
    const exit = await agent.finish();

    expect(exit.code).toBeGreaterThan(0);
    expect(agent.stdout()).toHaveLength(0);
    expect(agent.stderr().trimEnd().split('\n')).toHaveLength(1);
    expect(agent.stderr()).toContain(missing);
  });

  it('refuses a schema-invalid scenario, naming the step that is wrong', async () => {
    const path = join(dir, 'broken.jsonc');
    await writeFile(
      path,
      JSON.stringify({ steps: [{ type: 'chunks', count: 1 }, { type: 'chunkz' }] }),
      'utf8',
    );

    const agent = spawnMockAgent(['--scenario', path]);
    const exit = await agent.finish();

    expect(exit.code).toBeGreaterThan(0);
    expect(agent.stdout()).toHaveLength(0);

    const stderr = agent.stderr().trimEnd();
    expect(stderr.split('\n')).toHaveLength(1);
    expect(stderr).toContain('steps[1]');
    expect(stderr).toContain('chunkz');
  });

  it('refuses a file that is not JSON at all', async () => {
    const path = join(dir, 'not-json.jsonc');
    await writeFile(path, 'steps: [ ]\n', 'utf8');

    const agent = spawnMockAgent(['--scenario', path]);
    expect((await agent.finish()).code).toBeGreaterThan(0);
    expect(agent.stdout()).toHaveLength(0);
    expect(agent.stderr().trimEnd().split('\n')).toHaveLength(1);
  });
});
