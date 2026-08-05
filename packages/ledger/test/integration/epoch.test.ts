/**
 * KAR-03.7 — `daemon_epoch` bookkeeping: read, incremented and persisted
 * atomically at boot, and stamped on every row the ledger writes.
 *
 * File-backed and reopened, never `:memory:`: the claim is that the counter
 * survives the process that bumped it, and an in-memory database cannot be
 * reopened at all.
 *
 * Verifies: EPIC-03-S23 (scenarios 1 and 2), EPIC-03-S22 (scenarios 1 and 2)
 * · AC4, AC5
 */
import { RunIdSchema } from '@DeFlow/core';
import { it } from '@DeFlow/testkit';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import {
  appendEvents,
  bumpEpoch,
  openLedger,
  readEpoch,
  readRange,
  StaleEpoch,
} from '../../src/index.ts';
import { draft, drafts, RUN_A } from './support/events.ts';

const BUMPER = fileURLToPath(new URL('./support/bump-epoch.ts', import.meta.url));

/** One daemon life: open the ledger, bump the epoch, do something, close. */
function life<T>(
  dataDir: string,
  body: (epoch: number, db: ReturnType<typeof openLedger>) => T,
): T {
  const db = openLedger(dataDir);
  try {
    return body(bumpEpoch(db), db);
  } finally {
    db.close();
  }
}

suite('the epoch is monotonic across boots (EPIC-03-S23 scenario 1, AC4)', () => {
  it('reads 1, then 2, then 3 over a fresh data directory', async ({ tmp }) => {
    expect([
      life(tmp, (epoch) => epoch),
      life(tmp, (epoch) => epoch),
      life(tmp, (epoch) => epoch),
    ]).toEqual([1, 2, 3]);
  });

  it('persists it, so a later process reads what the last one wrote', async ({ tmp }) => {
    life(tmp, (epoch) => epoch);
    life(tmp, (epoch) => epoch);

    const db = openLedger(tmp);
    try {
      expect(readEpoch(db)).toBe(2);
    } finally {
      db.close();
    }
  });

  it('starts at 0 on a ledger no daemon has booted against', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(readEpoch(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('never hands the same epoch to two racing daemons', async ({ tmp }) => {
    // Read-then-write would pass every sequential test above and still hand
    // two daemon lives the same number here, which silently defeats the
    // fencing in EPIC-03-S22. Five real processes, all bumping at once.
    openLedger(tmp).close(); // migrate first; the children only bump

    const bumped = await Promise.all(
      Array.from(
        { length: 5 },
        () =>
          new Promise<number>((resolve, reject) => {
            const child = fork(BUMPER, [tmp], { execArgv: [], stdio: 'pipe' });
            child.once('message', (message) => resolve((message as { epoch: number }).epoch));
            child.once('error', reject);
            child.once('exit', (code) => {
              if (code !== 0) reject(new Error(`the bumper exited with code ${code}`));
            });
          }),
      ),
    );

    expect([...bumped].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });
});

suite('every appended event carries the epoch (EPIC-03-S23 scenario 2, AC4)', () => {
  it('stamps 500 events across two daemon lives, none of them null', async ({ tmp }) => {
    life(tmp, (epoch, db) => {
      appendEvents(
        db,
        drafts(250).map((one) => ({ ...one, epoch })),
      );
    });
    life(tmp, (epoch, db) => {
      appendEvents(
        db,
        drafts(250).map((one) => ({ ...one, epoch })),
      );
    });

    const db = openLedger(tmp);
    try {
      const { events } = readRange(db, RUN_A, 0, 1_000);
      expect(events).toHaveLength(500);
      expect(events.every((event) => typeof event.epoch === 'number')).toBe(true);
      // Cleanly partitioned into the two lives, in order: no interleaving,
      // no row left holding the column default.
      expect(events.filter((event) => event.epoch === 1)).toHaveLength(250);
      expect(events.filter((event) => event.epoch === 2)).toHaveLength(250);
      expect(events.slice(0, 250).every((event) => event.epoch === 1)).toBe(true);
    } finally {
      db.close();
    }
  });
});

suite('a stale-epoch append is refused at the boundary (EPIC-03-S22 scenario 1, AC5)', () => {
  it('throws StaleEpoch naming both epochs and writes nothing', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      bumpEpoch(db); // 1
      bumpEpoch(db); // 2
      appendEvents(db, [draft({ epoch: 2 })]);

      let thrown: unknown;
      try {
        appendEvents(db, [draft({ epoch: 2 }), draft({ epoch: 1 }), draft({ epoch: 2 })]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(StaleEpoch);
      const error = thrown as StaleEpoch;
      expect(error.epoch).toBe(1);
      expect(error.currentEpoch).toBe(2);
      expect(error.index).toBe(1);
      expect(error.message).toContain('1');
      expect(error.message).toContain('2');

      // The batch is atomic and the valid rows beside the stale one are gone
      // with it: one row in the ledger, the one appended before the attempt.
      expect(readRange(db, RUN_A, 0, 100).events).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it('accepts the current epoch (EPIC-03-S22 scenario 2)', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const epoch = bumpEpoch(db);
      const [seq] = appendEvents(db, [draft({ epoch })]);
      expect(seq).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it('refuses a stale epoch for every run, not just the one being fenced', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      bumpEpoch(db);
      bumpEpoch(db);
      const other = RunIdSchema.parse('run_20260802T141135Z_11ab22');
      expect(() => appendEvents(db, [draft({ runId: other, epoch: 1 })])).toThrow(StaleEpoch);
    } finally {
      db.close();
    }
  });
});
