/**
 * KAR-25.3 AC1, AC3 — `PATCH /api/providers/:provider`, and the one fact it
 * writes reaching every reader without any of them being told separately.
 *
 * A real booted daemon with `providerRoots`, the same harness
 * `admission-refusal.test.ts` uses: the claim under test — "the picker and
 * admission agree with the settings page without either being told
 * separately" — is only real against the actual boot-time thunk
 * (`../../src/boot.ts`'s `currentResolutions`), not against a reducer called
 * directly.
 *
 * Verifies: EPIC-25-S20, EPIC-25-S21 · KAR-25.3 AC1, AC3
 */
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { mkdir, symlink } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';
import { clearIntakePorts } from '../../src/http/intake-ports.ts';
import { probeProvidersOnBoot } from '../../src/providers/boot-probe.ts';

const fetch = authorizedFetch();

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

interface ProviderRow {
  readonly provider: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly source: string;
  readonly binaryPath: string | null;
}

interface RouteRow {
  readonly id: string;
  readonly available: boolean;
  readonly reason: string;
}

/** The bundled agent, on `PATH` under its own name — so the provider this
 *  machine resolves and admits is `mock` itself, the one this file toggles,
 *  rather than `claude` wearing the mock agent's binary. */
async function mockAgentInstalled(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await symlink(process.execPath, join(binDir, 'node'));
  await symlink(MOCK_AGENT_BIN, join(binDir, 'deflow-mock-agent'));
}

function setTimerOf() {
  return (ms: number, fire: () => void) => {
    const handle = setTimeout(fire, ms);
    handle.unref();
    return { cancel: () => clearTimeout(handle) };
  };
}

function sleepOf() {
  return (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());
}

interface Daemon {
  readonly origin: string;
  readonly booted: Booted;
  readonly stop: () => Promise<void>;
}

async function bootAgainst(dataDir: string, binDir: string): Promise<Daemon> {
  const env = { ...process.env, PATH: binDir } satisfies NodeJS.ProcessEnv;
  const booted = await boot({
    dataDir,
    port: 0,
    dev: false,
    token: TEST_DAEMON_TOKEN,
    providerRoots: [binDir],
    probeProviders: ({ db, dataDir: dir }) =>
      probeProvidersOnBoot({
        db,
        clock: { now: () => Date.now(), setTimer: setTimerOf(), sleep: sleepOf() },
        dataDir: dir,
        env,
        randomHex: () => 'aaaaaa',
      }),
  });
  const address = booted.http.server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    booted,
    stop: () => booted.shutdown(),
  };
}

async function submit(origin: string, provider?: string): Promise<Response> {
  return await fetch(`${origin}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: { kind: 'text', text: 'Migrate the checkout module' },
      cwd: process.cwd(),
      permission: 'read',
      ...(provider === undefined ? {} : { provider }),
    }),
  });
}

async function patchEnabled(origin: string, provider: string, enabled: boolean): Promise<Response> {
  return await fetch(`${origin}/api/providers/${provider}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

suite('PATCH /api/providers/:provider (AC1, AC3)', () => {
  it('refuses an id PROVIDER_SPECS never registered', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    await mockAgentInstalled(binDir);
    const daemon = await bootAgainst(dataDir, binDir);

    try {
      const response = await patchEnabled(daemon.origin, 'not-a-real-runtime', false);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('unknown_provider');
    } finally {
      await daemon.stop();
    }
  });

  it('refuses a body that is not { enabled: boolean }', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    await mockAgentInstalled(binDir);
    const daemon = await bootAgainst(dataDir, binDir);

    try {
      const response = await fetch(`${daemon.origin}/api/providers/claude`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: 'yes' }),
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe('invalid_request');
    } finally {
      await daemon.stop();
    }
  });

  it('is the one fact GET /providers, GET /providers/routes and admission all read (AC1, AC3)', async ({
    tmp,
  }) => {
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    await mockAgentInstalled(binDir);
    const daemon = await bootAgainst(dataDir, binDir);

    try {
      // Enabled by default — no row in `provider_setting` yet.
      const before = (await (
        await fetch(`${daemon.origin}/api/providers`)
      ).json()) as ProviderRow[];
      const mockBefore = before.find((row) => row.provider === 'mock');
      expect(mockBefore).toMatchObject({ enabled: true, source: 'detected' });
      expect(mockBefore?.installed).toBe(true);
      // AC1's binaryPath — the resolution-derived fact this manifest route
      // is allowed to carry, matching what was actually linked onto PATH.
      expect(mockBefore?.binaryPath).toBe(join(binDir, 'deflow-mock-agent'));

      const routesBefore = (await (
        await fetch(`${daemon.origin}/api/providers/routes`)
      ).json()) as { providers: RouteRow[] };
      expect(routesBefore.providers.find((row) => row.id === 'mock')?.available).toBe(true);

      expect((await submit(daemon.origin)).status).toBe(201);

      // AC3 — disable it, and every other reader agrees without a second call.
      const patched = await patchEnabled(daemon.origin, 'mock', false);
      expect(patched.status).toBe(200);
      expect(await patched.json()).toEqual({ provider: 'mock', enabled: false });

      const after = (await (await fetch(`${daemon.origin}/api/providers`)).json()) as ProviderRow[];
      expect(after.find((row) => row.provider === 'mock')?.enabled).toBe(false);

      const routesAfter = (await (await fetch(`${daemon.origin}/api/providers/routes`)).json()) as {
        providers: RouteRow[];
      };
      const mockRoute = routesAfter.providers.find((row) => row.id === 'mock');
      expect(mockRoute?.available).toBe(false);
      // The daemon's own words — the exact sentence `providerVerdict`'s new
      // first branch composes, not a paraphrase this test invented.
      expect(mockRoute?.reason).toContain('disabled in Settings');

      // Every provider on this machine is `mock`, and it is now disabled —
      // so admission has nothing left to offer, and says so.
      const refused = await submit(daemon.origin);
      expect(refused.status).toBeGreaterThanOrEqual(400);
      const refusedBody = (await refused.json()) as { error: { message: string } };
      expect(refusedBody.error.message).toContain('disabled in Settings');

      // Re-enabling reverses every one of the above, from the same one call.
      expect((await patchEnabled(daemon.origin, 'mock', true)).status).toBe(200);
      expect((await submit(daemon.origin)).status).toBe(201);
    } finally {
      await daemon.stop();
    }
  });

  it('answers 503 rather than crashing when the daemon has no ports yet', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    await mockAgentInstalled(binDir);
    const daemon = await bootAgainst(dataDir, binDir);

    try {
      // The same pattern `providers-doctor-api.test.ts` uses for the sibling
      // provider route: a real booted daemon whose write ports have since
      // gone away, rather than a request nothing is listening for.
      clearIntakePorts();
      const response = await patchEnabled(daemon.origin, 'claude', false);
      expect(response.status).toBe(503);
    } finally {
      await daemon.stop();
    }
  });
});

suite('GET /api/providers carries enough for the settings panel (AC1)', () => {
  it('reports source: detected for every row, since nothing here can be added', async ({ tmp }) => {
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    await mockAgentInstalled(binDir);
    const daemon = await bootAgainst(dataDir, binDir);

    try {
      const providers = (await (
        await fetch(`${daemon.origin}/api/providers`)
      ).json()) as ProviderRow[];
      expect(providers.length).toBeGreaterThan(0);
      expect(providers.every((row) => row.source === 'detected')).toBe(true);
    } finally {
      await daemon.stop();
    }
  });

  it('reports a null binaryPath rather than 503ing when booted without providerRoots', async ({
    tmp,
  }) => {
    const dataDir = join(tmp, 'data');
    // No `providerRoots`, no `probeProviders` — the exact "never told which
    // machine it is on" daemon life `/providers/routes`' own `known: false`
    // already documents.
    const booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
    const address = booted.http.server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;

    try {
      const response = await fetch(`${origin}/api/providers`);
      expect(response.status).toBe(200);
      const providers = (await response.json()) as ProviderRow[];
      expect(providers.every((row) => row.binaryPath === null)).toBe(true);
      expect(providers.every((row) => row.enabled === true)).toBe(true);
    } finally {
      await booted.shutdown();
    }
  });
});
