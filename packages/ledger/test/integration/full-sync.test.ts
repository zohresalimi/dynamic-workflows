/**
 * KAR-03.1 — `withFullSync`, the escape hatch for the one transaction that
 * records a genuinely irreversible external effect.
 *
 * On darwin this has to raise `fullfsync` as well as `synchronous`, and that is
 * not a detail: spike S5 measured that macOS's `fsync(2)` does not flush the
 * drive's write cache, so `synchronous = FULL` at the platform default
 * `fullfsync = 0` costs 3.3x and buys nothing extra against power loss. Without
 * the second pragma this function is decoration.
 *
 * Verifies: EPIC-03-S25 (scenario 3) · AC8
 */

import { it } from '@DeFlow/testkit';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { openWrite, withFullSync } from '../../src/index.ts';

const FULL = 2;
const NORMAL = 1;

const openFixture = (tmp: string) => {
  const db = openWrite(join(tmp, 'ledger.db'));
  db.exec('CREATE TABLE effect (ikey TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT');
  return db;
};

suite('withFullSync (EPIC-03-S25 scenario 3, AC8)', () => {
  it('runs the callback with synchronous = FULL', ({ tmp }) => {
    const db = openFixture(tmp);
    try {
      expect(db.pragma('synchronous')).toBe(NORMAL);
      const inside = withFullSync(db, () => db.pragma('synchronous'));
      expect(inside).toBe(FULL);
    } finally {
      db.close();
    }
  });

  it('restores NORMAL afterwards', ({ tmp }) => {
    const db = openFixture(tmp);
    try {
      withFullSync(db, () => {
        db.prepare('INSERT INTO effect (ikey, state) VALUES (?, ?)').run('run_x/n1/1/0', 'done');
      });
      expect(db.pragma('synchronous')).toBe(NORMAL);
    } finally {
      db.close();
    }
  });

  it('restores NORMAL when the transaction throws, and rolls the write back', ({ tmp }) => {
    const db = openFixture(tmp);
    try {
      expect(() =>
        withFullSync(db, () => {
          db.prepare('INSERT INTO effect (ikey, state) VALUES (?, ?)').run('run_x/n1/1/0', 'done');
          throw new Error('the irreversible effect failed');
        }),
      ).toThrow('the irreversible effect failed');

      expect(db.pragma('synchronous')).toBe(NORMAL);
      expect(db.prepare<{ n: number }>('SELECT count(*) AS n FROM effect').get()).toEqual({ n: 0 });
    } finally {
      db.close();
    }
  });

  it('commits the write when the callback returns, and returns its value', ({ tmp }) => {
    const db = openFixture(tmp);
    try {
      const result = withFullSync(db, () => {
        db.prepare('INSERT INTO effect (ikey, state) VALUES (?, ?)').run('run_x/n1/1/0', 'done');
        return 'published';
      });
      expect(result).toBe('published');
      expect(db.prepare<{ n: number }>('SELECT count(*) AS n FROM effect').get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it.runIf(process.platform === 'darwin')(
    'also raises fullfsync on darwin, where FULL is otherwise not a barrier',
    ({ tmp }) => {
      const db = openFixture(tmp);
      try {
        expect(db.pragma('fullfsync')).toBe(0);
        expect(withFullSync(db, () => db.pragma('fullfsync'))).toBe(1);
        expect(db.pragma('fullfsync')).toBe(0);
      } finally {
        db.close();
      }
    },
  );
});
