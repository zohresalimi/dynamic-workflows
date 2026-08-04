/**
 * The migration runner — ~40 lines over `PRAGMA user_version`
 * (docs/05-durable-execution.md §7.2, KAR-03.2).
 *
 * Migrations are numbered `.ts` files under `src/migrations/`, append-only and
 * never edited once shipped, each exporting a `Migration` with an `up(db)`.
 * There are no `down` migrations: for a local single-user daemon you roll
 * forward or restore the backup this function takes before it touches
 * anything. A down migration is a second, less-tested code path that exists
 * to be wrong.
 */
import type { Db } from '@DeFlow/core';
import { join } from 'node:path';
import { LedgerTooNew } from './errors.ts';

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly up: (db: Db) => void;
}

function readUserVersion(db: Db): number {
  const value = db.pragma('user_version');
  if (typeof value !== 'number') {
    throw new TypeError(`PRAGMA user_version returned ${typeof value} where a number was expected`);
  }
  return value;
}

function highestId(migrations: readonly Migration[]): number {
  return migrations.reduce((max, m) => Math.max(max, m.id), 0);
}

/**
 * `VACUUM INTO '<dbDir>/pre-migrate-<userVersion>.db'` — measured 2026-08-02
 * at 1007 ms for a 193 MB database, versus 1633 ms for `db.backup()`, so this
 * is both faster and produces a compacted copy. Bound as a statement
 * parameter rather than interpolated: unlike `PRAGMA user_version`, `VACUUM
 * INTO`'s filename is an ordinary expression argument and SQLite accepts it
 * bound.
 *
 * It has a second use: a one-command "attach my ledger to this bug report".
 */
function backupBeforeMigrating(db: Db, dbDir: string, userVersion: number): void {
  const backupFile = join(dbDir, `pre-migrate-${userVersion}.db`);
  db.prepare('VACUUM INTO ?').run(backupFile);
}

/**
 * Runs every migration whose id is greater than the ledger's current
 * `PRAGMA user_version`, in ascending id order, leaving `user_version` at the
 * highest applied id. `dbDir` is where the pre-migration backup lands — the
 * directory the ledger file itself lives in.
 *
 * Refuses outright, via `LedgerTooNew`, when the ledger's `user_version`
 * already exceeds every id `migrations` knows about: that is a ledger written
 * by a newer binary, and there is no `down` path to run it backward with.
 *
 * An already-current ledger takes no backup and performs no write at all —
 * idempotence here is by construction, not by luck.
 */
export function migrate(db: Db, migrations: readonly Migration[], dbDir: string): void {
  const highest = highestId(migrations);
  const current = readUserVersion(db);

  if (current > highest) throw new LedgerTooNew(current, highest, dbDir);

  const pending = migrations.filter((m) => m.id > current).sort((a, b) => a.id - b.id);
  if (pending.length === 0) return;

  // Before the first up() runs — the whole point of taking it.
  backupBeforeMigrating(db, dbDir, current);

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    for (const m of pending) {
      db.exec('BEGIN IMMEDIATE');
      try {
        m.up(db);
        // Cannot be parameterised — `m.id` is a number read off the migration
        // object itself, never anything derived from input.
        db.exec(`PRAGMA user_version = ${m.id}`);
        db.exec('COMMIT');
      } catch (error) {
        // SQLite DDL is transactional, unlike MySQL, so this rolls back
        // cleanly even mid-CREATE-TABLE.
        db.exec('ROLLBACK');
        throw new Error(`migration ${m.id} (${m.name}) failed`, { cause: error });
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
