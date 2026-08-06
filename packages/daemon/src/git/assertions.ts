/**
 * KAR-07.1 — the two forbidden-argument assertions, run before every spawn
 * (docs/09-workspace-and-safety.md §3.3, §10.6).
 *
 * Both are pure and synchronous over `argv` alone: no repository read, no
 * filesystem access, no process. That is what lets `Git.run()` (./git.ts)
 * call them ahead of the one `execa` chokepoint in ./run-git.ts and make "a
 * caller in a hurry cannot reach the corruption or the default-branch write"
 * a provable fact rather than a convention.
 */

/**
 * §3.3: `git worktree add --force` bypasses the same-branch check and
 * creates two worktrees on one branch — verified corruption, not a
 * hypothetical. `--force` is permitted only on `worktree remove`, which is
 * why this checks `args[1] === 'add'` specifically rather than any
 * `worktree` subcommand.
 */
export function assertNoForcedWorktreeAdd(args: readonly string[]): void {
  if (
    args[0] === 'worktree' &&
    args[1] === 'add' &&
    (args.includes('--force') || args.includes('-f'))
  ) {
    throw new Error('worktree add --force is forbidden: it creates two worktrees on one branch');
  }
}

const HEAD_REF_PREFIX = 'refs/heads/';
const DEFLOW_REF_PREFIX = 'DeFlow/';

/** `refs/heads/main` → `main`; anything else passes through unchanged. */
function shortRef(ref: string): string {
  return ref.startsWith(HEAD_REF_PREFIX) ? ref.slice(HEAD_REF_PREFIX.length) : ref;
}

/** The destination side of a push refspec: `HEAD:main` → `main`; a bare
 * `main` → `main`. */
function pushTarget(refspec: string): string {
  const colon = refspec.indexOf(':');
  return shortRef(colon === -1 ? refspec : refspec.slice(colon + 1));
}

function assertPushAllowed(rest: readonly string[], defaultBranch: string): void {
  const hasForce = rest.includes('--force') || rest.includes('-f');
  const hasForceWithLease = rest.some(
    (arg) => arg === '--force-with-lease' || arg.startsWith('--force-with-lease='),
  );
  const positionals = rest.filter((arg) => !arg.startsWith('-'));
  // `git push <remote> <refspec>`: refspec is the second positional when a
  // remote was named, or the first when it was not (`git push <refspec>`).
  const refspec = positionals[1] ?? positionals[0];
  const target = refspec === undefined ? undefined : pushTarget(refspec);

  // Bare --force/-f is refused unconditionally — never mapped to success,
  // even for DeFlow's own ref. --force-with-lease is the only accepted way
  // to force-push, and only ever to a ref DeFlow itself owns.
  if (hasForce) {
    throw new Error(
      'git push --force/-f is forbidden: use --force-with-lease on a DeFlow/ ref instead (F5.5)',
    );
  }
  if (hasForceWithLease) {
    if (target !== undefined && target.startsWith(DEFLOW_REF_PREFIX)) return;
    throw new Error(
      `git push --force-with-lease to "${target ?? '(unresolvable target)'}" is forbidden: ` +
        'only DeFlow/ refs may be force-pushed (F5.5)',
    );
  }
  if (target === defaultBranch || target === 'HEAD') {
    throw new Error(`git push to the default branch "${defaultBranch}" is forbidden (F5.5)`);
  }
}

function assertBranchAllowed(rest: readonly string[], defaultBranch: string): void {
  const hasForce = rest.includes('-f') || rest.includes('--force');
  if (!hasForce) return;
  const target = rest.find((arg) => !arg.startsWith('-'));
  if (target === defaultBranch) {
    throw new Error(
      `git branch -f "${defaultBranch}" is forbidden: it force-moves the default branch (F5.5)`,
    );
  }
}

function assertUpdateRefAllowed(rest: readonly string[], defaultBranch: string): void {
  const ref = rest[0];
  if (ref !== undefined && shortRef(ref) === defaultBranch) {
    throw new Error(
      `git update-ref targeting the default branch "${defaultBranch}" is forbidden (F5.5)`,
    );
  }
}

/** Whether `args` is one of the three command shapes §10.6 governs — the
 * ones that need the resolved default branch to be judged at all. Anything
 * else (`commit`, `status`, `merge-tree`, …) is always allowed by this
 * assertion, whatever the default branch is. */
export function isDefaultBranchWriteShaped(args: readonly string[]): boolean {
  return args[0] === 'push' || args[0] === 'branch' || args[0] === 'update-ref';
}

/**
 * §10.6: never write to the default branch, mechanically. `defaultBranch` is
 * the caller's resolved value (see ./default-branch.ts) — this function
 * never hardcodes "main".
 */
export function assertNotDefaultBranchWrite(args: readonly string[], defaultBranch: string): void {
  const [command, ...rest] = args;
  if (command === 'push') {
    assertPushAllowed(rest, defaultBranch);
  } else if (command === 'branch') {
    assertBranchAllowed(rest, defaultBranch);
  } else if (command === 'update-ref') {
    assertUpdateRefAllowed(rest, defaultBranch);
  }
}
