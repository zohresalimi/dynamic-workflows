/**
 * KAR-13.2 AC6, AC7 — answering a queued patch from the approval queue
 * (docs/06-planning-and-replanning.md §4.3, docs/11-api-and-realtime.md §11).
 *
 * The service half of `POST /api/runs/:id/patches/:patchId/decide`, written as
 * a function and exercised through it, which is the same code path the HTTP
 * route mounts (the epic's own mitigation for EPIC-15 arriving later).
 *
 * Two conflicts and one write, and each of the three is a decision the queue
 * cannot be correct without:
 *
 * **`ifLastSeq` is optimistic concurrency, not a version check.** A panel goes
 * stale while the Operator reads it — patches are auto-applied on a policy
 * timer (F2.5), so that is the normal case rather than an exotic one — and an
 * approval applied to a world that moved is exactly what the `409` prevents.
 * But a `409` on *every* advance would train the Operator to retry blindly,
 * which is the same failure as an always-on approval dialog. So staleness is
 * measured against the **decision surface**: the kinds that create or resolve
 * an approval-queue row. Twenty `node.progress` frames since the cursor change
 * nothing anybody is deciding, and the write goes through.
 *
 * **A decided patch is answered with what actually happened.** Two tabs showing
 * the same patch is not a race to be prevented; it is a thing to be *reported*.
 * The second decision returns `409 patch_already_decided` carrying the original
 * — its decision, who made it and the `seq` — so the UI renders the truth
 * rather than double-applying.
 *
 * **A rejected patch stays in the queue.** *"A rejection is a 'not without
 * you', not a dead end"*: the policy's `plan.patch.rejected { by: 'policy' }`
 * leaves the patch answerable, and only a *human's* rejection closes it.
 *
 * Applying an approved patch is KAR-11.3's `commitPatchedPlan`, injected as a
 * port. It needs the run's spec, capability rows, ref checker and run
 * directory, none of which the HTTP layer assembles yet — and composing it here
 * would put a second copy of that pipeline beside the repair loop's, which is
 * how one of them comes to skip the ruling.
 *
 * Verifies: EPIC-13-S13, EPIC-13-S14 · AC6, AC7
 */
import type { Db, PatchDecision, PlanPatch, RunId } from '@DeFlow/core';
import { EVENT_CURRENT_VERSIONS, toSingleLine } from '@DeFlow/core';
import { appendEvents, headSeq, pendingPatchApprovals, readRange } from '@DeFlow/ledger';

/**
 * The event kinds that change what an Operator is deciding.
 *
 * Every one of them creates or resolves a row in the approval queue (KAR-13.2's
 * eight kinds), which is the definition of *the decision surface* and the whole
 * of AC6's "in a way that changes the decision". `node.progress`, `io_chunk`,
 * `budget.consumed` and the rest of the run's ordinary traffic are deliberately
 * absent: an item nobody has touched is still the item that was rendered.
 */
export const DECISION_SURFACE_KINDS: readonly string[] = [
  'human.requested',
  'human.responded',
  'plan.patch.proposed',
  'plan.patch.queued',
  'plan.patch.rejected',
  'plan.patched',
  'gate.evaluated',
  'node.failed',
  'run.needs_human',
  'budget.exceeded',
  'budget.ceiling.set',
  'fact.invalidated',
  'run.completed',
  'run.aborted',
];

/** How many events one staleness pass reads. Bounded, like every read here. */
const PAGE = 500;

/**
 * The first event after `afterSeq` that changed what this run's queue rows say,
 * or `null` when nothing did.
 *
 * Returned rather than a boolean so the `409` can name the event, which is what
 * lets a client re-hydrate from its cursor and re-render exactly the rows that
 * moved instead of refetching the world.
 */
export function decisionSurfaceMoved(db: Db, runId: RunId, afterSeq: number): number | null {
  let cursor = afterSeq;
  for (;;) {
    const page = readRange(db, runId, cursor, PAGE);
    for (const event of page.events) {
      if (DECISION_SURFACE_KINDS.includes(event.kind)) return event.seq;
      cursor = event.seq;
    }
    if (!page.hasMore) return null;
  }
}

/** What `commitPatchedPlan` is asked for, and what it answers with. */
export interface PatchApplication {
  /** The `seq` of the `plan.patched` it committed. */
  readonly seq: number;
  readonly planHash: string;
  readonly version: number;
}

/**
 * KAR-11.3's commit, as a port.
 *
 * Answers `null` when the patch could not be applied — revalidation refused it,
 * or the base plan moved — having recorded its own `plan.patch.rejected`. The
 * refusal is the port's to record because only it knows which of the two
 * happened.
 */
export type ApplyPatch = (request: {
  readonly patch: PlanPatch;
  readonly decision: PatchDecision;
}) => Promise<PatchApplication | null>;

export interface DecidePatchOptions {
  readonly db: Db;
  readonly runId: RunId;
  readonly patchId: string;
  readonly decision: 'approve' | 'reject';
  /** Why, for a rejection. Recorded; a rejection with nothing to say is one
   * nobody can act on later. */
  readonly reason?: string | undefined;
  /** The cursor the Operator's panel was rendered at (AC6). */
  readonly ifLastSeq?: number | undefined;
  readonly by?: 'ui' | 'cli' | undefined;
  /** ms epoch, from the injected `Clock` — never `Date.now()`. */
  readonly ts: number;
  readonly epoch: number;
  /** Required to approve; an approval with no way to apply is not an approval. */
  readonly apply?: ApplyPatch | undefined;
}

/** The original decision, as the `409` echoes it. */
export interface RecordedDecision {
  readonly decision: string;
  readonly by: string;
  readonly rule: string | null;
  readonly at: string;
  readonly seq: number;
}

export type DecidePatchResult =
  | {
      readonly status: 'ok';
      readonly http: 200;
      readonly decision: 'approve' | 'reject';
      readonly seq: number;
      /** The version the approved patch produced; `null` for a rejection. */
      readonly planHash: string | null;
    }
  | {
      readonly status: 'conflict';
      readonly http: 409;
      readonly code: 'stale_cursor';
      readonly message: string;
      /** The run's head now, so the client re-hydrates from its own cursor. */
      readonly head: number;
      /** The event that moved the decision surface. */
      readonly movedAt: number;
    }
  | {
      readonly status: 'conflict';
      readonly http: 409;
      readonly code: 'patch_already_decided';
      readonly message: string;
      readonly original: RecordedDecision;
    }
  | {
      readonly status: 'refused';
      readonly http: 404 | 422;
      readonly code: 'patch_not_found' | 'not_applicable' | 'apply_unavailable';
      readonly message: string;
    };

/**
 * AC6, AC7 — the Operator's answer to a queued patch, or why it was not taken.
 *
 * The order of the checks is the contract: *already decided* is asked before
 * *stale*, because a patch somebody else answered is a more useful thing to be
 * told than a cursor that moved (the cursor moved *because* of that answer),
 * and telling the Operator to re-render a row that no longer exists is a worse
 * answer than telling them what happened to it.
 */
export async function decideQueuedPatch(options: DecidePatchOptions): Promise<DecidePatchResult> {
  const { db, runId, patchId } = options;

  const decided = originalDecisionOf(db, runId, patchId);
  if (decided !== null) {
    return {
      status: 'conflict',
      http: 409,
      code: 'patch_already_decided',
      message: toSingleLine(
        `patch '${patchId}' was already ${decided.decision} by ${decided.by} at seq ${decided.seq}; ` +
          'a patch is decided once, and the first decision stands',
      ),
      original: decided,
    };
  }

  const pending = pendingPatchApprovals(db, runId).find((entry) => entry.patchId === patchId);
  if (pending === undefined) {
    return {
      status: 'refused',
      http: 404,
      code: 'patch_not_found',
      message: toSingleLine(
        `run '${runId}' has no patch '${patchId}' waiting on a decision: it was never proposed, ` +
          'or it was auto-applied without ever reaching the queue',
      ),
    };
  }

  if (options.ifLastSeq !== undefined) {
    const movedAt = decisionSurfaceMoved(db, runId, options.ifLastSeq);
    if (movedAt !== null) {
      return {
        status: 'conflict',
        http: 409,
        code: 'stale_cursor',
        message: toSingleLine(
          `the run moved at seq ${movedAt}, after the cursor ${options.ifLastSeq} this decision was ` +
            'made against; nothing was applied — re-hydrate from your cursor and decide again',
        ),
        head: headSeq(db),
        movedAt,
      };
    }
  }

  const at = new Date(options.ts).toISOString();

  if (options.decision === 'reject') {
    const [seq] = appendEvents(db, [
      {
        runId,
        ts: options.ts,
        kind: 'plan.patch.rejected',
        v: EVENT_CURRENT_VERSIONS['plan.patch.rejected'],
        epoch: options.epoch,
        payload: {
          patchId,
          // The Operator *is* the rule here. A rejection with no named rule is
          // unanswerable later, and `by: 'human'` is what distinguishes this
          // from the policy refusal that leaves the patch answerable.
          rule: options.reason === undefined ? HUMAN_REJECTION_RULE : options.reason,
          by: 'human',
        },
      },
    ]);
    if (seq === undefined) throw new Error('appending plan.patch.rejected returned no seq');
    return { status: 'ok', http: 200, decision: 'reject', seq, planHash: null };
  }

  if (options.apply === undefined) {
    return {
      status: 'refused',
      http: 422,
      code: 'apply_unavailable',
      message: toSingleLine(
        'approving a patch composes and revalidates the successor plan, and this caller supplied ' +
          'no way to do it; nothing was applied and the patch is still in the queue',
      ),
    };
  }

  const applied = await options.apply({
    patch: pending.patch as PlanPatch,
    decision: { decision: 'approved', by: 'human', rule: HUMAN_APPROVAL_RULE, at },
  });

  if (applied === null) {
    return {
      status: 'refused',
      http: 422,
      code: 'not_applicable',
      message: toSingleLine(
        `patch '${patchId}' could not be applied to run '${runId}'s current plan; the refusal is ` +
          'recorded as a `plan.patch.rejected` and nothing else changed',
      ),
    };
  }

  return {
    status: 'ok',
    http: 200,
    decision: 'approve',
    seq: applied.seq,
    planHash: applied.planHash,
  };
}

/** A payload field as the string it is, or `null` — a payload read back off a
 * ledger another build wrote may hold anything at all in any of these. */
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The `rule` an operator's own answer is filed under. Named rather than
 * blank, because `plan.patch.rejected` without one is a decision nobody can
 * explain three days later. */
export const HUMAN_REJECTION_RULE = 'rejected-by-operator';
export const HUMAN_APPROVAL_RULE = 'approved-by-operator';

/**
 * The decision already on the log for `patchId`, or `null` while it is still
 * answerable.
 *
 * A `plan.patched` is one — the patch landed. A `plan.patch.rejected` is one
 * **only when a human made it**: the policy engine's refusal leaves the patch
 * in the queue with an approve button on it, which is the whole of §4.3's
 * *"not without you"*.
 */
function originalDecisionOf(db: Db, runId: RunId, patchId: string): RecordedDecision | null {
  let cursor = 0;
  for (;;) {
    const page = readRange(db, runId, cursor, PAGE);
    for (const event of page.events) {
      cursor = event.seq;
      const payload = event.payload as Record<string, unknown>;
      if (payload.patchId !== patchId) continue;

      if (event.kind === 'plan.patched') {
        const decision = (payload.decision ?? {}) as Record<string, unknown>;
        return {
          decision: text(decision.decision) ?? 'approved',
          by: text(decision.by) ?? 'policy',
          rule: text(decision.rule),
          at: text(decision.at) ?? new Date(event.ts).toISOString(),
          seq: event.seq as unknown as number,
        };
      }
      if (event.kind === 'plan.patch.rejected' && payload.by === 'human') {
        return {
          decision: 'rejected',
          by: 'human',
          rule: text(payload.rule),
          at: new Date(event.ts).toISOString(),
          seq: event.seq as unknown as number,
        };
      }
    }
    if (!page.hasMore) return null;
  }
}
