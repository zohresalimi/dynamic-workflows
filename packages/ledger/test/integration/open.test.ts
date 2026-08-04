/**
 * KAR-03.1 — opening the ledger: pragma read-back, WAL persistence across a
 * reopen, the reader's timeout, and the one-writer rule inside a process.
 *
 * File-backed throughout, in a real tmpdir. The reopen is the whole point of
 * scenario 2: a fresh handle over the same file is the code path a daemon
 * restart takes.
 *
 * Verifies: EPIC-03-S2, EPIC-03-S3 (scenario 3) · AC1, AC2, AC3, AC4
 */

import { it } from '@DeFlow/testkit';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, describe as suite } from 'vitest';
import { LedgerAlreadyOpen, openRead, openWrite } from '../../src/index.ts';

const ledgerFile = (tmp: string): string => join(tmp, 'ledger.db');

/** The fixture table these specs write into. Migration 0001 (KAR-03.2) is where the real schema lands. */
const CREATE_FIXTURE = 'CREATE TABLE fixture (seq INTEGER PRIMARY KEY AUTOINCREMENT) STRICT';

suite('every open applies the pragmas (EPIC-03-S2, AC1)', () => {
  it('reads all seven back off the write connection', ({ tmp }) => {
    const db = openWrite(ledgerFile(tmp));
    try {
      expect(db.pragma('journal_mode')).toBe('wal');
      expect(db.pragma('synchronous')).toBe(1); // NORMAL
      expect(db.pragma('busy_timeout')).toBe(5000);
      expect(db.pragma('foreign_keys')).toBe(1);
      expect(db.pragma('wal_autocheckpoint')).toBe(1000);
      expect(db.pragma('journal_size_limit')).toBe(67_108_864);
      expect(db.pragma('cache_size')).toBe(-32_000);
    } finally {
      db.close();
    }
  });

  it('leaves a -wal and a -shm alongside the database while it is open', ({ tmp }) => {
    const file = ledgerFile(tmp);
    const db = openWrite(file);
    try {
      db.exec(CREATE_FIXTURE);
      expect(existsSync(`${file}-wal`)).toBe(true);
      expect(existsSync(`${file}-shm`)).toBe(true);
    } finally {
      db.close();
    }
  });
});

suite('journal_mode is persistent, the rest are per-connection (EPIC-03-S2, AC2)', () => {
  it('reads back "wal" on a connection that has set no pragma at all', ({ tmp }) => {
    const file = ledgerFile(tmp);
    const first = openWrite(file);
    first.exec(CREATE_FIXTURE);
    first.close();

    // Deliberately the raw driver rather than openWrite: the claim is about
    // what the *file* remembers, and openWrite would set journal_mode itself.
    const bare = new Database(file);
    try {
      expect(bare.pragma('journal_mode', { simple: true })).toBe('wal');
      // …and the per-connection half. `journal_size_limit` is the honest probe
      // here: this build compiles DEFAULT_WAL_SYNCHRONOUS=1 and
      // DEFAULT_FOREIGN_KEYS, so `synchronous` and `foreign_keys` already read
      // back the values §7.1 sets, while the journal size limit is -1 until a
      // connection asks for the 64 MB cap.
      expect(bare.pragma('journal_size_limit', { simple: true })).toBe(-1);
      expect(bare.pragma('cache_size', { simple: true })).toBe(-16_000);
    } finally {
      bare.close();
    }
  });
});

suite('one writer per path (EPIC-03-S3 scenario 3, AC3)', () => {
  it('throws LedgerAlreadyOpen on a second openWrite of the same file', ({ tmp }) => {
    const file = ledgerFile(tmp);
    const db = openWrite(file);
    try {
      expect(() => openWrite(file)).toThrow(LedgerAlreadyOpen);
      expect(() => openWrite(file)).toThrow(file);
    } finally {
      db.close();
    }
  });

  it('lets the path be reopened once the first connection is closed', ({ tmp }) => {
    const file = ledgerFile(tmp);
    openWrite(file).close();
    const second = openWrite(file);
    try {
      expect(second.open).toBe(true);
    } finally {
      second.close();
    }
  });

  it('exposes no pool, queue or writer-acquisition API', async () => {
    const ledger: Record<string, unknown> = await import('../../src/index.ts');
    const suspicious = Object.keys(ledger).filter((name) =>
      /pool|queue|acquire(writer|write)/i.test(name),
    );
    expect(suspicious).toEqual([]);
  });
});

suite('readers (EPIC-03-S2 scenario 3, AC4)', () => {
  it('gets the same 5000 ms busy timeout as the writer', ({ tmp }) => {
    const file = ledgerFile(tmp);
    const writer = openWrite(file);
    writer.exec(CREATE_FIXTURE);
    const reader = openRead(file);
    try {
      expect(reader.pragma('busy_timeout')).toBe(5000);
    } finally {
      reader.close();
      writer.close();
    }
  });

  it('can be opened more than once — readers are not a singleton', ({ tmp }) => {
    const file = ledgerFile(tmp);
    const writer = openWrite(file);
    writer.exec(CREATE_FIXTURE);
    const first = openRead(file);
    const second = openRead(file);
    try {
      expect(first.open && second.open).toBe(true);
    } finally {
      first.close();
      second.close();
      writer.close();
    }
  });

  it('refuses to write, so a reader can never become a second writer', ({ tmp }) => {
    const file = ledgerFile(tmp);
    const writer = openWrite(file);
    writer.exec(CREATE_FIXTURE);
    const reader = openRead(file);
    try {
      expect(() => reader.exec('INSERT INTO fixture DEFAULT VALUES')).toThrow(/readonly/i);
    } finally {
      reader.close();
      writer.close();
    }
  });

  it('reads while the write connection holds an open transaction', ({ tmp }) => {
    const file = ledgerFile(tmp);
    const writer = openWrite(file);
    writer.exec(CREATE_FIXTURE);
    writer.prepare('INSERT INTO fixture DEFAULT VALUES').run();
    const reader = openRead(file);
    try {
      const seen = writer.transaction(() => {
        writer.prepare('INSERT INTO fixture DEFAULT VALUES').run();
        // Inside the write transaction, on a different connection.
        return reader.prepare<{ n: number }>('SELECT count(*) AS n FROM fixture').get();
      });
      // The snapshot the reader saw is the pre-transaction one.
      expect(seen).toEqual({ n: 1 });
      expect(reader.prepare<{ n: number }>('SELECT count(*) AS n FROM fixture').get()).toEqual({
        n: 2,
      });
    } finally {
      reader.close();
      writer.close();
    }
  });
});
