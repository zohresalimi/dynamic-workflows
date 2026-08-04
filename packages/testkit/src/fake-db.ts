/**
 * The fake `Db` (KAR-03.1).
 *
 * This is the one place in the testkit where a fake is the right answer rather
 * than a real thing, and the reason is narrow: it exists to prove the port is
 * implementable **without a driver**. It imports `Db` from @DeFlow/core and
 * nothing else, so a port signature that mentioned a better-sqlite3 type could
 * not compile here at all — which is a stronger guarantee than any review.
 *
 * Its second job is to record. `applyPragmas` is asserted against `pragmaLog`,
 * because the ledger's seven PRAGMAs must be applied **in order** and three of
 * them are already this SQLite build's compile-time default — a read-back test
 * cannot tell "we set it" from "it was already that".
 *
 * It is **not** a SQLite emulator and must never grow into one. It understands
 * a deliberately tiny subset of SQL (the shapes the contract suite in
 * ./db-contract.ts uses) and throws `FakeDbUnsupportedSql` on anything else, so
 * a spec that outgrows it fails loudly instead of quietly testing the fake's
 * imagination. Durability, WAL, concurrency and everything else this project
 * actually promises are tested against a real file-backed database.
 */
import type { Db, DbRunResult, DbStatement, DbValue } from '@DeFlow/core';

export class FakeDbUnsupportedSql extends Error {
  readonly sql: string;

  constructor(sql: string) {
    super(
      `the fake Db does not implement "${sql}". It speaks only the small subset the Db contract ` +
        'suite uses and is not a SQLite emulator — write this spec against a real file-backed ' +
        'database (openWrite from @DeFlow/ledger) instead.',
    );
    this.name = 'FakeDbUnsupportedSql';
    this.sql = sql;
  }
}

export class FakeDbClosed extends Error {
  constructor() {
    super('the fake Db has been closed');
    this.name = 'FakeDbClosed';
  }
}

type Row = Record<string, DbValue>;

interface Table {
  readonly columns: string[];
  /** The `INTEGER PRIMARY KEY AUTOINCREMENT` column, when the DDL declared one. */
  readonly autoColumn: string | null;
  rows: Row[];
  /** AUTOINCREMENT's high-water mark: a deleted key is never reissued. */
  highWater: number;
}

const CREATE = /^CREATE\s+TABLE\s+(\w+)\s*\(([\s\S]*)\)\s*(?:STRICT)?\s*$/i;
const INSERT =
  /^INSERT\s+INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)(?:\s+RETURNING\s+(.+))?$/i;
const SELECT =
  /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(\w+)\s*=\s*\?)?(?:\s+ORDER\s+BY\s+(\w+))?$/i;
const DELETE = /^DELETE\s+FROM\s+(\w+)(?:\s+WHERE\s+(\w+)\s*=\s*\?)?$/i;
const PRAGMA_SET = /^(\w+)\s*=\s*(.+)$/;

const splitList = (text: string): string[] =>
  text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

/** Splits a CREATE TABLE body on top-level commas, so `DEFAULT (a, b)` survives. */
function splitColumnDefinitions(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of body) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

export class FakeDb implements Db {
  #open = true;
  #depth = 0;
  readonly #tables = new Map<string, Table>();
  readonly #pragmas = new Map<string, DbValue>();
  readonly #pragmaLog: string[] = [];

  /** Every pragma this connection was asked to apply, in order, sets and reads alike. */
  get pragmaLog(): readonly string[] {
    return this.#pragmaLog;
  }

  get open(): boolean {
    return this.#open;
  }

  prepare<R = Record<string, DbValue>>(sql: string): DbStatement<R> {
    const statement = sql.trim().replace(/;$/, '');
    const execute = (parameters: DbValue[]): { rows: Row[]; result: DbRunResult } =>
      this.#execute(statement, parameters);
    return {
      run: (...parameters: DbValue[]): DbRunResult => execute(parameters).result,
      get: (...parameters: DbValue[]): R | undefined =>
        execute(parameters).rows[0] as R | undefined,
      all: (...parameters: DbValue[]): R[] => execute(parameters).rows as R[],
    };
  }

  exec(sql: string): void {
    for (const statement of sql.split(';')) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) this.#execute(trimmed, []);
    }
  }

  transaction<T>(fn: () => T): T {
    this.#assertOpen();
    if (this.#depth > 0) return fn();

    const snapshot = new Map(
      [...this.#tables].map(([name, table]) => [
        name,
        { ...table, rows: table.rows.map((row) => ({ ...row })) } satisfies Table,
      ]),
    );
    this.#depth += 1;
    try {
      const value = fn();
      this.#depth -= 1;
      return value;
    } catch (error) {
      this.#depth -= 1;
      this.#tables.clear();
      for (const [name, table] of snapshot) this.#tables.set(name, table);
      throw error;
    }
  }

  pragma(source: string): unknown {
    this.#assertOpen();
    const trimmed = source.trim();
    this.#pragmaLog.push(trimmed);
    const set = PRAGMA_SET.exec(trimmed);
    if (set === null) return this.#pragmas.get(trimmed.toLowerCase());

    const name = (set[1] ?? '').toLowerCase();
    const raw = (set[2] ?? '').trim();
    const value: DbValue = /^-?\d+$/.test(raw) ? Number(raw) : raw;
    this.#pragmas.set(name, value);
    return value;
  }

  close(): void {
    this.#open = false;
  }

  #assertOpen(): void {
    if (!this.#open) throw new FakeDbClosed();
  }

  #table(name: string, sql: string): Table {
    const table = this.#tables.get(name.toLowerCase());
    if (table === undefined) throw new FakeDbUnsupportedSql(sql);
    return table;
  }

  #execute(sql: string, parameters: DbValue[]): { rows: Row[]; result: DbRunResult } {
    this.#assertOpen();
    const none = { changes: 0, lastInsertRowid: 0 } satisfies DbRunResult;

    const create = CREATE.exec(sql);
    if (create !== null) {
      const definitions = splitColumnDefinitions(create[2] ?? '');
      const columns = definitions.map((definition) => definition.split(/\s+/)[0] ?? '');
      const auto = definitions.find((definition) =>
        /INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/i.test(definition),
      );
      this.#tables.set((create[1] ?? '').toLowerCase(), {
        columns,
        autoColumn: auto === undefined ? null : (auto.split(/\s+/)[0] ?? null),
        rows: [],
        highWater: 0,
      });
      return { rows: [], result: none };
    }

    const insert = INSERT.exec(sql);
    if (insert !== null) {
      const table = this.#table(insert[1] ?? '', sql);
      const columns = splitList(insert[2] ?? '');
      const placeholders = splitList(insert[3] ?? '');
      if (placeholders.some((placeholder) => placeholder !== '?')) {
        throw new FakeDbUnsupportedSql(sql);
      }
      const row: Row = {};
      if (table.autoColumn !== null) {
        table.highWater += 1;
        row[table.autoColumn] = table.highWater;
      }
      for (const [index, column] of columns.entries()) row[column] = parameters[index] ?? null;
      table.rows.push(row);

      const returning = insert[4];
      const rows =
        returning === undefined
          ? []
          : [
              Object.fromEntries(
                splitList(returning).map((column) => [column, row[column] ?? null]),
              ),
            ];
      return {
        rows,
        result: { changes: 1, lastInsertRowid: table.autoColumn === null ? 0 : table.highWater },
      };
    }

    const select = SELECT.exec(sql);
    if (select !== null) {
      const table = this.#table(select[2] ?? '', sql);
      const columns = select[1] === '*' ? table.columns : splitList(select[1] ?? '');
      if (columns.some((column) => !table.columns.includes(column))) {
        throw new FakeDbUnsupportedSql(sql);
      }
      const where = select[3];
      let rows = table.rows;
      if (where !== undefined) rows = rows.filter((row) => row[where] === parameters[0]);
      const order = select[4];
      if (order !== undefined) {
        rows = [...rows].sort((left, right) => Number(left[order]) - Number(right[order]));
      }
      return {
        rows: rows.map((row) =>
          Object.fromEntries(columns.map((column) => [column, row[column] ?? null])),
        ),
        result: none,
      };
    }

    const remove = DELETE.exec(sql);
    if (remove !== null) {
      const table = this.#table(remove[1] ?? '', sql);
      const where = remove[2];
      const before = table.rows.length;
      table.rows =
        where === undefined ? [] : table.rows.filter((row) => row[where] !== parameters[0]);
      return { rows: [], result: { changes: before - table.rows.length, lastInsertRowid: 0 } };
    }

    throw new FakeDbUnsupportedSql(sql);
  }
}
