/**
 * KAR-07.2 — every worktree command's argv, in one place
 * (docs/09-workspace-and-safety.md §4.1, §4.3, §4.4; all verified on real git).
 *
 * Three of these are load-bearing rather than tidy:
 *
 * - **`--lock` is inside the `add`.** Not a `worktree add` followed by a
 *   `worktree lock`: the gap between the two is a real window in which DeFlow's
 *   own background reaper — across a daemon restart, when it has no idea a new
 *   worktree is being born — can `prune` the worktree out from under a live
 *   agent. Locked worktrees are immune to `prune` (§4.2), which is exactly why
 *   lock is the crash-safety primitive rather than a side-channel lockfile that
 *   can desync from git's own view. There is no `worktreeLockArgs` in this
 *   module, deliberately, so the racy sequence has nothing to be spelled with.
 * - **`--detach` for read nodes, and no `-b`.** Detached HEAD sidesteps branch
 *   uniqueness entirely (§3) and encodes intent: this node is not going to
 *   produce a branch.
 * - **No `--force` anywhere in here.** The double force that overrides both
 *   dirtiness and the lock lives in ./worktree-force-remove.ts, which the
 *   node-completion path does not import — see that file, and the static
 *   reachability assertion in ../../test/double-force-reachability.test.ts.
 *
 * The branch name is an *input*, not something this module composes. Composing
 * it is KAR-07.3's `nodeBranch`, whose `DeFlow/` prefix and leading-dash
 * refusal are what make it safe to hand to `-b` — and `-b` is not a safe slot
 * for an arbitrary string: `git worktree add -b -n <path>` accepts `-n` as the
 * branch name and then fails deep inside its own `git branch` call
 * (`error: unknown switch 'n'`, verified on git 2.50.1, 2026-08-06, and pinned
 * in test/integration/worktree-lifecycle.test.ts).
 *
 * Verifies: EPIC-07-S9, EPIC-07-S10, EPIC-07-S15 · AC1, AC2, AC5, AC7
 */
import { join } from 'node:path';

/** §4.3, and the only form `worktree list` is ever invoked in (AC5). */
export const WORKTREE_LIST_ARGS: readonly string[] = ['worktree', 'list', '--porcelain', '-z'];

/** A write node owns a branch; a read node owns a detached checkout. */
export type WorktreeMode = 'write' | 'read';

interface WorktreeSpecBase {
  readonly runId: string;
  readonly nodeId: string;
  /** Absolute path of the worktree. @see worktreePathFor */
  readonly path: string;
  /** What the worktree starts from — a branch, tag or oid. Never checked out. */
  readonly baseRef: string;
}

export interface WriteWorktreeSpec extends WorktreeSpecBase {
  readonly mode: 'write';
  /** Composed by KAR-07.3's `nodeBranch`, from the run and node ids, never here. */
  readonly branch: string;
}

export interface ReadWorktreeSpec extends WorktreeSpecBase {
  readonly mode: 'read';
}

export type WorktreeSpec = WriteWorktreeSpec | ReadWorktreeSpec;

/**
 * §4.1's `--reason` verbatim: `DeFlow run=<runId> node=<nodeId>`.
 *
 * It is a real payload rather than a label — git reports it back in
 * `worktree list --porcelain`'s `locked` record, so it is how the projection
 * (and a human reading `git worktree list`) learns whose worktree this is,
 * with no side table involved.
 */
export function lockReasonFor(runId: string, nodeId: string): string {
  return `DeFlow run=${runId} node=${nodeId}`;
}

const LOCK_REASON = /^DeFlow run=(?<runId>[^ ]+) node=(?<nodeId>[^ ]+)$/;

/** The inverse of `lockReasonFor`, or `null` when DeFlow did not write this
 * lock — an operator's own `git worktree lock -–reason "on holiday"` included. */
export function parseLockReason(
  reason: string | null,
): { readonly runId: string; readonly nodeId: string } | null {
  if (reason === null) return null;
  const groups = LOCK_REASON.exec(reason)?.groups;
  if (groups?.runId === undefined || groups.nodeId === undefined) return null;
  return { runId: groups.runId, nodeId: groups.nodeId };
}

/**
 * §4.1, in **one** invocation for both node kinds (AC1, AC2).
 *
 * The order of the arguments is the document's order, not an arbitrary one:
 * `--lock --reason <reason>` first, then the mode-specific `-b <branch>`, then
 * the two positionals `<path> <baseRef>`.
 */
export function worktreeAddArgs(spec: WorktreeSpec): string[] {
  const reason = lockReasonFor(spec.runId, spec.nodeId);
  const modeArgs =
    spec.mode === 'write'
      ? ['--lock', '--reason', reason, '-b', spec.branch]
      : ['--detach', '--lock', '--reason', reason];
  return ['worktree', 'add', ...modeArgs, spec.path, spec.baseRef];
}

/** §4.4's happy path, step one. Run unconditionally: a `remove` on a locked
 * worktree fails, and DeFlow locks every worktree it creates. */
export function worktreeUnlockArgs(path: string): string[] {
  return ['worktree', 'unlock', path];
}

/** §4.4's happy path, step two. No `--force`: a dirty worktree must be salvaged
 * first (KAR-07.4), never discarded. */
export function worktreeRemoveArgs(path: string): string[] {
  return ['worktree', 'remove', path];
}

/**
 * D13's path scheme, composed in one place so it cannot drift from the branch
 * scheme: `<root>/.DeFlow/wt/<runId>__<nodeId>`, the same flat `__` separator
 * `nodeBranch` uses (docs/03-local-development.md §"data directory layout").
 */
export function worktreePathFor(root: string, runId: string, nodeId: string): string {
  return join(root, '.DeFlow', 'wt', `${runId}__${nodeId}`);
}
