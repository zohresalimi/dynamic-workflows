/**
 * KAR-12.2 AC6, AC7 — sealing an adversarial verdict with how its reviewer was
 * routed.
 *
 * `sealVerdict` (./verdict-of.ts) is the deterministic tier's: it *composes* a
 * verdict from a process's exit code and parsed findings. This is the
 * adversarial tier's, and it composes nothing — the reviewer returned a whole
 * document and DeFlow adds one field to it.
 *
 * **Why `weakened` is added here rather than returned by the reviewer.** The
 * `.v3` document is what a vendor CLI is handed on `--json-schema`, and it has
 * no `weakened` field on purpose: the marker records a scheduling decision, and
 * a model asked to fill it in would be stating that its own review was not
 * weakened. That is the one claim in the document only the scheduler is in a
 * position to make, so the field is overwritten rather than merged — a value
 * that arrived some other way (a prompt-only adapter, a creative reviewer) is
 * discarded rather than trusted.
 *
 * `by.provider` follows for the same reason. A verdict names the provider it
 * ran on; the reviewer's own belief about which vendor it is has no standing
 * against the routing decision that spawned it.
 *
 * Verifies: EPIC-12-S11, EPIC-12-S14 · AC6, AC7
 */
import {
  type ProviderId,
  SchemaIdSchema,
  VERDICT_V4_SCHEMA_ID,
  type VerdictV3,
  type VerdictV4,
  VerdictV4Schema,
  type VerdictWeakening,
} from '@DeFlow/core';

/** The routing decision this verdict was produced under —
 * `pickReviewer`'s `routed` arm, narrowed to what the seal needs. */
export interface ReviewRouting {
  readonly provider: ProviderId;
  /** Absent unless something was given up. Present, it is stamped verbatim. */
  readonly weakened?: VerdictWeakening;
}

/**
 * The reviewer's document, sealed as a `DeFlow.verdict.v4`.
 *
 * Validated on the way out rather than trusted: a malformed verdict is refused
 * here, where the failure is *this reviewer returned something invalid*, and
 * not three projections later where it is a board row that renders wrong.
 */
export function sealReviewVerdict(returned: VerdictV3, routing: ReviewRouting): VerdictV4 {
  const { weakened: _reviewerClaim, ...rest } = returned as VerdictV3 & {
    weakened?: unknown;
  };

  return VerdictV4Schema.parse({
    ...rest,
    schemaId: SchemaIdSchema.parse(VERDICT_V4_SCHEMA_ID),
    by: { ...returned.by, provider: routing.provider },
    ...(routing.weakened === undefined ? {} : { weakened: routing.weakened }),
  });
}
