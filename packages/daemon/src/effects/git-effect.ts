/**
 * KAR-06.4 — the two `git` effects, each made idempotent in the way that is
 * actually true for it (docs/05-durable-execution.md §8.3, EPIC-06-S13).
 *
 * **The commit** is the one genuinely non-idempotent git operation, and it is
 * fixed by a trailer rather than by a journal: the ikey travels *inside the
 * commit message*, so the question "did my commit land?" is answered by the
 * repository itself, by the same `--grep` on any machine, for ever. A journal
 * could only ever answer "I wrote down that I was about to".
 *
 * **The worktree add** needs no probe at all, which is why `reconcile` returns
 * `not-started` unconditionally: re-running it is safe by construction,
 * because a `worktree add` that fails with `already exists` for the path this
 * effect asked for *is* the state this effect wanted. The subtlety is that
 * "already exists" and "already used by worktree at" are different worlds —
 * the first is this effect's own previous life, the second is another worktree
 * holding the branch, and mapping it to success would hand the node somebody
 * else's working tree. So the success mapping is confirmed against
 * `git worktree list --porcelain` before it is believed.
 *
 * The `run` port rather than importing `runGit` directly: these effects are
 * per-repository, the wrapper is per-call, and a test drives real `git`
 * through a hermetic environment. It is the same seam KAR-07.1's `Git` class
 * will slot into.
 *
 * Verifies: EPIC-06-S13, EPIC-06-S16 (git rows) · AC7
 */
import type { NodeId, RunId } from '@DeFlow/core';
import { NodeFailureError } from '@DeFlow/core';
import { realpath } from 'node:fs/promises';
import { WORKTREE_LIST_ARGS } from '../git/worktree-args.ts';
import { parseWorktreeList } from '../git/worktree-porcelain.ts';
import type { Effect, EffectCtx, ReconcileProbe } from './durable.ts';
import {
  type CommandResult,
  classifyWorktreeAdd,
  commitArgs,
  commitShaFrom,
  findCommitArgs,
  mergeArgs,
  type WorktreeAddOutcome,
} from './reconcile/git.ts';

/** What every git effect is given: a way to run git in one repository. */
export interface GitEffectPorts {
  run(args: readonly string[]): Promise<CommandResult>;
}

interface GitEffectIdentity {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
  readonly ordinal?: number;
  readonly requestHash: string;
}

/**
 * A git command that failed for a reason this layer has no opinion about.
 *
 * `internal` and `permanent`: the taxonomy has no `git.*` reason, and inventing
 * a class would be the layering violation the taxonomy exists to prevent — the
 * thrower supplies the class, and a git command that refused an argument will
 * refuse it identically on the next attempt.
 */
function gitFailed(what: string, result: CommandResult): NodeFailureError {
  const message = `${result.stderr}\n${result.stdout}`.trim();
  return new NodeFailureError(`${what} exited ${result.exitCode}: ${message}`, {
    reason: 'internal',
    class: 'permanent',
    detail: { exitCode: result.exitCode, stderr: result.stderr, stdout: result.stdout },
  });
}

export interface GitCommitInput extends GitEffectIdentity {
  /** The commit subject. The trailer is added by the effect, never by the
   * caller — a caller that wrote its own could get the ikey wrong. */
  readonly subject: string;
}

/**
 * `git commit -m "<subject>" -m "DeFlow-Effect-Id: <ikey>"`, reconciled by
 * `git log --grep` (AC7).
 *
 * The sha is resolved through the *same* `--grep` the probe uses, not through
 * `rev-parse HEAD`. Two reasons, and the second is the real one: `HEAD` after
 * a commit is a different question from "which commit carries my ikey", and
 * asking the probe's question on the happy path is what keeps the probe
 * honest — a trailer that had stopped being greppable would fail here, on the
 * first run, instead of a month later during a recovery nobody is watching.
 */
export function gitCommitEffect(input: GitCommitInput, ports: GitEffectPorts): Effect<string> {
  const find = async (ikey: string): Promise<string | null> =>
    commitShaFrom(await ports.run(findCommitArgs(ikey)));

  return {
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    kind: 'git',
    requestHash: input.requestHash,

    async perform(ctx: EffectCtx): Promise<string> {
      const result = await ports.run(commitArgs(input.subject, ctx.ikey));
      if (result.exitCode !== 0) throw gitFailed('git commit', result);

      const sha = await find(ctx.ikey);
      if (sha === null) {
        throw new NodeFailureError(
          `git commit succeeded but no commit carries ${ctx.ikey} as a DeFlow-Effect-Id trailer. ` +
            'The trailer is how a restart finds this commit again, so a commit without one is not ' +
            'a commit this system can recover.',
          { reason: 'internal', class: 'permanent', detail: { ikey: ctx.ikey } },
        );
      }
      return sha;
    },

    async reconcile(ctx: EffectCtx): Promise<ReconcileProbe<string>> {
      const sha = await find(ctx.ikey);
      // Found: the commit landed before the crash and its sha is the memoised
      // result. Absent: nothing was committed, and re-committing with the same
      // trailer is safe precisely because this probe will find *that* one.
      return sha === null ? { status: 'not-started' } : { status: 'done', result: sha };
    },
  };
}

export interface GitWorktreeAddInput extends GitEffectIdentity {
  /** Absolute path of the worktree, `.DeFlow/wt/<runId>__<nodeId>`. */
  readonly path: string;
  /** Flat branch name, `DeFlow/<runId>__<nodeId>` (D13). */
  readonly branch: string;
}

export interface WorktreeAddResult {
  readonly path: string;
  readonly branch: string;
  readonly outcome: WorktreeAddOutcome;
}

const HEAD_REF = 'refs/heads/';

/** Paths as git prints them are resolved; ours may run through a symlink —
 * `/var` on macOS is `/private/var`. Comparing the raw strings would report a
 * mismatch for the same directory. */
async function resolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * Whether `path` really is a registered worktree on `branch`, per git.
 *
 * Read through KAR-07.2's `--porcelain -z` parser: the non-porcelain form pads
 * path, oid and branch onto one line with spaces, so a worktree under
 * `~/my projects` would answer this question wrongly rather than failing to
 * answer it — and this question decides whether another node's working tree
 * gets handed to this one (docs/09-workspace-and-safety.md §4.3, AC5).
 */
async function worktreeIsAt(ports: GitEffectPorts, path: string, branch: string): Promise<boolean> {
  const listed = await ports.run(WORKTREE_LIST_ARGS);
  if (listed.exitCode !== 0) return false;

  const wanted = await resolved(path);
  for (const entry of parseWorktreeList(listed.stdout)) {
    if (entry.path !== path && (await resolved(entry.path)) !== wanted) continue;
    return entry.branch === `${HEAD_REF}${branch}`;
  }
  return false;
}

/**
 * `git worktree add`, with "already exists" read as the success it is (AC7).
 *
 * Whether the branch is created or attached is decided by asking git, not by
 * catching an error: `worktree add -b <branch>` against an existing branch
 * fails with *a branch named … already exists*, whose text would sail straight
 * through the path-collision mapping and claim a worktree that is not there.
 */
export function gitWorktreeAddEffect(
  input: GitWorktreeAddInput,
  ports: GitEffectPorts,
): Effect<WorktreeAddResult> {
  return {
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    kind: 'git',
    requestHash: input.requestHash,

    async perform(): Promise<WorktreeAddResult> {
      const branchExists =
        (await ports.run(['rev-parse', '--verify', '--quiet', `${HEAD_REF}${input.branch}`]))
          .exitCode === 0;

      const result = await ports.run(
        branchExists
          ? ['worktree', 'add', input.path, input.branch]
          : ['worktree', 'add', '-b', input.branch, input.path],
      );

      const outcome = classifyWorktreeAdd(result);
      if (outcome === 'created') return { path: input.path, branch: input.branch, outcome };

      if (outcome === 'already-exists' && (await worktreeIsAt(ports, input.path, input.branch))) {
        return { path: input.path, branch: input.branch, outcome };
      }

      // Either a collision git named, or an "already exists" that git's own
      // worktree list does not confirm. Both are failures, and the message
      // carries git's words rather than a paraphrase of them.
      throw gitFailed('git worktree add', result);
    },

    reconcile(): Promise<ReconcileProbe<WorktreeAddResult>> {
      // Idempotent by construction: the cheapest correct probe is to do it
      // again and let `already exists` be the answer.
      return Promise.resolve({ status: 'not-started' });
    },
  };
}

// ── KAR-07.7 — the integration branch and its merges ─────────────────────────

export interface GitIntegrationBranchInput extends GitEffectIdentity {
  /** `DeFlow/int/<runId>`, composed by KAR-07.3's `integrationBranch`. */
  readonly branch: string;
  /** Absolute path of the integration worktree. */
  readonly path: string;
  /** The run's base ref — what the integration branch starts from (AC1). */
  readonly baseRef: string;
  /** `worktree add --reason`'s payload, so `git worktree list` says whose. */
  readonly lockReason: string;
}

export interface IntegrationBranchResult {
  readonly branch: string;
  readonly path: string;
  readonly outcome: WorktreeAddOutcome;
}

/**
 * KAR-07.7 AC1 — `DeFlow/int/<runId>` and its locked worktree, created by one
 * `git worktree add` and journalled (docs/09-workspace-and-safety.md §7.1).
 *
 * One command, for KAR-07.2's reason restated: `add` then `lock` leaves a
 * window in which the boot reaper can prune the worktree the whole run is
 * about to merge into. And one *effect*, because AC1 asks for the branch's
 * creation to be journalled — a run that crashes between creating the branch
 * and scheduling its first node must come back to the branch it already has,
 * not to a second attempt that fails on `already exists` and takes the run
 * down with it.
 *
 * `reconcile` is `not-started` unconditionally for `gitWorktreeAddEffect`'s
 * reason: re-performing is safe by construction here, because `perform` asks
 * git what exists before it asks git to create anything.
 */
export function gitIntegrationBranchEffect(
  input: GitIntegrationBranchInput,
  ports: GitEffectPorts,
): Effect<IntegrationBranchResult> {
  return {
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    kind: 'git',
    requestHash: input.requestHash,

    async perform(): Promise<IntegrationBranchResult> {
      const exists =
        (await ports.run(['rev-parse', '--verify', '--quiet', `${HEAD_REF}${input.branch}`]))
          .exitCode === 0;
      if (exists && (await worktreeIsAt(ports, input.path, input.branch))) {
        return { branch: input.branch, path: input.path, outcome: 'already-exists' };
      }

      const result = await ports.run([
        'worktree',
        'add',
        '--lock',
        '--reason',
        input.lockReason,
        ...(exists ? [] : ['-b', input.branch]),
        '--',
        input.path,
        exists ? input.branch : input.baseRef,
      ]);

      const outcome = classifyWorktreeAdd(result);
      if (outcome === 'created') return { branch: input.branch, path: input.path, outcome };
      if (outcome === 'already-exists' && (await worktreeIsAt(ports, input.path, input.branch))) {
        return { branch: input.branch, path: input.path, outcome };
      }
      throw gitFailed('git worktree add (integration)', result);
    },

    reconcile(): Promise<ReconcileProbe<IntegrationBranchResult>> {
      return Promise.resolve({ status: 'not-started' });
    },
  };
}

export interface GitMergeInput extends GitEffectIdentity {
  /** The node branch being integrated. */
  readonly branch: string;
  /** The merge commit's subject — AC6 requires it to name the run and node. */
  readonly subject: string;
}

/**
 * What one `git merge` attempt did. A conflict is a *result*, not a failure:
 * it is the normal input to §7.2's resolution node, and an effect that threw
 * on it would turn the cheapest branch of the design into an error path.
 */
export type MergeAttempt =
  | { readonly merged: true; readonly commit: string }
  | { readonly merged: false };

/** `git rev-parse --verify --quiet MERGE_HEAD` — whether this worktree is in
 * the middle of a merge right now. */
const MERGE_HEAD_ARGS: readonly string[] = ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'];

/**
 * KAR-07.7 AC6 — `git merge --no-ff -m <subject + trailer> -- <branch>`,
 * reconciled by the same `--grep` a commit is.
 *
 * `--no-ff` is the acceptance criterion, not a preference: a fast-forward
 * merge leaves no commit of its own, so a run whose branches happened to be
 * linear would produce an integration branch whose history cannot say which
 * node contributed what. One merge commit per node branch is the reviewable
 * artefact the whole loop exists to produce.
 *
 * There is deliberately **no strategy option** here. `-X ours`, `-X theirs`
 * and `--strategy=ours` are the blind auto-resolution §7.2 forbids, and their
 * absence is asserted by the integration spec over the recorded argv rather
 * than left to review.
 *
 * **A conflict is left in place, not aborted.** The conflicted worktree *is*
 * the resolution node's workspace (§7.2 puts the node on the integration
 * worktree for exactly this reason): the markers are there, `MERGE_HEAD` is
 * there, and the resolver's own `git commit` therefore produces a real merge
 * commit with the node branch as its second parent, carrying the message —
 * and the ikey trailer — this effect already wrote into `MERGE_MSG`. Aborting
 * and asking the resolver to "produce a commit" instead would leave the node
 * branch permanently unmerged, and no amount of later work would put it into
 * the integration branch's history.
 *
 * That is also why `perform` looks for `MERGE_HEAD` first: a daemon that died
 * mid-conflict comes back to a worktree with a merge already open, and
 * re-issuing `git merge` there fails with *you have not concluded your merge*.
 */
export function gitMergeEffect(input: GitMergeInput, ports: GitEffectPorts): Effect<MergeAttempt> {
  const find = async (ikey: string): Promise<string | null> =>
    commitShaFrom(await ports.run(findCommitArgs(ikey)));

  const merging = async (): Promise<boolean> => (await ports.run(MERGE_HEAD_ARGS)).exitCode === 0;

  return {
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    ...(input.ordinal === undefined ? {} : { ordinal: input.ordinal }),
    kind: 'git',
    requestHash: input.requestHash,

    async perform(ctx: EffectCtx): Promise<MergeAttempt> {
      if (await merging()) return { merged: false };

      const result = await ports.run(mergeArgs(input.subject, ctx.ikey, input.branch));
      if (result.exitCode !== 0) {
        // A conflict leaves MERGE_HEAD behind; anything else did not start a
        // merge at all and is a real failure with git's own words attached.
        if (await merging()) return { merged: false };
        throw gitFailed('git merge --no-ff', result);
      }

      const sha = await find(ctx.ikey);
      if (sha === null) {
        throw new NodeFailureError(
          `git merge succeeded but no commit carries ${ctx.ikey} as a DeFlow-Effect-Id trailer. ` +
            'The trailer is how a restart finds this merge again, so a merge without one is not ' +
            'a merge this system can recover. A branch already contained in the integration ' +
            'branch produces exactly this, and must not reach the merge queue.',
          { reason: 'internal', class: 'permanent', detail: { ikey: ctx.ikey } },
        );
      }
      return { merged: true, commit: sha };
    },

    async reconcile(ctx: EffectCtx): Promise<ReconcileProbe<MergeAttempt>> {
      const sha = await find(ctx.ikey);
      // Found: the merge landed before the crash, whoever committed it. Absent:
      // either nothing happened or a conflict is still open, and `perform`
      // tells those two apart from MERGE_HEAD rather than guessing here.
      return sha === null
        ? { status: 'not-started' }
        : { status: 'done', result: { merged: true, commit: sha } };
    },
  };
}
