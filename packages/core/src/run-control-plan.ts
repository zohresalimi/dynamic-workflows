/**
 * KAR-15.5 — the state machine behind `pause`, `resume` and `cancel`, as a pure
 * decision over what the ledger says (docs/11-api-and-realtime.md §7.3, §11).
 *
 * > **Moved here by KAR-27.7, from `@DeFlow/daemon`'s `run-control.ts`.** It was
 * > written as the pure half of that file and it stayed pure; what changed is
 * > that a *second* caller appeared. KAR-27.7 AC3 asks the run surface to
 * > disable a control "exactly when the daemon would refuse it", and the only
 * > way to say *exactly* is for the browser to ask the daemon's own decision
 * > function rather than a second table that agrees today. `@DeFlow/daemon` is
 * > not importable from a browser bundle — the web package imports its route
 * > types and nothing else — so the decision moved to the package both sides
 * > already share. The edge half (`controlRun`, the ledger reads, the append)
 * > stayed in the daemon, where the database is.
 *
 * What is not boring here is that **a repeat must be free**. A double-click, a
 * retried request and a panel that was open while somebody else pressed pause
 * all arrive at these verbs, and §11.1's answer is that these writes are
 * naturally idempotent because they are event appends over a state machine:
 * pausing a paused run returns `200` with the `seq` of the `run.paused` already
 * in the log, not `409` and not a second event. A run in a state that genuinely
 * cannot take the verb — one that has ended — is the only conflict, and it is
 * `409 run_not_pausable`.
 *
 * **The seq echoed for a no-op is the seq of the event that established the
 * state, never the head.** The head moves with every progress frame, so echoing
 * it would make two identical pauses answer with two different numbers and give
 * a client no way to tell "already paused" from "paused again".
 *
 * **`ifLastSeq` is asked after the spec gate and before the state machine.** An
 * operator whose panel went stale should be told *that*, not told about a state
 * they have not seen yet — but a run whose spec is not approved cannot be
 * controlled at all, and that is the more basic answer (AC6).
 *
 * Verifies: EPIC-15-S33, EPIC-15-S34, EPIC-15-S36, EPIC-15-S37 · AC1, AC2,
 * AC3, AC6, AC9
 */
import type { CancelMode } from './event-payloads.ts';
import type { RunStatus } from './run-state.ts';
import { toSingleLine } from './text.ts';

export type RunControlVerb = 'pause' | 'resume' | 'cancel';

/** The codes the API turns into status lines. All four are members of the
 * closed union in the daemon's `http/errors.ts`; none of them is new here. */
export type RunControlRefusalCode =
  | 'run_not_found'
  | 'spec_not_approved'
  | 'run_not_pausable'
  | 'stale_cursor';

/** Who asked. `policy` exists because `decide()` pauses runs too (F4.6's
 * ceiling), and the event payload has always carried the distinction. */
export type RunControlSource = 'user' | 'policy';

export interface RunControlRequest {
  readonly verb: RunControlVerb;
  readonly by: RunControlSource;
  /** Recorded on a pause. A resume carries none — there is nothing to explain
   * about continuing, and `run.resumed`'s payload has no field for it. */
  readonly reason?: string | undefined;
  /** `cancel` only, and required there: the two ladders behave differently
   * enough that guessing would be guessing about whether an agent gets to
   * flush its transcript. */
  readonly mode?: CancelMode | undefined;
}

/** Everything the decision needs to know about the run, read once by the edge. */
export interface RunSituation {
  /** `null` when this ledger holds no such run — the 404. */
  readonly status: RunStatus | null;
  /**
   * The `seq` of the event that put the run in `status`, and therefore the
   * number a repeated write echoes. 0 when nothing established it, which only
   * happens for a status no event produces.
   */
  readonly establishedSeq: number;
  /** The cancel already in flight, from `RunState.cancel`. */
  readonly cancel?: { readonly mode: CancelMode; readonly requestedSeq: number } | null;
  /** Where the decision surface moved after the caller's `ifLastSeq`, or
   * `null` when it did not — including when no cursor was sent. */
  readonly movedAt?: number | null;
  /** The ledger's head, for the `stale_cursor` body. */
  readonly head?: number;
}

/** The event `planRunControl` asks the edge to append. */
export interface RunControlAppend {
  readonly outcome: 'append';
  readonly kind: 'run.paused' | 'run.resumed' | 'run.cancel.requested';
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * KAR-19.6 AC3 — end this run now, in one transaction, rather than append a
 * request something else will act on.
 *
 * Planned for a `cancel` of a run that never started: nothing is in flight, so
 * there is no ladder with a rung on it and `cancelling` would be a status no
 * surface could render honestly. What performs it is `terminateRun` in the
 * daemon's `spec/gate.ts` — the one module that appends `run.aborted` for an
 * operator (AC5).
 */
export interface RunControlTerminate {
  readonly outcome: 'terminate';
  readonly mode: CancelMode;
}

export type RunControlPlan =
  | RunControlAppend
  | RunControlTerminate
  /** Nothing to do: the run is already in the state asked for. */
  | { readonly outcome: 'unchanged'; readonly seq: number }
  | {
      readonly outcome: 'refused';
      readonly http: 404 | 409 | 422;
      readonly code: RunControlRefusalCode;
      readonly message: string;
      /** For `stale_cursor`: where the surface moved, and the head. */
      readonly movedAt?: number;
      readonly head?: number;
      /** For `run_not_pausable` and `spec_not_approved`: the status that
       * refused, so a UI can say what happened without a second read. */
      readonly runStatus?: RunStatus;
    };

/**
 * The statuses in which the F1.3 spec gate has not been passed (AC6).
 *
 * `created` and `awaiting-spec-approval` are the same fact from two sides:
 * intake appended `task.submitted` and framing has either not produced a spec
 * or not had it approved. There is nothing running to pause and nothing
 * scheduled to resume, so those two verbs refuse.
 *
 * > **Amended 2026-08-12 by KAR-19.6 AC3.** This check used to sit above the
 * > verb split and refuse `cancel` here too, with the sentence *"the operator
 * > has `POST /runs/:id/spec/abandon` for the thing they actually mean"* — and
 * > that route begins `if (!gateIsOpen(events)) throw new SpecGateNotOpen(…)`.
 * > A run accepted and never framed was therefore refused by both, and three of
 * > them accumulated in one operator's `deflow status` with no way out at all.
 * > `cancel` now takes the verb split first and plans a termination for these
 * > two statuses; `pause` and `resume` are unchanged.
 */
export const RUN_CONTROL_UNAPPROVED: readonly RunStatus[] = ['created', 'awaiting-spec-approval'];

/** A run that has ended. No verb applies, and none is a no-op either: the run
 * is not paused, not running and not cancelling. */
export const RUN_CONTROL_ENDED: readonly RunStatus[] = ['completed', 'aborted'];

/** The statuses in which a run is admitting work, so a `resume` is a no-op. */
const ADMITTING: readonly RunStatus[] = ['running', 'spec-approved'];

const refused = (
  http: 404 | 409 | 422,
  code: RunControlRefusalCode,
  message: string,
  extra: { movedAt?: number; head?: number; runStatus?: RunStatus } = {},
): RunControlPlan => ({ outcome: 'refused', http, code, message: toSingleLine(message), ...extra });

const notPausable = (verb: RunControlVerb, status: RunStatus): RunControlPlan =>
  refused(
    409,
    'run_not_pausable',
    `this run is ${status}, so it cannot be ${verb === 'cancel' ? 'cancelled' : `${verb}d`}: ` +
      'the verb applies to a run that is still admitting work, and nothing was appended',
    { runStatus: status },
  );

/**
 * AC1, AC2, AC3, AC6 — what the daemon should do about one control request.
 *
 * Pure. The order of the checks is the contract, and it is asserted directly in
 * `@DeFlow/daemon`'s `run-control.test.ts`: existence, then the spec gate, then
 * staleness, then the state machine.
 */
export function planRunControl(
  request: RunControlRequest,
  situation: RunSituation,
): RunControlPlan {
  const { status } = situation;
  if (status === null) {
    return refused(404, 'run_not_found', 'this ledger holds no such run');
  }

  // Below the verb split for `cancel`, and above everything else for the two
  // verbs that admit work (AC3). Written as one guard rather than moved into
  // the `pause` and `resume` arms so that the *order* of the answers — the
  // contract this file's specs assert — is still readable in one place.
  if (request.verb !== 'cancel' && RUN_CONTROL_UNAPPROVED.includes(status)) {
    return refused(
      422,
      'spec_not_approved',
      `this run is ${status}: creating a run does not start it, and no control verb applies until ` +
        'POST /api/runs/:id/spec/approve has been answered',
      { runStatus: status },
    );
  }

  const movedAt = situation.movedAt ?? null;
  if (movedAt !== null) {
    return refused(
      409,
      'stale_cursor',
      `the run moved at seq ${movedAt}, after the cursor this request was written against; ` +
        'nothing was applied — re-hydrate from your cursor and look at what changed',
      { movedAt, ...(situation.head === undefined ? {} : { head: situation.head }) },
    );
  }

  if (request.verb === 'cancel') return planCancel(request, situation, status);
  if (RUN_CONTROL_ENDED.includes(status)) return notPausable(request.verb, status);

  if (request.verb === 'pause') {
    if (status === 'paused') return { outcome: 'unchanged', seq: situation.establishedSeq };
    if (status === 'cancelling') return notPausable('pause', status);
    return {
      outcome: 'append',
      kind: 'run.paused',
      payload: {
        by: request.by,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      },
    };
  }

  if (ADMITTING.includes(status)) return { outcome: 'unchanged', seq: situation.establishedSeq };
  if (status === 'cancelling') return notPausable('resume', status);
  return { outcome: 'append', kind: 'run.resumed', payload: { by: request.by } };
}

/**
 * `cancel`, which is the one verb with two of them (F5.7).
 *
 * A repeat of the mode already in flight is `unchanged`; a *different* mode is
 * appended, because an escalation from `cooperative` to `forceful` is the
 * operator saying "stop asking nicely" and `reduce()` deliberately lets a later
 * request replace an earlier one.
 */
function planCancel(
  request: RunControlRequest,
  situation: RunSituation,
  status: RunStatus,
): RunControlPlan {
  // AC6, and it is KAR-15.5 AC2's rule reaching a path it was never exercised
  // against rather than a new one: a cancel of a run that has already ended is
  // a *repeat* — the operator asked for the state it is in — so it answers with
  // the seq that ended it and appends nothing. `pause` and `resume` keep their
  // `409`; neither is a state an ended run is in.
  if (RUN_CONTROL_ENDED.includes(status)) {
    return { outcome: 'unchanged', seq: situation.establishedSeq };
  }

  const mode: CancelMode = request.mode ?? 'cooperative';

  // AC3 — a run that never started ends here and now. @see RUN_CONTROL_UNAPPROVED
  if (RUN_CONTROL_UNAPPROVED.includes(status)) return { outcome: 'terminate', mode };
  const inFlight = situation.cancel ?? null;
  if (status === 'cancelling' && inFlight !== null && inFlight.mode === mode) {
    return { outcome: 'unchanged', seq: inFlight.requestedSeq };
  }
  return { outcome: 'append', kind: 'run.cancel.requested', payload: { mode } };
}
