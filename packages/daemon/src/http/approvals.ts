/**
 * KAR-13.2 — `GET /api/approvals`, assembled from the ledger
 * (docs/11-api-and-realtime.md §6, F8.3).
 *
 * The projection itself is pure and lives in `@DeFlow/core`
 * (`approvalsProjection`). What is here is the *edge*: reading each run's
 * reduced state, its patch queue and its tainted reads through the read-only
 * view, and joining the one fact a pure projection cannot produce — each item's
 * **age**, which is wall-clock arithmetic against the `ts` of the event that
 * created the item.
 *
 * The age is joined rather than folded on purpose. `RunState` records no
 * timestamps for these items, and adding one would mean a projection whose
 * value depends on when it is asked — the property a replay may never have. The
 * `seq` is on the item; `ts` is a primary-key lookup per row; and the queue is
 * small by construction, because it is a list of things a person has to answer.
 *
 * There is **no auxiliary pending table** anywhere in this path (AC3). Every
 * row traces to an event, deleting the checkpoint cache and replaying from
 * seq 0 produces the same queue, and a `SIGKILL` changes nothing about it —
 * which is the entire reason the queue is computed rather than kept.
 */
import type { ApprovalItem, RunId } from '@DeFlow/core';
import { approvalsProjection } from '@DeFlow/core';
import type { LedgerView } from './ledger-view.ts';

/** One queue row on the wire: the projected item, plus when it started waiting. */
export type ApprovalRow = ApprovalItem & {
  /** The `ts` of the creating event, or `null` when that row was pruned. */
  readonly ts: number | null;
  /** `now - ts`, never negative; `null` when there is no `ts` to measure from. */
  readonly ageMs: number | null;
};

export interface ApprovalsResponse {
  readonly items: readonly ApprovalRow[];
  /** AC9 — per-run counts, so a run list badge costs no second query. */
  readonly counts: Readonly<Record<string, number>>;
  /** The ledger's head, so a client can tell how far behind its cursor is. */
  readonly headSeq: number;
}

/**
 * Every pending decision across every run in this directory, oldest first.
 *
 * One pass over the runs, and no per-run request from the client — that is the
 * whole of AC1. `now` arrives from the injected clock rather than from
 * `Date.now()` here, so a spec drives the ages it asserts on.
 */
export function approvalQueue(view: LedgerView, now: number): ApprovalsResponse {
  const runs = view.runIds().flatMap((runId: RunId) => {
    const state = view.runState(runId);
    return state === null
      ? []
      : [{ runId, state, patches: view.patches(runId), taints: view.taints(runId) }];
  });

  const { items, counts } = approvalsProjection(runs);

  return {
    items: items.map((item) => {
      const ts = view.eventTs(item.seq);
      return { ...item, ts, ageMs: ts === null ? null : Math.max(0, now - ts) };
    }),
    counts,
    headSeq: view.headSeq(),
  };
}
