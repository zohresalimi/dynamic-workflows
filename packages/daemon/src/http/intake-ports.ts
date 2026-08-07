/**
 * The module-level registry `POST /api/runs` reads its write-side ports
 * through — the same pattern as `../runtime.ts` and `./ledger-view.ts`, and
 * for the same reason: `api.ts` is a module-level `Hono` app, `boot.ts` is
 * what owns the data directory and the write connection, and there is exactly
 * one daemon per process (the lease in `boot.ts` enforces it), so a setter
 * called once at boot is the honest cardinality rather than a parameter
 * threaded through every route.
 */
import type { RunIntakePorts } from '../intake/intake.ts';

let ports: RunIntakePorts | null = null;

/** Called once, by boot, with the ports `submitTask` needs to write. */
export function setIntakePorts(next: RunIntakePorts): void {
  ports = next;
}

/** Called on shutdown, so a route cannot write through a closed connection. */
export function clearIntakePorts(): void {
  ports = null;
}

/**
 * The ports, or `null` before boot has registered them — which a client can
 * only observe in a test that starts the HTTP server without booting a
 * daemon around it. The route answers that with a 503, never a crash.
 */
export function intakePorts(): RunIntakePorts | null {
  return ports;
}
