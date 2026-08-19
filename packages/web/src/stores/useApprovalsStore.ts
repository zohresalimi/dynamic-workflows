/**
 * KAR-25.7 — every gate an operator can answer, across every run, live.
 *
 * The topbar's approvals control (`../components/frame/ApprovalsMenu.vue`) is
 * mounted for the whole life of the tab, and AC5/AC7 ask for the same thing
 * `RunGateBanner.vue` already promises for one run: an answer clears the
 * control **from the ledger**, whoever sent it and wherever they sent it
 * from — never from a flag this store or its caller set on its own POST.
 *
 * So this store folds exactly the events that open and close a gate,
 * `human.requested` and `human.responded`, the same two `../ledger/projections/
 * gates.ts`'s escalation fold reads for one run — generalised across every
 * run instead of one. It does not re-derive the daemon's `ApprovalKind`
 * split: every `human.requested` the ledger ever writes is one of the two
 * answerable kinds (`human-node`, `permission` — see `packages/core/src/
 * approval-queue.ts`'s own `humanItems()`), so a live frame needs no kind
 * check at all. `GET /api/approvals`'s **hydrate**, though, is a queue of
 * eight kinds, six of which have no `gateAnswerRequest` path — a patch is
 * answered through the patch route, a budget breach through
 * `budget.ceiling.set` — so `hydrate()` is what filters those out, which is
 * also what keeps the badge and the list counting the same thing (AC2).
 *
 * `entries` is one row per open gate, not one per run: `approvalsProjection`
 * on the daemon already emits it that way, and a run holding two open gates
 * is two rows here rather than one row hiding the second (see
 * `NodeInspector.vue`'s own note on the same fact for `openGate`).
 */
import type { Event, PendingGateOption } from '@DeFlow/core';
import { defineStore } from 'pinia';
import { computed, shallowRef, triggerRef } from 'vue';

/** One waiting gate, named enough to link to it and answer it. */
export interface ApprovalEntry {
  readonly runId: string;
  readonly node: string;
  /** What the gate asked, verbatim — `GateOptions.vue` does not need it, but
   * the control renders it so an operator can decide without leaving the
   * popover for `human-node` gates whose prompt is a single line. */
  readonly prompt: string;
  readonly options: readonly PendingGateOption[];
  /** The `seq` that opened this entry — oldest first is the queue's order. */
  readonly seq: number;
}

/** One row of `GET /api/approvals`, narrowed to what an entry needs. */
export interface ApprovalRowIn {
  readonly runId: string;
  readonly kind: string;
  readonly node: string | null;
  readonly prompt?: string;
  readonly options?: readonly { readonly id: string; readonly label: string }[];
  readonly seq: number;
}

/** The two `ApprovalKind`s a `gateAnswerRequest` can ever answer. The other
 * six — patch, gate-needs-human, reconcile-unknown, budget, churn, tainted —
 * are real waits with no route through this control (KAR-25.7's own notes on
 * the story). */
const ANSWERABLE_KINDS = new Set(['human-node', 'permission']);

function optionsOf(
  raw: readonly { readonly id?: unknown; readonly label?: unknown }[],
): PendingGateOption[] {
  return raw
    .filter(
      (option): option is { id: string; label: string } =>
        typeof option.id === 'string' && typeof option.label === 'string',
    )
    .map((option) => ({ id: option.id, label: option.label }));
}

export const useApprovalsStore = defineStore('approvals', () => {
  const entries = shallowRef<ApprovalEntry[]>([]);
  const hydrated = shallowRef(false);

  /** AC2 — the control's count and the control's list are the same number,
   * derived from the same array, so a badge cannot read higher than the list
   * beneath it. */
  const count = computed<number>(() => entries.value.length);

  function hydrate(rows: readonly ApprovalRowIn[]): void {
    entries.value = rows
      .filter(
        (row): row is ApprovalRowIn & { node: string; prompt: string } =>
          ANSWERABLE_KINDS.has(row.kind) && row.node !== null && typeof row.prompt === 'string',
      )
      .map((row) => ({
        runId: row.runId,
        node: row.node,
        prompt: row.prompt,
        options: optionsOf(row.options ?? []),
        seq: row.seq,
      }));
    hydrated.value = true;
    triggerRef(entries);
  }

  /**
   * One frame off `?runs=*`. Every other kind on that topic (`run.created`,
   * `run.completed`, `run.aborted`) says nothing about a gate and is ignored
   * here — the run list's own store is what reads those.
   */
  function applyLifecycle(event: Event): boolean {
    if (event.kind === 'human.requested') return open(event);
    if (event.kind === 'human.responded') return close(event);
    return false;
  }

  /** A gate opening — first ask or a re-ask (`escalated`), same handling
   * either way: the newer request replaces whatever this run's node held. */
  function open(event: Event): boolean {
    const payload = event.payload as {
      readonly node?: unknown;
      readonly prompt?: unknown;
      readonly options?: readonly { readonly id?: unknown; readonly label?: unknown }[];
    };
    if (typeof payload.node !== 'string' || typeof payload.prompt !== 'string') return false;

    const node = payload.node;
    const prompt = payload.prompt;
    entries.value = [
      ...entries.value.filter((entry) => !(entry.runId === event.runId && entry.node === node)),
      {
        runId: event.runId,
        node,
        prompt,
        options: optionsOf(payload.options ?? []),
        seq: event.seq,
      },
    ];
    triggerRef(entries);
    return true;
  }

  /** AC5, AC7 — the only thing that ever removes an entry. No caller of this
   * store sets a "did I already answer this" flag; this fold is the ledger's
   * own record of the decision, applied identically for an answer this tab
   * sent, one another tab sent, or one `deflow answer` sent from a terminal. */
  function close(event: Event): boolean {
    const payload = event.payload as { readonly node?: unknown };
    if (typeof payload.node !== 'string') return false;

    const node = payload.node;
    const before = entries.value.length;
    entries.value = entries.value.filter(
      (entry) => !(entry.runId === event.runId && entry.node === node),
    );
    if (entries.value.length === before) return false;
    triggerRef(entries);
    return true;
  }

  return { entries, hydrated, count, hydrate, applyLifecycle };
});
