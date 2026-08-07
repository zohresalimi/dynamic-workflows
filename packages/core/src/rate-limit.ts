/**
 * KAR-14.4 — a rate limit as a value, and the wait it becomes
 * (docs/06-planning-and-replanning.md §4.4, docs/07-provider-adapter-layer.md
 * §8.1).
 *
 * This is the story the days-long horizon depends on. **Verified 2026-08-02**,
 * Claude Code's `stream-json` emits
 * `{"type":"rate_limit_event","rate_limit_info":{ … }}` carrying `resetsAt`,
 * and the whole point of reading it is that a rate limit then costs **one
 * SQLite row and zero CPU** instead of the rest of the node's retry budget.
 *
 * Four decisions, each of which is a bug if reversed.
 *
 * 1. **`raw` is kept verbatim.** The vendor's shape is not ours to normalise,
 *    and a field this build ignores is one a later build re-parses off the
 *    ledger without a re-run. So the normalised value carries `{ provider,
 *    resetsAt, raw }` and `raw` is stored as it arrived.
 * 2. **A missing `resetsAt` is `null`, never a guess.** Inventing a plausible
 *    reset so a surface has something to render is the same failure as a
 *    fabricated compaction figure: the operator schedules their afternoon
 *    around it. `describeRateLimit` says *"reset time unknown"* out loud, and
 *    the retry falls to full jitter — which is blind, and honestly labelled.
 * 3. **The class is `transient`, and it is assigned here.** Not derived from
 *    the reason anywhere downstream (docs/04-domain-model.md §8): a rate limit
 *    is retryable, optionally on a different provider, and is never conflated
 *    with a budget `gate` or a `permanent` auth failure. `rateLimitOf` is how
 *    a scheduler asks "is this about a quota?" without naming a reason, the
 *    same shape `budgetBreachOf` has next door and for the same rule.
 * 4. **The wait is an instant, never a delay.** `quotaWake` returns a `wakeAt`
 *    that goes straight into `node_wake`. **Verified 2026-08-02:** Node's
 *    maximum timer delay is `2**31 - 1` ms (24.9 days) and passing `2**31`
 *    neither throws nor clamps — it fires the callback after **1 ms** with only
 *    a `TimeoutOverflowWarning` on stderr. A monthly quota reset is past that
 *    ceiling, and a timer would honour it by firing immediately.
 *
 * Verifies: EPIC-14-S21, EPIC-14-S22, EPIC-14-S26, EPIC-14-S27 ·
 * AC1, AC2, AC6, AC9, AC10
 */
import type { WakeReason } from './command.ts';
import type { ProviderId } from './ids.ts';
import type { NodeFailure, ToNodeFailureContext } from './node-failure.ts';
import type { RetryPolicy } from './plan-graph.ts';
import type { PatchCause } from './plan-patch.ts';
import { type Backoff, backoffDelay } from './retry.ts';
import { toSingleLine } from './text.ts';

/**
 * §10.3's numbers, named once. Full jitter over `min(cap, base * 2 ** (n - 1))`
 * with base 2,000 ms and cap 300,000 ms — the same pair `DEFAULT_RETRY_POLICY`
 * ships, restated here because AC6 fixes them for *this* failure specifically
 * and a node that narrowed its own backoff must not narrow the one thing that
 * exists to stop several nodes re-tripping the same vendor limit in lockstep.
 */
export const RATE_LIMIT_BACKOFF: Backoff = Object.freeze({ base: 2_000, cap: 300_000 });

/**
 * The `node_wake.reason` a suspension until a vendor's own reset is written
 * under, and the `NodeSuspension.kind` that matches it. One literal, so the
 * value the timeline renders is the value on the row.
 */
export const QUOTA_WAKE_REASON = 'quota';

/**
 * The `cause` a re-route proposed *because of* a rate limit carries
 * (docs/06-planning-and-replanning.md §4.4).
 *
 * The same literal as the wake reason, and deliberately so: one word answers
 * "why is this node asleep" and "why did this node change vendor", and a
 * scrubber showing both should not have to translate between two vocabularies
 * for the same event.
 *
 * It travels on `plan.patch.proposed` rather than inside the `PlanPatch`
 * document itself. `DeFlow.planpatch.v1` is a shipped, content-pinned schema
 * (schemas/CHANGELOG.md) and adding a field to it is a `.v2` — a change that
 * belongs to EPIC-11's patch application, not to this story. The cause is a
 * fact about *the proposal*, so the proposal is where it goes.
 */
export const QUOTA_CAUSE: PatchCause = 'quota';

/** The normalised rate-limit signal (AC1) — one shape for both paths. */
export interface RateLimit {
  readonly provider: ProviderId;
  /** ms epoch, or `null` when the vendor said it was limited and not when it
   * lifts. Never inferred: see `describeRateLimit`. */
  readonly resetsAt: number | null;
  /** The vendor payload, verbatim, for later re-parsing. */
  readonly raw: unknown;
}

/** The key `detail` carries a normalised limit under. Deliberately not the
 * root of `detail`: a rate limit reported by an adapter may bring diagnostic
 * fields of its own, and nesting keeps the two from colliding. */
const RATE_LIMIT_DETAIL = 'rateLimit';

/**
 * A rate limit as a failure (AC1, AC9).
 *
 * `class: 'transient'` is a claim about the situation rather than a lookup on
 * the reason — which is the rule this module lives under. The vendor said it
 * will serve this node again, and it said when; that is the definition of
 * retryable, and the difference between it and a `permanent` auth refusal is
 * exactly the difference between waiting and giving up.
 */
export function rateLimitedFailure(limit: RateLimit, ctx: ToNodeFailureContext): NodeFailure {
  const tag = rateLimitFailureTag(limit);
  return {
    reason: tag.reason,
    class: tag.class,
    message: rateLimitMessage(limit),
    detail: tag.detail,
    evidence: [],
    occurredAtEvent: ctx.occurredAtEvent,
    attempt: ctx.attempt,
  };
}

/** The one line a board cell renders, and the one a thrower's message uses. */
export function rateLimitMessage(limit: RateLimit): string {
  return toSingleLine(`${limit.provider}: ${describeRateLimit(limit)}`);
}

/**
 * The same failure, as the tag an *adapter* throws with (AC1, AC9).
 *
 * Exported so no other package spells `detail.rateLimit`: an adapter that
 * reaches a rate limit by a different route — a vendor frame, an exit code the
 * caller declared — produces a failure `rateLimitOf` can read back, without a
 * second copy of the key. One key, one reader, no drift.
 */
export function rateLimitFailureTag(limit: RateLimit): {
  readonly reason: 'provider.rate-limited';
  readonly class: 'transient';
  readonly detail: Record<string, unknown>;
} {
  return {
    reason: 'provider.rate-limited',
    class: 'transient',
    detail: { [RATE_LIMIT_DETAIL]: { ...limit } },
  };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * The limit a failure describes, or `null` when it is not about one (AC9).
 *
 * Asked rather than a `reason` comparison, so no scheduling module names
 * `provider.rate-limited` — `packages/core/test/scheduler-reads-class.test.ts`
 * enforces that, and this is the escape hatch it leaves open. A malformed
 * `detail` reads as `null`: the failure is still transient and still retried,
 * it simply cannot claim a reset instant nobody supplied.
 */
export function rateLimitOf(failure: NodeFailure): RateLimit | null {
  const nested = asRecord(failure.detail?.[RATE_LIMIT_DETAIL]);
  if (nested === null) return null;

  const provider = nested.provider;
  if (typeof provider !== 'string' || provider === '') return null;

  const resetsAt = nested.resetsAt;
  const validReset = typeof resetsAt === 'number' && Number.isInteger(resetsAt) && resetsAt >= 0;

  return {
    provider: provider as ProviderId,
    resetsAt: validReset ? resetsAt : null,
    raw: nested.raw,
  };
}

/** What one wait is: the instant, and why the row says the node is asleep. */
export interface QuotaWake {
  readonly wakeAt: number;
  readonly reason: WakeReason;
}

export interface QuotaWakeInput {
  /** Already classified, and carrying the limit under `detail`. */
  readonly failure: NodeFailure;
  /** The failing node's own policy — `maxAttempts` is *not* consulted here;
   * whether an attempt remains is `planRetry`'s question. */
  readonly retry: RetryPolicy;
  /** The instant the failure was recorded at, from the `Clock` port. */
  readonly now: number;
  /** One draw from the `Random` port, in `[0, 1)`. Used only when the vendor
   * named no reset. */
  readonly draw: number;
}

/**
 * When this node should be looked at again, and under which reason (AC2, AC6).
 *
 * Two answers, and the preference between them is the story:
 *
 *   - the vendor named an instant → wake **exactly** then, `reason: 'quota'`.
 *     Not `resetsAt + a margin`, not `min(resetsAt, something)`: the row is the
 *     vendor's own statement, and a 30-day reset is honoured as 30 days
 *     because a row has no ceiling a timer would silently impose;
 *   - it did not → full jitter over `min(cap, base * 2 ** (attempt - 1))`,
 *     `reason: 'backoff'`. Full rather than equal or none because the common
 *     failure here is *correlated*: several nodes hit the same vendor limit in
 *     the same tick, and lockstep retries re-trip it.
 *
 * `null` for a failure that is not about a rate limit at all, so a caller can
 * ask without first knowing.
 */
export function quotaWake(input: QuotaWakeInput): QuotaWake | null {
  const limit = rateLimitOf(input.failure);
  if (limit === null) return null;

  if (limit.resetsAt !== null) {
    return { wakeAt: limit.resetsAt, reason: QUOTA_WAKE_REASON };
  }

  // 1-based for the formula: the attempt that just failed is the first one.
  const attempt = input.failure.attempt + 1;
  const delayMs = backoffDelay(attempt, input.retry.backoff, input.draw);
  return { wakeAt: input.now + delayMs, reason: 'backoff' };
}

/**
 * One line an operator can act on (AC10, EPIC-14-S27).
 *
 * The wording of the second arm is the point. *"rate limited, reset time
 * unknown"* rather than a plausible-looking instant: a fabricated reset is
 * worse than an honest gap, because a surface that renders one is a surface
 * somebody plans around.
 */
export function describeRateLimit(limit: RateLimit): string {
  return limit.resetsAt === null
    ? 'rate limited, reset time unknown'
    : `rate limited until ${new Date(limit.resetsAt).toISOString()}`;
}
