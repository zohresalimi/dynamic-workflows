/**
 * KAR-06.5 — the retry ladder as a pure function of `(failure.class, policy,
 * attempt, draw)` (docs/05-durable-execution.md §10.3).
 *
 * Every case below hands `planRetry` a `NodeFailure` whose `class` was assigned
 * at construction, and asserts what the scheduler does about it. Nothing here
 * passes a `reason` to a branch: the scenario outline in EPIC-06-S18 varies
 * `reason` *and* `class` precisely so that a planner which secretly read the
 * reason would produce the same answer for two rows that disagree.
 *
 * Verifies: EPIC-06-S18 (scenarios 1, 2 and 4), EPIC-06-S19 (all three) ·
 * AC2, AC5, AC8, AC9
 */
import { expect, it, describe as suite } from 'vitest';
import type { EventSeq, NodeId, ProviderId, RunId } from './ids.ts';
import type { NodeFailure, NodeFailureReason } from './node-failure.ts';
import { DEFAULT_RETRY_POLICY, type RetryPolicy } from './plan-graph.ts';
import { seededRandom } from './random.ts';
import { backoffDelay, backoffWindow, planRetry, reroutePatch } from './retry.ts';

const NOW = 1_754_150_000_000;
const RUN_ID = 'run_20260802T141133Z_9f2a1c' as RunId;
const NODE = 'implement' as NodeId;
const CLAUDE = 'claude-code' as ProviderId;
const CODEX = 'codex' as ProviderId;

/** A failure exactly as the classifier constructs it: `class` is a field. */
function failure(
  reason: NodeFailureReason,
  failureClass: NodeFailure['class'],
  attempt = 0,
  detail?: Record<string, unknown>,
): NodeFailure {
  return {
    reason,
    class: failureClass,
    message: `${reason} at attempt ${attempt}`,
    ...(detail === undefined ? {} : { detail }),
    evidence: [],
    occurredAtEvent: 12 as EventSeq,
    attempt,
  };
}

const policy = (overrides: Partial<RetryPolicy> = {}): RetryPolicy => ({
  ...structuredClone(DEFAULT_RETRY_POLICY),
  ...overrides,
});

/** Half-open draw, so the delay is exactly half the window and easy to read. */
const HALF = 0.5;

// ── the class, and nothing else, decides ─────────────────────────────────────

suite('EPIC-06-S18 scenario 1 — the scheduler reads class and nothing else', () => {
  const rows: readonly [NodeFailureReason, NodeFailure['class'], string][] = [
    ['provider.rate-limited', 'transient', 'retry'],
    ['timeout', 'transient', 'retry'],
    ['adapter.spawn-failed', 'permanent', 'fail'],
    ['contract.schema-invalid', 'permanent', 'fail'],
    ['safety.pathscope-violation', 'permanent', 'fail'],
    ['effect.request-hash-mismatch', 'permanent', 'fail'],
    ['effect.reconcile-unknown', 'gate', 'gate'],
    ['budget.cost-exceeded', 'gate', 'gate'],
    ['agent.schema-repair-exhausted', 'permanent', 'fail'],
  ];

  for (const [reason, failureClass, action] of rows) {
    it(`${reason} (${failureClass}) → ${action}`, () => {
      const plan = planRetry({
        failure: failure(reason, failureClass),
        retry: policy(),
        now: NOW,
        draw: HALF,
      });
      expect(plan.action).toBe(action);
    });
  }

  it('the same reason classifies differently by context, and the plan follows the class', () => {
    const rateLimited = planRetry({
      failure: failure('provider.unavailable', 'transient'),
      retry: policy(),
      now: NOW,
      draw: HALF,
    });
    const uninstalled = planRetry({
      failure: failure('provider.unavailable', 'permanent'),
      retry: policy(),
      now: NOW,
      draw: HALF,
    });

    expect(rateLimited.action).toBe('retry');
    expect(uninstalled.action).toBe('fail');
  });
});

// ── the attempt budget ───────────────────────────────────────────────────────

suite('AC2 — transient schedules n+1 until the budget is spent', () => {
  const transient = (attempt: number) => failure('provider.rate-limited', 'transient', attempt);

  it('attempt 0 of 3 schedules the second attempt', () => {
    const plan = planRetry({ failure: transient(0), retry: policy(), now: NOW, draw: HALF });
    expect(plan).toMatchObject({ action: 'retry', nextAttempt: 1, delayMs: 1000 });
  });

  it('attempt 1 of 3 schedules the third', () => {
    const plan = planRetry({ failure: transient(1), retry: policy(), now: NOW, draw: HALF });
    expect(plan).toMatchObject({ action: 'retry', nextAttempt: 2, delayMs: 2000 });
  });

  it('attempt 2 of 3 is the last one: the node fails, transiently or not', () => {
    const plan = planRetry({ failure: transient(2), retry: policy(), now: NOW, draw: HALF });
    expect(plan).toEqual({ action: 'fail', exhausted: true });
  });

  it('maxAttempts: 1 means no retry at all', () => {
    const plan = planRetry({
      failure: transient(0),
      retry: policy({ maxAttempts: 1 }),
      now: NOW,
      draw: HALF,
    });
    expect(plan).toEqual({ action: 'fail', exhausted: true });
  });

  it('a permanent failure does not spend the budget — it never had one', () => {
    const plan = planRetry({
      failure: failure('adapter.spawn-failed', 'permanent'),
      retry: policy(),
      now: NOW,
      draw: HALF,
    });
    expect(plan).toEqual({ action: 'fail', exhausted: false });
  });
});

// ── full jitter ──────────────────────────────────────────────────────────────

suite('EPIC-06-S19 scenario 1 — the formula and its bounds (AC5)', () => {
  const { base, cap } = DEFAULT_RETRY_POLICY.backoff;

  it('doubles the window per attempt and then holds it at the cap', () => {
    const windows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((attempt) =>
      backoffWindow(attempt, { base, cap }),
    );
    expect(windows).toEqual([
      2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000,
    ]);
  });

  it('applies the cap AFTER the exponent, never before', () => {
    // The red this catches: min(cap, base) * 2 ** (attempt - 1), which agrees
    // with the correct formula for the first eight attempts and then runs away.
    expect(backoffWindow(20, { base, cap })).toBe(cap);
    expect(backoffWindow(64, { base, cap })).toBe(cap);
  });

  it('keeps every delay inside [0, window) for every draw the port can make', () => {
    const random = seededRandom(2026);
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      for (let trial = 0; trial < 200; trial += 1) {
        const delay = backoffDelay(attempt, { base, cap }, random.next());
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(backoffWindow(attempt, { base, cap }));
        expect(Number.isSafeInteger(delay)).toBe(true);
      }
    }
  });

  it('refuses a draw outside [0, 1): a broken port is not a shorter backoff', () => {
    expect(() => backoffDelay(1, { base, cap }, 1)).toThrow(RangeError);
    expect(() => backoffDelay(1, { base, cap }, -0.001)).toThrow(RangeError);
    expect(() => backoffDelay(1, { base, cap }, Number.NaN)).toThrow(RangeError);
  });
});

suite('EPIC-06-S19 scenario 3 — the golden sequence for seed 42', () => {
  it('reproduces attempts 1 through 6 exactly', () => {
    const random = seededRandom(42);
    const { base, cap } = DEFAULT_RETRY_POLICY.backoff;
    const delays = [1, 2, 3, 4, 5, 6].map((attempt) =>
      backoffDelay(attempt, { base, cap }, random.next()),
    );
    expect(delays).toEqual([1202, 1793, 6819, 10715, 5594, 33701]);
  });

  it('reaches the same numbers through planRetry, so the ladder uses the port', () => {
    const random = seededRandom(42);
    const wakes = [0, 1, 2].map((attempt) =>
      planRetry({
        failure: failure('provider.rate-limited', 'transient', attempt),
        retry: policy({ maxAttempts: 10 }),
        now: NOW,
        draw: random.next(),
      }),
    );
    expect(wakes.map((plan) => (plan.action === 'retry' ? plan.wakeAt : null))).toEqual([
      NOW + 1202,
      NOW + 1793,
      NOW + 6819,
    ]);
  });
});

suite('EPIC-06-S19 scenario 2 — 20 correlated failures do not retry in lockstep', () => {
  /** Twenty nodes failing `provider.rate-limited` at the same instant. */
  const storm = (seed: number): number[] => {
    const random = seededRandom(seed);
    return Array.from({ length: 20 }, () => {
      const plan = planRetry({
        failure: failure('provider.rate-limited', 'transient'),
        retry: policy(),
        now: NOW,
        draw: random.next(),
      });
      if (plan.action !== 'retry') throw new Error('a transient failure must schedule a retry');
      return plan.wakeAt;
    });
  };

  const WINDOW = 2_000;

  it('gives all twenty a distinct wake time', () => {
    expect(new Set(storm(42)).size).toBe(20);
  });

  it('spreads them across more than 80% of the [now, now+2000) window', () => {
    const sorted = [...storm(42)].sort((left, right) => left - right);
    const span = (sorted.at(-1) ?? 0) - (sorted[0] ?? 0);
    expect(span).toBeGreaterThan(WINDOW * 0.8);
  });

  it('holds for 200 seeds, not just the one this file happens to name', () => {
    const spans = Array.from({ length: 200 }, (_unused, seed) => {
      const sorted = [...storm(seed + 1)].sort((left, right) => left - right);
      return (sorted.at(-1) ?? 0) - (sorted[0] ?? 0);
    });
    expect(spans.filter((span) => span > WINDOW * 0.8).length).toBeGreaterThanOrEqual(180);
    expect(Math.min(...spans)).toBeGreaterThan(WINDOW * 0.5);
  });

  /**
   * EPIC-06-S19's scenario also says "no two are within 10 ms of each other".
   * That is **not a property full jitter has**, and this test measures it
   * rather than asserting it, because the only way to make it green is to hunt
   * for a seed that happens to satisfy it — a test tuned to pass.
   *
   * The measured truth over 200 seeds: every pair is 10 ms apart in 24 of them
   * (12%), and in 23 of them two nodes land on the *same* millisecond. That is
   * what an independent uniform draw per node does, and the anti-lockstep claim
   * survives it — 20 nodes spread over 1.4 s of a 2 s window do not re-trip a
   * rate limit whether or not two of them share a millisecond.
   *
   * Guaranteeing a minimum separation needs a different strategy (decorrelated
   * or slot-assigned jitter), and `RetryPolicy.backoff.jitter` is deliberately
   * the literal `'full'`: §10.3 names one strategy, and an option nobody
   * implements is a field that lies. The numbers are pinned so that changing
   * the strategy — or the generator — shows up here rather than nowhere.
   */
  it('measures, rather than asserts, the flow’s 10 ms separation clause', () => {
    const minGaps = Array.from({ length: 200 }, (_unused, seed) => {
      const sorted = [...storm(seed + 1)].sort((left, right) => left - right);
      return Math.min(...sorted.slice(1).map((wake, index) => wake - (sorted[index] ?? 0)));
    });
    expect(minGaps.filter((gap) => gap >= 10).length).toBe(24);
    expect(minGaps.filter((gap) => gap === 0).length).toBe(23);
  });
});

// ── onFailure overrides ──────────────────────────────────────────────────────

suite('EPIC-06-S18 scenario 4 — retry.onFailure overrides the class default (AC8)', () => {
  const rerouting = policy({
    onFailure: [{ when: 'provider.rate-limited', action: 'reroute' }],
  });

  it('reroute schedules the retry AND names the provider to move to', () => {
    const plan = planRetry({
      failure: failure('provider.rate-limited', 'transient'),
      retry: rerouting,
      now: NOW,
      draw: HALF,
      providers: { current: CLAUDE, prefer: [CLAUDE, CODEX] },
    });
    expect(plan).toEqual({
      action: 'reroute',
      nextAttempt: 1,
      delayMs: 1000,
      wakeAt: NOW + 1000,
      provider: CODEX,
    });
  });

  it('a reroute with nowhere to go is an ordinary retry, not a silent no-op patch', () => {
    const plan = planRetry({
      failure: failure('provider.rate-limited', 'transient'),
      retry: rerouting,
      now: NOW,
      draw: HALF,
      providers: { current: CLAUDE, prefer: [CLAUDE] },
    });
    expect(plan).toEqual({ action: 'retry', nextAttempt: 1, delayMs: 1000, wakeAt: NOW + 1000 });
  });

  it('escalate turns a transient failure into a gate', () => {
    const plan = planRetry({
      failure: failure('timeout', 'transient'),
      retry: policy({ onFailure: [{ when: 'timeout', action: 'escalate' }] }),
      now: NOW,
      draw: HALF,
    });
    expect(plan).toEqual({ action: 'gate' });
  });

  it('retry turns a permanent failure into a retry, because the plan said so', () => {
    const plan = planRetry({
      failure: failure('adapter.spawn-failed', 'permanent'),
      retry: policy({ onFailure: [{ when: 'adapter.spawn-failed', action: 'retry' }] }),
      now: NOW,
      draw: HALF,
    });
    expect(plan).toMatchObject({ action: 'retry', nextAttempt: 1 });
  });

  it('an entry for another reason does not apply', () => {
    const plan = planRetry({
      failure: failure('adapter.spawn-failed', 'permanent'),
      retry: policy({ onFailure: [{ when: 'timeout', action: 'retry' }] }),
      now: NOW,
      draw: HALF,
    });
    expect(plan.action).toBe('fail');
  });

  it('an override still respects the attempt budget', () => {
    const plan = planRetry({
      failure: failure('adapter.spawn-failed', 'permanent', 2),
      retry: policy({ onFailure: [{ when: 'adapter.spawn-failed', action: 'retry' }] }),
      now: NOW,
      draw: HALF,
    });
    expect(plan).toEqual({ action: 'fail', exhausted: true });
  });
});

suite('AC9 — a budget ceiling is a gate no override can turn into a failure', () => {
  for (const reason of ['budget.cost-exceeded', 'budget.wallclock-exceeded'] as const) {
    it(`${reason} gates even when onFailure asks for a retry`, () => {
      const plan = planRetry({
        failure: failure(reason, 'gate', 0, {
          scope: 'run',
          dimension: reason === 'budget.cost-exceeded' ? 'cost' : 'wallclock',
          limit: 10,
          actual: 11,
        }),
        retry: policy({ onFailure: [{ when: reason, action: 'retry' }] }),
        now: NOW,
        draw: HALF,
      });
      expect(plan).toEqual({ action: 'gate' });
    });
  }

  it('effect.reconcile-unknown is immune to an override too', () => {
    const plan = planRetry({
      failure: failure('effect.reconcile-unknown', 'gate'),
      retry: policy({ onFailure: [{ when: 'effect.reconcile-unknown', action: 'retry' }] }),
      now: NOW,
      draw: HALF,
    });
    expect(plan).toEqual({ action: 'gate' });
  });
});

// ── the reroute patch ────────────────────────────────────────────────────────

suite('AC8 — a reroute is a PlanPatch proposal, visible in the scrubber (F3.9)', () => {
  const patch = reroutePatch({
    runId: RUN_ID,
    node: NODE,
    provider: CODEX,
    nextAttempt: 1,
    failure: failure('provider.rate-limited', 'transient'),
  });

  it('replaces the provider and touches nothing else', () => {
    expect(patch.ops).toEqual([{ op: 'replace-provider', node: NODE, provider: CODEX }]);
  });

  it('is proposed by the scheduler, so the scrubber can say who moved it', () => {
    expect(patch.proposedBy).toBe('scheduler');
  });

  it('carries a reason a human can read, naming the failure that caused it', () => {
    expect(patch.reason).toContain('provider.rate-limited');
    expect(patch.reason).toContain('codex');
  });

  it('declares a policy block the F2.5 engine can rule on without defaults', () => {
    expect(patch.policy).toEqual({
      estimatedCostDeltaUsd: 0,
      estimatedWallClockDeltaMs: 0,
      blastRadius: { paths: [], nodeCount: 1 },
      replanDepth: 0,
      escalatesPermission: null,
      addsWriteCapability: false,
    });
  });

  it('has a deterministic id, so the same reroute proposed twice is one patch', () => {
    const again = reroutePatch({
      runId: RUN_ID,
      node: NODE,
      provider: CODEX,
      nextAttempt: 1,
      failure: failure('provider.rate-limited', 'transient'),
    });
    expect(again.id).toBe(patch.id);
    expect(patch.id).not.toBe(
      reroutePatch({
        runId: RUN_ID,
        node: NODE,
        provider: CODEX,
        nextAttempt: 2,
        failure: failure('provider.rate-limited', 'transient'),
      }).id,
    );
  });
});
