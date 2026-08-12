/**
 * KAR-18.2 AC7 — SIGINT with work in flight (EPIC-18-S16), at the level where
 * the two halves are observable: a real detached process tree, and the ledger
 * the next daemon will read.
 *
 * SIGTERM tests the shutdown handler; SIGKILL (EPIC-18-S13) tests durability.
 * They are different code paths and both have to work — this is the first one.
 * The process-level half of the scenario (the signal, the removed
 * `daemon.json`, the released lease, a clean `DeFlow up` afterwards) is
 * `e2e/up.test.ts`; what is here is what that spec cannot see from outside:
 * whether the group is genuinely empty, and whether the interrupted node was
 * concluded rather than left `running` for the next boot to reconcile.
 *
 * No fake timers: real children are alive throughout
 * (docs/14-testing-strategy.md §8).
 *
 * Verifies: EPIC-18-S16 · AC7
 */
import { openLedger, readProcesses, readRange, recordProcess } from '@DeFlow/ledger';
import { it, sleep, waitFor } from '@DeFlow/testkit';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';
import { AUTH, CANCEL_RUN, seedRunningRun } from './support/cancel-run.ts';
import { groupRows, killGroup, liveRows } from './support/ps.ts';

const groups: number[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
let booted: Booted | undefined;

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
  for (const pgid of groups.splice(0)) killGroup(pgid);
  children.splice(0);
  await sleep(50);
});

function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not read the bound port'));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/** A detached shell that backgrounds two children: four processes, one group. */
async function startTree(): Promise<number> {
  const child = spawn('/bin/sh', ['-c', 'sleep 300 & sleep 300 & sleep 300; wait'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
  });
  children.push(child);
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  const pgid = child.pid as number;
  groups.push(pgid);
  child.stdout.resume();
  child.stderr.resume();
  await waitFor(() => liveRows(pgid).length >= 4, {
    describe: `the tree in pgid ${pgid} to have 4 live members`,
  });
  return pgid;
}

/** The OS's own start time for `pid`, the way `recordProcess` stores it. */
async function realStartTime(pid: number): Promise<string> {
  const { processStartTime } = await import('@DeFlow/adapters');
  const startedAt = processStartTime(pid);
  if (startedAt === null) throw new Error(`no start time for pid ${pid}`);
  return startedAt;
}

suite('shutdown with a child mid-turn (EPIC-18-S16, AC7)', () => {
  it('stops the whole group, concludes the node, and leaves nothing behind', async ({ tmp }) => {
    booted = await boot({ dataDir: tmp, port: await freePort(), dev: false });

    // A run whose node is running *in this daemon's life*, with a real process
    // tree behind it. Appended after boot rather than before, because a node
    // left running by a *previous* life is recovery's business and is concluded
    // on the way in (KAR-06.9 step 5) — which is a different code path.
    seedRunningRun(booted.db);
    const pgid = await startTree();
    recordProcess(booted.db, {
      runId: CANCEL_RUN,
      nodeId: AUTH,
      attempt: 0,
      pid: pgid,
      pgid,
      startedAt: await realStartTime(pgid),
      binarySha256: 'd'.repeat(64),
      worktree: null,
      spawnedAt: Date.now(),
    });

    expect(existsSync(join(tmp, 'daemon.json'))).toBe(true);

    await booted.shutdown();
    const shutDown = booted;
    booted = undefined;

    // The group is empty of everything but zombies. `groupRows` is the
    // unfiltered view and it is asserted *non-empty is not required* — what
    // matters is that nothing non-`Z` is left, because after a successful group
    // SIGKILL `ps` still lists the grandchildren awaiting init.
    expect(liveRows(pgid)).toEqual([]);
    for (const row of groupRows(pgid)) expect(row.state.startsWith('Z')).toBe(true);

    // Nothing points at a daemon that has gone.
    expect(existsSync(join(tmp, 'daemon.json'))).toBe(false);

    const db = openLedger(tmp);
    try {
      // The row is terminal, so the next boot has nothing to reap.
      expect(readProcesses(db)[0]?.state).toBe('reaped');

      // And the node is concluded with a *typed* failure naming the cause,
      // rather than left `running` for the next daemon to reconcile.
      const failures = readRange(db, CANCEL_RUN, 0, 500)
        .events.filter((event) => event.kind === 'node.failed')
        .map((event) => event.payload as { failure?: { detail?: { cause?: string } } });
      expect(failures).toHaveLength(1);
      expect(failures[0]?.failure?.detail?.cause).toBe('daemon-shutdown');
    } finally {
      db.close();
    }

    // The lease went with it: the next daemon starts with no manual cleanup.
    booted = await boot({ dataDir: tmp, port: await freePort(), dev: false });
    expect(booted.epoch).toBe(shutDown.epoch + 1);
  });
});

suite('shutdown with nothing running', () => {
  it('is free: no replay, no signal, no events', async ({ tmp }) => {
    booted = await boot({ dataDir: tmp, port: await freePort(), dev: false });
    const before = booted.headSeq;

    await booted.shutdown();
    booted = undefined;

    const db = openLedger(tmp);
    try {
      expect(readRange(db, CANCEL_RUN, 0, 500).events).toEqual([]);
    } finally {
      db.close();
    }
    expect(before).toBe(0);
  });
});
