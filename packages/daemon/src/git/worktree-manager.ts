/**
 * KAR-07.2 — the Workspace Manager's worktree lifecycle
 * (docs/09-workspace-and-safety.md §3, §4).
 *
 * Four operations, and three of them exist because of a specific verified
 * failure rather than because a lifecycle "should" have them:
 *
 * - **`provision`** creates, branches and locks in *one* `git worktree add`
 *   (§4.1). Not create-then-lock: the gap between the two is a real window in
 *   which DeFlow's own reaper, across a daemon restart, can `prune` a worktree
 *   out from under a live agent. Locked worktrees are immune to `prune`, which
 *   is why lock is the crash-safety primitive rather than a side-channel
 *   lockfile that can desync from git's own view.
 * - **Occupancy is pre-checked against `worktree list --porcelain -z`** (§3.1),
 *   never by running `add` and reading the error. The real message is
 *   `fatal: '<branch>' is already used by worktree at '<path>'`, not the
 *   widely-quoted `already checked out at` — and a design that parses either
 *   is one git release from deciding every branch is free. The refusal is a
 *   typed error plus a `workspace.branch_occupied` event; nothing downstream
 *   ever sees a git string.
 * - **`remove` is unlock then remove** (§4.4), never a blind force. The branch
 *   outlives the worktree, because the branch is the deliverable (F5.5), and
 *   the tip oid recorded in `workspace.worktree_removed` is what the
 *   integration loop merges later. The double force lives in
 *   ./worktree-force-remove.ts, which this module does not import.
 * - **`refresh` reconciles the projection**, and reconciling is a *normal
 *   outcome*: an operator who runs `git worktree remove` in their own terminal
 *   — and they will — produces a table row that is simply gone, an event, and
 *   no error at all (§4.3, AC8).
 *
 * The branch name is an input. Composing it is KAR-07.3's `nodeBranch`, whose
 * `DeFlow/` prefix and leading-dash refusal are what make it safe to put in a
 * `-b` slot at all — `git worktree add -b -n <path>` accepts `-n` as a branch
 * name and then fails inside its own `git branch` call (verified on git 2.50.1,
 * pinned in test/integration/worktree-lifecycle.test.ts).
 *
 * Verifies: EPIC-07-S9 … EPIC-07-S16 · AC1–AC8
 */
import type { Clock, Db, NodeId, RunId, WorktreeOccupantKind } from '@DeFlow/core';
import {
  appendEvents,
  type EventDraft,
  readWorktrees,
  replaceWorktrees,
  type WorktreeRow,
} from '@DeFlow/ledger';
import type { GitResult } from './run-git.ts';
import {
  lockReasonFor,
  parseLockReason,
  WORKTREE_LIST_ARGS,
  worktreeAddArgs,
  worktreeRemoveArgs,
  worktreeUnlockArgs,
} from './worktree-args.ts';
import {
  findOccupant,
  parseWorktreeList,
  shortBranch,
  type WorktreeEntry,
} from './worktree-porcelain.ts';

/** The one way this module reaches git: the `Git` wrapper's own shape, injected
 * so a spec can record the argv while real git still does the work. */
export interface WorkspaceGit {
  run(args: readonly string[], opts?: { readonly cwd?: string }): Promise<GitResult>;
}

export interface WorkspacePorts {
  readonly git: WorkspaceGit;
  readonly db: Db;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** This daemon life's epoch, stamped on every event appended here. */
  readonly epoch: number;
}

interface ProvisionBase {
  readonly runId: string;
  readonly nodeId: string;
  /** Absolute path. @see worktreePathFor */
  readonly path: string;
  /** What the worktree starts from — never checked out as a branch. */
  readonly baseRef: string;
}

export interface ProvisionWrite extends ProvisionBase {
  readonly mode: 'write';
  /** Composed by KAR-07.3's `nodeBranch` from the run and node ids. */
  readonly branch: string;
}

export interface ProvisionRead extends ProvisionBase {
  readonly mode: 'read';
}

export type ProvisionRequest = ProvisionWrite | ProvisionRead;

export interface ProvisionResult {
  readonly path: string;
  /** `null` for a read node — `--detach` means no branch was created. */
  readonly branch: string | null;
  readonly detached: boolean;
  readonly lockReason: string;
}

export interface RemoveRequest {
  readonly runId: string;
  readonly nodeId: string;
  readonly path: string;
  /** The node's branch, so its tip can be recorded before the worktree goes.
   * Absent for a read node's detached checkout. */
  readonly branch?: string;
}

export interface RemoveResult {
  readonly path: string;
  readonly branch: string | null;
  readonly tipOid: string | null;
}

export interface ReconcileReport {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly prunable: readonly string[];
  /** Whether anything at all differed from the stored projection. */
  readonly changed: boolean;
  readonly entries: readonly WorktreeEntry[];
}

/**
 * A branch DeFlow wanted is held by something else.
 *
 * The fields are the answer; the message is for a human. Nothing downstream
 * should ever need to read either a git string or this message to decide what
 * happened — that is the whole point of pre-checking the porcelain list.
 */
export class BranchOccupiedError extends Error {
  readonly branch: string;
  readonly occupiedBy: string;
  readonly occupantKind: WorktreeOccupantKind;

  constructor(branch: string, occupiedBy: string, occupantKind: WorktreeOccupantKind) {
    super(occupancyMessage(branch, occupiedBy, occupantKind));
    this.name = 'BranchOccupiedError';
    this.branch = branch;
    this.occupiedBy = occupiedBy;
    this.occupantKind = occupantKind;
  }
}

/** A `git worktree add` that failed for a reason the pre-check does not cover
 * — a path that already exists, a base ref that does not resolve. Carries git's
 * own words, because at this point they are the only information there is. */
export class WorktreeCreateFailed extends Error {
  readonly path: string;
  readonly stderr: string;

  constructor(path: string, result: GitResult) {
    super(`git worktree add for "${path}" exited ${result.exitCode}: ${result.stderr.trim()}`);
    this.name = 'WorktreeCreateFailed';
    this.path = path;
    this.stderr = result.stderr;
  }
}

/**
 * `git worktree remove` refused.
 *
 * Almost always a dirty working tree, which is KAR-07.4's salvage sequence and
 * emphatically not a reason to force: the whole point is that an agent's work
 * is committed to the node branch before the worktree can be discarded.
 */
export class WorktreeRemovalRefused extends Error {
  readonly path: string;
  readonly stderr: string;

  constructor(path: string, result: GitResult) {
    super(`git worktree remove for "${path}" exited ${result.exitCode}: ${result.stderr.trim()}`);
    this.name = 'WorktreeRemovalRefused';
    this.path = path;
    this.stderr = result.stderr;
  }
}

/**
 * DeFlow's own words for an occupied branch — AC4.
 *
 * The `main-checkout` wording is the one that matters, and it is deliberately
 * about *the operator*: they are sitting on this branch, DeFlow is not going to
 * take it from them, and the thing they almost certainly wanted is available by
 * using it as a base ref instead. Git's phrasing ("is already used by worktree
 * at") is not echoed, in either the real or the widely-quoted form, so that
 * nobody downstream — human or code — starts matching on it.
 */
function occupancyMessage(
  branch: string,
  occupiedBy: string,
  occupantKind: WorktreeOccupantKind,
): string {
  if (occupantKind === 'main-checkout') {
    return (
      `The branch "${branch}" is the one your own working copy at "${occupiedBy}" has checked ` +
      'out, and DeFlow will not take a branch out from under you. Give the node "' +
      `${branch}" as its base ref instead — it will start from exactly that commit on a branch ` +
      'of its own — or check out a different branch in your working copy first.'
    );
  }
  return (
    `The branch "${branch}" is held by the worktree at "${occupiedBy}", and git allows a branch ` +
    'to be checked out in one worktree only. Give this node a branch of its own (DeFlow does, for ' +
    `every write node) and pass "${branch}" as its base ref.`
  );
}

/** The tip of a branch, or `null` when it has none / is not a branch. */
async function branchTip(git: WorkspaceGit, branch: string): Promise<string | null> {
  const result = await git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  const oid = result.stdout.trim();
  return result.exitCode === 0 && oid !== '' ? oid : null;
}

function rowFor(entry: WorktreeEntry, refreshedAt: number): WorktreeRow {
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

/** Everything but `refreshedAt`, which changes on every refresh and would make
 * every refresh look like a change. */
const comparable = (row: WorktreeRow): string => JSON.stringify({ ...row, refreshedAt: 0 });

export class WorkspaceManager {
  readonly #ports: WorkspacePorts;

  constructor(ports: WorkspacePorts) {
    this.#ports = ports;
  }

  /** §4.3, the only read path: `worktree list --porcelain -z`, parsed. */
  async list(): Promise<WorktreeEntry[]> {
    const result = await this.#ports.git.run(WORKTREE_LIST_ARGS);
    if (result.exitCode !== 0) {
      throw new Error(`git worktree list exited ${result.exitCode}: ${result.stderr.trim()}`);
    }
    return parseWorktreeList(result.stdout);
  }

  /**
   * §4.1 — one invocation, locked at creation (AC1, AC2), preceded only by the
   * occupancy pre-check for a write node (AC3, AC4).
   *
   * A read node skips the pre-check entirely, and that is not an optimisation:
   * `--detach` means it claims no branch, so there is nothing for it to
   * collide on. Two read nodes on the same commit both succeed.
   */
  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    if (request.mode === 'write') await this.#assertBranchFree(request);

    const result = await this.#ports.git.run(worktreeAddArgs(request));
    if (result.exitCode !== 0) throw new WorktreeCreateFailed(request.path, result);

    const branch = request.mode === 'write' ? request.branch : null;
    const lockReason = lockReasonFor(request.runId, request.nodeId);
    this.#append(request.runId, request.nodeId, 'workspace.worktree_created', {
      node: request.nodeId,
      path: request.path,
      branch,
      baseRef: request.baseRef,
      detached: request.mode === 'read',
      lockReason,
    });

    return { path: request.path, branch, detached: request.mode === 'read', lockReason };
  }

  /**
   * §4.4's happy path (AC7): unlock, then remove. Never `--force`.
   *
   * The tip is read *before* the removal, so the event records what the node
   * actually produced even though the worktree is about to stop existing. The
   * unlock's exit code is ignored on purpose: a worktree that is not locked —
   * one an operator already unlocked, say — makes `unlock` exit non-zero, and
   * that is the state this call wanted anyway.
   */
  async remove(request: RemoveRequest): Promise<RemoveResult> {
    const branch = request.branch ?? null;
    const tipOid = branch === null ? null : await branchTip(this.#ports.git, branch);

    await this.#ports.git.run(worktreeUnlockArgs(request.path));
    const removed = await this.#ports.git.run(worktreeRemoveArgs(request.path));
    if (removed.exitCode !== 0) throw new WorktreeRemovalRefused(request.path, removed);

    this.#append(request.runId, request.nodeId, 'workspace.worktree_removed', {
      node: request.nodeId,
      path: request.path,
      branch,
      tipOid,
    });

    return { path: request.path, branch, tipOid };
  }

  /**
   * §4.3 (AC8) — makes the `worktrees` projection equal to what git just said,
   * and appends `workspace.reconciled` when anything differed.
   *
   * No error is ever raised for a difference. A difference is the *expected*
   * case: it means an operator did something in their own terminal, which is
   * their repository's prerogative, and a daemon that failed a run over it
   * would be a daemon nobody could use git alongside.
   *
   * `runId` is only the timeline the event lands in — the projection itself is
   * daemon-wide, because so are worktrees.
   */
  async refresh(runId: string): Promise<ReconcileReport> {
    const entries = await this.list();
    const now = this.#ports.clock.now();
    const next = entries.map((entry) => rowFor(entry, now));

    const previous = readWorktrees(this.#ports.db);
    const previousByPath = new Map(previous.map((row) => [row.path, row]));
    const nextByPath = new Map(next.map((row) => [row.path, row]));

    const added = next.filter((row) => !previousByPath.has(row.path)).map((row) => row.path);
    const removed = previous.filter((row) => !nextByPath.has(row.path)).map((row) => row.path);
    const prunable = next.filter((row) => row.prunable).map((row) => row.path);
    const changed =
      previous.length !== next.length ||
      next.some((row) => {
        const before = previousByPath.get(row.path);
        return before === undefined || comparable(before) !== comparable(row);
      });

    replaceWorktrees(this.#ports.db, next);

    if (changed) {
      this.#appendRun(runId, 'workspace.reconciled', { added, removed, prunable });
    }

    return { added, removed, prunable, changed, entries };
  }

  /** AC3, AC4 — the pre-check, from git's list and nothing else. The event is
   * appended before the throw, so the refusal is in the run's history whether
   * or not anything catches the error. */
  async #assertBranchFree(request: ProvisionWrite): Promise<void> {
    const occupant = findOccupant(await this.list(), request.branch);
    if (occupant === null) return;

    this.#append(request.runId, request.nodeId, 'workspace.branch_occupied', {
      node: request.nodeId,
      branch: shortBranch(request.branch),
      occupiedBy: occupant.path,
      occupantKind: occupant.kind,
    });
    throw new BranchOccupiedError(shortBranch(request.branch), occupant.path, occupant.kind);
  }

  /** One event, in this daemon life's epoch, attributed to a node. */
  #append(runId: string, nodeId: string, kind: string, payload: unknown): void {
    this.#appendDraft({
      runId: runId as RunId,
      ts: this.#ports.clock.now(),
      kind,
      v: 1,
      epoch: this.#ports.epoch,
      nodeId: nodeId as NodeId,
      payload,
    });
  }

  /** One event with no node: the projection is daemon-wide, so a reconcile
   * belongs to the run's timeline but not to any node in it. */
  #appendRun(runId: string, kind: string, payload: unknown): void {
    this.#appendDraft({
      runId: runId as RunId,
      ts: this.#ports.clock.now(),
      kind,
      v: 1,
      epoch: this.#ports.epoch,
      payload,
    });
  }

  #appendDraft(draft: EventDraft): void {
    appendEvents(this.#ports.db, [draft]);
  }
}
