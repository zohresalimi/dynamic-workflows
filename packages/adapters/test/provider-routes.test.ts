/**
 * KAR-19.10 — provider state is **one answer per route**, produced once.
 *
 * Test plan #6, and EPIC-19-S69's outline verbatim. The red this file is
 * written against is the 2026-08-13 afternoon: `doctor` called `claude`
 * `adapter-missing` — one word, meaning "unusable" to every reader — and the
 * run selected `claude` anyway through `spec.shim.bin` and spawned the vendor
 * CLI. Neither half was lying; the *shape* of the answer could not express
 * "usable on one route, not the other", so the two views were free to disagree.
 *
 * The third row of the outline is the one to read twice: an ACP bridge with
 * nothing underneath it is not a usable ACP route either, because the bridge
 * spawns the vendor CLI. Before this reducer existed that machine resolved to
 * `not-installed`, which was right by accident rather than by construction.
 *
 * Verifies: EPIC-19-S69 · AC6, AC7
 */
import {
  type ProviderResolution,
  type ProviderRoute,
  providerRoutes,
  type RunTurn,
  turnsServedBy,
  unservedTurns,
  usableProviders,
} from '@DeFlow/adapters';
import { expect, it, describe as suite } from 'vitest';

/** A resolution literal, so the table is about the reducer and not about a
 * temp directory. `resolveProviderState` turns a real `PATH` into one. */
function resolution(over: Partial<ProviderResolution> = {}): ProviderResolution {
  return {
    provider: 'claude',
    state: 'adapter-missing',
    kind: 'adapter',
    vendorBin: 'claude',
    vendorPath: '/opt/homebrew/bin/claude',
    adapterBin: 'claude-agent-acp',
    adapterPath: null,
    package: '@agentclientprotocol/claude-agent-acp',
    bundled: false,
    ...over,
  };
}

const ACP = '/opt/homebrew/bin/claude-agent-acp';
const VENDOR = '/opt/homebrew/bin/claude';

suite('providerRoutes — EPIC-19-S69, one answer per route', () => {
  it('reports both routes available when both binaries resolve', () => {
    expect(
      providerRoutes(resolution({ state: 'installed', adapterPath: ACP, vendorPath: VENDOR })),
    ).toEqual({ acp: 'available', shim: 'available' });
  });

  it('reports the exec-shim route available with the ACP bridge absent — the reported machine', () => {
    expect(providerRoutes(resolution({ adapterPath: null, vendorPath: VENDOR }))).toEqual({
      acp: 'missing',
      shim: 'available',
    });
  });

  it('reports neither route when a bridge resolves over no vendor CLI', () => {
    // A `claude-agent-acp` with no `claude` under it bridges to nothing: the
    // adapter spawns the vendor CLI, so an ACP session cannot open either.
    expect(
      providerRoutes(resolution({ state: 'not-installed', adapterPath: ACP, vendorPath: null })),
    ).toEqual({ acp: 'missing', shim: 'missing' });
  });

  it('reports neither route when nothing resolves', () => {
    expect(
      providerRoutes(resolution({ state: 'not-installed', adapterPath: null, vendorPath: null })),
    ).toEqual({ acp: 'missing', shim: 'missing' });
  });

  it('reports the ACP route missing for a bridge that is present and did not answer', () => {
    // KAR-19.2 AC7's state survives as a *route* answer: the file system says
    // the bridge is there, the boot probe says it does not speak ACP, and a
    // route nobody can open is missing however present its binary is.
    expect(
      providerRoutes(
        resolution({ state: 'handshake-failed', adapterPath: ACP, vendorPath: VENDOR }),
      ),
    ).toEqual({ acp: 'missing', shim: 'available' });
  });
});

suite('turns — which turns a set of routes can serve (AC7)', () => {
  it('serves every pre-execution turn on the exec-shim route alone', () => {
    const served = turnsServedBy({ acp: 'missing', shim: 'available' });
    expect(served).toContain('framing');
    expect(served).toContain('recon');
    expect(served).toContain('planner');
    expect(served).not.toContain('node execution');
  });

  it('names agent-node execution as the turn a shim-only machine cannot serve', () => {
    expect(unservedTurns({ acp: 'missing', shim: 'available' })).toEqual(['node execution']);
  });

  it('leaves nothing unserved when both routes are available', () => {
    expect(unservedTurns({ acp: 'available', shim: 'available' })).toEqual([]);
  });

  it('leaves every turn unserved when neither route is available', () => {
    expect(turnsServedBy({ acp: 'missing', shim: 'missing' })).toEqual([]);
  });

  it('maps every turn onto a route that exists', () => {
    const routes: readonly ProviderRoute[] = ['acp', 'shim'];
    const every: readonly RunTurn[] = unservedTurns({ acp: 'missing', shim: 'missing' });
    expect(every.length).toBeGreaterThan(1);
    for (const turn of every) {
      // Each unserved turn is unserved *because of a route*, so the union of
      // the two served sets is the whole vocabulary.
      const servedBySomething = routes.some((route) =>
        turnsServedBy({
          acp: route === 'acp' ? 'available' : 'missing',
          shim: route === 'shim' ? 'available' : 'missing',
        }).includes(turn),
      );
      expect(servedBySomething, `${turn} is served by no route`).toBe(true);
    }
  });
});

suite('usableProviders — route-aware, order unchanged (AC3)', () => {
  const bothRoutes = resolution({ state: 'installed', adapterPath: ACP });
  const shimOnly = resolution({ provider: 'codex', vendorBin: 'codex', vendorPath: '/bin/codex' });
  const nothing = resolution({
    provider: 'gemini',
    state: 'not-installed',
    kind: 'native',
    vendorBin: 'gemini',
    vendorPath: null,
    adapterBin: 'gemini',
    adapterPath: null,
    package: '@google/gemini-cli',
  });
  const bundled = resolution({
    provider: 'mock',
    state: 'installed',
    kind: 'native',
    vendorBin: 'DeFlow-mock-agent',
    vendorPath: '/tmp/bin/DeFlow-mock-agent',
    adapterBin: 'DeFlow-mock-agent',
    adapterPath: '/tmp/bin/DeFlow-mock-agent',
    package: 'DeFlow',
    bundled: true,
  });

  it('keeps a provider usable on the exec-shim route alone — the amendment', () => {
    expect(usableProviders([shimOnly, nothing]).map((entry) => entry.provider)).toEqual(['codex']);
  });

  it('drops a provider with no usable route', () => {
    expect(usableProviders([nothing])).toEqual([]);
  });

  it('still puts bundled entries last (KAR-19.7 AC8)', () => {
    expect(usableProviders([bundled, shimOnly, bothRoutes]).map((e) => e.provider)).toEqual([
      'codex',
      'claude',
      'mock',
    ]);
  });
});
