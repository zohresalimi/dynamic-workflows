/**
 * The `Db` contract suite — one set of assertions, run against every
 * implementation of the port (KAR-03.1 test plan row 7).
 *
 * A port is only substitutable if something checks that the substitutes agree,
 * and "it compiles" is not that check: `prepare()` returning a driver type
 * still compiles for the driver. So this suite is exported rather than written
 * twice, and both the real better-sqlite3 adapter in @DeFlow/ledger and the
 * `FakeDb` next door run it verbatim.
 *
 * It deliberately stays inside a very small SQL subset. The point is the shape
 * of the port — prepare/exec/transaction/pragma/close, and what each returns —
 * not SQLite's dialect, which only one of the two implementations could ever
 * claim to speak.
 */

import type { Db } from '@DeFlow/core';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { it } from './fixtures.ts';

const CREATE_CONTRACT =
  'CREATE TABLE contract (seq INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL) STRICT';
const INSERT_RETURNING = 'INSERT INTO contract (label) VALUES (?) RETURNING seq';
const INSERT = 'INSERT INTO contract (label) VALUES (?)';
const SELECT_ALL = 'SELECT seq, label FROM contract ORDER BY seq';
const SELECT_ONE = 'SELECT seq, label FROM contract WHERE seq = ?';
const DELETE_ONE = 'DELETE FROM contract WHERE seq = ?';

interface ContractRow {
  readonly seq: number;
  readonly label: string;
}

/**
 * Registers the contract suite for one implementation.
 *
 * `open` receives a path inside a per-test temp directory. An implementation
 * that keeps no file is free to ignore it.
 */
export function dbContract(label: string, open: (file: string) => Db): void {
  suite(`Db contract — ${label}`, () => {
    const live: Db[] = [];

    // Closing twice is part of the contract (see the last spec), so this
    // teardown running after a spec that already closed is deliberate.
    afterEach(() => {
      for (const db of live.splice(0)) db.close();
    });

    const openContract = (tmp: string): Db => {
      const db = open(join(tmp, 'contract.db'));
      live.push(db);
      db.exec(CREATE_CONTRACT);
      return db;
    };

    it('reports itself open until it is closed', ({ tmp }) => {
      const db = openContract(tmp);
      expect(db.open).toBe(true);
      db.close();
      expect(db.open).toBe(false);
    });

    it('closing twice is a no-op rather than an error', ({ tmp }) => {
      const db = openContract(tmp);
      db.close();
      expect(() => db.close()).not.toThrow();
    });

    it('hands back the assigned key from INSERT … RETURNING', ({ tmp }) => {
      const db = openContract(tmp);
      const insert = db.prepare<ContractRow>(INSERT_RETURNING);
      const seqs = ['first', 'second', 'third'].map((text) => insert.get(text)?.seq);
      expect(seqs).toEqual([1, 2, 3]);
    });

    it('reuses one prepared statement across calls', ({ tmp }) => {
      const db = openContract(tmp);
      const insert = db.prepare(INSERT);
      expect(insert.run('first').changes).toBe(1);
      expect(insert.run('second').changes).toBe(1);
      expect(db.prepare<ContractRow>(SELECT_ALL).all()).toHaveLength(2);
    });

    it('returns rows in key order from all()', ({ tmp }) => {
      const db = openContract(tmp);
      const insert = db.prepare(INSERT);
      for (const text of ['first', 'second', 'third']) insert.run(text);
      expect(db.prepare<ContractRow>(SELECT_ALL).all()).toEqual([
        { seq: 1, label: 'first' },
        { seq: 2, label: 'second' },
        { seq: 3, label: 'third' },
      ]);
    });

    it('returns undefined from get() when nothing matches', ({ tmp }) => {
      const db = openContract(tmp);
      db.prepare(INSERT).run('first');
      const select = db.prepare<ContractRow>(SELECT_ONE);
      expect(select.get(1)).toEqual({ seq: 1, label: 'first' });
      expect(select.get(99)).toBeUndefined();
    });

    it('reports how many rows a delete changed', ({ tmp }) => {
      const db = openContract(tmp);
      const insert = db.prepare(INSERT);
      for (const text of ['first', 'second']) insert.run(text);
      expect(db.prepare(DELETE_ONE).run(1).changes).toBe(1);
      expect(db.prepare(DELETE_ONE).run(99).changes).toBe(0);
      expect(db.prepare<ContractRow>(SELECT_ALL).all()).toEqual([{ seq: 2, label: 'second' }]);
    });

    it('never reissues a key that a delete freed', ({ tmp }) => {
      // The port has to carry AUTOINCREMENT's high-water mark, not a bare
      // rowid: `seq` is an identity outside the database — an SSE frame id, a
      // checkpoint offset, a cursor a browser tab persisted.
      const db = openContract(tmp);
      const insert = db.prepare<ContractRow>(INSERT_RETURNING);
      for (const text of ['first', 'second', 'third']) insert.get(text);
      db.prepare(DELETE_ONE).run(3);
      expect(insert.get('fourth')?.seq).toBe(4);
    });

    it('returns the callback value from transaction() and commits its writes', ({ tmp }) => {
      const db = openContract(tmp);
      const returned = db.transaction(() => {
        db.prepare(INSERT).run('inside');
        return 'the callback value';
      });
      expect(returned).toBe('the callback value');
      expect(db.prepare<ContractRow>(SELECT_ALL).all()).toHaveLength(1);
    });

    it('rolls a transaction back when the callback throws, and rethrows', ({ tmp }) => {
      const db = openContract(tmp);
      db.prepare(INSERT).run('before');
      expect(() =>
        db.transaction(() => {
          db.prepare(INSERT).run('doomed');
          throw new Error('the callback failed');
        }),
      ).toThrow('the callback failed');
      expect(db.prepare<ContractRow>(SELECT_ALL).all()).toEqual([{ seq: 1, label: 'before' }]);
    });

    it('round-trips a pragma value', ({ tmp }) => {
      const db = openContract(tmp);
      db.pragma('busy_timeout = 5000');
      expect(db.pragma('busy_timeout')).toBe(5000);
    });
  });
}
