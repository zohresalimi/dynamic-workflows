/**
 * KAR-12.4 AC4, test plan #4 — a `satisfies:` entry naming a criterion the
 * spec does not contain.
 *
 * Pure, and standalone from the file-discovery mechanism itself (KAR-12.6,
 * which this story blocks): `.DeFlow/gates/*.{yaml,yml}` parsing and the
 * filesystem walk belong to that story, and this is the one rule they will
 * call — "a typo here must not quietly cover nothing"
 * (docs/delivery/epics/EPIC-12-verification-gates.md, KAR-12.4).
 *
 * Verifies: EPIC-12-S24 (third scenario)
 */
import { expect, it, describe as suite } from 'vitest';
import { unknownGateCriteria } from './gate-file-criteria.ts';
import { type TaskSpec, TaskSpecSchema } from './task-spec.ts';

function specWith(ids: readonly string[]): TaskSpec {
  return TaskSpecSchema.parse({
    schemaId: 'DeFlow.taskspec.v1',
    goal: 'Ship the a11y pass.',
    scope: { included: ['packages/ui'] },
    nonGoals: [],
    constraints: [],
    priorDecisions: [],
    acceptanceCriteria: ids.map((id) => ({
      id,
      statement: `Criterion ${id} holds.`,
      check: { kind: 'manual', rubric: 'a human looks' },
      coveredByGates: [],
    })),
    knownFailureModes: [],
    approvedBy: null,
    specHash: `sha256-${'0'.repeat(64)}`,
  });
}

const EIGHT = ['ac-1', 'ac-2', 'ac-3', 'ac-4', 'ac-5', 'ac-6', 'ac-7', 'ac-8'];

suite('unknownGateCriteria — GATE_UNKNOWN_CRITERION', () => {
  it('names the file and the id for a satisfies entry the spec does not contain', () => {
    const issues = unknownGateCriteria('.DeFlow/gates/a11y.yaml', ['ac-99'], specWith(EIGHT));

    expect(issues).toEqual([
      {
        file: '.DeFlow/gates/a11y.yaml',
        id: 'ac-99',
        message: expect.stringContaining('ac-99'),
      },
    ]);
    expect(issues[0]?.message).toContain('.DeFlow/gates/a11y.yaml');
  });

  it('is empty when every satisfies entry names a real criterion', () => {
    expect(
      unknownGateCriteria('.DeFlow/gates/typecheck.yaml', ['ac-1', 'ac-8'], specWith(EIGHT)),
    ).toEqual([]);
  });

  it('reports every unknown id, not only the first', () => {
    const issues = unknownGateCriteria(
      '.DeFlow/gates/a11y.yaml',
      ['ac-1', 'ac-98', 'ac-99'],
      specWith(EIGHT),
    );
    expect(issues.map((issue) => issue.id)).toEqual(['ac-98', 'ac-99']);
  });
});
