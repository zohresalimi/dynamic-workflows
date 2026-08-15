/**
 * KAR-22.1 — `ProjectId` minting.
 *
 * A deliberate near-copy of ./run-id.ts rather than a shared helper with a
 * prefix parameter: the two id vocabularies are independent, and a generic
 * `mintId(prefix, …)` would make a future change to one shape a change to both
 * — which is precisely the kind of accidental coupling `NodeId`'s own stability
 * rules exist to prevent. Twelve lines of duplication is the cheaper of the two.
 *
 * Both inputs are injected for the same reason `mintRunId` injects them
 * (NF9, docs/16-repo-layout.md R1): time arrives as a plain millisecond epoch
 * from the caller's `Clock`, and randomness as a factory, because `@DeFlow/core`
 * may depend on nothing capable of I/O — including `node:crypto`.
 *
 * Verifies: EPIC-22-S1 · KAR-22.1 AC1
 */

import type { ProjectId } from './ids.ts';
import { ProjectIdSchema } from './ids.ts';

/** `YYYYMMDDTHHMMSSZ` from a given epoch millisecond — pure, no clock read. */
function formatTimestamp(epochMs: number): string {
  const iso = new Date(epochMs).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}T${iso.slice(11, 19).replace(/:/g, '')}Z`;
}

/**
 * Mints a `ProjectId` of the form `prj_<YYYYMMDDTHHMMSSZ>_<6 lowercase hex>`.
 *
 * @param now Milliseconds since the Unix epoch, from the injected `Clock` port.
 * @param randomHex Produces the 6-lowercase-hex suffix. Must be injected.
 */
export function mintProjectId(now: number, randomHex: () => string): ProjectId {
  return ProjectIdSchema.parse(`prj_${formatTimestamp(now)}_${randomHex()}`);
}
