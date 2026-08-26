/**
 * KAR-15.5 — `POST /api/runs/:id/pause`, `/resume` and `/cancel`: the edge that
 * performs the three control verbs (docs/11-api-and-realtime.md §7.3, §11).
 *
 * The write surface is deliberately boring — three plain `POST`s that append an
 * event and answer with its `seq`.
 *
 * The file used to be in two halves, and the split was the point:
 *
 * - **`planRunControl` is pure.** Given what the ledger says, it answers with
 *   the event to append, the seq to echo, or the refusal.
 * - **`controlRun` is the edge.** It reads the four facts the decision needs —
 *   does the run exist, what is its reduced status, which event established it,
 *   and has the decision surface moved past the caller's `ifLastSeq` — and
 *   performs the plan in one append.
 *
 * > **KAR-27.7 moved the pure half into `@DeFlow/core`**
 * > (`run-control-plan.ts`), unchanged, and re-exports it from here so this
 * > module is still the one name the daemon and its specs reach for. The reason
 * > is AC3 of that story: the run surface disables a control "exactly when the
 * > daemon would refuse it", and *exactly* means the browser asks this decision
 * > function rather than a second table that agrees today. A browser bundle
 * > cannot import `@DeFlow/daemon` — it takes this package's route *types* and
 * > no runtime code — so the decision moved to the package both sides share,
 * > and the database stayed here.
 *
 * One thing that looks like it could be simplified and cannot: **the seq echoed
 * for a no-op is the seq of the event that established the state, never the
 * head.** The head moves with every progress frame, so echoing it would make
 * two identical pauses answer with two different numbers and give a client no
 * way to tell "already paused" from "paused again".
 *
 * Verifies: EPIC-15-S33, EPIC-15-S34, EPIC-15-S36, EPIC-15-S37 · AC1, AC2,
 * AC3, AC6, AC9
 */
import type {
  Db,
  RunControlAppend,
  RunControlRefusalCode,
  RunControlRequest,
  RunControlVerb,
  RunId,
  RunSituation,
  RunState,
  RunStatus,
} from '@DeFlow/core';
import { planRunControl, RUN_CONTROL_ENDED } from '@DeFlow/core';
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

/*
 * The decision, and the vocabulary it answers in, re-exported rather than
 * re-declared. `./run-control.test.ts`, `./http/api.ts` and every integration
 * spec import them from here; the definitions live one package down.
 */
export type {
  RunControlAppend,
  RunControlPlan,
  RunControlRefusalCode,
  RunControlRequest,
  RunControlSource,
  RunControlTerminate,
  RunControlVerb,
  RunSituation,
} from '@DeFlow/core';
export { planRunControl } from '@DeFlow/core';

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
  if (RUN_CONTROL_ENDED.includes(state.status)) {
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
