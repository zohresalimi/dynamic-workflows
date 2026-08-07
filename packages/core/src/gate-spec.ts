/**
 * KAR-09.4 AC8 / §4.3 — verification gates read the `TaskSpec` from the ledger,
 * not from whatever the agent believes the spec was.
 *
 * This is a consequence of §4.2 rather than a separate idea. Security-Recall
 * Divergence is *"invisible to standard monitoring, because the commission-type
 * audit signals stay healthy while the prohibitions rot"* — so a green board is
 * not evidence, and a gate that asked the agent what it was supposed to check
 * would be reading the one thing that decayed. F1.5 already required this; §4.2
 * is why it is not optional.
 *
 * The signature is the argument. `gateSpecFromLedger` takes events and nothing
 * else: no packet, no prompt, no transcript, so "the gate could not have read
 * the agent's context" is a property of the type rather than a convention a
 * later change can quietly drop.
 *
 * **The approval is what selects.** `run.created` carries the spec and
 * `run.spec.approved` carries the `specHash` a human signed off; the resolution
 * is the spec whose recomputed hash equals the last approved one. A run whose
 * spec was never approved has no criteria to judge against — F1.3 says no work
 * is scheduled before approval — and a hash that does not reconcile is refused
 * rather than judged, because at that point nobody knows which document the
 * verdict would be about.
 *
 * EPIC-12 owns what a gate *does* with these criteria; what lives here is where
 * it is allowed to get them.
 *
 * Verifies: EPIC-09-S25 · AC8
 */
import type { Event } from './events.ts';
import { specHash } from './hash.ts';
import type { AcceptanceCriterion, TaskSpec } from './task-spec.ts';

/** Why a gate cannot be evaluated. A closed set — each arm is a different
 * operator action, and collapsing them into one message costs the reader the
 * only useful part. */
export type GateSpecUnavailableReason =
  /** No `run.created` in the ledger — nothing to judge against. */
  | 'no-spec'
  /** Never approved. F1.3 gates all work on approval; a draft is not a spec. */
  | 'not-approved'
  /** The approved digest is not the digest of the spec on record. */
  | 'hash-mismatch';

export class GateSpecUnavailable extends Error {
  readonly reason: GateSpecUnavailableReason;

  constructor(reason: GateSpecUnavailableReason, detail: string) {
    super(detail);
    this.name = 'GateSpecUnavailable';
    this.reason = reason;
  }
}

export interface LedgerSpec {
  readonly spec: TaskSpec;
  /** The approved digest — the identity a verdict's evidence cites, so that a
   * later spec edit is visible as a different identity rather than as a verdict
   * that changed its mind. */
  readonly specHash: string;
  readonly criteria: readonly AcceptanceCriterion[];
}

export async function gateSpecFromLedger(events: readonly Event[]): Promise<LedgerSpec> {
  let spec: TaskSpec | null = null;
  let approved: string | null = null;

  // Last write wins on both, in `seq` order as the ledger hands them over: a
  // re-approval is a later approval, not a second opinion.
  for (const event of events) {
    if (event.kind === 'run.created') spec = event.payload.spec;
    if (event.kind === 'run.spec.approved') approved = event.payload.specHash;
  }

  if (spec === null) {
    throw new GateSpecUnavailable(
      'no-spec',
      'the ledger carries no run.created, so there is no TaskSpec to evaluate against. A gate ' +
        "reads the spec from the ledger and never from the agent's context (F1.5, " +
        'docs/08-context-and-memory.md §4.3).',
    );
  }
  if (approved === null) {
    throw new GateSpecUnavailable(
      'not-approved',
      'the ledger carries no run.spec.approved: this spec is a draft, and F1.3 schedules no work ' +
        'against one. Approve the spec before a gate can judge anything against it.',
    );
  }

  const recomputed = await specHash(spec);
  if (recomputed !== approved) {
    throw new GateSpecUnavailable(
      'hash-mismatch',
      `the approved specHash is ${approved} but the spec on record hashes to ${recomputed}. ` +
        'Refused rather than judged: at this point nobody knows which document the verdict would ' +
        'be about.',
    );
  }

  return { spec, specHash: approved, criteria: spec.acceptanceCriteria };
}
