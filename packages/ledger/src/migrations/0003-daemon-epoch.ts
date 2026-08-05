/**
 * Migration 0003 — `daemon.epoch`, the persisted fencing counter
 * (docs/05-durable-execution.md §12, KAR-03.7 AC4).
 *
 * One row, for ever: `id` is pinned to 1 by a CHECK constraint, so "the
 * current epoch" is a value the schema itself cannot hold two of. It lives in
 * `ledger.db` rather than beside the lock file because the append boundary
 * compares against it **inside the transaction that inserts the rows** — a
 * counter in another file could not be read under the same write lock, and a
 * fence that can be raced is not a fence.
 *
 * It starts at 0, which is the value no daemon life ever stamps: `bumpEpoch`
 * increments before it returns, so the first daemon writes epoch 1. That
 * leaves 0 meaning exactly one thing — a ledger no daemon has booted against
 * yet — and it is also the `event.epoch` default migration 0002 had to give
 * the column, so a row carrying 0 is visibly a row nothing wrote.
 */
import type { Migration } from '../migrate.ts';

export const migration0003DaemonEpoch: Migration = {
  id: 3,
  name: 'daemon-epoch',
  up(db) {
    db.exec(`
      CREATE TABLE daemon (
        id    INTEGER PRIMARY KEY CHECK (id = 1),
        epoch INTEGER NOT NULL
      ) STRICT
    `);
    db.exec('INSERT INTO daemon (id, epoch) VALUES (1, 0)');
  },
};
