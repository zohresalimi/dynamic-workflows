/**
 * KAR-12.1 AC5 — there is no field, flag, config key or environment variable
 * anywhere in this package that advances a milestone past a non-`pass` verdict.
 *
 * A source-level assertion, because the failure mode is a person: the shortest
 * path from "gates are real" to "gates are decoration" is one boolean somebody
 * added on a Friday to unblock a demo. Overriding a red gate *must* remain
 * possible or the tool is unusable — the design decision
 * ([docs/10-verification-gates.md §9.1]) is that it can only happen through a
 * `human` node whose `human.responded` event carries an identity and a
 * timestamp, never through a flag the data model would let anybody set.
 *
 * Verifies: EPIC-12-S5 (second scenario) · AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { productionSources } from '../../../test/support/workspace.ts';
import { MILESTONE_ADVANCE_INPUTS } from '../src/milestone.ts';

const sources = productionSources('packages/gates');

/** S5's own expression, plus the bare word the acceptance criterion names. */
const ESCAPE_HATCH = /\boverride\b|\bforce\w*|\bskipGate\b|\bignoreGate\b|\bforceAdvance\b/i;

suite('the package has sources to assert over', () => {
  it('found them', () => {
    expect(sources.length).toBeGreaterThan(5);
  });
});

suite('no escape hatch exists in packages/gates (S5, second scenario)', () => {
  for (const file of sources) {
    it(`${file.path} names no override`, () => {
      const hits = file.text
        .split('\n')
        .map((line, index) => ({ line: index + 1, text: line }))
        .filter((entry) => ESCAPE_HATCH.test(entry.text));
      expect(hits).toEqual([]);
    });
  }
});

suite('the milestone rule reads exactly two things (S5, first scenario)', () => {
  it('takes verdict outcomes and write positions, and nothing else', () => {
    expect([...MILESTONE_ADVANCE_INPUTS]).toEqual(['verdicts', 'writes']);
  });
});
