/**
 * KAR-07.8 — orphaned worktree reaping on daemon start, against real git and
 * real processes (docs/09-workspace-and-safety.md §4.5, §11.3).
 *
 * `detached: true` means an agent survives DeFlowd's death, so a `kill -9` of
 * the daemon leaves real processes editing real worktrees that are still
 * `git worktree lock`ed — and **locked worktrees are immune to `prune`**. The
 * order reap → unlock → prune is therefore the whole story: pruning first is a
 * no-op that looks like success, and the second scenario below is the test that
 * pins it.
 *
 * Everything here is a real detached process group and a real `git`. A mocked
 * `kill` would prove the reaper calls a function; what is under test is that a
 * process stops existing, a lock stops being held and an administrative entry
 * stops being listed.
 *
 * **Three findings recorded here**, all from real git 2.50.1 on 2026-08-06:
 *
 * 1. A **locked** worktree whose directory was `rm -rf`'d is *not* reported
 *    `prunable` at all, and `prune` says nothing about it. Unlocking it is what
 *    makes it prunable. This is §4.5's ordering, verified rather than assumed.
 * 2. `--expire 2.weeks.ago` **suppresses** the removal of a freshly orphaned
 *    entry. `git worktree prune` with no `--expire` uses `TIME_MAX` — prune
 *    everything prunable — and passing an expiry narrows that to entries whose
 *    `.git/worktrees/<name>/index` has not been touched since. So the boot
 *    prune is a *conservative sweep of long-dead entries*, and it is emphatically
 *    not what removes the worktree of an agent that died an hour ago. That is
 *    `remove -f -f`, on the reaper path only, once the owning process is proven
 *    gone (AC5).
 * 3. `prune -v` writes `Removing worktrees/<name>: …` to **stderr**, not
 *    stdout. A reader that took stdout alone would see an empty string and
 *    conclude, every time, that nothing had been pruned.
 *
 * Verifies: EPIC-07-S29, EPIC-07-S31, EPIC-07-S32 · AC1–AC7
 */

import { processStartTime } from '@DeFlow/adapters';
import type { Db } from '@DeFlow/core';
import {
  openLedger,
  type ProcessRowDraft,
  readProcesses,
  readRange,
  readWorktrees,
  recordProcess,
} from '@DeFlow/ledger';
import { GIT_ENV, git, it, makeRepo, TestClock, waitFor } from '@DeFlow/testkit';
import { spawn } from 'node:child_process';
import { mkdir, realpath, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { Git } from '../../src/git/git.ts';
import { lockReasonFor, worktreePathFor } from '../../src/git/worktree-args.ts';
import { reapOrphans } from '../../src/reaper.ts';
import { reapWorktrees } from '../../src/workspace/worktree-reaper.ts';

const RUN = 'run_20260806T090000Z_5c1d2e';
const SHA = 'a'.repeat(64);
const EPOCH = 7;
const NOW = 1_754_400_000_000;

/** A pid this machine will not have handed out: above every default
 * `kern.maxproc`/`pid_max`, so `processStartTime` genuinely reports "gone". */
const DEAD_PID = 4_194_303;

const strays: number[] = [];

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone, which is what most of these specs are asserting.
    }
  }
});

/** A real, detached, group-leading process — an orphan of the kind a dead
 * daemon leaves behind. */
async function startOrphan(): Promise<number> {
  const child = spawn('/bin/sh', ['-c', 'sleep 300'], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const pid = child.pid as number;
  child.unref();
  strays.push(pid);
  return pid;
}

interface Scene {
  readonly root: string;
  readonly repo: string;
  readonly db: Db;
  readonly calls: string[][];
  /** Only the `worktree …` invocations, which is what the scenarios name. */
  worktreeCalls(): string[][];
  /** Creates a DeFlow-owned, locked worktree for `nodeId` and returns its path. */
  provision(nodeId: string, runId?: string): Promise<string>;
  /** Runs the boot sweep over this repository. */
  sweep(over?: { startTime?: (pid: number) => string | null }): Promise<SweepReport>;
  entries(): Promise<string>;
  close(): void;
}

type SweepReport = Awaited<ReturnType<typeof reapWorktrees>>;

async function scene(tmp: string): Promise<Scene> {
  const root = await realpath(tmp);
  const repo = join(root, 'repo');
  await makeRepo({ dir: repo });

  const wrapped = new Git(repo, { env: GIT_ENV });
  const calls: string[][] = [];
  const recording = {
    run: (args: readonly string[], opts?: { readonly cwd?: string }) => {
      calls.push([...args]);
      return wrapped.run(args, opts);
    },
  };
  const db = openLedger(root);

  return {
    root,
    repo,
    db,
    calls,
    worktreeCalls: () => calls.filter((argv) => argv[0] === 'worktree'),
    provision: async (nodeId, runId = RUN) => {
      const path = worktreePathFor(repo, runId, nodeId);
      await git(repo, [
        'worktree',
        'add',
        '--lock',
        '--reason',
        lockReasonFor(runId, nodeId),
        '-b',
        `DeFlow/${runId}__${nodeId}`,
        path,
        'main',
      ]);
      return path;
    },
    sweep: (over = {}) =>
      reapWorktrees({
        db,
        clock: new TestClock(NOW),
        epoch: EPOCH,
        repos: [{ repoRoot: repo, git: recording }],
        ...(over.startTime === undefined ? {} : { startTime: over.startTime }),
      }),
    entries: () => git(repo, ['worktree', 'list', '--porcelain']),
    close: () => {
      db.close();
    },
  };
}

const row = (over: Partial<ProcessRowDraft>): ProcessRowDraft => ({
  runId: RUN,
  nodeId: 'n1',
  attempt: 0,
  pid: DEAD_PID,
  pgid: DEAD_PID,
  startedAt: 'Wed Aug  5 10:15:00 2026',
  binarySha256: SHA,
  worktree: null,
  spawnedAt: NOW - 60_000,
  ...over,
});

const events = (db: Db, runId = RUN): { kind: string; payload: unknown }[] =>
  readRange(db, runId, 0, 500).events.map((event) => ({
    kind: event.kind,
    payload: event.payload,
  }));

/** `.git/worktrees/<name>/index`'s mtime is what `--expire` is measured
 * against, so backdating it is how a spec ages an entry without waiting a
 * fortnight. @see this file's header, finding 2. */
async function ageAdminEntry(repo: string, name: string, days: number): Promise<void> {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  await utimes(join(repo, '.git', 'worktrees', name, 'index'), when, when);
}

// ── EPIC-07-S29 — reap → unlock → prune, in that order ──────────────────────

suite('EPIC-07-S29: the full recovery on restart (AC1, AC3)', () => {
  it('kills the orphan, then unlocks, then prunes — in that git order', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const pid = await startOrphan();
      const worktree = await s.provision('n1');
      recordProcess(s.db, row({ pid, pgid: pid, startedAt: processStartTime(pid), worktree }));

      // Step 1: the process half (KAR-05.9, extended here by AC3's verification).
      const reaped = await reapOrphans(s.db, { clock: new TestClock(NOW), epoch: EPOCH });
      expect(reaped).toEqual([expect.objectContaining({ outcome: 'reaped', survivors: [] })]);
      await waitFor(
        () => {
          try {
            process.kill(pid, 0);
            return false;
          } catch {
            return true;
          }
        },
        { describe: 'the orphaned process group to be gone' },
      );

      // Step 2 and 3: unlock, then prune — the sweep, and the order under test.
      const report = await s.sweep();

      expect(report.decisions).toEqual([
        expect.objectContaining({ path: worktree, action: 'reaped', nodeId: 'n1' }),
      ]);

      const argv = s.worktreeCalls().map((call) => call.slice(0, 2).join(' '));
      expect(argv).toEqual([
        'worktree list',
        'worktree unlock',
        'worktree remove',
        'worktree prune',
        'worktree list',
      ]);
      expect(argv.indexOf('worktree unlock')).toBeLessThan(argv.indexOf('worktree prune'));

      // And the two argvs in full, because the flags are the acceptance criteria.
      expect(s.worktreeCalls().find((call) => call[1] === 'unlock')).toEqual([
        'worktree',
        'unlock',
        worktree,
      ]);
      expect(s.worktreeCalls().find((call) => call[1] === 'prune')).toEqual([
        'worktree',
        'prune',
        '-v',
        '--expire',
        '2.weeks.ago',
      ]);

      expect(await s.entries()).not.toContain(worktree);
      // The branch outlives the worktree, because the branch is the deliverable.
      expect(
        await git(s.repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
      ).toContain(`DeFlow/${RUN}__n1`);
    } finally {
      s.close();
    }
  });

  it('pins the trap: pruning before unlocking silently does nothing', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const worktree = await s.provision('n1');
      await rm(worktree, { recursive: true, force: true });

      // Verified finding 1: a *locked* entry whose directory is gone is not
      // even reported prunable, so prune has nothing to say about it.
      expect(await s.entries()).toContain('locked');
      expect(await s.entries()).not.toContain('prunable');

      const before = await git(s.repo, ['worktree', 'prune', '-v', '--expire', '2.weeks.ago']);
      expect(before).toBe('');
      expect(await s.entries()).toContain(worktree);

      // Unlock, and the same entry becomes prunable — which is the whole reason
      // §4.5 orders reap, unlock, prune rather than reap, prune, unlock.
      await git(s.repo, ['worktree', 'unlock', worktree]);
      expect(await s.entries()).toContain('prunable');
    } finally {
      s.close();
    }
  });

  it('is idempotent: a second sweep changes nothing and appends no event', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const worktree = await s.provision('n1');
      recordProcess(s.db, row({ worktree }));

      const first = await s.sweep();
      expect(first.decisions).toEqual([expect.objectContaining({ action: 'reaped' })]);
      const afterFirst = await s.entries();
      const eventsAfterFirst = events(s.db);
      expect(eventsAfterFirst.map((event) => event.kind)).toEqual(['workspace.orphan_reaped']);

      const second = await s.sweep();

      expect(second.decisions).toEqual([]);
      expect(await s.entries()).toBe(afterFirst);
      expect(events(s.db)).toEqual(eventsAfterFirst);
      expect(readWorktrees(s.db).map((stored) => stored.path)).toEqual([s.repo]);
    } finally {
      s.close();
    }
  });

  it('reaps 20 orphaned rows inside the cold-start budget (AC7)', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const worktrees: string[] = [];
      for (let index = 0; index < 20; index += 1) {
        const nodeId = `n${index}`;
        worktrees.push(await s.provision(nodeId));
        recordProcess(
          s.db,
          row({ nodeId, worktree: worktrees[index] as string, pid: DEAD_PID - index }),
        );
      }

      // The control: 20 bare `git worktree list` subprocesses against this same
      // repository in this same state, measured on this same machine. The sweep
      // spends its time in git subprocesses too, so a loaded box inflates both
      // and the ratio stays honest — where a bare wall-clock budget would just
      // be measuring how busy the rest of the suite is (EPIC-05's two timing
      // budgets went red for exactly that reason).
      const controlStarted = performance.now();
      for (let index = 0; index < 20; index += 1) {
        await git(s.repo, ['worktree', 'list', '--porcelain', '-z']);
      }
      const control = performance.now() - controlStarted;

      const started = performance.now();
      await reapOrphans(s.db, { clock: new TestClock(NOW), epoch: EPOCH });
      const report = await s.sweep();
      const elapsed = performance.now() - started;

      expect(report.decisions).toHaveLength(20);
      expect(report.decisions.every((decision) => decision.action === 'reaped')).toBe(true);
      // NF3's 3-second cold start is the reason for the 2 s floor; the control
      // multiple is what keeps the assertion about the reaper under load.
      //
      // Measured idle on the author's machine, 2026-08-06: control 260 ms for
      // 20 git subprocesses, sweep 839 ms for the ~63 it runs (20 start-time
      // reads, 20 unlocks, 20 forced removes, two lists and a prune) — a ratio
      // of 3.2 against a ceiling of 6, and 2.4x inside the 2 s floor.
      expect(elapsed, `control for 20 git subprocesses was ${control.toFixed(0)} ms`).toBeLessThan(
        Math.max(2_000, control * 6),
      );
    } finally {
      s.close();
    }
  });
});

// ── EPIC-07-S31 — the PID-reuse guard ───────────────────────────────────────

suite('EPIC-07-S31: a live PID that is not our process (AC2)', () => {
  it('signals nothing, emits workspace.pid_recycled and marks the row terminal', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      const pid = await startOrphan();
      const worktree = await s.provision('n1');
      // The pid exists, but it belongs to something this row never described.
      recordProcess(s.db, row({ pid, pgid: pid, startedAt: 'Tue Jan  1 00:00:00 2019', worktree }));

      const reaped = await reapOrphans(s.db, { clock: new TestClock(NOW), epoch: EPOCH });

      expect(reaped).toEqual([expect.objectContaining({ outcome: 'pid-recycled' })]);
      // The unrelated process is untouched, which is the entire point.
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(readProcesses(s.db).map((stored) => stored.state)).toEqual(['discarded']);

      const recycled = events(s.db).find((event) => event.kind === 'workspace.pid_recycled');
      expect(recycled?.payload).toEqual({
        node: 'n1',
        pid,
        recorded: 'Tue Jan  1 00:00:00 2019',
        observed: processStartTime(pid),
      });
    } finally {
      s.close();
    }
  });

  it('still unlocks and removes the worktree the recycled row named', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const pid = await startOrphan();
      const worktree = await s.provision('n1');
      recordProcess(s.db, row({ pid, pgid: pid, startedAt: 'Tue Jan  1 00:00:00 2019', worktree }));

      await reapOrphans(s.db, { clock: new TestClock(NOW), epoch: EPOCH });
      const report = await s.sweep();

      expect(report.decisions).toEqual([
        expect.objectContaining({ path: worktree, action: 'reaped' }),
      ]);
      expect(await s.entries()).not.toContain(worktree);
      // The run is not left holding a lock for ever, and the stranger lives.
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      s.close();
    }
  });

  it('handles a pid that is gone entirely without throwing', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const worktree = await s.provision('n1');
      recordProcess(s.db, row({ worktree }));

      // "not found", not an exception — this is the boot path.
      expect(processStartTime(DEAD_PID)).toBeNull();

      const reaped = await reapOrphans(s.db, { clock: new TestClock(NOW), epoch: EPOCH });
      const report = await s.sweep();

      expect(reaped).toEqual([expect.objectContaining({ outcome: 'gone' })]);
      expect(readProcesses(s.db).map((stored) => stored.state)).toEqual(['exited']);
      expect(report.decisions).toEqual([expect.objectContaining({ action: 'reaped' })]);
      expect(await s.entries()).not.toContain(worktree);
    } finally {
      s.close();
    }
  });
});

// ── EPIC-07-S32 — prune the dead, never the living ──────────────────────────

suite('EPIC-07-S32: a directory removed behind git’s back (AC4)', () => {
  it('is prunable, and prune -v names it and drops the projection row', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      // Not DeFlow's: no lock, no process row. Prune is what deals with it.
      const stray = join(s.root, 'stray');
      await git(s.repo, ['worktree', 'add', '-b', 'stray', stray, 'main']);

      const seeded = await s.sweep();
      expect(seeded.decisions).toEqual([
        expect.objectContaining({ path: stray, action: 'not-ours' }),
      ]);
      expect(readWorktrees(s.db).map((stored) => stored.path)).toEqual([s.repo, stray].toSorted());

      await rm(stray, { recursive: true, force: true });
      expect(await s.entries()).toContain('prunable gitdir file points to non-existent location');

      // Verified finding 2: `--expire 2.weeks.ago` measures the administrative
      // entry's own age, so a fortnight has to have passed for it to go.
      const tooYoung = await s.sweep();
      expect(tooYoung.pruned).toEqual([]);
      expect(await s.entries()).toContain(stray);

      await ageAdminEntry(s.repo, 'stray', 21);
      const report = await s.sweep();

      expect(report.pruneOutput).toContain(
        'Removing worktrees/stray: gitdir file points to non-existent location',
      );
      expect(report.pruned).toEqual([
        { name: 'stray', reason: 'gitdir file points to non-existent location' },
      ]);
      expect(await s.entries()).not.toContain(stray);
      expect(readWorktrees(s.db).map((stored) => stored.path)).toEqual([s.repo]);
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S32: a locked worktree whose owner is alive survives untouched (AC5)', () => {
  it('is neither unlocked nor pruned nor removed', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const pid = await startOrphan();
      const worktree = await s.provision('n1');
      recordProcess(s.db, row({ pid, pgid: pid, startedAt: processStartTime(pid), worktree }));

      const report = await s.sweep();

      expect(report.decisions).toEqual([
        expect.objectContaining({ path: worktree, action: 'adopted', pid }),
      ]);
      // Still there, still locked, still nobody's business but the agent's.
      expect(await s.entries()).toContain(worktree);
      expect(await s.entries()).toContain(`locked ${lockReasonFor(RUN, 'n1')}`);
      expect(s.worktreeCalls().map((call) => call[1])).toEqual(['list', 'prune', 'list']);
      expect(() => process.kill(pid, 0)).not.toThrow();
      // Adoption is EPIC-06's; this sweep's whole job is to leave it alone.
      expect(events(s.db)).toEqual([]);
    } finally {
      s.close();
    }
  });

  it('leaves an operator’s own lock alone, whatever its reason says', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const mine = join(s.root, 'mine');
      await git(s.repo, ['worktree', 'add', '-b', 'mine', mine, 'main']);
      await git(s.repo, ['worktree', 'lock', '--reason', 'on holiday', mine]);

      const report = await s.sweep();

      expect(report.decisions).toEqual([
        expect.objectContaining({ path: mine, action: 'not-ours' }),
      ]);
      expect(await s.entries()).toContain('locked on holiday');
    } finally {
      s.close();
    }
  });
});

suite('EPIC-07-S32: a locked worktree whose owner is gone is fully removed (AC5)', () => {
  it('unlocks, removes with -f -f, and says so in the ledger', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const worktree = await s.provision('n1');
      recordProcess(s.db, row({ worktree }));

      const report = await s.sweep();

      expect(report.decisions).toEqual([
        expect.objectContaining({ path: worktree, runId: RUN, nodeId: 'n1', action: 'reaped' }),
      ]);
      expect(s.worktreeCalls().filter((call) => call[1] === 'remove')).toEqual([
        ['worktree', 'remove', '-f', '-f', worktree],
      ]);

      const reaped = events(s.db).find((event) => event.kind === 'workspace.orphan_reaped');
      expect(reaped?.payload).toEqual({ node: 'n1', path: worktree, pid: DEAD_PID });
      expect(await s.entries()).not.toContain(worktree);
    } finally {
      s.close();
    }
  });

  it('removes one whose directory an operator already deleted', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const worktree = await s.provision('n1');
      recordProcess(s.db, row({ worktree }));
      await rm(worktree, { recursive: true, force: true });

      const report = await s.sweep();

      // `remove -f -f` copes with a missing directory, which matters because
      // `prune --expire 2.weeks.ago` will not touch it for a fortnight.
      expect(report.decisions).toEqual([expect.objectContaining({ action: 'reaped' })]);
      expect(await s.entries()).not.toContain(worktree);
      expect(readWorktrees(s.db).map((stored) => stored.path)).toEqual([s.repo]);
    } finally {
      s.close();
    }
  });

  it('sweeps a repository it cannot read without failing the boot', async ({ tmp }) => {
    const root = await realpath(tmp);
    const notARepo = join(root, 'not-a-repo');
    await mkdir(notARepo, { recursive: true });
    const db = openLedger(root);
    try {
      const report = await reapWorktrees({
        db,
        clock: new TestClock(NOW),
        epoch: EPOCH,
        repos: [{ repoRoot: notARepo, git: new Git(notARepo, { env: GIT_ENV }) }],
      });

      expect(report.decisions).toEqual([]);
      expect(report.unreadable).toEqual([notARepo]);
    } finally {
      db.close();
    }
  });
});
