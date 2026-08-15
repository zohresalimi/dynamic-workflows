/**
 * KAR-00.10 — the regression, built on purpose.
 *
 * This is the same module surface again, aliased in by
 * `S3_VARIANT=main-thread`, with the one change that matters: ELK arrives as
 * `elkjs/lib/elk.bundled.js`, a plain static import, rather than as
 * `elk-worker.min.js?worker` behind `workerFactory`. So there is no worker
 * entry for Vite to split out, nothing to hash, and 1.6 MB of GWT-transpiled
 * Java is statically reachable from `main.ts` — which is to say, it lands in
 * the entry chunk and in the first paint's critical path.
 *
 * `docs/spikes/S3-elk-worker.md` names that as the failure mode the AC2
 * measurement rules out. It was named and never built, and a budget nobody has
 * watched go red is a budget nobody knows is connected to anything. This module
 * is the thing that makes it observable: the integration slice builds this
 * variant and asserts that every dimension of `budgetViolations` fires on it.
 *
 * It is never served, never loaded in a browser and never shipped. Its output
 * directory (`dist-main-thread/`) is gitignored with the other two.
 */
import ElkConstructor, { type ELK } from 'elkjs/lib/elk.bundled.js';

export const elkAvailable = true;

export function lastWorkerUrl(): string | null {
  return null;
}

export function createEngine(): ELK {
  return new ElkConstructor();
}
