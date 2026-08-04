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
