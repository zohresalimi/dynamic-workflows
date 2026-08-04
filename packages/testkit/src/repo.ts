/**
 * `makeRepo({ branches, files, conflicts })` — a real git repository in a real
 * directory, built with the hermetic environment of ./git.ts.
 *
 * EPIC-07's whole worktree lifecycle is tested against real `git`, so this
 * fixture is what makes those results mean anything: `git init -b main` must
 * produce `main` on a machine whose global config says `trunk`, and a commit
 * must succeed on a machine whose global config demands a signing key.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type GitResult, git, tryGit } from './git.ts';

export interface MakeRepoOptions {
  /** Directory to initialise. Created if missing; usually the `tmp` fixture. */
  readonly dir: string;
  /** Repo-relative path to contents, committed on `main` before any branching. */
  readonly files?: Readonly<Record<string, string>>;
  /** Branches to create off `main`. `main` itself is always there. */
  readonly branches?: readonly string[];
  /**
   * Repo-relative paths that every branch in `branches` rewrites differently,
   * so that merging any two of those branches conflicts on them for real.
   */
  readonly conflicts?: readonly string[];
}

export interface Repo {
  readonly dir: string;
  /** Runs git in the repo, hermetically, throwing on a non-zero exit. */
  git(...args: string[]): Promise<string>;
  /** Runs git in the repo, hermetically, returning the exit code instead. */
  tryGit(...args: string[]): Promise<GitResult>;
  currentBranch(): Promise<string>;
  /** Local branch names, sorted. */
  branches(): Promise<string[]>;
}

const DEFAULT_FILES = { 'README.md': '# fixture\n' } as const;

async function writeAll(dir: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(dir, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

export async function makeRepo(options: MakeRepoOptions): Promise<Repo> {
  const { dir, branches = [], conflicts = [] } = options;
  const files = options.files ?? DEFAULT_FILES;

  await mkdir(dir, { recursive: true });
  // -b main explicitly: init.defaultBranch is exactly the setting a developer's
  // global config is most likely to have changed, and /dev/null'ing the config
  // only removes their value — it does not choose ours.
  await git(dir, ['init', '-b', 'main']);
  await writeAll(dir, files);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', 'DeFlow test fixture: initial commit']);

  for (const branch of branches) {
    await git(dir, ['checkout', '-b', branch, 'main']);
    if (conflicts.length > 0) {
      await writeAll(
        dir,
        Object.fromEntries(conflicts.map((path) => [path, `written by ${branch}\n`])),
      );
      await git(dir, ['add', '-A']);
      await git(dir, [
        'commit',
        '-m',
        `DeFlow test fixture: ${branch} rewrites the conflict paths`,
      ]);
    }
  }
  if (branches.length > 0) await git(dir, ['checkout', 'main']);

  return {
    dir,
    git: (...args) => git(dir, args),
    tryGit: (...args) => tryGit(dir, args),
    currentBranch: () => git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    branches: async () =>
      (await git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
        .split('\n')
        .filter((line) => line !== '')
        .sort(),
  };
}
