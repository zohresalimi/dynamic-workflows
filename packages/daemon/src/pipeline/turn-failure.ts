/**
 * KAR-19.9 — what becomes of a pre-execution turn that failed.
 *
 * A run's framing turn is dispatched off the ticker and performed by a port
 * that spawns a vendor CLI. When that port throws, three things have to happen
 * and on 2026-08-13 none of them did: the failure has to reach the **ledger**,
 * the retry has to be **bounded**, and a run that has spent its attempts has to
 * **end**. Instead `runOneFraming` caught, logged to the daemon's own file, and
 * pushed the wake forward by a flat 30 s — for ever. The reported run's ledger
 * held `provider.probed`, `provider.probed`, `task.submitted` and nothing else
 * after eight minutes of identical failures, so neither the UI nor
 * `deflow status` could have shown what was wrong.
 *
 * **This module invents no policy.** The ceiling, the jittered backoff, the cap
 * and the classification are `planRetry`'s, applied through
 * `recordNodeFailure`, which writes the events and the `node_wake` row in one
 * transaction (KAR-06.5). The only thing decided here is *which* policy a node
 * with no plan entry has, and the answer is `DEFAULT_RETRY_POLICY` — EPIC-02's
 * own default, the same object `PlanNodeSchema` hands every node that does not
 * override it, rather than a number chosen here.
 *
 * **Ending the run is an append, like everything else.** Exhaustion writes
 * `run.aborted { outcome: 'failed' }` in the same transaction as the last
 * `node.failed`, consuming every wake the run still holds — a run that ends
 * holding a due row is a run the next tick dispatches a turn for, which is a
 * run that was stopped and carried on working. The reason is not on
 * `run.aborted` (`RunEndedSchema` has no field for one, and this epic adds no
 * event kinds); it is on the `node.failed` immediately before it, at the same
 * head sequence, which is exactly how intake's own refusal is read back
 * (`http/run-refusal.ts`).
 *
 * Verifies: EPIC-19-S58, EPIC-19-S59, EPIC-19-S60, EPIC-19-S61, EPIC-19-S63 ·
 * KAR-19.9 AC1, AC2, AC3
 */
import type { Db, Event, Handle, NodeId, Random, RetryPlan, RunId } from '@DeFlow/core';
import {
  DEFAULT_RETRY_POLICY,
  EVENT_CURRENT_VERSIONS,
  EventSeqSchema,
  NodeFailureError,
  parseEvent,
  toNodeFailure,
} from '@DeFlow/core';
import type { AppendOptions } from '@DeFlow/ledger';
import {
  appendEventsConsumingWakes,
  clearWake,
  headSeq,
  putBlob,
  readRange,
  readWakes,
} from '@DeFlow/ledger';
import { Buffer } from 'node:buffer';
import { tmpdir } from 'node:os';
import { log } from '../logging.ts';
import { recordNodeFailure } from '../retry.ts';

const recorder = log.child({ mod: 'turn-failure' });

/** A pre-plan run's whole log fits far inside this. */
const EVENT_PAGE = 5_000;

/** The run's events, skipping any this build cannot read. */
function ledger(db: Db, runId: RunId): readonly Event[] {
  return readRange(db, runId, 0, EVENT_PAGE).events.flatMap((stored) => {
    const parsed = parseEvent(stored);
    return parsed.status === 'ok' ? [parsed.event] : [];
  });
}

/**
 * How many attempts this node has already spent on the turn it is currently
 * owed — the 0-based index the next failure belongs to.
 *
 * Counted from the ledger rather than held in the driver, which is the whole of
 * *"exhaustion is the `fail` action with `exhausted` true, not a count kept by
 * the driver"*: a daemon restarted mid-backoff reaches the same number by
 * reading the same log, and a run that is on its third attempt cannot come back
 * from a crash with a fresh budget.
 *
 * Reset by `run.created`, deliberately. A spec the operator rejected asks for a
 * *new* framing turn (KAR-10.3 AC7), and charging that turn for the attempts a
 * previous, successful one spent would fail a run for something that already
 * worked.
 */
export function attemptsSpent(db: Db, runId: RunId, nodeId: NodeId): number {
  let since = 0;
  let spent = 0;
  for (const event of ledger(db, runId)) {
    if (event.kind === 'run.created') {
      since = event.seq;
      spent = 0;
      continue;
    }
    if (event.kind !== 'node.failed') continue;
    if (event.payload.node !== nodeId) continue;
    if (event.seq <= since) continue;
    spent += 1;
  }
  return spent;
}

/**
 * The failure a turn reports when this machine can serve no adapter.
 *
 * Constructed here rather than at the call site because the call site is the
 * chain dispatch, and AC2's source guard forbids it from naming a
 * `NodeFailureReason` — classification belongs beside the policy that reads it.
 *
 * `transient` rather than `permanent`: admission already refused runs no
 * provider could serve at submission time (KAR-19.2), so a run that reaches
 * here had one and lost it, and a vendor CLI being reinstalled or a probe
 * landing a moment later is a real and ordinary recovery. It is bounded either
 * way — three attempts and the run ends saying so, instead of a warning line
 * once a second for ever.
 */
export function noProviderFailure(runId: RunId): NodeFailureError {
  return new NodeFailureError(
    `no adapter on this machine both resolves on the operator's PATH and has a probed ` +
      `capability row, so run ${runId} cannot be served; run 'deflow doctor' to see what this ` +
      'daemon found when it started',
    { reason: 'provider.unavailable', class: 'transient' },
  );
}

/**
 * The failure a turn reports when the run's own log cannot support one — no
 * repository on `task.submitted`, no task source to frame.
 *
 * `permanent`, because no number of retries adds an event to a log that was
 * written minutes ago: the run ends on the first attempt, with the sentence in
 * its own ledger rather than in the daemon's.
 */
export function unframeableRunFailure(message: string): NodeFailureError {
  return new NodeFailureError(message, { reason: 'internal', class: 'permanent' });
}

export interface TurnFailureInput {
  readonly db: Db;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** The daemon epoch stamped on everything this records (KAR-03.7). */
  readonly epoch: number;
  /** The instant the failure was observed at, from the `Clock` port. */
  readonly ts: number;
  /** Whatever was thrown. Classified by the taxonomy, never by this module. */
  readonly error: unknown;
  /**
   * The attempt index this turn was, read off the ledger **before** the turn
   * ran.
   *
   * Passed in rather than recomputed because the turn may have journalled its
   * own `node.failed` in the meantime, and counting afterwards would read the
   * turn's own record as a previous attempt.
   */
  readonly attempt: number;
  /** The daemon life's generator — one draw per scheduled retry. */
  readonly random: Random;
  /** Where an evidence blob is written. The daemon's data directory. */
  readonly dataDir?: string | undefined;
  readonly appendOptions?: AppendOptions;
}

export interface TurnFailureOutcome {
  readonly plan: RetryPlan;
  /** True when this failure ended the run rather than scheduling a retry. */
  readonly ended: boolean;
}

/**
 * Records one failed pre-execution turn, and ends the run if that was its last
 * attempt.
 *
 * `recordNodeFailure` is imported lazily-by-reference rather than re-implemented
 * here: this function is composition, and the two questions it answers itself
 * are *"which policy does a node with no plan entry have"* and *"who ends a run
 * whose pre-execution turn is out of attempts"*.
 */
export function recordTurnFailure(input: TurnFailureInput): TurnFailureOutcome {
  const { db, runId, nodeId } = input;
  const spentAfter = attemptsSpent(db, runId, nodeId);
  // The turn journalled its own failure while it ran, so the scheduler records
  // the classification without a second `node.failed` for one attempt.
  const journalled = spentAfter > input.attempt;

  const failure = toNodeFailure(input.error, {
    // A pre-execution node always has intake's `task.submitted` behind it, so
    // the ledger is never empty here; the floor is stated rather than assumed
    // because `seq` must be positive.
    occurredAtEvent: EventSeqSchema.parse(Math.max(1, headSeq(db))),
    attempt: input.attempt,
    captureEvidence: evidenceStore(input.dataDir),
  });

  return db.transaction((): TurnFailureOutcome => {
    // The row this attempt was dispatched from is spent, and it has to go
    // *before* the ladder runs. `recordNodeFailure` deliberately prefers an
    // outstanding `backoff` row over a fresh draw — that is KAR-06.5 AC7, so a
    // restart inside a backoff window cannot push its own deadline forward one
    // restart at a time — and a due row left in place would be read as exactly
    // that: the next wait would be re-derived as an instant already in the
    // past, and three "retries" would happen in one millisecond. A plan node
    // never hits this because `decide()` consumes its wake when it starts the
    // attempt; a framing wake is deliberately left in place across the turn so
    // that a crash leaves the durable record behind, which makes clearing it
    // here — in the same transaction as the retry that replaces it — this
    // path's equivalent.
    clearWake(db, { runId, nodeId });

    const recorded = recordNodeFailure(db, {
      runId,
      nodeId,
      failure,
      retry: DEFAULT_RETRY_POLICY,
      epoch: input.epoch,
      ts: input.ts,
      random: input.random,
      journalled,
      ...(input.appendOptions === undefined ? {} : { appendOptions: input.appendOptions }),
    });

    if (recorded.plan.action !== 'fail') return { plan: recorded.plan, ended: false };

    // AC3 — exhausted, or permanently broken. Either way the run is over, and
    // it ends holding no wake: a row that outlived its run is a turn the next
    // tick dispatches for a run nobody is running.
    appendEventsConsumingWakes(
      db,
      [
        {
          runId,
          ts: input.ts,
          kind: 'run.aborted',
          v: EVENT_CURRENT_VERSIONS['run.aborted'],
          epoch: input.epoch,
          payload: { outcome: 'failed', criteriaSatisfied: [] },
        },
      ],
      readWakes(db, runId).map((row) => ({ runId, nodeId: row.nodeId })),
    );

    recorder.error(
      {
        runId,
        nodeId,
        attempt: input.attempt,
        reason: failure.reason,
        exhausted: recorded.plan.exhausted,
      },
      `run ${runId} gave up on ${nodeId} after ${String(input.attempt + 1)} attempt(s): ` +
        `${failure.reason} — ${failure.message}`,
    );
    return { plan: recorded.plan, ended: true };
  });
}

/**
 * Where the thrown value's stack goes.
 *
 * A daemon always has a data directory; a driver built by a spec without one
 * still has to be able to record a failure, and the system temp directory is
 * the honest fallback — the blob is stored somewhere real rather than the
 * handle naming bytes that were never written.
 */
function evidenceStore(dataDir: string | undefined): (text: string) => Handle {
  return (text: string): Handle =>
    putBlob(dataDir ?? tmpdir(), Buffer.from(text, 'utf8'), 'text/plain');
}
