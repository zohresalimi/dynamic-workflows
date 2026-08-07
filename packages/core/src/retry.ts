/**
 * KAR-06.5 — the retry ladder: what a classified failure means, and when the
 * next attempt is due (docs/05-durable-execution.md §10.3).
 *
 * Pure, like `decide()` beside it, and for the same reason: the delay is drawn
 * from a number this module is *handed*, never from a generator it reaches for,
 * so the same `(failure, policy, draw, now)` produces the same plan in this
 * process, in a replay and on another machine.
 *
 * Three rules govern every line below.
 *
 * 1. **The class decides, and nothing else.** `class` was assigned when the
 *    `NodeFailure` was constructed, by the code that knew which situation it was
 *    in — `provider.unavailable` is transient for a rate-limited vendor and
 *    permanent for a binary the user uninstalled mid-run. Nothing here names a
 *    reason; `packages/core/test/scheduler-reads-class.test.ts` keeps it that
 *    way, and the two questions this module does have to ask about a reason
 *    (`escalatesToHuman`, and whether an `onFailure` entry matches) are asked of
 *    the classifier module or answered by data from the plan.
 * 2. **Full jitter, and only full jitter.** `delay = draw * min(cap, base * 2 **
 *    (attempt - 1))`. Not equal jitter, not none, because the common failure
 *    here is *correlated*: several nodes hit the same vendor rate limit at the
 *    same moment, and retrying in lockstep re-trips it. `RetryPolicy.backoff.
 *    jitter` is the literal `'full'` for the same reason — an option nobody
 *    implements is a field that lies.
 * 3. **The cap applies after the exponent.** `min(cap, base * 2 ** n)`, never
 *    `min(cap, base) * 2 ** n`. The two agree for the first eight attempts and
 *    then diverge without limit, which is about the worst shape a bug can have.
 *
 * Verifies: EPIC-06-S18, EPIC-06-S19 · AC2, AC5, AC8, AC9
 */
import type { NodeId, ProviderId, RunId } from './ids.ts';
import { escalatesToHuman, type NodeFailure } from './node-failure.ts';
import type { RetryPolicy } from './plan-graph.ts';
import { type PatchCause, PLANPATCH_SCHEMA_ID, type PlanPatch } from './plan-patch.ts';
import { toSingleLine } from './text.ts';

/** The exponential window an attempt's delay is drawn from, in milliseconds. */
export interface Backoff {
  readonly base: number;
  readonly cap: number;
}

/**
 * `min(cap, base * 2 ** (attempt - 1))` — the *width* of the window, not the
 * delay.
 *
 * `attempt` is 1-based here, matching §10.3 and EPIC-06-S19: attempt 1 draws
 * from `[0, 2000)`, attempt 8 from `[0, 256000)`, and attempt 9 and beyond from
 * `[0, 300000)`. A large attempt number overflows `2 ** n` to `Infinity`, and
 * `Math.min` then returns the cap — which is the right answer, arrived at
 * without a special case.
 */
export function backoffWindow(attempt: number, backoff: Backoff): number {
  return Math.min(backoff.cap, backoff.base * 2 ** (attempt - 1));
}

/**
 * The delay itself: `floor(draw * window)`, so `0 <= delay < window` (AC5).
 *
 * Floored to a whole millisecond because the delay becomes `node_wake.wake_at`,
 * an `INTEGER` in a `STRICT` table. A float there is a wait that compares
 * *almost* correctly, and "the retry fired 0.4 ms early" is not a failure
 * anybody would ever debug.
 *
 * A draw outside `[0, 1)` throws rather than clamping. The only way to get one
 * is a broken `Random` implementation, and a broken port must not quietly
 * become a shorter backoff against a vendor that is already rate-limiting.
 */
export function backoffDelay(attempt: number, backoff: Backoff, draw: number): number {
  if (!(draw >= 0 && draw < 1)) {
    throw new RangeError(
      `a Random draw must be in [0, 1); got ${String(draw)}. Full jitter multiplies the draw by ` +
        'the backoff window, so a draw outside the unit interval is a wait of the wrong length ' +
        'rather than a rounding error.',
    );
  }
  return Math.floor(draw * backoffWindow(attempt, backoff));
}

/** What the scheduler should do about one classified failure. */
export type RetryPlan =
  | {
      readonly action: 'retry';
      /**
       * The attempt index the retry will run at — 0-based, so it is also the
       * count of attempts already spent, and it goes straight into the
       * idempotency key. A retry therefore mints a new key by construction,
       * which is what distinguishes it from a crash-resume of the same attempt.
       */
      readonly nextAttempt: number;
      readonly delayMs: number;
      /** An absolute instant, because the wait outlives the process. */
      readonly wakeAt: number;
    }
  | {
      readonly action: 'reroute';
      readonly nextAttempt: number;
      readonly delayMs: number;
      readonly wakeAt: number;
      /** The provider the patch proposal moves the node to. */
      readonly provider: ProviderId;
    }
  | {
      readonly action: 'fail';
      /** True when a retryable failure ran out of attempts rather than being
       * unretryable in the first place — the difference between "this cannot
       * work" and "this did not work three times". */
      readonly exhausted: boolean;
    }
  | { readonly action: 'gate' };

export interface RetryPlanInput {
  /** Already classified. `class` is read; `reason` is only ever *matched*. */
  readonly failure: NodeFailure;
  readonly retry: RetryPolicy;
  /** The instant the failure was recorded at, from the `Clock` port. */
  readonly now: number;
  /** One draw from the `Random` port, in `[0, 1)`. */
  readonly draw: number;
  /** Where a `reroute` would move the node to, when the plan asks for one. */
  readonly providers?: {
    readonly current: ProviderId | null;
    readonly prefer: readonly ProviderId[];
  };
}

/**
 * The whole ladder (AC2, AC8, AC9).
 *
 * Order of precedence, and each step is a decision worth stating:
 *
 *   1. A gate-only reason wins over everything. The taxonomy refuses to
 *      classify a budget breach or a `reconcile-unknown` as anything but
 *      `gate`, and an `onFailure` entry must not be able to route around a
 *      schema-level guarantee — otherwise "add a retry for the ceiling" is one
 *      YAML line away from a run that dies with hours of work half-done.
 *   2. An `onFailure` entry for this reason overrides the class default. This
 *      is data from the plan being matched, not a branch on the reason: F4.5
 *      makes "retry with a different provider" policy on the node rather than a
 *      decision buried in the scheduler.
 *   3. Otherwise the class decides.
 *
 * And in every retrying branch, the attempt budget is checked last: an override
 * changes *what* a failure means, never how many times a node may run.
 */
export function planRetry(input: RetryPlanInput): RetryPlan {
  const { failure, retry } = input;

  if (escalatesToHuman(failure.reason)) return { action: 'gate' };

  const override = retry.onFailure?.find((entry) => entry.when === failure.reason)?.action;
  if (override === 'escalate') return { action: 'gate' };
  if (override === 'retry') return schedule(input, false);
  if (override === 'reroute') return schedule(input, true);

  if (failure.class === 'gate') return { action: 'gate' };
  if (failure.class === 'permanent') return { action: 'fail', exhausted: false };
  return schedule(input, false);
}

/**
 * The retrying half: attempt `n` just failed, so attempt `n + 1` is due after a
 * jittered delay — unless the budget is spent, in which case the node fails
 * with that last failure preserved (AC2).
 *
 * `failure.attempt` is the 0-based index of the attempt that failed, so
 * `attempt + 1` is both the number of attempts spent and the index of the next
 * one. `maxAttempts` (default 3, F7.5's surgical-repair cap) bounds it.
 */
function schedule(input: RetryPlanInput, reroute: boolean): RetryPlan {
  const { failure, retry, now, draw } = input;
  const nextAttempt = failure.attempt + 1;
  if (nextAttempt >= retry.maxAttempts) return { action: 'fail', exhausted: true };

  // 1-based for the formula: the attempt that just failed is the first one.
  const delayMs = backoffDelay(nextAttempt, retry.backoff, draw);
  const wakeAt = now + delayMs;

  const provider = reroute ? alternativeProvider(input) : null;
  return provider === null
    ? { action: 'retry', nextAttempt, delayMs, wakeAt }
    : { action: 'reroute', nextAttempt, delayMs, wakeAt, provider };
}

/**
 * The next provider in the node's preference list after the one that just
 * failed, or `null` when the plan offers no alternative.
 *
 * `null` degrades a `reroute` to an ordinary `retry` rather than proposing a
 * patch that changes nothing: a no-op `replace-provider` op in the scrubber is
 * worse than no patch, because it claims a decision was made.
 */
function alternativeProvider(input: RetryPlanInput): ProviderId | null {
  const providers = input.providers;
  if (providers === undefined) return null;
  return providers.prefer.find((candidate) => candidate !== providers.current) ?? null;
}

export interface ReroutePatchInput {
  readonly runId: RunId;
  readonly node: NodeId;
  readonly provider: ProviderId;
  readonly nextAttempt: number;
  readonly failure: NodeFailure;
  /**
   * KAR-14.4 AC7 — why the scheduler is moving this node, when it knows.
   *
   * Rendered into the patch's own `reason`, which the scrubber prints verbatim,
   * and carried as data on `plan.patch.proposed` beside the patch. Absent for a
   * reroute driven by an ordinary `onFailure: reroute` entry, which is a policy
   * the plan asked for rather than a vendor refusing to serve.
   */
  readonly cause?: PatchCause | undefined;
}

/**
 * The `PlanPatch` a reroute proposes (AC8, F3.9).
 *
 * Automatic re-routing to a healthy provider is recorded as a patch *precisely*
 * so it shows up in the plan-evolution scrubber: a silent provider swap is
 * exactly the kind of thing that makes a run's cost profile inexplicable
 * afterwards. `proposedBy: 'scheduler'` is in the vocabulary for this case.
 *
 * The id is derived from `(run, node, attempt)` rather than generated, so the
 * same reroute proposed twice — by a retry of the same attempt after a crash —
 * is one patch rather than two competing ones.
 *
 * The `policy` block is all zeroes and `false`, and that is a claim rather than
 * a placeholder: swapping which vendor runs an existing node inserts no nodes,
 * widens no path scope, escalates no permission and adds no write capability.
 * The cost delta is genuinely unknown at this point (the F9.3 estimator is
 * KAR-14.3's), and zero is the honest neutral for a rule comparing against a
 * threshold.
 */
export function reroutePatch(input: ReroutePatchInput): PlanPatch {
  return {
    schemaId: PLANPATCH_SCHEMA_ID,
    id: `reroute-${input.runId}-${input.node}-${input.nextAttempt}`,
    proposedBy: 'scheduler',
    reason: toSingleLine(
      `${input.node} failed with ${input.failure.reason}${
        // Named in the prose as well as carried as data, because this string is
        // what the plan scrubber renders and F3.9's whole point is that the
        // swap is explicable there without opening the ledger.
        input.cause === undefined ? '' : ` (cause: ${input.cause})`
      }; retrying attempt ${input.nextAttempt} on ${input.provider}`,
    ),
    ops: [{ op: 'replace-provider', node: input.node, provider: input.provider }],
    policy: {
      estimatedCostDeltaUsd: 0,
      estimatedWallClockDeltaMs: 0,
      blastRadius: { paths: [], nodeCount: 1 },
      replanDepth: 0,
      escalatesPermission: null,
      addsWriteCapability: false,
    },
  };
}
