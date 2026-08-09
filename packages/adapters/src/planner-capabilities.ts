/**
 * KAR-11.1 AC2 — the planner's third input, materialised from probed rows.
 *
 * 06 §2.1 names three planner inputs and calls this one *"the input people get
 * wrong"*; §2.2 says why: *"a hardcoded capability matrix will be wrong within
 * a month"*, and the matrix measured on 2026-08-02 already differs from what
 * the vendor docs imply in two places. So this is a **projection of rows**, one
 * entry per row, computed at plan time. Delete a row and the provider is gone
 * from the list; there is nothing to invalidate because there is nothing
 * cached.
 *
 * Every answer goes through `capability()` and nothing else, which is what
 * keeps 06 §2.2's finding intact all the way to the prompt: **absent, `{}` and
 * an explicit `false` are three different answers**, and the reason travels
 * beside the boolean so the planner reads *"gemini: capability-absent"* rather
 * than a bare `false` it would be entitled to plan around.
 *
 * Two fields are not probe answers and say so in their own comments —
 * `structuredOutput` and `strongestEffort` are invocation knowledge, read from
 * the vendor registry. `test/no-capability-table.test.ts` is what keeps that
 * boundary from eroding in the other direction.
 *
 * Verifies: EPIC-11-S2 (second and third scenarios) · AC2, AC8
 */
import type { PlannerCapability, PlannerCapabilityAnswer } from '@DeFlow/core';
import {
  CAPABILITY_PATHS,
  type CapabilityKey,
  type CapabilityRow,
  capability,
} from './capabilities.ts';
import { strongestEffort } from './planner-effort.ts';
import { providerStructuredOutput } from './structured-output.ts';

/**
 * Every question the router can ask, asked of every row.
 *
 * The whole set rather than a curated subset, and in a fixed order, because the
 * planner's job is to choose a provider per node: a question omitted here is a
 * requirement it cannot know it must avoid, and a per-provider question set
 * would be a capability table wearing a different hat.
 */
export const PLANNER_CAPABILITY_KEYS: readonly CapabilityKey[] = Object.keys(
  CAPABILITY_PATHS,
) as CapabilityKey[];

function answersFor(row: ProbedRow): readonly PlannerCapabilityAnswer[] {
  return PLANNER_CAPABILITY_KEYS.map((key) => {
    const answer = capability(row as CapabilityRow, key);
    return { key, supported: answer.supported, reason: answer.reason };
  });
}

/**
 * A probed row as the ledger hands it over: structurally `CapabilityRow`, with
 * `provider` left a plain string.
 *
 * `CapabilityRow.provider` is a branded `ProviderId`, and `provider_capabilities`
 * holds whatever was probed — including a vendor this build has never
 * registered. Widening the parameter here is the honest reading: the list is a
 * projection of what is installed, and refusing to describe an unregistered
 * binary would hide it from the planner rather than tell the planner that
 * nothing can enforce a schema on it.
 */
export type ProbedRow = Omit<CapabilityRow, 'provider'> & { readonly provider: string };

/**
 * The capability list for `rows`, in the order they were read.
 *
 * `probedEvent` is the `provider.probed` seq the segment's provenance points
 * at. It is a parameter rather than something derived from `probedAt`, because
 * the packet's click-through addresses an *event*, and a millisecond timestamp
 * is not one.
 */
export function plannerCapabilityList(
  rows: readonly ProbedRow[],
  probedEvent: number,
): readonly PlannerCapability[] {
  return rows.map((row) => ({
    provider: row.provider,
    version: row.version,
    // Invocation knowledge: no ACP `initialize` response advertises structured
    // output, so this is read from how the vendor is driven, not from the row.
    structuredOutput: providerStructuredOutput(row.provider).structuredOutput,
    // Invocation knowledge too, for the same reason — and `null` where the
    // vendor exposes no reasoning-effort control at all (AC8).
    strongestEffort: strongestEffort(row.provider)?.effort ?? null,
    answers: answersFor(row),
    sourceEvent: probedEvent,
  }));
}
