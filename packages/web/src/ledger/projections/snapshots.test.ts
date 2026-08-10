/**
 * KAR-16.3 AC2 — every projection's final state over every fixture, as a
 * committed file snapshot under the normalising serializer.
 *
 * Verifies: EPIC-16-S15 · AC2
 *
 * The serializer is registered in `test/setup.ts`, which every project slice
 * loads, and it was registered **before the first snapshot in this repository
 * was written** (docs/14 §9). That ordering is the requirement rather than a
 * nicety: a serializer added after snapshots exist rewrites all of them at
 * once, and a snapshot mechanism that produces a diff on every run stops being
 * read — at which point `-u` becomes a reflex and the snapshots will happily
 * record a regression.
 *
 * What these files are *for* is the change nobody thought to assert: a field
 * quietly dropped from a view-model, a state that stopped being reached, a
 * consumer set that shrank. The named assertions in the six specs beside this
 * one say what each projection must do; these say what it currently does, in
 * full, so that a change to any of it is visible in a diff.
 */
import { expect, it, describe as suite } from 'vitest';
import { ledger, type RunFixture } from '../../../test/run-fixtures.ts';
import { PROJECTIONS, type ProjectionModule } from './index.ts';

/**
 * Which projection is snapshotted over which fixture.
 *
 * Not the cross product: a projection folded over a ledger with nothing in it
 * for that view snapshots an empty object, and forty files of `{}` is noise
 * that makes the interesting diffs harder to see rather than easier.
 */
const MATRIX: readonly (readonly [RunFixture, string])[] = [
  ['happy-path-12', 'plan'],
  ['happy-path-12', 'planHistory'],
  ['happy-path-12', 'blackboard'],
  ['happy-path-12', 'context'],
  ['happy-path-12', 'gates'],
  ['happy-path-12', 'cost'],
  ['happy-path-12', 'timeline'],
  ['three-patches', 'plan'],
  ['three-patches', 'planHistory'],
  ['compaction', 'context'],
  ['gate-failure-repair', 'plan'],
  ['gate-failure-repair', 'planHistory'],
  ['gate-failure-repair', 'gates'],
  ['gate-failure-repair', 'cost'],
  ['gate-failure-repair', 'timeline'],
  ['crash-resume-seq-gap', 'plan'],
];

const moduleNamed = (name: string): ProjectionModule<never> => {
  const found = PROJECTIONS.find((one) => one.name === name);
  if (found === undefined) throw new Error(`no projection named ${name}`);
  return found;
};

function fold(fixture: RunFixture, name: string): unknown {
  const module = moduleNamed(name);
  const state = module.create();
  for (const event of ledger(fixture)) module.apply(state, event);
  return state;
}

suite('AC2 — fixture-driven file snapshots, under the normalising serializer', () => {
  it.each(MATRIX)('%s folded by %s', async (fixture, name) => {
    await expect(fold(fixture, name)).toMatchFileSnapshot(`__snapshots__/${fixture}.${name}.snap`);
  });
});

suite('AC2 — the suite is fast enough to run on every save', () => {
  it('folds every fixture through all seven projections far inside the budget', () => {
    // AC2's claim is about the *suite*, which a spec cannot time from inside
    // it. What it can time is the work the suite is made of: the seven
    // projections over every recorded fixture, fifty times over. If that is
    // milliseconds then the two-second budget is spent on the runner, and a
    // projection that had quietly acquired a quadratic scan would show here
    // long before it showed on the wall clock.
    const fixtures: readonly RunFixture[] = [
      'happy-path-12',
      'three-patches',
      'compaction',
      'gate-failure-repair',
      'crash-resume-seq-gap',
    ];
    for (const fixture of fixtures) ledger(fixture);

    const started = performance.now();
    for (let round = 0; round < 50; round += 1) {
      for (const fixture of fixtures) {
        for (const module of PROJECTIONS) {
          const state = module.create();
          for (const event of ledger(fixture)) module.apply(state, event);
        }
      }
    }
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(2_000);
  });
});
