/**
 * KAR-10.3 — RFC 6902 as a schema, so the ledger and the UI mean the same thing
 * by "what changed".
 *
 * The schema is here and the **differ is not**: R1 keeps `zod` as
 * `@DeFlow/core`'s single dependency, so `rfc6902@5.3.0` — the library
 * docs/02-tech-stack.md §4 pins, and deliberately not `fast-json-patch`, which
 * last shipped in 2022 — is called from `@DeFlow/daemon` (`spec/amend.ts`).
 * Core owns what a patch *is*; the daemon owns computing one. It is the same
 * differ docs/11-api-and-realtime.md §7.4 puts behind the plan-evolution
 * scrubber, so a spec history and a plan history render through one component
 * rather than two that agree by accident.
 *
 * The schema exists because the patch travels **in an event payload**. A ledger
 * is append-only, so a malformed operation cannot be repaired later; it is
 * refused at the boundary like every other payload, and `path` is required to be
 * a JSON Pointer rather than "a string" so that a patch nobody can apply cannot
 * be written in the first place.
 */
import { z } from 'zod';

/** A JSON Pointer (RFC 6901): empty, or a sequence of `/`-prefixed tokens. */
const PointerSchema = z
  .string()
  .regex(/^(\/(([^/~])|(~[01]))*)*$/, 'must be an RFC 6901 JSON Pointer');

/**
 * RFC 6902 §4's six operations, as a discriminated union.
 *
 * `value` is `z.unknown()` and not `z.any()`: the operation's payload is
 * whatever the document holds, and the point of the union is the *shape* of the
 * operation — which member carries `from`, which carries `value` — because that
 * is what a wrong operation gets wrong.
 */
export const JsonPatchOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('add'), path: PointerSchema, value: z.unknown() }),
  z.strictObject({ op: z.literal('remove'), path: PointerSchema }),
  z.strictObject({ op: z.literal('replace'), path: PointerSchema, value: z.unknown() }),
  z.strictObject({ op: z.literal('move'), path: PointerSchema, from: PointerSchema }),
  z.strictObject({ op: z.literal('copy'), path: PointerSchema, from: PointerSchema }),
  z.strictObject({ op: z.literal('test'), path: PointerSchema, value: z.unknown() }),
]);

export type JsonPatchOperation = z.infer<typeof JsonPatchOperationSchema>;
