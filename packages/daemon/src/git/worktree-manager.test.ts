/**
 * KAR-25.8 — `provision` is idempotent about its own worktree, and still
 * refuses somebody else's (EPIC-25-S51 … EPIC-25-S55).
 *
 * A fake `WorkspaceGit` rather than real git, because this lives in the `unit`
 * project: no child process is started, and every "what does git say" answer
 * is one this file states and controls. What it must still get right is the
 * one thing the defect actually turned on — that `provision`'s decision comes
 * from `git worktree list --porcelain -z`'s own report (`list()`, already
 * exercised against real git in ../../test/integration/worktree-lifecycle.test.ts)
 * plus `parseLockReason`, never from whether `git worktree add` happens to
 * fail. The ledger is real (`openLedger` over a temp dir): the event payloads
 * these scenarios assert on are the actual `@DeFlow/core` schemas, not a
 * shape this file made up to agree with itself.
 *
 * The defect, reproduced literally: `provision` used to run `git worktree add`
 * unconditionally (worktree-manager.ts:322-323 before this story), so calling
 * it twice for the same run and node — exactly what `advanceRun` does on a
 * retry — made the second call exit 128 with "already exists" and throw
 * `WorktreeCreateFailed`, forever. EPIC-25-S51 calls `provision` twice for the
 * same run and node and asserts the second call does not throw it.
 *
 * Verifies: EPIC-25-S51, EPIC-25-S52, EPIC-25-S53, EPIC-25-S54, EPIC-25-S55 ·
 * KAR-25.8 AC1-AC6
 */
import { type Db, RunIdSchema } from '@DeFlow/core';
import { openLedger, readRange } from '@DeFlow/ledger';
import { it, TestClock } from '@DeFlow/testkit';
import { mkdir, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import type { GitResult } from './run-git.ts';
import {
  lockReasonFor,
  WORKTREE_LIST_ARGS,
  worktreeAddArgs,
  worktreePathFor,
} from './worktree-args.ts';
import {
  BranchOccupiedError,
  type WorkspaceGit,
  WorkspaceManager,
  WorktreePathOccupiedError,
} from './worktree-manager.ts';
import { parseWorktreeList } from './worktree-porcelain.ts';

const RUN = RunIdSchema.parse('run_20260819T090000Z_5c1d2e');
const EPOCH = 3;

interface FakeEntry {
  path: string;
  branch: string | null;
  detached: boolean;
  lockReason: string;
}

/**
 * The whole of "git" this suite needs: a registry of what a real `worktree
 * add` would have made `worktree list --porcelain -z` report, kept honest by
 * routing every call through the same argv builders and parser the manager
 * itself uses. `add` really creates the directory on disk (mkdir), because
 * `provision`'s new path-existence check reads the real filesystem — a fake
 * that only pretended would make EPIC-25-S54's orphan case untestable.
 *
 * `add` also really fails the way real git does — exit 128, `fatal: '<path>'
 * already exists` on stderr — when asked to register a path this fake already
 * has an entry for (Finding 1's fix's own precondition). Before this, `add`
 * unconditionally succeeded and `mkdir(path, {recursive:true})` is a silent
 * no-op on an existing directory, so a pre-fix `provision` that ran `add`
 * unconditionally a second time never saw a failure here at all — the AC1
 * test below passed unchanged against the defect it claims to pin. `git
 * worktree add` never overwrites an existing registration; this mirrors that.
 */
class FakeGit implements WorkspaceGit {
  readonly calls: string[][] = [];
  readonly #entries = new Map<string, FakeEntry>();
  /** Real git always lists the repository's own checkout first (§3.1's
   * `main-checkout` occupant kind). A fake with no such entry would put
   * whichever worktree happens to be added first at index 0 instead, which
   * `findOccupant` would then misclassify. */
  readonly #mainCheckout: string;
  addExitCode = 0;
  addStderr = '';

  constructor(mainCheckout: string) {
    this.#mainCheckout = mainCheckout;
  }

  async run(args: readonly string[], _opts?: { readonly cwd?: string }): Promise<GitResult> {
    this.calls.push([...args]);

    if (args[0] === 'worktree' && args[1] === 'list') {
      const main =
        `worktree ${this.#mainCheckout}\0` +
        `HEAD 0000000000000000000000000000000000000000\0branch refs/heads/main\0\0`;
      const rest = [...this.#entries.values()]
        .map((entry) => {
          const branchRecord = entry.branch === null ? 'detached\0' : `branch ${entry.branch}\0`;
          return (
            `worktree ${entry.path}\0HEAD 0000000000000000000000000000000000000000\0` +
            `${branchRecord}locked ${entry.lockReason}\0\0`
          );
        })
        .join('');
      return { exitCode: 0, stdout: main + rest, stderr: '' };
    }

    if (args[0] === 'worktree' && args[1] === 'add') {
      if (this.addExitCode !== 0) {
        return { exitCode: this.addExitCode, stdout: '', stderr: this.addStderr };
      }
      const path = args.at(-2) ?? '';
      // Real git: `worktree add` at a path that already has a registered
      // worktree exits 128 with `fatal: '<path>' already exists` — it does
      // NOT silently re-register or overwrite. This is the exit the pre-fix
      // `provision`'s unconditional second `add` actually hit.
      if (this.#entries.has(path)) {
        return { exitCode: 128, stdout: '', stderr: `fatal: '${path}' already exists\n` };
      }
      const reasonIdx = args.indexOf('--reason');
      const lockReason = args[reasonIdx + 1] ?? '';
      const bIdx = args.indexOf('-b');
      const branch = bIdx === -1 ? null : `refs/heads/${args[bIdx + 1] ?? ''}`;
      const detached = args.includes('--detach');
      this.#entries.set(path, { path, branch, detached, lockReason });
      await mkdir(path, { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (args[0] === 'worktree' && args[1] === 'prune') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    throw new Error(`FakeGit does not implement: ${args.join(' ')}`);
  }

  /** Directly registers an entry, as if a prior `add` had happened — used to
   * seed EPIC-25-S53's "held by someone else" fixture without going through a
   * whole first provision. */
  seed(entry: FakeEntry): void {
    this.#entries.set(entry.path, entry);
  }
}

interface Scene {
  readonly root: string;
  readonly db: Db;
  readonly git: FakeGit;
  readonly manager: WorkspaceManager;
  wt(runId: string, nodeId: string): string;
  close(): void;
}

function scene(tmp: string): Scene {
  const db = openLedger(tmp);
  const git = new FakeGit(join(tmp, 'repo'));
  const manager = new WorkspaceManager({
    git,
    db,
    clock: new TestClock(1_755_600_000_000),
    epoch: EPOCH,
  });
  return {
    root: tmp,
    db,
    git,
    manager,
    wt: (runId, nodeId) => worktreePathFor(tmp, runId, nodeId),
    close: () => db.close(),
  };
}

const events = (db: Db): { kind: string; payload: Record<string, unknown> }[] =>
  readRange(db, RUN, 0, 500).events.map((event) => ({
    kind: event.kind,
    payload: event.payload as Record<string, unknown>,
  }));

const exists = async (path: string): Promise<boolean> =>
  await stat(path).then(
    () => true,
    () => false,
  );

// ── EPIC-25-S51 ──────────────────────────────────────────────────────────────

suite('EPIC-25-S51: a failed node provisions again and the run advances', () => {
  it('provisioning twice for the same run and node succeeds both times (AC1)', async ({ tmp }) => {
    const s = scene(tmp);
    try {
      const request = {
        mode: 'read' as const,
        runId: RUN,
        nodeId: 'recon',
        path: s.wt(RUN, 'recon'),
        baseRef: 'main',
      };

      const first = await s.manager.provision(request);
      // The literal defect: nothing removed the worktree between the two
      // calls — a failed node, retried on the next drive tick, provisions
      // again over its own still-present directory.
      const second = await s.manager.provision(request);

      expect(second).toEqual(first);
    } finally {
      s.close();
    }
  });

  it('the second call does not throw WorktreeCreateFailed — the run advances rather than looping', async ({
    tmp,
  }) => {
    const s = scene(tmp);
    try {
      const request = {
        mode: 'write' as const,
        runId: RUN,
        nodeId: 'recon',
        branch: 'DeFlow/recon',
        path: s.wt(RUN, 'recon'),
        baseRef: 'main',
      };
      await s.manager.provision(request);

      const second = s.manager.provision(request);

      await expect(second).resolves.toMatchObject({ path: request.path, branch: request.branch });
    } finally {
      s.close();
    }
  });

  it('this is a change from today: two unconditional `worktree add`s would have failed', async ({
    tmp,
  }) => {
    // Pins the defect itself, against `FakeGit` directly rather than through
    // `provision` — `provision` no longer runs `add` unconditionally, so this
    // is deliberately the old behaviour, reproduced literally: the exact two
    // calls the pre-fix `provision` made for a node retried after it failed.
    // If `FakeGit` ever stopped reproducing real git's exit-128 "already
    // exists" here, the AC1 test above (and every other test in this file)
    // would go back to passing unchanged against a `provision` that regressed
    // to running `add` unconditionally — this is the assertion that would
    // catch the fake losing that fidelity.
    const s = scene(tmp);
    try {
      const spec = {
        mode: 'write' as const,
        runId: 'r1',
        nodeId: 'n1',
        branch: 'DeFlow/r1__n1',
        path: join(tmp, 'wt'),
        baseRef: 'main',
      };
      const args = worktreeAddArgs(spec);

      const first = await s.git.run(args);
      expect(first.exitCode).toBe(0);

      const second = await s.git.run(args);
      expect(second.exitCode).not.toBe(0);
      expect(second.stderr).toContain('already exists');
    } finally {
      s.close();
    }
  });
});

// ── EPIC-25-S52 ──────────────────────────────────────────────────────────────

suite('EPIC-25-S52: the second provision is recorded as reuse, not as a second creation', () => {
  it('appends workspace.worktree_reused, not a second workspace.worktree_created (AC2)', async ({
    tmp,
  }) => {
    const s = scene(tmp);
    try {
      const request = {
        mode: 'write' as const,
        runId: RUN,
        nodeId: 'spec-approval',
        branch: 'DeFlow/spec-approval',
        path: s.wt(RUN, 'spec-approval'),
        baseRef: 'main',
      };

      await s.manager.provision(request);
      await s.manager.provision(request);

      const kinds = events(s.db).map((event) => event.kind);
      expect(kinds.filter((kind) => kind === 'workspace.worktree_created')).toHaveLength(1);
      expect(kinds.filter((kind) => kind === 'workspace.worktree_reused')).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  it('the returned path, branch and lock reason are identical to the first (AC1, AC2)', async ({
    tmp,
  }) => {
    const s = scene(tmp);
    try {
      const request = {
        mode: 'write' as const,
        runId: RUN,
        nodeId: 'n1',
        branch: 'DeFlow/n1',
        path: s.wt(RUN, 'n1'),
        baseRef: 'main',
      };

      const first = await s.manager.provision(request);
      const second = await s.manager.provision(request);

      expect(second.path).toBe(first.path);
      expect(second.branch).toBe(first.branch);
      expect(second.lockReason).toBe(first.lockReason);
      expect(second.lockReason).toBe(lockReasonFor(RUN, 'n1'));
    } finally {
      s.close();
    }
  });

  it('the reused event carries the same shape as worktree_created', async ({ tmp }) => {
    const s = scene(tmp);
    try {
      const request = {
        mode: 'write' as const,
        runId: RUN,
        nodeId: 'n1',
        branch: 'DeFlow/n1',
        path: s.wt(RUN, 'n1'),
        baseRef: 'main',
      };

      await s.manager.provision(request);
      await s.manager.provision(request);

      const created = events(s.db).find((event) => event.kind === 'workspace.worktree_created');
      const reused = events(s.db).find((event) => event.kind === 'workspace.worktree_reused');
      expect(reused?.payload).toEqual(created?.payload);
    } finally {
      s.close();
    }
  });
});

// ── EPIC-25-S53 ──────────────────────────────────────────────────────────────

suite('EPIC-25-S53: a worktree held by another node is still refused, by name', () => {
  it('refuses when the path is registered to a different run and node (AC3)', async ({ tmp }) => {
    const s = scene(tmp);
    try {
      const path = s.wt('run_other', 'other-node');
      // A fixture, not just a code path: seed exactly what `git worktree
      // list` would report for somebody else's worktree sitting at the path
      // this request is about to ask for.
      s.git.seed({
        path,
        branch: 'refs/heads/DeFlow/run_other__other-node',
        detached: false,
        lockReason: lockReasonFor('run_other', 'other-node'),
      });
      await mkdir(path, { recursive: true });

      const refusal = s.manager
        .provision({
          mode: 'write',
          runId: RUN,
          nodeId: 'recon',
          branch: 'DeFlow/recon',
          path,
          baseRef: 'main',
        })
        .catch((error: unknown) => error);

      const thrown = await refusal;
      expect(thrown).toBeInstanceOf(WorktreePathOccupiedError);
      const error = thrown as WorktreePathOccupiedError;
      expect(error.path).toBe(path);
      expect(error.occupiedBy).toContain('run_other');
      expect(error.occupiedBy).toContain('other-node');
      expect(error.message).toContain('run_other');
      expect(error.message).toContain('other-node');
    } finally {
      s.close();
    }
  });

  it('never calls "worktree add" over somebody else\'s worktree', async ({ tmp }) => {
    const s = scene(tmp);
    try {
      const path = s.wt('run_other', 'other-node');
      s.git.seed({
        path,
        branch: 'refs/heads/DeFlow/run_other__other-node',
        detached: false,
        lockReason: lockReasonFor('run_other', 'other-node'),
      });
      await mkdir(path, { recursive: true });

      await s.manager
        .provision({
          mode: 'write',
          runId: RUN,
          nodeId: 'recon',
          branch: 'DeFlow/recon',
          path,
          baseRef: 'main',
        })
        .catch(() => undefined);

      expect(s.git.calls.filter((argv) => argv[1] === 'add')).toEqual([]);
    } finally {
      s.close();
    }
  });

  it('refuses when the entry at the path carries no DeFlow lock reason at all', async ({ tmp }) => {
    const s = scene(tmp);
    try {
      const path = join(tmp, 'humans-own-checkout');
      s.git.seed({ path, branch: 'refs/heads/main', detached: false, lockReason: 'on holiday' });
      await mkdir(path, { recursive: true });

      const thrown = await s.manager
        .provision({
          mode: 'write',
          runId: RUN,
          nodeId: 'n1',
          branch: 'DeFlow/n1',
          path,
          baseRef: 'main',
        })
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(WorktreePathOccupiedError);
      expect((thrown as WorktreePathOccupiedError).occupiedBy).toContain('on holiday');
    } finally {
      s.close();
    }
  });
});

// ── EPIC-25-S54 ──────────────────────────────────────────────────────────────

suite('EPIC-25-S54: an orphan directory git does not know about is pruned and re-added', () => {
  it('prunes, removes the directory, adds the worktree, and the run continues (AC4)', async ({
    tmp,
  }) => {
    const s = scene(tmp);
    try {
      const path = s.wt(RUN, 'recon');
      // A crash between mkdir and the ledger append: the directory is on
      // disk, and it holds a leftover file no `git worktree add` would ever
      // have put there — but git's own list knows nothing about it at all.
      await mkdir(path, { recursive: true });
      await mkdir(join(path, 'stale'), { recursive: true });

      const result = await s.manager.provision({
        mode: 'read',
        runId: RUN,
        nodeId: 'recon',
        path,
        baseRef: 'main',
      });

      expect(result.path).toBe(path);
      expect(await exists(join(path, 'stale'))).toBe(false);
      const worktreeCalls = s.git.calls.filter((argv) => argv[0] === 'worktree');
      const kinds = worktreeCalls.map((argv) => argv[1]);
      expect(kinds).toContain('prune');
      expect(kinds).toContain('add');
      expect(kinds.indexOf('prune')).toBeLessThan(kinds.indexOf('add'));
      const created = events(s.db).filter((event) => event.kind === 'workspace.worktree_created');
      expect(created).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  it('the fresh directory really is a new one, empty apart from what add itself makes', async ({
    tmp,
  }) => {
    const s = scene(tmp);
    try {
      const path = s.wt(RUN, 'recon');
      await mkdir(path, { recursive: true });
      await mkdir(join(path, 'stale-agent-output'), { recursive: true });

      await s.manager.provision({
        mode: 'read',
        runId: RUN,
        nodeId: 'recon',
        path,
        baseRef: 'main',
      });

      expect(await readdir(path)).toEqual([]);
    } finally {
      s.close();
    }
  });
});

// ── EPIC-25-S55 ──────────────────────────────────────────────────────────────

suite('EPIC-25-S55: read nodes keep detached, unchecked, concurrent provisioning', () => {
  it('two read nodes on the same commit both succeed, both detached, no branch check (AC6)', async ({
    tmp,
  }) => {
    const s = scene(tmp);
    try {
      const first = await s.manager.provision({
        mode: 'read',
        runId: RUN,
        nodeId: 'n1',
        path: s.wt(RUN, 'n1'),
        baseRef: 'main',
      });
      const second = await s.manager.provision({
        mode: 'read',
        runId: RUN,
        nodeId: 'n2',
        path: s.wt(RUN, 'n2'),
        baseRef: 'main',
      });

      expect(first.branch).toBeNull();
      expect(second.branch).toBeNull();
      expect(first.detached).toBe(true);
      expect(second.detached).toBe(true);
      // Neither request triggered a `worktree list`: nothing existed yet at
      // either path, so the new path-registration check never ran, and a read
      // node still performs no occupancy check of any kind.
      expect(s.git.calls.filter((argv) => argv.join(' ') === WORKTREE_LIST_ARGS.join(' '))).toEqual(
        [],
      );
    } finally {
      s.close();
    }
  });

  it('a repeated read-node provision still reuses rather than refusing', async ({ tmp }) => {
    const s = scene(tmp);
    try {
      const request = {
        mode: 'read' as const,
        runId: RUN,
        nodeId: 'n3',
        path: s.wt(RUN, 'n3'),
        baseRef: 'main',
      };

      const first = await s.manager.provision(request);
      const second = await s.manager.provision(request);

      expect(second).toEqual(first);
      const kinds = events(s.db).map((event) => event.kind);
      expect(kinds).toContain('workspace.worktree_reused');
    } finally {
      s.close();
    }
  });
});

// ── Finding 1: a symlinked ancestor must not turn a registered, locked ─────
// ── worktree into an "orphan" that gets pruned and rm -rf'd ────────────────

suite(
  'a worktree registered under a symlinked ancestor is reused, never wiped as an orphan',
  () => {
    it('recognises the registered worktree through the symlink and does not delete it (write mode)', async ({
      tmp,
    }) => {
      const s = scene(tmp);
      try {
        // `git worktree list --porcelain` prints realpath-resolved paths
        // (verified in ../effects/git-effect.ts's own `resolved()`). This
        // module builds `request.path` with a plain `path.join`, so when an
        // ancestor is a symlink the two strings differ for the very same
        // directory — exactly the shape of `link_dir -> real_dir` a reviewer
        // reproduced against the pre-fix raw `===` comparison.
        const realDir = join(tmp, 'real_dir');
        const linkDir = join(tmp, 'link_dir');
        await mkdir(realDir, { recursive: true });
        await symlink(realDir, linkDir, 'dir');

        const requestPath = join(linkDir, 'wt');
        await mkdir(requestPath, { recursive: true });
        // The evidence a wrongly-taken orphan branch would destroy: an agent's
        // uncommitted file, sitting in the worktree the run already owns.
        await writeFile(join(requestPath, 'uncommitted-work.txt'), 'do not delete me');
        const registeredPath = await realpath(requestPath);

        s.git.seed({
          path: registeredPath,
          branch: 'refs/heads/DeFlow/recon',
          detached: false,
          lockReason: lockReasonFor(RUN, 'recon'),
        });

        const result = await s.manager.provision({
          mode: 'write',
          runId: RUN,
          nodeId: 'recon',
          branch: 'DeFlow/recon',
          path: requestPath,
          baseRef: 'main',
        });

        // Reused, not treated as somebody else's occupied branch and not
        // treated as an orphan directory.
        expect(result.path).toBe(requestPath);
        expect(result.branch).toBe('DeFlow/recon');

        // The pre-fix raw comparison in `#assertBranchFree`'s self-occupant
        // bypass would have found `occupant.path !== request.path` here and
        // thrown `BranchOccupiedError` against the run's own worktree.
        const kinds = events(s.db).map((event) => event.kind);
        expect(kinds).not.toContain('workspace.branch_occupied');
        expect(kinds).toContain('workspace.worktree_reused');
        expect(kinds).not.toContain('workspace.worktree_created');

        // The pre-fix raw comparison in `provision`'s own orphan check would
        // have found `registered` `undefined` here, run `worktree prune`
        // (a no-op — the entry is valid) and then `rm(requestPath, {recursive:
        // true, force: true})`, wiping the live worktree's file while git still
        // listed the entry.
        expect(s.git.calls.some((argv) => argv[1] === 'prune')).toBe(false);
        expect(s.git.calls.filter((argv) => argv[1] === 'add')).toEqual([]);
        expect(await exists(join(requestPath, 'uncommitted-work.txt'))).toBe(true);
        expect(await exists(requestPath)).toBe(true);
      } finally {
        s.close();
      }
    });
  },
);

// ── Regression: the branch pre-check and BranchOccupiedError are unchanged ──

suite('the existing branch-occupancy refusal is unaffected', () => {
  it('still throws BranchOccupiedError before ever touching the path check', async ({ tmp }) => {
    const s = scene(tmp);
    try {
      const occupied = join(tmp, 'someone-elses-checkout');
      s.git.seed({
        path: occupied,
        branch: 'refs/heads/feature',
        detached: false,
        lockReason: 'DeFlow run=r9 node=n9',
      });
      await mkdir(occupied, { recursive: true });

      const thrown = await s.manager
        .provision({
          mode: 'write',
          runId: RUN,
          nodeId: 'n1',
          branch: 'feature',
          path: join(tmp, 'a-fresh-path'),
          baseRef: 'main',
        })
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(BranchOccupiedError);
    } finally {
      s.close();
    }
  });
});

// Confirms the fake's porcelain output really does round-trip through the
// real parser the manager uses — otherwise every "seed" fixture above would
// only be testing the fake, not the manager.
suite('FakeGit sanity: parseWorktreeList reads its porcelain back correctly', () => {
  it('round-trips a locked, branched entry', async () => {
    const git = new FakeGit('/tmp/repo');
    git.seed({
      path: '/tmp/x',
      branch: 'refs/heads/DeFlow/r__n',
      detached: false,
      lockReason: lockReasonFor('r', 'n'),
    });
    const raw = await git.run(WORKTREE_LIST_ARGS as unknown as string[]);
    const parsed = parseWorktreeList(raw.stdout).filter((entry) => entry.path !== '/tmp/repo');
    expect(parsed).toEqual([
      {
        path: '/tmp/x',
        head: '0000000000000000000000000000000000000000',
        branch: 'refs/heads/DeFlow/r__n',
        detached: false,
        bare: false,
        locked: true,
        lockReason: 'DeFlow run=r node=n',
        prunable: false,
        prunableReason: null,
      },
    ]);
  });
});
