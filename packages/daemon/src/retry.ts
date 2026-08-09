/**
 * KAR-06.5 — recording a classified failure: the events, the wake row, and the
 * single transaction that holds them (docs/05-durable-execution.md §10.3).
 *
 * `planRetry` in @DeFlow/core decides *what* the failure means. This module is
 * the imperative half, and it exists for one sentence in §10.3:
 *
 *   > persist the computed `wake_at` into `node_wake` in the same transaction
 *   > as the `node.failed` event, together with `node.retry.scheduled`.
 *
 * Split them and a restart inside the backoff window lands in one of two
 * states, and both are bad in a way that is invisible until it matters. Lose
 * the row and the retry is due immediately — an instant storm against the
 * vendor that just rate-limited you, which is precisely the failure full jitter
 * exists to prevent. Lose the events and the attempt is spent twice, so a node
 * with three attempts gets two.
 *
 * The three classes leave three different shapes on the log, and each shape is
 * a decision:
 *
 * | Class       | Events                                                            | Wake row |
 * | ----------- | ----------------------------------------------------------------- | -------- |
 * | `transient` | `node.failed`, `node.retry.scheduled` (+ `plan.patch.proposed`)  | `backoff` |
 * | `permanent` | `node.failed`                                                     | none     |
 * | `gate`      | `node.failed`, `node.suspended`, then `run.needs_human` — or, for a ceiling, `budget.exceeded` + `run.paused` | none |
 *
 * A `permanent` failure writes no wake row because it is not waiting for
 * anything; `decide()` propagates `dependency.failed` down the branch on the
 * next tick, from state alone. A `gate` writes none either: it is woken by a
 * person, not by the ticker.
 *
 * Nothing here names a `NodeFailureReason`. The two questions that look like
 * they need one — "is this a budget breach?" and "which needs-human category is
 * this?" — are asked of the classifier module in @DeFlow/core, which is the
 * only place that knows. `packages/core/test/scheduler-reads-class.test.ts`
 * scans this file and fails if a literal appears.
 *
 * Verifies: EPIC-06-S18, EPIC-06-S20, EPIC-06-S31 · AC2, AC3, AC4, AC6, AC7, AC9
 */
import type { QuotaRoute } from '@DeFlow/adapters';
import type {
  Db,
  EventSeq,
  NodeFailure,
  NodeId,
  PatchCause,
  PlanPatch,
  ProviderId,
  Random,
  RetryPlan,
  RetryPolicy,
  RunId,
  WakeReason,
} from '@DeFlow/core';
import {
  budgetBreachOf,
  EVENT_CURRENT_VERSIONS,
  needsHumanCategory,
  planRetry,
  QUOTA_CAUSE,
  QUOTA_WAKE_REASON,
  quotaWake,
  rateLimitOf,
  reroutePatch,
  toSingleLine,
} from '@DeFlow/core';
import type { AppendOptions, EventDraft } from '@DeFlow/ledger';
import { appendEvents, readWake, scheduleWake } from '@DeFlow/ledger';

export interface RecordFailureInput {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /**
   * Already classified. `class` was assigned where the failure was constructed
   * — this module reads it and never re-derives it.
   */
  readonly failure: NodeFailure;
  /** The failing node's own policy, carried on the `StartNode` command. */
  readonly retry: RetryPolicy;
  /** The daemon epoch stamped on every event this records (KAR-03.7). */
  readonly epoch: number;
  /** The instant the failure was observed at, from the `Clock` port. */
  readonly ts: number;
  /** The daemon life's generator. One draw per scheduled retry. */
  readonly random: Random;
  /** The node's provider preference, so a `reroute` knows where to go. */
  readonly providers?: {
    readonly current: ProviderId | null;
    readonly prefer: readonly ProviderId[];
  };
  /**
   * KAR-11.6 AC2, AC5 — the capability-aware answer to *"is there anywhere to
   * move this node to?"*, from `../providers/quota-reroute.ts`.
   *
   * Supplied only for a rate limit, and consulted only when the plan's own
   * `onFailure` policy did not already name a target: F4.5 makes "retry with a
   * different provider" the operator's decision, and the scheduler's choice is
   * what happens when they did not make one. A `suspend` proposes nothing —
   * which is AC5's whole point, because a reroute onto an adapter the probed
   * row says cannot run the node spends an attempt to re-learn that.
   */
  readonly quotaRoute?: QuotaRoute | undefined;
  readonly appendOptions?: AppendOptions;
}

export interface RecordedFailure {
  readonly plan: RetryPlan;
  readonly seqs: readonly EventSeq[];
  /** The instant on the `node_wake` row, or `null` when none was written. */
  readonly wakeAt: number | null;
  /**
   * KAR-11.6 — the reroute this failure proposed, or `null` when it proposed
   * none.
   *
   * Returned rather than left for the caller to read back off the log, because
   * the caller's next move is to rule on it: re-parsing the event it has just
   * written would make the patch the gate rules on a *different object* from
   * the one the proposal recorded, and the two can only differ by a bug.
   */
  readonly patch: PlanPatch | null;
}

/**
 * Records one failure and everything that follows from it, atomically.
 *
 * AC7 — "restarting inside a backoff window re-derives the same `wakeAt` from
 * the `node_wake` row rather than recomputing it" — has two halves, and both
 * are here. The ordinary half is that a restart does not call this function at
 * all: the wait is the row, `decide()` restates it from the reduced `wakeAt`,
 * and `scheduleWakeIfChanged` sees the row already says exactly that and writes
 * nothing. The other half is this function being re-entered for a node that
 * already has a `backoff` row outstanding — the same failure being recorded
 * twice — where the instant is read off the row instead of drawn again, so the
 * deadline cannot drift forward one restart at a time.
 */
export function recordNodeFailure(db: Db, input: RecordFailureInput): RecordedFailure {
  return db.transaction(() => {
    const outstanding = readWake(db, { runId: input.runId, nodeId: input.nodeId });
    const plan = planRetry({
      failure: input.failure,
      retry: input.retry,
      now: input.ts,
      draw: input.random.next(),
      ...(input.providers === undefined ? {} : { providers: input.providers }),
    });

    const drafts: EventDraft[] = [nodeFailed(input)];
    let wakeAt: number | null = null;
    let reason: WakeReason = 'backoff';
    let patch: PlanPatch | null = null;

    if (plan.action === 'retry' || plan.action === 'reroute') {
      // KAR-14.4 AC2, AC6. A rate limit that named its own reset overrides the
      // jittered draw entirely: the vendor said when it will serve this node,
      // and a shorter wait is a request it has already refused. One that named
      // no reset leaves both alone and the ordinary backoff applies — blind,
      // and labelled `backoff` rather than `quota` so the row never claims
      // DeFlow knows something it does not.
      const quota = quotaWake({
        failure: input.failure,
        retry: input.retry,
        now: input.ts,
        draw: 0,
      });
      const scheduled =
        quota?.reason === QUOTA_WAKE_REASON ? quota : { wakeAt: plan.wakeAt, reason };

      // The row wins over a fresh draw: see AC7 above.
      wakeAt = outstanding?.reason === scheduled.reason ? outstanding.wakeAt : scheduled.wakeAt;
      reason = scheduled.reason;

      // AC2, and in this order: the suspension says what the node is waiting
      // for, the retry says the attempt is still coming. `node.suspended` last
      // would leave the node `suspended`, which `ADMISSIBLE_STATUSES` excludes
      // — a node that never wakes, four hours from now, for no visible reason.
      if (reason === QUOTA_WAKE_REASON) drafts.push(quotaSuspended(input, wakeAt));
      drafts.push(retryScheduled(input, plan.nextAttempt, wakeAt));

      // KAR-11.6 AC2. Two proposers, asked in this order and no other. The
      // plan's own `onFailure: reroute` names the target when the operator set
      // one (F4.5), and the scheduler's capability-aware route answers only
      // when they did not — so a quota route can never overrule a policy a
      // human wrote, and a node whose plan says nothing still moves rather than
      // sleeping for four hours beside an installed adapter that could run it.
      const target = rerouteTarget(plan, input);
      if (target !== null) {
        patch = reroutePatch({
          runId: input.runId,
          node: input.nodeId,
          provider: target,
          nextAttempt: plan.nextAttempt,
          failure: input.failure,
          cause: causeOf(input),
        });
        drafts.push(patchProposed(input, patch));
      }
    } else if (plan.action === 'gate') {
      drafts.push(...gateDrafts(input));
    }

    const seqs = appendEvents(db, drafts, input.appendOptions ?? {});
    if (wakeAt !== null) {
      scheduleWake(db, { runId: input.runId, nodeId: input.nodeId, wakeAt, reason });
    }

    return { plan, seqs, wakeAt, patch };
  });
}

/**
 * KAR-11.6 AC2, AC5 — which provider the swap names, or `null` for no swap at
 * all.
 *
 * `null` is a real answer in two different situations, and conflating them
 * would be a bug in either direction: the plan asked for a reroute and offered
 * no alternative (`planRetry` degrades that to an ordinary retry rather than
 * proposing a patch that changes nothing), and the scheduler looked and found
 * nowhere healthy to go — AC5's *"no reroute is proposed"*, whose whole point
 * is that the node waits on the durable row instead.
 */
function rerouteTarget(plan: RetryPlan, input: RecordFailureInput): ProviderId | null {
  if (plan.action === 'reroute') return plan.provider;
  const route = input.quotaRoute;
  return route?.action === 'reroute' ? route.provider : null;
}

/**
 * KAR-14.4 AC7 — why the swap is being asked for, when the scheduler knows.
 *
 * Absent for every other reroute, which is honest rather than tidy: a node
 * whose `onFailure` reroutes on a timeout is following the plan's policy, and
 * labelling that `quota` would let `quota-reroute-equivalent` auto-apply a
 * patch nobody's vendor asked for. `rateLimitOf` is how the question is asked
 * without naming a reason, the same shape `budgetBreachOf` has below.
 */
function causeOf(input: RecordFailureInput): PatchCause | undefined {
  return rateLimitOf(input.failure) === null ? undefined : QUOTA_CAUSE;
}

/**
 * KAR-14.4 AC2 — `node.suspended { until }` for a node asleep on a vendor's
 * own quota reset.
 *
 * `kind: 'quota'` rather than `'wake'`, because the timeline has to be able to
 * say *what* the node is waiting for. It carries straight through to
 * `node_wake.reason` unchanged, so the reason on the row and the reason in the
 * payload are one value rather than two that can drift.
 *
 * The instant is ISO-8601 in the payload and an integer ms epoch on the row.
 * Both are instants rather than durations, because a duration is only
 * meaningful relative to a process that is still running and the point of the
 * row is to outlive one that is not.
 */
const quotaSuspended = (input: RecordFailureInput, wakeAt: number): EventDraft =>
  envelope(input, 'node.suspended', {
    node: input.nodeId,
    until: { kind: QUOTA_WAKE_REASON, wakeAt: new Date(wakeAt).toISOString() },
  });

const envelope = (
  input: RecordFailureInput,
  kind: string,
  payload: unknown,
  scoped = true,
): EventDraft => ({
  runId: input.runId,
  ts: input.ts,
  kind,
  // The version this build writes, read off the registry rather than spelled
  // as a literal: a literal is right until the first version bump and then
  // wrong silently — an event written at `v: 1` carrying a v2 payload is
  // refused at replay time, hours later, in a run nobody can repeat.
  v: (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)[kind] ?? 1,
  epoch: input.epoch,
  ...(scoped ? { nodeId: input.nodeId, attempt: input.failure.attempt } : {}),
  payload,
});

const nodeFailed = (input: RecordFailureInput): EventDraft =>
  envelope(input, 'node.failed', {
    node: input.nodeId,
    attempt: input.failure.attempt,
    failure: input.failure,
  });

const retryScheduled = (
  input: RecordFailureInput,
  nextAttempt: number,
  wakeAt: number,
): EventDraft =>
  envelope(input, 'node.retry.scheduled', { node: input.nodeId, nextAttempt, wakeAt });

/**
 * AC8 — the reroute is *proposed*, never applied here.
 *
 * A proposal changes no state (`plan.patch.proposed` reduces to nothing by
 * design: F2.4 records the proposal precisely so the audit trail is the event).
 * That is what makes an automatic provider swap visible in the plan-evolution
 * scrubber rather than an unexplained line in a cost report.
 */
const patchProposed = (input: RecordFailureInput, patch: PlanPatch): EventDraft => {
  const cause = causeOf(input);
  return envelope(input, 'plan.patch.proposed', {
    patch,
    ...(cause === undefined ? {} : { cause }),
  });
};

/**
 * AC4, AC9 — a gate suspends the node and stops the run, and how it stops
 * depends on *why*.
 *
 * A ceiling produces `budget.exceeded` and `run.paused`: F4.6's whole point is
 * that hitting a limit pauses for a human decision rather than dying with hours
 * of work half-done, and a pause is resumable by raising the ceiling. Every
 * other gate produces `run.needs_human`, which moves the run's projected status
 * out of `running` — and `decide()` admits nothing at all unless the run is
 * `running`, so that, and not a per-node flag, is what makes "no `StartNode` on
 * any subsequent tick" true for the whole run.
 *
 * `node.suspended` comes first in both cases. It is the node-level half: the
 * attempt is over, the node holds no slot and no lock, and the board shows it
 * waiting rather than failed-and-forgotten.
 */
function gateDrafts(input: RecordFailureInput): EventDraft[] {
  const suspended = envelope(input, 'node.suspended', {
    node: input.nodeId,
    until: { kind: 'human' },
  });

  const breach = budgetBreachOf(input.failure);
  if (breach !== null) {
    return [
      suspended,
      envelope(
        input,
        'budget.exceeded',
        {
          ...breach,
          // A breach that reached *here* came from an adapter reporting a
          // vendor's own refusal — DeFlow's own ceiling is checked in
          // `decide()` and never becomes a node failure — so an unstated owner
          // is the vendor rather than the `deflow` default of the wire format.
          firedBy: breach.firedBy ?? 'vendor',
          // From the failure, so the class on the ledger is the taxonomy's
          // answer rather than this module's opinion (KAR-14.2 AC2). The
          // schema refuses anything but `gate`.
          failureClass: input.failure.class,
        },
        false,
      ),
      envelope(
        input,
        'run.paused',
        { by: 'policy', reason: toSingleLine(input.failure.message) },
        false,
      ),
      // The same three events a DeFlow-side trip appends, in the same order and
      // the same transaction: a budget pause that did not raise the ask would
      // never reach the approval queue, and an operator would find a stopped
      // run with nothing telling them it is theirs to answer.
      envelope(
        input,
        'run.needs_human',
        {
          reason: needsHumanCategory(input.failure.reason),
          detail: toSingleLine(`${input.nodeId}: ${input.failure.message}`),
        },
        false,
      ),
    ];
  }

  return [
    suspended,
    envelope(
      input,
      'run.needs_human',
      {
        // A category, not a restatement: the vocabulary is closed at three and
        // the specific reason travels in `detail`, which is what the inspector
        // renders beside the failure itself.
        reason: needsHumanCategory(input.failure.reason),
        detail: toSingleLine(`${input.nodeId}: ${input.failure.reason} — ${input.failure.message}`),
      },
      false,
    ),
  ];
}
