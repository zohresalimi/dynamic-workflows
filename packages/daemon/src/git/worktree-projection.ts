/**
 * One porcelain entry as one `worktrees` row (docs/09-workspace-and-safety.md
 * §4.3).
 *
 * Its own module because two callers build the projection and they must build
 * it identically: `WorkspaceManager.refresh` after a node's lifecycle changes
 * something, and KAR-07.8's boot reaper after it has swept every repository
 * DeFlow has runs in. A second copy of this mapping is how the two views of the
 * same table start disagreeing about `runId` — which is the field the reaper
 * decides whose worktree it is looking at from.
 *
 * `runId`/`nodeId` come out of DeFlow's own lock reason and are `null` for
 * anyone else's worktree, which is exactly the distinction the reaper needs:
 * git is the authority, SQLite is an index over it, and an operator's own
 * `git worktree lock --reason "on holiday"` is not DeFlow's business.
 */
import type { WorktreeRow } from '@DeFlow/ledger';
import { parseLockReason } from './worktree-args.ts';
import type { WorktreeEntry } from './worktree-porcelain.ts';

/** `refreshedAt` is ms epoch, from the caller's injected `Clock` (NF9). */
export function worktreeRowFor(entry: WorktreeEntry, refreshedAt: number): WorktreeRow {
  const owner = parseLockReason(entry.lockReason);
  return {
    path: entry.path,
    head: entry.head,
    branch: entry.branch,
    detached: entry.detached,
    bare: entry.bare,
    locked: entry.locked,
    lockReason: entry.lockReason,
    prunable: entry.prunable,
    prunableReason: entry.prunableReason,
    runId: owner?.runId ?? null,
    nodeId: owner?.nodeId ?? null,
    refreshedAt,
  };
}
