/**
 * KAR-07.1 — the git version floor (docs/09-workspace-and-safety.md §1.2).
 *
 * `git merge-tree --write-tree` — the entire conflict-detection design (D14)
 * — does not exist below 2.38, so a daemon below that floor must refuse to
 * start a run outright, not warn and hope. `worktree list --porcelain -z`
 * is not guaranteed stable before 2.45, so that band is a warning only.
 *
 * This module holds the policy and the pure parsing/classification.
 * `deflow doctor` (EPIC-18, KAR-18.4) is the CLI surface that will call
 * `checkGitVersion`; `assertGitVersionSupported` is what a run-start path
 * throws through ahead of that command existing (AC6).
 */
import { runGit } from './run-git.ts';

/** `RunGitOptions.env` is a plain `Record<string, string>` (see run-git.ts);
 * `process.env` (and any caller-supplied override of it) carries `undefined`
 * for unset keys, so it is filtered down before being handed to `runGit`. */
function definedEntriesOf(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** The trimmed line `git --version` printed. */
  readonly raw: string;
}

const VERSION_PATTERN = /git version (\d+)\.(\d+)\.(\d+)/;

/** Parses the real `git version X.Y.Z[.suffix]` line. `null` when the output
 * cannot be read at all — a missing binary, a shell error, garbage. */
export function parseGitVersion(output: string): GitVersion | null {
  const match = VERSION_PATTERN.exec(output);
  if (!match) return null;
  const [, major, minor, patch] = match;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    raw: output.trim(),
  };
}

/** Hard floor (docs §1.2): below this, `merge-tree --write-tree` does not
 * exist and DeFlow's entire conflict-detection design is unavailable. */
export const MIN_GIT_VERSION = { major: 2, minor: 38 } as const;

/** Preferred floor: `worktree list --porcelain -z` is only guaranteed
 * stable from here. Below it DeFlow warns rather than refuses. */
export const PREFERRED_GIT_VERSION = { major: 2, minor: 45 } as const;

function atLeast(
  version: GitVersion,
  floor: { readonly major: number; readonly minor: number },
): boolean {
  return (
    version.major > floor.major || (version.major === floor.major && version.minor >= floor.minor)
  );
}

export type GitVersionStatus = 'fail' | 'warn' | 'pass';

export interface GitVersionCheck {
  readonly status: GitVersionStatus;
  readonly message: string;
  readonly version: GitVersion | null;
}

/** The pure classification: given a parsed version (or none), which of the
 * three bands it falls in and why. */
export function classifyGitVersion(version: GitVersion | null): GitVersionCheck {
  if (version === null) {
    return {
      status: 'fail',
      message:
        'Could not determine the installed git version from "git --version" output. ' +
        `DeFlow requires at least git ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor}.`,
      version: null,
    };
  }
  if (!atLeast(version, MIN_GIT_VERSION)) {
    return {
      status: 'fail',
      message:
        `git ${version.major}.${version.minor}.${version.patch} is below the minimum supported ` +
        `version ${MIN_GIT_VERSION.major}.${MIN_GIT_VERSION.minor}: "git merge-tree --write-tree" ` +
        'is missing, and it is the entire conflict-detection design (D14). Upgrade git before ' +
        'starting a run.',
      version,
    };
  }
  if (!atLeast(version, PREFERRED_GIT_VERSION)) {
    return {
      status: 'warn',
      message:
        `git ${version.major}.${version.minor}.${version.patch} predates the preferred version ` +
        `${PREFERRED_GIT_VERSION.major}.${PREFERRED_GIT_VERSION.minor}, where "worktree list ` +
        '--porcelain -z" is only guaranteed stable. DeFlow will proceed, but upgrading is recommended.',
      version,
    };
  }
  return {
    status: 'pass',
    message: `git ${version.major}.${version.minor} meets the preferred version ${PREFERRED_GIT_VERSION.major}.${PREFERRED_GIT_VERSION.minor} floor.`,
    version,
  };
}

/**
 * Runs `git -C <cwd> --version` (through the one spawn chokepoint,
 * ./run-git.ts) and classifies the result. `env`/`cwd` default to the
 * daemon's own, so a test overriding `PATH` with a stub `git` drives the
 * whole check without installing a different git on the machine.
 */
export async function checkGitVersion(
  env: Readonly<Record<string, string | undefined>> = process.env,
  cwd: string = process.cwd(),
): Promise<GitVersionCheck> {
  const result = await runGit(cwd, ['--version'], { env: definedEntriesOf(env) });
  if (result.exitCode !== 0) {
    return {
      status: 'fail',
      message:
        `"git --version" exited ${result.exitCode}: ${result.stderr || result.stdout}`.trim(),
      version: null,
    };
  }
  return classifyGitVersion(parseGitVersion(result.stdout));
}

/** Thrown by `assertGitVersionSupported` below the hard floor (AC6). */
export class GitVersionTooOldError extends Error {
  readonly check: GitVersionCheck;

  constructor(check: GitVersionCheck) {
    super(check.message);
    this.name = 'GitVersionTooOldError';
    this.check = check;
  }
}

/**
 * AC6: below git 2.38, refuse outright — no worktree is created, no run is
 * started. Between 2.38 and 2.45 this resolves with the `warn` check instead
 * of throwing, and the daemon proceeds.
 */
export async function assertGitVersionSupported(
  env?: Readonly<Record<string, string | undefined>>,
  cwd?: string,
): Promise<GitVersionCheck> {
  const check = await checkGitVersion(env, cwd);
  if (check.status === 'fail') throw new GitVersionTooOldError(check);
  return check;
}
