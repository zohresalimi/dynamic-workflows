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
