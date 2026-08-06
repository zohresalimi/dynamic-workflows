/**
 * KAR-02.1 — the effect journal's idempotency key.
 *
 * docs/04-domain-model.md §1.1: the idempotency key is
 * `(runId, nodeId, attempt, ordinal)`. If a node's id changed between the
 * `pending` effect row being written and the daemon restarting, the
 * memoised result would be orphaned and the side effect would run twice —
 * undetectably. `ikey()` is the *only* legal constructor (AC4): there is
 * deliberately no exported schema that parses an arbitrary string into an
 * `IdempotencyKey`, so nothing downstream can fabricate one from a free
 * string and skip the type-safe join of its four validated components.
 *
 * Verifies: EPIC-02-S2 (idempotency-key half) · AC4
 */

import { sha256Hex } from './hash.ts';
import type { IdempotencyKey, NodeId, RunId } from './ids.ts';
import { NodeIdSchema, RunIdSchema } from './ids.ts';

const SEPARATOR = '/';

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer, got ${value}`);
  }
}

/**
 * Builds the idempotency key `<runId>/<nodeId>/<attempt>/<ordinal>`.
 *
 * Safe by construction: `RunId` and `NodeId` are both validated against
 * formats that forbid `/` (§1), so the separator can never be corrupted by
 * one of the components it is meant to delimit.
 */
export function ikey(
  runId: RunId,
  nodeId: NodeId,
  attempt: number,
  ordinal: number,
): IdempotencyKey {
  assertNonNegativeInteger(attempt, 'attempt');
  assertNonNegativeInteger(ordinal, 'ordinal');
  return `${runId}${SEPARATOR}${nodeId}${SEPARATOR}${attempt}${SEPARATOR}${ordinal}` as IdempotencyKey;
}

export interface ParsedIkey {
  runId: RunId;
  nodeId: NodeId;
  attempt: number;
  ordinal: number;
}

const INTEGER_PATTERN = /^\d+$/;

/** Inverts `ikey()`. Throws on anything that isn't exactly four
 * `/`-separated parts with the runId/nodeId segments format-valid and the
 * attempt/ordinal segments non-negative integers — a malformed key is a bug
 * to surface loudly, not a value to coerce. */
export function parseIkey(key: IdempotencyKey): ParsedIkey {
  const parts = key.split(SEPARATOR);
  if (parts.length !== 4) {
    throw new Error(
      `malformed IdempotencyKey (expected runId/nodeId/attempt/ordinal, got ${parts.length} segments): ${key}`,
    );
  }
  const [runIdPart, nodeIdPart, attemptPart, ordinalPart] = parts as [
    string,
    string,
    string,
    string,
  ];

  const runId = RunIdSchema.parse(runIdPart);
  const nodeId = NodeIdSchema.parse(nodeIdPart);

  if (!INTEGER_PATTERN.test(attemptPart)) {
    throw new Error(
      `malformed IdempotencyKey: attempt segment is not a non-negative integer: ${key}`,
    );
  }
  if (!INTEGER_PATTERN.test(ordinalPart)) {
    throw new Error(
      `malformed IdempotencyKey: ordinal segment is not a non-negative integer: ${key}`,
    );
  }

  return { runId, nodeId, attempt: Number(attemptPart), ordinal: Number(ordinalPart) };
}

/**
 * KAR-06.3 AC1 — how many hex characters of the sha256 `shortIkeyHash`
 * returns.
 *
 * Twelve, which is 48 bits. The value is pinned as a constant rather than
 * spelled at each call site because the string it produces is written into a
 * *filename by one daemon life and globbed for by the next* (the atomic file
 * write of docs/05-durable-execution.md §8.3 puts it in a sibling temp name,
 * and reconcile finds the orphan by rebuilding it). Shorten it later and every
 * temp file an older build left behind becomes invisible to the probe that is
 * supposed to clean it up.
 *
 * Forty-eight bits is not chosen for cryptographic collision resistance — the
 * key it stands for is already unique by construction, and the hash only has
 * to separate the effects of one run inside one directory, which is hundreds
 * of names, not billions.
 */
export const IKEY_SHORT_HASH_LENGTH = 12;

/**
 * The `IKEY_SHORT_HASH_LENGTH`-character lowercase hex prefix of the sha256 of
 * `key` — the form used wherever the key has to be embedded in a filename
 * (docs/05-durable-execution.md §8.1).
 *
 * A raw ikey cannot be one: it contains `/`, so `${path}.deflow-${ikey}.tmp`
 * would name a file in a directory that does not exist. Hashing rather than
 * escaping keeps the name a fixed, short, predictable length regardless of how
 * long the run and node ids are, which matters on the filesystems that still
 * cap a path component at 255 bytes.
 */
export async function shortIkeyHash(key: IdempotencyKey): Promise<string> {
  return (await sha256Hex(key)).slice(0, IKEY_SHORT_HASH_LENGTH);
}
