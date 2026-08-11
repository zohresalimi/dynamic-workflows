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
import { type Migration, migrate } from './migrate.ts';
import { MIGRATIONS } from './migrations/index.ts';
import { openWrite } from './sqlite-db.ts';

/**
 * `migrations` defaults to every migration this build ships, and the parameter
 * exists for exactly one caller: a spec that has to watch a migration *fail*
 * (KAR-18.2 AC5). Shipped migrations are append-only and are never edited once
 * released, so there is no other honest way to produce a failing one — and
 * "the daemon refuses to serve a half-migrated ledger" is a guarantee that has
 * to be tested rather than asserted.
 */
export function openLedger(dataDir: string, migrations: readonly Migration[] = MIGRATIONS): Db {
  const db = openWrite(join(dataDir, 'ledger.db'));
  try {
    migrate(db, migrations, dataDir);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
