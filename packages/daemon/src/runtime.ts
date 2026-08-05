/**
 * The handful of facts `/api/health` and the `hello` frame report about the
 * running daemon, set once at boot (docs/11-api-and-realtime.md §12).
 *
 * A module-level value rather than a parameter threaded through Hono because
 * the alternative is passing a context object into every route for two
 * numbers, and because there is exactly one daemon per process by
 * construction — that is what the lease in `boot.ts` enforces.
 *
 * It imports nothing, which is the point: `api.ts` reads it and `boot.ts`
 * writes it, and neither has to import the other.
 */

let epoch: number | null = null;

/** Called once, by boot, with the epoch this daemon life took. */
export function setDaemonEpoch(value: number): void {
  epoch = value;
}

/**
 * This daemon life's epoch, or null before boot has taken one — which a client
 * can only observe in a test that starts the HTTP server on its own.
 *
 * A client watches this across connections: a changed epoch means the daemon
 * it was talking to has been replaced (docs/11-api-and-realtime.md §5).
 */
export function daemonEpoch(): number | null {
  return epoch;
}

let head = 0;

/**
 * Called by boot with the highest `seq` the ledger held when it was replayed
 * (KAR-03.8).
 *
 * An assignment rather than a `Math.max`, for the same reason `setDaemonEpoch`
 * is: this is what *this* daemon life observed at its start, and a value that
 * survived from the previous life would be a number describing a ledger this
 * process has not read.
 */
export function setHeadSeq(value: number): void {
  head = value;
}

/** The ledger's head `seq` as this daemon last observed it; 0 for a fresh one. */
export function headSeq(): number {
  return head;
}
