/**
 * KAR-07.1 — default branch resolution (docs/09-workspace-and-safety.md
 * §10.6): "resolved from `origin/HEAD` when present and from the `HEAD`
 * symref when there is no remote". Never a hardcoded "main" — the last
 * scenario of EPIC-07-S4 exists specifically to catch that.
 */
import { type RunGitOptions, runGit } from './run-git.ts';

const ORIGIN_HEAD_REF = 'refs/remotes/origin/HEAD';
const ORIGIN_PREFIX = 'origin/';

function withoutOriginPrefix(ref: string): string {
  return ref.startsWith(ORIGIN_PREFIX) ? ref.slice(ORIGIN_PREFIX.length) : ref;
}

/** Thrown when neither `origin/HEAD` nor a `HEAD` symref could be read —
 * only possible on a repository with no commits and no remote at all. */
export class DefaultBranchUnresolvedError extends Error {
  constructor(repoRoot: string) {
    super(
      `Could not resolve the default branch of "${repoRoot}": no origin/HEAD symref and no HEAD ` +
        'symref either.',
    );
    this.name = 'DefaultBranchUnresolvedError';
  }
}

/**
 * The uncached resolution: `git symbolic-ref --short refs/remotes/origin/HEAD`
 * when a remote is configured, falling back to
 * `git symbolic-ref --short HEAD` otherwise. Spawns through `runGit`, the
 * one chokepoint — callers that want the "at most once per repository per
 * run" guarantee (AC5) memoize this themselves (see `Git.resolveDefaultBranch`).
 */
export async function resolveDefaultBranchUncached(
  repoRoot: string,
  options: RunGitOptions = {},
): Promise<string> {
  const originHead = await runGit(
    repoRoot,
    ['symbolic-ref', '-q', '--short', ORIGIN_HEAD_REF],
    options,
  );
  if (originHead.exitCode === 0 && originHead.stdout.trim() !== '') {
    return withoutOriginPrefix(originHead.stdout.trim());
  }

  const headSymref = await runGit(repoRoot, ['symbolic-ref', '-q', '--short', 'HEAD'], options);
  if (headSymref.exitCode === 0 && headSymref.stdout.trim() !== '') {
    return headSymref.stdout.trim();
  }

  throw new DefaultBranchUnresolvedError(repoRoot);
}
