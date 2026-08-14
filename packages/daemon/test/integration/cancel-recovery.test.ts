/**
 * KAR-19.6 test plan #8 / EPIC-19-S43 — a crash mid-cancel finishes the cancel;
 * it does not resume the run.
 *
 * This is [05 §10.4](../../../../docs/05-durable-execution.md)'s *"never
 * in-memory flags"* asserted against the one path where breaking it is most
 * tempting, because a kill ladder is a sequence of timed signals and a timer is
 * the natural way to write one. A cancel that does not survive a restart
 * resumes a run the operator has already decided to stop — which is worse than
 * never having cancelled it, because by then they are no longer watching.
 *
 * Real processes throughout, and a real `SIGKILL` of a real child: there is no
 * way to be killed that rudely from inside a process, and the agent tree is
 * spawned **detached** so that it outlives the daemon exactly as a real agent
 * does. No fake timers — children are alive, and `vi.useFakeTimers()` would
 * stop their I/O ever arriving (docs/14-testing-strategy.md §8).
 *
 * Verifies: EPIC-19-S43 · KAR-19.6 AC8
 */
import type { Db } from '@DeFlow/core';
import { decide, initialRunState } from '@DeFlow/core';
import { openLedger, replayRun } from '@DeFlow/ledger';
import { type Crashable, it, sleep, startCrashable, TestClock, waitFor } from '@DeFlow/testkit';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { KILL_VERIFY_MS, TERM_GRACE_MS } from '../../src/cancel.ts';
import { createRunDriver } from '../../src/drive.ts';
import { CANCEL_RUN, T0 } from './support/cancel-run.ts';
import { groupRows, killGroup, liveRows } from './support/ps.ts';

const HANG_SCRIPT = fileURLToPath(new URL('./support/hang-mid-cancel.ts', import.meta.url));

const alive: Crashable[] = [];
const groups: number[] = [];

afterEach(async () => {
  await Promise.all(alive.splice(0).map((child) => child.sigkill()));
  for (const pgid of groups.splice(0)) killGroup(pgid);
  await sleep(50);
});

/** The daemon of the incident: it took the request and died holding it. */
async function crashMidCancel(tmp: string, mode: 'cooperative' | 'forceful'): Promise<number> {
  const readyFile = join(tmp, 'ready.json');
  const child = startCrashable({ script: HANG_SCRIPT, args: [tmp, readyFile, mode] });
  alive.push(child);

  await waitFor(() => existsSync(readyFile), {
    describe: 'the daemon to record the cancel request',
    timeoutMs: 20_000,
  });
  const { pgid } = JSON.parse(readFileSync(readyFile, 'utf8')) as { pgid: number };
  groups.push(pgid);

  await child.sigkill();
  alive.splice(alive.indexOf(child), 1);
  return pgid;
}

/** A second daemon life over the same data directory: its own clock, its own
 * driver, and nothing carried over but the file. */
function reboot(db: Db) {
  const clock = new TestClock(T0 + 60_000);
  return {
    clock,
    driver: createRunDriver({ db, clock, epoch: 2, startedAt: clock.now() }),
  };
}

const kindsOf = (db: Db, runId = CANCEL_RUN): string[] =>
  db
    .prepare<{ kind: string }>('SELECT kind FROM event WHERE run_id = ? ORDER BY seq')
    .all(runId)
    .map((row) => row.kind);

const countOf = (db: Db, kind: string): number => kindsOf(db).filter((one) => one === kind).length;

const statusOf = (db: Db): string => (replayRun(db, CANCEL_RUN).state ?? initialRunState()).status;

suite('EPIC-19-S43 — the daemon dies between the request and the ladder (AC8)', () => {
  it('comes back cancelling rather than running, and starts nothing', async ({ tmp }) => {
    await crashMidCancel(tmp, 'forceful');

    const db = openLedger(tmp);
    try {
      expect(db.prepare<{ integrity_check: string }>('PRAGMA integrity_check').get()).toEqual({
        integrity_check: 'ok',
      });
      expect(statusOf(db)).toBe('cancelling');

      // The guarantee lives in `decide()` and is asserted where it lives: a
      // cancelling run admits nothing, so there is no tick on which the new
      // daemon could restart the node the operator stopped.
      const commands = decide(replayRun(db, CANCEL_RUN).state, T0 + 60_000);
      expect(commands.filter((command) => command.kind === 'StartNode')).toEqual([]);
      expect(commands.some((command) => command.kind === 'CancelNode')).toBe(true);
    } finally {
      db.close();
    }
  });

  it('finishes the ladder and appends run.aborted exactly once, with no second command', async ({
    tmp,
  }) => {
    const pgid = await crashMidCancel(tmp, 'forceful');
    expect(liveRows(pgid).length).toBeGreaterThan(0);

    const db = openLedger(tmp);
    try {
      const { clock, driver } = reboot(db);

      // One tick of the ordinary loop. The operator is not here.
      const ticking = driver.tick(T0 + 60_000);

      // The tree goes on the group SIGTERM; the ladder's graces are on the
      // injected clock, so they cost microseconds while real children are
      // alive (no fake timers — their I/O still has to arrive).
      await waitFor(() => liveRows(pgid).length === 0, {
        describe: `the agent group ${pgid} to be empty of non-Z processes`,
        timeoutMs: 10_000,
      });
      await clock.advance(TERM_GRACE_MS + KILL_VERIFY_MS);
      await ticking;

      // The unfiltered view is not empty at the same instant, so the `Z`
      // exclusion cannot pass vacuously (09 §11.1).
      expect(liveRows(pgid)).toEqual([]);
      expect(groupRows(pgid).every((row) => row.stat.includes('Z'))).toBe(true);

      expect(statusOf(db)).toBe('aborted');
      expect(countOf(db, 'run.aborted')).toBe(1);

      // And it stays once: every later tick reads a run that has ended.
      await driver.tick(T0 + 61_000);
      await driver.tick(T0 + 62_000);
      expect(countOf(db, 'run.aborted')).toBe(1);
    } finally {
      db.close();
    }
  });

  it('leaves a cooperative cancel cancelling, and signals nothing on its own', async ({ tmp }) => {
    const pgid = await crashMidCancel(tmp, 'cooperative');

    const db = openLedger(tmp);
    try {
      const { driver } = reboot(db);
      await driver.tick(T0 + 60_000);
      await driver.tick(T0 + 61_000);

      // The agent was asked politely and has not answered. Promoting that to a
      // SIGTERM would make `--force` decorative and would truncate the
      // transcript the operator cancelled the run in order to read.
      expect(liveRows(pgid).length).toBeGreaterThan(0);
      expect(statusOf(db)).toBe('cancelling');
      expect(countOf(db, 'run.aborted')).toBe(0);
    } finally {
      db.close();
    }
  });
});
