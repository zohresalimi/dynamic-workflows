/**
 * KAR-06.2 — the repo write lock survives a restart because it lives in the
 * ledger (EPIC-06-S6, AC4, AC5).
 *
 * This is the spec the architecture argues for directly: *an in-memory lock
 * evaporates on restart, and the first thing that happens after a crash is that
 * several nodes resume at once — precisely when the lock matters most.* So the
 * daemon here is a real, detached child that takes the lock and is then killed
 * with `SIGKILL`: no shutdown handler, no release, no `close()`. Everything
 * after the kill is a **fresh engine over the same file**, which is the code
 * path a restart really takes and the one an in-memory `Map` cannot survive.
 *
 * Verifies: EPIC-06-S6 (scenarios 1 and 2) · AC4, AC5
 */
import { decide, foldEvents, initialRunState } from '@DeFlow/core';
import { type Crashable, it, startCrashable } from '@DeFlow/testkit';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { drainEvents, openAndReplay } from '../../src/index.ts';
import { COMPETITOR, HOLDER, LOCK_RUN, REPO_LOCK } from './support/repo-lock-run.ts';

const HOLD_SCRIPT = fileURLToPath(new URL('./support/hold-repo-lock.ts', import.meta.url));

/** The instant every tick in this file is taken at; nothing here waits. */
const NOW = 1_754_308_400_000;

const alive: Crashable[] = [];

afterEach(async () => {
  await Promise.all(alive.splice(0).map((child) => child.sigkill()));
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs the holder until its events are committed, then `kill -9`s it and its
 * whole process group.
 */
async function crashAfterWriting(dataDir: string, mode: 'held' | 'failed'): Promise<void> {
  const readyFile = join(dataDir, `${mode}.ready`);
  const child = startCrashable({ script: HOLD_SCRIPT, args: [dataDir, readyFile, mode] });
  alive.push(child);

  const deadline = Date.now() + 20_000;
  while (!existsSync(readyFile)) {
    if (Date.now() > deadline) {
      throw new Error(`the holder never committed: ${child.stderr()}`);
    }
    await sleep(20);
  }

  await child.sigkill();
  alive.splice(alive.indexOf(child), 1);
}

suite('an unreleased lock is still held after kill -9 (AC4)', () => {
  it('reduces to the holder still owning the repo lock, and withholds the competitor', async ({
    tmp,
  }) => {
    await crashAfterWriting(tmp, 'held');

    const restarted = openAndReplay(tmp);
    try {
      const state = restarted.runs.get(LOCK_RUN);
      if (state === undefined) throw new Error('the restarted daemon did not find the run');

      // The lock is a fact of the projection, rebuilt from rows on disk.
      expect(state.locks).toEqual({
        [`repo:${REPO_LOCK}`]: {
          lock: 'repo',
          key: REPO_LOCK,
          node: HOLDER,
          sinceSeq: 4,
        },
      });

      // And it is *enforced*: the competitor is withheld on the first
      // post-restart tick, with no lock command of its own.
      const commands = decide(state, NOW);
      expect(
        commands.filter((command) => 'node' in command && command.node === COMPETITOR),
      ).toEqual([]);
    } finally {
      restarted.db.close();
    }
  });

  it('rebuilds the same answer from a cold fold, so no checkpoint is being trusted', async ({
    tmp,
  }) => {
    await crashAfterWriting(tmp, 'held');

    const restarted = openAndReplay(tmp);
    try {
      const replayed = restarted.runs.get(LOCK_RUN);
      if (replayed === undefined) throw new Error('the restarted daemon did not find the run');
      const cold = foldEvents(drainEvents(restarted.db, LOCK_RUN), initialRunState()).state;

      expect(cold.locks).toEqual(replayed.locks);
      expect(decide(cold, NOW)).toEqual(decide(replayed, NOW));
    } finally {
      restarted.db.close();
    }
  });
});

suite('a lock whose owner is gone is reclaimed, not leaked (AC5)', () => {
  it('releases it with reason "reclaimed" and admits the competitor on that tick', async ({
    tmp,
  }) => {
    await crashAfterWriting(tmp, 'failed');

    const restarted = openAndReplay(tmp);
    try {
      const state = restarted.runs.get(LOCK_RUN);
      if (state === undefined) throw new Error('the restarted daemon did not find the run');

      const commands = decide(state, NOW);

      expect(commands).toContainEqual({
        kind: 'ReleaseLock',
        runId: LOCK_RUN,
        node: HOLDER,
        lock: 'repo',
        key: REPO_LOCK,
        reason: 'reclaimed',
      });
      expect(commands).toContainEqual({
        kind: 'AcquireLock',
        runId: LOCK_RUN,
        node: COMPETITOR,
        lock: 'repo',
        key: REPO_LOCK,
      });
      expect(
        commands.filter((command) => command.kind === 'StartNode').map((command) => command.node),
      ).toEqual([COMPETITOR]);
    } finally {
      restarted.db.close();
    }
  });
});
