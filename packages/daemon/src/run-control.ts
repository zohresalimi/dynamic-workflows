/**
 * KAR-15.5 — `POST /api/runs/:id/pause`, `/resume` and `/cancel`: the three
 * control verbs, as a state machine over the ledger
 * (docs/11-api-and-realtime.md §7.3, §11).
 *
 * The write surface is deliberately boring — three plain `POST`s that append an
 * event and answer with its `seq`. What is not boring is that **a repeat must
 * be free**. A double-click, a retried request and a panel that was open while
 * somebody else pressed pause all arrive here, and §11.1's answer is that these
 * writes are naturally idempotent because they are event appends over a state
 * machine: pausing a paused run returns `200` with the `seq` of the
 * `run.paused` already in the log, not `409` and not a second event. A run in a
 * state that genuinely cannot take the verb — one that has ended — is the only
 * conflict, and it is `409 run_not_pausable`.
 *
 * The file is in two halves, and the split is the point:
 *
 * - **`planRunControl` is pure.** Given what the ledger says, it answers with
 *   the event to append, the seq to echo, or the refusal. Every transition
 *   claim in `./run-control.test.ts` is about this function, so none of them
 *   needs a database.
 * - **`controlRun` is the edge.** It reads the four facts the decision needs —
 *   does the run exist, what is its reduced status, which event established it,
 *   and has the decision surface moved past the caller's `ifLastSeq` — and
 *   performs the plan in one append.
 *
 * Two things that look like they could be simplified and cannot:
 *
 * **The seq echoed for a no-op is the seq of the event that established the
 * state, never the head.** The head moves with every progress frame, so
 * echoing it would make two identical pauses answer with two different numbers
 * and give a client no way to tell "already paused" from "paused again".
 *
 * **`ifLastSeq` is asked after the spec gate and before the state machine.** An
 * operator whose panel went stale should be told *that*, not told about a state
 * they have not seen yet — but a run whose spec is not approved cannot be
 * controlled at all, and that is the more basic answer (AC6).
 *
 * Verifies: EPIC-15-S33, EPIC-15-S34, EPIC-15-S36, EPIC-15-S37 · AC1, AC2,
 * AC3, AC6, AC9
 */
import type { CancelMode, Db, RunId, RunState, RunStatus } from '@DeFlow/core';
import { toSingleLine } from '@DeFlow/core';
import type { EventDraft } from '@DeFlow/ledger';
import {
  appendEvents,
  lastSeqOfKinds,
  headSeq as ledgerHeadSeq,
  replayRun,
  runHeadSeq,
} from '@DeFlow/ledger';
import { decisionSurfaceMoved } from './human/patch-decision.ts';
import { terminateRun } from './spec/gate.ts';

export type RunControlVerb = 'pause' | 'resume' | 'cancel';

/** The codes the API turns into status lines. All four are members of the
 * closed union in `./http/errors.ts`; none of them is new here. */
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
 * surface could render honestly. What performs it is `terminateRun` in
 * `./spec/gate.ts` — the one module that appends `run.aborted` for an operator
 * (AC5) — and not this file.
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
const UNAPPROVED: readonly RunStatus[] = ['created', 'awaiting-spec-approval'];

/** A run that has ended. No verb applies, and none is a no-op either: the run
 * is not paused, not running and not cancelling. */
const ENDED: readonly RunStatus[] = ['completed', 'aborted'];

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
 * `./run-control.test.ts`: existence, then the spec gate, then staleness, then
 * the state machine.
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
  if (request.verb !== 'cancel' && UNAPPROVED.includes(status)) {
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
  if (ENDED.includes(status)) return notPausable(request.verb, status);

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
  if (ENDED.includes(status)) return { outcome: 'unchanged', seq: situation.establishedSeq };

  const mode: CancelMode = request.mode ?? 'cooperative';

  // AC3 — a run that never started ends here and now. @see UNAPPROVED
  if (UNAPPROVED.includes(status)) return { outcome: 'terminate', mode };
  const inFlight = situation.cancel ?? null;
  if (status === 'cancelling' && inFlight !== null && inFlight.mode === mode) {
    return { outcome: 'unchanged', seq: inFlight.requestedSeq };
  }
  return { outcome: 'append', kind: 'run.cancel.requested', payload: { mode } };
}

// ── the edge ─────────────────────────────────────────────────────────────────

export interface ControlRunOptions extends RunControlRequest {
  readonly db: Db;
  readonly runId: RunId;
  /** The cursor the operator's panel rendered this run at (AC3). */
  readonly ifLastSeq?: number | undefined;
  readonly epoch: number;
  /** ms epoch, from the injected `Clock` — never `Date.now()`. */
  readonly ts: number;
}

export type ControlRunResult =
  | {
      readonly status: 'ok';
      readonly http: 200;
      readonly seq: number;
      /** False when the run was already in the state asked for (AC2). */
      readonly appended: boolean;
      /** The run's status *after* the write, so a UI need not re-read. */
      readonly runStatus: RunStatus;
    }
  | {
      readonly status: 'refused';
      readonly http: 404 | 409 | 422;
      readonly code: RunControlRefusalCode;
      readonly message: string;
      readonly movedAt?: number;
      readonly head?: number;
      readonly runStatus?: RunStatus;
    };

/**
 * The events that establish each status, newest of which is the one a repeat
 * echoes.
 *
 * `spec-approved` and `running` share a list because a resume is a no-op in
 * both and the honest answer to "which event put it there" is whichever of them
 * came last: a run that started has a `run.started`, one that was approved and
 * has not started yet has only the approval.
 */
const ESTABLISHED_BY: Readonly<Record<'paused' | 'admitting' | 'ended', readonly string[]>> = {
  paused: ['run.paused'],
  admitting: ['run.resumed', 'run.started', 'run.spec.approved'],
  /** KAR-19.6 AC6 — what a cancel of a run that has already ended echoes: the
   * event that ended it, so the CLI can say *how* it ended without a re-read. */
  ended: ['run.completed', 'run.aborted'],
};

/**
 * The seq a repeated `cancel` echoes: the request already in flight, or — for a
 * run that has ended — the event that ended it (AC6).
 *
 * A run cancelled twice reaches the second branch rather than the first, and
 * that is the honest answer: by then the cancel is not in flight, it is done,
 * and `run.aborted`'s seq is the one that tells the operator so.
 */
function cancelEstablishedSeq(db: Db, runId: RunId, state: RunState): number {
  if (ENDED.includes(state.status)) {
    return lastSeqOfKinds(db, runId, ESTABLISHED_BY.ended) ?? runHeadSeq(db, runId);
  }
  return state.cancel?.requestedSeq ?? 0;
}

/** The reduced state of one run, or `null` when the ledger holds none. */
function situationOf(
  db: Db,
  runId: RunId,
  verb: RunControlVerb,
  ifLastSeq: number | undefined,
): RunSituation {
  // `runHeadSeq` is one covering-index seek and answers the 404 without
  // replaying anything, which matters because these routes are the ones an
  // operator hits repeatedly on a run with tens of thousands of events.
  if (runHeadSeq(db, runId) === 0) {
    return { status: null, establishedSeq: 0, head: ledgerHeadSeq(db) };
  }

  // `replayRun`, not `replayAll`: a control request asks about *one* run, and a
  // directory supervises several — replaying the neighbours to answer "is this
  // one paused" is work no answer depends on, paid on the route an operator
  // presses most.
  const state: RunState = replayRun(db, runId).state;
  const kinds = verb === 'pause' ? ESTABLISHED_BY.paused : ESTABLISHED_BY.admitting;
  const established =
    verb === 'cancel'
      ? cancelEstablishedSeq(db, runId, state)
      : (lastSeqOfKinds(db, runId, kinds) ?? runHeadSeq(db, runId));

  // `Number.isSafeInteger` rather than a truthiness check: seq 0 is a
  // legitimate cursor meaning "I have read nothing".
  const cursor =
    typeof ifLastSeq === 'number' && Number.isSafeInteger(ifLastSeq) && ifLastSeq >= 0
      ? ifLastSeq
      : null;

  return {
    status: state.status,
    establishedSeq: established,
    cancel: state.cancel ?? null,
    movedAt: cursor === null ? null : decisionSurfaceMoved(db, runId, cursor),
    head: ledgerHeadSeq(db),
  };
}

/**
 * AC1, AC2, AC3, AC6, AC9 — one control request, decided and performed.
 *
 * A refusal appends nothing at all, on every path. A control event recorded
 * against a run the daemon then refused to control is an audit trail implying
 * something happened, which is worse than an error.
 */
export function controlRun(options: ControlRunOptions): ControlRunResult {
  const { db, runId } = options;
  const situation = situationOf(db, runId, options.verb, options.ifLastSeq);
  const plan = planRunControl(
    {
      verb: options.verb,
      by: options.by,
      reason: options.reason,
      mode: options.mode,
    },
    situation,
  );

  if (plan.outcome === 'refused') {
    return {
      status: 'refused',
      http: plan.http,
      code: plan.code,
      message: plan.message,
      ...(plan.movedAt === undefined ? {} : { movedAt: plan.movedAt }),
      ...(plan.head === undefined ? {} : { head: plan.head }),
      ...(plan.runStatus === undefined ? {} : { runStatus: plan.runStatus }),
    };
  }

  if (plan.outcome === 'unchanged') {
    return {
      status: 'ok',
      http: 200,
      seq: plan.seq,
      appended: false,
      // Non-null by construction: `unchanged` is only reachable through a
      // branch that already read a status.
      runStatus: situation.status as RunStatus,
    };
  }

  // AC3, AC5 — the run ends here, and it ends in `terminateRun`: this file
  // decides, `./spec/gate.ts` writes, and there is one module that appends
  // `run.aborted` for an operator rather than one per route.
  if (plan.outcome === 'terminate') {
    const ended = terminateRun({
      db,
      runId,
      epoch: options.epoch,
      ts: options.ts,
      mode: plan.mode,
    });
    return { status: 'ok', http: 200, seq: ended.seq, appended: true, runStatus: 'aborted' };
  }

  const draft: EventDraft = {
    runId,
    ts: options.ts,
    kind: plan.kind,
    v: 1,
    epoch: options.epoch,
    payload: plan.payload,
  };
  const [seq] = appendEvents(db, [draft]);
  if (seq === undefined) throw new Error(`appendEvents returned no seq for ${plan.kind}`);

  return {
    status: 'ok',
    http: 200,
    seq,
    appended: true,
    runStatus: statusAfter(plan.kind),
  };
}

/** What the run reduces to once the appended event is folded. Stated rather
 * than re-replayed: a second full replay to learn a fact `reduce()` already
 * states is the expensive way to answer a question with one answer. */
function statusAfter(kind: RunControlAppend['kind']): RunStatus {
  if (kind === 'run.paused') return 'paused';
  if (kind === 'run.resumed') return 'running';
  return 'cancelling';
}
