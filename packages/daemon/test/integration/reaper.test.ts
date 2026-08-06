/**
 * EPIC-05-S32 — orphan reaping on boot, with the PID-reuse guard.
 *
 * `detached: true` means the agent survives DeFlowd's death, and that is not
 * optional to handle: a crashed daemon leaves real agents editing a real
 * worktree with nobody supervising them. The `process` row is the only handle
 * the next daemon has on them.
 *
 * The dangerous half of this story is the *other* direction. Trusting a bare
 * pid across a restart — let alone a reboot — is how an orphan reaper sends
 * SIGKILL to an unrelated user process, which is the kind of bug that ends a
 * tool's credibility in one incident. So the reaper compares the OS's own start
 * time for the pid against the one recorded at spawn, and a mismatch is a
 * *discard*, never a kill.
 *
 * Real processes and real `git` throughout: a mocked `kill` would prove that
 * the reaper calls a function, and what is under test is that a process stops
 * existing and a worktree stops being locked.
 *
 * Verifies: EPIC-05-S32 · AC7
 */
import { processStartTime } from '@DeFlow/adapters';
import {
  appendEventsWithProcess,
  openLedger,
  type ProcessRowDraft,
  readProcesses,
  readRange,
  recordProcess,
} from '@DeFlow/ledger';
import { git, it, makeTempDir, removeTempDir, TestClock, waitFor } from '@DeFlow/testkit';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { reapOrphans } from '../../src/reaper.ts';

const RUN = 'run_20260805T090000Z_5c1d2e';
const SHA = 'a'.repeat(64);

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

const row = (over: Partial<ProcessRowDraft>): ProcessRowDraft => ({
  runId: RUN,
  nodeId: 'n1',
  attempt: 0,
  pid: 999_999,
  pgid: 999_999,
  startedAt: 'Wed Aug  5 10:15:00 2026',
  binarySha256: SHA,
  worktree: null,
  spawnedAt: 1_754_313_093_000,
  ...over,
});

const ports = () => ({ clock: new TestClock(1_754_400_000_000), epoch: 2 });

suite('a live orphan is reaped (EPIC-05-S32 scenario 1)', () => {
  it('kills the tree, marks the row terminal and records the reap as an event', async ({ tmp }) => {
    const pid = await startOrphan();
    const db = openLedger(tmp);
    try {
      recordProcess(db, row({ pid, pgid: pid, startedAt: processStartTime(pid) }));

      const reaped = await reapOrphans(db, ports());

      expect(reaped).toEqual([expect.objectContaining({ outcome: 'reaped' })]);
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

      expect(readProcesses(db).map((stored) => stored.state)).toEqual(['reaped']);
      const events = readRange(db, RUN, 0, 10).events;
      expect(events.map((event) => event.kind)).toEqual(['node.progress']);
      expect(events[0]?.payload).toMatchObject({ phase: 'process.orphan-reaped' });
      // This daemon life's epoch, not the dead one's.
      expect(events[0]?.epoch).toBe(2);
    } finally {
      db.close();
    }
  });
});

suite('the PID-reuse guard (EPIC-05-S32 scenario 2)', () => {
  it('sends no signal when the start time disagrees, and logs both', async ({ tmp }) => {
    const pid = await startOrphan();
    const db = openLedger(tmp);
    const logged: { message: string; fields: Record<string, unknown> }[] = [];
    try {
      // The pid exists, but it belongs to something this row never described.
      recordProcess(db, row({ pid, pgid: pid, startedAt: 'Tue Jan  1 00:00:00 2019' }));

      const reaped = await reapOrphans(db, {
        ...ports(),
        onDecision: (fields, message) => logged.push({ fields, message }),
      });

      expect(reaped).toEqual([expect.objectContaining({ outcome: 'pid-recycled' })]);
      // The unrelated process is untouched, which is the entire point.
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(readProcesses(db).map((stored) => stored.state)).toEqual(['discarded']);

      const discard = logged.find((entry) => entry.fields.outcome === 'pid-recycled');
      expect(discard, 'the discard has to be visible to an operator').toBeDefined();
      // Both start times, so the operator can see *why* it was discarded.
      expect(discard?.fields).toMatchObject({
        pid,
        recordedStartedAt: 'Tue Jan  1 00:00:00 2019',
        observedStartedAt: processStartTime(pid),
      });

      // No orphan was reaped, so no `node.progress` says one was — but the
      // refusal itself is a domain fact (KAR-07.8 AC2), because "an orphan the
      // operator can see running was deliberately left alone" has to be
      // answerable from the run's timeline and not only from a log nobody kept.
      const appended = readRange(db, RUN, 0, 10).events;
      expect(appended.map((event) => event.kind)).toEqual(['workspace.pid_recycled']);
      expect(appended[0]?.payload).toEqual({
        node: 'n1',
        pid,
        recorded: 'Tue Jan  1 00:00:00 2019',
        observed: processStartTime(pid),
      });
    } finally {
      db.close();
    }
  });

  it('refuses to kill a row whose start time was never recorded', async ({ tmp }) => {
    const pid = await startOrphan();
    const db = openLedger(tmp);
    try {
      recordProcess(db, row({ pid, pgid: pid, startedAt: null }));

      const reaped = await reapOrphans(db, ports());

      expect(reaped).toEqual([expect.objectContaining({ outcome: 'unverifiable' })]);
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(readProcesses(db).map((stored) => stored.state)).toEqual(['discarded']);
    } finally {
      db.close();
    }
  });
});

suite("a dead orphan's worktree lock is released (EPIC-05-S32 scenario 4)", () => {
  it('runs git worktree unlock and marks the row terminal', async () => {
    const dir = await makeTempDir();
    try {
      const repo = join(dir, 'repo');
      const worktree = join(dir, 'wt', 'n1');
      await mkdir(repo, { recursive: true });
      await git(repo, ['init', '-b', 'main']);
      await git(repo, ['commit', '--allow-empty', '-m', 'root']);
      await git(repo, ['worktree', 'add', worktree, '-b', 'node/n1']);
      await git(repo, ['worktree', 'lock', worktree]);
      expect(await git(repo, ['worktree', 'list', '--porcelain'])).toContain('locked');

      const db = openLedger(dir);
      try {
        // A pid that is certainly gone: this process's own parent chain never
        // reaches 2^22, and the row is what a crashed daemon left behind.
        recordProcess(db, row({ pid: 4_194_303, pgid: 4_194_303, worktree }));

        const reaped = await reapOrphans(db, ports());

        expect(reaped).toEqual([expect.objectContaining({ outcome: 'gone' })]);
        expect(await git(repo, ['worktree', 'list', '--porcelain'])).not.toContain('locked');
        expect(readProcesses(db).map((stored) => stored.state)).toEqual(['exited']);
      } finally {
        db.close();
      }
    } finally {
      await removeTempDir(dir);
    }
  });
});

suite('the reaper reads every non-terminal row and nothing else', () => {
  it('leaves terminal rows alone and reports one decision per live row', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEventsWithProcess(
        db,
        [
          {
            runId: RUN,
            ts: 1_754_313_093_000,
            kind: 'node.started',
            v: 1,
            epoch: 1,
            nodeId: 'n1',
            attempt: 0,
            payload: { node: 'n1', attempt: 0, ikey: `${RUN}:n1:0:0` },
          },
        ],
        row({ pid: 4_194_303, pgid: 4_194_303 }),
      );
      recordProcess(db, row({ nodeId: 'n2', pid: 4_194_302, pgid: 4_194_302 }));

      expect(await reapOrphans(db, ports())).toHaveLength(2);
      // A second boot finds nothing left to do.
      expect(await reapOrphans(db, ports())).toEqual([]);
    } finally {
      db.close();
    }
  });
});
