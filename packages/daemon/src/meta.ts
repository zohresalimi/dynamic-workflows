/**
 * Identity of one daemon life.
 *
 * `bootId` is generated once per process, which is what makes a restart
 * observable from outside: `pnpm dev` kills and restarts DeFlowd on every save
 * (D10), and "did it actually come back, or am I talking to the old process?"
 * is a question the dev loop has to be able to answer.
 *
 * `daemonEpoch` and `headSeq` are part of the documented `/api/health` body
 * (docs/11-api-and-realtime.md §12) but are owned by the ledger rather than by
 * this file. Since KAR-03.7 the epoch is real: `boot` takes it and publishes it
 * through `runtime.ts`. `headSeq` waits for the ledger tail (KAR-03.8) and is
 * reported as null until then rather than invented here.
 */
import './env.ts'; // side effect: populates process.env before DeFlow_BUILD is read
import { randomUUID } from 'node:crypto';

export const API_VERSION = 1;

/** Unique to this process. A new value means the daemon restarted. */
export const BOOT_ID: string = randomUUID();

export const BUILD: string = process.env.DeFlow_BUILD ?? '0.0.0-dev';

const bootedAt = performance.now();

export function uptimeMs(): number {
  return Math.round(performance.now() - bootedAt);
}
