/**
 * KAR-02.1 — `RunId` minting.
 *
 * Both inputs are injected rather than read from the ambient environment
 * (NF9, docs/16-repo-layout.md R1): time comes in as a plain millisecond
 * epoch — callers pass `clock.now()` — and randomness comes in as a factory,
 * because `@DeFlow/core` may depend on nothing capable of I/O, including
 * `node:crypto`. The daemon supplies a real random-hex source; `@DeFlow/testkit`
 * supplies a deterministic one.
 *
 * Verifies: EPIC-02-S5 · AC2
 */

import type { RunId } from './ids.ts';
import { RunIdSchema } from './ids.ts';

/** `YYYYMMDDTHHMMSSZ`, formatted from a given epoch millisecond — pure, no
 * clock read of its own. */
function formatTimestamp(epochMs: number): string {
  const iso = new Date(epochMs).toISOString(); // e.g. 2026-08-02T14:11:33.123Z
  const date = iso.slice(0, 10).replace(/-/g, '');
  const time = iso.slice(11, 19).replace(/:/g, '');
  return `${date}T${time}Z`;
}

/**
 * Mints a `RunId` of the form `run_<YYYYMMDDTHHMMSSZ>_<6 lowercase hex>`.
 *
 * @param now Milliseconds since the Unix epoch, from the injected `Clock`
 *   port — never read internally.
 * @param randomHex Produces the 6-lowercase-hex-character suffix. Must be
 *   injected; this function performs no randomness of its own.
 */
export function mintRunId(now: number, randomHex: () => string): RunId {
  const candidate = `run_${formatTimestamp(now)}_${randomHex()}`;
  return RunIdSchema.parse(candidate);
}
