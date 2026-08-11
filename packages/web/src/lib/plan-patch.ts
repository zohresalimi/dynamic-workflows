/**
 * KAR-17.2 — the field-level "why did this change" panel
 * (docs/12-frontend-architecture.md §6.2).
 *
 * Verifies: EPIC-17-S8 · AC5
 *
 * AC5 pairs two things that answer different questions, and the pairing is what
 * makes the panel diagnostic rather than decorative: the human `reason` off the
 * `plan.patched` event says what the planner *intended*, and the RFC 6902 patch
 * says what actually *moved*. The two disagreeing is itself a finding.
 *
 * This module owns the second half. It never computes a patch — the diff
 * endpoint does that with `rfc6902`'s `createPatch` over the two node documents
 * (`@DeFlow/daemon`'s `plan/diff.ts`) — it renders one. What it adds is the one
 * reading the patch policy cares about: **a permission escalation, called out
 * distinctly**, because escalating a node's permission is precisely what F2.5's
 * rule table gates a patch on, and a widened blast radius buried as the fourth
 * line of a six-line patch is a widened blast radius nobody saw.
 *
 * `rfc6902@^5.3.0`, never `fast-json-patch`, which last shipped in 2022
 * (docs/02-tech-stack.md §4). Only the `Operation` *type* is imported here; the
 * value side of the library is the daemon's.
 */
import { PERMISSION_LEVELS } from '@DeFlow/core';

/**
 * One RFC 6902 operation, **as it arrives over the wire**.
 *
 * Structural rather than `rfc6902`'s own `Operation`, and that is a layering
 * decision rather than a shortcut. The patch is *produced* by the daemon —
 * `packages/daemon/src/plan/diff.ts` runs `createPatch` from `rfc6902@^5.3.0`,
 * and `packages/daemon/src/plan/diff.test.ts` is where that choice is asserted.
 * What reaches this tab is JSON off `GET /api/runs/:id/plans/diff`, so what
 * this module needs is the shape of that JSON. Depending on the library to
 * describe a wire format would put a second copy of the producer's version
 * constraint in the frontend, where nothing would ever notice the two drifting.
 *
 * RFC 6902 §4: `op` and `path` are on every operation; `value` is on `add`,
 * `replace` and `test`; `from` is on `move` and `copy`.
 */
export interface JsonPatchOperation {
  readonly op: string;
  readonly path: string;
  readonly value?: unknown;
  readonly from?: string;
}

/** One operation, as the panel renders it. */
export interface PatchLineVM {
  /** RFC 6902's verb: `add`, `remove`, `replace`, `move`, `copy`, `test`. */
  readonly op: string;
  /** The JSON Pointer into the node document, verbatim. */
  readonly path: string;
  /** The operation's value, for the ops that carry one. `undefined` otherwise. */
  readonly value: unknown;
  /** The operation as JSON — what AC5 shows an operator being shown. */
  readonly text: string;
  /** This line is the permission escalation `escalationIn` found. */
  readonly escalates: boolean;
}

export interface PermissionEscalation {
  readonly from: string;
  readonly to: string;
}

/** The permission path in a `PlanNode` document. One place, so the two functions
 * below cannot come to disagree about which pointer means permission. */
const PERMISSION_PATH = '/permission';

const rankOf = (level: string): number => (PERMISSION_LEVELS as readonly string[]).indexOf(level);

/**
 * The operations, ready to render.
 *
 * `before` is the node's permission in the *older* version, and it is a
 * parameter rather than something read out of the patch because a `replace`
 * carries only where it landed. Omit it and no line is marked — which is the
 * right default for a caller that is rendering a patch without the pair it came
 * from.
 */
export function describeOperations(
  operations: readonly JsonPatchOperation[],
  before?: string | null,
): readonly PatchLineVM[] {
  const escalation = before === undefined ? null : escalationIn(operations, before);

  return operations.map((operation) => {
    const value = (operation as { value?: unknown }).value;
    return {
      op: operation.op,
      path: operation.path,
      value,
      // Two-space JSON, because the acceptance criterion's example is a JSON
      // object and because a one-line `JSON.stringify` of a `reads[]` operation
      // is a hundred characters of unreadable pointer soup.
      text: JSON.stringify(operation, null, 2),
      escalates: escalation !== null && operation.path === PERMISSION_PATH,
    };
  });
}

/**
 * The permission escalation in `operations`, or `null`.
 *
 * Only *up* the ladder. Narrowing a node's permission is not what F2.5 gates on,
 * and marking it would train an operator to ignore the marker — which costs
 * exactly the escalation the marker exists for.
 *
 * A level neither `PERMISSION_LEVELS` knows is `-1` on both sides, which
 * compares as "not an escalation": an unknown permission is not evidence of a
 * widening, and guessing in this direction is the guess that fails open.
 */
export function escalationIn(
  operations: readonly JsonPatchOperation[],
  before: string | null | undefined,
): PermissionEscalation | null {
  if (before === null || before === undefined) return null;

  for (const operation of operations) {
    if (operation.path !== PERMISSION_PATH) continue;
    const to = (operation as { value?: unknown }).value;
    if (typeof to !== 'string') continue;
    if (rankOf(before) < 0 || rankOf(to) < 0) continue;
    if (rankOf(to) > rankOf(before)) return { from: before, to };
  }
  return null;
}
