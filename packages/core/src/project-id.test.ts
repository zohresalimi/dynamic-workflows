/**
 * KAR-22.1 — `ProjectId` and its minter.
 *
 * The shape is `mintRunId`'s and that is deliberate rather than imitative:
 * timestamp before the random suffix, so plain string comparison sorts projects
 * in creation order. Both inputs are injected for the same reason `mintRunId`
 * injects them — `@DeFlow/core` may depend on nothing capable of I/O, and a
 * spec has to be able to reproduce an id exactly.
 *
 * Verifies: EPIC-22-S1 (the id clause) · KAR-22.1 AC1
 */
import { expect, it, describe as suite } from 'vitest';
import { ProjectIdSchema } from './ids.ts';
import { mintProjectId } from './project-id.ts';

const AT = Date.parse('2026-08-15T10:11:12.345Z');

suite('mintProjectId', () => {
  it('mints prj_<YYYYMMDDTHHMMSSZ>_<6 lowercase hex>', () => {
    expect(mintProjectId(AT, () => 'a1b2c3')).toBe('prj_20260815T101112Z_a1b2c3');
  });

  it('sorts in creation order under plain string comparison', () => {
    const earlier = mintProjectId(AT, () => 'ffffff');
    const later = mintProjectId(AT + 60_000, () => '000000');
    expect([later, earlier].toSorted()).toEqual([earlier, later]);
  });

  it('reads time and randomness only from its arguments', () => {
    expect(mintProjectId(AT, () => 'a1b2c3')).toBe(mintProjectId(AT, () => 'a1b2c3'));
  });

  it('refuses a suffix that is not six lowercase hex characters', () => {
    expect(() => mintProjectId(AT, () => 'A1B2C3')).toThrow();
    expect(() => mintProjectId(AT, () => 'abc')).toThrow();
  });
});

suite('ProjectIdSchema', () => {
  it('accepts a minted id and rejects everything shaped like one but not', () => {
    expect(ProjectIdSchema.parse('prj_20260815T101112Z_a1b2c3')).toBe(
      'prj_20260815T101112Z_a1b2c3',
    );
    for (const bad of [
      'run_20260815T101112Z_a1b2c3',
      'prj_20260815T101112Z_A1B2C3',
      'prj_20260815T101112_a1b2c3',
      'prj_a1b2c3',
      '',
    ]) {
      expect(() => ProjectIdSchema.parse(bad)).toThrow();
    }
  });
});
