/**
 * KAR-03.3 — sequence gaps are legal, and the cursor contract is **strictly
 * greater than** (EPIC-03-S9).
 *
 * **Verified 2026-08-05, and it corrects the architecture doc.**
 * docs/05-durable-execution.md §6 said "a rolled-back transaction burns
 * `AUTOINCREMENT` values". It does not: `sqlite_sequence` is an ordinary table,
 * its high-water update is part of the transaction, and `ROLLBACK` — full or to
 * a `SAVEPOINT` — restores it. Probed on better-sqlite3@13.0.2 / SQLite 3.53.4
 * under this package's own pragmas: append 100, roll back a batch of 3, append
 * again, and the next event is 101.
 *
 * The contract the doc drew from it is nevertheless right, and this file is
 * where the real reasons are pinned:
 *
 * 1. **Pruning.** `AUTOINCREMENT` refuses to reissue a deleted number (§6,
 *    EPIC-03-S8), so deleting the row that held 3 leaves a permanent hole in
 *    what any reader observes.
 * 2. **One global `event` table.** A run's cursor walks a strided subsequence
 *    of a sequence shared with every other run, so `cursor + 1` is wrong from
 *    the second concurrent run onward, before anything is deleted at all.
 *
 * So: **resume from strictly greater than your cursor, never from `cursor + 1`.**
 *
 * Verifies: EPIC-03-S9 · AC3
 */

import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { appendEvents, openLedger, readRange } from '../../src/index.ts';
import { draft, drafts, RUN_A, RUN_B } from './support/events.ts';

const highWater = (db: ReturnType<typeof openLedger>): number | undefined =>
  db.prepare<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'event'").get()?.seq;

suite('a rolled-back batch leaves no rows (EPIC-03-S9 scenario 1)', () => {
  it('writes none of them, and SQLite restores the high-water mark with them', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, drafts(100));
      expect(highWater(db)).toBe(100);

      const abort = new Error('the effect this batch described failed');
      expect(() =>
        db.transaction(() => {
          // The seqs handed back here are meaningless: a seq exists only once
          // the transaction that produced it commits.
          appendEvents(db, [draft({ payload: { note: 'doomed' } })]);
          throw abort;
        }),
      ).toThrow(abort);

      const payloads = readRange(db, RUN_A, 0, 200).events.map((event) => event.payload);
      expect(payloads).not.toContainEqual({ note: 'doomed' });
      expect(payloads).toHaveLength(100);
      expect(highWater(db)).toBe(100);
    } finally {
      db.close();
    }
  });
});

suite('pruning is what actually leaves a hole (EPIC-03-S8, AC1 → AC3)', () => {
  it('never reissues the deleted number, so the observed sequence has a gap', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, drafts(3));
      db.prepare('DELETE FROM event WHERE seq = ?').run(2);
      const [next] = appendEvents(db, [draft()]);

      expect(next).toBe(4);
      expect(readRange(db, RUN_A, 0, 100).events.map((event) => event.seq)).toEqual([1, 3, 4]);

      // A consumer holding cursor 1 gets 3, not 2. `cursor + 1` would ask for a
      // row that will never exist again.
      expect(readRange(db, RUN_A, 1, 100).events.map((event) => event.seq)).toEqual([3, 4]);
    } finally {
      db.close();
    }
  });
});

suite('the cursor contract is "strictly greater than" (EPIC-03-S9 scenario 2)', () => {
  it('walks a run to the end without ever computing cursor + 1', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      // Interleaved runs: run A's seqs are 1, 3, 5, 7 — every step is a gap.
      for (let index = 0; index < 4; index += 1) {
        appendEvents(db, [draft({ runId: RUN_A }), draft({ runId: RUN_B })]);
      }

      const seen: number[] = [];
      let cursor = 0;
      for (;;) {
        const page = readRange(db, RUN_A, cursor, 2);
        for (const event of page.events) seen.push(event.seq);
        if (!page.hasMore) break;
        cursor = page.events.at(-1)?.seq ?? cursor;
      }
      expect(seen).toEqual([1, 3, 5, 7]);

      // …and the naive resume is a permanent phantom gap: nothing at 2.
      expect(readRange(db, RUN_A, 1, 1).events.map((event) => event.seq)).toEqual([3]);
      expect(
        db
          .prepare<{ n: number }>('SELECT count(*) AS n FROM event WHERE run_id = ? AND seq = 2')
          .get(RUN_A),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});
