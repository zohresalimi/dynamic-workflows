/**
 * The post-commit emitter (docs/11-api-and-realtime.md §5.2).
 *
 * ```ts
 * const seqs = db.transaction(appendAll)(events); // one transaction
 * bus.emit("committed", seqs);                    // AFTER commit returns
 * ```
 *
 * > If the emitter fires inside the transaction, a stream can read a row that
 * > a subsequent rollback removes, and the client's cursor advances past an
 * > event that does not exist.
 *
 * Two details make this the least clever part of the system, deliberately:
 *
 * - **The notification carries nothing.** The reaction to it is *"drain from
 *   your cursor"*, so it needs no ordering guarantees, a missed one only
 *   delays delivery to the next one (and the stream's own tick bounds that),
 *   and a spurious one costs a bounded query that returns no rows.
 * - **Depth, not `inTransaction`.** This ledger nests its own transactions —
 *   `appendEventsConsumingWakes`, `appendEventsSchedulingWakes` and
 *   `appendEventsWithProcess` each wrap `appendEvents` — and an emitter inside
 *   the inner one would fire while the outer is still open, which is the same
 *   defect one level up. `committing` counts the nesting it can see and emits
 *   as the outermost call returns.
 *
 * What it cannot see is a caller's *own* `db.transaction(...)` wrapped around
 * an append. There, the emit happens before that caller commits or rolls back,
 * and it is harmless in both directions: a reader on another connection cannot
 * see uncommitted rows, so the drain it provokes finds nothing and no cursor
 * moves. The rollback scenario in EPIC-15-S22 is exactly that case, asserted
 * from the client's side.
 *
 * In-process only, and that is honest rather than a limitation being hidden:
 * a writer in another process cannot notify this one, which is why the serving
 * loop keeps a bounded re-drain tick as its floor and treats this as the
 * latency optimisation it is.
 */
import type { Db } from '@DeFlow/core';

type Listener = () => void;

const listeners = new Set<Listener>();

/**
 * How many `committing` calls are on the stack. Module-level rather than
 * per-`Db` because there is exactly one write connection per process — the
 * writer registry in ./sqlite-db.ts is what enforces that — and because a
 * count that lived on the connection would have to be part of the `Db` port,
 * which exists to be five methods wide.
 */
let depth = 0;

/**
 * Registers `listener`, called after each committed batch. Returns the
 * unsubscribe, and a caller that closes without calling it leaves the daemon
 * waking a socket that has gone.
 */
export function onCommitted(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Runs `work` in a transaction and notifies **after** the outermost one
 * returns.
 *
 * A listener that throws is swallowed: one stream failing to be woken must not
 * fail the append that woke it, and must not stop the other streams being
 * woken either.
 */
export function committing<T>(db: Db, work: () => T): T {
  depth += 1;
  let result: T;
  try {
    result = db.transaction(work);
  } finally {
    depth -= 1;
  }
  if (depth === 0) emit();
  return result;
}

function emit(): void {
  // A copy, because a listener may unsubscribe itself as it runs — a stream
  // that notices its socket has gone does exactly that — and mutating the Set
  // mid-iteration would skip its neighbour.
  const snapshot = Array.from(listeners);
  for (const listener of snapshot) {
    try {
      listener();
    } catch {
      // Deliberately silent: see above. A wake-up nobody could receive is not
      // a reason to refuse a batch that is already on disk.
    }
  }
}
