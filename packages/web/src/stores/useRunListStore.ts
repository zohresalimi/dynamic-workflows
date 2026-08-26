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
 * **in place**, and its label is recomputed rather than invented here.
 *
 * **KAR-28.7 — where "recomputed" now means.** This file used to keep the
 * status tables themselves, and the frame's status pill imported them from
 * here. They live in `../lib/run-status.ts` now, which is the one place either
 * surface decides what status a run is in — see that module's header for why
 * the client fold survived at all and what was deleted instead.
 */
import type { CancelWaiting, Event, PendingGateOption, RunStatus } from '@DeFlow/core';
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, triggerRef } from 'vue';
import {
  foldRunStatus,
  RUN_STATUS_BY_KIND,
  type RunStatusFold,
  runStatusFoldOf,
  runStatusViewOf,
} from '../lib/run-status.ts';

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
  /**
   * KAR-27.6 AC2, AC4 — for a run whose cooperative cancel has gone unanswered,
   * what is still running and how to end it; `null` for every other run.
   *
   * `GET /api/runs` puts it on the row (from `cancelWaiting`), and unlike
   * `gate` there is no frame that carries it: `?runs=*`'s membership is the four
   * lifecycle kinds and `run.cancel.unanswered` is not one of them. So a run
   * that parks while this page is open wears the waiting copy on the next
   * visit, exactly as the store's own header note describes for `run.created` —
   * and a row this store *does* update in place keeps whatever the endpoint
   * said, because none of the four kinds can create or clear a parked cancel.
   */
  readonly cancelWaiting: CancelWaiting | null;
}

/** The two lifecycle kinds that end a run, and therefore end every wait on it. */
const ENDING: ReadonlySet<string> = new Set(['run.completed', 'run.aborted']);

export const useRunListStore = defineStore('run-list', () => {
  const rows = shallowRef<RunListRow[]>([]);
  /**
   * KAR-28.7 — what each listed run was doing before it stopped to ask, so an
   * answered gate can put the word back rather than leaving it on
   * `needs a decision` for the rest of the run.
   *
   * A plain `Map` beside the rows rather than a field on one: `RunListRow` is
   * the shape `GET /api/runs` answers with and nothing else, and this is the
   * store's own memory between two frames. Cleared with every hydrate, because
   * a fresh page of the daemon's own answers is not a fold this store has any
   * business carrying history across.
   */
  const folds = new Map<string, RunStatusFold>();
  /** How many `GET /api/runs` requests this store has made. EPIC-19-S2's
   * "no refetch" clause is asserted against it. */
  const fetches = ref(0);
  const hydrated = ref(false);

  /** Newest first, which is the order the endpoint answers in and the order the
   * `seq` of each run's first event puts them in. */
  const list = computed<readonly RunListRow[]>(() => rows.value);

  function hydrate(page: readonly RunListRow[]): void {
    folds.clear();
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
   *
   * `human.responded` is handled first and separately from the table — KAR-25.7
   * AC5, AC7. It is **not** a `RunStatus`: what it clears is `row.gate`, and
   * only the ledger clears it — there is no "I already answered" flag anywhere
   * in this store, on this row or in whatever pressed the button, so this frame
   * is the one and only thing that empties it, for an answer sent from this
   * tab, another tab, or `deflow answer` in a terminal, alike.
   *
   * **KAR-28.7 — it moves the word beside the row as well as the gate line.**
   * It used to clear the gate and deliberately leave `status` and `label`
   * alone, which left a row that had latched on `human.requested` reading
   * *needs a decision* for the rest of the run. What the answer restores is
   * what the run was doing before it asked; `../lib/run-status.ts` is where
   * both surfaces get that from, and it is the only place either of them gets a
   * status at all.
   */
  function applyLifecycle(event: Event): boolean {
    if (event.kind === 'human.responded') return clearGate(event);

    const at = rows.value.findIndex((row) => row.runId === event.runId);
    const previous = at === -1 ? null : foldFor(event.runId, rows.value[at]);
    const fold = foldRunStatus(previous, event);
    if (fold === null || RUN_STATUS_BY_KIND[event.kind] === undefined) return false;
    folds.set(event.runId, fold);
    const view = runStatusViewOf(fold.status);

    if (at === -1) {
      rows.value = [
        {
          runId: event.runId,
          status: view.status,
          label: view.label,
          title: titleOf(event) ?? event.runId,
          createdAt: new Date(event.ts).toISOString(),
          headSeq: event.seq,
          planVersion: 0,
          gate: gateOf(event),
          // A run this list is meeting for the first time on a lifecycle frame
          // has not been cancelled by it: the four kinds on this topic create,
          // end or block a run, and none of them parks one.
          cancelWaiting: null,
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
      status: view.status,
      label: view.label,
      title: titleOf(event) ?? current.title,
      headSeq: Math.max(current.headSeq, event.seq),
      // A run that ends stops waiting on anybody, so the gate goes with it —
      // `gateOf` answers `null` for every kind that is not a request.
      gate: gateOf(event),
      // KAR-27.6 — and so does a parked cancel: `run.aborted` is what a
      // completed cancel appends, and a row that kept naming survivors after it
      // would be telling the operator to `--force` a run that has stopped.
      cancelWaiting: ENDING.has(event.kind) ? null : (current.cancelWaiting ?? null),
    };
    rows.value = next;
    triggerRef(rows);
    return true;
  }

  /**
   * KAR-25.7 AC5, AC7 — the row's gate closing, off the same event the run's
   * own gate panel closes from (`../ledger/projections/gates.ts`'s escalation
   * fold).
   *
   * Matched on the row's own `node` rather than trusted blind: `row.gate` is
   * `pendingGate`'s **oldest** open gate, matching the daemon's own rule
   * (`packages/core/src/pending-gate.ts`), so a `human.responded` for a
   * *different* node — a run holding two open gates — must not clear the one
   * still open. A response naming the row's own gate closes it; the row does
   * not know whether a second, newer gate is now the oldest, and rather than
   * guess it reports none until the next `GET` or `human.requested` says
   * otherwise, which is this store's existing, already-accepted simplicity
   * (one gate per row, exactly what `GET /api/runs` itself carries).
   */
  function clearGate(event: Event): boolean {
    const payload = event.payload as { node?: unknown };
    if (typeof payload.node !== 'string') return false;

    const at = rows.value.findIndex(
      (row) => row.runId === event.runId && row.gate?.node === payload.node,
    );
    if (at === -1) return false;

    const current = rows.value[at];
    if (current === undefined) return false;

    // KAR-28.7 — the word moves with the gate line. `foldRunStatus` answers
    // with the status the run held before it stopped to ask; for a row this
    // store only ever met through a hydrate, that is the daemon's own word,
    // unchanged.
    const fold =
      foldRunStatus(foldFor(event.runId, current), event) ?? runStatusFoldOf(current.status);
    folds.set(event.runId, fold);
    const view = runStatusViewOf(fold.status);

    const next = [...rows.value];
    next[at] = { ...current, gate: null, status: view.status, label: view.label };
    rows.value = next;
    triggerRef(rows);
    return true;
  }

  /** This run's fold, or one seeded from whatever `GET /api/runs` last said. */
  function foldFor(runId: string, row: RunListRow | undefined): RunStatusFold | null {
    const held = folds.get(runId);
    if (held !== undefined) return held;
    return row === undefined ? null : runStatusFoldOf(row.status);
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
