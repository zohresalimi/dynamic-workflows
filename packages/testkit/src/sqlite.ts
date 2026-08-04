/**
 * File-backed SQLite for tests (docs/14-testing-strategy.md §7).
 *
 * There is no in-memory shortcut here on purpose. An in-memory database cannot
 * exercise WAL, cannot be reopened after a simulated crash, and hides fsync and
 * ordering bugs — that is F4.2, resume after crash, which is the entire
 * durability thesis. Reopening a fresh handle over the same file is the code
 * path a daemon restart actually takes, so it is the one the tests take too.
 *
 * There is no performance excuse either: better-sqlite3@13.0.2 ships prebuilt
 * N-API binaries with `gypfile: false` and installs in about a second with zero
 * compilation, so the real driver costs the suite nothing.
 */
import Database from 'better-sqlite3';

/**
 * `synchronous=NORMAL` protects against a process crash but not power loss, and
 * `FULL` on APFS is slow enough (979 ev/s versus 22,982 ev/s on the Linux
 * measurement) that the setting is a product trade-off. KAR-00.5 re-measures it
 * on APFS and names the shipping value; until then the tests use the value
 * docs/14-testing-strategy.md §7 states.
 */
export const TEST_PRAGMAS = [
  'PRAGMA journal_mode=WAL',
  'PRAGMA synchronous=NORMAL',
  'PRAGMA busy_timeout=5000',
] as const;

/** Opens (or creates) a database file and applies the pragmas above. */
export function openTestDatabase(file: string): Database.Database {
  const db = new Database(file);
  for (const pragma of TEST_PRAGMAS) db.exec(pragma);
  return db;
}
