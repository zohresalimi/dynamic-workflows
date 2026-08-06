/**
 * KAR-07.4 — the salvage argv, checked where it is cheap to check
 * (docs/09-workspace-and-safety.md §4.4).
 *
 * The sequence itself is an integration concern and lives in
 * ../../test/integration/worktree-salvage.test.ts against real git. What is
 * unit-checkable is the shape of each command, and the two properties the
 * story would silently lose if a future edit got them wrong: `add -A` rather
 * than `add -u` (the untracked file is the whole point), and **one** `--force`
 * rather than two (the second overrides the lock, which only the reaper may do).
 *
 * Verifies: EPIC-07-S17 · AC2, AC4
 */
import { expect, it, describe as suite } from 'vitest';
import {
  SALVAGE_COMMIT_SUBJECT,
  salvageAddArgs,
  salvageBranchArgs,
  salvageCommitArgs,
  salvagedRemoveArgs,
} from './worktree-salvage.ts';

const OID = 'a'.repeat(40);

suite('§4.4 step 2: stage everything, commit under the pinned subject', () => {
  it('stages with -A, so untracked files are included', () => {
    expect(salvageAddArgs()).toEqual(['add', '-A']);
    // -u stages modifications to tracked files only, which is precisely the
    // half a blind --force would not have destroyed anyway.
    expect(salvageAddArgs()).not.toContain('-u');
  });

  it('commits with the subject §4.4 names, verbatim', () => {
    expect(SALVAGE_COMMIT_SUBJECT).toBe('DeFlow: WIP salvage');
    expect(salvageCommitArgs()).toEqual(['commit', '-m', 'DeFlow: WIP salvage']);
  });
});

suite('AC6: the detached checkout’s throwaway branch is created at the commit', () => {
  it('uses git branch with a -- separator before the generated name', () => {
    expect(salvageBranchArgs('DeFlow/salvage/r1__n2', OID)).toEqual([
      'branch',
      '--',
      'DeFlow/salvage/r1__n2',
      OID,
    ]);
  });

  it('never checks the branch out, so a worktree about to be deleted is not disturbed', () => {
    const argv = salvageBranchArgs('DeFlow/salvage/r1__n2', OID);

    expect(argv).not.toContain('checkout');
    expect(argv).not.toContain('switch');
    expect(argv).not.toContain('-b');
  });
});

suite('§4.4 step 3: one force, never two', () => {
  it('is exactly "worktree remove --force <path>"', () => {
    expect(salvagedRemoveArgs('/tmp/wt')).toEqual(['worktree', 'remove', '--force', '/tmp/wt']);
  });

  it('does not carry the second force, which would override the lock as well', () => {
    const argv = salvagedRemoveArgs('/tmp/wt');

    expect(argv.filter((arg) => arg === '--force')).toHaveLength(1);
    expect(argv).not.toContain('-f');
    expect(argv.join(' ')).not.toContain('-f -f');
  });

  it('emits exactly one argument of its own beyond the fixed three', () => {
    // Not a claim that a flag-shaped path would be safe — `git worktree remove
    // --force --force <path>` really is the double form, verified on git
    // 2.50.1. It is a claim that this builder adds nothing: the path it is
    // given is `worktreePathFor`'s composed absolute path, never a user string.
    expect(salvagedRemoveArgs('/tmp/wt')).toHaveLength(4);
    expect(salvagedRemoveArgs('/tmp/wt').at(-1)).toBe('/tmp/wt');
  });
});
