/**
 * KAR-11.4 AC5, AC6 — F8.3's approval queue for proposed patches, projected
 * from the log (docs/06-planning-and-replanning.md §4.3).
 *
 * A **projection, not a table**. Every fact it needs is already an event —
 * `plan.patch.proposed` carries the patch itself, `plan.patch.queued` the rule
 * that queued it and the estimate it was ruled on, `plan.patch.rejected` the
 * rule that refused it, and `plan.patched` says it landed — so a table would be
 * a second copy of the ledger with its own way of being wrong. NF10 wants the
 * opposite: every state the UI shows traces to a specific event.
 *
 * **A rejected patch stays in the queue.** That is not an oversight, it is the
 * design: *"a rejection is a 'not without you', not a dead end"* (06 §4.3). The
 * operator opens the queue, reads which rule refused it, and may approve it
 * explicitly. A queue that hid rejections would turn a policy into a wall, and
 * the only remaining escape would be editing `.DeFlow/config.yaml` — which,
 * mid-run, changes nothing (AC10).
 *
 * A patch that was **applied** leaves the queue, because there is nothing left
 * to decide about it; its history is the `plan.patched` event and the plan
 * version it produced.
 */
import type { Db, PermissionLevel, PlanPatch, RunId } from '@DeFlow/core';
import { PlanPatchSchema } from '@DeFlow/core';
import { readRange } from './append.ts';

/** How many events one pass reads. The queue is small; the log is not. */
const PAGE = 500;

/** The figures the rule table was applied to, as `plan.patch.queued` recorded
 * them — so an operator approves against the estimate that was actually ruled
 * on rather than one recomputed against a world that has moved. */
export interface QueuedPatchEstimate {
  readonly costUsdDelta: number | null;
  readonly blastRadiusFiles: number;
  readonly maxPermission: PermissionLevel;
  readonly replanDepth: number;
}

export interface PendingPatchApproval {
  readonly patchId: string;
  /** `queued` is waiting on a human; `rejected` was refused and may still be
   * approved by one. */
  readonly status: 'queued' | 'rejected';
  /** The rule that fired, always — a decision with no named rule is
   * unanswerable (AC2). */
  readonly rule: string;
  /** `policy`, `validation` or `human`; absent for a queued item, which nobody
   * has answered yet. */
  readonly by?: 'policy' | 'human' | 'validation';
  /** The proposal itself: its ops are the plan diff, its `reason` the finding
   * that motivated it. */
  readonly patch: PlanPatch;
  /** The plan version the proposer derived against, when the proposal named
   * one (KAR-11.3 AC6). */
  readonly basePlanHash: string | null;
  readonly estimate: QueuedPatchEstimate | null;
  /** The `seq` of the proposal, which is the queue's order. */
  readonly proposedSeq: number;
  /** The `seq` of the decision that queued or rejected it. */
  readonly decidedSeq: number;
}

interface Pending {
  patchId: string;
  status: 'proposed' | 'queued' | 'rejected' | 'applied';
  rule: string;
  by?: 'policy' | 'human' | 'validation' | undefined;
  patch: PlanPatch;
  basePlanHash: string | null;
  estimate: QueuedPatchEstimate | null;
  proposedSeq: number;
  decidedSeq: number;
}

/**
 * The patches this run is waiting on a human about, oldest proposal first.
 *
 * Named for what it returns rather than for the surface it feeds. `@DeFlow/ledger`
 * carries two standing guards on its own export list — no `*Queue` (KAR-03.1's
 * single-writer architecture admits no connection pool or write queue) and no
 * exported function beginning `patch` (KAR-03.3's append-only log admits no
 * event mutator) — and a domain read called `patchApprovalQueue` trips both by
 * spelling, not by behaviour. The guards are worth more than the name.
 *
 * A proposal with no decision yet is **not** in the queue: it has not been
 * ruled on, so there is nothing for a human to answer. The gate appends the
 * ruling in the same breath as it makes it, so the window in which a proposal
 * is undecided is one function call wide.
 */
export function pendingPatchApprovals(db: Db, runId: RunId): readonly PendingPatchApproval[] {
  const byId = new Map<string, Pending>();

  let after = 0;
  for (;;) {
    const page = readRange(db, runId, after, PAGE);
    for (const event of page.events) {
      const payload = event.payload as Record<string, unknown>;
      const seq = event.seq as unknown as number;

      switch (event.kind) {
        case 'plan.patch.proposed': {
          const parsed = PlanPatchSchema.safeParse(payload.patch);
          // A proposal the current build cannot parse is skipped rather than
          // thrown on: the queue is a read of history, and history may hold a
          // document shape a later schema retired.
          if (!parsed.success) break;
          byId.set(parsed.data.id, {
            patchId: parsed.data.id,
            status: 'proposed',
            rule: '',
            patch: parsed.data,
            basePlanHash: typeof payload.basePlanHash === 'string' ? payload.basePlanHash : null,
            estimate: null,
            proposedSeq: seq,
            decidedSeq: 0,
          });
          break;
        }
        case 'plan.patch.queued': {
          const item = byId.get(String(payload.patchId));
          if (item === undefined) break;
          item.status = 'queued';
          item.rule = String(payload.rule);
          item.estimate = (payload.estimate as QueuedPatchEstimate | undefined) ?? null;
          item.decidedSeq = seq;
          break;
        }
        case 'plan.patch.rejected': {
          const item = byId.get(String(payload.patchId));
          if (item === undefined) break;
          item.status = 'rejected';
          item.rule = String(payload.rule);
          item.by = payload.by as Pending['by'];
          item.decidedSeq = seq;
          break;
        }
        case 'plan.patched': {
          const item = byId.get(String(payload.patchId));
          if (item !== undefined) item.status = 'applied';
          break;
        }
        default:
          break;
      }

      after = seq;
    }
    if (!page.hasMore) break;
  }

  return [...byId.values()]
    .filter((item) => item.status === 'queued' || item.status === 'rejected')
    .toSorted((left, right) => left.proposedSeq - right.proposedSeq)
    .map((item) => ({
      patchId: item.patchId,
      status: item.status as 'queued' | 'rejected',
      rule: item.rule,
      ...(item.by === undefined ? {} : { by: item.by }),
      patch: item.patch,
      basePlanHash: item.basePlanHash,
      estimate: item.estimate,
      proposedSeq: item.proposedSeq,
      decidedSeq: item.decidedSeq,
    }));
}
