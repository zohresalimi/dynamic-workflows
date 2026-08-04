/**
 * @DeFlow/ledger — the SQLite event store: append-only event log, effect
 * journal, plan/run/node_wake tables, PRAGMA user_version migrations, the
 * content-addressed blob store and the SSE tail queries.
 *
 * This file is the package's whole contract: re-exports only, no logic
 * (docs/16-repo-layout.md §8).
 *
 * KAR-03.1 ships the connection layer. The rest of EPIC-03 fills this in.
 */
// KAR-03.1 — the driver adapter behind the Db port declared in @DeFlow/core.
export { LedgerAlreadyOpen } from './errors.ts';
export { applyPragmas, LEDGER_PRAGMAS, SYNCHRONOUS, withFullSync } from './pragmas.ts';
export { openRead, openWrite } from './sqlite-db.ts';
