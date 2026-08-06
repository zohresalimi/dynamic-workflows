/**
 * KAR-06.4 — what happens when `reconcile()` answers `unknown`
 * (EPIC-06-S15, roadmap risk **A1-5**, roadmap §7 open question 2).
 *
 * There is **no correct automatic action.** Retrying might apply a migration
 * twice; skipping might drop it; both are wrong in some cases and neither is
 * detectable afterwards. A migration that half-ran is not a thing to guess
 * about. So the answer designed on day one — not bolted on after the first 3
 * a.m. occurrence — is to stop and ask, with evidence:
 *
 * - `node.failed` with reason `effect.reconcile-unknown`, class `gate`. The
 *   class is not a choice this module makes: `NodeFailureSchema` refuses any
 *   other class for that reason, so nobody can helpfully add a retry later.
 * - `run.needs_human { reason: 'reconcile-unknown', detail }`, which moves the
 *   run's projected status to `needs_human`. `decide()` admits nothing at all
 *   unless the run is `running`, so this — and not a per-node flag — is what
 *   makes AC6's "no `StartNode` on any subsequent tick" true, for the failed
 *   node and for everything downstream of it.
 *
 * Both events are appended in **one transaction**. A run that failed the node
 * without recording why it stopped, or announced a gate against a node the
 * ledger says is fine, is a state no restart can interpret.
 *
 * What is deliberately *not* built: the content-addressed copy-on-write
 * overlay that would make `unknown` rarer. It is large, it still does not help
 * with network effects, and if `unknown` turns out to be common in practice
 * that measurement is what justifies it (EPIC-06-S15 notes).
 *
 * Verifies: EPIC-06-S15 · AC6, AC9, AC10
 */
import type {
  Db,
  EffectKind,
  EventSeq,
  IdempotencyKey,
  NodeFailure,
  NodeId,
  RunId,
} from '@DeFlow/core';
import { toSingleLine } from '@DeFlow/core';
import { type AppendOptions, appendEvents, headSeq } from '@DeFlow/ledger';

/**
 * Everything a human needs to answer "did it run?" — and nothing they would
 * have to take on trust.
 *
 * The three worktree hashes are `null` for the kinds that have none: an agent
 * or git effect never journals a `git status --porcelain` pair, and a `null`
 * here says "there was nothing to record" rather than "we did not tell you".
 */
export interface ReconcileEvidence {
  readonly ikey: IdempotencyKey;
  readonly kind: EffectKind;
  readonly requestHash: string;
  /** The hash journalled before `perform()`, or `null`. */
  readonly before?: string | null;
  /** The hash journalled when `perform()` returned, or `null`. */
  readonly after?: string | null;
  /** What the probe measured just now, or `null`. */
  readonly observed?: string | null;
  /** The probe's own words, when it had any. */
  readonly note?: string;
}

/**
 * The first 12 hex characters of a `sha256-…` value.
 *
 * Enough to tell three hashes apart at a glance, which is all the single-line
 * form is for. The full values are on the `node.failed` payload and in the
 * effect row, both of which the node inspector renders.
 */
export function shortDigest(hash: string): string {
  return hash.replace(/^sha256-/, '').slice(0, 12);
}

const NEVER = '<never journalled>';

const describe = (hash: string | null | undefined): string =>
  hash === null || hash === undefined ? NEVER : shortDigest(hash);

/**
 * The one line `run.needs_human` carries (AC10).
 *
 * `RunNeedsHumanSchema.detail` is `singleLine()` and capped at 400 characters;
 * four `sha256-…` values in full are 284 characters before a single label, so
 * the hashes appear as short digests. `toSingleLine` is applied at the end
 * rather than trusted: this string is built from ids this module does not own.
 */
export function reconcileUnknownDetail(evidence: ReconcileEvidence): string {
  const parts = [
    `reconcile returned unknown for ${evidence.kind} effect ${evidence.ikey}`,
    `request=${describe(evidence.requestHash)}`,
    `before=${describe(evidence.before)}`,
    `after=${describe(evidence.after)}`,
    `observed=${describe(evidence.observed)}`,
  ];
  if (evidence.note !== undefined) parts.push(evidence.note);
  return toSingleLine(parts.join(' '));
}

export interface FailureContext {
  /** The `seq` this failure happened at — a real event, never a guess. */
  readonly occurredAtEvent: number;
  readonly attempt: number;
}

/**
 * The `NodeFailure` value, with the evidence as structured fields (AC10).
 *
 * `evidence: []` and not a blob handle: there is no stdout tail or diff to
 * capture here. What the operator needs is six exact values, and putting them
 * in `detail` keeps them queryable instead of buried in an artifact.
 */
export function reconcileUnknownFailure(
  evidence: ReconcileEvidence,
  context: FailureContext,
): NodeFailure {
  return {
    reason: 'effect.reconcile-unknown',
    // Not a choice: NodeFailureSchema refuses any other class for this reason.
    class: 'gate',
    message: reconcileUnknownDetail(evidence),
    detail: {
      ikey: evidence.ikey,
      kind: evidence.kind,
      requestHash: evidence.requestHash,
      before: evidence.before ?? null,
      after: evidence.after ?? null,
      observed: evidence.observed ?? null,
      ...(evidence.note === undefined ? {} : { note: evidence.note }),
    },
    evidence: [],
    occurredAtEvent: context.occurredAtEvent as EventSeq,
    attempt: context.attempt,
  };
}

export interface EscalationInput {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
  readonly epoch: number;
  readonly ts: number;
  readonly evidence: ReconcileEvidence;
  readonly appendOptions?: AppendOptions;
}

export interface Escalation {
  readonly failure: NodeFailure;
  readonly seqs: readonly EventSeq[];
}

/**
 * Appends `node.failed` and `run.needs_human` together, and returns the
 * failure it recorded (AC6, AC9).
 *
 * `occurredAtEvent` is the ledger's head at the moment of escalation — the
 * last thing that really happened before the probe gave up — because
 * `NodeFailureSchema` wants a positive `seq` and a fabricated one would point
 * the inspector at the wrong place in the timeline.
 */
export function escalateReconcileUnknown(db: Db, input: EscalationInput): Escalation {
  return db.transaction(() => {
    const failure = reconcileUnknownFailure(input.evidence, {
      // A ledger with no events at all cannot happen here — the effect's own
      // `effect.started` is already in it — but `seq` must be positive, so the
      // floor is stated rather than assumed.
      occurredAtEvent: Math.max(1, headSeq(db)),
      attempt: input.attempt,
    });

    const seqs = appendEvents(
      db,
      [
        {
          runId: input.runId,
          ts: input.ts,
          kind: 'node.failed',
          v: 1,
          epoch: input.epoch,
          nodeId: input.nodeId,
          attempt: input.attempt,
          ikey: input.evidence.ikey,
          payload: { node: input.nodeId, attempt: input.attempt, failure },
        },
        {
          runId: input.runId,
          ts: input.ts,
          kind: 'run.needs_human',
          v: 1,
          epoch: input.epoch,
          payload: {
            reason: 'reconcile-unknown',
            detail: reconcileUnknownDetail(input.evidence),
          },
        },
      ],
      input.appendOptions ?? {},
    );

    return { failure, seqs };
  });
}
