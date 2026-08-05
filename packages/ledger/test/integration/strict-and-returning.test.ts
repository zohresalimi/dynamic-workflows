/**
 * KAR-03.1 — `STRICT` refuses what affinity would have coerced, and
 * `RETURNING` hands back the assigned sequence number without a second query.
 *
 * The table is created here rather than imported: migration 0001 (KAR-03.2) is
 * where the six real tables land. What is under test in this story is the
 * driver — that a `STRICT` table declared through this port genuinely enforces
 * its column types, and that `INSERT … RETURNING` works on the pinned
 * better-sqlite3/SQLite pair.
 *
 * Verifies: EPIC-03-S4, EPIC-03-S1 (scenario 2's RETURNING clause) · AC6, AC7
 */

import { it } from '@DeFlow/testkit';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { openWrite } from '../../src/index.ts';

/** docs/05-durable-execution.md §5, trimmed to the columns these specs touch. */
const CREATE_EVENT = `CREATE TABLE event (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id  TEXT    NOT NULL,
  ts      INTEGER NOT NULL,
  kind    TEXT    NOT NULL,
  v       INTEGER NOT NULL DEFAULT 1,
  payload TEXT    NOT NULL
) STRICT`;

const openEventTable = (tmp: string) => {
  const db = openWrite(join(tmp, 'ledger.db'));
  db.exec(CREATE_EVENT);
  return db;
};

suite('STRICT enforces column types (EPIC-03-S4, AC6)', () => {
  it('rejects a text timestamp with the exact SQLite message', ({ tmp }) => {
    const db = openEventTable(tmp);
    try {
      const insert = db.prepare(
        'INSERT INTO event (run_id, ts, kind, v, payload) VALUES (?, ?, ?, ?, ?)',
      );
      expect(() => insert.run('run_x', 'not-a-number', 'run.created', 1, '{}')).toThrow(
        'cannot store TEXT value in INTEGER column event.ts',
      );
    } finally {
      db.close();
    }
  });

  it('writes no row when it rejects one', ({ tmp }) => {
    const db = openEventTable(tmp);
    try {
      const insert = db.prepare(
        'INSERT INTO event (run_id, ts, kind, v, payload) VALUES (?, ?, ?, ?, ?)',
      );
      expect(() => insert.run('run_x', 'not-a-number', 'run.created', 1, '{}')).toThrow();
      expect(db.prepare<{ n: number }>('SELECT count(*) AS n FROM event').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('every table in the file is declared STRICT', ({ tmp }) => {
    const db = openEventTable(tmp);
    try {
      const tables = db
        .prepare<{ name: string; sql: string }>(
          "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      expect(tables.length).toBeGreaterThan(0);
      for (const table of tables) expect(table.sql.trimEnd().endsWith('STRICT')).toBe(true);
    } finally {
      db.close();
    }
  });
});

suite('INSERT … RETURNING seq (EPIC-03-S1, AC7)', () => {
  it('returns the assigned sequence number from the insert itself', ({ tmp }) => {
    const db = openEventTable(tmp);
    try {
      const insert = db.prepare<{ seq: number }>(
        'INSERT INTO event (run_id, ts, kind, v, payload) VALUES (?, ?, ?, ?, ?) RETURNING seq',
      );
      const returned = [1, 2, 3].map(
        (ts) => insert.get('run_20260802T141133Z_9f2a1c', ts, 'run.created', 1, '{}')?.seq,
      );
      expect(returned).toEqual([1, 2, 3]);

      // The same number a follow-up SELECT would have cost a second round trip
      // to learn.
      expect(db.prepare<{ max: number }>('SELECT max(seq) AS max FROM event').get()).toEqual({
        max: 3,
      });
    } finally {
      db.close();
    }
  });
});
