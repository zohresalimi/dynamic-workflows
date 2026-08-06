/**
 * EPIC-06-S13 — the `DeFlow-Effect-Id` trailer makes a commit structurally
 * idempotent (KAR-06.4 AC7).
 *
 * Real `git`, real repositories, real worktrees, and two real daemon lives
 * over one file-backed ledger. Nothing here is faked, because every claim is
 * about what `git` itself does: which exit code and which message it produces
 * when a worktree path is taken, and whether `--grep` can find a trailer a
 * previous process wrote. A stubbed git would test its author's memory of
 * those strings — which is precisely what was wrong in the PRD, where the
 * branch-collision message is quoted as "is already checked out at", a string
 * git does not print.
 *
 * Both messages this spec asserts were re-measured against the installed git
 * while it was written:
 *
 *   `fatal: 'wt1' already exists`                    → this effect's own path
 *   `fatal: 'feat' is already used by worktree at …` → somebody else's branch
 *
 * The environment is hermetic (`GIT_CONFIG_GLOBAL=/dev/null`,
 * `GIT_CONFIG_SYSTEM=/dev/null`, forced identity): a developer whose global
 * config sets `commit.gpgsign` or `init.defaultBranch` must not change the
 * result.
 *
 * Verifies: EPIC-06-S12 (git rows), EPIC-06-S13, EPIC-06-S16 · AC7, AC9
 */
import type { NodeId, RunId } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { type EffectRow, openLedger, readEffect, readRange } from '@DeFlow/ledger';
import { GIT_ENV, git, it, makeRepo, TestClock } from '@DeFlow/testkit';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  createEffectRunner,
  type Effect,
  type EffectCtx,
  gitCommitEffect,
  gitWorktreeAddEffect,
  runGit,
} from '../../src/index.ts';

const RUN: RunId = RunIdSchema.parse('run_20260805T141133Z_9f2a1c');
const NODE: NodeId = NodeIdSchema.parse('implement');
const HASH = `sha256-${'a'.repeat(64)}`;
const DAEMON_STARTED_AT = 1_754_313_000_000;
const IKEY = `${RUN}/implement/0/0`;

const openRunner = (dataDir: string, daemonStartedAt = DAEMON_STARTED_AT) => {
  const db = openLedger(dataDir);
  const clock = new TestClock(daemonStartedAt + 1000);
  return { db, clock, runner: createEffectRunner({ db, clock, daemonStartedAt, epoch: 1 }) };
};

/** `git`, hermetic, in `repo` — the same port the effects are given. */
const gitIn = (repo: string) => (args: readonly string[]) => runGit(repo, args, { env: GIT_ENV });

const eventsOf = (db: { prepare: unknown }, kind: string): Record<string, unknown>[] =>
  readRange(db as never, RUN, 0, 500)
    .events.filter((event) => event.kind === kind)
    .map((event) => event.payload as Record<string, unknown>);

/** The same effect, with the daemon dying the instant `perform()` returns —
 * the irreducible window of EPIC-06-S16, produced rather than described. */
function killedAfterPerform<T>(effect: Effect<T>): Effect<T> {
  return {
    ...effect,
    async perform(ctx: EffectCtx): Promise<T> {
      await effect.perform(ctx);
      throw new Error('SIGKILL: the effect landed and markDone never ran');
    },
  };
}

/** The same effect, with the daemon dying *before* anything reaches the world. */
function killedBeforePerform<T>(effect: Effect<T>): Effect<T> {
  return {
    ...effect,
    perform(): Promise<T> {
      return Promise.reject(new Error('SIGKILL: before the commit'));
    },
  };
}

/**
 * The commit effect, at a named ordinal.
 *
 * Naming it is the contract for re-entry, not a convenience: `durable()`
 * derives an unnamed ordinal by counting the intents already journalled for
 * the attempt, so a node that crashed mid-effect and let the runner count
 * again would be handed *the next* position and mint a new ikey — a different
 * effect, reconciling against nothing. A caller replaying an interrupted
 * attempt replays it from ordinal 0, which is what a restart does.
 */
const commitEffect = (repo: string, subject = 'implement: step') =>
  gitCommitEffect(
    { runId: RUN, nodeId: NODE, attempt: 0, ordinal: 0, requestHash: HASH, subject },
    { run: gitIn(repo) },
  );

async function stage(repo: string, name: string): Promise<void> {
  await writeFile(join(repo, name), `${name}\n`);
  await git(repo, ['add', '-A']);
}

suite('a commit carries its ikey as a trailer (EPIC-06-S13, AC7)', () => {
  it('writes DeFlow-Effect-Id into the commit message and returns the sha', async ({ tmp }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });
    await stage(repo, 'change.txt');
    const { db, runner } = openRunner(tmp);

    try {
      const sha = await runner.durable(commitEffect(repo));

      expect(await git(repo, ['log', '-1', '--format=%B'])).toContain(`DeFlow-Effect-Id: ${IKEY}`);
      expect(sha).toBe((await git(repo, ['rev-parse', 'HEAD'])).trim());
    } finally {
      db.close();
    }
  });
});

suite('reconcile finds a commit that landed before the crash (EPIC-06-S13, AC7, AC9)', () => {
  it('returns done with the found sha, and makes no second commit', async ({ tmp }) => {
    const repo = join(tmp, 'repo');
    const data = tmp;
    await makeRepo({ dir: repo });
    await stage(repo, 'change.txt');

    const first = openRunner(data);
    try {
      await first.runner.durable(killedAfterPerform(commitEffect(repo))).catch(() => undefined);
      // The window: the commit is in the world, the row still says pending.
      expect((readEffect(first.db, IKEY) as EffectRow).state).toBe('pending');
    } finally {
      first.db.close();
    }

    const sha = (await git(repo, ['rev-parse', 'HEAD'])).trim();
    const count = (await git(repo, ['rev-list', '--count', 'HEAD'])).trim();

    const second = openRunner(data, DAEMON_STARTED_AT + 100_000);
    try {
      expect(await second.runner.durable(commitEffect(repo))).toBe(sha);
      expect((await git(repo, ['rev-list', '--count', 'HEAD'])).trim()).toBe(count);

      // AC9: a reconcile that mutates the row without appending an event does
      // not exist.
      const completed = eventsOf(second.db, 'effect.completed');
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({ ikey: IKEY, result: sha, reconciled: true });
      expect((readEffect(second.db, IKEY) as EffectRow).state).toBe('done');
    } finally {
      second.db.close();
    }
  });

  it('is not-started when the trailer is absent, and commits under the same ikey', async ({
    tmp,
  }) => {
    const repo = join(tmp, 'repo');
    const data = tmp;
    await makeRepo({ dir: repo });
    await stage(repo, 'change.txt');

    const first = openRunner(data);
    try {
      await first.runner.durable(killedBeforePerform(commitEffect(repo))).catch(() => undefined);
    } finally {
      first.db.close();
    }

    const before = Number((await git(repo, ['rev-list', '--count', 'HEAD'])).trim());

    const second = openRunner(data, DAEMON_STARTED_AT + 100_000);
    try {
      const sha = await second.runner.durable(commitEffect(repo));

      expect(Number((await git(repo, ['rev-list', '--count', 'HEAD'])).trim())).toBe(before + 1);
      expect(await git(repo, ['log', '-1', '--format=%B'])).toContain(`DeFlow-Effect-Id: ${IKEY}`);
      expect(sha).toBe((await git(repo, ['rev-parse', 'HEAD'])).trim());
      expect(eventsOf(second.db, 'effect.completed')[0]).toMatchObject({ reconciled: false });
    } finally {
      second.db.close();
    }
  });
});

suite('worktree creation is idempotent by construction (EPIC-06-S13, AC7)', () => {
  const worktreeEffect = (repo: string, path: string, branch: string, ordinal: number) =>
    gitWorktreeAddEffect(
      { runId: RUN, nodeId: NODE, attempt: 0, ordinal, requestHash: HASH, path, branch },
      { run: gitIn(repo) },
    );

  it('maps a second `git worktree add` on the same path to SUCCESS', async ({ tmp }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });
    const path = join(repo, '.DeFlow', 'wt', `${RUN}__implement`);
    const branch = `DeFlow/${RUN}__implement`;
    const { db, runner } = openRunner(tmp);

    try {
      expect(await runner.durable(worktreeEffect(repo, path, branch, 0))).toEqual({
        path,
        branch,
        outcome: 'created',
      });

      // A different ordinal: a genuinely new attempt at the same operation,
      // not the memoised read of the first one.
      expect(await runner.durable(worktreeEffect(repo, path, branch, 1))).toEqual({
        path,
        branch,
        outcome: 'already-exists',
      });

      // Real git really refused, and the refusal really was the path one.
      const refused = await gitIn(repo)(['worktree', 'add', path, branch]);
      expect(refused.exitCode).not.toBe(0);
      expect(`${refused.stderr}${refused.stdout}`).toContain('already exists');
    } finally {
      db.close();
    }
  });

  it('does NOT map a branch already used by another worktree to success', async ({ tmp }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });
    const branch = `DeFlow/${RUN}__implement`;
    const taken = join(repo, '.DeFlow', 'wt', 'taken');
    const wanted = join(repo, '.DeFlow', 'wt', 'wanted');
    const { db, runner } = openRunner(tmp);

    try {
      await runner.durable(worktreeEffect(repo, taken, branch, 0));

      const thrown = await runner
        .durable(worktreeEffect(repo, wanted, branch, 1))
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain('already used by worktree at');
    } finally {
      db.close();
    }
  });
});
