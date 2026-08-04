/**
 * @DeFlow/ledger — the SQLite event store: append-only event log, effect
 * journal, plan/run/node_wake tables, PRAGMA user_version migrations, the
 * content-addressed blob store and the SSE tail queries.
 *
 * This file is the package's whole contract: re-exports only, no logic
 * (docs/16-repo-layout.md §8).
 *
 * KAR-03.1 ships the connection layer. KAR-03.2 adds the migration runner,
 * migration 0001's six-table schema, and `openLedger`. The rest of EPIC-03
 * fills the rest in.
 */
// KAR-03.1 — the driver adapter behind the Db port declared in @DeFlow/core.
export { LedgerAlreadyOpen, LedgerTooNew } from './errors.ts';
// KAR-03.2 — ~40 lines over PRAGMA user_version, plus the pre-migration backup.
export { type Migration, migrate } from './migrate.ts';
export { MIGRATIONS } from './migrations/index.ts';
export { openLedger } from './open-ledger.ts';
export { applyPragmas, LEDGER_PRAGMAS, SYNCHRONOUS, withFullSync } from './pragmas.ts';
export { openRead, openWrite } from './sqlite-db.ts';
