/**
 * KAR-07.3 — flat branch naming and the domain-layer half of ref-name
 * validation (docs/09-workspace-and-safety.md §2, §2.1; Decision D13).
 *
 * D13 overrides the PRD's hierarchical `DeFlow/<runId>/<nodeId>` scheme: git's
 * refs storage cannot have both a file and a directory at
 * `refs/heads/DeFlow/<runId>`, so once a node branch exists under a run, a
 * run-level integration branch can never be created (and the reverse fails
 * symmetrically) — verified on real git in
 * ../../test/integration/branch-name.test.ts (EPIC-07-S6). Flat naming,
 * `DeFlow/<runId>__<nodeId>`, removes the whole class of bug.
 *
 * `BRANCH_SAFE` is deliberately stricter than git's own ref-name rules: it is
 * lowercase-only (so two ids differing only in case can never compose into
 * worktree paths that collide on a case-insensitive filesystem — AC5, without
 * DeFlow ever having to transform an id's case) and it rejects a leading `-`
 * outright, because a dash-led id reaching git as a bare positional argument
 * is parsed as a flag, not a name (the "-n trap": see ./ref-format.ts and
 * EPIC-07-S8). Two further checks — a `.lock` suffix and a `..` sequence —
 * are the same two of git's own reference-naming rules that the character
 * class alone does not exclude (both `.` and the alphanumerics it forbids-by-
 * omission are otherwise inside `[a-z0-9._-]`), and are applied explicitly so
 * they are still refused here, at the domain layer, before any value can
 * reach git at all (AC2, AC4).
 */

const BRANCH_SAFE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type BranchIdComponent = 'runId' | 'nodeId';

/** Thrown by `nodeBranch`/`integrationBranch` before any git process is
 * spawned, naming which component failed and why (AC2). */
export class UnsafeRefError extends Error {
  readonly component: BranchIdComponent;
  readonly value: string;

  constructor(component: BranchIdComponent, value: string) {
    super(
      `unsafe ${component} ${JSON.stringify(value)}: must match ${BRANCH_SAFE.source} ` +
        'and must not end with ".lock" or contain a ".." sequence',
    );
    this.name = 'UnsafeRefError';
    this.component = component;
    this.value = value;
  }
}

/** The two rules `BRANCH_SAFE`'s character class cannot express on its own:
 * both use only characters the regex already allows. */
function hasDisallowedSequence(value: string): boolean {
  return value.endsWith('.lock') || value.includes('..');
}

function isBranchSafe(value: string): boolean {
  return BRANCH_SAFE.test(value) && !hasDisallowedSequence(value);
}

function assertBranchSafe(component: BranchIdComponent, value: string): void {
  if (!isBranchSafe(value)) throw new UnsafeRefError(component, value);
}

/**
 * A `RunId` rendered so a ref can be named after it, and the **only**
 * transformation this module performs on any id.
 *
 * Added by KAR-19.5, because binding `executeNodes` in the composition root
 * made a latent cross-epic collision reachable for the first time: a `RunId` is
 * `run_YYYYMMDDTHHMMSSZ_<hex>` (EPIC-03), whose `T` and `Z` are uppercase, and
 * `BRANCH_SAFE` is lowercase-only (EPIC-07 AC5). So **no run at all** could
 * have a node branch or a salvage ref composed for it — `nodeBranch` threw
 * `UnsafeRefError` on every run in existence, and nothing had noticed because
 * nothing shipped had ever called it. The first live agent node failed with
 * `internal` and that message.
 *
 * Lowercasing is safe *here and only here*, and the distinction is the whole
 * justification for making an exception to this module's no-transformation
 * rule. AC5's concern is two ids that differ only in case colliding into one
 * worktree path — which needs two ids whose case an operator or a planner
 * chose. A `RunId`'s uppercase characters are DeFlow's own constant separators
 * at fixed positions in a schema-validated shape, so lowercasing is injective
 * over the entire set of run ids by construction. `nodeId` gets no such
 * treatment: a plan may name a node anything, so `Implement` and `implement`
 * stay two ids and `assertBranchSafe` still refuses both-cased ones outright.
 */
export function runRef(runId: string): string {
  return runId.toLowerCase();
}

/**
 * D13: the one place a node's branch name is composed. `runId` and `nodeId`
 * are validated separately, so the thrown error always names the offending
 * component — before either value can reach git (AC1, AC2).
 *
 * Callers composing a ref for a live run pass `runRef(runId)` rather than the
 * run id itself; see that function for why the transformation is theirs to
 * apply and not this one's to assume.
 */
export function nodeBranch(runId: string, nodeId: string): string {
  assertBranchSafe('runId', runId);
  assertBranchSafe('nodeId', nodeId);
  return `DeFlow/${runId}__${nodeId}`;
}

/**
 * D13: the run-level integration branch, under a prefix (`DeFlow/int/`) that
 * cannot collide with any node branch `nodeBranch` can produce (AC1). `runId`
 * is validated with the same rule `nodeBranch` applies to it.
 */
export function integrationBranch(runId: string): string {
  assertBranchSafe('runId', runId);
  return `DeFlow/int/${runId}`;
}

/**
 * KAR-07.4 AC6 — where a **detached** node's salvage commit goes.
 *
 * A read node is checked out with `--detach` (§4.1), so when one is somehow
 * left dirty there is no branch for `git commit` to advance and nothing for the
 * work to be recoverable by. This composes the throwaway ref it lands on
 * instead. Throwaway is the word: nothing merges it, and its only job is that
 * `git show DeFlow/salvage/<runId>__<nodeId>` still answers after the worktree
 * is gone.
 *
 * The `DeFlow/salvage/` prefix cannot collide with anything `nodeBranch`
 * produces, for exactly D13's reason: every node branch is a *file* named
 * `<runId>__<nodeId>` directly under `refs/heads/DeFlow/`, and no id pair can
 * compose to the bare name `salvage`, because the `__` separator is always
 * there. Same argument as `DeFlow/int/`.
 *
 * The composed value only ever reaches git behind the `--` separator
 * ./worktree-salvage.ts writes (`git branch -- <name> <oid>`), which is
 * KAR-07.3 AC6's rule; it is never handed to a bare positional slot.
 */
export function salvageBranch(runId: string, nodeId: string): string {
  assertBranchSafe('runId', runId);
  assertBranchSafe('nodeId', nodeId);
  return `DeFlow/salvage/${runId}__${nodeId}`;
}
