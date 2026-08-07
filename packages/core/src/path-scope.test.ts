/**
 * KAR-08.7 — the glob-scope matcher, path normalization and the plan-time
 * empty-scope check (docs/09-workspace-and-safety.md §6.3, §8.2).
 *
 * Test plan rows 1, 2 and 5 — row 5 is a cross-check: KAR-07.6's
 * `scopeCollisions` already admits two nodes both scoped to the same glob,
 * which is AC4, and this file does not re-implement it, it just proves the
 * claim next to the rest of KAR-08.7's suite.
 *
 * Verifies: KAR-08.7 test plan rows 1, 2, 5 · AC1, AC4, AC6
 */
import { expect, it, describe as suite } from 'vitest';
import {
  type EmptyWriteScope,
  emptyWriteScopes,
  pathScopeMatches,
  relativeToWorktree,
} from './path-scope.ts';
import { type PlanGraph, PlanGraphSchema } from './plan-graph.ts';
import { scopeCollisions } from './scope-collision.ts';

interface NodeShape {
  readonly id: string;
  readonly write: readonly string[];
  readonly permission?: 'read' | 'worktree' | 'worktree+net' | 'full';
}

function agent(shape: NodeShape): Record<string, unknown> {
  return {
    id: shape.id,
    title: shape.id,
    type: 'agent',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    permission: shape.permission ?? 'worktree',
    pathScopes: { write: [...shape.write] },
    returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 500 },
    brief: `Do ${shape.id}.`,
    provider: { prefer: ['claude-code'], requires: [] },
    resume: 'native-if-available',
  };
}

function planOf(shapes: readonly NodeShape[]): PlanGraph {
  return PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: 'run_20260802T141133Z_9f2a1c',
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'a'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-02T14:11:33.000Z',
    nodes: shapes.map(agent),
    edges: [],
  });
}

suite('the glob-scope matcher (test plan row 1)', () => {
  it.each([
    [['src/**'], 'src/a.ts', true],
    [['src/**'], 'src/nested/deep/b.ts', true],
    [['src/**'], 'docs/a.ts', false],
    [['src/**'], 'src', false],
    [['src/**', '!src/generated/**'], 'src/generated/x.ts', false],
    [['src/**', '!src/generated/**'], 'src/a.ts', true],
    // A bare filename — no `/` in the pattern — matches at any depth, the
    // same reading `.gitignore` gives it.
    [['README.md'], 'README.md', true],
    [['README.md'], 'docs/README.md', true],
    [['README.md'], 'README.md.bak', false],
    // A trailing-slash directory matches everything under it, and nothing
    // that merely shares its prefix.
    [['dist/'], 'dist/bundle.js', true],
    [['dist/'], 'dist/nested/x.js', true],
    [['dist/'], 'distfoo/x.js', false],
    [['dist/'], 'dist', false],
    // No declared scope at all matches nothing — an empty pathScope is a
    // plan-validation failure (AC1), never silently "anything goes".
    [[], 'src/a.ts', false],
  ] as const)('%j against %j → %s', (scopes, path, expected) => {
    expect(pathScopeMatches(scopes, path)).toBe(expected);
  });

  it('lets a later pattern override an earlier one, in declaration order', () => {
    // gitignore semantics: the last matching pattern wins, so re-including a
    // file under an excluded directory is expressible.
    expect(
      pathScopeMatches(
        ['src/**', '!src/generated/**', 'src/generated/keep.ts'],
        'src/generated/keep.ts',
      ),
    ).toBe(true);
  });
});

suite('path normalization matches KAR-08.2s containment check (test plan row 2, AC6)', () => {
  const WT = '/tmp/DeFlow-scope/wt';

  it.each([
    ['./src/a.ts', 'src/a.ts'],
    ['src/a.ts', 'src/a.ts'],
    [`${WT}/src/a.ts`, 'src/a.ts'],
    [`${WT}/./src/a.ts`, 'src/a.ts'],
    [WT, ''],
    ['.', ''],
  ] as const)('%j normalizes to %j', (input, expected) => {
    expect(relativeToWorktree(WT, input)).toBe(expected);
  });

  it('does not double the slash when the worktree resolves to the filesystem root', () => {
    // The same edge case ./scope.ts's pathIsInside special-cases: `${root}/`
    // would otherwise be `//`, which no resolved path starts with.
    expect(relativeToWorktree('/', '/src/a.ts')).toBe('src/a.ts');
    expect(relativeToWorktree('', '/src/a.ts')).toBe('src/a.ts');
  });

  it('three spellings of one path are one path once normalized and matched', () => {
    const scopes = ['src/**'];
    for (const spelling of ['./src/a.ts', 'src/a.ts', `${WT}/src/a.ts`]) {
      expect(pathScopeMatches(scopes, relativeToWorktree(WT, spelling))).toBe(true);
    }
  });
});

suite('an empty declared write scope fails plan validation (AC1)', () => {
  it('flags a write node with no declared scope', () => {
    const findings: EmptyWriteScope[] = emptyWriteScopes(planOf([{ id: 'n1', write: [] }]));
    expect(findings).toEqual([{ node: 'n1' }]);
  });

  it('does not flag a write node that declared something', () => {
    expect(emptyWriteScopes(planOf([{ id: 'n1', write: ['src/**'] }]))).toEqual([]);
  });

  it('does not flag a read node, which cannot write regardless of what it declares', () => {
    expect(emptyWriteScopes(planOf([{ id: 'n1', write: [], permission: 'read' }]))).toEqual([]);
  });

  it('reports every offending node, in plan order', () => {
    const findings = emptyWriteScopes(
      planOf([
        { id: 'n1', write: [] },
        { id: 'n2', write: ['src/**'] },
        { id: 'n3', write: [] },
      ]),
    );
    expect(findings).toEqual([{ node: 'n1' }, { node: 'n3' }]);
  });
});

suite('AC4 is already satisfied by KAR-07.6s scopeCollisions (test plan row 5)', () => {
  it('admits two concurrent write nodes that both declare the same glob', () => {
    expect(
      scopeCollisions(
        planOf([
          { id: 'n1', write: ['src/**'] },
          { id: 'n2', write: ['src/**'] },
        ]),
      ),
    ).toEqual([]);
  });
});
