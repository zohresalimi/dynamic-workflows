/**
 * KAR-10.3 AC5 — the differ behind `spec.amended`.
 *
 * It lives in `@DeFlow/daemon` and not beside the rest of the gate's domain
 * logic for one structural reason: R1 keeps `zod` as `@DeFlow/core`'s single
 * runtime dependency, and `rfc6902@5.3.0` is a dependency. So core owns *what a
 * patch is* (`JsonPatchOperationSchema`) and *what is diffed*
 * (`hashableSpec` — the form `specHash` is over, excluding `specHash` and
 * `approvedBy`), and this file owns the one call that computes one.
 *
 * `rfc6902`, never `fast-json-patch`: that package last shipped in 2022
 * (docs/02-tech-stack.md §4). It is the same differ the plan-evolution scrubber
 * uses (docs/11-api-and-realtime.md §7.4), which is what lets the spec history
 * and the plan history render through one component.
 *
 * Verifies: EPIC-10-S14 · AC5
 */
import type { SpecAmendment, TaskSpec } from '@DeFlow/core';
import {
  emptyEditRefusal,
  hashableSpec,
  type JsonPatchOperation,
  sealEditedSpec,
  type TaskSpecDraft,
} from '@DeFlow/core';
import { createPatch } from 'rfc6902';

/**
 * An operator edit, as a patch and a new identity.
 *
 * Throws `SpecEditRefused` for an edit the criteria contract rejects — with the
 * framing interview's own message text, because `sealEditedSpec` runs the same
 * `validateTaskSpecDraft` the framing node is held to — and for an edit that
 * changes nothing, which would otherwise write a `spec.amended` row saying so.
 * Throwing rather than returning a failure is deliberate here and the opposite
 * of `enforceHandoff`'s convention: nothing retries an operator, the gate stays
 * open, and the caller's only job is to put the message in front of them.
 */
export async function amendSpec(previous: TaskSpec, edited: unknown): Promise<SpecAmendment> {
  const spec = await sealEditedSpec(edited);
  const patch = createPatch(
    hashableSpec(previous),
    hashableSpec(spec),
  ) as readonly JsonPatchOperation[];
  if (patch.length === 0) throw emptyEditRefusal();

  return {
    from: previous.specHash,
    to: spec.specHash,
    patch,
    document: edited as TaskSpecDraft,
    spec,
  };
}
