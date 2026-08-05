/**
 * KAR-03.3 — `AUTOINCREMENT` is mandatory, and this is the ten lines that say
 * why (docs/05-durable-execution.md §6, EPIC-03-S8).
 *
 * `seq` is the identity of an event **outside** the database: the SSE frame
 * `id` a browser tab persisted before a reload, the `last_seq` in a checkpoint
 * row, the cursor a frontend store holds across a reconnect. A bare
 * `INTEGER PRIMARY KEY` hands the highest deleted rowid straight back out —
 * so the first time run pruning ships, every one of those persisted cursors
 * starts pointing at a different event, silently. The comparison below is what
 * answers the future reader who thinks the keyword is ceremony.
 *
 * Verifies: EPIC-03-S8 · AC1
 */

import { it } from '@DeFlow/testkit';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { appendEvents, openLedger, openWrite, readRange } from '../../src/index.ts';
import { draft, RUN_A } from './support/events.ts';

/** insert, insert, insert, delete the third, insert — the pruning shape. */
const insertDeleteInsert = (
  insert: () => number,
  deleteBySeq: (seq: number) => void,
): { first: number[]; reissued: number } => {
  const first = [insert(), insert(), insert()];
  deleteBySeq(first[2] ?? 0);
  return { first, reissued: insert() };
};

suite('a bare INTEGER PRIMARY KEY reuses the number (EPIC-03-S8 scenario 1)', () => {
  it('reissues 3 after the row holding 3 is deleted', ({ tmp }) => {
    const db = openWrite(join(tmp, 'scratch.db'));
    try {
      db.exec('CREATE TABLE naive (seq INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT');
      const insertOne = db.prepare<{ seq: number }>(
        "INSERT INTO naive (v) VALUES ('x') RETURNING seq",
      );
      const removeOne = db.prepare('DELETE FROM naive WHERE seq = ?');

      const { first, reissued } = insertDeleteInsert(
        () => insertOne.get()?.seq ?? 0,
        (seq) => {
          removeOne.run(seq);
        },
      );

      expect(first).toEqual([1, 2, 3]);
      expect(reissued).toBe(3);
      // …and there is no sqlite_sequence row to have remembered otherwise.
      expect(
        db
          .prepare<{ n: number }>(
            "SELECT count(*) AS n FROM sqlite_master WHERE name = 'sqlite_sequence'",
          )
          .get(),
      ).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });
});

suite('the real event table does not (EPIC-03-S8 scenario 2)', () => {
  it('issues 4 after the row holding 3 is deleted, and sqlite_sequence remembers', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const highWater = (): number | undefined =>
        db.prepare<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'event'").get()
          ?.seq;

      const first = appendEvents(db, [draft(), draft(), draft()]);
      expect(first).toEqual([1, 2, 3]);
      expect(highWater()).toBe(3);

      // Pruning is not shipped and there is no exported way to do this — which
      // is the point of AC7. It is spelled out in raw SQL here precisely
      // because a future pruning feature will do exactly this.
      db.prepare('DELETE FROM event WHERE seq = ?').run(3);
      expect(highWater()).toBe(3);

      expect(appendEvents(db, [draft()])).toEqual([4]);
      expect(highWater()).toBe(4);
    } finally {
      db.close();
    }
  });

  it('declares AUTOINCREMENT on event.seq and io_chunk.seq', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const ddl = db
        .prepare<{ name: string; sql: string }>(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('event', 'io_chunk')",
        )
        .all();
      expect(ddl.map((table) => table.name).sort()).toEqual(['event', 'io_chunk']);
      for (const table of ddl) {
        expect(table.sql).toMatch(/seq\s+INTEGER PRIMARY KEY AUTOINCREMENT/i);
      }
    } finally {
      db.close();
    }
  });
});

suite('what reuse would break (EPIC-03-S8 scenario 3)', () => {
  it('would silently skip a real event for a consumer resuming from cursor 3', ({ tmp }) => {
    // The naive schema, driven exactly as the ledger's own cursor contract
    // drives the real one: "strictly greater than what I last saw".
    const db = openWrite(join(tmp, 'scratch.db'));
    try {
      db.exec('CREATE TABLE naive (seq INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT');
      const insertOne = db.prepare<{ seq: number }>(
        'INSERT INTO naive (v) VALUES (?) RETURNING seq',
      );
      for (const value of ['a', 'b', 'c']) insertOne.get(value);

      // A tab persisted cursor 3, then pruning removed the event that was 3.
      const cursor = 3;
      db.prepare('DELETE FROM naive WHERE seq = ?').run(3);

      // A genuinely new event arrives and is handed the freed number.
      expect(insertOne.get('d')?.seq).toBe(cursor);

      // The consumer resumes from "strictly greater than 3" and never sees it.
      const resumed = db
        .prepare<{ seq: number; v: string }>('SELECT seq, v FROM naive WHERE seq > ? ORDER BY seq')
        .all(cursor);
      expect(resumed).toEqual([]);
      // The event is there. Nothing errored. That is the whole failure.
      expect(db.prepare<{ n: number }>('SELECT count(*) AS n FROM naive').get()).toEqual({ n: 3 });
    } finally {
      db.close();
    }
  });

  it('does not happen on the real table: the resumed read sees the new event', ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      appendEvents(db, [draft(), draft(), draft()]);
      const cursor = 3;
      db.prepare('DELETE FROM event WHERE seq = ?').run(cursor);
      appendEvents(db, [draft({ payload: { note: 'after pruning' } })]);

      const { events } = readRange(db, RUN_A, cursor, 100);
      expect(events.map((event) => event.payload)).toEqual([{ note: 'after pruning' }]);
    } finally {
      db.close();
    }
  });
});
