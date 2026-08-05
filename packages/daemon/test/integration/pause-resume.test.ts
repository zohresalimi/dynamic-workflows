/**
 * EPIC-06-S23 — pause is an event, so it survives a restart (KAR-06.7).
 *
 * The claim is not "a paused run does not start anything" — a boolean satisfies
 * that. It is that **nothing in memory is consulted at all**: the pause is
 * written by one process, that process is SIGKILLed, and a second process over
 * the same bytes reaches the same conclusion by folding the log. So this file
 * is integration rather than unit, and the crash is a real `kill -9` of a real
 * child rather than a `db.close()` — SIGTERM would test a shutdown handler, and
 * durability is what is under test (docs/14-testing-strategy.md §8).
 *
 * The lock held *across* the pause is the other half. A pause that let the
 * scheduler reclaim the repository write lock from a node that is still running
 * would corrupt the resume: two writers in one checkout, which is the failure
 * F5.2 exists to prevent.
 *
 * Verifies: EPIC-06-S23 · AC1, AC2, AC3, AC4
 */
import { appendEvents, openLedger } from '@DeFlow/ledger';
import { type Crashable, it, startCrashable, waitFor } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import {
  AUTH,
  CANCEL_RUN,
  completeAuth,
  makeLoop,
  pause,
  REPO_LOCK,
  ROUTER,
  resume,
  seedRunningRun,
  T0,
} from './support/cancel-run.ts';

const PAUSE_SCRIPT = fileURLToPath(new URL('./support/pause-then-hang.ts', import.meta.url));

const alive: Crashable[] = [];

afterEach(async () => {
  await Promise.all(alive.splice(0).map((child) => child.sigkill()));
});

suite('EPIC-06-S23 scenario 1 — pausing stops admission but not in-flight work', () => {
  it('admits nothing, cancels nothing, and still accepts the completion (AC1, AC2)', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const loop = makeLoop(db);

      // Before the pause: `impl-router` is genuinely ready and merely withheld
      // by the lock, so "nothing started" below is a claim about the pause.
      loop.tick(T0);
      expect(loop.state().status).toBe('running');

      appendEvents(db, [pause()]);
      const commands = loop.tick(T0 + 1_000);

      expect(loop.state().status).toBe('paused');
      expect(commands.filter((command) => command.kind === 'StartNode')).toEqual([]);
      // The in-flight node is left alone: pause is not cancel.
      expect(commands.filter((command) => command.kind === 'CancelNode')).toEqual([]);
      expect(loop.state().nodes[AUTH]?.status).toBe('running');
      // And it keeps the lock it is using.
      expect(loop.state().locks[`repo:${REPO_LOCK}`]).toMatchObject({ node: AUTH });

      // Its completion is accepted normally while the run is paused, and the
      // lock comes back — a pause that stranded the repo lock would block the
      // next run as well as this one.
      appendEvents(db, [...completeAuth()]);
      loop.tick(T0 + 2_000);

      expect(loop.state().nodes[AUTH]?.status).toBe('completed');
      expect(loop.state().locks).toEqual({});
      // Still paused, so the freed lock admits nobody.
      expect(loop.started()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('EPIC-06-S23 scenario 2 — pause survives kill -9', () => {
  it('comes back paused, and 100 ticks produce no StartNode (AC3)', async ({ tmp }) => {
    const readyFile = join(tmp, 'paused.json');
    const child = startCrashable({ script: PAUSE_SCRIPT, args: [tmp, readyFile] });
    alive.push(child);

    await waitFor(
      () => {
        try {
          return (
            (JSON.parse(readFileSync(readyFile, 'utf8')) as { after: string }).after === 'paused'
          );
        } catch {
          return false;
        }
      },
      { describe: 'the child to pause the run', timeoutMs: 20_000 },
    );

    // It really was running when it paused it, so what follows is not a run
    // that never started.
    expect(JSON.parse(readFileSync(readyFile, 'utf8'))).toEqual({
      before: 'running',
      after: 'paused',
      started: [],
    });

    await child.sigkill();
    alive.splice(alive.indexOf(child), 1);

    const restarted = openLedger(tmp);
    try {
      const loop = makeLoop(restarted);

      // Nothing carried over but the file. The status is folded, not restored.
      expect(loop.state().status).toBe('paused');

      for (let count = 0; count < 100; count += 1) loop.tick(T0 + count * 1_000);
      expect(loop.started()).toEqual([]);

      // And the resume is what re-admits — proving the 100 ticks above were a
      // loop that would otherwise have started something.
      appendEvents(restarted, [resume(), ...completeAuth()]);
      loop.tick(T0 + 100_000);

      expect(loop.started()).toEqual([ROUTER]);
    } finally {
      restarted.close();
    }
  });
});

suite('EPIC-06-S23 scenario 3 — resume re-admits under the same semaphores', () => {
  it('withholds the competitor while the repo lock is still held, then admits it (AC4)', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      const loop = makeLoop(db);
      loop.tick(T0);

      appendEvents(db, [pause()]);
      loop.tick(T0 + 1_000);

      // The pause is lifted while `impl-auth` is still running and still
      // holding the repository lock.
      appendEvents(db, [resume()]);
      loop.tick(T0 + 2_000);

      expect(loop.state().status).toBe('running');
      expect(loop.state().locks[`repo:${REPO_LOCK}`]).toMatchObject({ node: AUTH });
      // Re-admitted, but under the same bound: the lock is taken, so nothing
      // starts. A resume that handed `impl-router` a held lock would be two
      // agents in one checkout.
      expect(loop.started()).toEqual([]);

      appendEvents(db, [...completeAuth()]);
      loop.tick(T0 + 3_000);

      expect(loop.started()).toEqual([ROUTER]);
      expect(loop.state().locks[`repo:${REPO_LOCK}`]).toMatchObject({ node: ROUTER });
    } finally {
      db.close();
    }
  });

  it('the pause and the resume are both in the timeline, with their ts and by', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      seedRunningRun(db);
      appendEvents(db, [pause('policy')]);
      appendEvents(db, [resume()]);

      const rows = db
        .prepare<{ kind: string; ts: number; payload: string }>(
          `SELECT kind, ts, payload FROM event WHERE run_id = ? AND kind IN ('run.paused','run.resumed') ORDER BY seq`,
        )
        .all(CANCEL_RUN);

      expect(rows.map((row) => row.kind)).toEqual(['run.paused', 'run.resumed']);
      for (const row of rows) {
        expect(row.ts).toBe(T0);
        expect(JSON.parse(row.payload)).toMatchObject({ by: expect.any(String) });
      }
    } finally {
      db.close();
    }
  });
});
