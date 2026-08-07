/**
 * KAR-10.2 — the framed document contract, as a unit.
 *
 * Verifies: EPIC-10-S6 (second scenario), EPIC-10-S9 · AC4, AC5, AC6, AC8,
 * AC10, AC11 · test plan #1, #2
 */
import { expect, it, describe as suite } from 'vitest';
import {
  answersAsPriorDecisions,
  criterionOrdinal,
  FRAMING_PERMISSION,
  FRAMING_RETURN_MAX_TOKENS,
  framingReturns,
  sealTaskSpec,
  TASKSPEC_DRAFT_SCHEMA_ID,
  validateTaskSpecDraft,
} from './framing.ts';
import { specHash } from './hash.ts';
import { DEFAULT_RETURNS_MAX_TOKENS } from './plan-graph.ts';
import { TaskSpecSchema } from './task-spec.ts';

/** A hand-written framed document that satisfies every clause of AC4-AC6. */
function goodDraft(): Record<string, unknown> {
  return {
    schemaId: TASKSPEC_DRAFT_SCHEMA_ID,
    goal: 'Migrate the design system from Vue 2 to Vue 3 across packages/ui and packages/forms.',
    scope: { included: ['packages/ui', 'packages/forms'], paths: ['packages/ui/**'] },
    nonGoals: ['packages/legacy is not touched'],
    constraints: ['no new runtime dependencies'],
    priorDecisions: [
      {
        decision: 'Only packages/ui and packages/forms are in scope.',
        rationale: 'The operator said so when asked which packages the migration covers.',
        source: 'operator',
      },
    ],
    acceptanceCriteria: [
      {
        id: 'ac-1',
        statement: 'All components under packages/ui/src/** compile under Vue 3 with no errors.',
        verifiedBy: ['typecheck', 'build'],
      },
      {
        id: 'ac-2',
        statement: 'The migrated date picker feels as responsive as the old one.',
        unverifiable: true,
        reason: 'Subjective. No harness exists. Route to a human node at the milestone.',
        verifiedBy: ['human-review-ui'],
      },
    ],
    knownFailureModes: [
      {
        id: 'fm-1',
        description: 'the migration codemod silently drops v-model modifiers',
        detection: 'the form package’s snapshot tests change without an intended diff',
      },
    ],
  };
}

/** `goodDraft()` with one edit applied at `path`. */
function draftWith(patch: (draft: Record<string, unknown>) => void): Record<string, unknown> {
  const draft = goodDraft();
  patch(draft);
  return draft;
}

const pointers = (issues: readonly { pointer: string }[]) => issues.map((issue) => issue.pointer);

suite('EPIC-10-S6 — the framing node’s return budget is set for its type (AC10)', () => {
  it('is 4000 rather than the 1500 default', () => {
    expect(FRAMING_RETURN_MAX_TOKENS).toBe(4000);
    expect(FRAMING_RETURN_MAX_TOKENS).not.toBe(DEFAULT_RETURNS_MAX_TOKENS);
    expect(framingReturns()).toEqual({
      schemaId: TASKSPEC_DRAFT_SCHEMA_ID,
      maxTokens: 4000,
    });
  });

  it('runs at read permission (AC1)', () => {
    expect(FRAMING_PERMISSION).toBe('read');
  });
});

suite('test plan #1 — the document contract', () => {
  it('accepts a hand-written good document', () => {
    expect(validateTaskSpecDraft(goodDraft())).toEqual([]);
  });

  it('rejects nonGoals: [] with a pointer to /nonGoals (AC6)', () => {
    const issues = validateTaskSpecDraft(
      draftWith((draft) => {
        draft.nonGoals = [];
      }),
    );
    expect(pointers(issues)).toContain('/nonGoals');
    expect(issues[0]?.message).toMatch(/nonGoals/);
    expect(issues[0]?.message).toMatch(/scope creep/);
  });

  it('rejects a failure mode with a description and no detection (AC5)', () => {
    const issues = validateTaskSpecDraft(
      draftWith((draft) => {
        draft.knownFailureModes = [{ id: 'fm-1', description: 'the codemod drops modifiers' }];
      }),
    );
    expect(pointers(issues)).toContain('/knownFailureModes/0/detection');
  });

  it('rejects an empty acceptanceCriteria array', () => {
    const issues = validateTaskSpecDraft(
      draftWith((draft) => {
        draft.acceptanceCriteria = [];
      }),
    );
    expect(pointers(issues)).toContain('/acceptanceCriteria');
  });
});

suite('EPIC-10-S9 — the acceptance-criteria contract is enforced structurally (AC4)', () => {
  it('fails with exactly one error naming the criterion nothing checks', () => {
    const issues = validateTaskSpecDraft(
      draftWith((draft) => {
        draft.acceptanceCriteria = [
          {
            id: 'ac-3',
            statement: 'All 47 components under packages/ui/src/** compile under Vue 3.',
            verifiedBy: ['typecheck', 'build'],
          },
          {
            id: 'ac-7',
            statement: 'The migration does not regress bundle size.',
            verifiedBy: [],
          },
        ];
      }),
    );

    expect(issues).toHaveLength(1);
    expect(issues[0]?.pointer).toBe('/acceptanceCriteria/1');
    expect(issues[0]?.message).toContain('ac-7');
    expect(issues[0]?.message).toMatch(/at least one gate|unverifiable/);
  });

  it('accepts unverifiable: true with a reason', () => {
    expect(
      validateTaskSpecDraft(
        draftWith((draft) => {
          draft.acceptanceCriteria = [
            {
              id: 'ac-9',
              statement: 'The migrated date picker feels as responsive as the old one.',
              unverifiable: true,
              reason: 'Subjective. No harness exists. Route to a human node.',
              verifiedBy: ['human-review-ui'],
            },
          ];
        }),
      ),
    ).toEqual([]);
  });

  it('refuses unverifiable: true with an empty reason', () => {
    const issues = validateTaskSpecDraft(
      draftWith((draft) => {
        draft.acceptanceCriteria = [
          {
            id: 'ac-9',
            statement: 'The migrated date picker feels as responsive as the old one.',
            unverifiable: true,
            reason: '',
          },
        ];
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('ac-9');
  });

  it('reports all violations at once, ordered by criterion id', () => {
    const issues = validateTaskSpecDraft(
      draftWith((draft) => {
        draft.acceptanceCriteria = [
          { id: 'ac-11', statement: 'eleventh', verifiedBy: [] },
          { id: 'ac-2', statement: 'second', verifiedBy: [] },
          { id: 'ac-1', statement: 'first', unverifiable: true, reason: '' },
          { id: 'ac-3', statement: 'third', verifiedBy: [] },
        ];
      }),
    );

    expect(issues).toHaveLength(4);
    expect(issues.map((issue) => issue.message.match(/ac-\d+/)?.[0])).toEqual([
      'ac-1',
      'ac-2',
      'ac-3',
      'ac-11',
    ]);
  });

  it('orders ac-10 after ac-9, not before ac-2', () => {
    expect(criterionOrdinal('ac-10')).toBeGreaterThan(criterionOrdinal('ac-9'));
  });
});

suite('AC8 — a clarifying answer becomes a priorDecision the spec carries', () => {
  it('records the question, the answer and source: operator', () => {
    const decisions = answersAsPriorDecisions([
      {
        question: 'Which packages does the migration cover?',
        answer: 'Only packages/ui and packages/forms. Leave packages/legacy alone.',
      },
    ]);

    expect(decisions).toEqual([
      {
        decision: 'Only packages/ui and packages/forms. Leave packages/legacy alone.',
        rationale:
          'Answered by the operator when asked: “Which packages does the migration cover?”',
        source: 'operator',
      },
    ]);
  });
});

suite('AC11 — sealing the framed document into the TaskSpec run.created carries', () => {
  it('mints a specHash, leaves approvedBy null, and validates as DeFlow.taskspec.v1', async () => {
    const sealed = await sealTaskSpec(goodDraft());

    expect(() => TaskSpecSchema.parse(sealed)).not.toThrow();
    expect(sealed.approvedBy).toBeNull();
    expect(sealed.specHash).toBe(await specHash(sealed as unknown as Record<string, unknown>));
    expect(sealed.goal).toBe(goodDraft().goal);
    expect(sealed.nonGoals).toEqual(['packages/legacy is not touched']);
  });

  it('projects a single named gate onto check, and an unverifiable criterion onto a manual rubric', async () => {
    const sealed = await sealTaskSpec(
      draftWith((draft) => {
        draft.acceptanceCriteria = [
          { id: 'ac-1', statement: 'typechecks', verifiedBy: ['typecheck'] },
          {
            id: 'ac-2',
            statement: 'feels responsive',
            unverifiable: true,
            reason: 'Subjective; no harness exists.',
          },
          { id: 'ac-3', statement: 'compiles and builds', verifiedBy: ['typecheck', 'build'] },
        ];
      }),
    );

    expect(sealed.acceptanceCriteria[0]?.check).toEqual({ kind: 'gate', gate: 'typecheck' });
    expect(sealed.acceptanceCriteria[1]?.check).toEqual({
      kind: 'manual',
      rubric: 'Subjective; no harness exists.',
    });
    // v1 has no vocabulary for "all of typecheck and build", and inventing one
    // gate out of two would be a claim the framed document did not make.
    expect(sealed.acceptanceCriteria[2]?.check).toBeUndefined();
  });

  it('refuses to seal a document that does not satisfy the contract', async () => {
    await expect(
      sealTaskSpec(
        draftWith((draft) => {
          draft.nonGoals = [];
        }),
      ),
    ).rejects.toThrow(/nonGoals/);
  });

  it('is identity-preserving: the same document seals to the same specHash', async () => {
    const first = await sealTaskSpec(goodDraft());
    const second = await sealTaskSpec(goodDraft());
    expect(second.specHash).toBe(first.specHash);
  });
});
