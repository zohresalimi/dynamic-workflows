/**
 * The `Db` port (decision D6, docs/05-durable-execution.md §7).
 *
 * Five methods, and that is the whole surface. The port exists for
 * **substitutability, not abstraction**: it is the seam that lets
 * @DeFlow/core describe what the engine does with a database without core
 * ever holding one, and it is the seam that makes swapping the driver a
 * one-file change in @DeFlow/ledger. It is emphatically not a query builder,
 * and nothing here tries to hide SQL — the ledger's statements are written out
 * in full because they are the schema's contract and are meant to be read.
 *
 * Two rules follow from where this file lives (R1: core performs no I/O):
 *
 * 1. **No driver type may appear in a signature.** If `prepare()` returned a
 *    better-sqlite3 `Statement`, core would depend on the driver's types and no
 *    fake could implement the port. The contract suite in @DeFlow/testkit is
 *    what keeps that honest — it runs unchanged against both implementations.
 * 2. **Nothing here opens anything.** `openWrite`/`openRead` live in
 *    @DeFlow/ledger; core only ever receives an already-open `Db`.
 *
 * The connection model this port is shaped for is **one write connection and N
 * read-only connections** — not a pool. Verified 2026-08-02 (and again on
 * 2026-08-05 across two processes): SQLite permits exactly one writer, and a
 * second connection's `BEGIN IMMEDIATE` fails with `SQLITE_BUSY`.
 */

/** Everything SQLite can bind to a statement parameter or return in a column. */
export type DbValue = string | number | bigint | Uint8Array | null;

/** What a statement that changed rows reports. */
export interface DbRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

/**
 * A prepared statement. Prepared once, executed many times — the ledger's
 * append path runs the same three statements for the life of the daemon.
 */
export interface DbStatement<Row = Record<string, DbValue>> {
  /** Executes the statement and reports what it changed. */
  run(...parameters: DbValue[]): DbRunResult;
  /** The first row, or `undefined` when there is none. */
  get(...parameters: DbValue[]): Row | undefined;
  /** Every row. */
  all(...parameters: DbValue[]): Row[];
}

export interface Db {
  /** False once `close()` has been called. */
  readonly open: boolean;
  /** Prepares `sql`. The caller owns the returned statement and should reuse it. */
  prepare<Row = Record<string, DbValue>>(sql: string): DbStatement<Row>;
  /** Executes one or more statements that return nothing — DDL, `BEGIN`, `COMMIT`. */
  exec(sql: string): void;
  /**
   * Runs `fn` inside a transaction that begins **immediately** — the write lock
   * is taken up front rather than on the first write, so a busy database fails
   * here, at a point that can wait for `busy_timeout`, instead of half way
   * through. Commits on return, rolls back and rethrows on throw.
   */
  transaction<T>(fn: () => T): T;
  /**
   * Runs one PRAGMA and returns its simple value. `pragma('busy_timeout')`
   * reads; `pragma('busy_timeout = 5000')` sets. The `PRAGMA` keyword itself is
   * not part of `source`.
   */
  pragma(source: string): unknown;
  /** Closes the connection. Idempotent. */
  close(): void;
}
