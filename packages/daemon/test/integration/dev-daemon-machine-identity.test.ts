/**
 * KAR-26.2 AC2, AC3, AC5 / EPIC-26-S10, EPIC-26-S12, EPIC-26-S14 — a daemon
 * booted the way `../../src/main.ts` boots it knows which machine it is on.
 *
 * The wiring is one option pair, and the reason it needs a real daemon rather
 * than a reducer test is that everything downstream of it is a *thunk built at
 * boot*: `boot.ts`'s `currentResolutions` is what `/providers/routes` reads for
 * `known` and what `RunIntakePorts.admit` folds a submission onto, and both are
 * simply absent when `providerRoots` is. A spec over `admitRun` cannot tell the
 * difference between "admission refused" and "admission was never there".
 *
 * So the machine is staged on `PATH` and the options are constructed exactly as
 * `main.ts` constructs them — `pathRoots(env)`, and `probeProvidersOnBoot` with
 * the system clock — over that `PATH` instead of the author's own.
 * `test/machine-identity-boot-options.test.ts` is the other half: it is what
 * asserts `main.ts` passes this same set, so that this file's `bootAsMainDoes`
 * cannot quietly become a shape only the test uses.
 *
 * The chain and executor ports `main.ts` also passes are deliberately left out.
 * They are not machine-identity ports — both roots have passed them since
 * KAR-19.3/19.4 — and binding them here would drive a real framing interview
 * for a claim decided at `POST /api/runs`, before a node is reached at all.
 *
 * Verifies: EPIC-26-S10, EPIC-26-S12, EPIC-26-S14 · KAR-26.2 AC2, AC3, AC5
 */
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { randomBytes } from 'node:crypto';
import { mkdir, symlink } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';
import { systemClock } from '../../src/clock.ts';
import { probeProvidersOnBoot } from '../../src/providers/boot-probe.ts';
import { pathRoots } from '../../src/providers/detect.ts';

const fetch = authorizedFetch();

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

/** One row of `GET /api/providers/routes` — the composer's picker's own wire
 *  shape. */
interface RouteRow {
  readonly id: string;
  readonly available: boolean;
  readonly reason: string;
}

interface RoutesBody {
  readonly providers: readonly RouteRow[];
  readonly known: boolean;
}

interface CreatedBody {
  readonly runId: string;
  readonly provider?: { readonly provider: string; readonly route: string };
}

/** The bundled agent under its own name, so the provider this machine resolves
 *  is `mock` itself rather than `claude` wearing the mock agent's binary. */
async function mockAgentInstalled(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await symlink(process.execPath, join(binDir, 'node'));
  await symlink(MOCK_AGENT_BIN, join(binDir, 'deflow-mock-agent'));
}

interface Daemon {
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

async function origin(booted: Booted): Promise<Daemon> {
  const address = booted.http.server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stop: () => booted.shutdown(),
  };
}

/**
 * `main.ts`'s machine-identity option pair, built the way `main.ts` builds it —
 * over a staged `PATH` rather than the runner's, which is the only difference
 * and the reason this spec is hermetic.
 */
async function bootAsMainDoes(dataDir: string, binDir: string): Promise<Daemon> {
  const env = { ...process.env, PATH: binDir } satisfies NodeJS.ProcessEnv;
  const randomHex = (): string => randomBytes(3).toString('hex');
  return await origin(
    await boot({
      dataDir,
      port: 0,
      dev: false,
      token: TEST_DAEMON_TOKEN,
      providerRoots: pathRoots(env),
      probeProviders: ({ db, dataDir: dir }) =>
        probeProvidersOnBoot({
          db,
          clock: systemClock,
          dataDir: dir,
          env,
          randomHex,
        }),
    }),
  );
}

async function routes(daemon: Daemon): Promise<RoutesBody> {
  const response = await fetch(`${daemon.origin}/api/providers/routes`);
  expect(response.status).toBe(200);
  return (await response.json()) as RoutesBody;
}

async function submit(daemon: Daemon): Promise<Response> {
  return await fetch(`${daemon.origin}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: { kind: 'text', text: 'Migrate the checkout module' },
      cwd: process.cwd(),
      permission: 'read',
    }),
  });
}

suite('EPIC-26-S10 — routes are known under the dev daemon (AC2)', () => {
  it('answers known: true with the row for the provider PATH resolves', async ({ tmp }) => {
    const binDir = join(tmp, 'bin');
    await mockAgentInstalled(binDir);
    const daemon = await bootAsMainDoes(join(tmp, 'data'), binDir);

    try {
      const body = await routes(daemon);
      expect(body.known).toBe(true);
      // Real rows, not an empty list wearing `known: true`: this is the
      // difference the composer renders as an adapter picker rather than as
      // "this daemon has not been told which machine it is on".
      expect(body.providers.length).toBeGreaterThan(0);
      const mock = body.providers.find((row) => row.id === 'mock');
      expect(mock?.available).toBe(true);
      // And the row carries the daemon's own sentence, which is what the
      // settings runtime rows print instead of "started without knowing this
      // machine's PATH".
      expect(mock?.reason ?? '').not.toBe('');
    } finally {
      await daemon.stop();
    }
  });
});

suite('EPIC-26-S12 — admission admits under the dev daemon (AC3)', () => {
  it('decides the submission on the machine, not on the absence of a thunk', async ({ tmp }) => {
    const binDir = join(tmp, 'bin');
    await mockAgentInstalled(binDir);
    const daemon = await bootAsMainDoes(join(tmp, 'data'), binDir);

    try {
      const response = await submit(daemon);
      expect(response.status).toBe(201);
      // The provider named on the 201 is the one this staged `PATH` resolved,
      // which is what makes this an admission *decision* rather than a daemon
      // that admitted because it had nothing to check against.
      const created = (await response.json()) as CreatedBody;
      expect(created.provider?.provider).toBe('mock');
    } finally {
      await daemon.stop();
    }
  });

  it('names a machine fact when it refuses, rather than a missing resolution', async ({ tmp }) => {
    // An empty `PATH` is a real machine: nothing is installed, `providerRoots`
    // is `[]` rather than absent, and the refusal that follows is about the
    // machine. The other half of AC3 — the honest "no" — and the shape a
    // developer with no agent CLI on their laptop actually meets.
    const binDir = join(tmp, 'empty-bin');
    await mkdir(binDir, { recursive: true });
    const daemon = await bootAsMainDoes(join(tmp, 'data'), binDir);

    try {
      const body = await routes(daemon);
      expect(body.known).toBe(true);
      expect(body.providers.every((row) => !row.available)).toBe(true);

      const refused = await submit(daemon);
      expect(refused.status).toBeGreaterThanOrEqual(400);
      const error = (await refused.json()) as { error: { code: string; message: string } };

      // The code and the sentence, not merely "a 4xx with words in it": a
      // schema rejection, a non-git `cwd` and a bad token are all 4xx too, and
      // any of them would satisfy a status-only assertion while the daemon was
      // refusing for a reason that has nothing to do with the machine. This is
      // the whole claim of AC3's second half — that the refusal names what the
      // machine lacks — so it is the thing to assert.
      expect(error.error.code).toBe('no_usable_provider');
      expect(error.error.message).toContain('is not installed here');
    } finally {
      await daemon.stop();
    }
  });
});

suite('EPIC-26-S14 — booting without roots still answers known: false (AC5)', () => {
  it('leaves the endpoint contract alone for a spec, a fixture or a supervisor', async ({
    tmp,
  }) => {
    // The daemon life this story did *not* change: no `providerRoots`, no
    // `probeProviders`, and therefore no honest basis for saying a provider is
    // missing. An empty list read as "nothing is installed" would send an
    // operator to npm to fix a machine that is fine.
    const booted = await boot({
      dataDir: join(tmp, 'data'),
      port: 0,
      dev: false,
      token: TEST_DAEMON_TOKEN,
    });
    const daemon = await origin(booted);

    try {
      const body = await routes(daemon);
      expect(body).toEqual({ providers: [], known: false });
    } finally {
      await daemon.stop();
    }
  });
});
