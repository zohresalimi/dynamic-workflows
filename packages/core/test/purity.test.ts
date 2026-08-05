/**
 * R1 — @DeFlow/core is pure structurally, not by convention.
 *
 * This test is cheap and it exists before the first temptation, not after: by
 * EPIC-06 there will be a plausible-sounding reason to reach for a driver in
 * core, and by then the test is a negotiation rather than a fact.
 *
 * Verifies: EPIC-01-S5 (scenarios 1 and 2) · AC7. The `ohash` check is
 * KAR-02.9 AC6 / EPIC-02-S8 — a different concern (a serialisation-stability
 * guarantee, not I/O-capability) that reuses the same "grep packages/core/src"
 * mechanism, so it lives alongside the other structural purity checks.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkCorePurity,
  checkNoDataPlaneReachFromCore,
  checkNoNodeBuiltinImports,
  checkNoOhashImport,
  describe as render,
} from '../../../test/support/guards.ts';
import { productionSources, readJson } from '../../../test/support/workspace.ts';

suite('@DeFlow/core purity', () => {
  it('has no I/O-capable dependencies', () => {
    const core = readJson('packages/core/package.json');
    expect(Object.keys(core.dependencies ?? {})).toEqual(['zod']);
    expect(render(checkCorePurity(core))).toBe('');
  });

  it('imports no node: builtins', () => {
    const sources = productionSources('packages/core');
    expect(sources.length).toBeGreaterThan(0);
    expect(render(checkNoNodeBuiltinImports(sources))).toBe('');
  });

  it('imports no ohash (KAR-02.9 AC6): canonicalJson is the encoder core owns', () => {
    const sources = productionSources('packages/core');
    expect(sources.length).toBeGreaterThan(0);
    expect(render(checkNoOhashImport(sources))).toBe('');
  });
});

/**
 * KAR-03.4 AC2 / EPIC-03-S11 scenario 3. The control-plane / data-plane split
 * is what removes snapshotting, and it survives only if the reducer *cannot*
 * read `io_chunk` — not if it merely does not today. Two structural facts hold
 * it: core declares no dependency on the ledger or on a driver, and no file
 * under packages/core/src names either.
 */
suite('the reducer structurally cannot reach the data plane (KAR-03.4 AC2)', () => {
  it('declares no dependency on @DeFlow/ledger or better-sqlite3', () => {
    const core = readJson('packages/core/package.json');
    const declared = Object.keys({
      ...core.dependencies,
      ...core.devDependencies,
      ...core.optionalDependencies,
      ...core.peerDependencies,
    });
    expect(declared).not.toContain('@DeFlow/ledger');
    expect(declared).not.toContain('better-sqlite3');
  });

  it('has no source that imports the ledger or names the io_chunk table', () => {
    const sources = productionSources('packages/core');
    expect(sources.length).toBeGreaterThan(0);
    expect(render(checkNoDataPlaneReachFromCore(sources))).toBe('');
  });

  it('and that is a real result, not an empty scan', () => {
    // Take the rule away from the real source and the guard must object, which
    // is only possible if it read the files in the first place.
    const mutated = productionSources('packages/core').map((file) => ({
      ...file,
      text: `${file.text}\nimport { readIoChunks } from '@DeFlow/ledger';\n`,
    }));
    expect(checkNoDataPlaneReachFromCore(mutated).length).toBe(mutated.length);
  });
});
