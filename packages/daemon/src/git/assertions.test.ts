/**
 * KAR-07.1 — the two forbidden-argument assertions, as pure functions over
 * `argv` (docs/09-workspace-and-safety.md §3.3, §10.6).
 *
 * Both run before any process is spawned, which is exactly what makes them
 * testable with no `git` on PATH at all: a caller in a hurry cannot reach the
 * corruption or the default-branch write that no later check can undo, and
 * that claim is provable here without a subprocess.
 *
 * Verifies: EPIC-07-S2, EPIC-07-S4 · KAR-07.1 test plan rows 1-3
 */
import { expect, it, describe as suite } from 'vitest';
import {
  assertNoForcedWorktreeAdd,
  assertNotDefaultBranchWrite,
  isDefaultBranchWriteShaped,
} from './assertions.ts';

const FORCE_MESSAGE = 'worktree add --force is forbidden: it creates two worktrees on one branch';

suite('assertNoForcedWorktreeAdd (§3.3, test plan row 1)', () => {
  it.each([
    ['long flag first', ['worktree', 'add', '--force', '/tmp/wt', 'feature']],
    ['short flag', ['worktree', 'add', '-f', '/tmp/wt', 'feature']],
    ['flag after the path', ['worktree', 'add', '/tmp/wt', '--force', 'feature']],
    ['mixed with other flags', ['worktree', 'add', '--lock', '-f', '-b', 'x', '/tmp/wt', 'main']],
  ])('throws with the exact message: %s', (_label, args) => {
    expect(() => assertNoForcedWorktreeAdd(args)).toThrowError(FORCE_MESSAGE);
  });

  // Test plan row 2.
  it('does not throw for "worktree remove --force" — the assertion is scoped to add', () => {
    expect(() =>
      assertNoForcedWorktreeAdd(['worktree', 'remove', '--force', '/tmp/wt']),
    ).not.toThrow();
  });

  it('does not throw for an ordinary worktree add', () => {
    expect(() =>
      assertNoForcedWorktreeAdd(['worktree', 'add', '-b', 'DeFlow/r1__n1', '/tmp/wt', 'main']),
    ).not.toThrow();
  });

  it('does not throw for unrelated commands', () => {
    expect(() => assertNoForcedWorktreeAdd(['status', '--porcelain=v2', '-z'])).not.toThrow();
  });
});

suite('isDefaultBranchWriteShaped', () => {
  it.each([['push'], ['branch'], ['update-ref']])('is true for "%s"', (command) => {
    expect(isDefaultBranchWriteShaped([command, 'x'])).toBe(true);
  });

  it.each([['commit'], ['status'], ['worktree'], ['merge-tree']])(
    'is false for "%s"',
    (command) => {
      expect(isDefaultBranchWriteShaped([command, 'x'])).toBe(false);
    },
  );
});

// Test plan row 3 — EPIC-07-S4's refusal-set table, verbatim.
const DEFAULT_BRANCH = 'main';

const REFUSAL_TABLE: ReadonlyArray<readonly [string, readonly string[], 'refused' | 'allowed']> = [
  ['push to the local default branch', ['push', 'origin', 'main'], 'refused'],
  ['push to origin HEAD via a colon refspec', ['push', 'origin', 'HEAD:main'], 'refused'],
  ['push --force to a DeFlow ref', ['push', '--force', 'origin', 'DeFlow/r1__n1'], 'refused'],
  ['push -f to a DeFlow ref', ['push', '-f', 'origin', 'DeFlow/r1__n1'], 'refused'],
  ['branch -f on the default branch', ['branch', '-f', 'main', 'DeFlow/r1__n1'], 'refused'],
  [
    'update-ref targeting the default branch',
    ['update-ref', 'refs/heads/main', '<oid>'],
    'refused',
  ],
  [
    'push --force-with-lease on a DeFlow ref',
    ['push', '--force-with-lease', 'origin', 'DeFlow/r1__n1'],
    'allowed',
  ],
  ['push to a DeFlow integration branch', ['push', 'origin', 'DeFlow/int/r1'], 'allowed'],
  ['an ordinary WIP salvage commit', ['commit', '-m', 'DeFlow: WIP salvage'], 'allowed'],
];

suite('assertNotDefaultBranchWrite (§10.6, test plan row 3)', () => {
  it.each(REFUSAL_TABLE)('%s → %s', (_label, args, outcome) => {
    if (outcome === 'refused') {
      expect(() => assertNotDefaultBranchWrite(args, DEFAULT_BRANCH)).toThrow();
    } else {
      expect(() => assertNotDefaultBranchWrite(args, DEFAULT_BRANCH)).not.toThrow();
    }
  });

  it('is a property of the repository, not a hardcoded "main" (the last scenario in S4)', () => {
    // origin/HEAD points at "trunk" here.
    expect(() => assertNotDefaultBranchWrite(['push', 'origin', 'trunk'], 'trunk')).toThrow();
    expect(() => assertNotDefaultBranchWrite(['push', 'origin', 'main'], 'trunk')).not.toThrow();
  });

  it('bare --force is refused even without a recognizable target', () => {
    expect(() =>
      assertNotDefaultBranchWrite(['push', '--force', 'origin'], DEFAULT_BRANCH),
    ).toThrow();
  });
});
