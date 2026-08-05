/**
 * KAR-03.8 — the seed rules, which are the difference between a crash-fuzz
 * failure you can reproduce and one you can only describe (AC6).
 *
 * Verifies: EPIC-03-S26 (background) · AC6
 */
import { expect, it, describe as suite } from 'vitest';
import { CI_RUN_ID_ENV, CRASH_SEED_ENV, crashSeed, mulberry32 } from './random.ts';

suite('mulberry32', () => {
  it('produces the same sequence for the same seed', () => {
    const draw = (seed: number) => Array.from({ length: 8 }, mulberry32(seed));
    expect(draw(1_234)).toEqual(draw(1_234));
  });

  it('produces a different sequence for a different seed', () => {
    expect(Array.from({ length: 8 }, mulberry32(1))).not.toEqual(
      Array.from({ length: 8 }, mulberry32(2)),
    );
  });

  it('stays inside [0, 1)', () => {
    const next = mulberry32(0xdead_beef);
    for (let draw = 0; draw < 5_000; draw += 1) {
      const value = next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

suite('crashSeed picks a number a failure can be replayed from (AC6)', () => {
  it('takes $GITHUB_RUN_ID, so a CI failure reproduces from the log', () => {
    expect(crashSeed({ [CI_RUN_ID_ENV]: '18246113077' })).toEqual({
      seed: 18_246_113_077 >>> 0,
      source: 'ci-run-id',
    });
  });

  it('lets an explicit seed beat CI’s, because that is what reproducing looks like', () => {
    expect(crashSeed({ [CI_RUN_ID_ENV]: '18246113077', [CRASH_SEED_ENV]: '99' })).toEqual({
      seed: 99,
      source: 'explicit',
    });
  });

  it('falls back to the clock, and says so, so the caller can print the number', () => {
    const chosen = crashSeed({});
    expect(chosen.source).toBe('clock');
    expect(Number.isInteger(chosen.seed)).toBe(true);
  });

  it('ignores a value that is not a number rather than seeding with NaN', () => {
    expect(crashSeed({ [CRASH_SEED_ENV]: 'not-a-number' }).source).toBe('clock');
  });
});
