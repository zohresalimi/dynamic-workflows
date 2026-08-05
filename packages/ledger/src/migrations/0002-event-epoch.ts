/**
 * Migration 0002 — `event.epoch`, the fencing stamp
 * (docs/05-durable-execution.md §12, KAR-03.3 AC6).
 *
 * Every appended event carries the daemon epoch that wrote it, so a write from
 * a superseded daemon is rejectable by looking at the row itself and nothing
 * else. KAR-03.7 is what bumps the epoch at boot and rejects a stale one; this
 * migration is only the column, added here because the append path (KAR-03.3)
 * must never be able to write a row without it.
 *
 * `DEFAULT 0` exists because SQLite requires a non-null default when a NOT NULL
 * column is added to an existing table, and for no other reason: `appendEvents`
 * always binds the epoch explicitly, so 0 is a value no row this code writes
 * can ever hold. Migration 0001 is shipped and never edited — this file is the
 * roll-forward.
 */
import type { Migration } from '../migrate.ts';

export const migration0002EventEpoch: Migration = {
  id: 2,
  name: 'event-epoch',
  up(db) {
    db.exec('ALTER TABLE event ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0');
  },
};
