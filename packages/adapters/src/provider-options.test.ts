/**
 * KAR-22.2 AC2, AC3 — the composer's adapter picker, as a reduction of the
 * producer `doctor` and admission already read.
 *
 * The whole of this file is one claim: **the picker has no opinion of its own.**
 * Every row it shows is `providerRoutes`, `routeForNextTurn`, `usableProviders`
 * and `providerVerdict` applied to the resolutions the daemon established at
 * boot — the same four functions, in the same module, that `doctor`'s Agents
 * section and `admitRun` call. A picker that probed `PATH` for itself would be
 * a fourth answer about this machine, and the first thing an operator would do
 * with it is select something admission then refuses.
 *
 * The fixtures are hand-built `ProviderResolution`s rather than a real
 * filesystem on purpose: what is under test is a pure reduction, and the
 * question *"does this machine actually have that binary"* is
 * `resolveProviderStates`' and is asserted against a real temp `PATH` in
 * `packages/daemon/test/integration/composer-picker.test.ts`.
 *
 * Verifies: EPIC-22-S22, EPIC-22-S23 · KAR-22.2 AC2, AC3 · test plan #3
 */
import { expect, it, describe as suite } from 'vitest';
import {
  admitRun,
  installCommand,
  type ProviderOption,
  type ProviderResolution,
  providerOptions,
  providerRoutes,
  providerVerdict,
} from './index.ts';

/**
 * A resolution, spelled from what a machine has rather than from a state word.
 *
 * `state` is derived here exactly as `resolveProviderState` derives it, so a
 * fixture cannot claim a combination the resolver would never produce — an
 * `installed` provider whose vendor CLI is missing, say, which would make every
 * assertion below true of nothing.
 */
function resolution(over: {
  readonly provider: string;
  readonly vendorPath?: string | null;
  readonly adapterPath?: string | null;
  readonly kind?: 'native' | 'adapter';
  readonly bundled?: boolean;
  readonly handshakeFailed?: boolean;
}): ProviderResolution {
  const vendorPath = over.vendorPath ?? null;
  const adapterPath = over.adapterPath ?? null;
  const kind = over.kind ?? 'adapter';
  const state =
    over.handshakeFailed === true
      ? ('handshake-failed' as const)
      : vendorPath === null
        ? ('not-installed' as const)
        : adapterPath !== null
          ? ('installed' as const)
          : kind === 'adapter'
            ? ('adapter-missing' as const)
            : ('not-installed' as const);

  return {
    provider: over.provider,
    state,
    kind,
    vendorBin: over.provider,
    vendorPath,
    adapterBin: `${over.provider}-agent-acp`,
    adapterPath,
    package: `@example/${over.provider}-acp`,
    bundled: over.bundled ?? false,
  };
}

const rowFor = (rows: readonly ProviderOption[], id: string): ProviderOption => {
  const found = rows.find((row) => row.id === id);
  if (found === undefined) throw new Error(`the picker dropped ${id} from its rows`);
  return found;
};

suite('AC2 — every row is the producer’s own answer', () => {
  it('names one row per resolution, dropping none of them', () => {
    const resolutions = [
      resolution({ provider: 'alpha', vendorPath: '/bin/alpha', adapterPath: '/bin/alpha-acp' }),
      resolution({ provider: 'beta', vendorPath: '/bin/beta' }),
      resolution({ provider: 'gamma' }),
    ];

    // A picker that filtered the unusable ones would answer "why is it not in
    // the list?" with silence, which is the question AC3 exists to answer.
    expect(providerOptions(resolutions).map((row) => row.id)).toHaveLength(3);
  });

  it('takes availability from usableProviders and the route from routeForNextTurn', () => {
    const both = resolution({
      provider: 'alpha',
      vendorPath: '/bin/alpha',
      adapterPath: '/bin/alpha-acp',
    });
    const shimOnly = resolution({ provider: 'beta', vendorPath: '/bin/beta' });
    const nothing = resolution({ provider: 'gamma' });
    const rows = providerOptions([both, shimOnly, nothing]);

    // The first turn of a run is framing and framing is a shim turn, so a
    // machine with both routes open still starts on the shim. The picker says
    // what the run will actually do, not what the machine could do.
    expect(rowFor(rows, 'alpha')).toMatchObject({ available: true, route: 'shim' });
    expect(rowFor(rows, 'beta')).toMatchObject({ available: true, route: 'shim' });
    expect(rowFor(rows, 'gamma')).toMatchObject({ available: false, route: null });
  });

  it('carries both routes, verbatim from the route reducer', () => {
    const shimOnly = resolution({ provider: 'beta', vendorPath: '/bin/beta' });
    const [row] = providerOptions([shimOnly]);

    expect(row?.routes).toEqual(providerRoutes(shimOnly));
    expect(row?.routes).toEqual({ acp: 'missing', shim: 'available' });
  });

  it('orders the rows the way admission would choose, best first', () => {
    // The picker's default selection is whatever is first, so "first" has to be
    // the provider a submission with no `provider` field would land on. A
    // bundled agent is a real answer on a machine with nothing else and must
    // never be the answer on a machine that has a vendor adapter sitting there.
    const bundled = resolution({
      provider: 'mock',
      kind: 'native',
      bundled: true,
      vendorPath: '/bin/mock',
      adapterPath: '/bin/mock',
    });
    const vendor = resolution({
      provider: 'alpha',
      vendorPath: '/bin/alpha',
      adapterPath: '/bin/alpha-acp',
    });
    const absent = resolution({ provider: 'gamma' });

    const rows = providerOptions([bundled, vendor, absent]);
    expect(rows.map((row) => row.id)).toEqual(['alpha', 'mock', 'gamma']);

    const admission = admitRun([bundled, vendor, absent]);
    expect(admission.outcome).toBe('admitted');
    if (admission.outcome !== 'admitted') return;
    expect(rows[0]?.id).toBe(admission.chosen?.provider);
  });
});

suite('AC3 — an unavailable provider carries the reason and the fix', () => {
  it('renders doctor’s own sentence and doctor’s own command', () => {
    const missingBridge = resolution({ provider: 'beta', vendorPath: '/bin/beta' });
    const absent = resolution({ provider: 'gamma' });
    const rows = providerOptions([missingBridge, absent]);

    // Byte-identical to what `deflow doctor` prints for the same machine. A
    // second, friendlier wording composed for the browser is how the same
    // machine comes to describe itself two ways.
    expect(rowFor(rows, 'gamma').reason).toBe(providerVerdict(absent).detail);
    expect(rowFor(rows, 'gamma').action).toBe(providerVerdict(absent).action ?? null);
    expect(rowFor(rows, 'gamma').action).toBe(
      `install "gamma", then ${installCommand('@example/gamma-acp')}`,
    );
  });

  it('states the limitation of a provider that is usable but partial', () => {
    const shimOnly = resolution({ provider: 'beta', vendorPath: '/bin/beta' });
    const [row] = providerOptions([shimOnly]);

    // AC7 of KAR-19.10, surfaced in the picker: selectable, and honest about
    // the turn it will not reach — said here rather than at the agent node
    // three minutes later.
    expect(row?.available).toBe(true);
    expect(row?.limitation).toContain('node execution');
    expect(row?.limitation).toContain(installCommand('@example/beta-acp'));
  });

  it('leaves nothing to explain on a provider that needs nothing', () => {
    const complete = resolution({
      provider: 'alpha',
      vendorPath: '/bin/alpha',
      adapterPath: '/bin/alpha-acp',
    });
    const [row] = providerOptions([complete]);

    expect(row?.action).toBeNull();
    expect(row?.limitation).toBeNull();
    expect(row?.reason).toBe(providerVerdict(complete).detail);
  });

  it('reports a broken bridge as broken, never as absent', () => {
    // The row an operator would otherwise answer by uninstalling and
    // reinstalling a package that was already there — twice — before suspecting
    // DeFlow.
    const broken = resolution({
      provider: 'beta',
      vendorPath: '/bin/beta',
      adapterPath: '/bin/beta-agent-acp',
      handshakeFailed: true,
    });
    const [row] = providerOptions([broken]);

    expect(row?.state).toBe('handshake-failed');
    expect(row?.reason).not.toContain('is not installed here');
    expect(row?.reason).toContain('it is present');
    // The shim is still open, so the row is still selectable — and the
    // limitation is what says the ACP route is not.
    expect(row?.available).toBe(true);
    expect(row?.routes).toEqual({ acp: 'missing', shim: 'available' });
  });
});

suite('AC2 — the picker cannot be asked for a route the producer did not report', () => {
  it('answers `acp` only where the producer opened the ACP route', () => {
    // The fixture the story is written against: the producer reports one route
    // open, and any row claiming the other is the 2026-08-13 disagreement with
    // a browser in front of it.
    for (const entry of [
      resolution({ provider: 'beta', vendorPath: '/bin/beta' }),
      resolution({ provider: 'gamma' }),
      resolution({
        provider: 'delta',
        vendorPath: '/bin/delta',
        adapterPath: '/bin/delta-agent-acp',
        handshakeFailed: true,
      }),
    ]) {
      const [row] = providerOptions([entry]);
      expect(row?.routes.acp).toBe('missing');
      expect(row?.route).not.toBe('acp');
    }
  });
});
