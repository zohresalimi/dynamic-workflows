/**
 * KAR-07.5 Layer 2 — which package manager this repository actually uses
 * (docs/09-workspace-and-safety.md §5.1).
 *
 * The lockfile is the answer, and it is the only answer consulted: a
 * `packageManager` field in `package.json` is advisory, a `.npmrc` says
 * nothing about npm-vs-pnpm, and the file that is actually going to be
 * installed *from* is the file whose name decides the command.
 *
 * **Two lockfiles is an error, not a precedence rule.** A repository holding
 * both `pnpm-lock.yaml` and `package-lock.json` is a repository that does not
 * agree with itself, and picking one silently builds every worktree's
 * `node_modules` with the manager the project does not use. That failure does
 * not surface here — it surfaces three nodes later as a version skew nobody
 * can attribute — so the ambiguity is refused at the point where the evidence
 * is still on screen.
 *
 * pnpm is first in the table because §5.1 recommends it, but "first" carries
 * no weight: `detectPackageManager` counts before it chooses.
 *
 * Verifies: EPIC-07-S20 · AC3
 */

/** The three managers DeFlow knows how to install with. */
export type PackageManager = 'pnpm' | 'npm' | 'yarn';

export interface PackageManagerSetup {
  readonly manager: PackageManager;
  readonly lockfile: string;
  /**
   * The install, in its reproducible form in every case — `--frozen-lockfile`,
   * `ci`, `--immutable`. A worktree provisioned with a *resolving* install
   * would let one node's `node_modules` drift from another's while both claim
   * to be the same commit.
   */
  readonly command: string;
}

/** §5.1's table, verbatim and in its order. */
export const LOCKFILES: readonly PackageManagerSetup[] = [
  { manager: 'pnpm', lockfile: 'pnpm-lock.yaml', command: 'pnpm install --frozen-lockfile' },
  { manager: 'npm', lockfile: 'package-lock.json', command: 'npm ci' },
  { manager: 'yarn', lockfile: 'yarn.lock', command: 'yarn install --immutable' },
];

/**
 * More than one lockfile, and therefore no honest default.
 *
 * `lockfiles` is the answer a caller acts on; the message is for the human who
 * has to delete one of them. Both name every file found rather than the first
 * two, because a repository mid-migration often has all three.
 */
export class AmbiguousLockfileError extends Error {
  readonly lockfiles: readonly string[];

  constructor(lockfiles: readonly string[]) {
    super(
      `This repository contains ${lockfiles.length} lockfiles — ${lockfiles.join(', ')} — so ` +
        'there is no honest way to decide how a worktree should install its dependencies. DeFlow ' +
        "will not pick one: building every node's node_modules with the manager the project does " +
        'not use produces a version skew that surfaces much later and reads like a code failure. ' +
        'Delete the lockfiles you do not use, or set workspace.setup in DeFlow.config.ts to the ' +
        'exact install command you want.',
    );
    this.name = 'AmbiguousLockfileError';
    this.lockfiles = lockfiles;
  }
}

/**
 * The manager for a repository root whose entries are `present`, or `null`
 * when there is no lockfile at all.
 *
 * `null` is a normal outcome, not a degraded one: plenty of repositories have
 * no JavaScript dependencies, and the caller simply plans no install step.
 */
export function detectPackageManager(present: readonly string[]): PackageManagerSetup | null {
  const names = new Set(present);
  const found = LOCKFILES.filter((entry) => names.has(entry.lockfile));

  if (found.length > 1) throw new AmbiguousLockfileError(found.map((entry) => entry.lockfile));
  return found[0] ?? null;
}
