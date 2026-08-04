/**
 * KAR-02.2 — TaskSpec schema, specHash identity and pinnedSegmentsOf.
 *
 * Verifies: EPIC-02-S6, EPIC-02-S7 · AC1-AC6
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { specHash } from './hash.ts';
import { PINNED_SPEC_FIELDS, pinnedSegmentsOf, TaskSpecSchema } from './task-spec.ts';

const fixturePath = fileURLToPath(
  new URL('../test/fixtures/specs/vue3-migration.json', import.meta.url),
);
const validSpec: Record<string, unknown> = JSON.parse(readFileSync(fixturePath, 'utf8'));

/** A deep clone plus a patch, so every mutation test starts from the same
 * known-good baseline rather than accumulating mutations across cases. */
function withMutation(patch: (draft: Record<string, unknown>) => void): Record<string, unknown> {
  const draft = structuredClone(validSpec);
  patch(draft);
  return draft;
}

suite('TaskSpecSchema — AC1: zero acceptanceCriteria is rejected', () => {
  it('rejects an empty acceptanceCriteria array, naming the field', () => {
    const spec = withMutation((draft) => {
      draft.acceptanceCriteria = [];
    });
    const result = TaskSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.error.issues[0]?.path).toEqual(['acceptanceCriteria']);
  });
});

suite('TaskSpecSchema — AC2: the command check.expect literal is closed', () => {
  it('parses check: { kind: "command", run: "pnpm test", expect: "exit-zero" }', () => {
    const criteria = (validSpec.acceptanceCriteria as unknown[])[0];
    expect((criteria as { check: { expect: string } }).check.expect).toBe('exit-zero');
    expect(TaskSpecSchema.safeParse(validSpec).success).toBe(true);
  });

  it('rejects expect: "passes" as an invalid literal', () => {
    const spec = withMutation((draft) => {
      const criteria = draft.acceptanceCriteria as Array<Record<string, unknown>>;
      const check = criteria[0]?.check as Record<string, unknown>;
      check.expect = 'passes';
    });
    const result = TaskSpecSchema.safeParse(spec);
    expect(result.success).toBe(false);
  });
});

suite('TaskSpecSchema — EPIC-02-S7: rejections at the boundary', () => {
  const cases: Array<{
    mutation: string;
    path: (string | number)[];
    patch: (draft: Record<string, unknown>) => void;
  }> = [
    {
      mutation: 'acceptanceCriteria set to []',
      path: ['acceptanceCriteria'],
      patch: (draft) => {
        draft.acceptanceCriteria = [];
      },
    },
    {
      mutation: 'criterion check.expect set to "passes"',
      path: ['acceptanceCriteria', 0, 'check', 'expect'],
      patch: (draft) => {
        const criteria = draft.acceptanceCriteria as Array<Record<string, unknown>>;
        const check = criteria[0]?.check as Record<string, unknown>;
        check.expect = 'passes';
      },
    },
    {
      mutation: 'criterion check.kind set to "script"',
      path: ['acceptanceCriteria', 0, 'check', 'kind'],
      patch: (draft) => {
        const criteria = draft.acceptanceCriteria as Array<Record<string, unknown>>;
        const check = criteria[0]?.check as Record<string, unknown>;
        check.kind = 'script';
      },
    },
    {
      mutation: 'goal set to ""',
      path: ['goal'],
      patch: (draft) => {
        draft.goal = '';
      },
    },
    {
      mutation: 'knownFailureModes[0].detection removed',
      path: ['knownFailureModes', 0, 'detection'],
      patch: (draft) => {
        const modes = draft.knownFailureModes as Array<Record<string, unknown>>;
        delete modes[0]?.detection;
      },
    },
    {
      mutation: 'schemaId set to "DeFlow.taskspec"',
      path: ['schemaId'],
      patch: (draft) => {
        draft.schemaId = 'DeFlow.taskspec';
      },
    },
  ];

  for (const { mutation, path, patch } of cases) {
    it(`rejects: ${mutation}`, () => {
      const spec = withMutation(patch);
      const result = TaskSpecSchema.safeParse(spec);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('unreachable');
      expect(result.error.issues[0]?.path).toEqual(path);
    });
  }
});

suite('TaskSpecSchema — AC5: coveredByGates defaults to [] on parse', () => {
  it('is not required from a hand-written spec, and defaults to [] on every criterion', () => {
    const spec = withMutation((draft) => {
      const criteria = draft.acceptanceCriteria as Array<Record<string, unknown>>;
      for (const criterion of criteria) delete criterion.coveredByGates;
    });
    const result = TaskSpecSchema.safeParse(spec);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    for (const criterion of result.data.acceptanceCriteria) {
      expect(criterion.coveredByGates).toEqual([]);
    }
  });
});

suite('TaskSpecSchema — specHash identity (AC3, AC4)', () => {
  it('is unchanged by re-approving a parsed spec', async () => {
    const parsed = TaskSpecSchema.parse(validSpec);
    const before = await specHash(parsed);
    const approved = { ...parsed, approvedBy: { at: '2026-08-02T15:00:00Z', via: 'ui' as const } };
    const after = await specHash(approved);
    expect(after).toBe(before);
  });

  it('changes when a single character of goal changes', async () => {
    const parsed = TaskSpecSchema.parse(validSpec);
    const before = await specHash(parsed);
    const edited = { ...parsed, goal: `${parsed.goal}!` };
    const after = await specHash(edited);
    expect(after).not.toBe(before);
  });

  it('is unchanged by a JSON round trip with shuffled keys', async () => {
    const parsed = TaskSpecSchema.parse(validSpec);
    const before = await specHash(parsed);
    const roundTripped = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
    const shuffled = Object.fromEntries(Object.entries(roundTripped).toReversed());
    const after = await specHash(shuffled);
    expect(after).toBe(before);
  });
});

suite('pinnedSegmentsOf — AC6', () => {
  it('returns exactly the six named field groups, in a stable order', () => {
    const parsed = TaskSpecSchema.parse(validSpec);
    const segments = pinnedSegmentsOf(parsed, {
      pathScopes: ['packages/web/**'],
      permission: 'edit',
    });
    expect(segments.map((segment) => segment.field)).toEqual(PINNED_SPEC_FIELDS);
    expect(segments).toHaveLength(6);
  });

  it('matches the committed snapshot', async () => {
    const parsed = TaskSpecSchema.parse(validSpec);
    const segments = pinnedSegmentsOf(parsed, {
      pathScopes: ['packages/web/**'],
      permission: 'edit',
    });
    await expect(JSON.stringify(segments, null, 2)).toMatchFileSnapshot(
      '__snapshots__/taskspec-pinned.json',
    );
  });
});
