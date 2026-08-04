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
