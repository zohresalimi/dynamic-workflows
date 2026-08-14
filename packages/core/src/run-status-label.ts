/**
 * KAR-19.1 AC6 — the one function that turns a `RunState` into the sentence a
 * human reads.
 *
 * On 2026-08-12 three surfaces described one run at one instant three different
 * ways — `task submitted` from `deflow run`, `created — no nodes yet` from
 * `deflow status`, `No plan yet` from the web UI — and each was locally
 * defensible. Three defensible descriptions of one state is not a cosmetic
 * problem: it is how an operator concludes the fault must be somewhere they
 * have not looked, and it cost an afternoon.
 *
 * So the string is produced **here** and rendered by the three callers.
 * `test/one-status-label.test.ts` is the guard: it fails the day a fourth
 * spelling appears in a shipped source file.
 *
 * Two rules shape the table.
 *
 * **It is a function of the projection and of nothing else.** No clock, no
 * database, no provider registry — a label that depended on any of those would
 * answer differently on two surfaces holding the same events, which is the
 * whole failure being removed.
 *
 * **It says what is true, including when the truth is "nothing is happening".**
 * `created` renders as *submitted — waiting to be framed* rather than as
 * `created`, because "created" is a word about DeFlow's own bookkeeping and the
 * operator's question is whether their task has started. A run that has
 * reported a stall for the episode the projection is still sitting on says so,
 * because a stalled run that reads as `running` is exactly the reassurance that
 * kept the operator waiting.
 *
 * Verifies: EPIC-19-S7 · KAR-19.1 AC6
 */
import type { RunState, RunStatus } from './run-state.ts';

/**
 * One label per `RunStatus`, all nine of them, no two alike.
 *
 * A total record rather than a `switch` with a default: a status added to
 * `RUN_STATUSES` without a label here is a compile error, and a default arm
 * would have turned that into a run rendered as its own enum member.
 */
export const RUN_STATUS_LABELS: Readonly<Record<RunStatus, string>> = Object.freeze({
  created: 'submitted — waiting to be framed',
  'awaiting-spec-approval': 'awaiting spec approval',
  'spec-approved': 'planning',
  running: 'running',
  paused: 'paused',
  'needs-human': 'needs a decision',
  cancelling: 'cancelling',
  completed: 'completed',
  aborted: 'aborted',
});

/**
 * Whether the last `run.stalled` this run appended is still describing where
 * the projection is sitting.
 *
 * `stalledAtSeq === watermarkSeq` is the same episode identity the detector
 * uses (./no-progress.ts): the moment the projection moves, the episode is over
 * and the suffix goes with it. Only a live run carries it — an ended run's last
 * stall is history, and history is not a status.
 */
function stalled(state: RunState): boolean {
  return (
    state.watermarkSeq > 0 && state.stalledAtSeq === state.watermarkSeq && !ENDED.has(state.status)
  );
}

const ENDED: ReadonlySet<RunStatus> = new Set<RunStatus>(['completed', 'aborted']);

/** The status string every surface prints for `state`. */
export function runStatusLabel(state: RunState): string {
  const label = RUN_STATUS_LABELS[state.status];
  return stalled(state) ? `${label} — stalled` : label;
}
