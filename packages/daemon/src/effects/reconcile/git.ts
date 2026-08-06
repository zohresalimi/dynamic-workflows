/**
 * KAR-06.4 — git made **structurally idempotent** rather than journalled
 * around (docs/05-durable-execution.md §8.3).
 *
 * Two operations, two different fixes:
 *
 * - **`git worktree add`** is already idempotent if you read its failures
 *   properly. Exiting non-zero with a message containing `already exists`
 *   means the directory this effect wanted is the directory that is there —
 *   which is success, not an error. What must **not** be swallowed is
 *   `already used by worktree at`: that is a *branch* collision, a different
 *   worktree holding the branch this one asked for, and treating it as success
 *   hands the node somebody else's working tree. (The real string is `already
 *   used by worktree at` — verified 2026-08-02. Most blog posts claim "is
 *   already checked out at", which is why the match here is on the string git
 *   actually prints and why the collision is checked first.)
 * - **`git commit`** is the one genuinely non-idempotent git operation, and a
 *   trailer fixes it. The ikey goes into the commit message as a second `-m`,
 *   so git records it as a trailer, and reconcile finds it again with
 *   `git log --grep`. A commit that landed before the crash is then *findable*
 *   rather than *guessed at*, and the sha it returns is the memoised result.
 *
 * This module holds only the argv and the string reading. Running them is
 * ../../git/run-git.ts, and `test/integration/reconcile-git.test.ts` drives
 * both against a real `git` in a real repository.
 *
 * Verifies: EPIC-06-S13 · AC7
 */

/** The trailer key. One place, because it is written by one daemon life and
 * grepped for by the next. */
export const EFFECT_TRAILER = 'DeFlow-Effect-Id';

/** The exact line a commit carries, and the exact line `--grep` looks for. */
export function trailerLine(ikey: string): string {
  return `${EFFECT_TRAILER}: ${ikey}`;
}

/**
 * `git commit -m "<subject>" -m "DeFlow-Effect-Id: <ikey>"`.
 *
 * A second `-m` rather than a newline inside the subject: git joins the `-m`
 * values with a blank line, which is what makes the last paragraph a trailer
 * block instead of body prose that `--grep` would still match but `git
 * interpret-trailers` would not see.
 */
export function commitArgs(subject: string, ikey: string): string[] {
  return ['commit', '-m', subject, '-m', trailerLine(ikey)];
}

/**
 * KAR-07.7 AC6 — `git merge --no-ff -m "<subject>\n\n<trailer>" -- <branch>`.
 *
 * One `-m`, unlike `commitArgs`: `git merge` takes a single message and the
 * blank line inside it is what makes the last paragraph a trailer block. The
 * `--` separator is KAR-07.3 AC6's rule — the branch name is generated, and a
 * generated name must never occupy a bare positional slot.
 *
 * `--no-ff` is load-bearing: without it a linear branch merges by moving the
 * ref, leaving no commit to carry either the trailer or the provenance, and
 * both the idempotency probe and the reviewable one-commit-per-node history
 * quietly stop existing.
 */
export function mergeArgs(subject: string, ikey: string, branch: string): string[] {
  return ['merge', '--no-ff', '-m', `${subject}\n\n${trailerLine(ikey)}`, '--', branch];
}

/**
 * `git log --fixed-strings --grep=<trailer> --format=%H -1` — the newest
 * commit carrying this ikey, or no output at all.
 *
 * `--fixed-strings` is not decoration. The ikey is built from ids this module
 * does not own, and a metacharacter reaching `--grep` as a pattern would match
 * a *different* commit — the single failure mode where reconcile answers
 * "done" about somebody else's work.
 */
export function findCommitArgs(ikey: string): string[] {
  return ['log', '--fixed-strings', `--grep=${trailerLine(ikey)}`, '--format=%H', '-1'];
}

/** What `git worktree add` really said, once its exit code is read as data. */
export type WorktreeAddOutcome = 'created' | 'already-exists' | 'failed';

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The branch collision, which is a real failure and must never be mapped to
 * success. Checked before the path collision, so the two cannot be confused. */
const BRANCH_COLLISION = 'already used by worktree at';

/** The path collision, which is this effect's own previous life. */
const PATH_COLLISION = 'already exists';

export function classifyWorktreeAdd(result: CommandResult): WorktreeAddOutcome {
  if (result.exitCode === 0) return 'created';

  // Both streams: git writes `fatal:` to stderr, but a porcelain wrapper or a
  // merged pty stream puts it on stdout, and a probe that reads only one of
  // them re-creates a worktree that already exists.
  const message = `${result.stderr}\n${result.stdout}`;

  if (message.includes(BRANCH_COLLISION)) return 'failed';
  if (message.includes(PATH_COLLISION)) return 'already-exists';
  return 'failed';
}

/** `git worktree add` succeeded, for the two meanings of succeeded. */
export function isWorktreeAddSuccess(outcome: WorktreeAddOutcome): boolean {
  return outcome !== 'failed';
}

/**
 * The sha `findCommitArgs` printed, or `null` when the trailer is absent.
 *
 * `git log` exits 0 with empty output when `--grep` matches nothing, so the
 * emptiness — not the exit code — is the answer.
 */
export function commitShaFrom(result: CommandResult): string | null {
  if (result.exitCode !== 0) return null;
  const sha = result.stdout.trim();
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}
