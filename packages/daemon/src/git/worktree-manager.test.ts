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
import { mkdir, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { runRef } from './branch-name.ts';
import type { GitResult } from './run-git.ts';
import { STATUS_ARGS } from './status-porcelain.ts';
import {
  lockReasonFor,
  WORKTREE_LIST_ARGS,
  worktreeAddArgs,
  worktreePathFor,
  worktreeRemoveArgs,
  worktreeUnlockArgs,
} from './worktree-args.ts';
import {
  BranchOccupiedError,
  describeOccupant,
  occupancyDecision,
  type WorkspaceGit,
  WorkspaceManager,
  WorktreePathOccupiedError,
} from './worktree-manager.ts';
import { parseWorktreeList, type WorktreeEntry } from './worktree-porcelain.ts';
import {
  salvageAddArgs,
  salvageBranchArgs,
  salvageCommitArgs,
  salvagedRemoveArgs,
} from './worktree-salvage.ts';

const RUN = RunIdSchema.parse('run_20260819T090000Z_5c1d2e');
const EPOCH = 3;

/**
 * Where a detached leftover's salvage commit lands (KAR-07.4 AC6).
 *
 * Lowercased, because a `RunId`'s `T` and `Z` are uppercase and `BRANCH_SAFE`
 * is not — `runRef` is the one sanctioned transformation, and a caller that
 * forgot it would make every real run's salvage throw `UnsafeRefError` and
 * leave the worktree present and dirty.
 */
const SALVAGE_REF = `DeFlow/salvage/${runRef(RUN)}__recon`;

/**
 * One row of the fake's worktree registry, in the shape `git worktree list
 * --porcelain -z` can actually express.
 *
 * `locked` and `lockReason` are two fields rather than one because git prints
 * three different things: `locked <reason>` for a lock taken with `--reason`,
 * a bare `locked` for one taken without, and **no record at all** for a
 * worktree that is not locked. A single `lockReason: string | null` collapses
 * the last two into one shape, which is exactly the collapse that let an
 * unlocked leftover be read as an operator's own bare lock.
 */
interface FakeEntry {
  path: string;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
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
  /** Path → the `status --porcelain=v2 -z` bytes git would print inside it.
   * Absent means clean, which is what an empty parse means to `isDirty`. */
  readonly #dirty = new Map<string, string>();
  /** Path → the oid `rev-parse HEAD` answers with, once a commit was made. */
  readonly #head = new Map<string, string>();
  /** Every ref `branch` or `worktree add -b` created, so `rev-parse --verify`
   * can answer the tip question `remove()` asks before it removes. */
  readonly #refs = new Set<string>();
  #commits = 0;
  addExitCode = 0;
  addStderr = '';

  constructor(mainCheckout: string) {
    this.#mainCheckout = mainCheckout;
  }

  async run(args: readonly string[], opts?: { readonly cwd?: string }): Promise<GitResult> {
    this.calls.push([...args]);
    const argv = args.join(' ');

    if (args[0] === 'worktree' && args[1] === 'list') {
      const main =
        `worktree ${this.#mainCheckout}\0` +
        `HEAD 0000000000000000000000000000000000000000\0branch refs/heads/main\0\0`;
      const rest = [...this.#entries.values()].map((entry) => this.#render(entry)).join('');
      return { exitCode: 0, stdout: main + rest, stderr: '' };
    }

    if (args[0] === 'worktree' && args[1] === 'add') {
      if (this.addExitCode !== 0) {
        return { exitCode: this.addExitCode, stdout: '', stderr: this.addStderr };
      }
      const path = args.at(-2) ?? '';
      // Real git: `worktree add` at a path that already has a registered
      // worktree exits 128 — it does NOT silently re-register or overwrite.
      // This is the exit the pre-fix `provision`'s unconditional second `add`
      // actually hit. Which of the two refusals it is turns on whether the
      // directory is still there, and the second one is the whole of the
      // registered-but-deleted case: git offers `prune` or `remove` to clear
      // it, and `add` alone can never succeed over it.
      if (this.#entries.has(path)) {
        const onDisk = await stat(path).then(
          () => true,
          () => false,
        );
        return {
          exitCode: 128,
          stdout: '',
          stderr: onDisk
            ? `fatal: '${path}' already exists\n`
            : `fatal: '${path}' is a missing but already registered worktree;\n` +
              "use 'add -f' to override, or 'prune' or 'remove' to clear\n",
        };
      }
      const reasonIdx = args.indexOf('--reason');
      const lockReason = args[reasonIdx + 1] ?? '';
      const bIdx = args.indexOf('-b');
      const detached = args.includes('--detach');
      const commitish = args.at(-1) ?? '';
      let branch: string | null = null;
      if (bIdx === -1) {
        // No `-b`: git checks the last positional out *as a branch* when it
        // names one, and only otherwise treats it as a commit-ish. That is the
        // attach form — a worktree re-entering a branch that already exists.
        const named = `refs/heads/${commitish}`;
        branch = !detached && this.#refs.has(named) ? named : null;
      } else {
        // `-b <branch>` asks git to *create* the branch, and git refuses when
        // the name is taken — exit 255, `fatal: a branch named '<b>' already
        // exists`, verified on git 2.43.0. Without this the fake would let a
        // node whose teardown was interrupted re-create the branch its own
        // leftover was checked out on, which is the one thing real git will
        // not do.
        const wanted = args[bIdx + 1] ?? '';
        branch = `refs/heads/${wanted}`;
        if (this.#refs.has(branch)) {
          return {
            exitCode: 255,
            stdout: `Preparing worktree (new branch '${wanted}')\n`,
            stderr: `fatal: a branch named '${wanted}' already exists\n`,
          };
        }
        this.#refs.add(branch);
      }
      this.#entries.set(path, { path, branch, detached, locked: true, lockReason });
      await mkdir(path, { recursive: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (args[0] === 'worktree' && args[1] === 'prune') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    // Built here from the argv the manager itself builds, rather than from a
    // shape spelled twice: a fake that recognised `['worktree','unlock',p]` by
    // hand would keep answering after `worktreeUnlockArgs` changed.
    const unlockPath = args[2] ?? '';
    if (argv === worktreeUnlockArgs(unlockPath).join(' ')) {
      const entry = await this.#entryAt(unlockPath);
      // Real git exits 1 for a worktree that is not locked. `remove()` ignores
      // the code on purpose — unlocked is the state it wanted — and a fake that
      // always exited 0 would hide that it relies on that.
      if (entry === undefined || !entry.locked) {
        return { exitCode: 1, stdout: '', stderr: 'fatal: not locked\n' };
      }
      entry.locked = false;
      entry.lockReason = null;
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    const removeArg = args.at(-1) ?? '';
    const forced = argv === salvagedRemoveArgs(removeArg).join(' ');
    if (forced || argv === worktreeRemoveArgs(removeArg).join(' ')) {
      const entry = await this.#entryAt(removeArg);
      if (entry === undefined) {
        return { exitCode: 128, stdout: '', stderr: `fatal: '${removeArg}' is not a worktree\n` };
      }
      if (entry.locked && !forced) {
        return { exitCode: 128, stdout: '', stderr: `fatal: '${removeArg}' is locked\n` };
      }
      // Real git refuses a dirty worktree without `--force`, in the words
      // §4.4's own note warns not to parse. Reproduced so that a `provision`
      // which reached `remove` on a dirty leftover without deciding from
      // `status` first would fail here rather than quietly pass.
      if (this.#dirty.has(entry.path) && !forced) {
        return {
          exitCode: 128,
          stdout: '',
          stderr: `fatal: '${removeArg}' contains modified or untracked files, use --force to delete it\n`,
        };
      }
      this.#entries.delete(entry.path);
      this.#dirty.delete(entry.path);
      // The **entry's** directory, not the argument's: git removes the worktree
      // it resolved the argument to, so a link handed to `remove` costs the
      // directory at the other end of it and never merely the link.
      await rm(entry.path, { recursive: true, force: true });
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (argv === STATUS_ARGS.join(' ')) {
      return { exitCode: 0, stdout: this.#dirty.get(opts?.cwd ?? '') ?? '', stderr: '' };
    }

    if (argv === salvageAddArgs().join(' ')) return { exitCode: 0, stdout: '', stderr: '' };

    if (argv === salvageCommitArgs().join(' ')) {
      this.#commits += 1;
      this.#head.set(opts?.cwd ?? '', `${'c'.repeat(39)}${this.#commits}`);
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (argv === salvageBranchArgs(args[2] ?? '', args[3] ?? '').join(' ')) {
      this.#refs.add(`refs/heads/${args[2] ?? ''}`);
      return { exitCode: 0, stdout: '', stderr: '' };
    }

    if (argv === 'rev-parse HEAD') {
      const oid = this.#head.get(opts?.cwd ?? '');
      return oid === undefined
        ? { exitCode: 128, stdout: '', stderr: 'fatal: no commit\n' }
        : { exitCode: 0, stdout: `${oid}\n`, stderr: '' };
    }

    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      const ref = args.at(-1) ?? '';
      return this.#refs.has(ref)
        ? { exitCode: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }
        : { exitCode: 1, stdout: '', stderr: '' };
    }

    throw new Error(`FakeGit does not implement: ${argv}`);
  }

  /**
   * The entry a path argument names, the way git resolves one: registrations
   * are keyed by resolved path, so `unlock` and `remove` handed a *symlink*
   * act on the worktree at the other end of it. A fake that looked the raw
   * string up would report "not a worktree" for a link and hide what a real
   * `remove` through one costs.
   */
  async #entryAt(path: string): Promise<FakeEntry | undefined> {
    const direct = this.#entries.get(path);
    if (direct !== undefined) return direct;
    const real = await realpath(path).catch(() => path);
    return this.#entries.get(real);
  }

  /** One entry as `worktree list --porcelain -z` prints it. The `locked`
   * record is emitted in all three of git's forms, which is the whole reason
   * this fake exists in this story. */
  #render(entry: FakeEntry): string {
    const branchRecord = entry.branch === null ? 'detached\0' : `branch ${entry.branch}\0`;
    const lockRecord = !entry.locked
      ? ''
      : entry.lockReason === null
        ? 'locked\0'
        : `locked ${entry.lockReason}\0`;
    return (
      `worktree ${entry.path}\0HEAD 0000000000000000000000000000000000000000\0` +
      `${branchRecord}${lockRecord}\0`
    );
  }

  /** Directly registers an entry, as if a prior `add` had happened — used to
   * seed EPIC-25-S53's "held by someone else" fixture without going through a
   * whole first provision. */
  seed(entry: FakeEntry): void {
    this.#entries.set(entry.path, entry);
    if (entry.branch !== null) this.#refs.add(entry.branch);
  }

  /** A branch with no worktree — what §4.4 leaves behind on purpose, because
   * the branch is the deliverable and outlives the worktree that made it. */
  seedRef(branch: string): void {
    this.#refs.add(`refs/heads/${branch}`);
  }

  /** Whether the ref is still there, which is how a test asserts the teardown
   * did not take the node's work with it. */
  refExists(branch: string): boolean {
    return this.#refs.has(`refs/heads/${branch}`);
  }

  /** What `git worktree unlock <path>` in an operator's own terminal leaves
   * behind, and what a teardown killed between its unlock and its remove
   * leaves behind: the entry is still registered, and no `locked` record is
   * printed for it at all. */
  unlock(path: string): void {
    const entry = this.#entries.get(path);
    if (entry === undefined) throw new Error(`FakeGit has no entry at ${path}`);
    entry.locked = false;
    entry.lockReason = null;
  }

  /** Makes `status --porcelain=v2 -z` inside `path` report one modified file
   * and one untracked one — real porcelain v2 records, so the manager's own
   * parser is what decides they mean "dirty". */
  soil(path: string): void {
    this.#dirty.set(
      path,
      `1 .M N... 100644 100644 100644 ${'a'.repeat(40)} ${'b'.repeat(40)} src/index.ts\0` +
        '? scratch.txt\0',
    );
  }

  /** Whether git still has a registration at `path`. */
  registered(path: string): boolean {
    return this.#entries.has(path);
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
        locked: true,
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
        locked: true,
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
      s.git.seed({
        path,
        branch: 'refs/heads/main',
        detached: false,
        locked: true,
        lockReason: 'on holiday',
      });
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
      // Each request read git's registry exactly once and then added: no
      // branch pre-check ran for either (that is AC6 — a read node claims no
      // branch, so it has nothing to collide on), and neither refused the
      // other. Reading the registry is not a check on a *branch*; it is how
      // `provision` learns whether anything is registered at its own path, and
      // a registered entry whose directory is gone is invisible without it.
      expect(
        s.git.calls.filter((argv) => argv.join(' ') === WORKTREE_LIST_ARGS.join(' ')),
      ).toHaveLength(2);
      expect(events(s.db).map((event) => event.kind)).not.toContain('workspace.branch_occupied');
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

// ── EPIC-26-S01, EPIC-26-S02, EPIC-26-S03 ────────────────────────────────────
//
// KAR-26.1 — an interrupted §4.4 teardown at the node's own path is finished,
// not refused. `remove()` runs unlock first and ignores its exit code, then
// `worktree remove` without force; a crash between the two, or a `remove` that
// git refused because the tree was dirty, leaves the entry **registered and
// unlocked** at exactly the path this run and node derive for themselves. That
// is DeFlow's own half-removed worktree, and the pre-KAR-26.1 code read it as a
// stranger and refused for ever.

/** The argv of every `worktree` subcommand the fake was asked for, in order. */
const worktreeSubcommands = (git: FakeGit): string[] =>
  git.calls.filter((argv) => argv[0] === 'worktree').map((argv) => argv[1] ?? '');

const eventKinds = (db: Db): string[] => events(db).map((event) => event.kind);

suite(
  'EPIC-26-S01: an unlocked registered worktree is a finished teardown, then a fresh one',
  () => {
    it('removes without --force, then adds, and lands one _removed before one _created (AC1)', async ({
      tmp,
    }) => {
      const s = scene(tmp);
      try {
        const path = s.wt(RUN, 'recon');
        // What an interrupted teardown leaves: git still lists the entry, and
        // prints no `locked` record for it at all.
        s.git.seed({ path, branch: null, detached: true, locked: false, lockReason: null });
        await mkdir(path, { recursive: true });

        const result = await s.manager.provision({
          mode: 'read',
          runId: RUN,
          nodeId: 'recon',
          path,
          baseRef: 'main',
        });

        expect(result.path).toBe(path);
        expect(result.lockReason).toBe(lockReasonFor(RUN, 'recon'));

        const kinds = eventKinds(s.db);
        expect(kinds.filter((kind) => kind === 'workspace.worktree_removed')).toHaveLength(1);
        expect(kinds.filter((kind) => kind === 'workspace.worktree_created')).toHaveLength(1);
        expect(kinds.indexOf('workspace.worktree_removed')).toBeLessThan(
          kinds.indexOf('workspace.worktree_created'),
        );
        // A clean leftover is removed plainly — the salvage force is for work
        // that would otherwise be destroyed, and there is none here.
        expect(s.git.calls).toContainEqual(worktreeRemoveArgs(path));
        expect(s.git.calls).not.toContainEqual(salvagedRemoveArgs(path));
        expect(worktreeSubcommands(s.git)).toContain('add');
        expect(kinds).not.toContain('workspace.dirty_on_remove');
      } finally {
        s.close();
      }
    });

    it('does not refuse it as somebody else’s worktree', async ({ tmp }) => {
      const s = scene(tmp);
      try {
        const path = s.wt(RUN, 'recon');
        s.git.seed({ path, branch: null, detached: true, locked: false, lockReason: null });
        await mkdir(path, { recursive: true });

        const thrown = await s.manager
          .provision({ mode: 'read', runId: RUN, nodeId: 'recon', path, baseRef: 'main' })
          .catch((error: unknown) => error);

        expect(thrown).not.toBeInstanceOf(WorktreePathOccupiedError);
        expect(s.git.registered(path)).toBe(true);
      } finally {
        s.close();
      }
    });

    it('a write node’s unlocked leftover is torn down on its own recorded branch, not the request’s', async ({
      tmp,
    }) => {
      const s = scene(tmp);
      try {
        const path = s.wt(RUN, 'n1');
        // The leftover is on the branch a *previous* attempt checked out. It is
        // read back from porcelain rather than assumed to be this request's,
        // because the two genuinely differ after a re-plan.
        s.git.seed({
          path,
          branch: 'refs/heads/DeFlow/older-attempt',
          detached: false,
          locked: false,
          lockReason: null,
        });
        await mkdir(path, { recursive: true });

        await s.manager.provision({
          mode: 'write',
          runId: RUN,
          nodeId: 'n1',
          branch: 'DeFlow/n1',
          path,
          baseRef: 'main',
        });

        const removed = events(s.db).find((event) => event.kind === 'workspace.worktree_removed');
        expect(removed?.payload.branch).toBe('DeFlow/older-attempt');
        const created = events(s.db).find((event) => event.kind === 'workspace.worktree_created');
        expect(created?.payload.branch).toBe('DeFlow/n1');
      } finally {
        s.close();
      }
    });
  },
);

suite('EPIC-26-S02: the dirty variant salvages before it removes', () => {
  it('runs KAR-07.4’s order — capture, commit, then the single force — and then provisions (AC1)', async ({
    tmp,
  }) => {
    const s = scene(tmp);
    try {
      const path = s.wt(RUN, 'recon');
      s.git.seed({ path, branch: null, detached: true, locked: false, lockReason: null });
      await mkdir(path, { recursive: true });
      // An agent's uncommitted work, sitting in the worktree the interrupted
      // teardown could not remove. This is exactly what git refused to discard.
      s.git.soil(path);

      await s.manager.provision({
        mode: 'read',
        runId: RUN,
        nodeId: 'recon',
        path,
        baseRef: 'main',
      });

      // Nothing is skipped because *provisioning* triggered the sequence
      // rather than completion: it is the same `remove()`, so it is the same
      // four events in the same order.
      const kinds = eventKinds(s.db).filter((kind) => kind.startsWith('workspace.'));
      expect(kinds).toEqual([
        'workspace.dirty_on_remove',
        'workspace.wip_salvaged',
        'workspace.worktree_removed',
        'workspace.worktree_created',
      ]);

      const argv = s.git.calls.map((call) => call.join(' '));
      const order = [
        STATUS_ARGS.join(' '),
        salvageAddArgs().join(' '),
        salvageCommitArgs().join(' '),
        'rev-parse HEAD',
        // A detached leftover has no branch of its own, so the commit is made
        // reachable by KAR-07.4 AC6's throwaway ref.
        salvageBranchArgs(SALVAGE_REF, `${'c'.repeat(39)}1`).join(' '),
        worktreeUnlockArgs(path).join(' '),
        salvagedRemoveArgs(path).join(' '),
      ].map((one) => argv.indexOf(one));

      expect(order).not.toContain(-1);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      // The `worktree add` is last: provisioning proceeds as for a fresh path.
      expect(
        argv.lastIndexOf(
          worktreeAddArgs({
            mode: 'read',
            runId: RUN,
            nodeId: 'recon',
            path,
            baseRef: 'main',
          }).join(' '),
        ),
      ).toBeGreaterThan(Math.max(...order));
    } finally {
      s.close();
    }
  });

  it('the salvage commit is reachable, and no plain remove was attempted first', async ({
    tmp,
  }) => {
    const s = scene(tmp);
    try {
      const path = s.wt(RUN, 'recon');
      s.git.seed({ path, branch: null, detached: true, locked: false, lockReason: null });
      await mkdir(path, { recursive: true });
      s.git.soil(path);

      await s.manager.provision({
        mode: 'read',
        runId: RUN,
        nodeId: 'recon',
        path,
        baseRef: 'main',
      });

      const salvaged = events(s.db).find((event) => event.kind === 'workspace.wip_salvaged');
      expect(salvaged?.payload.branch).toBe(SALVAGE_REF);
      expect(salvaged?.payload.files).toBe(2);
      // §4.4 decides from `status`, never by running the plain remove and
      // reading git's refusal — so the plain form is never issued at all.
      expect(s.git.calls).not.toContainEqual(worktreeRemoveArgs(path));
    } finally {
      s.close();
    }
  });
});

suite('EPIC-26-S03: a worktree locked with this node’s own reason is still reused', () => {
  it('appends workspace.worktree_reused and removes nothing (AC2, KAR-25.8 AC2)', async ({
    tmp,
  }) => {
    const s = scene(tmp);
    try {
      const path = s.wt(RUN, 'recon');
      s.git.seed({
        path,
        branch: null,
        detached: true,
        locked: true,
        lockReason: lockReasonFor(RUN, 'recon'),
      });
      await mkdir(path, { recursive: true });

      await s.manager.provision({
        mode: 'read',
        runId: RUN,
        nodeId: 'recon',
        path,
        baseRef: 'main',
      });

      expect(eventKinds(s.db)).toContain('workspace.worktree_reused');
      // The teardown-completion arm must not have been taken: this worktree is
      // live, and removing it would destroy a running node's workspace.
      expect(worktreeSubcommands(s.git)).not.toContain('remove');
      expect(worktreeSubcommands(s.git)).not.toContain('add');
      expect(eventKinds(s.db)).not.toContain('workspace.worktree_removed');
    } finally {
      s.close();
    }
  });
});

// ── EPIC-26-S06, EPIC-26-S07 ────────────────────────────────────────────────

/** A porcelain entry at `path`, with only the fields these arms read stated. */
const entryAt = (path: string, over: Partial<WorktreeEntry> = {}): WorktreeEntry => ({
  path,
  head: '0'.repeat(40),
  branch: null,
  detached: true,
  bare: false,
  locked: false,
  lockReason: null,
  prunable: false,
  prunableReason: null,
  ...over,
});

const OCCUPIED = '/tmp/wt/run_1__recon';

suite('EPIC-26-S07: the occupant description never points the path at itself', () => {
  it('names the interrupted removal for an unlocked entry, without naming the path (AC4)', () => {
    const described = describeOccupant(entryAt(OCCUPIED));

    expect(described).not.toContain(OCCUPIED);
    expect(described).toMatch(/no lock/i);
    expect(described).toMatch(/interrupted removal/i);
  });

  it('names the owner a DeFlow lock reason declares (AC4)', () => {
    const described = describeOccupant(
      entryAt(OCCUPIED, { locked: true, lockReason: lockReasonFor('run_other', 'other-node') }),
    );

    expect(described).not.toContain(OCCUPIED);
    expect(described).toContain('run run_other');
    expect(described).toContain('node other-node');
  });

  it('quotes an operator’s own reason verbatim rather than inventing an owner (AC4)', () => {
    const described = describeOccupant(
      entryAt(OCCUPIED, { locked: true, lockReason: 'on holiday' }),
    );

    expect(described).not.toContain(OCCUPIED);
    expect(described).toContain('on holiday');
    expect(described).toMatch(/operator/i);
  });

  it('says an operator locked it with no reason for a bare lock (AC4)', () => {
    const described = describeOccupant(entryAt(OCCUPIED, { locked: true, lockReason: null }));

    expect(described).not.toContain(OCCUPIED);
    expect(described).toMatch(/operator/i);
    expect(described).toMatch(/no reason/i);
  });

  it('the refusal message names the occupant and never says the path belongs to itself', () => {
    const error = new WorktreePathOccupiedError(
      OCCUPIED,
      describeOccupant(entryAt(OCCUPIED, { locked: true, lockReason: 'on holiday' })),
    );

    expect(error.message).toContain('on holiday');
    // The exact sentence the owner's daemon logged once per tick, for ever.
    expect(error.message).not.toContain('already belongs to');
    expect(error.message).not.toContain(`worktree at "${OCCUPIED}", not this run`);
  });
});

suite(
  'EPIC-26-S06: only an unlocked entry is adopted; every lock but this node’s is foreign',
  () => {
    const request = { runId: 'r1', nodeId: 'n1' };
    /** The ordinary site: the node's own derived path, a real directory. */
    const here = { reachedThroughSymlink: false };

    it('an unlocked entry is the interrupted teardown, and nothing else is', () => {
      expect(occupancyDecision(request, entryAt(OCCUPIED), here)).toEqual({
        kind: 'finish-teardown',
      });
    });

    it('this run and node’s own lock is reused', () => {
      const entry = entryAt(OCCUPIED, { locked: true, lockReason: lockReasonFor('r1', 'n1') });

      expect(occupancyDecision(request, entry, here)).toEqual({ kind: 'reuse' });
    });

    it('another run’s DeFlow lock is refused, naming that owner', () => {
      const entry = entryAt(OCCUPIED, { locked: true, lockReason: lockReasonFor('r2', 'n9') });

      const decision = occupancyDecision(request, entry, here);
      expect(decision.kind).toBe('refuse');
      expect(decision.kind === 'refuse' && decision.occupant).toContain('run r2');
    });

    it('a bare `locked` record is an operator’s lock, refused — not an unlocked entry', () => {
      // `git worktree lock <path>` with no `--reason` prints `locked` with no
      // value, which parses to `{locked: true, lockReason: null}`. Branching on
      // the reason alone would fold it into the teardown arm and destroy an
      // operator's own worktree, which is the one thing this story must not do.
      const entry = entryAt(OCCUPIED, { locked: true, lockReason: null });

      expect(occupancyDecision(request, entry, here).kind).toBe('refuse');
    });

    it('an operator’s own reason is refused and quoted', () => {
      const entry = entryAt(OCCUPIED, { locked: true, lockReason: 'on holiday' });

      const decision = occupancyDecision(request, entry, here);
      expect(decision.kind).toBe('refuse');
      expect(decision.kind === 'refuse' && decision.occupant).toContain('on holiday');
    });

    it('the refusal carries a gate-class failure tag, so it is terminal rather than retried (AC3)', () => {
      const error = new WorktreePathOccupiedError(OCCUPIED, 'run r2 node n9');

      expect(error.deflowFailure).toEqual({ reason: 'safety.execution-boundary', class: 'gate' });
    });
  },
);

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
          locked: true,
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
        locked: true,
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
      locked: true,
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

  /**
   * The anti-vacuity harness for KAR-26.1, and the reason the fake was changed
   * at all.
   *
   * Every scenario below turns on *which* of git's three lock shapes an entry
   * has, and the old fake could express exactly one of them. A fake that
   * rendered `locked <reason>` unconditionally makes the unlocked case
   * unreachable and the bare-lock case indistinguishable from it — so the
   * shapes are parsed back with the real `parseWorktreeList` here, once, rather
   * than trusted anywhere below.
   */
  it('round-trips all four shapes: DeFlow-locked, foreign-locked, bare-locked and unlocked', async () => {
    const git = new FakeGit('/tmp/repo');
    git.seed({
      path: '/tmp/ours',
      branch: null,
      detached: true,
      locked: true,
      lockReason: lockReasonFor('r1', 'n1'),
    });
    git.seed({
      path: '/tmp/theirs',
      branch: null,
      detached: true,
      locked: true,
      lockReason: lockReasonFor('r2', 'n9'),
    });
    git.seed({ path: '/tmp/bare', branch: null, detached: true, locked: true, lockReason: null });
    git.seed({ path: '/tmp/free', branch: null, detached: true, locked: false, lockReason: null });

    const raw = await git.run([...WORKTREE_LIST_ARGS]);
    const shapes = parseWorktreeList(raw.stdout)
      .filter((entry) => entry.path !== '/tmp/repo')
      .map((entry) => [entry.path, entry.locked, entry.lockReason] as const);

    expect(shapes).toEqual([
      ['/tmp/ours', true, 'DeFlow run=r1 node=n1'],
      ['/tmp/theirs', true, 'DeFlow run=r2 node=n9'],
      // A lock taken with no `--reason`: git prints the record with no value.
      ['/tmp/bare', true, null],
      // Not locked at all: git prints no `locked` record, which is the shape
      // an interrupted teardown leaves and the one the old fake could not make.
      ['/tmp/free', false, null],
    ]);
  });
});

// ── EPIC-26-S01, write nodes ────────────────────────────────────────────────
//
// A write node's leftover is checked out on the branch `nodeBranch` derives
// from its own run and node ids — deterministically the branch its next
// attempt asks for. Finishing the teardown frees the *path* and deliberately
// keeps the *branch* (§4.4: the branch is the deliverable, F5.5), so a
// provision that then asked git to create that branch could never succeed:
// `fatal: a branch named '<b>' already exists`, on this attempt and every
// later one, with the worktree already destroyed. AC1's "provisioning proceeds
// as for a fresh path" has to hold for a write node too, and a fresh path
// whose branch already exists is entered, not re-created.

suite('EPIC-26-S01: a write node’s interrupted teardown can still provision (AC1)', () => {
  const writeRequest = (path: string, branch: string) => ({
    mode: 'write' as const,
    runId: RUN,
    nodeId: 'n1',
    branch,
    path,
    baseRef: 'main',
  });

  it('re-enters the branch the leftover was on rather than asking git to create it twice', async ({
    tmp,
  }) => {
    const s = scene(tmp);
    try {
      const path = s.wt(RUN, 'n1');
      const branch = `DeFlow/${runRef(RUN)}__n1`;
      // The interrupted teardown, for a write node: registered, unlocked, and
      // on the very branch this request is about to ask for.
      s.git.seed({
        path,
        branch: `refs/heads/${branch}`,
        detached: false,
        locked: false,
        lockReason: null,
      });
      await mkdir(path, { recursive: true });

      const result = await s.manager.provision(writeRequest(path, branch));

      expect(result.path).toBe(path);
      expect(result.branch).toBe(branch);
      const kinds = eventKinds(s.db);
      expect(kinds.indexOf('workspace.worktree_removed')).toBeLessThan(
        kinds.indexOf('workspace.worktree_created'),
      );
      // The add never asks git to create a name it already holds.
      const add = s.git.calls.find((argv) => argv[0] === 'worktree' && argv[1] === 'add') ?? [];
      expect(add).not.toContain('-b');
      expect(add.at(-1)).toBe(branch);
    } finally {
      s.close();
    }
  });

  it('keeps the branch across the teardown — it is the node’s deliverable, not scratch', async ({
    tmp,
  }) => {
    const s = scene(tmp);
    try {
      const path = s.wt(RUN, 'n1');
      const branch = `DeFlow/${runRef(RUN)}__n1`;
      s.git.seed({
        path,
        branch: `refs/heads/${branch}`,
        detached: false,
        locked: false,
        lockReason: null,
      });
      await mkdir(path, { recursive: true });
      // Work the agent committed before the daemon died: on the branch, and
      // the only copy of it there is.
      s.git.soil(path);

      await s.manager.provision(writeRequest(path, branch));

      // Deleting the branch would be the other way to make `-b` succeed, and
      // it would take the salvage commit with it.
      expect(s.git.refExists(branch)).toBe(true);
      expect(s.git.calls.filter((argv) => argv[0] === 'branch' && argv.includes('-D'))).toEqual([]);
      const salvaged = events(s.db).find((event) => event.kind === 'workspace.wip_salvaged');
      expect(salvaged?.payload.branch).toBe(branch);
    } finally {
      s.close();
    }
  });

  it('provisions on a later attempt too, when only the branch is left', async ({ tmp }) => {
    const s = scene(tmp);
    try {
      const path = s.wt(RUN, 'n1');
      const branch = `DeFlow/${runRef(RUN)}__n1`;
      // The state one completed teardown leaves behind: no worktree, no
      // directory, and the branch §4.4 kept on purpose. Every later drive tick
      // starts here, so a provision that fails on this shape fails for ever.
      s.git.seedRef(branch);

      const result = await s.manager.provision(writeRequest(path, branch));

      expect(result.branch).toBe(branch);
      expect(eventKinds(s.db)).toContain('workspace.worktree_created');
    } finally {
      s.close();
    }
  });

  it('git itself refuses `-b` on a branch that exists — the fake is not being kind', async ({
    tmp,
  }) => {
    // Anti-vacuity, against `FakeGit` directly: without this refusal every
    // assertion above would pass over a `provision` that still ran `add -b`
    // into an occupied name, which is exactly what real git rejects with
    // exit 255 (verified on git 2.43.0).
    const s = scene(tmp);
    try {
      const spec = {
        mode: 'write' as const,
        runId: 'r1',
        nodeId: 'n1',
        branch: 'DeFlow/r1__n1',
        path: join(tmp, 'wt-a'),
        baseRef: 'main',
      };
      await s.git.run(worktreeAddArgs(spec));

      const again = await s.git.run(worktreeAddArgs({ ...spec, path: join(tmp, 'wt-b') }));

      expect(again.exitCode).not.toBe(0);
      expect(again.stderr).toContain("a branch named 'DeFlow/r1__n1' already exists");
    } finally {
      s.close();
    }
  });
});

// ── EPIC-26-S01, the directory already gone ─────────────────────────────────
//
// `git worktree remove` deletes the working directory *before* it clears the
// administrative entry, so a teardown killed inside that window leaves
// registered + unlocked + no directory — the same interrupted removal as the
// dirty variant, from the other end. An operator's own `rm -rf` of a stale
// worktree lands in the identical state. git marks the entry `prunable` and
// keeps reporting it, and `worktree add` over it can only ever fail.

suite('EPIC-26-S01: an interrupted teardown whose directory is already gone (AC1)', () => {
  it('finishes the removal from git’s own registry, and provisions over it', async ({ tmp }) => {
    const s = scene(tmp);
    try {
      const path = s.wt(RUN, 'recon');
      // Registered, unlocked, and no directory — seeded without the mkdir
      // every other fixture in this file does.
      s.git.seed({ path, branch: null, detached: true, locked: false, lockReason: null });

      const result = await s.manager.provision({
        mode: 'read',
        runId: RUN,
        nodeId: 'recon',
        path,
        baseRef: 'main',
      });

      expect(result.path).toBe(path);
      const kinds = eventKinds(s.db);
      expect(kinds.filter((kind) => kind === 'workspace.worktree_removed')).toHaveLength(1);
      expect(kinds.filter((kind) => kind === 'workspace.worktree_created')).toHaveLength(1);
      expect(kinds.indexOf('workspace.worktree_removed')).toBeLessThan(
        kinds.indexOf('workspace.worktree_created'),
      );
    } finally {
      s.close();
    }
  });

  it('asks for no status and salvages nothing — there is no working tree to hold work', async ({
    tmp,
  }) => {
    const s = scene(tmp);
    try {
      const path = s.wt(RUN, 'recon');
      s.git.seed({ path, branch: null, detached: true, locked: false, lockReason: null });

      await s.manager.provision({
        mode: 'read',
        runId: RUN,
        nodeId: 'recon',
        path,
        baseRef: 'main',
      });

      // `git status` runs *inside* the worktree (§4.4 step 1), and a directory
      // that is not there cannot be a cwd — asking would fail the provision
      // rather than complete the teardown.
      expect(s.git.calls).not.toContainEqual([...STATUS_ARGS]);
      expect(eventKinds(s.db)).not.toContain('workspace.dirty_on_remove');
      expect(s.git.calls).not.toContainEqual(salvagedRemoveArgs(path));
    } finally {
      s.close();
    }
  });
});

// ── The path is a symlink ───────────────────────────────────────────────────
//
// `findRegistered` matches by realpath, on purpose: a symlinked *ancestor*
// must not make a run's own worktree look unregistered. But the same
// resolution means a symlink at the node's own path matches whatever it points
// at, and the justification for adopting an unlocked entry — "this path is
// derived from the very run and node now asking for it" — is a fact about the
// path, not about the directory it resolves to. Adopting through one costs an
// operator the worktree at the other end.

suite('a symlink at the node’s own path is refused, never adopted', () => {
  it('refuses instead of finishing a teardown of the worktree the link points at', async ({
    tmp,
  }) => {
    const s = scene(tmp);
    try {
      const operator = join(tmp, 'operator-wt');
      await mkdir(operator, { recursive: true });
      await writeFile(join(operator, 'precious.txt'), 'hours of uncommitted work');
      const path = s.wt(RUN, 'recon');
      await mkdir(join(path, '..'), { recursive: true });
      await symlink(operator, path, 'dir');
      // The operator's own worktree: registered, and unlocked because they
      // never locked it — indistinguishable, by lock alone, from DeFlow's own
      // half-removed one.
      s.git.seed({
        path: await realpath(operator),
        branch: null,
        detached: true,
        locked: false,
        lockReason: null,
      });

      const thrown = await s.manager
        .provision({ mode: 'read', runId: RUN, nodeId: 'recon', path, baseRef: 'main' })
        .catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(WorktreePathOccupiedError);
      // Named by where it really is, which is the one thing that tells an
      // operator what happened.
      expect((thrown as WorktreePathOccupiedError).occupiedBy).toContain(operator);
      expect(worktreeSubcommands(s.git)).not.toContain('remove');
      expect(worktreeSubcommands(s.git)).not.toContain('add');
      expect(await exists(join(operator, 'precious.txt'))).toBe(true);
      expect(eventKinds(s.db)).not.toContain('workspace.worktree_removed');
    } finally {
      s.close();
    }
  });

  it('refuses a symlink even when the lock reason names this very run and node', async ({
    tmp,
  }) => {
    const s = scene(tmp);
    try {
      const elsewhere = join(tmp, 'elsewhere');
      await mkdir(elsewhere, { recursive: true });
      const path = s.wt(RUN, 'recon');
      await mkdir(join(path, '..'), { recursive: true });
      await symlink(elsewhere, path, 'dir');
      s.git.seed({
        path: await realpath(elsewhere),
        branch: null,
        detached: true,
        locked: true,
        lockReason: lockReasonFor(RUN, 'recon'),
      });

      const thrown = await s.manager
        .provision({ mode: 'read', runId: RUN, nodeId: 'recon', path, baseRef: 'main' })
        .catch((error: unknown) => error);

      // Reuse would return `request.path` as the worktree's path — a lie about
      // where the node's files are, and the ledger's record of it.
      expect(thrown).toBeInstanceOf(WorktreePathOccupiedError);
      expect(eventKinds(s.db)).not.toContain('workspace.worktree_reused');
    } finally {
      s.close();
    }
  });

  it('the decision itself refuses a symlinked site, whatever the lock says', () => {
    const request = { runId: 'r1', nodeId: 'n1' };
    const linked = { reachedThroughSymlink: true };

    for (const entry of [
      entryAt(OCCUPIED),
      entryAt(OCCUPIED, { locked: true, lockReason: lockReasonFor('r1', 'n1') }),
    ]) {
      const decision = occupancyDecision(request, entry, linked);
      expect(decision.kind).toBe('refuse');
      expect(decision.kind === 'refuse' && decision.occupant).toContain(OCCUPIED);
    }
  });
});
