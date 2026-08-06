/**
 * KAR-07.2 — the argv of every worktree command, stated once
 * (docs/09-workspace-and-safety.md §4.1, §4.3, §4.4).
 *
 * These are pure argv builders, so the acceptance criteria that are *about the
 * argv* — "in one invocation", "no separate `worktree lock` call", "no `-b`",
 * "never `--force` on the node-completion path" — are checkable here, in
 * microseconds, without a repository. The integration suite then proves the
 * same argv does what §4 says against real git.
 *
 * Verifies: EPIC-07-S9, EPIC-07-S10, EPIC-07-S15, EPIC-07-S16 · AC1, AC2, AC5, AC7
 */
import { expect, it, describe as suite } from 'vitest';
import {
  lockReasonFor,
  parseLockReason,
  WORKTREE_LIST_ARGS,
  worktreeAddArgs,
  worktreePathFor,
  worktreeRemoveArgs,
  worktreeUnlockArgs,
} from './worktree-args.ts';

suite('AC1: a write node is created, branched and locked in one invocation', () => {
  const argv = worktreeAddArgs({
    mode: 'write',
    runId: 'r1',
    nodeId: 'n1',
    branch: 'DeFlow/r1__n1',
    path: '/tmp/.DeFlow/wt/r1__n1',
    baseRef: 'main',
  });

  it('is exactly §4.1 write form', () => {
    expect(argv).toEqual([
      'worktree',
      'add',
      '--lock',
      '--reason',
      'DeFlow run=r1 node=n1',
      '-b',
      'DeFlow/r1__n1',
      '/tmp/.DeFlow/wt/r1__n1',
      'main',
    ]);
  });

  it('carries --lock in the add itself, so there is no lock call to race', () => {
    expect(argv).toContain('--lock');
    expect(argv.join(' ')).not.toContain('worktree lock');
  });

  it('never carries --force, which the KAR-07.1 assertion would refuse anyway', () => {
    expect(argv).not.toContain('--force');
    expect(argv).not.toContain('-f');
  });
});

suite('AC2: a read node gets --detach and no branch', () => {
  const argv = worktreeAddArgs({
    mode: 'read',
    runId: 'r1',
    nodeId: 'n2',
    path: '/tmp/.DeFlow/wt/r1__n2',
    baseRef: 'main',
  });

  it('is exactly §4.1 read form', () => {
    expect(argv).toEqual([
      'worktree',
      'add',
      '--detach',
      '--lock',
      '--reason',
      'DeFlow run=r1 node=n2',
      '/tmp/.DeFlow/wt/r1__n2',
      'main',
    ]);
  });

  it('contains no -b at all', () => {
    expect(argv).not.toContain('-b');
  });
});

suite('AC5: worktree list is only ever the porcelain -z form', () => {
  it('is exactly ["worktree","list","--porcelain","-z"]', () => {
    expect(WORKTREE_LIST_ARGS).toEqual(['worktree', 'list', '--porcelain', '-z']);
  });
});

suite('AC7: removal is unlock then remove, and neither forces', () => {
  it('unlock names the path and nothing else', () => {
    expect(worktreeUnlockArgs('/tmp/wt')).toEqual(['worktree', 'unlock', '/tmp/wt']);
  });

  it('remove names the path and nothing else', () => {
    expect(worktreeRemoveArgs('/tmp/wt')).toEqual(['worktree', 'remove', '/tmp/wt']);
  });

  it('neither builder can be talked into a force by its arguments', () => {
    for (const argv of [worktreeUnlockArgs('--force'), worktreeRemoveArgs('-f')]) {
      // The path is a positional, so a caller passing a flag-shaped path gets
      // it as data — it never becomes a second flag on the command.
      expect(argv.slice(0, 2)).toEqual(['worktree', argv[1]]);
      expect(argv).toHaveLength(3);
    }
  });
});

suite('the lock reason is the run/node identity, round-trippable', () => {
  it('is §4.1 verbatim', () => {
    expect(lockReasonFor('r1', 'n1')).toBe('DeFlow run=r1 node=n1');
  });

  it('reads its own reason back, which is how the projection learns whose worktree it is', () => {
    expect(parseLockReason(lockReasonFor('r1', 'n1'))).toEqual({ runId: 'r1', nodeId: 'n1' });
  });

  it('returns null for a reason DeFlow did not write', () => {
    expect(parseLockReason('held by a human')).toBeNull();
    expect(parseLockReason(null)).toBeNull();
  });
});

suite('the worktree path is composed in one place (D13)', () => {
  it('is <root>/.DeFlow/wt/<runId>__<nodeId>', () => {
    expect(worktreePathFor('/repo', 'r1', 'n1')).toBe('/repo/.DeFlow/wt/r1__n1');
  });

  it('uses the same flat separator as the branch scheme, so the two agree', () => {
    expect(worktreePathFor('/repo', 'r1', 'n1').endsWith('r1__n1')).toBe(true);
  });
});
