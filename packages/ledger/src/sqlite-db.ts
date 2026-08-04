/**
 * The `Db` port's one implementation: better-sqlite3@13.0.2 (decision D6).
 *
 * This file is the whole driver surface of DeFlow. Everything above it — the
 * migration runner, the append path, the reducer, the scheduler — talks to the
 * `Db` interface in @DeFlow/core, so swapping the driver is a change to this
 * file and its contract test, and nothing else. That is the entire reason the
 * port exists; it is not an abstraction over SQL, and the statements elsewhere
 * in this package are written out in full on purpose.
 *
 * Synchronous by design. better-sqlite3 is not an oversight to be wrapped in
 * promises later: SQLite reads are memory-speed, and an async wrapper would buy
 * a thread hop per statement while making the transaction boundary — which must
 * not interleave with anything — much easier to get wrong.
 */
import type { Db, DbRunResult, DbStatement, DbValue } from '@DeFlow/core';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { LedgerAlreadyOpen } from './errors.ts';
import { applyPragmas } from './pragmas.ts';

/**
 * The write connections this process holds, by resolved path.
 *
 * One writer per ledger, and a registry rather than a single slot because a
 * test worker legitimately drives several ledgers in several tmpdirs at once —
 * what must never happen is two write connections to the *same* file. A
 * process-wide singleton would make the tests lie about which rule is being
 * enforced.
 */
const writers = new Map<string, SqliteDb>();

class SqliteDb implements Db {
  readonly #db: Database.Database;
  readonly #onClose: (() => void) | undefined;

  constructor(db: Database.Database, onClose?: () => void) {
    this.#db = db;
    this.#onClose = onClose;
  }

  get open(): boolean {
    return this.#db.open;
  }

  prepare<Row = Record<string, DbValue>>(sql: string): DbStatement<Row> {
    const statement = this.#db.prepare<DbValue[], Row>(sql);
    return {
      run: (...parameters: DbValue[]): DbRunResult => statement.run(...parameters),
      get: (...parameters: DbValue[]): Row | undefined => statement.get(...parameters),
      all: (...parameters: DbValue[]): Row[] => statement.all(...parameters),
    };
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    // `.immediate()`, not the default deferred form: a deferred transaction
    // takes the write lock on its first write, which means a busy database is
    // discovered part-way through a batch that has already computed its
    // effects. Immediate takes it up front, where `busy_timeout` can wait for
    // it and where failing costs nothing.
    return this.#db.transaction(fn).immediate();
  }

  pragma(source: string): unknown {
    return this.#db.pragma(source, { simple: true });
  }

  close(): void {
    if (this.#db.open) this.#db.close();
    this.#onClose?.();
  }
}

/**
 * Opens **the** write connection for `file`, applying §7.1's pragmas in order.
 *
 * Throws `LedgerAlreadyOpen` if this process already has one for the same path.
 * Closing the returned connection releases the claim.
 */
export function openWrite(file: string): Db {
  const key = resolve(file);
  const existing = writers.get(key);
  if (existing?.open === true) throw new LedgerAlreadyOpen(key);

  const db = new SqliteDb(new Database(key), () => {
    writers.delete(key);
  });
  writers.set(key, db);
  try {
    applyPragmas(db);
  } catch (error) {
    // A pragma that fails leaves a connection nobody holds a reference to and a
    // registry entry nobody can release — so the next openWrite would report
    // LedgerAlreadyOpen for a ledger that is not open. Unwind before rethrowing.
    db.close();
    throw error;
  }
  return db;
}

/**
 * Opens a read-only connection. There may be as many as the daemon wants —
 * WAL readers do not block the writer and are not blocked by it.
 *
 * The same seven pragmas are applied here, `busy_timeout` very much included:
 * a reader without one fails immediately the moment it meets a checkpoint
 * instead of waiting, which surfaces later as a flaky SSE hydrate rather than
 * as anything that looks like a locking problem.
 */
export function openRead(file: string): Db {
  const db = new SqliteDb(new Database(resolve(file), { readonly: true, fileMustExist: true }));
  applyPragmas(db);
  return db;
}
