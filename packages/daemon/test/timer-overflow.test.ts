/**
 * EPIC-06-S21 scenario 1 — the verified Node behaviour this whole design routes
 * around (KAR-06.6 AC5).
 *
 * This is a regression test against **Node itself**, not against DeFlow, and it
 * is kept because the failure it describes is invisible. Node's maximum timer
 * delay is `2**31 - 1` ms = 24.9 days. Pass `2**31` and it does not throw and
 * does not clamp to the maximum — it fires the callback after about a
 * millisecond, with only a `TimeoutOverflowWarning` on stderr. A 30-day human
 * gate implemented with `setTimeout` therefore fires *instantly*, and nothing
 * in the logs says "durability failure".
 *
 * If a future Node clamps instead, this test goes red — which is the point.
 * The `node_wake` row would still be the right design (timers do not fire
 * during laptop sleep and do not survive a restart either), but the sentence
 * everyone repeats about why would have stopped being true, and a comment
 * cannot notice that.
 *
 * Real timers, no fakes: `vi.useFakeTimers()` would be measuring the fake.
 *
 * Verifies: EPIC-06-S21 (scenario 1) · AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { sleepHint, TICK_INTERVAL_MS } from '../src/ticker.ts';

/** Node's documented ceiling. One more than this is the whole problem. */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

const OVERFLOWING_DELAY = 2 ** 31;

const days = (count: number): number => count * 86_400_000;

interface OverflowResult {
  readonly elapsedMs: number;
  readonly warnings: readonly string[];
}

/** Schedules `setTimeout(fn, 2**31)` and reports how long it actually took. */
async function fireOverflowingTimer(): Promise<OverflowResult> {
  const warnings: string[] = [];
  const collect = (warning: Error): void => {
    warnings.push(warning.name);
  };
  process.on('warning', collect);

  const started = performance.now();
  try {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, OVERFLOWING_DELAY);
    });
    return { elapsedMs: performance.now() - started, warnings };
  } finally {
    process.off('warning', collect);
  }
}

suite('a 30-day gate written with setTimeout fires after 1 ms (EPIC-06-S21 scenario 1)', () => {
  it('fires almost immediately instead of in 24.9 days, and throws nothing', async () => {
    const { elapsedMs } = await fireOverflowingTimer();

    // Verified 2026-08-02, and re-verified on every run of this suite.
    expect(elapsedMs).toBeLessThan(1_000);
    // No clamping: had it clamped to the maximum, this would still be running
    // in 2026 and the spec would have timed out rather than reached here.
    expect(OVERFLOWING_DELAY).toBeGreaterThan(MAX_TIMER_DELAY);
  });

  it('says so only as a TimeoutOverflowWarning, which no operator will ever read', async () => {
    const { warnings } = await fireOverflowingTimer();

    expect(warnings).toContain('TimeoutOverflowWarning');
  });

  it('and a 30-day human gate is exactly that delay', () => {
    // Not a hypothetical number: F8.1 gates are measured in hours and F4.8
    // allows days, and the roadmap's worked example is 30 of them.
    expect(days(30)).toBeGreaterThan(MAX_TIMER_DELAY);
  });
});

suite('which is why the ticker’s only delay is a capped hint (AC1, AC5)', () => {
  it('never hands a timer a delay anywhere near the ceiling, whatever is waiting', () => {
    const now = 1_754_308_400_000;
    const instants = [
      null,
      now - days(365),
      now,
      now + 1,
      now + 200,
      now + TICK_INTERVAL_MS,
      now + days(30),
      now + days(3_650),
      Number.MAX_SAFE_INTEGER,
    ];

    for (const nextWakeAt of instants) {
      const hint = sleepHint(now, nextWakeAt);
      expect(hint).toBeGreaterThan(0);
      expect(hint).toBeLessThanOrEqual(TICK_INTERVAL_MS);
      expect(hint).toBeLessThan(MAX_TIMER_DELAY);
    }
  });
});
