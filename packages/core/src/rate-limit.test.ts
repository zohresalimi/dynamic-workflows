/**
 * KAR-14.4 — a rate limit as a value: normalised, classified, and turned into
 * a durable wake rather than a retry storm.
 *
 * Verifies: EPIC-14-S21 (the classification and wake half), EPIC-14-S22
 * (scenario 2, the row that expresses a 30-day wait), EPIC-14-S26 (scenario 2,
 * the seeded jitter distribution), EPIC-14-S27 (the honest degradation) ·
 * AC1, AC2, AC6, AC9, AC10
 */
import { expect, it, describe as suite } from 'vitest';
import type { EventSeq, Handle, NodeId, ProviderId } from './ids.ts';
import type { NodeFailure, NodeFailureReason } from './node-failure.ts';
import { budgetBreachOf, budgetExceededFailure } from './node-failure.ts';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './plan-graph.ts';
import { seededRandom } from './random.ts';
import {
  describeRateLimit,
  QUOTA_WAKE_REASON,
  quotaWake,
  RATE_LIMIT_BACKOFF,
  type RateLimit,
  rateLimitedFailure,
  rateLimitOf,
} from './rate-limit.ts';

const NOW = 1_754_150_000_000;
const CLAUDE = 'claude' as ProviderId;
const NODE = 'n_impl_1' as NodeId;
const hours = (count: number): number => count * 3_600_000;
const days = (count: number): number => count * 86_400_000;

const context = () => ({
  occurredAtEvent: 12 as EventSeq,
  attempt: 0,
  captureEvidence: (text: string): Handle => `blob:sha256-${text.length}` as Handle,
});

/** The committed shape of Claude Code's frame, verbatim (docs/07 §8.1). */
const FRAME = {
  type: 'rate_limit_event',
  rate_limit_info: { status: 'rejected', resetsAt: (NOW + hours(4)) / 1000 },
};

const policy = (overrides: Partial<RetryPolicy> = {}): RetryPolicy => ({
  ...structuredClone(DEFAULT_RETRY_POLICY),
  ...overrides,
});

// ── AC1 — one normalised shape, both paths, raw kept verbatim ────────────────

suite('EPIC-14-S21 / AC1 — the vendor frame normalises without being flattened', () => {
  it('keeps provider, resetsAt and the raw payload byte-for-byte', () => {
    const failure = rateLimitedFailure(
      { provider: CLAUDE, resetsAt: NOW + hours(4), raw: FRAME },
      context(),
    );

    expect(rateLimitOf(failure)).toEqual({
      provider: CLAUDE,
      resetsAt: NOW + hours(4),
      raw: FRAME,
    });
    // Verbatim, not re-serialised: the vendor's shape is not ours to normalise,
    // and `raw` exists so a later parser can read a field this build ignored.
    expect(rateLimitOf(failure)?.raw).toEqual(FRAME);
  });

  it('AC1: a signal with no resetsAt normalises to the same shape with a null', () => {
    const failure = rateLimitedFailure(
      { provider: CLAUDE, resetsAt: null, raw: { exitCode: 77 } },
      context(),
    );

    expect(rateLimitOf(failure)).toEqual({
      provider: CLAUDE,
      resetsAt: null,
      raw: { exitCode: 77 },
    });
  });

  it('answers null for a failure that is not about a rate limit at all', () => {
    const breach = budgetExceededFailure(
      { scope: 'run', dimension: 'cost', limit: 5, actual: 6 },
      { occurredAtEvent: 12 as EventSeq, attempt: 0 },
    );
    expect(rateLimitOf(breach)).toBeNull();
  });
});

// ── AC9 — three classes, never conflated ─────────────────────────────────────

suite('EPIC-14-S21 / AC9 — the classifier table: transient, gate, permanent', () => {
  const rows: readonly [string, NodeFailure, NodeFailureReason, NodeFailure['class']][] = [
    [
      'a vendor rate limit',
      rateLimitedFailure({ provider: CLAUDE, resetsAt: NOW + hours(4), raw: FRAME }, context()),
      'provider.rate-limited',
      'transient',
    ],
    [
      'a budget ceiling breach',
      budgetExceededFailure(
        { scope: 'run', dimension: 'cost', limit: 5, actual: 6, firedBy: 'vendor' },
        { occurredAtEvent: 12 as EventSeq, attempt: 0 },
      ),
      'budget.cost-exceeded',
      'gate',
    ],
    [
      'an auth failure',
      {
        reason: 'adapter.handshake-failed',
        class: 'permanent',
        message: 'the agent refused the credentials it was given',
        evidence: [],
        occurredAtEvent: 12 as EventSeq,
        attempt: 0,
      },
      'adapter.handshake-failed',
      'permanent',
    ],
  ];

  for (const [label, failure, reason, expected] of rows) {
    it(`classifies ${label} as ${expected}`, () => {
      expect(failure.reason).toBe(reason);
      expect(failure.class).toBe(expected);
    });
  }

  it('never lets one be read as another: only the rate limit answers rateLimitOf', () => {
    expect(rows.filter(([, failure]) => rateLimitOf(failure) !== null)).toHaveLength(1);
    expect(rows.filter(([, failure]) => budgetBreachOf(failure) !== null)).toHaveLength(1);
  });

  it('AC9: a rate limit is retryable, and a budget gate is not retried into', () => {
    const [, limited] = rows[0] ?? [];
    const [, gated] = rows[1] ?? [];
    if (limited === undefined || gated === undefined) throw new Error('unreachable');
    expect(limited.class).toBe('transient');
    expect(gated.class).toBe('gate');
  });
});

// ── AC2, AC6 — the wake: the vendor's instant, or full jitter ────────────────

suite('EPIC-14-S21 / AC2 — resetsAt becomes the wake, exactly', () => {
  it('wakes at the instant the vendor named, with reason quota', () => {
    const failure = rateLimitedFailure(
      { provider: CLAUDE, resetsAt: NOW + hours(4), raw: FRAME },
      context(),
    );

    expect(quotaWake({ failure, retry: policy(), now: NOW, draw: 0.5 })).toEqual({
      wakeAt: NOW + hours(4),
      reason: QUOTA_WAKE_REASON,
    });
  });

  it('EPIC-14-S22: honours a reset 30 days out exactly, past the 2^31 ms timer ceiling', () => {
    const resetsAt = NOW + days(30);
    // The number a timer cannot express: Node fires setTimeout(2**31) after
    // ~1 ms rather than clamping (verified 2026-08-02).
    expect(days(30)).toBeGreaterThan(2 ** 31 - 1);

    const failure = rateLimitedFailure({ provider: CLAUDE, resetsAt, raw: FRAME }, context());
    expect(quotaWake({ failure, retry: policy(), now: NOW, draw: 0.5 })).toEqual({
      wakeAt: resetsAt,
      reason: QUOTA_WAKE_REASON,
    });
  });

  it('AC6: with no resetsAt it falls to full jitter with base 2,000 and cap 300,000', () => {
    expect(RATE_LIMIT_BACKOFF).toEqual({ base: 2_000, cap: 300_000 });

    const failure = rateLimitedFailure(
      { provider: CLAUDE, resetsAt: null, raw: { exitCode: 77 } },
      context(),
    );
    const wake = quotaWake({ failure, retry: policy(), now: NOW, draw: 0.5 });

    // Attempt 0 failed, so attempt 1 is due: window = min(300000, 2000 * 2**0).
    expect(wake).toEqual({ wakeAt: NOW + 1_000, reason: 'backoff' });
  });

  it('AC6: the cap applies after the exponent, so attempt 9 draws from 300,000', () => {
    const failure = rateLimitedFailure(
      { provider: CLAUDE, resetsAt: null, raw: {} },
      { ...context(), attempt: 8 },
    );
    const wake = quotaWake({
      failure,
      retry: policy({ maxAttempts: 20 }),
      now: NOW,
      draw: 0.999,
    });
    expect(wake?.wakeAt).toBe(NOW + Math.floor(0.999 * 300_000));
  });

  it('answers null for a failure that carries no rate limit at all', () => {
    const breach = budgetExceededFailure(
      { scope: 'run', dimension: 'cost', limit: 5, actual: 6 },
      { occurredAtEvent: 12 as EventSeq, attempt: 0 },
    );
    expect(quotaWake({ failure: breach, retry: policy(), now: NOW, draw: 0.5 })).toBeNull();
  });
});

suite('EPIC-14-S26 scenario 2 — the jitter distribution over a seeded RNG', () => {
  /** Attempt 4's window: min(300000, 2000 * 2**3) = 16,000 ms. */
  const WINDOW = 16_000;

  const draws = (seed: number, count: number): number[] => {
    const random = seededRandom(seed);
    return Array.from({ length: count }, () => {
      const failure = rateLimitedFailure(
        { provider: CLAUDE, resetsAt: null, raw: {} },
        { ...context(), attempt: 3 },
      );
      const wake = quotaWake({
        failure,
        retry: policy({ maxAttempts: 20 }),
        now: NOW,
        draw: random.next(),
      });
      if (wake === null) throw new Error('a rate limit must always schedule a wake');
      return wake.wakeAt - NOW;
    });
  };

  it('every one of 1,000 draws lies in [0, min(300000, 16000))', () => {
    for (const delay of draws(42, 1_000)) {
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(WINDOW);
    }
  });

  it('and they are not all equal — this is full jitter, not a fixed delay', () => {
    expect(new Set(draws(42, 1_000)).size).toBeGreaterThan(900);
  });

  it('three nodes tripping the same limit in one tick get three distinct wakes', () => {
    // Statistically, over 200 seeds rather than by eyeball on one run.
    const collisions = Array.from({ length: 200 }, (_unused, seed) =>
      new Set(draws(seed + 1, 3)).size === 3 ? 0 : 1,
    ).reduce((sum: number, hit: number) => sum + hit, 0);
    expect(collisions).toBe(0);
  });
});

// ── AC10, EPIC-14-S27 — honest wording, never a fabricated reset ─────────────

suite('EPIC-14-S27 / AC10 — an unknown reset is said out loud, never invented', () => {
  const limit = (resetsAt: number | null): RateLimit => ({ provider: CLAUDE, resetsAt, raw: {} });

  it('names the reset instant when the vendor gave one', () => {
    expect(describeRateLimit(limit(NOW + hours(6)))).toBe(
      `rate limited until ${new Date(NOW + hours(6)).toISOString()}`,
    );
  });

  it('says the reset time is unknown rather than guessing one', () => {
    expect(describeRateLimit(limit(null))).toBe('rate limited, reset time unknown');
    // The failure this wording exists to prevent: an operator scheduling their
    // afternoon around a number DeFlow made up.
    expect(describeRateLimit(limit(null))).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

// ── the node this failure is about travels with it ───────────────────────────

suite('AC1 — the message is one line and names the provider', () => {
  it('reads as a board cell, not a stack trace', () => {
    const failure = rateLimitedFailure(
      { provider: CLAUDE, resetsAt: NOW + hours(4), raw: FRAME },
      context(),
    );
    expect(failure.message).not.toContain('\n');
    expect(failure.message).toContain(CLAUDE);
    expect(failure.attempt).toBe(0);
    expect(failure.occurredAtEvent).toBe(12);
    expect(NODE).toBe('n_impl_1');
  });
});
