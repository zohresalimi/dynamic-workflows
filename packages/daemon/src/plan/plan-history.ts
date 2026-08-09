/**
 * KAR-11.5 AC3, AC4, AC5 — the two pure pieces of `GET /api/runs/:id/plans/diff`
 * that `../plan/diff.ts`'s own docstring reserves for this story: *"the
 * unionLayoutKey and the reason/decision join are KAR-11.5's"*
 * (docs/06-planning-and-replanning.md §5).
 *
 * Both are pure on purpose, and for the same reason `diffPlanGraphs` is: the
 * DB reads that produce their inputs — resolving a version to its document,
 * finding the `plan.patched` event that produced it and the `plan.patch.proposed`
 * event that named its reason — belong to `@DeFlow/ledger` and
 * `../http/ledger-view.ts`, and keeping this file free of `Db` is what makes
 * the byte-identical-reason claim (AC5) testable without a database at all.
 *
 * Verifies: EPIC-11-S27 · AC3, AC4, AC5
 */

/** `<runId>:union:v<from>-v<to>` — AC4: a cache key the client's own union
 * layout is stored under, never coordinates. The server computes no x/y. */
export function unionLayoutKey(runId: string, from: number, to: number): string {
  return `${runId}:union:v${from}-v${to}`;
}

/** The `plan.patched` event that produced one plan version, reduced to the two
 * fields this join needs. */
export interface PatchedTransitionRef {
  readonly patchId: string;
  readonly decision: { readonly decision: string };
}

/** The `plan.patch.proposed` event the transition's `patchId` names, reduced
 * to the one field this join needs. */
export interface ProposedTransitionRef {
  readonly patch: { readonly reason: string };
}

/** AC3's `reason`/`decision` join, and AC5's whole content: the outcome and the
 * reason as they exist on the ledger, and nothing else. */
export interface PlanTransition {
  readonly patchId: string;
  /** Byte-identical to `PlanPatch.reason` on the proposal — this function
   * never touches the string, which is what makes AC5's newline-and-quote
   * scenario pass for the right reason rather than by coincidence. */
  readonly reason: string;
  /** The outcome only (`auto` | `approved` | `rejected` | `queued`) — the
   * rule, the approver and the timestamp stay on the ledger event for a
   * caller that asks for them by patchId; the scrubber's history strip wants
   * only this word next to the version. */
  readonly decision: string;
}

/**
 * Joins a version's `plan.patched` event to the proposal it names, or `null`
 * when either half is missing: a version with no patch behind it (v1's
 * initial compile has no transition at all), or — defensively — a patched
 * event whose proposal this build could not read back.
 */
export function joinPlanTransition(
  patched: PatchedTransitionRef | null,
  proposed: ProposedTransitionRef | null,
): PlanTransition | null {
  if (patched === null || proposed === null) return null;
  return {
    patchId: patched.patchId,
    reason: proposed.patch.reason,
    decision: patched.decision.decision,
  };
}
