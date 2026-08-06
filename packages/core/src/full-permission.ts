/**
 * KAR-08.1 AC5 — `full` never arrives by accident (EPIC-08-S4).
 *
 * F5.4 says `full` is an explicit per-run opt-in, never a default. Two doors
 * lead to it and both are locked from the inside here:
 *
 *   1. **Plan validation.** A plan containing a node at `full` is refused
 *      unless the run carries the operator's opt-in, and the refusal names the
 *      node so the answer to "why was this rejected" is not a hunt.
 *   2. **The patch policy.** A `PlanPatch` that would raise a node to `full`
 *      is `requires-approval`, never `auto`. This is the one that matters at
 *      runtime: a running node proposing a patch is DeFlow's normal replanning
 *      path (F2.5), so a policy engine whose default is "auto-apply anything
 *      that does not add write capability" would hand out `full` to a
 *      well-worded justification.
 *
 * The approval request states plainly that `full` is not a sandbox. Security
 * model §6.1 puts defending the user against themselves at `full` explicitly
 * out of scope — which is precisely why the consent must be informed at the
 * moment it is given, in the same honest words ODW uses about
 * `dangerously-full-access`, rather than in a document nobody opens.
 *
 * Both ops and the declared `escalatesPermission` pair are read, because the
 * pair is the *proposer's own account* of what its patch does. A patch that
 * inserts a `full` node while declaring no escalation is either a bug or the
 * attack, and in both cases the ops are the ground truth.
 *
 * Applying the rules — turning a ruling into a `PatchDecision`, queueing the
 * approval — is KAR-11.4. This module is the rule.
 *
 * Verifies: EPIC-08-S4 · AC5
 */
import { z } from 'zod';
import type { PermissionLevel, PlanIssue } from './plan-graph.ts';
import type { PlanPatch } from './plan-patch.ts';

/** The named rule, so a queued approval says which one fired (KAR-02.4 AC7
 * requires a rule on any refusal, and this is the rule's name). */
export const FULL_OPT_IN_RULE = 'full-permission-opt-in' as const;

/**
 * The operator's per-run consent.
 *
 * A timestamp is required and not optional: "the opt-in was on" is a flag, and
 * a flag does not survive the restart it exists to protect against, nor can it
 * be rendered on a run report as a fact with a time and an author.
 */
export const FullPermissionOptInSchema = z.strictObject({
  at: z.iso.datetime(),
  by: z.string().min(1),
});

export type FullPermissionOptIn = z.infer<typeof FullPermissionOptInSchema>;

/** The sentence the approval carries. Verbatim rather than assembled, because
 * it is the whole point of the gate. */
export const FULL_IS_NOT_A_SANDBOX =
  'full is not a sandbox: at this level DeFlow enforces no worktree boundary on commands and no ' +
  'network boundary at all, so the agent can do anything the operator can do.';

/**
 * Every node in `plan` sitting at `full` while the run carries no opt-in.
 *
 * Reads the raw input rather than a parsed `PlanGraph`, so it can run beside
 * the schema parse instead of after it: a plan rejected for some other field
 * must not get a second chance to smuggle `permission: "full"` through on the
 * retry, and a validator that only sees successfully-parsed graphs would give
 * it one.
 */
export function fullPermissionIssues(
  plan: unknown,
  optIn: FullPermissionOptIn | null,
): PlanIssue[] {
  if (optIn !== null) return [];
  if (typeof plan !== 'object' || plan === null) return [];
  const nodes: unknown = (plan as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];

  const issues: PlanIssue[] = [];
  for (const [index, entry] of (nodes as unknown[]).entries()) {
    if (typeof entry !== 'object' || entry === null) continue;
    const node = entry as { id?: unknown; permission?: unknown };
    if (node.permission !== 'full') continue;
    const id = typeof node.id === 'string' ? node.id : index;
    issues.push({
      path: ['nodes', id, 'permission'],
      code: 'full-permission-not-opted-in',
      message:
        `node ${String(id)} asks for permission level "full", which requires an explicit ` +
        'run-level opt-in this run does not carry',
    });
  }
  return issues;
}

export type FullEscalationRuling =
  | {
      readonly ruling: 'requires-approval';
      readonly rule: typeof FULL_OPT_IN_RULE;
      /** `null` when the patch never declared a pair and the ops are what gave
       * it away. */
      readonly from: PermissionLevel | null;
      readonly to: 'full';
      readonly message: string;
    }
  | { readonly ruling: 'not-applicable' };

/**
 * Whether this patch needs a human before it may be applied, on the `full`
 * rule alone.
 *
 * `'not-applicable'` rather than `'auto'` for everything else: an escalation
 * from `read` to `worktree` may well be auto-appliable, but that is KAR-11.4's
 * assessment to make against cost, blast radius and replan depth. This rule
 * answering `'auto'` would be it granting an approval it never assessed.
 */
export function fullEscalationRuling(patch: PlanPatch): FullEscalationRuling {
  const declared = patch.policy.escalatesPermission;
  const from = declared !== null && declared.to === 'full' ? declared.from : null;

  const inserted =
    from === null &&
    patch.ops.some((op) =>
      (op.op === 'insert-nodes' || op.op === 'split-node'
        ? op.op === 'insert-nodes'
          ? op.nodes
          : op.into
        : []
      ).some((node) => node.permission === 'full'),
    );

  if (from === null && !inserted) return { ruling: 'not-applicable' };
  return {
    ruling: 'requires-approval',
    rule: FULL_OPT_IN_RULE,
    from,
    to: 'full',
    message: FULL_IS_NOT_A_SANDBOX,
  };
}
