/**
 * KAR-27.6 — the one place a parked cooperative cancel is described.
 *
 * **The defect this was written for.** A cooperative cancel's first rung is
 * asking the agent to stop over the protocol, through `ports.protocolCancel`.
 * Production wired that port nowhere, so on a real run the default cancel asked
 * nobody anything, the drive's `finishCancels` reached `if (live.length > 0)
 * continue`, and the run parked. Observed twice on 2026-08-25: the API answered
 * `cancelling`, both runs sat there indefinitely, and the agent child outlived
 * the cancel, outlived the daemon, and ran until it was killed by hand.
 *
 * **What KAR-27.9 changed, and what it did not.** The rung exists now: the drive
 * asks the live ACP turn, and a run whose agent answers ends with a flushed
 * transcript and no signal. Two things keep this module honest rather than
 * obsolete. An agent can still *ignore* `session/cancel`, and a daemon that has
 * restarted holds no connection to ask through — both leave exactly the wait
 * described here, with the same processes to name and the same way out. What can
 * no longer happen is a cooperative cancel of a run on a route with **no**
 * channel: `cancelLaddersFor` refuses that at the point of request, so it never
 * becomes a `cancelling` this module has to describe.
 *
 * **What this module does, and what it must never do.** It makes the wait
 * *honest*: bounded by a named constant, reported on the log, and described in
 * words that name the way out. It does not escalate and nothing built on it may
 * — a cooperative cancel is never promoted to a forceful one, because an
 * automatic escalation would make `--force` decorative and would truncate the
 * transcript the operator cancelled the run in order to read (EPIC-19-S38,
 * EPIC-27-S30). That rule survived KAR-27.9 unchanged: the rung it built asks,
 * and never signals.
 *
 * **One producer, three surfaces.** The sentence lives here and is rendered by
 * the run list, `deflow status`, `deflow cancel` and the run view — for the
 * reason `./run-status-label.ts` gives at length, one field further in: three
 * defensible local wordings of one state is how an operator concludes the fault
 * must be somewhere they have not looked. `test/one-cancel-remedy.test.ts` is
 * the guard, and it fails the day a second spelling appears in a shipped file.
 *
 * Like `runStatusLabel`, everything here is a function of the projection and of
 * nothing else. No clock: *whether* the window has elapsed is the drive's
 * decision, recorded as `run.cancel.unanswered`, and re-deciding it at render
 * time would let two surfaces holding one ledger disagree about whether a run is
 * waiting.
 *
 * Verifies: EPIC-27-S28, EPIC-27-S29, EPIC-27-S31, EPIC-27-S33 · KAR-27.6 AC1,
 * AC2, AC4
 */
import type { RunState } from './run-state.ts';

/**
 * AC1 — how long a cooperative cancel may go unanswered before the run says so.
 *
 * A constant rather than a literal at the one call site, because the number is
 * the *claim*: "we waited this long and nothing answered" is only meaningful if
 * the surface, the spec and the loop agree on how long that is, and a magic
 * number in `drive.ts` would be a claim no test could name.
 *
 * A minute, and the reasoning is the shape of the wait rather than a measured
 * distribution. A cooperative cancel that is going to be answered is answered in
 * the seconds it takes an agent to flush a transcript; one that is never going
 * to be answered — an agent ignoring the protocol, or a `process` row left by a
 * daemon life that is over — is not more informative at ten minutes than at one.
 * The cost of being early is a line of copy on a run that was about to stop
 * anyway; the cost of being late is the 2026-08-25 incident.
 */
export const COOPERATIVE_CANCEL_UNANSWERED_MS = 60_000;

/** One process still running under a parked cancel: the node, and its pid. */
export interface CancelSurvivor {
  /** The node whose attempt is still running — `impl-auth`, not a pid alone. */
  readonly node: string;
  /** The process an operator can go and look at. */
  readonly pid: number;
}

/**
 * AC1, AC2, AC4 — everything a surface needs to describe a parked cancel,
 * rendered once.
 *
 * `since` and `stillRunning` are strings rather than an instant and a list
 * because the formatting is the part that drifts: an ISO-8601 instant rendered
 * by three callers is three chances to print a locale-dependent date, and a
 * survivor list joined by three callers is three chances to lose the node and
 * leave a bare pid. The structured `survivors` is carried as well, for a surface
 * that wants to draw them rather than print them.
 */
export interface CancelWaiting {
  /** ISO-8601 UTC: the instant the operator asked, which is what has gone
   * unanswered. */
  readonly since: string;
  readonly survivors: readonly CancelSurvivor[];
  /** `pid 48215 (impl-auth), pid 48216 (impl-router)` — AC4's "without recourse
   * to `ps`". */
  readonly stillRunning: string;
  /** AC2 — the operator's next move, naming this run. */
  readonly remedy: string;
}

/**
 * AC2 — `deflow cancel <runId> --force`, spelled once.
 *
 * Exported on its own as well as inside `remedy` because `deflow cancel` prints
 * it as a bare `action` line under a report row, where the surrounding sentence
 * would read as an instruction to type an English clause.
 */
export function forcefulCancelCommand(runId: string): string {
  return `deflow cancel ${runId} --force`;
}

/** `the agent has not answered since <instant>` — the clause `runStatusLabel`
 * appends to `cancelling`, and the reason this module is the label's only
 * collaborator. */
export function unansweredCancelClause(sinceTs: number): string {
  return `the agent has not answered since ${new Date(sinceTs).toISOString()}`;
}

/** AC4 — the survivors as one line. Never silently empty: a parked cancel that
 * can name nobody has still parked, and saying so is the honest answer. */
function stillRunning(survivors: readonly CancelSurvivor[]): string {
  if (survivors.length === 0) return 'nothing this daemon can still see';
  return survivors.map((one) => `pid ${String(one.pid)} (${one.node})`).join(', ');
}

/**
 * The parked cancel `state` is describing, or `null` when it is not describing
 * one.
 *
 * `null` is the answer for every ordinary run — one nobody cancelled, one whose
 * cancel completed, one still inside the window — which is EPIC-27-S33: *"a run
 * that was never cancelled says nothing new."*
 */
export function cancelWaiting(state: RunState, runId: string): CancelWaiting | null {
  // A run that ended is not waiting, whatever its cancel record still holds —
  // and `cancelling` is the only status that is neither ended nor pre-cancel.
  if (state.status !== 'cancelling') return null;
  const unanswered = state.cancel?.unanswered;
  if (unanswered === undefined || unanswered === null) return null;

  return {
    since: new Date(unanswered.sinceTs).toISOString(),
    survivors: unanswered.survivors,
    stillRunning: stillRunning(unanswered.survivors),
    remedy:
      `nothing will be signalled on the run's behalf; end it with ` +
      `'${forcefulCancelCommand(runId)}'`,
  };
}
