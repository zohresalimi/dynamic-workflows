/**
 * EPIC-04-S13 — one binary impersonates any row of the capability matrix.
 *
 * Real subprocess, real ACP `initialize` round trip — the point of KAR-04.4 is
 * that this is what turns "does ResumeByReplay work on a Gemini-shaped
 * profile?" from an integration-test problem needing an installed, real
 * Gemini CLI into a fast, deterministic one, so the profile itself has to be
 * proven over the wire and not just as a JS object (that half is
 * `test/capability-profiles.test.ts`).
 *
 * Verifies: EPIC-04-S13 · KAR-04.4 AC1, AC2, AC3, AC5 · test plan rows 2, 3, 4, 6
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { CAPABILITY_PROFILE_NAMES, CAPABILITY_PROFILES } from '../../src/capability-profiles.ts';
import { CLIENT_CAPABILITIES, connectClient, spawnMockAgent } from '../support/harness.ts';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'DeFlow-'));
});

afterEach(async () => {
  if (process.env.DeFlow_KEEP_TMP === undefined) await rm(dir, { recursive: true, force: true });
});

const REAL_PROFILES = ['claude', 'codex', 'opencode', 'copilot', 'gemini'] as const;

suite('Scenario Outline — the advertised block matches the measured matrix', () => {
  it.each(REAL_PROFILES)('--capabilities %s deep-equals the fixture row', async (profile) => {
    const agent = spawnMockAgent(['--seed', '1', '--capabilities', profile]);
    const client = connectClient(agent);

    const initialized = await client.connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });

    expect(initialized.agentCapabilities).toEqual(CAPABILITY_PROFILES[profile]);

    await agent.finish();
  });
});

suite("Gemini's shape has no sessionCapabilities key at all", () => {
  it('omits the key entirely rather than sending an empty object', async () => {
    const agent = spawnMockAgent(['--capabilities', 'gemini']);
    const client = connectClient(agent);

    const initialized = await client.connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });

    expect('sessionCapabilities' in (initialized.agentCapabilities as object)).toBe(false);
    expect(initialized.agentCapabilities?.loadSession).toBe(true);

    await agent.finish();
  });
});

suite("Copilot's shape is a nearly-empty object, not an absent key", () => {
  it('sessionCapabilities deep-equals { list: {} }', async () => {
    const agent = spawnMockAgent(['--capabilities', 'copilot']);
    const client = connectClient(agent);

    const initialized = await client.connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });

    expect(initialized.agentCapabilities?.sessionCapabilities).toEqual({ list: {} });

    await agent.finish();
  });
});

suite('Codex distinguishes explicit false from absent', () => {
  it('mcpCapabilities.sse and .acp are literal false', async () => {
    const agent = spawnMockAgent(['--capabilities', 'codex']);
    const client = connectClient(agent);

    const initialized = await client.connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });

    const mcp = initialized.agentCapabilities?.mcpCapabilities as {
      sse: unknown;
      acp: unknown;
    };
    expect(mcp.sse).toBe(false);
    expect(mcp.acp).toBe(false);

    await agent.finish();
  });
});

suite('An unknown profile is fatal', () => {
  it('exits non-zero, lists every valid name on stderr, and emits no frame', async () => {
    const agent = spawnMockAgent(['--capabilities', 'antigravity']);
    const exit = await agent.finish();

    expect(exit.code).toBeGreaterThan(0);
    expect(agent.stdout()).toHaveLength(0);
    for (const name of CAPABILITY_PROFILE_NAMES) expect(agent.stderr()).toContain(name);
  });
});

suite('AC1 — --capabilities-file supplies an arbitrary JSON block, returned verbatim', () => {
  it('embeds whatever JSON the file contains, unmodified', async () => {
    const arbitrary = {
      loadSession: true,
      sessionCapabilities: { resume: { extensionField: 'not-in-any-real-vendor' } },
      somethingNoRealVendorHasEverSent: [1, 2, 3],
    };
    const path = join(dir, 'custom-caps.json');
    await writeFile(path, JSON.stringify(arbitrary), 'utf8');

    const agent = spawnMockAgent(['--capabilities-file', path]);
    const client = connectClient(agent);

    const initialized = await client.connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });

    expect(initialized.agentCapabilities).toEqual(arbitrary);

    await agent.finish();
  });

  it('refuses a file that does not exist, with no frames on stdout', async () => {
    const missing = join(dir, 'nope.json');
    const agent = spawnMockAgent(['--capabilities-file', missing]);
    const exit = await agent.finish();

    expect(exit.code).toBeGreaterThan(0);
    expect(agent.stdout()).toHaveLength(0);
    expect(agent.stderr()).toContain(missing);
  });

  it('refuses a file that is not valid JSON', async () => {
    const path = join(dir, 'broken.json');
    await writeFile(path, 'not json at all', 'utf8');
    const agent = spawnMockAgent(['--capabilities-file', path]);
    const exit = await agent.finish();

    expect(exit.code).toBeGreaterThan(0);
    expect(agent.stdout()).toHaveLength(0);
  });
});

suite('without --capabilities, the pre-KAR-04.4 default is unchanged', () => {
  it('still returns the built-in default block', async () => {
    const agent = spawnMockAgent(['--seed', '1']);
    const client = connectClient(agent);

    const initialized = await client.connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });

    expect(initialized.agentCapabilities).toEqual({
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
    });

    await agent.finish();
  });
});
