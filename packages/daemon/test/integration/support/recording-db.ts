/**
 * A `Db` that records every statement executed through it (KAR-06.6 AC6).
 *
 * AC6's claim is not "the ticker is fast" — that would be a benchmark, and a
 * benchmark passes on a quiet machine and fails on a busy one. The claim is
 * that a suspended run performs **no writes at all** between ticks: a six-hour
 * human gate costs one row and a `SELECT` per second, and nothing else. That is
 * a countable fact, so this wrapper counts it.
 *
 * It delegates everything and interprets nothing beyond classifying a
 * statement as a read or a write by its leading keyword, which is enough here
 * because the ledger's SQL is written out in full rather than built.
 */
import type { Db, DbStatement, DbValue } from '@DeFlow/core';

export interface RecordedStatement {
  readonly sql: string;
  /** `run` for an executed statement, `exec` for a bare `db.exec`. */
  readonly via: 'run' | 'get' | 'all' | 'exec';
}

const WRITE_KEYWORDS = ['insert', 'update', 'delete', 'replace', 'create', 'drop', 'alter'];

const isWrite = (sql: string): boolean => {
  const first = sql.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  return WRITE_KEYWORDS.includes(first);
};

export interface RecordingDb extends Db {
  /** Every statement executed since the last `forget()`, in order. */
  readonly statements: readonly RecordedStatement[];
  /** Just the ones that could have changed a row. */
  readonly writes: readonly RecordedStatement[];
  forget(): void;
}

export function recordingDb(inner: Db): RecordingDb {
  const statements: RecordedStatement[] = [];
  const record = (sql: string, via: RecordedStatement['via']): void => {
    statements.push({ sql: sql.trim().replace(/\s+/g, ' '), via });
  };

  const wrap = <Row>(sql: string, statement: DbStatement<Row>): DbStatement<Row> => ({
    run: (...parameters: DbValue[]) => {
      record(sql, 'run');
      return statement.run(...parameters);
    },
    get: (...parameters: DbValue[]) => {
      record(sql, 'get');
      return statement.get(...parameters);
    },
    all: (...parameters: DbValue[]) => {
      record(sql, 'all');
      return statement.all(...parameters);
    },
  });

  return {
    get open(): boolean {
      return inner.open;
    },
    get statements(): readonly RecordedStatement[] {
      return statements;
    },
    get writes(): readonly RecordedStatement[] {
      return statements.filter((entry) => isWrite(entry.sql));
    },
    forget(): void {
      statements.length = 0;
    },
    prepare: <Row = Record<string, DbValue>>(sql: string): DbStatement<Row> =>
      wrap(sql, inner.prepare<Row>(sql)),
    exec: (sql: string): void => {
      record(sql, 'exec');
      inner.exec(sql);
    },
    transaction: <T>(fn: () => T): T => inner.transaction(fn),
    pragma: (source: string): unknown => inner.pragma(source),
    close: (): void => {
      inner.close();
    },
  };
}
