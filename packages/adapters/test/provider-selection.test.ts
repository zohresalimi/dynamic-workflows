/**
 * KAR-19.10 — admission answers three questions instead of one: *may this run
 * start*, *on which provider and route*, and *what can that route not do*.
 *
 * Test plan #2, #7 and #8's unit halves. Two reds:
 *
 *  * A machine with a vendor CLI and no ACP bridge was refused outright. It is
 *    not unusable — it can frame, survey and plan through the exec shim, which
 *    is the route every schema-bearing pre-execution turn actually takes — so
 *    the honest answer is *admitted, and here is the turn you will not reach*.
 *  * A run had no way to say which provider it wanted, and admission had no way
 *    to answer for the one it was asked for. An explicitly named provider that
 *    cannot serve a turn is refused **with the turn named**, because the only
 *    alternative is the silent fallback this whole story is about.
 *
 * Verifies: EPIC-19-S68, EPIC-19-S70 · AC2, AC7, AC8
 */
import {
  admitRun,
  MOCK_AGENT_SENTENCE,
  type ProviderResolution,
  providerVerdict,
  RUN_REFUSAL_CODES,
} from '@DeFlow/adapters';
import { expect, it, describe as suite } from 'vitest';

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

const shimOnly = resolution();

const bothRoutes = resolution({
  state: 'installed',
  adapterPath: '/opt/homebrew/bin/claude-agent-acp',
});

const absent = resolution({
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

suite('admission states what it chose (AC4, AC7)', () => {
  it('names the provider, the resolved binary and the route it will take first', () => {
    const verdict = admitRun([bothRoutes, absent]);
    expect(verdict.outcome).toBe('admitted');
    if (verdict.outcome !== 'admitted') return;
    expect(verdict.chosen).toEqual({
      provider: 'claude',
      route: 'shim',
      binaryPath: '/opt/homebrew/bin/claude',
      routes: { acp: 'available', shim: 'available' },
      unserved: [],
      // The machine as it looked when the choice was made, carried whole: the
      // ledger row has to be answerable six weeks later without re-probing
      // (NF8), and re-deriving it there would be a second reduction that can
      // disagree with this one.
      resolution: bothRoutes,
    });
    expect(verdict.limitation).toBeNull();
  });

  it('admits a shim-only machine and names the turn it will not reach — the amendment', () => {
    const verdict = admitRun([shimOnly, absent]);
    expect(verdict.outcome).toBe('admitted');
    if (verdict.outcome !== 'admitted') return;
    expect(verdict.chosen?.provider).toBe('claude');
    expect(verdict.chosen?.route).toBe('shim');
    expect(verdict.chosen?.unserved).toEqual(['node execution']);
    // The install sentence is unchanged and stays attached to the missing ACP
    // route (KAR-18.8), because agent-node execution still needs the bridge.
    expect(verdict.limitation).toContain('node execution');
    expect(verdict.limitation).toContain('@agentclientprotocol/claude-agent-acp');
    expect(verdict.limitation).toContain('npm install -g');
  });

  it('still prefers a real adapter over the bundled agent (KAR-19.7 AC8, AC3)', () => {
    const verdict = admitRun([bundled, shimOnly]);
    expect(verdict.outcome === 'admitted' && verdict.chosen?.provider).toBe('claude');
  });

  it('refuses a machine where no provider has a usable route', () => {
    const verdict = admitRun([absent]);
    expect(verdict.outcome).toBe('refused');
    if (verdict.outcome !== 'refused') return;
    expect(verdict.code).toBe(RUN_REFUSAL_CODES.noUsableProvider);
    expect(verdict.message).toContain(MOCK_AGENT_SENTENCE);
  });
});

suite('--provider is honoured or the run is refused (AC1, AC2, AC8)', () => {
  it('routes the run onto the provider that was asked for', () => {
    const verdict = admitRun([bothRoutes, bundled], { provider: 'mock' });
    expect(verdict.outcome === 'admitted' && verdict.chosen?.provider).toBe('mock');
  });

  it('refuses a registered provider this machine cannot serve, with doctor’s sentence', () => {
    const verdict = admitRun([bothRoutes, absent], { provider: 'gemini' });
    expect(verdict.outcome).toBe('refused');
    if (verdict.outcome !== 'refused') return;
    // The same renderer `doctor` prints, not a second wording (KAR-19.2 AC3).
    expect(verdict.message).toContain(providerVerdict(absent).detail);
    expect(verdict.message).toContain(MOCK_AGENT_SENTENCE);
    expect(verdict.code).toBe(RUN_REFUSAL_CODES.noUsableProvider);
    // …and it names only the provider that was asked for. A refusal that
    // listed the usable one would read as an offer to fall back onto it.
    expect(verdict.providers.map((entry) => entry.id)).toEqual(['gemini']);
  });

  it('refuses an explicitly named provider that cannot serve one of the turns', () => {
    const verdict = admitRun([shimOnly, bundled], { provider: 'claude' });
    expect(verdict.outcome).toBe('refused');
    if (verdict.outcome !== 'refused') return;
    expect(verdict.message).toContain('node execution');
    expect(verdict.message).toContain('npm install -g');
    // No silent fallback: the bundled agent is usable and is not offered as a
    // substitute for the provider the operator named.
    expect(verdict.providers.map((entry) => entry.id)).toEqual(['claude']);
  });

  it('never falls back onto another provider than the one it was told to use', () => {
    const verdict = admitRun([bundled, absent], { provider: 'gemini' });
    expect(verdict.outcome).toBe('refused');
  });
});
