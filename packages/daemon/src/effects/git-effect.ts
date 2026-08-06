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
import type { Effect, EffectCtx, ReconcileProbe } from './durable.ts';
import {
  type CommandResult,
  classifyWorktreeAdd,
  commitArgs,
  commitShaFrom,
  findCommitArgs,
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

/** Whether `path` really is a registered worktree on `branch`, per git. */
async function worktreeIsAt(ports: GitEffectPorts, path: string, branch: string): Promise<boolean> {
  const listed = await ports.run(['worktree', 'list', '--porcelain']);
  if (listed.exitCode !== 0) return false;

  const wanted = await resolved(path);
  let current: string | null = null;

  for (const line of listed.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      const at = line.slice('worktree '.length);
      current = at === path || (await resolved(at)) === wanted ? at : null;
      continue;
    }
    if (current !== null && line.startsWith('branch ')) {
      return line.slice('branch '.length) === `${HEAD_REF}${branch}`;
    }
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
