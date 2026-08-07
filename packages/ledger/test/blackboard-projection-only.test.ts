/**
 * KAR-09.8 AC3 / EPIC-09-S42 scenario 2 — there is no write path to `fact` or
 * `fact_edges` that is not the projection applying a `fact.*` event.
 *
 * > The one design smell to watch for is a helper that "just updates the fact
 * > table directly" for performance during a large fan-out. AC3's grep exists
 * > because that helper is the single change that would silently destroy NF9
 * > and NF10, and it would look like an optimisation in review.
 *
 * Three assertions, and the second and third are what make the first mean
 * something: a grep that has never matched anything passes for ever, and a
 * grep whose allow-list is empty passes because the feature does not exist.
 *
 * Verifies: EPIC-09-S42 (scenario 2) · AC3
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkFactWritesAreProjectionOnly,
  checkNoFactCache,
  describe as render,
} from '../../../test/support/guards.ts';
import { allWorkspaceSources, readText } from '../../../test/support/workspace.ts';

/** The one module allowed to write the blackboard tables. */
const PROJECTION = 'packages/ledger/src/blackboard.ts';

const sources = allWorkspaceSources();

suite('the blackboard has exactly one writer (AC3)', () => {
  it('finds no INSERT INTO fact outside the projection module', () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(render(checkFactWritesAreProjectionOnly(sources, [PROJECTION]))).toBe('');
  });

  it('and the projection module is where those writes actually are', () => {
    // Without this the suite above would be green on a repository that had no
    // blackboard at all, which is the state it was written in.
    const projection = readText(PROJECTION);
    expect(projection).toMatch(/INSERT INTO fact\b/);
    expect(projection).toMatch(/INSERT INTO fact_edges\b/);
    expect(
      checkFactWritesAreProjectionOnly([{ path: 'elsewhere.ts', text: projection }], []).length,
    ).toBeGreaterThan(0);
  });

  it('holds no module-level mutable fact cache anywhere', () => {
    expect(render(checkNoFactCache(sources, []))).toBe('');
    expect(
      checkNoFactCache(
        [{ path: 'daemon.ts', text: 'const factCache = new Map<string, Fact>()' }],
        [],
      ).length,
    ).toBe(1);
  });
});
