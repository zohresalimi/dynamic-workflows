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
import { unansweredCancelClause } from './cooperative-cancel.ts';
import { inFlightPreExecution, type PreExecutionTurnState } from './pre-execution-turn.ts';
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

/**
 * KAR-27.3 AC1 — the two statuses a run wears while a pre-execution turn can be
 * in flight.
 *
 * `created` covers framing; `spec-approved` covers recon and the planner.
 * Everything else takes precedence over the record and keeps its own label: a
 * run that has stopped for a person, or is cancelling, or has ended, is
 * describing something the operator has to act on, and a turn shown as running
 * underneath it would be describing a child that is on its way out.
 */
const FRAMEABLE: ReadonlySet<RunStatus> = new Set<RunStatus>(['created', 'spec-approved']);

/**
 * *"framing — running · attempt 1 of 3 · since 2026-08-23T10:41:41.000Z"*.
 *
 * The since-instant is composed **into the label** rather than left for each
 * caller to render, because the alternative is three surfaces formatting one
 * ledger instant three ways — which is the defect this whole file exists to
 * prevent, one field further in. ISO-8601 UTC costs no clock: `sinceTs` is a
 * recorded fact, and `toISOString` is arithmetic on it.
 *
 * The attempt is `failures + 1` and never `sessions`: a `repair` opens a second
 * vendor session inside one retry attempt, so counting sessions would tell an
 * operator their first framing turn was on its last life.
 */
function runningLabel(node: string, turn: PreExecutionTurnState): string {
  const attempt = Math.min(turn.failures + 1, turn.maxAttempts);
  return (
    `${node} — running · attempt ${String(attempt)} of ${String(turn.maxAttempts)} · ` +
    `since ${new Date(turn.sinceTs).toISOString()}`
  );
}

/**
 * KAR-27.6 AC1 — *"the run's own state carries `cancelling · the agent has not
 * answered since <instant>` rather than a bare `cancelling`"*.
 *
 * Composed here rather than spelled in `RUN_STATUS_LABELS` because it is not a
 * status: it is `cancelling` plus a fact about how long it has been that, the
 * same shape as the `— stalled` suffix below and for the same reason. The clause
 * itself comes from `./cooperative-cancel.ts`, which is the one module allowed
 * to spell it (`test/one-cancel-remedy.test.ts`).
 *
 * A bare `cancelling` is still the honest answer inside the window, and for a
 * forceful cancel at any point — a forceful cancel does not park; it runs the
 * ladder and reports what outlived it.
 */
function cancellingLabel(state: RunState): string {
  const unanswered = state.cancel?.unanswered;
  if (unanswered === undefined || unanswered === null) return RUN_STATUS_LABELS.cancelling;
  return `${RUN_STATUS_LABELS.cancelling} · ${unansweredCancelClause(unanswered.sinceTs)}`;
}

/** The status string every surface prints for `state`. */
export function runStatusLabel(state: RunState): string {
  const live = FRAMEABLE.has(state.status) ? inFlightPreExecution(state.preExecution) : null;
  const label =
    live !== null
      ? runningLabel(live.node, live.turn)
      : state.status === 'cancelling'
        ? cancellingLabel(state)
        : RUN_STATUS_LABELS[state.status];
  return stalled(state) ? `${label} — stalled` : label;
}
