/**
 * KAR-07.8 — the worktree half of boot reaping
 * (docs/09-workspace-and-safety.md §4.5, §11.3 steps 3–4).
 *
 * `../reaper.ts` deals with the *processes* a dead daemon left running. This
 * deals with what they were holding: a `git worktree lock` is a file in the
 * repository and nothing releases it when its holder dies, and **locked
 * worktrees are immune to `prune`** (§4.2). So a `kill -9` of DeFlowd leaves a
 * repository that accumulates locked worktrees no amount of pruning will ever
 * touch — which is the failure this module exists to stop.
 *
 * **The order is load-bearing: reap, then unlock, then prune.** Pruning before
 * unlocking is not merely ineffective, it is a no-op that *looks like success*
 * — git exits 0 and says nothing. `test/integration/worktree-reaping.test.ts`
 * pins that against real git rather than trusting the sentence.
 *
 * One rule decides everything here:
 *
 * > A worktree DeFlow owns is touched only when its owning process is
 * > **provably gone** — pid *and* the process start time recorded at spawn,
 * > never bare liveness (§11.3 step 1).
 *
 * The rule is stated as a property of the worktree rather than as a consequence
 * of what `reapOrphans` decided a moment earlier, and that is deliberate. It
 * makes "never destroy a live agent's workspace" true even when the kill did
 * not take, even when the row was already terminal, and — the case that will
 * matter — even when EPIC-06 grows an adoption path and the correct response to
 * a healthy orphan becomes reattaching to its output rather than destroying an
 * hour of work. `detached: true` means the agent genuinely outlived DeFlowd;
 * the sweep's whole job for that one is to leave it alone.
 *
 * Two verified findings shape the implementation, both from git 2.50.1 on
 * 2026-08-06:
 *
 * 1. A **locked** worktree whose directory was removed is not reported
 *    `prunable` at all. Unlocking is what makes it prunable — §4.5's ordering,
 *    verified rather than assumed.
 * 2. `--expire 2.weeks.ago` **narrows** prune rather than widening it: bare
 *    `prune` uses `TIME_MAX`, and an expiry restricts removal to administrative
 *    entries whose `index` has not been touched since. The boot prune is
 *    therefore a conservative sweep of long-dead entries, and the instrument
 *    that reclaims a *fresh* orphan is `remove -f -f` — which is exactly the
 *    call `../git/worktree-force-remove.ts` exists to keep off every other path.
 *
 * Nothing in here throws on the boot path. A repository that has been moved,
 * deleted or was never a repository is reported and skipped: a daemon that
 * refused to start because one of the repositories it once ran in is gone is a
 * worse failure than a worktree left listed.
 *
 * Verifies: EPIC-07-S29, EPIC-07-S31, EPIC-07-S32 · AC1–AC7
 */
import { processStartTime } from '@DeFlow/adapters';
import type { Clock, Db, NodeId, RunId } from '@DeFlow/core';
import {
  appendEvents,
  type ProcessRow,
  readProcesses,
  replaceWorktrees,
  type WorktreeRow,
} from '@DeFlow/ledger';
import {
  parseLockReason,
  WORKTREE_LIST_ARGS,
  WORKTREE_PRUNE_ARGS,
  worktreeUnlockArgs,
} from '../git/worktree-args.ts';
import { reaperForceRemoveArgs } from '../git/worktree-force-remove.ts';
import type { WorkspaceGit } from '../git/worktree-manager.ts';
import { parseWorktreeList, type WorktreeEntry } from '../git/worktree-porcelain.ts';
import { worktreeRowFor } from '../git/worktree-projection.ts';
import { log } from '../logging.ts';

const sweeper = log.child({ mod: 'worktree-reaper' });

/** One repository to sweep, and the `Git` chokepoint bound to it. */
export interface ReapRepo {
  readonly repoRoot: string;
  readonly git: WorkspaceGit;
}

export interface WorktreeReapPorts {
  readonly db: Db;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** This daemon life's epoch, stamped on the events the sweep appends. */
  readonly epoch: number;
  /** Every repository DeFlow has runs in. Empty is a valid answer. */
  readonly repos: readonly ReapRepo[];
  /** Defaults to reading the OS. @see processStartTime */
  readonly startTime?: (pid: number) => string | null;
  /** Every decision, for an operator log a spec can also read. */
  readonly onDecision?: (fields: Record<string, unknown>, message: string) => void;
}

/** What the sweep did about one listed worktree. */
export type WorktreeReapAction =
  /** DeFlow's, owner provably gone: unlocked and removed with `remove -f -f`. */
  | 'reaped'
  /** DeFlow's, owner verifiably alive: not unlocked, not removed, not pruned. */
  | 'adopted'
  /**
   * DeFlow's and reapable, but git would not remove it.
   *
   * Its own answer rather than a second meaning for `adopted`, which would tell
   * an operator that a live agent owns a worktree nothing owns. The lock has
   * been released by this point, so the entry becomes prunable and a later boot
   * — or `prune` once it expires — reaches it without anything being retried
   * here. A boot is not the place to fight the filesystem.
   */
  | 'refused'
  /** Not DeFlow's — the main checkout, an operator's own worktree, or a lock
   * whose reason DeFlow did not write. Left to `prune` and to its owner. */
  | 'not-ours';

export interface WorktreeReapDecision {
  readonly repoRoot: string;
  readonly path: string;
  /** From DeFlow's own lock reason, or from the `process` row that named the
   * path; `null` when the worktree is not DeFlow's. */
  readonly runId: string | null;
  readonly nodeId: string | null;
  readonly action: WorktreeReapAction;
  /** The owning process, when one was ever recorded. */
  readonly pid: number | null;
}

/** One `Removing worktrees/<name>: <reason>` line of `prune -v`. */
export interface PrunedEntry {
  readonly name: string;
  readonly reason: string;
}

export interface WorktreeReapReport {
  /** One per listed worktree, every repository, in the order git listed them. */
  readonly decisions: readonly WorktreeReapDecision[];
  readonly pruned: readonly PrunedEntry[];
  /** `prune -v`'s stdout, joined across repositories — the evidence for AC4. */
  readonly pruneOutput: string;
  /** Repositories `worktree list` could not be run in. Reported, never thrown. */
  readonly unreadable: readonly string[];
  /** The projection as it stands after the sweep. */
  readonly worktrees: readonly WorktreeRow[];
}

/** `Removing worktrees/<name>: <reason>` — `-v`'s one output shape. */
const PRUNED_LINE = /^Removing worktrees\/(?<name>[^:]+): (?<reason>.+)$/;

function parsePruneOutput(stdout: string): PrunedEntry[] {
  const pruned: PrunedEntry[] = [];
  for (const line of stdout.split('\n')) {
    const groups = PRUNED_LINE.exec(line.trim())?.groups;
    if (groups?.name === undefined || groups.reason === undefined) continue;
    pruned.push({ name: groups.name, reason: groups.reason });
  }
  return pruned;
}

/**
 * Who a listed worktree belongs to, from the two records that can say so.
 *
 * The lock reason is the primary evidence and needs no side table — but it only
 * exists while the worktree is *locked*, and `reapOrphans` releases the lock of
 * a row whose process is gone before this sweep ever runs. The `process` row's
 * `worktree` column is what keeps the worktree identifiable after that.
 */
interface Owner {
  readonly runId: string;
  readonly nodeId: string;
}

/** Every `process` row that ever named a worktree, newest spawn last. */
function ownersByPath(rows: readonly ProcessRow[]): Map<string, Owner> {
  const byPath = new Map<string, Owner>();
  for (const row of rows) {
    if (row.worktree === null) continue;
    byPath.set(row.worktree, { runId: row.runId, nodeId: row.nodeId });
  }
  return byPath;
}

/**
 * §11.3 step 1, asked about a *worktree* rather than about a row.
 *
 * Every attempt of the node is consulted, because a retried node has one
 * `process` row per attempt and any one of them still running means the
 * checkout is in use. A row with no recorded start time can never make this
 * true: "we could not verify it" and "it is not the process we meant" have the
 * same correct answer, and it is not to send a signal — but for a *worktree*
 * the conservative answer flips. Nothing is proven gone, so nothing is removed.
 */
function livingOwner(
  rows: readonly ProcessRow[],
  owner: Owner,
  startTime: (pid: number) => string | null,
): { readonly alive: boolean; readonly pid: number | null; readonly verifiable: boolean } {
  let pid: number | null = null;
  let verifiable = true;

  for (const row of rows) {
    if (row.runId !== owner.runId || row.nodeId !== owner.nodeId) continue;
    pid = row.pid;
    if (row.startedAt === null) {
      verifiable = false;
      continue;
    }
    if (startTime(row.pid) === row.startedAt)
      return { alive: true, pid: row.pid, verifiable: true };
  }

  return { alive: false, pid, verifiable };
}

/**
 * Sweeps every repository: unlock and remove what a dead daemon left behind,
 * then prune, then make the `worktrees` projection equal to what git now says.
 *
 * The projection is written **once**, from the union of every repository's
 * final list, because `replaceWorktrees` makes the table equal to its argument
 * — one call per repository would leave the last repository's worktrees as the
 * whole table, which is the kind of bug that only shows up on the second
 * repository somebody adds.
 */
export async function reapWorktrees(ports: WorktreeReapPorts): Promise<WorktreeReapReport> {
  const startTime = ports.startTime ?? ((pid: number) => processStartTime(pid));
  const report =
    ports.onDecision ??
    ((fields: Record<string, unknown>, message: string) => {
      sweeper.info(fields, message);
    });

  // Read once: the answer to "whose is this, and is it alive?" is asked of
  // every listed worktree, and the table is the same for all of them.
  const processRows = readProcesses(ports.db);
  const owners = ownersByPath(processRows);
  const decisions: WorktreeReapDecision[] = [];
  const pruned: PrunedEntry[] = [];
  const unreadable: string[] = [];
  const pruneOutputs: string[] = [];
  const rows: WorktreeRow[] = [];

  for (const repo of ports.repos) {
    const listed = await list(repo);
    if (listed === null) {
      unreadable.push(repo.repoRoot);
      report({ repoRoot: repo.repoRoot }, `no worktree list could be read for ${repo.repoRoot}`);
      continue;
    }

    // 1 and 2. Every worktree DeFlow owns whose process did not survive:
    // unlock, then the double force. Never in the other order, and never at
    // all while anything at that pid is still verifiably ours.
    //
    // `slice(1)`: the first entry git prints is the **main checkout** — the
    // repository this command ran in, the operator's own working copy — and it
    // is never a candidate for anything here. Skipping it by position rather
    // than by comparing paths is what `findOccupant` already does, and it does
    // not need `realpath` to be right about `/var` versus `/private/var`.
    for (const entry of listed.slice(1)) {
      const decision = await sweepOne(
        entry,
        repo,
        { owners, processRows },
        ports,
        startTime,
        report,
      );
      decisions.push(decision);
    }

    // 3. Only now, and once per repository (§4.5).
    //
    // **`prune -v` reports on stderr, not stdout** (verified on git 2.50.1,
    // 2026-08-06). Reading only stdout gives an empty string and therefore a
    // sweep that silently believes it removed nothing — so both streams are
    // kept, and both are parsed.
    const output = await repo.git.run(WORKTREE_PRUNE_ARGS);
    const said = [output.stdout, output.stderr].filter((stream) => stream !== '').join('\n');
    pruneOutputs.push(said);
    for (const entry of parsePruneOutput(said)) {
      pruned.push(entry);
      report({ repoRoot: repo.repoRoot, ...entry }, `git pruned worktrees/${entry.name}`);
    }

    // 4. Git is the authority; the table is an index over it (§4.3).
    const after = await list(repo);
    const now = ports.clock.now();
    for (const entry of after ?? []) rows.push(worktreeRowFor(entry, now));
  }

  replaceWorktrees(ports.db, rows);

  return {
    decisions,
    pruned,
    pruneOutput: pruneOutputs.join('\n'),
    unreadable,
    worktrees: rows,
  };
}

async function list(repo: ReapRepo): Promise<WorktreeEntry[] | null> {
  const result = await repo.git.run(WORKTREE_LIST_ARGS).catch(() => null);
  if (result === null || result.exitCode !== 0) return null;
  return parseWorktreeList(result.stdout);
}

interface ProcessView {
  readonly owners: Map<string, Owner>;
  readonly processRows: readonly ProcessRow[];
}

async function sweepOne(
  entry: WorktreeEntry,
  repo: ReapRepo,
  processes: ProcessView,
  ports: WorktreeReapPorts,
  startTime: (pid: number) => string | null,
  report: (fields: Record<string, unknown>, message: string) => void,
): Promise<WorktreeReapDecision> {
  const owner = parseLockReason(entry.lockReason) ?? processes.owners.get(entry.path) ?? null;

  const base = { repoRoot: repo.repoRoot, path: entry.path } as const;
  if (owner === null || entry.bare) {
    return { ...base, runId: null, nodeId: null, action: 'not-ours', pid: null };
  }

  const living = livingOwner(processes.processRows, owner, startTime);
  const fields = {
    ...base,
    runId: owner.runId,
    nodeId: owner.nodeId,
    pid: living.pid,
    locked: entry.locked,
    prunable: entry.prunable,
  };

  if (living.alive || !living.verifiable) {
    // Alive, or unverifiable — which for a *worktree* is the same answer.
    // Removing a checkout something might still be writing to is not a
    // recoverable mistake, and the adoption path (EPIC-06) is what turns this
    // from "left behind" into "reattached to".
    report(
      fields,
      living.alive
        ? `${entry.path} is still owned by a live process, so it was left untouched`
        : `${entry.path} has an owner whose start time was never recorded, so it was left alone`,
    );
    return {
      ...base,
      runId: owner.runId,
      nodeId: owner.nodeId,
      action: 'adopted',
      pid: living.pid,
    };
  }

  // Unlock first — locked worktrees are immune to prune, and `remove` refuses
  // one outright without the second force. The exit code is ignored: a worktree
  // that was not locked makes `unlock` exit non-zero, and that is the state
  // this call wanted anyway.
  await repo.git.run(worktreeUnlockArgs(entry.path));
  const removed = await repo.git.run(reaperForceRemoveArgs(entry.path));
  if (removed.exitCode !== 0) {
    report(
      { ...fields, stderr: removed.stderr.trim() },
      `could not remove the orphaned worktree ${entry.path}; prune will retry it once it expires`,
    );
    return {
      ...base,
      runId: owner.runId,
      nodeId: owner.nodeId,
      action: 'refused',
      pid: living.pid,
    };
  }

  appendEvents(ports.db, [
    {
      runId: owner.runId as RunId,
      ts: ports.clock.now(),
      kind: 'workspace.orphan_reaped',
      v: 1,
      epoch: ports.epoch,
      nodeId: owner.nodeId as NodeId,
      payload: { node: owner.nodeId, path: entry.path, pid: living.pid },
    },
  ]);
  report(fields, `reaped the orphaned worktree ${entry.path}`);

  return { ...base, runId: owner.runId, nodeId: owner.nodeId, action: 'reaped', pid: living.pid };
}
