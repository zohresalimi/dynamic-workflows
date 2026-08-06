/**
 * KAR-07.1 — the git version floor's pure logic (docs/09-workspace-and-safety.md
 * §1.2): parsing `git --version` output and classifying it against the two
 * bands. The subprocess half (a stub `git` on PATH) is
 * packages/daemon/test/integration/git-wrapper.test.ts, test plan row 7.
 *
 * Verifies: EPIC-07-S1 (version-floor scenario outline)
 */
import { expect, it, describe as suite } from 'vitest';
import { classifyGitVersion, parseGitVersion } from './version.ts';

suite('parseGitVersion', () => {
  it('reads major.minor.patch out of the real "git version X.Y.Z" line', () => {
    expect(parseGitVersion('git version 2.43.0\n')).toEqual({
      major: 2,
      minor: 43,
      patch: 0,
      raw: 'git version 2.43.0',
    });
  });

  it('tolerates a platform suffix (e.g. "git version 2.43.0.windows.1")', () => {
    expect(parseGitVersion('git version 2.43.0.windows.1')).toMatchObject({
      major: 2,
      minor: 43,
      patch: 0,
    });
  });

  it('returns null for unparsable output', () => {
    expect(parseGitVersion('command not found: git')).toBeNull();
  });
});

// EPIC-07-S1's "The git version floor" scenario outline, verbatim.
const VERSION_OUTLINE: ReadonlyArray<
  readonly [version: string, outcome: 'fail' | 'warn' | 'pass', mentions: string]
> = [
  ['2.37.1', 'fail', 'merge-tree --write-tree'],
  ['2.38.0', 'warn', 'worktree list --porcelain'],
  ['2.43.0', 'warn', 'worktree list --porcelain'],
  ['2.45.0', 'pass', 'git 2.45'],
];

suite('classifyGitVersion (EPIC-07-S1 version-floor outline)', () => {
  it.each(VERSION_OUTLINE)('git %s → %s, mentioning %j', (version, outcome, mentions) => {
    const parsed = parseGitVersion(`git version ${version}`);
    const check = classifyGitVersion(parsed);
    expect(check.status).toBe(outcome);
    expect(check.message).toContain(mentions);
  });

  it('fails closed when the version could not be parsed at all', () => {
    expect(classifyGitVersion(null).status).toBe('fail');
  });
});
