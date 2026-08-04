/**
 * KAR-01.4 — the SQLite fixture, file-backed, reopened.
 *
 * The reopen is the whole point: writing, closing and then constructing a fresh
 * handle over the same file is the exact code path a daemon restart takes, and
 * it is the path an in-memory database cannot express at all. Note that this
 * file names no in-memory DSN even in prose — the guard in
 * test/testing-hygiene.test.ts scans this directory for one.
 *
 * Verifies: EPIC-01-S19 · docs/14-testing-strategy.md §7
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { it, openTestDatabase } from '../../src/index.ts';

interface Row {
  readonly seq: number;
  readonly payload: string;
}

suite('openTestDatabase', () => {
  it('applies the three pragmas docs/14-testing-strategy.md §7 names', ({ tmp }) => {
    const db = openTestDatabase(join(tmp, 'ledger.db'));
    try {
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(db.pragma('synchronous', { simple: true })).toBe(1); // NORMAL
      expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    } finally {
      db.close();
    }
  });

  it('creates a real file, and a WAL alongside it once something is written', ({ tmp }) => {
    const file = join(tmp, 'ledger.db');
    const db = openTestDatabase(file);
    try {
      db.exec('CREATE TABLE event (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
      db.prepare('INSERT INTO event (seq, payload) VALUES (?, ?)').run(1, 'first');
      expect(existsSync(file)).toBe(true);
      expect(existsSync(`${file}-wal`)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('reads events back in order from a fresh handle over the same file', ({ tmp }) => {
    const file = join(tmp, 'ledger.db');

    const first = openTestDatabase(file);
    first.exec('CREATE TABLE event (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
    const insert = first.prepare('INSERT INTO event (seq, payload) VALUES (?, ?)');
    for (const [seq, payload] of [
      [1, 'planned'],
      [2, 'started'],
      [3, 'finished'],
    ] as const) {
      insert.run(seq, payload);
    }
    first.close();

    const reopened = openTestDatabase(file);
    try {
      const rows = reopened.prepare('SELECT seq, payload FROM event ORDER BY seq').all() as Row[];
      expect(rows.map((row) => row.payload)).toEqual(['planned', 'started', 'finished']);
      expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      reopened.close();
    }
  });
});
