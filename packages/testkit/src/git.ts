/**
 * The one place a `git` child process is started (docs/14-testing-strategy.md §6).
 *
 * Real `git`, never a library: `isomorphic-git@1.40.0` has no worktree support
 * at all — its full export list was enumerated at runtime and there is no
 * `worktree*` function — and `simple-git@3.36.0` has no worktree API either,
 * while worktrees are F5.1. Verified 2026-08-02.
 *
 * Real `git`, but **hermetically**: without an isolated environment the
 * developer's own ~/.gitconfig (`init.defaultBranch`, `commit.gpgsign`,
 * aliases, `core.hooksPath`) silently changes test outcomes, which is the
 * classic "passes locally, fails in CI" and its equally confusing inverse.
 * `test/testing-hygiene.test.ts` scans this package for any git invocation that
 * does not pass GIT_ENV.
 */
import { execa } from 'execa';

export const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@x',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@x',
  // Dates too, or every commit id in a snapshot is a different one.
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
} as const;

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The inherited environment with every `GIT_*` variable stripped out, so that a
 * `GIT_DIR`, `GIT_INDEX_FILE` or `GIT_CONFIG_*` exported by whatever shell
 * launched vitest cannot reach the child. Everything else — `PATH` above all —
 * is kept, because `git` needs it.
 */
function environmentWithoutGitVariables(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
}

/** Runs `git` in `cwd` with the hermetic environment. Never throws. */
export async function tryGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  const result = await execa('git', args, {
    cwd,
    env: { ...environmentWithoutGitVariables(), ...GIT_ENV },
    extendEnv: false,
    reject: false,
    stripFinalNewline: true,
  });
  return {
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Runs `git` in `cwd` with the hermetic environment, throwing on failure. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await tryGit(cwd, args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${result.exitCode}\n${result.stderr}`);
  }
  return result.stdout;
}
