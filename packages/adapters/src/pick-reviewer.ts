/**
 * KAR-12.2 — reviewer provider routing
 * ([docs/10-verification-gates.md §3.1](../../../docs/10-verification-gates.md)).
 *
 * §3 says *"preferably a different provider"*, and "preferably" is not
 * implementable: a preference with no stated behaviour when it cannot be
 * honoured is a preference that will be honoured differently by every caller.
 * So the section's four branches are written here as one total function with no
 * default arm, and the branch that carries the weight is the last one — **an
 * empty candidate set is a refusal, not a fallback**. NF7 says one provider
 * being unavailable degrades the plan; it does not say a degraded plan may
 * fabricate a verdict.
 *
 * **No vendor is named in this file.** `test/no-capability-table.test.ts` greps
 * this directory to keep it that way, and A0-9 is why: the measured capability
 * matrix is a snapshot against five specific versions, two of them published the
 * same day they were probed. A constant that goes stale does not fail — it
 * routes a review onto an adapter that cannot honour it, hours into a run. Every
 * capability question here is answered from the caller's `provider.probed` row
 * through `capabilities.ts`, so re-probing changes the decision with no code
 * change.
 *
 * **Health is part of the candidate set, not a capability.** A provider that
 * answered `initialize` beautifully and then emitted `provider.rate_limited` has
 * an untouched row and is still not somewhere to send a review. Folding the two
 * questions together would make a rate limit look like a missing capability in
 * every refusal detail an operator reads.
 *
 * **What the fallback weakens, and what it never does.** The single-provider
 * branch gives up the *provider* dimension and stamps `weakened: 'same-provider'`
 * so the board and the diff view can say so. It does not give up the session
 * dimension: every branch opens a new session, and `session: 'session/new'` is
 * returned rather than left implicit precisely so a reader can see that the
 * fork-shaped shortcut was not taken anywhere (AC3).
 *
 * Verifies: EPIC-12-S11, EPIC-12-S14, EPIC-12-S15 · AC6, AC7, AC8, AC9
 */
import type { PermissionLevel, ProviderId, VerdictWeakening } from '@DeFlow/core';
import { CAPABILITY_REQUIREMENTS, type CapabilityRequirement } from './admission.ts';
import { type CapabilityRow, capability } from './capabilities.ts';

/**
 * §3.1's context rule: the packet must fit in 60% of the reviewer's window.
 *
 * The same 0.6 as the context budget ceiling (`buildPacket`), and for the same
 * measured reason: the vendor's own compaction summary can consume up to 40k
 * tokens, so a packet above this leaves no room for the post-compaction floor.
 * A reviewer that compacts mid-review is a reviewer whose pinned acceptance
 * criteria may not survive into the prompt.
 */
export const REVIEW_CONTEXT_HEADROOM = 0.6;

/** AC8's machine-readable reason. A constant, because a UI branches on it. */
export const NO_CAPABLE_REVIEWER = 'no-capable-reviewer' as const;

/**
 * One provider as the router sees it.
 *
 * Three of these fields cannot come from a probed row and are not pretended to:
 * nothing in an ACP `initialize` response advertises structured output, the
 * permission levels a vendor's own flags can express are invocation knowledge
 * (`provider-registry.ts`), and a model's context window is a model property the
 * handshake says nothing about. They arrive from the caller, which is the layer
 * that knows them, and `row` is what answers everything a handshake *can*
 * answer.
 */
export interface ReviewerCandidate {
  readonly provider: ProviderId;
  /** The persisted `provider.probed` row, or `null` if it was never probed. */
  readonly row: CapabilityRow | null;
  /** `unavailable` after a `provider.rate_limited` or a failed availability
   * report. Not derivable from the row — see the header. */
  readonly health: 'healthy' | 'unavailable';
  readonly structuredOutput: boolean;
  readonly permissionLevels: readonly PermissionLevel[];
  readonly maxContext: number;
}

export interface ReviewerRouting {
  /** The provider the work under review was produced on. */
  readonly producer: ProviderId;
  /** The gate node's permission level, which the reviewer must be able to
   * express — a review that cannot read the worktree is not a review. */
  readonly permission: PermissionLevel;
  /** `estimatePacketTokens(node)`, counted by the caller's tokenizer. */
  readonly packetTokens: number;
  /** The gate node's `AdapterRequirement[]`, in the capability vocabulary
   * `admission.ts` already speaks. Answered from the row, never a table. */
  readonly requires: readonly CapabilityRequirement[];
  /** Every probed provider, in probe order. */
  readonly candidates: readonly ReviewerCandidate[];
  /** `policy.review.providerOrder` from `.DeFlow/config.yaml`. Absent, or
   * naming nothing installed, leaves probe order in charge. */
  readonly providerOrder?: readonly ProviderId[];
}

/** One requirement one provider did not meet, and why. */
export interface ReviewerRequirementFailure {
  /** A stable token — `structuredOutput`, `permission`, `context`, `health`,
   * `probed`, or a `CapabilityRequirement`. A UI groups by this. */
  readonly requirement: string;
  /** One line naming the measurement, for the human beside the grouping. */
  readonly detail: string;
}

export interface ReviewerExclusion {
  readonly provider: ProviderId;
  /** Every requirement this provider failed, in the order they were asked —
   * not the first. "Upgrade and retry" is only answerable from the whole list. */
  readonly failed: readonly ReviewerRequirementFailure[];
}

export type ReviewerDecision =
  | {
      readonly kind: 'routed';
      readonly provider: ProviderId;
      /** Always `session/new`: never a fork, never a resume (AC3). */
      readonly session: 'session/new';
      /** Present only on the single-provider fallback. */
      readonly weakened?: VerdictWeakening;
      readonly excluded: readonly ReviewerExclusion[];
    }
  | {
      readonly kind: 'needs-human';
      readonly reason: typeof NO_CAPABLE_REVIEWER;
      readonly excluded: readonly ReviewerExclusion[];
    };

/** Every requirement `candidate` fails, in the order §3.1 lists them. */
function failuresOf(
  candidate: ReviewerCandidate,
  routing: ReviewerRouting,
): readonly ReviewerRequirementFailure[] {
  const failed: ReviewerRequirementFailure[] = [];

  if (candidate.health !== 'healthy') {
    failed.push({
      requirement: 'health',
      detail:
        `${candidate.provider} is ${candidate.health}: its probed row is untouched, and a review ` +
        'sent to a provider that is refusing to serve is a review that does not happen',
    });
  }

  if (!candidate.structuredOutput) {
    failed.push({
      requirement: 'structuredOutput',
      detail:
        `${candidate.provider} cannot be handed a return contract, so its verdict would be ` +
        'enforced by prompt rather than at the adapter boundary (F7.3)',
    });
  }

  if (!candidate.permissionLevels.includes(routing.permission)) {
    failed.push({
      requirement: 'permission',
      detail:
        `${candidate.provider} expresses ${candidate.permissionLevels.join(', ') || 'no level'} ` +
        `and the gate node needs ${routing.permission}`,
    });
  }

  const ceiling = Math.floor(candidate.maxContext * REVIEW_CONTEXT_HEADROOM);
  if (routing.packetTokens > ceiling) {
    failed.push({
      requirement: 'context',
      detail:
        `the reviewer's packet is ${routing.packetTokens} tokens and ${candidate.provider} has ` +
        `${candidate.maxContext}, whose ${REVIEW_CONTEXT_HEADROOM} headroom is ${ceiling}`,
    });
  }

  if (candidate.row === null) {
    // Stricter than `admit()`, deliberately. Admission lets a node that
    // declared no requirements onto an unprobed adapter, because refusing
    // would suspend a run that could have kept going. The reviewer's candidate
    // set is defined in §3.1 as *"probed providers that are healthy and satisfy
    // the requirements"*, and the whole point of the branch below it is that an
    // empty set refuses rather than guesses — so an adapter nobody has shaken
    // hands with is not somewhere a verdict may come from.
    failed.push({
      requirement: 'probed',
      detail:
        `${candidate.provider} has no probed row: DeFlow never believes a documentation claim ` +
        'over a handshake, and a reviewer is the last place to start',
    });
    return failed;
  }

  for (const requirement of routing.requires) {
    const answer = capability(candidate.row, CAPABILITY_REQUIREMENTS[requirement]);
    if (answer.supported === true) continue;
    failed.push({
      requirement,
      detail:
        `${candidate.provider} ${candidate.row.version} answers ${answer.reason} at ` +
        `${answer.path}`,
    });
  }

  return failed;
}

/** `candidates` ranked by `policy.review.providerOrder`, then probe order. */
function ranked(
  candidates: readonly ReviewerCandidate[],
  order: readonly ProviderId[] | undefined,
): readonly ReviewerCandidate[] {
  if (order === undefined || order.length === 0) return candidates;
  const rankOf = (provider: ProviderId): number => {
    const at = order.indexOf(provider);
    return at === -1 ? order.length : at;
  };
  return [...candidates]
    .map((candidate, at) => ({ candidate, at }))
    .sort(
      (left, right) =>
        rankOf(left.candidate.provider) - rankOf(right.candidate.provider) || left.at - right.at,
    )
    .map((entry) => entry.candidate);
}

/**
 * §3.1's rule, evaluated over the probed rows. Total: four branches, no
 * default.
 *
 *   1. **Candidate set `C`** — healthy providers whose row and profile satisfy
 *      every declared requirement.
 *   2. **Preferred** — the highest-ranked member of `C \ {producer}`. No marker.
 *   3. **Fallback** — `C = {producer}`: the producer's provider, on a new
 *      session, marked `weakened: 'same-provider'`.
 *   4. **Refusal** — `C` empty: `needs-human` with `no-capable-reviewer` and
 *      which requirement each probed provider failed.
 *
 * `excluded` is returned on the routed branches too, not only the refusal. A
 * weakened review's whole justification is *the others were not capable*, and
 * a marker that cannot say why is a marker an operator has to take on trust.
 */
export function pickReviewer(routing: ReviewerRouting): ReviewerDecision {
  const excluded: ReviewerExclusion[] = [];
  const capable: ReviewerCandidate[] = [];

  for (const candidate of routing.candidates) {
    const failed = failuresOf(candidate, routing);
    if (failed.length === 0) capable.push(candidate);
    else excluded.push({ provider: candidate.provider, failed });
  }

  const preferred = ranked(
    capable.filter((candidate) => candidate.provider !== routing.producer),
    routing.providerOrder,
  )[0];
  if (preferred !== undefined) {
    return {
      kind: 'routed',
      provider: preferred.provider,
      session: 'session/new',
      excluded,
    };
  }

  const fallback = capable.find((candidate) => candidate.provider === routing.producer);
  if (fallback !== undefined) {
    return {
      kind: 'routed',
      provider: fallback.provider,
      session: 'session/new',
      weakened: 'same-provider',
      excluded,
    };
  }

  return { kind: 'needs-human', reason: NO_CAPABLE_REVIEWER, excluded };
}
