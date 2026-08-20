/**
 * KAR-07.2 — the worktree lifecycle against real git
 * (docs/09-workspace-and-safety.md §3, §4; EPIC-07-S9 … EPIC-07-S16).
 *
 * Real `git`, hermetically, throughout — every command in §4 was verified on
 * real git when the architecture was written, and re-verifying them here is the
 * only thing that makes those results mean anything today. `isomorphic-git` and
 * `simple-git` have no worktree API at all (docs/14-testing-strategy.md §6), so
 * there is nothing to mock even if mocking were allowed.
 *
 * `scene()` wraps the injected `run` port — the same seam the orchestrator will
 * inject through — and appends each argv to a list before delegating to a real
 * `Git`. That is what lets the argv assertions ("exactly one invocation", "no
 * separate `worktree lock`", "`remove -f -f` never appears") be made about a run
 * in which real git really did the work.
 *
 * **`realpath` on the temp directory, once, up front.** On macOS `/var` is a
 * symlink to `/private/var`, so `mkdtemp` hands back a path git will echo back
 * resolved. Comparing the unresolved form against git's output reports a
 * mismatch for the same directory — the same trap `src/effects/git-effect.ts`
 * already routes around.
 *
 * Verifies: EPIC-07-S9, EPIC-07-S10, EPIC-07-S11, EPIC-07-S12, EPIC-07-S13,
 * EPIC-07-S14, EPIC-07-S15, EPIC-07-S16 · AC1–AC8
 */
import type { Db } from '@DeFlow/core';
import { openLedger, readRange, readWorktrees } from '@DeFlow/ledger';
import { GIT_ENV, git, it, makeRepo, TestClock, tryGit } from '@DeFlow/testkit';
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { nodeBranch } from '../../src/git/branch-name.ts';
import { Git } from '../../src/git/git.ts';
import { worktreePathFor } from '../../src/git/worktree-args.ts';
import { reaperForceRemoveArgs } from '../../src/git/worktree-force-remove.ts';
import { BranchOccupiedError, WorkspaceManager } from '../../src/git/worktree-manager.ts';

const RUN = 'run_20260806T090000Z_5c1d2e';
const EPOCH = 7;

interface Scene {
  /** The temp directory, resolved — what git will echo back. */
  readonly root: string;
  readonly repo: string;
  readonly manager: WorkspaceManager;
  readonly calls: string[][];
  readonly db: Db;
  /** Only the `worktree …` invocations, which is what the scenarios name. */
  worktreeCalls(): string[][];
  /** `<repo>/.DeFlow/wt/<runId>__<nodeId>`, D13's path scheme. */
  wt(runId: string, nodeId: string): string;
  provisionWrite(runId: string, nodeId: string, baseRef?: string): Promise<string>;
  close(): void;
}

async function scene(
  tmp: string,
  repoOptions: { readonly branches?: readonly string[] } = {},
): Promise<Scene> {
  const root = await realpath(tmp);
  const repo = join(root, 'repo');
  await makeRepo({ dir: repo, ...repoOptions });

  const wrapped = new Git(repo, { env: GIT_ENV });
  const calls: string[][] = [];
  const db = openLedger(root);
  const manager = new WorkspaceManager({
    git: {
      run: (args, opts) => {
        calls.push([...args]);
        return wrapped.run(args, opts);
      },
    },
    db,
    clock: new TestClock(1_754_400_000_000),
    epoch: EPOCH,
  });

  const wt = (runId: string, nodeId: string): string => worktreePathFor(repo, runId, nodeId);

  return {
    root,
    repo,
    manager,
    calls,
    db,
    wt,
    worktreeCalls: () => calls.filter((argv) => argv[0] === 'worktree'),
    provisionWrite: async (runId, nodeId, baseRef = 'main') => {
      const path = wt(runId, nodeId);
      await manager.provision({
        mode: 'write',
        runId: RUN,
        nodeId,
        branch: nodeBranch(runId, nodeId),
        path,
        baseRef,
      });
      return path;
    },
    close: () => {
      db.close();
    },
  };
}

const kinds = (db: Db): string[] => readRange(db, RUN, 0, 200).events.map((event) => event.kind);

/** The **most recent** event of `kind`. A run refreshes its projection more
 * than once, and it is always the latest reconcile that is under test. */
const payloadOf = (db: Db, kind: string): Record<string, unknown> => {
  const found = readRange(db, RUN, 0, 200).events.findLast((event) => event.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} event was appended`);
  return found.payload as Record<string, unknown>;
};

suite('EPIC-07-S9: one command creates, branches and locks (AC1)', () => {
  it('records exactly one invocation, and its argv is §4.1 verbatim', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('r1', 'n1');

      expect(s.worktreeCalls()).toEqual([
        ['worktree', 'list', '--porcelain', '-z'],
        [
          'worktree',
          'add',
          '--lock',
          '--reason',
          `DeFlow run=${RUN} node=n1`,
          '-b',
          'DeFlow/r1__n1',
          path,
          'main',
        ],
      ]);
    } finally {
      s.close();
    }
  });

  it('never issues a separate "worktree lock" — the race the sequence would open', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      await s.provisionWrite('r1', 'n1');

      expect(s.calls.filter((argv) => argv[0] === 'worktree' && argv[1] === 'lock')).toEqual([]);
    } finally {
      s.close();
    }
  });

  it('git reports the branch and the lock reason in the same porcelain record', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      await s.provisionWrite('r1', 'n1');

      const entry = (await s.manager.list()).find((e) => e.branch?.endsWith('DeFlow/r1__n1'));
      expect(entry).toMatchObject({
        branch: 'refs/heads/DeFlow/r1__n1',
        detached: false,
        locked: true,
        lockReason: `DeFlow run=${RUN} node=n1`,
      });
    } finally {
      s.close();
    }
  });

  it('appends workspace.worktree_created carrying the path, branch and base ref', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('r1', 'n1');

      expect(payloadOf(s.db, 'workspace.worktree_created')).toEqual({
        node: 'n1',
        path,
        branch: 'DeFlow/r1__n1',
        baseRef: 'main',
        detached: false,
        lockReason: `DeFlow run=${RUN} node=n1`,
      });
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S9: a locked worktree is immune to prune (§4.2)', () => {
  it('survives "worktree prune -v --expire 2.weeks.ago", on disk and in the list', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('r1', 'n1');

      await git(s.repo, ['worktree', 'prune', '-v', '--expire', '2.weeks.ago']);

      expect((await s.manager.list()).map((entry) => entry.path)).toContain(path);
      expect((await stat(path)).isDirectory()).toBe(true);
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S10: a read node gets a locked detached worktree (AC2)', () => {
  it('uses --detach, no -b, and creates no branch', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const path = s.wt('r1', 'n2');

      await s.manager.provision({ mode: 'read', runId: RUN, nodeId: 'n2', path, baseRef: 'main' });

      const add = s.worktreeCalls().find((argv) => argv[1] === 'add');
      expect(add).toEqual([
        'worktree',
        'add',
        '--detach',
        '--lock',
        '--reason',
        `DeFlow run=${RUN} node=n2`,
        path,
        'main',
      ]);
      expect(add).not.toContain('-b');
      expect(await git(s.repo, ['branch', '--list', 'DeFlow/r1__n2'])).toBe('');
    } finally {
      s.close();
    }
  });

  it('skips the occupancy pre-check entirely, because it claims no branch', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      await s.manager.provision({
        mode: 'read',
        runId: RUN,
        nodeId: 'n2',
        path: s.wt('r1', 'n2'),
        baseRef: 'main',
      });

      // The registry read every provision makes, then the add — and nothing
      // else. A *branch* pre-check would show up as `workspace.branch_occupied`
      // on a collision and as a second list here; a read node makes neither,
      // because `--detach` claims no branch to collide on.
      expect(s.worktreeCalls().map((argv) => argv[1])).toEqual(['list', 'add']);
    } finally {
      s.close();
    }
  });

  it('two read nodes on the same base ref both succeed, both detached', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      for (const nodeId of ['n2', 'n3']) {
        await s.manager.provision({
          mode: 'read',
          runId: RUN,
          nodeId,
          path: s.wt('r1', nodeId),
          baseRef: 'main',
        });
      }

      const detached = (await s.manager.list()).filter((entry) => entry.detached);
      expect(detached).toHaveLength(2);
      expect(detached.every((entry) => entry.branch === null)).toBe(true);
      expect(kinds(s.db)).not.toContain('workspace.branch_occupied');
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S11: the same branch in two worktrees (AC3)', () => {
  it('DeFlow refuses before git is asked, and records no "worktree add"', async ({ tmp }) => {
    const s = await scene(tmp, { branches: ['feature'] });
    try {
      const wtA = join(s.root, 'wt-a');
      await git(s.repo, ['worktree', 'add', wtA, 'feature']);

      const refusal = s.manager.provision({
        mode: 'write',
        runId: RUN,
        nodeId: 'n1',
        branch: 'feature',
        path: join(s.root, 'wt-b'),
        baseRef: 'main',
      });

      await expect(refusal).rejects.toBeInstanceOf(BranchOccupiedError);
      expect(s.worktreeCalls().filter((argv) => argv[1] === 'add')).toEqual([]);
      expect(payloadOf(s.db, 'workspace.branch_occupied')).toEqual({
        node: 'n1',
        branch: 'feature',
        occupiedBy: wtA,
        occupantKind: 'worktree',
      });
    } finally {
      s.close();
    }
  });

  it('the typed error carries the occupant, so nothing downstream parses a string', async ({
    tmp,
  }) => {
    const s = await scene(tmp, { branches: ['feature'] });
    try {
      const wtA = join(s.root, 'wt-a');
      await git(s.repo, ['worktree', 'add', wtA, 'feature']);

      const thrown = await s.manager
        .provision({
          mode: 'write',
          runId: RUN,
          nodeId: 'n1',
          branch: 'feature',
          path: join(s.root, 'wt-b'),
          baseRef: 'main',
        })
        .catch((error: unknown) => error);

      expect(thrown).toMatchObject({
        branch: 'feature',
        occupiedBy: wtA,
        occupantKind: 'worktree',
      });
    } finally {
      s.close();
    }
  });

  it('the real git error string, pinned as a regression', async ({ tmp }) => {
    const s = await scene(tmp, { branches: ['feature'] });
    try {
      const wtA = join(s.root, 'wt-a');
      await git(s.repo, ['worktree', 'add', wtA, 'feature']);

      const raw = await tryGit(s.repo, ['worktree', 'add', join(s.root, 'wt-b'), 'feature']);

      expect(raw.exitCode).not.toBe(0);
      expect(raw.stderr).toContain('already used by worktree at');
      // The string most notes and blog posts claim. It is not what git says,
      // and a matcher written against it would decide every branch is free.
      expect(raw.stderr).not.toContain('is already checked out at');
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S12: the main checkout counts as an occupant (AC4)', () => {
  it('finds the operator’s own checkout and says so in DeFlow’s words', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const thrown = await s.manager
        .provision({
          mode: 'write',
          runId: RUN,
          nodeId: 'n1',
          branch: 'main',
          path: join(s.root, 'wt'),
          baseRef: 'main',
        })
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(BranchOccupiedError);
      const message = (thrown as Error).message;
      // Their branch, their checkout, and the base-ref offer.
      expect(message).toContain('main');
      expect(message).toContain(s.repo);
      expect(message).toMatch(/base ref/i);
      // Not git's wording, in either the real or the widely-quoted form.
      expect(message).not.toContain('already used by worktree at');
      expect(message).not.toContain('already checked out');
      expect(message).not.toContain('fatal:');
    } finally {
      s.close();
    }
  });

  it('the event names the main checkout as the occupant', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      await s.manager
        .provision({
          mode: 'write',
          runId: RUN,
          nodeId: 'n1',
          branch: 'main',
          path: join(s.root, 'wt'),
          baseRef: 'main',
        })
        .catch(() => undefined);

      expect(payloadOf(s.db, 'workspace.branch_occupied')).toEqual({
        node: 'n1',
        branch: 'main',
        occupiedBy: s.repo,
        occupantKind: 'main-checkout',
      });
    } finally {
      s.close();
    }
  });

  it('raw git agrees, which is why the pre-check exists', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const raw = await tryGit(s.repo, ['worktree', 'add', join(s.root, 'wt'), 'main']);

      expect(raw.exitCode).not.toBe(0);
      expect(raw.stderr).toContain(`'main' is already used by worktree at`);
    } finally {
      s.close();
    }
  });

  it('DeFlow’s own generated branches never hit this: 20 nodes across 4 runs', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      for (const runIdx of [1, 2, 3, 4]) {
        for (const nodeIdx of [1, 2, 3, 4, 5]) {
          await s.provisionWrite(`r${runIdx}`, `n${nodeIdx}`);
        }
      }

      // 20 worktrees plus the operator's own checkout.
      expect(await s.manager.list()).toHaveLength(21);
      expect(kinds(s.db)).not.toContain('workspace.branch_occupied');
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S13: porcelain -z against real git, path with a space', () => {
  it('reads back a worktree at "<tmp>/my worktrees/r1 n1" exactly', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const path = join(s.root, 'my worktrees', 'r1 n1');
      await mkdir(join(s.root, 'my worktrees'), { recursive: true });

      await s.manager.provision({
        mode: 'write',
        runId: RUN,
        nodeId: 'n1',
        branch: nodeBranch('r1', 'n1'),
        path,
        baseRef: 'main',
      });

      const entry = (await s.manager.list()).find((e) => e.branch?.endsWith('DeFlow/r1__n1'));
      expect(entry?.path).toBe(path);
      expect(entry?.lockReason).toBe(`DeFlow run=${RUN} node=n1`);
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S14: git is the authority (AC8)', () => {
  it('a manual "git worktree remove" reconciles to two rows, with no error', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const paths: string[] = [];
      for (const nodeId of ['n1', 'n2', 'n3']) paths.push(await s.provisionWrite('r1', nodeId));
      await s.manager.refresh(RUN);
      expect(readWorktrees(s.db)).toHaveLength(4);

      // The operator, in their own terminal.
      const gone = paths[1] ?? '';
      await git(s.repo, ['worktree', 'unlock', gone]);
      await git(s.repo, ['worktree', 'remove', gone]);
      const report = await s.manager.refresh(RUN);

      expect(readWorktrees(s.db)).toHaveLength(3);
      expect(report.removed).toEqual([gone]);
      expect(payloadOf(s.db, 'workspace.reconciled')).toMatchObject({ removed: [gone] });
    } finally {
      s.close();
    }
  });

  it('a manual rm -rf on an unlocked worktree leaves a prunable entry, reconciled as such', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('r1', 'n3');
      // The reaper's mandated order is reap, unlock, prune (§4.5) — a lock is
      // what keeps a worktree out of prune's way, so prunability is only ever
      // observable after the lock is gone. See the next spec.
      await git(s.repo, ['worktree', 'unlock', path]);
      await s.manager.refresh(RUN);

      await rm(path, { recursive: true, force: true });
      const report = await s.manager.refresh(RUN);

      expect(report.removed).toEqual([]);
      expect(report.prunable).toEqual([path]);
      expect(readWorktrees(s.db).find((entry) => entry.path === path)?.prunable).toBe(true);
    } finally {
      s.close();
    }
  });

  it('a locked worktree whose directory is gone is NOT prunable — the lock is doing its job', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('r1', 'n4');

      await rm(path, { recursive: true, force: true });
      const report = await s.manager.refresh(RUN);

      // Verified on git 2.50.1, 2026-08-06: git reports the entry with its
      // `locked` record and no `prunable` record at all. That is why §4.5
      // orders the boot sequence reap → unlock → prune, and why a reaper that
      // pruned first would silently skip every worktree it cared about.
      expect(report.prunable).toEqual([]);
      const row = readWorktrees(s.db).find((entry) => entry.path === path);
      expect(row).toMatchObject({ locked: true, prunable: false });
    } finally {
      s.close();
    }
  });

  it('the occupancy pre-check reads git, not the projection', async ({ tmp }) => {
    const s = await scene(tmp, { branches: ['feature'] });
    try {
      await git(s.repo, ['worktree', 'add', join(s.root, 'wt-a'), 'feature']);
      // The projection is deliberately never refreshed, so it holds nothing at
      // all. A design that consulted the table would happily hand out `feature`.
      expect(readWorktrees(s.db)).toEqual([]);

      await expect(
        s.manager.provision({
          mode: 'write',
          runId: RUN,
          nodeId: 'n1',
          branch: 'feature',
          path: join(s.root, 'wt-b'),
          baseRef: 'main',
        }),
      ).rejects.toBeInstanceOf(BranchOccupiedError);

      expect(s.worktreeCalls()[0]).toEqual(['worktree', 'list', '--porcelain', '-z']);
    } finally {
      s.close();
    }
  });

  it('records the run and node a lock reason identifies, and NULL for anyone else’s', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      await s.provisionWrite('r1', 'n1');

      await s.manager.refresh(RUN);

      const rows = readWorktrees(s.db);
      expect(rows.find((row) => row.path === s.repo)).toMatchObject({ runId: null, nodeId: null });
      expect(rows.find((row) => row.nodeId === 'n1')).toMatchObject({ runId: RUN });
    } finally {
      s.close();
    }
  });

  it('a refresh that changed nothing appends no event', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      await s.provisionWrite('r1', 'n1');
      await s.manager.refresh(RUN);
      const before = kinds(s.db).filter((kind) => kind === 'workspace.reconciled').length;

      const report = await s.manager.refresh(RUN);

      expect(report.changed).toBe(false);
      expect(kinds(s.db).filter((kind) => kind === 'workspace.reconciled')).toHaveLength(before);
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S15: removal is unlock then remove (AC7)', () => {
  it('issues exactly unlock then remove, neither forcing, and the directory goes', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('r1', 'n1');
      s.calls.length = 0;

      await s.manager.remove({ runId: RUN, nodeId: 'n1', path, branch: nodeBranch('r1', 'n1') });

      expect(s.worktreeCalls()).toEqual([
        ['worktree', 'unlock', path],
        ['worktree', 'remove', path],
      ]);
      expect(s.calls.flat()).not.toContain('--force');
      expect(s.calls.flat()).not.toContain('-f');
      await expect(stat(path)).rejects.toThrow();
    } finally {
      s.close();
    }
  });

  it('the branch survives with its commits, because the branch is the output', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('r1', 'n1');
      const branch = nodeBranch('r1', 'n1');
      await writeFile(join(path, 'agent-work.txt'), 'the node did something\n');
      await git(path, ['add', '-A']);
      await git(path, ['commit', '-m', 'node n1 output']);
      const tip = await git(s.repo, ['rev-parse', branch]);

      const removed = await s.manager.remove({ runId: RUN, nodeId: 'n1', path, branch });

      expect(await git(s.repo, ['log', '--oneline', branch])).toContain('node n1 output');
      expect(removed.tipOid).toBe(tip);
      expect(payloadOf(s.db, 'workspace.worktree_removed')).toEqual({
        node: 'n1',
        path,
        branch,
        tipOid: tip,
      });
    } finally {
      s.close();
    }
  });

  it('raw git still refuses a dirty worktree — which is why KAR-07.4 salvages before removing', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('r1', 'n1');
      await writeFile(join(path, 'untracked.txt'), 'work an agent left behind\n');
      await git(s.repo, ['worktree', 'unlock', path]);

      const raw = await tryGit(s.repo, ['worktree', 'remove', path]);

      // The verified message, pinned. KAR-07.2's `remove` never sees it: the
      // Workspace Manager asks `status --porcelain=v2 -z` first and takes
      // §4.4's salvage path (../integration/worktree-salvage.test.ts), because
      // branching on a git string is how a design ends up force-removing every
      // worktree the day the string changes.
      expect(raw.exitCode).not.toBe(0);
      expect(raw.stderr).toContain('contains modified or untracked files');
      expect((await stat(path)).isDirectory()).toBe(true);
      expect(kinds(s.db)).not.toContain('workspace.worktree_removed');
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S16: a locked worktree needs the double force (AC7)', () => {
  it('raw "worktree remove" refuses a locked worktree, and says how to override', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('r1', 'n1');

      const raw = await tryGit(s.repo, ['worktree', 'remove', path]);

      expect(raw.exitCode).not.toBe(0);
      expect(raw.stderr).toContain('cannot remove a locked working tree');
      expect(raw.stderr).toContain(`use 'remove -f -f' to override or unlock first`);
    } finally {
      s.close();
    }
  });

  it('the node-completion path unlocks instead: "remove -f -f" never appears', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('r1', 'n1');

      await s.manager.remove({ runId: RUN, nodeId: 'n1', path, branch: nodeBranch('r1', 'n1') });

      for (const argv of s.calls) expect(argv.join(' ')).not.toContain('remove -f -f');
    } finally {
      s.close();
    }
  });

  it('the reaper’s double force really does override both the lock and dirtiness', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      const path = await s.provisionWrite('r1', 'n1');
      // Locked *and* dirty: the two things the two forces separately override.
      await writeFile(join(path, 'untracked.txt'), 'work an agent left behind\n');

      expect(reaperForceRemoveArgs(path)).toEqual(['worktree', 'remove', '-f', '-f', path]);
      const forced = await tryGit(s.repo, reaperForceRemoveArgs(path));

      expect(forced.exitCode).toBe(0);
      await expect(stat(path)).rejects.toThrow();
    } finally {
      s.close();
    }
  });
});

suite(
  '§2.1: -b is not a safe slot for an arbitrary name, which is why nodeBranch composes it',
  () => {
    it('raw "worktree add -b -n" takes -n as the branch name and fails inside git branch', async ({
      tmp,
    }) => {
      const s = await scene(tmp);
      try {
        const raw = await tryGit(s.repo, [
          'worktree',
          'add',
          '-b',
          '-n',
          join(s.root, 'wt'),
          'main',
        ]);

        // Verified on git 2.50.1, 2026-08-06: `worktree add` accepts `-n` as the
        // value of `-b` — "Preparing worktree (new branch '-n')" — and then hands
        // it to its own `git branch` as a bare positional, where it is parsed as
        // a flag. So `-b` is *not* a safe slot for an arbitrary string, and the
        // protection is KAR-07.3's domain-layer refusal of a leading dash plus
        // nodeBranch's literal `DeFlow/` prefix.
        expect(raw.exitCode).not.toBe(0);
        expect(`${raw.stdout}\n${raw.stderr}`).toContain(`unknown switch \`n'`);
        const branches = await git(s.repo, [
          'for-each-ref',
          '--format=%(refname:short)',
          'refs/heads',
        ]);
        expect(branches.split('\n').filter((line) => line !== '')).toEqual(['main']);
      } finally {
        s.close();
      }
    });

    it('every name nodeBranch composes starts with the literal DeFlow/, so it cannot be a flag', () => {
      expect(nodeBranch('r1', 'n1').startsWith('-')).toBe(false);
      expect(nodeBranch('r1', 'n1').startsWith('DeFlow/')).toBe(true);
    });
  },
);
