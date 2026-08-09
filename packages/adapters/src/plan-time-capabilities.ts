/**
 * KAR-11.2 §3.2 — a probed row, projected into what plan validation may know
 * about an adapter (docs/06-planning-and-replanning.md §3.2).
 *
 * *"Read the probed capability row, never a constant."* Every field below is
 * either an answer `capability()` gave about a stored `initialize` response, or
 * a value the caller supplied — there is nothing in this file keyed by vendor
 * name, and `test/no-capability-table.test.ts` is what keeps it that way.
 *
 * Two fields deserve their reasoning stated, because both look like they should
 * be probe answers and neither can be:
 *
 * **`structuredOutput` is invocation knowledge.** No ACP `initialize` response
 * advertises structured output, so the reading comes from whether the vendor
 * takes a schema flag (`providerStructuredOutput`, the same source
 * `plannerCapabilityList` uses). An unregistered binary reads as `prompt-only`,
 * which is the conservative answer.
 *
 * **`permissionLevels` is derived from one bit.** F5.4 reduces to
 * `mediatedExecution` (docs/09-workspace-and-safety.md §8.3): DeFlow is the ACP
 * *client*, so it sits in the path of every write and every command for every
 * vendor, and the ladder is enforceable exactly when execution is mediated.
 * `read` needs no mediation and is therefore always offered. The absent case
 * offers the whole ladder, matching `admit()` at spawn time: no adapter
 * measured so far advertises the bit, and reading absence as a denial would
 * make the entire installed fleet unschedulable above `read` — which is a
 * different bug from the one F5.4 is about, and a louder one.
 *
 * `maxContext` is the caller's, for a third reason again: a window size is a
 * *model* property that no handshake mentions, and a per-model table here would
 * be the same staleness hazard in another column (`test/no-context-window-table
 * .test.ts`). The caller passes what it is actually going to budget against.
 */
import type { PermissionLevel, PlanTimeCapability } from '@DeFlow/core';
import { type CapabilityRow, canResume, mediatedExecution } from './capabilities.ts';
import type { ProbedRow } from './planner-capabilities.ts';
import { providerStructuredOutput } from './structured-output.ts';

/** The ladder, in `PERMISSION_LEVELS` order. */
const FULL_LADDER: readonly PermissionLevel[] = ['read', 'worktree', 'worktree+net', 'full'];

/** The one level that needs no mediation to be enforceable. */
const READ_ONLY: readonly PermissionLevel[] = ['read'];

/**
 * The plan-time view of `rows`, in the order they were read.
 *
 * `maxContext` is a function of the provider rather than a single number,
 * because a plan can name more than one adapter and the packet budget is per
 * adapter — passing one figure for the fleet would budget every node against
 * whichever window the caller happened to have to hand.
 */
export function planTimeCapabilities(
  rows: readonly ProbedRow[],
  maxContext: (provider: string) => number,
): readonly PlanTimeCapability[] {
  return rows.map((row) => {
    const probed = row as CapabilityRow;
    return {
      provider: row.provider,
      version: row.version,
      structuredOutput: providerStructuredOutput(row.provider).structuredOutput === 'native',
      resume: canResume(probed),
      permissionLevels: mediatedExecution(probed) === false ? READ_ONLY : FULL_LADDER,
      maxContext: maxContext(row.provider),
    };
  });
}
