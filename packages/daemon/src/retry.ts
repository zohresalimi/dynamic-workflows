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
import type {
  Db,
  EventSeq,
  NodeFailure,
  NodeId,
  ProviderId,
  Random,
  RetryPlan,
  RetryPolicy,
  RunId,
} from '@DeFlow/core';
import {
  budgetBreachOf,
  needsHumanCategory,
  planRetry,
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
  readonly appendOptions?: AppendOptions;
}

export interface RecordedFailure {
  readonly plan: RetryPlan;
  readonly seqs: readonly EventSeq[];
  /** The instant on the `node_wake` row, or `null` when none was written. */
  readonly wakeAt: number | null;
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

    if (plan.action === 'retry' || plan.action === 'reroute') {
      // The row wins over a fresh draw: see AC7 above.
      wakeAt = outstanding?.reason === 'backoff' ? outstanding.wakeAt : plan.wakeAt;
      drafts.push(retryScheduled(input, plan.nextAttempt, wakeAt));
      if (plan.action === 'reroute')
        drafts.push(patchProposed(input, plan.provider, plan.nextAttempt));
    } else if (plan.action === 'gate') {
      drafts.push(...gateDrafts(input));
    }

    const seqs = appendEvents(db, drafts, input.appendOptions ?? {});
    if (wakeAt !== null) {
      scheduleWake(db, {
        runId: input.runId,
        nodeId: input.nodeId,
        wakeAt,
        reason: 'backoff',
      });
    }

    return { plan, seqs, wakeAt };
  });
}

const envelope = (
  input: RecordFailureInput,
  kind: string,
  payload: unknown,
  scoped = true,
): EventDraft => ({
  runId: input.runId,
  ts: input.ts,
  kind,
  v: 1,
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
const patchProposed = (
  input: RecordFailureInput,
  provider: ProviderId,
  nextAttempt: number,
): EventDraft =>
  envelope(input, 'plan.patch.proposed', {
    patch: reroutePatch({
      runId: input.runId,
      node: input.nodeId,
      provider,
      nextAttempt,
      failure: input.failure,
    }),
  });

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
      envelope(input, 'budget.exceeded', { ...breach }, false),
      envelope(
        input,
        'run.paused',
        { by: 'policy', reason: toSingleLine(input.failure.message) },
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
