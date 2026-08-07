/**
 * KAR-08.7 AC3, AC5, AC6 — the pure half of the completion-time backstop:
 * which changed paths fall outside a node's declared scope, and the
 * `node.scope_warning` payload that produces.
 *
 * `changedPaths` (real `git status`) is proved separately, against a real
 * repository, in ../../test/integration/scope-diff.test.ts — this file is
 * about the decision once the paths are already known, which is what makes
 * it fast enough to run on every save.
 *
 * Verifies: EPIC-08-S30 · AC3, AC5, AC6
 */
import { NodeIdSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { outOfScopePaths, scopeWarningOf } from './scope-diff.ts';

const WT = '/tmp/DeFlow-scope-diff/wt';
const NODE = NodeIdSchema.parse('n1');

suite('outOfScopePaths — AC3, AC6', () => {
  it('is empty when every changed path is in scope', () => {
    expect(outOfScopePaths(WT, ['src/**'], ['src/a.ts', 'src/nested/b.ts'])).toEqual([]);
  });

  it('names exactly the paths that fall outside the declared scope', () => {
    expect(outOfScopePaths(WT, ['src/**'], ['src/a.ts', 'docs/readme.md'])).toEqual([
      'docs/readme.md',
    ]);
  });

  it('is empty for a clean diff, whatever the declared scope is', () => {
    expect(outOfScopePaths(WT, ['src/**'], [])).toEqual([]);
  });

  it('normalizes the same way request-time enforcement does (AC6)', () => {
    // git reports paths already relative to the worktree, but an absolute or
    // `./`-prefixed spelling must agree with the declared scope the same way.
    expect(outOfScopePaths(WT, ['src/**'], [`${WT}/src/a.ts`, './src/b.ts'])).toEqual([]);
  });
});

suite('scopeWarningOf — the node.scope_warning payload, AC3, AC5', () => {
  it('is null when nothing landed outside the declared scope', () => {
    expect(scopeWarningOf(NODE, 0, WT, ['src/**'], ['src/a.ts'])).toBeNull();
  });

  it('records the declared globs and the out-of-scope paths, and nothing else', () => {
    expect(scopeWarningOf(NODE, 2, WT, ['src/**'], ['src/a.ts', 'docs/readme.md'])).toEqual({
      node: NODE,
      attempt: 2,
      declared: ['src/**'],
      paths: ['docs/readme.md'],
    });
  });

  it('accumulates every offending path from one diff, not just the first', () => {
    const warning = scopeWarningOf(
      NODE,
      0,
      WT,
      ['src/**'],
      ['docs/a.md', 'infra/main.tf', 'src/ok.ts'],
    );
    expect(warning?.paths).toEqual(['docs/a.md', 'infra/main.tf']);
  });
});
