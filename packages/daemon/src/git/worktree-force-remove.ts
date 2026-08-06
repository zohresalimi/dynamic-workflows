/**
 * KAR-07.2 AC7 — the double force, in a module of its own so that "only the
 * reaper does this" is a fact about the import graph rather than a comment
 * (docs/09-workspace-and-safety.md §4.4).
 *
 * **Two forces, not one.** The first overrides a dirty working tree; the second
 * overrides the lock. Git's own message says so:
 *
 * ```
 * fatal: cannot remove a locked working tree, lock reason: DeFlow run=r1 node=n1
 * use 'remove -f -f' to override or unlock first
 * ```
 *
 * Everything DeFlow does on the **node-completion path** is the other branch of
 * that sentence — unlock first (./worktree-args.ts), and salvage a dirty tree
 * to a commit before it can be discarded (KAR-07.4). Forcing there would either
 * throw away work an agent had just done with no record of it, or delete a
 * worktree a live process is still writing to.
 *
 * The only caller that may reach for this is **KAR-07.8's boot reaper**, and
 * only for a worktree whose owning process is *provably* gone — pid **and**
 * recorded process start time, never bare liveness, because pids are recycled
 * and the failure mode of getting that wrong is deleting a directory something
 * else is using (§11.3, and the same refusal `src/reaper.ts` already makes for
 * signals).
 *
 * `test/double-force-reachability.test.ts` walks the module graph from the
 * node-completion entry point and fails if this file ever becomes reachable
 * from it.
 */

/**
 * `git worktree remove -f -f <path>` — reaper only. See this module's header
 * for the two preconditions, both of which are the caller's to establish.
 */
export function reaperForceRemoveArgs(path: string): string[] {
  return ['worktree', 'remove', '-f', '-f', path];
}
