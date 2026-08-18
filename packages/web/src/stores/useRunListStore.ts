/**
 * KAR-19.1 AC5 — the run list, as reactive state.
 *
 * The root route used to render `PlanGraphView` with no run id, which is why
 * the operator of 2026-08-12 had to type a run id into the address bar to see
 * the run they had just created. This store is what the root route renders
 * instead, and its whole design is one sentence from EPIC-19-S2: **a run
 * created while the page is open appears without a refresh and without a
 * poll.**
 *
 * So there are exactly two ways in, and neither is an interval:
 *
 * 1. `hydrate()` — one `GET /api/runs`, when the route mounts. The endpoint
 *    lists runs the ledger holds, including the ones with no `RunState` yet.
 * 2. `applyLifecycle()` — a frame off the `?runs=*` topic, whose membership is
 *    already exactly the four low-volume lifecycle kinds this list cares about.
 *    One subscription, not a firehose and not a poll.
 *
 * **The status string is the daemon's**, carried on the row as `label`. It is
 * produced by `runStatusLabel` in `@DeFlow/core`, which is the same function
 * `deflow status` and `deflow run` print through (AC6) — so a row this list
 * draws and a line that command prints cannot disagree about one run at one
 * head sequence. A frame that arrives for a run already on screen updates it
 * **in place**, and its label is recomputed from the same table rather than
 * invented here.
 */
import type { Event, PendingGateOption, RunStatus } from '@DeFlow/core';
import { RUN_STATUS_LABELS } from '@DeFlow/core';
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, triggerRef } from 'vue';

/** One row. The shape `GET /api/runs` answers with, plus nothing. */
export interface RunListRow {
  readonly runId: string;
  readonly status: RunStatus;
  readonly label: string;
  readonly title: string;
  readonly createdAt: string;
  readonly headSeq: number;
  readonly planVersion: number;
  readonly cost?: unknown;
  /**
   * KAR-19.12 AC6 — the gate this run has stopped on, or `null`.
   *
   * `GET /api/runs` puts it on the row (from `pendingGate`), and a
   * `human.requested` frame on this topic carries the same two facts — the node
   * and the options — so a run that stops while the page is open names its gate
   * without a refetch, exactly as its status word does.
   */
  readonly gate: { readonly node: string; readonly options: readonly PendingGateOption[] } | null;
}

/**
 * What each lifecycle kind says about a run's status.
 *
 * The four kinds are the global topic's whole membership (docs/11 §3), so this
 * table is total over what can arrive rather than a subset somebody has to
 * remember to extend. `human.requested` is the one that is *not* a run status —
 * a run waiting on an answer is `needs-human` — and it is here because a run
 * that has stopped to ask is exactly the run an operator scanning this list is
 * looking for.
 */
export const LIFECYCLE_STATUS: Readonly<Record<string, RunStatus>> = {
  'run.created': 'created',
  'run.completed': 'completed',
  'run.aborted': 'aborted',
  'human.requested': 'needs-human',
};

export const useRunListStore = defineStore('run-list', () => {
  const rows = shallowRef<RunListRow[]>([]);
  /** How many `GET /api/runs` requests this store has made. EPIC-19-S2's
   * "no refetch" clause is asserted against it. */
  const fetches = ref(0);
  const hydrated = ref(false);

  /** Newest first, which is the order the endpoint answers in and the order the
   * `seq` of each run's first event puts them in. */
  const list = computed<readonly RunListRow[]>(() => rows.value);

  function hydrate(page: readonly RunListRow[]): void {
    rows.value = [...page];
    hydrated.value = true;
    fetches.value += 1;
    triggerRef(rows);
  }

  /**
   * One frame off `?runs=*`.
   *
   * Returns whether the list changed, so a caller can tell "this frame was for
   * a run I already knew about at this head" from "nothing arrived".
   */
  function applyLifecycle(event: Event): boolean {
    const status = LIFECYCLE_STATUS[event.kind];
    if (status === undefined) return false;

    const at = rows.value.findIndex((row) => row.runId === event.runId);
    if (at === -1) {
      rows.value = [
        {
          runId: event.runId,
          status,
          label: RUN_STATUS_LABELS[status],
          title: titleOf(event) ?? event.runId,
          createdAt: new Date(event.ts).toISOString(),
          headSeq: event.seq,
          planVersion: 0,
          gate: gateOf(event),
        },
        ...rows.value,
      ];
      triggerRef(rows);
      return true;
    }

    const current = rows.value[at];
    if (current === undefined) return false;
    // Updated in place: a run that completes while the operator is reading the
    // list must not jump to the top as though it were new.
    const next = [...rows.value];
    next[at] = {
      ...current,
      status,
      label: RUN_STATUS_LABELS[status],
      title: titleOf(event) ?? current.title,
      headSeq: Math.max(current.headSeq, event.seq),
      // A run that ends stops waiting on anybody, so the gate goes with it —
      // `gateOf` answers `null` for every kind that is not a request.
      gate: gateOf(event),
    };
    rows.value = next;
    triggerRef(rows);
    return true;
  }

  return { list, rows, fetches, hydrated, hydrate, applyLifecycle };
});

/**
 * KAR-19.12 AC6 — the gate a `human.requested` frame opened, or `null`.
 *
 * Read off the frame rather than folded, which is the same rule this store
 * already applies to `status`: the four lifecycle kinds are the whole membership
 * of this topic, and exactly one of them is a run stopping to ask. The other
 * three end the run or start it, and neither leaves a gate open.
 */
function gateOf(event: Event): RunListRow['gate'] {
  if (event.kind !== 'human.requested') return null;
  const payload = event.payload as {
    node?: unknown;
    options?: readonly { id?: unknown; label?: unknown }[];
  };
  if (typeof payload.node !== 'string') return null;
  return {
    node: payload.node,
    options: (payload.options ?? [])
      .filter(
        (option): option is { id: string; label: string } =>
          typeof option.id === 'string' && typeof option.label === 'string',
      )
      .map((option) => ({ id: option.id, label: option.label })),
  };
}

/** The goal a `run.created` carries, when the frame is one. Never invented:
 * a frame with no title leaves the row's own text alone. */
function titleOf(event: Event): string | null {
  if (event.kind !== 'run.created') return null;
  const goal = (event.payload as { spec?: { goal?: unknown } }).spec?.goal;
  return typeof goal === 'string' && goal.trim().length > 0 ? goal : null;
}
