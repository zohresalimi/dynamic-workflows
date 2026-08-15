/**
 * KAR-19.1 AC4 — what `GET /api/runs` answers with
 * (docs/11-api-and-realtime.md §6).
 *
 * The endpoint has been in §6's route table since the architecture was written
 * and has never existed, which is why the operator of 2026-08-12 had to type a
 * run id into the address bar to see the run they had just created.
 *
 * **The un-framed run is the requirement, not an edge case.** A list built from
 * `RunState` alone omits exactly the runs that are stuck before `run.created` —
 * which are the only runs an operator in that situation is looking for. So the
 * iteration is over `listRunIds`, which is the `event` table's own answer to
 * "which runs exist", and every run it names is listed whether or not anything
 * has folded into a projection yet.
 *
 * **The status string comes from `@DeFlow/core` and is carried on the wire.**
 * `status` is the machine value a client branches on and `label` is the sentence
 * a human reads, produced by `runStatusLabel` — the same function `deflow run`
 * and `deflow status` print through (AC6). Sending the rendered string rather
 * than letting each surface derive one is what makes "three surfaces, one
 * answer" a property of the system rather than a convention three codebases
 * have to keep.
 *
 * **`cost` is passed through whole.** No flattening and no convenience total,
 * for the reason `./run-summary.ts` gives at length: subscription quota and real
 * currency are two substances, and an unmeasurable provider contributes `null`
 * rather than `0`.
 */
import type { BudgetRollup, PendingGate, RunId, RunState, RunStatus } from '@DeFlow/core';
import { initialRunState, pendingGate, runStatusLabel, toSingleLine } from '@DeFlow/core';
import type { LedgerView } from './ledger-view.ts';

/** One row of the list. AC4's seven fields, plus the rendered `label`. */
export interface RunListEntry {
  readonly runId: RunId;
  readonly status: RunStatus;
  /** The one string every surface prints. @see runStatusLabel */
  readonly label: string;
  /**
   * What the run is about, in one line: the sealed spec's goal once framing has
   * produced one, and the operator's own submitted text until then.
   *
   * Never empty and never multi-line — a list row is a line, and a title that
   * wrapped to a paragraph would push every other run off the screen.
   */
  readonly title: string;
  /** ISO-8601, from the `ts` of the run's first event. */
  readonly createdAt: string;
  readonly headSeq: number;
  readonly planVersion: number;
  readonly cost: BudgetRollup;
  /**
   * KAR-19.12 AC6 — the gate this run has stopped on, or `null`.
   *
   * On the row rather than only on `GET /api/runs/:id`, because the list is
   * where an operator scans for the run that wants them: `needs a decision`
   * with nothing to decide on is the same silence in a different font. Produced
   * by `pendingGate` and by nothing else, so this row and the terminal cannot
   * name different gates for one run at one head sequence.
   */
  readonly gate: PendingGate | null;
}

export interface RunListPage {
  readonly runs: readonly RunListEntry[];
  /** The last `runId` in this page, to pass back as `cursor`; `null` when the
   * page is empty. */
  readonly cursor: string | null;
  readonly more: boolean;
}

export interface RunListQuery {
  /**
   * `active` for everything that has not ended, or any `RunStatus` by name.
   * Anything else lists everything, which is the honest answer to a filter
   * nobody can apply — a 400 for an unknown word would make a typo look like an
   * empty machine.
   */
  readonly status?: string | undefined;
  readonly limit?: number | undefined;
  /** The `runId` the previous page ended at. Exclusive. */
  readonly cursor?: string | undefined;
}

export const RUN_LIST_DEFAULT_LIMIT = 50;
export const RUN_LIST_MAX_LIMIT = 200;

/** The two statuses `status=active` excludes. Everything else — including
 * `paused` and `needs-human` — is a run somebody is waiting on. */
const ENDED: readonly RunStatus[] = ['completed', 'aborted'];

/** The title fallback for a run nothing has framed: the operator's own words,
 * first line only. */
function submittedTitle(view: LedgerView, runId: RunId): string {
  const first = view.tail(runId, 0, 1)[0];
  const raw = (first?.payload as { raw?: unknown } | undefined)?.raw;
  return typeof raw === 'string' && raw.trim().length > 0
    ? toSingleLine(raw).slice(0, 200)
    : `run ${runId}`;
}

function titleOf(view: LedgerView, runId: RunId, state: RunState): string {
  if (state.specHash !== null) {
    const goal = view.runSpec(runId).created?.goal;
    if (typeof goal === 'string' && goal.trim().length > 0) {
      return toSingleLine(goal).slice(0, 200);
    }
  }
  return submittedTitle(view, runId);
}

function createdAtOf(view: LedgerView, runId: RunId): string {
  const first = view.tail(runId, 0, 1)[0];
  return new Date(first?.ts ?? 0).toISOString();
}

function matches(status: RunStatus, filter: string | undefined): boolean {
  if (filter === undefined || filter === '' || filter === 'all') return true;
  if (filter === 'active') return !ENDED.includes(status);
  return status === filter;
}

/**
 * One run, as a list row.
 *
 * Extracted from `runList` below rather than copied into KAR-22.3's project
 * history, and that is the whole design of that endpoint: a project's history
 * and the global list are the **same row from the same fold**, so a field added
 * to one cannot go missing from the other and `title` cannot mean the spec's
 * goal in one place and the operator's own words in the other.
 */
export function runEntry(
  view: LedgerView,
  runId: RunId,
  // A run whose events have all been pruned folds to the initial state, which
  // is a truer answer than pretending it was never there. Passed in by the
  // caller that has already folded it, so a filtered list does not fold twice —
  // and so a filter can be applied *before* the three extra reads a row costs.
  state: RunState = view.runState(runId) ?? initialRunState(),
): RunListEntry {
  return {
    runId,
    status: state.status,
    label: runStatusLabel(state),
    title: titleOf(view, runId, state),
    createdAt: createdAtOf(view, runId),
    headSeq: view.runHeadSeq(runId),
    planVersion: state.planVersion,
    cost: state.budget,
    gate: pendingGate(state),
  };
}

/**
 * KAR-22.3 AC4 — the runs of one project, in the order they were given.
 *
 * The ids arrive already ordered and already filtered, from
 * `runIdsForProject` — a `WHERE json_extract(payload, '$.provenance.projectId')`
 * over the `event` table. That is the point of this function existing at all:
 * the alternative is a page fetching the global list and sieving it, which
 * cannot work for a project with three runs among three hundred (test plan #6).
 */
export function projectRunList(
  view: LedgerView,
  runIds: readonly string[],
): { readonly runs: readonly RunListEntry[] } {
  return { runs: runIds.map((runId) => runEntry(view, runId as RunId)) };
}

/**
 * One page of the run list, newest first.
 *
 * "Newest" is the reverse of `listRunIds`, which orders by each run's **first
 * `seq`** — the total order of the system, and the only one of `seq`, `ts` and
 * `runId` that a wrong clock cannot write incorrectly (see `listRunIds`'s own
 * note). A list sorted by timestamp would reorder itself after a DST change.
 *
 * The fold is per run and is bounded by `limit`, which is why the filter is
 * applied as the page is built rather than to the whole directory first.
 */
export function runList(view: LedgerView, query: RunListQuery = {}): RunListPage {
  const limit = Math.min(
    Math.max(1, Math.trunc(query.limit ?? RUN_LIST_DEFAULT_LIMIT)),
    RUN_LIST_MAX_LIMIT,
  );

  const newestFirst = view.runIds().toReversed();
  const after =
    query.cursor === undefined || query.cursor === ''
      ? 0
      : newestFirst.indexOf(query.cursor as RunId) + 1;

  const runs: RunListEntry[] = [];
  let more = false;

  for (let index = after; index < newestFirst.length; index += 1) {
    const runId = newestFirst[index];
    if (runId === undefined) continue;
    const state = view.runState(runId) ?? initialRunState();
    if (!matches(state.status, query.status)) continue;

    if (runs.length === limit) {
      more = true;
      break;
    }

    runs.push(runEntry(view, runId, state));
  }

  return { runs, cursor: runs.at(-1)?.runId ?? null, more };
}
