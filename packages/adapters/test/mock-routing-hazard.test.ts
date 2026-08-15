/**
 * KAR-19.7 AC8 — the new entry is not a routing hazard, and `doctor` tells the
 * truth about a binary that ships in the same tarball.
 *
 * The failure this guards is quiet and expensive: a run that "succeeded"
 * against an agent nobody chose, on a machine where the real provider was
 * sitting right there. So the preference order is a function with a test rather
 * than a comment, and the bundled entry is last in it by construction.
 *
 * The second half is KAR-18.8's rule holding for a new entry — the words have
 * to fit the machine. Telling an operator to `npm install -g` a package that
 * shipped in the same tarball as the command they just ran is the same class of
 * wrong as *"claude is not installed"* on a machine where it resolves.
 *
 * Verifies: EPIC-19-S51 · AC8 · test plan #8
 */
import { expect, it, describe as suite } from 'vitest';
import {
  installCommand,
  PROVIDER_SPECS,
  type ProviderResolution,
  providerVerdict,
  usableProviders,
} from '../src/index.ts';

const BUNDLED = 'mock';

function resolution(over: Partial<ProviderResolution> & { provider: string }): ProviderResolution {
  return {
    state: 'installed',
    kind: 'native',
    vendorBin: over.provider,
    vendorPath: `/opt/DeFlow/${over.provider}`,
    adapterBin: over.provider,
    adapterPath: `/opt/DeFlow/${over.provider}`,
    package: 'some-package',
    bundled: over.provider === BUNDLED,
    ...over,
  };
}

suite('EPIC-19-S51 — a real provider is always preferred', () => {
  it('never puts the bundled agent ahead of an installed vendor', () => {
    const order = usableProviders([
      resolution({ provider: BUNDLED }),
      resolution({ provider: 'gemini', package: '@google/gemini-cli' }),
    ]).map((entry) => entry.provider);

    expect(order[0]).toBe('gemini');
    expect(order.at(-1)).toBe(BUNDLED);
  });

  it('is stable whichever order the table arrives in', () => {
    const forwards = usableProviders([
      resolution({ provider: 'gemini' }),
      resolution({ provider: BUNDLED }),
    ]).map((entry) => entry.provider);

    expect(forwards).toEqual(['gemini', BUNDLED]);
  });

  it('still offers the bundled agent when it is the only thing installed', () => {
    const order = usableProviders([
      resolution({ provider: BUNDLED }),
      resolution({
        provider: 'gemini',
        state: 'not-installed',
        vendorPath: null,
        adapterPath: null,
      }),
    ]).map((entry) => entry.provider);

    expect(order).toEqual([BUNDLED]);
  });

  it('declares the bundled entry as bundled, which is what puts it last', () => {
    expect(PROVIDER_SPECS.mock.bundled).toBe(true);
    for (const spec of Object.values(PROVIDER_SPECS)) {
      if (spec.id === BUNDLED) continue;
      expect(spec.bundled ?? false).toBe(false);
    }
  });
});

suite('EPIC-19-S51 — doctor tells the truth about a bundled binary', () => {
  it('reports it installed, with nothing to run', () => {
    const verdict = providerVerdict(resolution({ provider: BUNDLED }));

    expect(verdict.state).toBe('installed');
    expect(verdict.action).toBeUndefined();
    expect(verdict.detail).not.toContain('not installed');
  });

  it('never offers npm install -g for a package that ships in the same tarball', () => {
    const missing = providerVerdict(
      resolution({
        provider: BUNDLED,
        state: 'not-installed',
        vendorPath: null,
        adapterPath: null,
        package: 'deflow',
      }),
    );

    expect(missing.action ?? '').not.toContain(installCommand('deflow'));
    expect(missing.detail).not.toContain('npm install -g');
  });
});
