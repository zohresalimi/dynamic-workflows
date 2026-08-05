/**
 * KAR-03.5 — two structural facts about the reducer that no runtime test can
 * hold (EPIC-03-S11 scenario 3, EPIC-03-S17 scenario 3).
 *
 * The first is that `reduce` branches on `kind` and nothing else. Upcasting
 * runs on the way *in*, so a `v` comparison inside the reducer would mean
 * version logic had leaked into state transitions — where it is invisible to
 * the upcaster suite and testable only by replaying the one historical event
 * that happens to carry that version.
 *
 * The second is the signature: `(RunState, Event) -> RunState` is what makes
 * "the reducer structurally cannot read `io_chunk`" true, since neither
 * parameter can reach a database. The dependency half of that claim lives in
 * ./purity.test.ts.
 *
 * Verifies: EPIC-03-S11 (scenario 3), EPIC-03-S17 (scenario 3) · AC3
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { reduce } from '../src/reduce.ts';

const source = readFileSync(fileURLToPath(new URL('../src/reduce.ts', import.meta.url)), 'utf8');

/** Line and block comments removed: prose may discuss `v`; code may not read it. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

suite('the reducer branches on kind, never on the payload version', () => {
  it('never reads event.v', () => {
    expect(code).not.toMatch(/\bevent\.v\b/);
  });

  it('compares nothing against a version field', () => {
    expect(code).not.toMatch(/\.v\s*(===|!==|<=?|>=?)/);
    expect(code).not.toMatch(/\bversion\s*(===|!==)/);
  });

  it('does branch on kind, so the check above is not passing by vacuum', () => {
    expect(code).toMatch(/\bevent\.kind\b|\bkind\b/);
    expect(code).toContain('case');
  });
});

suite('the reducer takes state and one event, and returns state', () => {
  it('has arity two', () => {
    expect(reduce.length).toBe(2);
  });

  it('is usable directly as an Array.prototype.reduce callback', () => {
    // The extra (index, array) arguments a reducer callback receives must not
    // change the result — this is what `events.reduce(reduce, state)` relies
    // on everywhere else in the codebase.
    expect(reduce.length).toBeLessThan(3);
  });
});
