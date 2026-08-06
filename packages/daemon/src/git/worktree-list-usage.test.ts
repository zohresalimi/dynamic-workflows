/**
 * KAR-07.2 AC5 — the matcher behind the repo-wide grep
 * (../../test/worktree-list-porcelain.test.ts), unit-tested here on its own so
 * the repo walk can stay a single assertion.
 *
 * Verifies: EPIC-07-S13 scenario 3 · AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { findUnporcelainedWorktreeList } from './worktree-list-usage.ts';

suite('the porcelain -z form is accepted', () => {
  it('finds nothing in a call carrying both flags', () => {
    expect(findUnporcelainedWorktreeList(`run(['worktree', 'list', '--porcelain', '-z'])`)).toEqual(
      [],
    );
  });

  it('finds nothing in a const declaration of the same argv', () => {
    const source = `export const WORKTREE_LIST_ARGS = ['worktree', 'list', '--porcelain', '-z'];`;
    expect(findUnporcelainedWorktreeList(source)).toEqual([]);
  });

  it('accepts double quotes as readily as single ones', () => {
    expect(findUnporcelainedWorktreeList(`run(["worktree", "list", '--porcelain', '-z'])`)).toEqual(
      [],
    );
  });
});

suite('anything short of both flags is a hit', () => {
  it('flags a bare worktree list', () => {
    const found = findUnporcelainedWorktreeList(`await run(['worktree', 'list']);`);

    expect(found).toHaveLength(1);
    expect(found[0]?.missing).toEqual(['--porcelain', '-z']);
    expect(found[0]?.line).toBe(1);
  });

  it('flags --porcelain without -z, which is the one that looks fine', () => {
    const found = findUnporcelainedWorktreeList(`await run(['worktree', 'list', '--porcelain']);`);

    expect(found).toHaveLength(1);
    expect(found[0]?.missing).toEqual(['-z']);
  });

  it('flags -z without --porcelain', () => {
    expect(findUnporcelainedWorktreeList(`run(['worktree', 'list', '-z'])`)[0]?.missing).toEqual([
      '--porcelain',
    ]);
  });

  it('does not let the next command’s flags cover for this one', () => {
    const source = [
      `await run(['worktree', 'list']);`,
      `await run(['status', '--porcelain', '-z']);`,
    ].join('\n');

    expect(findUnporcelainedWorktreeList(source)).toHaveLength(1);
  });

  it('reports the line so the failure is actionable', () => {
    const source = ['// a comment', '', `run(['worktree', 'list']);`].join('\n');

    expect(findUnporcelainedWorktreeList(source)[0]?.line).toBe(3);
  });

  it('finds every offender, not just the first', () => {
    const source = [`run(['worktree', 'list']);`, `run(['worktree', 'list', '--porcelain']);`].join(
      '\n',
    );

    expect(findUnporcelainedWorktreeList(source)).toHaveLength(2);
  });
});

suite('prose about worktree list is not an argv', () => {
  it('ignores the words in a comment', () => {
    expect(
      findUnporcelainedWorktreeList('// refreshed from git worktree list --porcelain'),
    ).toEqual([]);
  });
});
