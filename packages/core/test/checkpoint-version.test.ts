/**
 * KAR-03.6 AC7 — `CHECKPOINT_VERSION` is a single constant, it lives beside
 * the type it guards, and it says out loud what obliges a bump.
 *
 * This is a source-level test because the failure mode is a person, not a
 * program: the constant only works if the next engineer to add a field to
 * `RunState` reads, three lines above their edit, that they have to change it.
 * A comment somewhere else in the tree is a comment nobody sees. Two copies of
 * the constant is worse than none, because the two will disagree and the cache
 * will be believed anyway.
 *
 * Verifies: EPIC-03-S19 · AC7
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { productionSources } from '../../../test/support/workspace.ts';
import { CHECKPOINT_VERSION } from '../src/run-state.ts';

const runStatePath = fileURLToPath(new URL('../src/run-state.ts', import.meta.url));
const source = readFileSync(runStatePath, 'utf8');

suite('the constant is adjacent to the type it guards', () => {
  it('is declared in run-state.ts, the file whose shape it stamps', () => {
    expect(source).toMatch(/export const CHECKPOINT_VERSION\s*(:[^=]+)?=\s*\d+/);
  });

  it('is declared exactly once in the whole workspace', () => {
    const declarations = productionSources('packages/core')
      .concat(productionSources('packages/ledger'))
      .concat(productionSources('packages/daemon'))
      .filter((file) => /export const CHECKPOINT_VERSION\b/.test(file.text));

    expect(declarations.map((file) => file.path)).toEqual(['packages/core/src/run-state.ts']);
  });
});

suite('the comment above it states the obligation', () => {
  /** The doc comment immediately preceding the declaration, and nothing else. */
  const preceding = source.slice(0, source.indexOf('export const CHECKPOINT_VERSION'));
  const comment = preceding.slice(preceding.lastIndexOf('/**'));

  it('tells the next engineer to bump it when the shape changes', () => {
    expect(comment).toMatch(/bump/i);
    expect(comment).toMatch(/shape/i);
  });

  it('says what a mismatch costs — a full replay, never a wrong state', () => {
    expect(comment).toMatch(/replay/i);
  });

  it('is a real comment and not the whole file', () => {
    expect(comment.length).toBeGreaterThan(80);
    // The ceiling exists to stop the comment becoming the file, not to cap the
    // bump log: that list grows by one short clause every time the shape
    // changes, which is the whole point of keeping it here. Raised from 1400
    // when bump 18 (`CancelState.unanswered`, KAR-27.6) landed.
    expect(comment.length).toBeLessThan(1700);
  });
});

suite('the value', () => {
  it('is a positive integer, so a mismatch is total-orderable', () => {
    expect(Number.isInteger(CHECKPOINT_VERSION)).toBe(true);
    expect(CHECKPOINT_VERSION).toBeGreaterThan(0);
  });
});
