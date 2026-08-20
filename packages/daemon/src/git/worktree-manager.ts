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
 * **`provision` is idempotent about its own worktree (KAR-25.8).** Before it
 * ran unconditionally: a node that failed *after* its worktree existed made
 * every retry's `git worktree add` exit 128 with "already exists", forever —
 * the owner's `recon` and `spec-approval` nodes, both stuck `Failed`. The
 * fix decides what a pre-existing path means from the same porcelain list the
 * occupancy pre-check already reads, plus `parseLockReason` (§4.1's exact
 * inverse of `lockReasonFor`), never from git's error string:
 *
 * - Registered, and its lock reason names *this* run and node → **reuse it**.
 *   `workspace.worktree_reused` is appended, not a second `_created` — two
 *   `_created` events for one node would make the ledger claim two worktrees
 *   where there is one.
 * - Registered to somebody else → refused with `WorktreePathOccupiedError`,
 *   before `git worktree add` is ever tried.
 * - On disk but **not** registered at all — an orphan from a crash between
 *   the directory being made and the ledger append landing — is pruned (never
 *   touches a locked entry, so this can only ever clear dead state) and
 *   removed, then provisioned fresh.
 *
 * **A fourth case: the teardown that never finished (KAR-26.1).** `remove`
 * unlocks before it removes and ignores the unlock's exit code, so a daemon
 * killed between the two steps — or a `remove` git refused because the tree was
 * dirty — leaves the entry **registered and unlocked**. KAR-25.8 read that as an
 * unidentifiable occupant and refused for ever, once per drive tick. It is not
 * unidentifiable: the path is `<runRoot>/runs/<runId>/worktrees/<nodeId>`,
 * derived from the very run and node now asking for it, so a registered entry
 * sitting there with no lock is DeFlow's own half-removed worktree and the
 * correct move is to finish the removal — `remove()` again, salvage sequence and
 * all — and then provision as for a fresh path. "As for a fresh path" includes
 * the branch: §4.4 keeps it, so a write node re-enters it rather than asking
 * git to create a name it already holds (@see worktreeAttachArgs).
 *
 * That justification is a claim about *the path*, and it holds only for the
 * literal one. `findRegistered` matches by realpath, so a **symlink** at the
 * node's own path matches whatever it points at — and `git worktree remove`
 * through a link removes the worktree at the other end of it. So a symlinked
 * site is refused, never adopted and never reused (@see isSymlink).
 *
 * The discriminator is `entry.locked`, **never** `entry.lockReason === null`.
 * `git worktree lock <path>` with no `--reason` prints a bare `locked` record,
 * which parses to `{ locked: true, lockReason: null }` — indistinguishable from
 * an unlocked entry to anything that branches on the reason, and adopting it
 * would destroy an operator's own worktree. Not locked is adopted; locked by
 * anyone but this run and node is refused.
 *
 * Verifies: EPIC-07-S9 … EPIC-07-S16 · AC1–AC8
 * Verifies: EPIC-25-S51 … EPIC-25-S55 · KAR-25.8 AC1–AC6
 * Verifies: EPIC-26-S01 … EPIC-26-S08 · KAR-26.1 AC1–AC6
 */
import type {
  Clock,
  Db,
  EventSeq,
  FailureTag,
  NodeId,
  RunId,
  WorktreeOccupantKind,
} from '@DeFlow/core';
import {
  appendEvents,
  type EventDraft,
  readRange,
  readWorktrees,
  replaceWorktrees,
  type WorktreeRow,
} from '@DeFlow/ledger';
import { lstat, realpath, rm, stat } from 'node:fs/promises';
import { log } from '../logging.ts';
import { runRef, salvageBranch } from './branch-name.ts';
import type { GitResult } from './run-git.ts';
import {
  isDirty,
  parseStatusPorcelainV2,
  STATUS_ARGS,
  type StatusEntry,
} from './status-porcelain.ts';
import {
  lockReasonFor,
  parseLockReason,
  WORKTREE_LIST_ARGS,
  WORKTREE_PRUNE_ORPHAN_ARGS,
  worktreeAddArgs,
  worktreeAttachArgs,
  worktreeRemoveArgs,
  worktreeUnlockArgs,
} from './worktree-args.ts';
import {
  findOccupant,
  parseWorktreeList,
  shortBranch,
  type WorktreeEntry,
} from './worktree-porcelain.ts';
import { worktreeRowFor } from './worktree-projection.ts';
import {
  salvageAddArgs,
  salvageBranchArgs,
  salvageCommitArgs,
  salvagedRemoveArgs,
} from './worktree-salvage.ts';

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
  /**
   * KAR-07.4 AC6 — where a *detached* checkout's salvage commit is made
   * reachable, when it turns out to be dirty. Composed by `salvageBranch` and
   * supplied by the caller for the same reason `branch` is: the ids a run uses
   * are not always the ids a ref may be named after (`BRANCH_SAFE`), and this
   * module never transforms an id to make one fit. Omitted, it is composed from
   * `runId`/`nodeId` — which throws `UnsafeRefError` rather than inventing a
   * name, and throwing here leaves the worktree present and dirty.
   */
  readonly salvageBranch?: string;
}

/** What the salvage sequence did, when it ran at all (KAR-07.4 AC2). */
export interface SalvageResult {
  /** Where the commit landed: the node's branch, or the throwaway salvage ref. */
  readonly branch: string;
  /** True when the checkout had no branch of its own to commit to. */
  readonly detached: boolean;
  readonly oid: string;
  /** The status entries the commit swept up. */
  readonly entries: readonly StatusEntry[];
}

export interface RemoveResult {
  readonly path: string;
  readonly branch: string | null;
  readonly tipOid: string | null;
  /** `null` when the worktree was clean — the ordinary case, and the one AC5
   * insists stays free of salvage machinery. */
  readonly salvage: SalvageResult | null;
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

/**
 * KAR-25.8 case 2 — the path a `provision` was asked for holds a **locked**
 * worktree, and the lock is not this run and node's.
 *
 * Decided from `list()` and `parseLockReason` before `git worktree add` is
 * ever tried, the same posture `BranchOccupiedError` takes for a branch: the
 * refusal names the holder from the lock reason §4.1 itself wrote, not from
 * whatever git's own "already exists" happens to say this release.
 *
 * **KAR-26.1 AC3 — the refusal is terminal.** The tag is what makes it so: a
 * `gate` class routes every caller of `provision` through the retry ladder's
 * escalation arm, which suspends the node and appends `run.needs_human`, and
 * both the driver and the run chain skip a run whose `run.needs_human` is newer
 * than its pin. Untagged, this classified as `internal`/`permanent` — a mapping
 * nobody had written — and the daemon logged the same refusal once per tick for
 * ever, because nothing recorded the node as failed. `safety.execution-boundary`
 * because adopting or destroying a worktree DeFlow did not provision is a
 * guarded operation (F5.6), and only a person can free the path.
 */
export class WorktreePathOccupiedError extends Error {
  readonly path: string;
  readonly occupiedBy: string;
  /** @see FAILURE_TAG — the property `toNodeFailure`'s `tagged` recogniser
   * reads, spelled as the literal @DeFlow/core spells it. */
  readonly deflowFailure: FailureTag = { reason: 'safety.execution-boundary', class: 'gate' };

  constructor(path: string, occupiedBy: string) {
    super(
      `The worktree at "${path}" is held by ${occupiedBy}, so DeFlow will not provision this ` +
        'run and node over it. Release the lock, or remove the worktree, and the next attempt ' +
        'will take the path.',
    );
    this.name = 'WorktreePathOccupiedError';
    this.path = path;
    this.occupiedBy = occupiedBy;
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

/** Which step of §4.4's salvage sequence gave up. */
export type SalvageStep = 'status' | 'add' | 'commit' | 'resolve' | 'branch' | 'durability';

/**
 * The salvage sequence stopped, so the worktree is still there and still dirty
 * — which is the *correct* outcome of a failure here, not a leak (KAR-07.4).
 *
 * Nothing has been removed and nothing has been forced. A repository-authored
 * `pre-commit` hook that refuses the salvage commit lands here, and the run
 * keeps its worktree until a human or a later attempt resolves it. The
 * alternative — forcing anyway — is the exact data loss this story exists to
 * prevent.
 */
export class WipSalvageFailed extends Error {
  readonly step: SalvageStep;
  readonly path: string;
  readonly stderr: string;

  constructor(step: SalvageStep, path: string, detail: string) {
    super(
      `the WIP salvage of "${path}" failed at the ${step} step, so the worktree was left ` +
        `present and dirty and no forced removal was attempted: ${detail.trim()}`,
    );
    this.name = 'WipSalvageFailed';
    this.step = step;
    this.path = path;
    this.stderr = detail;
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

/** KAR-25.8 — whether `provision`'s target path is already there, which is
 * the fork point for all three of its idempotency cases. A plain filesystem
 * read, not a git question: a path git has never heard of is exactly case 3. */
async function pathExists(path: string): Promise<boolean> {
  return await stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * Whether the **last** component of `path` is itself a symlink — `lstat`, so a
 * symlinked ancestor (the `/var` → `/private/var` case `resolved` exists for)
 * is not one of these.
 *
 * The distinction is the whole of KAR-26.1's adoption rule. Adopting an
 * unlocked entry is justified by *where the path came from*: `worktreePathFor`
 * derives it from the very run and node now asking for it, so nothing but
 * DeFlow can have put a worktree there. A symlink breaks that reasoning and
 * nothing else does — the name is still derived, but the directory it resolves
 * to is whatever somebody pointed the link at, and `findRegistered` matches by
 * realpath, so the entry that comes back is theirs. Verified against real git:
 * `worktree remove <link>` removes the worktree at the *other end*.
 */
async function isSymlink(path: string): Promise<boolean> {
  return await lstat(path).then(
    (entry) => entry.isSymbolicLink(),
    () => false,
  );
}

/**
 * Paths as `git worktree list` prints them are realpath-resolved; a path this
 * module builds itself (`worktreePathFor`, a plain `path.join`) is not. When
 * any ancestor is a symlink the two strings differ for the *same* directory,
 * and a raw `===` would report a registered, locked worktree as unregistered.
 *
 * This is `../effects/git-effect.ts`'s `resolved()` (KAR-07.2, verified there
 * against the `/var` → `/private/var` case macOS worktrees hit constantly),
 * reimplemented rather than imported: that helper is module-private, not
 * exported from `git-effect.ts`, and this module does not otherwise depend on
 * the effects layer. `realpath` on a path that does not exist throws — caught
 * the same way the precedent catches it, by falling back to the raw path,
 * which is exactly right here too: an entry `list()` just reported cannot
 * fail to exist on disk between that call and this one in the ordinary case,
 * and if it somehow does, comparing the raw strings is the same answer this
 * function would have given before symlink-resolution existed at all.
 */
async function resolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** KAR-25.8 — whether `path` is one of `entries`, comparing realpaths so a
 * symlinked ancestor cannot make a registered, locked worktree look like an
 * orphan (Finding 1). `path` is resolved once and reused, rather than
 * resolving it inside the loop, both because it is asked the same question at
 * most `entries.length` times and because the loop's own accumulator would
 * otherwise recompute it once too. */
async function findRegistered(
  entries: readonly WorktreeEntry[],
  path: string,
): Promise<WorktreeEntry | undefined> {
  const wanted = await resolved(path);
  for (const entry of entries) {
    if (entry.path === path || (await resolved(entry.path)) === wanted) return entry;
  }
  return undefined;
}

/**
 * What is sitting at a path, in DeFlow's own words — KAR-26.1 AC4.
 *
 * **Never the entry's own path.** The sentence this replaces was
 * *"already belongs to an unlabeled worktree at `<the same path>`"*, which told
 * an operator that a path belongs to itself and named neither the state nor an
 * owner. Each arm here names something a person can act on: the interrupted
 * removal, the run and node a DeFlow lock declares, or the operator's own words
 * quoted verbatim.
 *
 * The unlocked arm is a *description*, not a refusal — it is what the
 * teardown-completion log line says it is finishing.
 */
export function describeOccupant(entry: WorktreeEntry): string {
  if (!entry.locked) return 'a worktree with no lock, left by an interrupted removal';

  const owner = parseLockReason(entry.lockReason);
  if (owner !== null) return `run ${owner.runId} node ${owner.nodeId}`;
  if (entry.lockReason !== null) return `an operator's own lock, reason "${entry.lockReason}"`;
  return "an operator's own lock, taken with no reason";
}

/** What the *path* is, as opposed to what git says is registered at it —
 * everything the decision needs that the porcelain entry cannot tell it. */
export interface OccupancySite {
  /** @see isSymlink — required rather than optional, because a caller that
   * forgot it would silently get the adopting answer. */
  readonly reachedThroughSymlink: boolean;
}

/** What `provision` does about a worktree already registered at its path. */
export type OccupancyDecision =
  | { readonly kind: 'reuse' }
  | { readonly kind: 'finish-teardown' }
  | { readonly kind: 'refuse'; readonly occupant: string };

/**
 * KAR-25.8 AC1–AC3 and KAR-26.1 AC1–AC3, as one pure function over the
 * porcelain entry `list()` reported.
 *
 * **`entry.locked` is asked first, and the lock reason second.** git prints
 * three shapes and they mean three different things: no `locked` record at all
 * (not locked), `locked` with no value (an operator's `git worktree lock` with
 * no `--reason`), and `locked <reason>`. `parseLockReason` maps the first two to
 * the same `null`, so a decision keyed on the reason would adopt — and destroy —
 * a worktree an operator deliberately locked. Only *not locked* is adopted, and
 * only at a path this very run and node derive for themselves, which is what
 * makes adoption a finished teardown rather than a squatter being evicted.
 */
export function occupancyDecision(
  request: { readonly runId: string; readonly nodeId: string },
  entry: WorktreeEntry,
  site: OccupancySite,
): OccupancyDecision {
  // Neither arm below survives a symlink. Adoption rests on the path being
  // derived rather than found, and reuse would return `request.path` as the
  // worktree's own — a ledger record of a directory the node's files are not
  // in. Refusing is the F5.6 posture the rest of this module takes: DeFlow does
  // not act on a worktree it cannot show it provisioned.
  if (site.reachedThroughSymlink) {
    return {
      kind: 'refuse',
      occupant:
        `the worktree at "${entry.path}", which this path is only a symlink to — ` +
        describeOccupant(entry),
    };
  }

  if (!entry.locked) return { kind: 'finish-teardown' };

  const owner = parseLockReason(entry.lockReason);
  if (owner !== null && owner.runId === request.runId && owner.nodeId === request.nodeId) {
    return { kind: 'reuse' };
  }
  return { kind: 'refuse', occupant: describeOccupant(entry) };
}

/** Everything but `refreshedAt`, which changes on every refresh and would make
 * every refresh look like a change. */
const comparable = (row: WorktreeRow): string => JSON.stringify({ ...row, refreshedAt: 0 });

/** KAR-26.1 — finishing somebody's interrupted teardown is a thing an operator
 * should be able to find in the log afterwards, and it appends no event of its
 * own: `workspace.worktree_removed` records the removal, not why it ran now. */
const workspace = log.child({ mod: 'workspace' });

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
   *
   * **KAR-25.8** — `git worktree add` only runs against a path nothing holds.
   * `occupancyDecision` decides from `list()` and the lock reason whether a
   * registered entry is the node's own worktree (reused) or somebody else's
   * (refused); a directory git has no record of at all is pruned and removed
   * first, and provisioning proceeds exactly as it would have for a path that
   * was never there.
   *
   * **KAR-26.1** — and a registered entry that is *not locked* is neither of
   * those. It is a §4.4 teardown that stopped part-way, at a path namespaced by
   * this very run and node, so it is finished here and the `worktree add`
   * below then runs against a path that is genuinely free.
   *
   * **git's registry is read first, and the filesystem only after** — never the
   * other way round, because a registered worktree whose *directory* is gone is
   * invisible to a filesystem check and fatal to an `add`. That state is not
   * exotic: `worktree remove` deletes the working directory **before** it
   * clears the administrative entry, so a kill inside that window leaves
   * exactly it, and so does an operator's own `rm -rf` of a worktree they were
   * done with. git keeps listing the entry (marked `prunable`) and refuses
   * every later `add` with `is a missing but already registered worktree` —
   * deterministically, for ever. The cost is one `worktree list` per provision,
   * shared with the branch pre-check rather than read twice.
   */
  async provision(request: ProvisionRequest): Promise<ProvisionResult> {
    const entries = await this.list();
    if (request.mode === 'write') await this.#assertBranchFree(request, entries);

    const registered = await findRegistered(entries, request.path);
    if (registered !== undefined) {
      const decision = occupancyDecision(request, registered, {
        reachedThroughSymlink: await isSymlink(request.path),
      });
      if (decision.kind === 'reuse') return this.#reuse(request);
      if (decision.kind === 'refuse') {
        throw new WorktreePathOccupiedError(request.path, decision.occupant);
      }
      // Falls through to `worktree add`, and deliberately not into the orphan
      // branch below: `remove` has already taken both the git registration and
      // the directory, and the prune is for paths git never knew about.
      await this.#finishInterruptedTeardown(request, registered);
    } else if (await pathExists(request.path)) {
      // AC4 — on disk, but git's own list never heard of it: a crash between
      // the directory being made and the ledger append landing, not a live
      // worktree. `prune` cannot remove anything locked, so this is safe even
      // though it is unscoped — whatever it clears was already dead.
      await this.#ports.git.run(WORKTREE_PRUNE_ORPHAN_ARGS);
      await rm(request.path, { recursive: true, force: true });
    }

    const result = await this.#ports.git.run(await this.#addArgs(request));
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
   * §4.1's argv — `-b <branch>` to make the branch, or the attach form to
   * re-enter one that is already there (KAR-26.1 AC1).
   *
   * A read node never asks: `--detach` claims no branch, so there is nothing
   * for it to collide with. A write node's branch, though, is `nodeBranch`'s
   * deterministic function of its run and node ids, and §4.4 deliberately keeps
   * a branch when it removes its worktree — so by the time a node provisions a
   * second time, for any reason, the name `-b` would create is already taken
   * and git refuses. The alternatives are to delete the branch (which is the
   * node's deliverable, and after an interrupted teardown holds the WIP salvage
   * commit as well) or to invent a second name (which leaves the run's work in
   * two places nobody looks). Re-entering it is the only one that keeps both.
   *
   * `branchTip` is the existing question, asked of git rather than of a flag
   * this code carried down from the decision above: the branch may exist
   * because the leftover was on it, or because a previous *completed* teardown
   * kept it and the worktree is long gone.
   */
  async #addArgs(request: ProvisionRequest): Promise<readonly string[]> {
    if (request.mode === 'read') return worktreeAddArgs(request);
    const existing = await branchTip(this.#ports.git, request.branch);
    return existing === null ? worktreeAddArgs(request) : worktreeAttachArgs(request);
  }

  /**
   * KAR-26.1 AC1 — the removal §4.4 started and never finished, finished.
   *
   * `this.remove()` rather than a second removal sequence written here: the
   * dirty path's capture-commit-force order, its durability check, and the
   * single `--force` that is only reachable through it are all KAR-07.4's, and
   * duplicating them is how the salvage stops being the only way to a force.
   *
   * The branch is the **entry's own**, read back out of the porcelain rather
   * than taken from `request`: a leftover may be checked out on a branch a
   * previous attempt made, and `remove` uses it both for the tip oid it records
   * and as the salvage commit's target. A detached leftover (every recon node)
   * passes none, so `remove`'s AC6 path lands the commit on a throwaway ref.
   *
   * `salvageBranch` is composed here and passed in for the reason
   * `RemoveRequest.salvageBranch` exists at all: a `RunId` is
   * `run_YYYYMMDDTHHMMSSZ_<hex>`, whose `T` and `Z` are uppercase, and
   * `BRANCH_SAFE` is lowercase-only — so `remove`'s own fallback throws
   * `UnsafeRefError` for **every run in existence** and leaves the worktree
   * present and dirty, which is the loop this story is closing rather than a
   * safe failure. `runRef` is the one sanctioned transformation
   * (./branch-name.ts), and this composes the ref exactly as
   * ../pipeline/live-nodes.ts already does for a completing node.
   */
  async #finishInterruptedTeardown(request: ProvisionRequest, entry: WorktreeEntry): Promise<void> {
    workspace.info(
      { runId: request.runId, node: request.nodeId, path: request.path },
      `the path for ${request.nodeId} holds ${describeOccupant(entry)}; finishing that removal ` +
        'before the node is provisioned again',
    );

    await this.remove({
      runId: request.runId,
      nodeId: request.nodeId,
      path: request.path,
      salvageBranch: salvageBranch(runRef(request.runId), request.nodeId),
      ...(entry.branch === null ? {} : { branch: shortBranch(entry.branch) }),
    });
  }

  /**
   * KAR-25.8 AC1, AC2 — the path `provision` was asked for is this run and
   * node's own locked worktree. `parseLockReason` is `lockReasonFor`'s exact
   * inverse (../git/worktree-args.ts), so the identity checked in
   * `occupancyDecision` is the one §4.1 locked the worktree with, read back
   * rather than re-derived.
   *
   * Same path, same branch, same lock reason, and `workspace.worktree_reused`
   * instead of a second `_created`: two `_created` events for one node would
   * make the ledger claim two worktrees where there is one.
   */
  #reuse(request: ProvisionRequest): ProvisionResult {
    const branch = request.mode === 'write' ? request.branch : null;
    const lockReason = lockReasonFor(request.runId, request.nodeId);
    this.#append(request.runId, request.nodeId, 'workspace.worktree_reused', {
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
   * §4.4 — dirtiness is decided **first**, and everything else follows from it.
   *
   * The clean path is KAR-07.2's happy path unchanged (AC7): unlock, then
   * remove, never `--force`. The dirty path is KAR-07.4's salvage sequence:
   * capture, commit, and only then a single force, in that order and no other.
   *
   * Asking `status --porcelain=v2 -z` up front, rather than running `remove`
   * and reading its error, is the same decision the occupancy pre-check makes
   * for `add` (§3.1): the failure string
   * (`contains modified or untracked files, use --force to delete it`) is one
   * git release from changing, and a design that branches on it would one day
   * decide every worktree is clean and force-remove them all. It also makes
   * AC5 fall out for free — a worktree holding only `node_modules/` reports no
   * entries at all, so nothing special-cases gitignored files anywhere.
   *
   * The tip is read *before* the removal, so the event records what the node
   * actually produced even though the worktree is about to stop existing. The
   * unlock's exit code is ignored on purpose: a worktree that is not locked —
   * one an operator already unlocked, say — makes `unlock` exit non-zero, and
   * that is the state this call wanted anyway.
   */
  async remove(request: RemoveRequest): Promise<RemoveResult> {
    // A worktree whose directory is already gone has no work to salvage, and
    // `status` cannot be asked about it at all — it runs *inside* the worktree,
    // and a directory that is not there cannot be a cwd. This is the state a
    // removal interrupted after git deleted the directory and before it cleared
    // the registration leaves, and the removal below is what clears it: `git
    // worktree remove` on a missing-but-registered worktree exits 0 and takes
    // the administrative entry with it (verified on git 2.43.0).
    const entries = (await pathExists(request.path)) ? await this.#captureStatus(request.path) : [];
    const salvage = isDirty(entries) ? await this.#salvage(request, entries) : null;

    const branch = request.branch ?? null;
    const tipOid = branch === null ? null : await branchTip(this.#ports.git, branch);

    await this.#ports.git.run(worktreeUnlockArgs(request.path));
    const removeArgs =
      salvage === null ? worktreeRemoveArgs(request.path) : salvagedRemoveArgs(request.path);
    const removed = await this.#ports.git.run(removeArgs);
    if (removed.exitCode !== 0) throw new WorktreeRemovalRefused(request.path, removed);

    this.#append(request.runId, request.nodeId, 'workspace.worktree_removed', {
      node: request.nodeId,
      path: request.path,
      branch,
      tipOid,
    });

    return { path: request.path, branch, tipOid, salvage };
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
    const next = entries.map((entry) => worktreeRowFor(entry, now));

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

  /** §4.4 step 1's read, run **inside** the worktree — `status` reports on the
   * checkout it is run in, and the main repository's own cleanliness has
   * nothing to do with whether this worktree may be removed. */
  async #captureStatus(path: string): Promise<StatusEntry[]> {
    const result = await this.#ports.git.run(STATUS_ARGS, { cwd: path });
    if (result.exitCode !== 0) throw new WipSalvageFailed('status', path, result.stderr);
    return parseStatusPorcelainV2(result.stdout);
  }

  /**
   * §4.4's dirty path (KAR-07.4 AC1–AC4, AC6), in the order that is the story:
   *
   * 1. `workspace.dirty_on_remove` — the evidence, appended while the worktree
   *    is still dirty and still on disk.
   * 2. `add -A`, `commit -m "DeFlow: WIP salvage"` — the untracked file
   *    included, because it is exactly what a blind force would have destroyed.
   * 3. For a detached checkout, a throwaway branch created *at* that commit,
   *    because a detached HEAD leaves nothing for the work to be found by.
   * 4. `workspace.wip_salvaged`, **read back out of SQLite** before returning.
   *
   * Step 4 is not ceremony. AC4 says force is reachable only once the salvage
   * event is durable, and the only way to know a row is durable is to read it
   * back from the database rather than to trust the `seq` an uncommitted
   * transaction handed out. Every failure in here throws, which leaves the
   * worktree present, dirty, and un-forced.
   */
  async #salvage(request: RemoveRequest, entries: readonly StatusEntry[]): Promise<SalvageResult> {
    const { runId, nodeId, path } = request;
    this.#append(runId, nodeId, 'workspace.dirty_on_remove', { node: nodeId, path, entries });

    const staged = await this.#ports.git.run(salvageAddArgs(), { cwd: path });
    if (staged.exitCode !== 0) throw new WipSalvageFailed('add', path, staged.stderr);

    const committed = await this.#ports.git.run(salvageCommitArgs(), { cwd: path });
    if (committed.exitCode !== 0) {
      // A repository-authored `pre-commit` hook is the expected way to get
      // here. @see ./worktree-salvage.ts on why hooks are not suppressed.
      throw new WipSalvageFailed('commit', path, `${committed.stdout}\n${committed.stderr}`);
    }

    const resolved = await this.#ports.git.run(['rev-parse', 'HEAD'], { cwd: path });
    const oid = resolved.stdout.trim();
    if (resolved.exitCode !== 0 || oid === '') {
      throw new WipSalvageFailed('resolve', path, resolved.stderr);
    }

    // A detached checkout has no branch for the commit to advance, so the
    // commit is made first and a throwaway ref is created *at* it (AC6).
    const nodeOwnBranch = request.branch;
    const detached = nodeOwnBranch === undefined;
    const branch = nodeOwnBranch ?? (await this.#createSalvageBranch(request, oid));

    const seq = this.#append(runId, nodeId, 'workspace.wip_salvaged', {
      node: nodeId,
      path,
      branch,
      detached,
      oid,
      files: entries.length,
    });
    this.#assertDurable(seq, runId, 'workspace.wip_salvaged', path);

    return { branch, detached, oid, entries };
  }

  /** AC6 — the throwaway ref a detached checkout's commit is made reachable by,
   * created at the commit rather than checked out before it. */
  async #createSalvageBranch(request: RemoveRequest, oid: string): Promise<string> {
    const branch = request.salvageBranch ?? salvageBranch(request.runId, request.nodeId);

    const created = await this.#ports.git.run(salvageBranchArgs(branch, oid));
    if (created.exitCode !== 0) throw new WipSalvageFailed('branch', request.path, created.stderr);
    return branch;
  }

  /**
   * AC4's precondition, made mechanical: the event is read back out of SQLite,
   * so `--force` is unreachable from a life in which the append did not commit.
   */
  #assertDurable(seq: EventSeq, runId: string, kind: string, path: string): void {
    const readBack = readRange(this.#ports.db, runId as RunId, seq - 1, 1).events.at(0);
    if (readBack === undefined || readBack.seq !== seq || readBack.kind !== kind) {
      throw new WipSalvageFailed(
        'durability',
        path,
        `the ${kind} event at seq ${seq} could not be read back, so --force was not reached`,
      );
    }
  }

  /** AC3, AC4 — the pre-check, from git's list and nothing else. The event is
   * appended before the throw, so the refusal is in the run's history whether
   * or not anything catches the error.
   *
   * KAR-25.8 — an occupant at *this call's own target path* is not a
   * conflict: it is either this node's own prior worktree (a retry after a
   * failure) or somebody else's registered at the exact path this request
   * asked for, and either way `provision`'s own path check, right after this
   * one returns, is what decides — reuse or `WorktreePathOccupiedError` —
   * from the lock reason rather than from branch uniqueness. Without this,
   * every retry of a write node would refuse itself: the branch a prior
   * attempt created is, by construction, still checked out at the path the
   * retry is about to reuse. */
  async #assertBranchFree(
    request: ProvisionWrite,
    entries: readonly WorktreeEntry[],
  ): Promise<void> {
    const occupant = findOccupant(entries, request.branch);
    if (occupant === null) return;
    const isSelf =
      occupant.path === request.path ||
      (await resolved(occupant.path)) === (await resolved(request.path));
    if (isSelf) return;

    this.#append(request.runId, request.nodeId, 'workspace.branch_occupied', {
      node: request.nodeId,
      branch: shortBranch(request.branch),
      occupiedBy: occupant.path,
      occupantKind: occupant.kind,
    });
    throw new BranchOccupiedError(shortBranch(request.branch), occupant.path, occupant.kind);
  }

  /** One event, in this daemon life's epoch, attributed to a node. Returns the
   * `seq` SQLite assigned it, which is what `#assertDurable` reads back. */
  #append(runId: string, nodeId: string, kind: string, payload: unknown): EventSeq {
    return this.#appendDraft({
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

  #appendDraft(draft: EventDraft): EventSeq {
    const [seq] = appendEvents(this.#ports.db, [draft]);
    if (seq === undefined) throw new Error(`appendEvents returned no seq for ${draft.kind}`);
    return seq;
  }
}
