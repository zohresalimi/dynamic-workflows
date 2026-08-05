/**
 * EPIC-05-S30 and EPIC-05-S31 — the process group, measured.
 *
 * Every claim in this file was produced by running the code, not by reading a
 * manual page, and each one is the regression test for a change that would look
 * like a simplification in review:
 *
 * - Dropping `detached: true` puts the grandchildren in **DeFlowd's own process
 *   group**, where `child.kill()` reaches only the direct child and a group kill
 *   would take DeFlowd with it.
 * - Replacing `kill(-pid)` with `kill(pid)` leaves every grandchild running,
 *   reparented to init, still holding the worktree open.
 * - Verifying a kill without filtering `Z` reports failure after a kill that
 *   worked perfectly.
 *
 * The third is the expensive one. `test('the filter is load-bearing')` asserts
 * the **unfiltered** count is non-zero at the same instant the filtered count is
 * zero, so the filter cannot pass vacuously — measured 8/8 runs on darwin
 * 2026-08-05, where the group leader is the row left in `Z`.
 *
 * No fake timers: real children are alive throughout, and `vi.useFakeTimers()`
 * would stop their I/O ever arriving (docs/14-testing-strategy.md §8).
 *
 * Verifies: EPIC-05-S30, EPIC-05-S31 (scenarios 2, 3) · AC1, AC2, AC4 · test
 * plan #1, #2, #3
 */
import { sleep, waitFor } from '@DeFlow/testkit';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import process from 'node:process';
import { afterEach, expect, it, describe as suite } from 'vitest';
import { groupRows, killGroup, liveRows, ownPgid, rowOf } from './support/ps.ts';

/** A shell that backgrounds two children and keeps a third in the foreground:
 * four processes, one of which DeFlowd knows about. */
const BACKGROUNDS_TWO = ['-c', 'sleep 300 & sleep 300 & sleep 300; wait'];

const started: ChildProcessWithoutNullStreams[] = [];
const strays: number[] = [];

afterEach(async () => {
  for (const child of started.splice(0)) {
    if (child.pid !== undefined) killGroup(child.pid);
  }
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  await sleep(50);
});

async function startTree(detached: boolean): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn('/bin/sh', BACKGROUNDS_TWO, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached,
  });
  started.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const pid = child.pid as number;
  // Four processes: the shell and its three sleeps.
  await waitFor(
    () =>
      (detached ? groupRows(pid) : groupRows(ownPgid()).filter((row) => row.ppid === pid)).length >=
      (detached ? 4 : 3),
    { describe: 'the shell to have backgrounded its children' },
  );
  return child;
}

suite('all descendants share the child pid as their pgid (AC2, test plan #1)', () => {
  it('puts every process in the tree in a group led by the child', async () => {
    const child = await startTree(true);
    const pid = child.pid as number;

    const rows = liveRows(pid);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.pgid).toBe(pid);
    // And the group is not DeFlowd's, which is what makes signalling it safe.
    expect(pid).not.toBe(ownPgid());

    // One signal reaches all of them.
    process.kill(-pid, 'SIGTERM');
    await waitFor(() => liveRows(pid).length === 0, {
      describe: 'the whole group to go on one SIGTERM',
    });
  });
});

suite('the non-detached case is actively dangerous (EPIC-05-S30 scenario 2)', () => {
  it("leaves the grandchildren in DeFlowd's own group, where child.kill reaches only the shell", async () => {
    const child = await startTree(false);
    const pid = child.pid as number;
    const mine = ownPgid();

    const descendants = groupRows(mine).filter((row) => row.ppid === pid);
    expect(descendants).toHaveLength(3);
    // The measured, dangerous result: their group is the daemon's own, so there
    // is no group to signal — signalling it would kill DeFlowd.
    for (const row of descendants) expect(row.pgid).toBe(mine);
    for (const row of descendants) strays.push(row.pid);

    child.kill('SIGTERM');
    await waitFor(() => rowOf(pid) === undefined || rowOf(pid)?.stat.includes('Z') === true, {
      describe: 'the direct child to die',
    });

    // Both grandchildren are still running, in state S, reparented to init.
    for (const row of descendants) {
      const now = rowOf(row.pid);
      expect(now, `grandchild ${row.pid} should have survived child.kill('SIGTERM')`).toBeDefined();
      expect(now?.stat).toContain('S');
      expect(now?.ppid).toBe(1);
    }
  });
});

suite('the zombie false negative (EPIC-05-S31 scenario 2, AC4)', () => {
  it('reports zero survivors only once Z-state rows are filtered out', async () => {
    const child = await startTree(true);
    const pid = child.pid as number;

    expect(liveRows(pid)).toHaveLength(4);

    process.kill(-pid, 'SIGKILL');
    // Read the table immediately, synchronously: this is the instant the naive
    // assertion looks at, and the one it gets wrong.
    const unfiltered = groupRows(pid);
    const live = unfiltered.filter((row) => !row.stat.includes('Z'));

    expect(live).toEqual([]);
    // The filter is doing real work rather than passing vacuously: `ps` is
    // still listing members of a group that is entirely dead.
    expect(
      unfiltered.length,
      'no Z-state row survived the kill, so this run proves nothing about the filter',
    ).toBeGreaterThan(0);
    for (const row of unfiltered) expect(row.stat).toContain('Z');
  });
});

suite('a positive-pid kill is not equivalent (EPIC-05-S31 scenario 3, test plan #3)', () => {
  it('kills the shell and leaves both grandchildren running with ppid 1', async () => {
    const child = await startTree(true);
    const pid = child.pid as number;
    const descendants = liveRows(pid).filter((row) => row.pid !== pid);
    expect(descendants).toHaveLength(3);

    // A POSITIVE pid. One character from the correct call, and the entire
    // difference between a kill switch and a leak.
    process.kill(pid, 'SIGKILL');
    await waitFor(() => liveRows(pid).every((row) => row.pid !== pid), {
      describe: 'the direct child to die',
    });

    for (const row of descendants) {
      const now = rowOf(row.pid);
      expect(now, `grandchild ${row.pid} should have survived a positive-pid kill`).toBeDefined();
      expect(now?.stat).toContain('S');
      expect(now?.ppid).toBe(1);
      // Still in the dead shell's group: the pgid is the only handle left, and
      // the reason the `process` row records it.
      expect(now?.pgid).toBe(pid);
    }
  });
});
