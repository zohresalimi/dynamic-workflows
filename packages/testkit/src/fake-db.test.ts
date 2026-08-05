/**
 * KAR-03.1 — the fake `Db` against the shared contract.
 *
 * The fake is the half of the contract that proves the port did not leak driver
 * types: it imports `Db` from @DeFlow/core and nothing else, so a signature
 * that mentioned a better-sqlite3 `Statement` could not be implemented here at
 * all. The other half runs the same suite against the real adapter in
 * packages/ledger/test/integration/db-contract.test.ts.
 *
 * Verifies: KAR-03.1 test plan row 7 (fake half)
 */
import { it as base, expect, describe as suite } from 'vitest';
import { dbContract } from './db-contract.ts';
import { FakeDb, FakeDbUnsupportedSql } from './fake-db.ts';

dbContract('the fake Db', () => new FakeDb());

suite('the fake refuses what it cannot honestly answer', () => {
  base('throws on SQL outside the subset it implements', () => {
    const db = new FakeDb();
    expect(() => db.prepare('SELECT label FROM contract JOIN other USING (seq)').all()).toThrow(
      FakeDbUnsupportedSql,
    );
  });

  base('records every pragma it was asked to apply, in order', () => {
    const db = new FakeDb();
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    expect(db.pragmaLog).toEqual(['journal_mode = WAL', 'busy_timeout = 5000']);
  });
});
