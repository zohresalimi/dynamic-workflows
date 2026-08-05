/**
 * `openLedger` — the daemon's front door onto a data directory: takes the
 * write connection, runs every pending shipped migration against it (backup
 * first, downgrade-refusal included), and hands back the open `Db`.
 *
 * A migration failure — including `LedgerTooNew` — closes the connection it
 * just opened before rethrowing, so a caller that catches and retries never
 * finds `LedgerAlreadyOpen` in its own way.
 */
import type { Db } from '@DeFlow/core';
import { join } from 'node:path';
import { migrate } from './migrate.ts';
import { MIGRATIONS } from './migrations/index.ts';
import { openWrite } from './sqlite-db.ts';

export function openLedger(dataDir: string): Db {
  const db = openWrite(join(dataDir, 'ledger.db'));
  try {
    migrate(db, MIGRATIONS, dataDir);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
