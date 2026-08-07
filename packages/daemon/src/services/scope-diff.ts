/**
 * KAR-08.7 AC3, AC5 — the completion-time backstop for an adapter that never
 * populates `ToolCallLocation`: diff the worktree against `git status` and
 * warn on anything that landed outside the node's declared write scope
 * (docs/09-workspace-and-safety.md §6.3, EPIC-08-S30).
 *
 * `permission-ladder.ts`'s AC2 check only ever runs when the agent's
 * `session/request_permission` carries a location — most vendors, most of
 * the time, but not all of them (EPIC-08-S11's third scenario). A write via
 * an allowlisted `terminal/create` command bypasses it entirely: KAR-08.3
 * polices the *binary*, not where its output lands. This module is what
 * catches that write anyway, once the node is done — a **warning**, D14's
 * plan-time prediction failing to hold, never a gate: `git merge-tree
 * --write-tree` is what actually gates a merge, and it needs zero agent
 * cooperation to do it.
 *
 * `changedPaths` is the only I/O in the file, and it is the one place a
 * `git` child is spawned for this purpose — `../git/status-porcelain.ts`
 * already parses the exact byte layout, and this reuses it rather than
 * re-deriving "what changed" from a second command. `outOfScopePaths` and
 * `scopeWarningOf` are pure, so the decision half of AC3 is as fast to test
 * as the rest of the safety model.
 *
 * Verifies: EPIC-08-S30 · AC3, AC5, AC6
 */
import type { NodeScopeWarning, ScopeAudit } from '@DeFlow/adapters';
import { type NodeId, pathScopeMatches, relativeToWorktree } from '@DeFlow/core';
import { type RunGitOptions, runGit } from '../git/run-git.ts';
import { parseStatusPorcelainV2 } from '../git/status-porcelain.ts';

/**
 * Its own args, deliberately not `../git/status-porcelain.ts`'s `STATUS_ARGS`:
 * that module only ever asks "is the worktree dirty", so git's default
 * `--untracked-files=normal` — which collapses a brand-new directory to one
 * entry, `docs/` rather than `docs/readme.md` — is exactly right for it and
 * exactly wrong here. AC3 needs the individual file a scope check can compare
 * against a glob, so this passes `--untracked-files=all`.
 */
const SCOPE_STATUS_ARGS: readonly string[] = [
  'status',
  '--porcelain=v2',
  '-z',
  '--untracked-files=all',
];

/**
 * Every changed, renamed or untracked path in `worktree`, worktree-relative,
 * sorted. A rename contributes both its new and its old path — the old one
 * really did change too, from the worktree's point of view, and a scope
 * declared over the file it used to be at is worth warning about the same as
 * one declared over where it landed.
 *
 * An ignored entry never appears without `--ignored`, which is not among
 * `SCOPE_STATUS_ARGS`, so nothing here needs to filter it out.
 */
export async function changedPaths(
  worktree: string,
  options: RunGitOptions = {},
): Promise<string[]> {
  const result = await runGit(worktree, SCOPE_STATUS_ARGS, options);
  const paths = new Set<string>();
  for (const entry of parseStatusPorcelainV2(result.stdout)) {
    paths.add(entry.path);
    if (entry.origPath !== null) paths.add(entry.origPath);
  }
  return [...paths].toSorted();
}

/**
 * AC3, AC6: the entries of `paths` that match none of `declared`, each
 * normalized through `relativeToWorktree` — the same normalization
 * `permission-ladder.ts`'s request-time check uses, so the two mechanisms
 * never disagree about what "in scope" means for one file.
 */
export function outOfScopePaths(
  worktree: string,
  declared: readonly string[],
  paths: readonly string[],
): string[] {
  return paths.filter((path) => !pathScopeMatches(declared, relativeToWorktree(worktree, path)));
}

/**
 * The `node.scope_warning` payload — `@DeFlow/core`'s `NodeScopeWarningSchema`
 * shape, exactly, by way of the port the adapter declares.
 *
 * Aliased rather than restated: this is the value that crosses the boundary
 * into `runAcpNode`, and two hand-written copies of one payload shape are two
 * things that can drift while both still compile.
 */
export type ScopeWarningPayload = NodeScopeWarning;

/**
 * AC3, AC5: the warning `paths`' violations are, or `null` when every change
 * is in scope — a clean diff never warns, which is what keeps this from
 * firing on a node that behaved.
 */
export function scopeWarningOf(
  node: NodeId,
  attempt: number,
  worktree: string,
  declared: readonly string[],
  paths: readonly string[],
): ScopeWarningPayload | null {
  const outOfScope = outOfScopePaths(worktree, declared, paths);
  return outOfScope.length === 0
    ? null
    : { node, attempt, declared: [...declared], paths: outOfScope };
}

/**
 * The two halves above, wired into the port `runAcpNode` and `runShimNode`
 * call on completion (KAR-08.7 AC3) — this is what makes the backstop part of
 * the running system rather than a library beside it.
 *
 * Built as a factory rather than exported as a bare function so the `git`
 * environment is decided once, by the daemon, at the place that knows it: a
 * hermetic test passes `GIT_ENV`, and DeFlowd passes nothing and gets the
 * user's own configuration, which is the only environment their repository
 * actually works in (`run-git.ts`).
 */
export function createScopeAudit(options: RunGitOptions = {}): ScopeAudit {
  return async (request): Promise<NodeScopeWarning | null> =>
    scopeWarningOf(
      request.node,
      request.attempt,
      request.worktree,
      request.declared,
      await changedPaths(request.worktree, options),
    );
}
