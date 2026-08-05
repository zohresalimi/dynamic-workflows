/**
 * KAR-03.7 — `daemon_epoch`: the belt to `flock`'s braces
 * (docs/05-durable-execution.md §12).
 *
 * The lease stops a second DeFlowd from starting. The epoch covers the cases
 * where it cannot: a stale lock file on a network mount, a debugger-suspended
 * process, a container restart that inherited the file. One counter, bumped
 * once per daemon life, stamped on every write, and compared at the append
 * boundary — a daemon that has been superseded cannot put a row in the ledger,
 * whatever it believes about the lock.
 *
 * Two properties matter, and both are structural:
 *
 * 1. **The bump is one statement.** `UPDATE … SET epoch = epoch + 1 RETURNING
 *    epoch` reads, increments and persists in a single write, so there is no
 *    window between reading and writing for a crash — or for a second daemon —
 *    to occupy. A read followed by a write would pass every sequential test
 *    and still hand two daemon lives the same number under a race, which
 *    silently defeats the fence.
 * 2. **The comparison happens inside the append transaction.** `appendEvents`
 *    reads the persisted epoch after `BEGIN IMMEDIATE` has taken the write
 *    lock, so no other connection can advance it between the check and the
 *    insert. Caching the epoch at boot instead would fence nothing: the whole
 *    point is that the *other* daemon moved it.
 */
import type { Db } from '@DeFlow/core';

/**
 * A write from a daemon that has been superseded (AC5).
 *
 * Names both numbers, because "stale epoch" without them is a sentence nobody
 * can act on. The writer does not retry: a lower epoch is not a transient
 * condition — it means this process has been replaced and every write it has
 * left to make is one the ledger does not want.
 */
export class StaleEpoch extends Error {
  /** Position in the batch. The batch is atomic, so nothing was written. */
  readonly index: number;
  /** The epoch the refused event carried. */
  readonly epoch: number;
  /** The epoch persisted in the ledger — a later daemon's. */
  readonly currentEpoch: number;

  constructor(index: number, epoch: number, currentEpoch: number) {
    super(
      `event ${index} of this batch carries daemon epoch ${epoch}, but this ledger's current ` +
        `epoch is ${currentEpoch}: a later DeFlowd has taken over, so none of the batch was ` +
        'appended. Do not retry — a stale epoch is not a transient failure. This process lost ' +
        'the single-instance lease (or never held it) and should stop writing.',
    );
    this.name = 'StaleEpoch';
    this.index = index;
    this.epoch = epoch;
    this.currentEpoch = currentEpoch;
  }
}

const SELECT_EPOCH = 'SELECT epoch FROM daemon WHERE id = ?';
const BUMP_EPOCH = 'UPDATE daemon SET epoch = epoch + 1 WHERE id = 1 RETURNING epoch';

/** The one row's id. There is exactly one, and the schema enforces it. */
const ROW = 1;

/**
 * The epoch persisted in this ledger. 0 means no daemon has booted against it.
 *
 * Read fresh every time it is needed, never cached: a cached epoch is the
 * epoch of the daemon doing the caching, which is precisely the value the
 * fence must not trust.
 */
export function readEpoch(db: Db): number {
  const row = db.prepare<{ epoch: number }>(SELECT_EPOCH).get(ROW);
  if (row === undefined) {
    throw new Error(
      'this ledger has no daemon epoch row. Migration 0003 creates it, so a ledger without one ' +
        'was opened without migrating — call openLedger rather than openWrite.',
    );
  }
  return row.epoch;
}

/**
 * Takes the next epoch for this daemon life: reads, increments and persists in
 * one statement inside one immediate transaction, and returns what was
 * persisted.
 *
 * Called exactly once per DeFlowd start, at boot, right after the lease.
 * Every event this daemon appends carries the number it returns.
 */
export function bumpEpoch(db: Db): number {
  return db.transaction(() => {
    const row = db.prepare<{ epoch: number }>(BUMP_EPOCH).get();
    if (row === undefined) {
      throw new Error(
        'UPDATE daemon SET epoch = epoch + 1 RETURNING epoch matched no row. Migration 0003 ' +
          'inserts it, so this ledger was opened without migrating — call openLedger.',
      );
    }
    return row.epoch;
  });
}
