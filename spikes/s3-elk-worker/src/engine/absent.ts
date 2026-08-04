/**
 * The same module surface with ELK taken out, aliased in by
 * `S3_VARIANT=no-elk`. It exists for exactly one reason: AC2 asks for the entry
 * chunk's size "against a build with ELK removed", and the only honest way to
 * remove ELK is to build the same application without it — same fixtures, same
 * DOM rendering, same dynamic dagre import, same everything the entry chunk
 * would otherwise contain.
 *
 * Its type surface is deliberately identical to `./elk.ts`, so the two builds
 * differ in one thing only.
 */
import type { ELK } from 'elkjs/lib/elk-api.js';

export const elkAvailable = false;

export function lastWorkerUrl(): string | null {
  return null;
}

export function createEngine(): ELK {
  throw new Error('this build was made with S3_VARIANT=no-elk; there is no layout engine in it');
}
