/**
 * KAR-07.4 — the salvage sequence's argv, and the **only** single `--force` on
 * the node-completion path (docs/09-workspace-and-safety.md §4.4).
 *
 * §4.4's dirty-removal path, verbatim:
 *
 * > 1. Capture `git -C <wt> status --porcelain=v2 -z` into the ledger as a
 * >    `workspace.dirty_on_remove` event.
 * > 2. Auto-commit everything to the node branch as a `DeFlow: WIP salvage`
 * >    commit, so the work is recoverable by ref.
 * > 3. _Then_ `git worktree remove --force <path>`.
 * >
 * > Only after the salvage commit is durable does force become acceptable.
 *
 * **Why the force lives here and not in ./worktree-args.ts.** That module is
 * the lifecycle's argv and states, as a property of itself, that it contains no
 * force at all. This one is the exception the story creates, kept in a file of
 * its own so "a `--force` on the completion path is reachable only through the
 * salvage" is a fact about the import graph — the same technique
 * ./worktree-force-remove.ts uses for the reaper's *double* force, and checked
 * by ../../test/double-force-reachability.test.ts, which still refuses `-f`
 * anywhere in the graph and refuses this module's single force outside it.
 *
 * **`add -A` is deliberate.** The untracked file is exactly the thing a blind
 * `--force` would have destroyed with no record anywhere, and it is the file an
 * agent most often has open when it is interrupted. Gitignored paths are not
 * swept up by it — `node_modules/` is not in `status --porcelain=v2 -z`'s
 * output and is not in `add -A`'s either, which is why a fat `node_modules` is
 * a disk problem (§5) and not a removal one.
 *
 * **No `--no-verify`, on purpose, and it is an open question.** This is the
 * first place DeFlow's own git call can trigger a repository-authored hook
 * (the epic's risk table; docs/15-security-model.md §6). Suppressing hooks
 * would make the salvage commit unconditional, but it would also make DeFlow
 * the one thing in the repository that ignores rules the repository wrote for
 * itself. Until that is decided, the commit is issued plainly and a hook that
 * refuses it produces a `WipSalvageFailed` — which leaves the worktree present
 * and dirty, and reaches no force. Failing safe is available; failing silently
 * is not.
 *
 * Verifies: EPIC-07-S17 · AC2, AC4, AC6
 */
/** §4.4 step 2's subject, verbatim. Pinned as a constant because it is what a
 * human greps `git log` for when they are looking for work a crashed run left
 * behind, and what EPIC-07-S17 asserts on. */
export const SALVAGE_COMMIT_SUBJECT = 'DeFlow: WIP salvage';

/** §4.4 step 2, stage half. `-A`, not `-u`: untracked files are the point. */
export function salvageAddArgs(): string[] {
  return ['add', '-A'];
}

/** §4.4 step 2, commit half. */
export function salvageCommitArgs(): string[] {
  return ['commit', '-m', SALVAGE_COMMIT_SUBJECT];
}

/**
 * AC6 — the throwaway branch a **detached** worktree's salvage commit is made
 * reachable by, created at the commit rather than checked out before it.
 *
 * Creating the ref after the fact rather than `checkout -b`-ing before it keeps
 * the commit itself identical in both modes (add, commit, done) and touches
 * neither HEAD nor the index of a worktree that is about to be deleted anyway.
 *
 * The `--` is KAR-07.3 AC6's rule: a generated name never occupies a bare
 * positional slot, however un-flag-like `DeFlow/…` is. `branch` is composed by
 * `salvageBranch` (./branch-name.ts) and passed in, exactly as `worktreeAddArgs`
 * takes the node branch rather than composing it.
 */
export function salvageBranchArgs(branch: string, oid: string): string[] {
  return ['branch', '--', branch, oid];
}

/**
 * §4.4 step 3 — and the single force this whole module exists to contain.
 *
 * One `--force`, never two: the second would override the *lock*, and the lock
 * is only ever released by the unlock the completion path already runs
 * (`worktreeUnlockArgs`). A worktree still locked at this point belongs to a
 * live process, and KAR-07.8's reaper is the only thing allowed to decide
 * otherwise.
 *
 * Reaching this function with no durable `workspace.wip_salvaged` event for the
 * node is the failure AC4 forbids. The precondition is not stated here because
 * a comment cannot hold it — ./worktree-manager.ts reads the event back out of
 * SQLite before it calls this.
 */
export function salvagedRemoveArgs(path: string): string[] {
  return ['worktree', 'remove', '--force', path];
}
