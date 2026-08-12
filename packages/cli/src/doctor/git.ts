/**
 * KAR-18.4, category 2 — git (docs/09-workspace-and-safety.md §1.2).
 *
 * Two checks, and the second is the one that matters. `checkGitVersion`
 * (KAR-07.1) reads `git --version` and places it in one of three bands; this
 * module then **executes `merge-tree --write-tree` against a real scratch
 * repository** rather than concluding from the number that it works.
 *
 * EPIC-18-S28's second scenario is the reason: *"a git whose merge-tree is
 * broken"* passes a version check and fails a run. The exercise asserts both
 * halves of the contract DeFlow actually depends on — a clean merge exits 0
 * and a conflicting one exits 1 — because conflict detection reads the *exit
 * code*, and a build that reported conflicts as failures (or failures as
 * conflicts) would corrupt the D14 ground truth in opposite directions.
 *
 * The scratch repository is created under the data directory rather than in
 * `/tmp`: it is the one directory DeFlowd owns and can be told about, the same
 * rule `packages/daemon/src/providers/doctor.ts` follows for probe scratch.
 *
 * Verifies: EPIC-18-S26, EPIC-18-S28 · AC3
 */
import { checkGitVersion, type GitVersionCheck, runGit } from '@DeFlow/daemon';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorCheck } from './report.ts';

/** `<dataDir>/doctor-git/` — where the merge-tree exercise runs. */
export const GIT_SCRATCH_DIR = 'doctor-git';

/**
 * A hermetic git environment for the scratch repository.
 *
 * The operator's own `~/.gitconfig` is deliberately shut out here — and only
 * here. `commit.gpgsign`, `core.hooksPath` or an `init.defaultBranch` alias
 * would each turn this diagnostic into a different, less answerable question,
 * and the exercise is about what the *binary* can do, not about how this user
 * has configured it. Real work goes through the daemon's git wrapper, which
 * keeps their configuration precisely because it is how their repo works.
 */
function scratchEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    PATH: env.PATH ?? '',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'DeFlow doctor',
    GIT_AUTHOR_EMAIL: 'doctor@deflow.invalid',
    GIT_COMMITTER_NAME: 'DeFlow doctor',
    GIT_COMMITTER_EMAIL: 'doctor@deflow.invalid',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
  };
}

/** The version band, with the consequence spelled out in DeFlow's terms. */
function versionCheck(check: GitVersionCheck): DoctorCheck {
  if (check.status === 'fail') {
    return {
      id: 'git.version',
      status: 'fail',
      detail:
        `${check.message} Until git is upgraded, DeFlow cannot schedule any write node: ` +
        '"git merge-tree --write-tree" is how it detects a conflict between two concurrent ' +
        'write nodes before either of them lands, and there is no fallback.',
      data: { version: check.version },
    };
  }
  if (check.status === 'warn') {
    return {
      id: 'git.version',
      status: 'warn',
      detail: check.message,
      data: { version: check.version },
    };
  }
  return {
    id: 'git.version',
    status: 'ok',
    detail: check.message,
    data: { version: check.version },
  };
}

interface Exercise {
  readonly clean: number;
  readonly conflicting: number;
  readonly detail: string;
}

/**
 * Builds a two-branch repository and runs `merge-tree --write-tree` twice.
 *
 * `left` and `right` edit the same line of the same file — a conflict git has
 * to report as exit 1 — while `clean` touches a different file entirely, which
 * has to merge at exit 0.
 */
async function exerciseMergeTree(dir: string, env: NodeJS.ProcessEnv): Promise<Exercise> {
  const gitEnv = scratchEnv(env);
  const git = async (...args: string[]) => runGit(dir, args, { env: gitEnv, timeoutMs: 20_000 });

  await git('init', '--quiet', '--initial-branch', 'base');
  writeFileSync(join(dir, 'shared.txt'), 'base\n');
  await git('add', '-A');
  await git('commit', '--quiet', '-m', 'base');

  await git('checkout', '--quiet', '-b', 'left');
  writeFileSync(join(dir, 'shared.txt'), 'left\n');
  await git('commit', '--quiet', '-a', '-m', 'left');

  await git('checkout', '--quiet', 'base');
  await git('checkout', '--quiet', '-b', 'right');
  writeFileSync(join(dir, 'shared.txt'), 'right\n');
  await git('commit', '--quiet', '-a', '-m', 'right');

  await git('checkout', '--quiet', 'base');
  await git('checkout', '--quiet', '-b', 'elsewhere');
  writeFileSync(join(dir, 'other.txt'), 'elsewhere\n');
  await git('add', '-A');
  await git('commit', '--quiet', '-m', 'elsewhere');

  const clean = await git('merge-tree', '--write-tree', 'left', 'elsewhere');
  const conflicting = await git('merge-tree', '--write-tree', 'left', 'right');

  return {
    clean: clean.exitCode,
    conflicting: conflicting.exitCode,
    detail: conflicting.stderr === '' ? clean.stderr : conflicting.stderr,
  };
}

export interface GitChecksInput {
  /** The repository doctor was run in — what `git --version` is asked from. */
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Where the scratch repository is created and removed. */
  readonly dataDir: string;
}

export async function gitChecks(input: GitChecksInput): Promise<readonly DoctorCheck[]> {
  const version = versionCheck(await checkGitVersion(input.env, input.cwd));

  if (version.status === 'fail') {
    return [
      version,
      {
        id: 'git.merge-tree',
        status: 'fail',
        detail:
          'not attempted: the installed git is below the 2.38 floor, so "merge-tree ' +
          '--write-tree" does not exist to be executed. This is the same failure as above, ' +
          'reported here so the section is not silent about the command it actually depends on.',
      },
    ];
  }

  let scratch: string | null = null;
  try {
    mkdirSync(join(input.dataDir, GIT_SCRATCH_DIR), { recursive: true });
    scratch = mkdtempSync(join(input.dataDir, GIT_SCRATCH_DIR, 'merge-tree-'));
    const result = await exerciseMergeTree(scratch, input.env);

    if (result.clean === 0 && result.conflicting === 1) {
      return [
        version,
        {
          id: 'git.merge-tree',
          status: 'ok',
          detail:
            '"git merge-tree --write-tree" was executed against a scratch repository, not ' +
            'inferred from the version string: a clean merge returned exit 0 and a conflicting ' +
            'merge returned exit 1, which is the conflict ground truth (D14) DeFlow schedules ' +
            'write nodes against.',
          data: { clean: result.clean, conflicting: result.conflicting },
        },
      ];
    }

    return [
      version,
      {
        id: 'git.merge-tree',
        status: 'fail',
        detail:
          '"git merge-tree --write-tree" was executed and did not behave as DeFlow requires: a ' +
          `clean merge exited ${result.clean} (expected 0) and a conflicting merge exited ` +
          `${result.conflicting} (expected 1). ${result.detail} Write nodes cannot be scheduled ` +
          'against a git whose conflict signal cannot be trusted.',
        data: { clean: result.clean, conflicting: result.conflicting },
      },
    ];
  } catch (error) {
    return [
      version,
      {
        id: 'git.merge-tree',
        status: 'fail',
        detail:
          '"git merge-tree --write-tree" could not be executed against a scratch repository: ' +
          `${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  } finally {
    if (scratch !== null) rmSync(scratch, { recursive: true, force: true });
  }
}
