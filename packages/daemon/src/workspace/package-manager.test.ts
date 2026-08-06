/**
 * KAR-07.5 test 3 — lockfile detection, and the ambiguity that is an error
 * (docs/09-workspace-and-safety.md §5.1 Layer 2; EPIC-07-S20).
 *
 * The table is the specification. What the last case is really testing is that
 * nobody wrote a precedence rule: a repository holding both `pnpm-lock.yaml`
 * and `package-lock.json` is a repository whose author does not agree with
 * itself about how to install, and picking one silently produces a worktree
 * whose `node_modules` was built by the manager the project does not use — a
 * failure that surfaces three nodes later as a version skew nobody can explain.
 *
 * Verifies: EPIC-07-S20 · AC3
 */
import { expect, it, describe as suite } from 'vitest';
import { AmbiguousLockfileError, detectPackageManager, LOCKFILES } from './package-manager.ts';

suite('the manager is detected from the lockfile (AC3)', () => {
  const cases = [
    { lockfile: 'pnpm-lock.yaml', manager: 'pnpm', command: 'pnpm install --frozen-lockfile' },
    { lockfile: 'package-lock.json', manager: 'npm', command: 'npm ci' },
    { lockfile: 'yarn.lock', manager: 'yarn', command: 'yarn install --immutable' },
  ] as const;

  for (const { lockfile, manager, command } of cases) {
    it(`${lockfile} → ${command}`, () => {
      const detected = detectPackageManager([lockfile]);

      expect(detected).toEqual({ manager, lockfile, command });
    });
  }

  it('covers every lockfile the module knows about, so the table cannot grow untested', () => {
    expect(LOCKFILES.map((entry) => entry.lockfile)).toEqual(cases.map((c) => c.lockfile));
  });

  it('is null when the repository has no lockfile at all — not an error', () => {
    // A repository with no lockfile is a repository with no install step, and
    // there are plenty of them. Only `workspace.setup` speaks for those.
    expect(detectPackageManager([])).toBeNull();
    expect(detectPackageManager(['Cargo.lock', 'go.sum'])).toBeNull();
  });

  it('ignores files that merely look like a lockfile', () => {
    expect(detectPackageManager(['pnpm-lock.yaml.bak', 'yarn.lock.orig'])).toBeNull();
  });
});

suite('two lockfiles is a hard error naming both (AC3)', () => {
  it('throws AmbiguousLockfileError rather than choosing', () => {
    expect(() => detectPackageManager(['package-lock.json', 'pnpm-lock.yaml'])).toThrow(
      AmbiguousLockfileError,
    );
  });

  it('names every lockfile it found, in the module order, on the error and in the message', () => {
    let thrown: AmbiguousLockfileError | undefined;
    try {
      detectPackageManager(['yarn.lock', 'package-lock.json', 'pnpm-lock.yaml']);
    } catch (error) {
      thrown = error as AmbiguousLockfileError;
    }

    expect(thrown?.lockfiles).toEqual(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock']);
    expect(thrown?.message).toContain('pnpm-lock.yaml');
    expect(thrown?.message).toContain('package-lock.json');
    expect(thrown?.message).toContain('yarn.lock');
  });

  it('does not resolve the ambiguity by returning the first entry of the table', () => {
    // The red this guards: `LOCKFILES.find(...)` with no count check reads as
    // "pnpm wins", which is a precedence rule spelled as an implementation
    // detail rather than a decision anyone made.
    expect(() => detectPackageManager(['pnpm-lock.yaml', 'yarn.lock'])).toThrow(
      AmbiguousLockfileError,
    );
  });
});
