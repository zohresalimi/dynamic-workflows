/**
 * KAR-12.6 test plan #7, AC8 — `.DeFlow/gates/**` is in the protected path
 * set EPIC-08 (via KAR-12.5's `DEFAULT_PROTECTED_PATHS`) already defends.
 *
 * A test in this story rather than a comment, because everything in §9.1 of
 * 10-verification-gates.md — the manifest hash, the divergence check, the
 * "an agent cannot edit the check" defence — rests on this one rule staying
 * true. If EPIC-08's protected set ever stops containing it, this fails
 * instead of the drift going unnoticed.
 *
 * Verifies: EPIC-12-S36, EPIC-12-S37 (third scenario) · AC8
 */
import { pathScopeMatches } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { DEFAULT_PROTECTED_PATHS } from './scope-gate.ts';

suite('.DeFlow/gates/** is in the protected path set (AC8)', () => {
  it('isProtected(".DeFlow/gates/typecheck.yaml") === true', () => {
    expect(pathScopeMatches(DEFAULT_PROTECTED_PATHS, '.DeFlow/gates/typecheck.yaml')).toBe(true);
  });

  it('protects a nested custom gate file too', () => {
    expect(pathScopeMatches(DEFAULT_PROTECTED_PATHS, '.DeFlow/gates/nested/a11y.yaml')).toBe(true);
  });
});
