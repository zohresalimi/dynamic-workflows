/**
 * KAR-03.8 — `kill -9` mid-append, reopen, integrity intact (EPIC-03-S24, and
 * scenario 1 of EPIC-03-S25).
 *
 * This is the measurement the whole durability design rests on. `SIGKILL` and
 * not `SIGTERM` is the entire point: SIGTERM tests the shutdown handler, and
 * the shutdown handler is exactly what a crashed laptop does not run. The child
 * next door in `support/append-loop.ts` has no handler, no flush and no
 * `close()` — the signal lands in the middle of a write loop and the file on
 * disk is all that survives.
 *
 * **Verified 2026-08-02**, and re-measured by this file on every run: SIGKILL
 * at ~45k committed rows, then reopen — every committed row present, `PRAGMA
 * integrity_check` = `ok`, and the `-wal` recovered on open with no manual
 * checkpoint.
 *
 * The reopen is a **fresh engine over the same file**, never the handle the
 * test already had: that is the code path a daemon restart really takes, and
 * an in-memory database cannot express it at all — it cannot be reopened, so
 * it cannot test the one property that matters most
 * (docs/14-testing-strategy.md §7).
 *
 * Verifies: EPIC-03-S24, EPIC-03-S25 (scenario 1) · AC2
 */
import { foldEvents, initialRunState, type RunId, RunIdSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { type ChildProcess, fork } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { drainEvents, openAndReplay } from '../../src/index.ts';

const APPEND_LOOP = fileURLToPath(new URL('./support/append-loop.ts', import.meta.url));

/** The run `append-loop.ts` writes. */
const RUN: RunId = RunIdSchema.parse('run_20260805T090000Z_5c1d2e');

/**
 * The reference measurement's order of magnitude. 45,339 rows is what the
 * architecture recorded surviving a SIGKILL on 2026-08-02; this asks the child
 * for at least 45,000 before the knife lands so the number under test is the
 * same size as the one that was published.
 */
const ROWS_BEFORE_KILL = 45_000;

/**
 * Rows per transaction, and therefore the granularity a torn write would show
 * up at: a surviving row count that is not a multiple of this would mean half
 * a transaction reached the file.
 */
const BATCH = 500;

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The committed row count the child last reported, or 0 before its first batch. */
function reported(progressFile: string): number {
  if (!existsSync(progressFile)) return 0;
  const text = readFileSync(progressFile, 'utf8');
  const value = Number.parseInt(text, 10);
  return Number.isNaN(value) ? 0 : value;
}

interface Crashed {
  /** The rows the child had *committed and reported* when it was killed. */
  readonly committed: number;
  /** True when a `-wal` was still sitting beside the database, unrecovered. */
  readonly walSurvived: boolean;
}

/**
 * Starts the append loop, waits for it to commit `ROWS_BEFORE_KILL`, and
 * SIGKILLs it. Real signal, real process, real file.
 */
async function appendUntilKilled(tmp: string): Promise<Crashed> {
  const progressFile = join(tmp, 'committed.txt');
  const child = fork(APPEND_LOOP, [tmp, progressFile, String(BATCH)], {
    execArgv: [],
    stdio: 'pipe',
  });
  children.push(child);

  const deadline = Date.now() + 20_000;
  let committed = 0;
  while (committed < ROWS_BEFORE_KILL) {
    if (child.exitCode !== null) throw new Error(`the append loop exited early: ${child.exitCode}`);
    if (Date.now() > deadline) {
      throw new Error(`the append loop only reached ${committed} rows in 20 s`);
    }
    await sleep(10);
    committed = reported(progressFile);
  }

  const exited = new Promise<NodeJS.Signals | null>((resolve) => {
    child.once('exit', (_code, signal) => resolve(signal));
  });
  // No handler, no flush, no cleanup. The file is on its own from here.
  child.kill('SIGKILL');
  expect(await exited).toBe('SIGKILL');

  return { committed, walSurvived: existsSync(join(tmp, 'ledger.db-wal')) };
}

suite('SIGKILL during a write loop loses nothing committed (AC2)', () => {
  it('reopens with every committed row present and integrity_check ok', async ({ tmp }) => {
    const crashed = await appendUntilKilled(tmp);
    expect(crashed.committed).toBeGreaterThanOrEqual(ROWS_BEFORE_KILL);
    // The WAL is still there, holding committed frames the main database file
    // has not been given yet. Recovering it is the reopen's job, and nothing
    // below runs a manual checkpoint.
    expect(crashed.walSurvived).toBe(true);

    // A FRESH engine over the SAME FILE — the code path a restart takes.
    const opened = openAndReplay(tmp);
    try {
      const rows = opened.db
        .prepare<{ rows: number; head: number }>(
          'SELECT count(*) AS rows, coalesce(max(seq), 0) AS head FROM event',
        )
        .get() ?? { rows: 0, head: 0 };

      expect(rows.rows).toBeGreaterThanOrEqual(crashed.committed);
      // Nothing was lost *and* nothing was invented: with no deletes and no
      // rolled-back batch, a contiguous sequence is the only shape a whole
      // number of committed transactions can leave behind.
      expect(rows.rows).toBe(rows.head);
      // And the knife never landed inside a transaction: a count that is not a
      // multiple of the batch size would be half a batch on disk.
      expect(rows.rows % BATCH).toBe(0);
      expect(opened.db.pragma('integrity_check')).toBe('ok');
    } finally {
      opened.db.close();
    }
  });

  it('replays the survivors into the state a cold fold of the same file gives', async ({ tmp }) => {
    await appendUntilKilled(tmp);

    const opened = openAndReplay(tmp);
    try {
      const cold = foldEvents(drainEvents(opened.db, RUN), initialRunState()).state;
      expect(opened.runs.get(RUN)).toEqual(cold);
    } finally {
      opened.db.close();
    }
  });

  it('leaves the surviving checkpoint no further ahead than the ledger (scenario 3)', async ({
    tmp,
  }) => {
    await appendUntilKilled(tmp);

    const opened = openAndReplay(tmp);
    try {
      const row = opened.db
        .prepare<{ last_seq: number; head: number }>(
          'SELECT run.last_seq AS last_seq, (SELECT max(seq) FROM event) AS head FROM run',
        )
        .get();
      expect(row).toBeDefined();
      expect(row?.last_seq).toBeLessThanOrEqual(row?.head ?? 0);
    } finally {
      opened.db.close();
    }
  });
});
