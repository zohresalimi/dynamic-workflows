/**
 * KAR-16.4 AC9 — the dev-only projection counter.
 *
 * Verifies: EPIC-16-S30 (scenarios 1 and 3) · AC9
 *
 * > **Ship a dev-only assertion.** Every 60 seconds in dev, log
 * > `{ nodes, facts, events, terminals }` counts. *You will find the leak in
 * > week one instead of in hour four of a run you cared about.*
 *
 * A two-line feature with an outsized payoff, and it is in the acceptance
 * criteria precisely because it is the kind of thing that gets cut as
 * unnecessary and then reinvented under pressure at hour four.
 *
 * The interval is an **injected** clock, not `setInterval` reached for
 * directly, and not vitest's fake timers: this suite shares a browser with
 * specs that hold real SSE connections open, and replacing the page's timers
 * under them is how an unrelated file times out. The production clock is
 * `browserInterval()`, and it is one line whose only job is to be the thing
 * this test substitutes.
 *
 * The *other* half of AC9 — that the tag is absent from the built bundle — is
 * `../../test/integration/dev-leak-assertion.test.ts`, because it is a claim
 * about `vite build`'s output and nothing a page can answer about itself.
 */
import { expect, it, describe as suite } from 'vitest';
import type { RunStoreCounts } from '../stores/useRunStore.ts';
import {
  browserInterval,
  LEAK_ASSERTION_INTERVAL_MS,
  PROJECTION_LOG_TAG,
  startLeakAssertion,
} from './leak-assert.ts';

/** A clock whose ticks this spec fires by hand. */
function manualClock() {
  const scheduled: { everyMs: number; tick: () => void }[] = [];
  let cancelled = 0;

  return {
    scheduled,
    cancelled: () => cancelled,
    every(everyMs: number, tick: () => void) {
      scheduled.push({ everyMs, tick });
      return () => {
        cancelled += 1;
      };
    },
  };
}

const counts = (over: Partial<RunStoreCounts> = {}): RunStoreCounts => ({
  nodes: 400,
  facts: 37,
  events: 2_000,
  terminals: 2,
  ringCap: 2_000,
  ...over,
});

suite('AC9 — it fires every sixty seconds in dev', () => {
  it('schedules one tick at the stated interval and no more', () => {
    const clock = manualClock();

    startLeakAssertion({ counts: () => counts(), clock });

    expect(clock.scheduled).toHaveLength(1);
    expect(clock.scheduled[0]?.everyMs).toBe(LEAK_ASSERTION_INTERVAL_MS);
    expect(LEAK_ASSERTION_INTERVAL_MS).toBe(60_000);
  });

  it('logs the tag and the four counters EPIC-16-S27 names as suspects', () => {
    const clock = manualClock();
    const logged: [string, unknown][] = [];

    startLeakAssertion({
      counts: () => counts(),
      clock,
      log: (tag, sample) => logged.push([tag, sample]),
    });
    clock.scheduled[0]?.tick();

    expect(logged).toHaveLength(1);
    expect(logged[0]?.[0]).toBe(PROJECTION_LOG_TAG);
    expect(logged[0]?.[1]).toEqual({
      nodes: 400,
      facts: 37,
      events: 2_000,
      terminals: 2,
      ringCap: 2_000,
    });
  });

  it('samples afresh on every tick, so the log is a trend and not a snapshot', () => {
    const clock = manualClock();
    const logged: RunStoreCounts[] = [];
    let nodes = 1;

    startLeakAssertion({
      counts: () => counts({ nodes }),
      clock,
      log: (_tag, sample) => logged.push(sample),
    });

    clock.scheduled[0]?.tick();
    nodes = 2;
    clock.scheduled[0]?.tick();

    expect(logged.map((one) => one.nodes)).toEqual([1, 2]);
  });

  it('stops when told, so a torn-down app leaves no interval behind', () => {
    const clock = manualClock();

    const stop = startLeakAssertion({ counts: () => counts(), clock });
    stop();

    expect(clock.cancelled()).toBe(1);
  });

  it('defaults to console.debug, which is what a dev console is filtered on', () => {
    const clock = manualClock();
    const seen: unknown[][] = [];
    const original = console.debug;
    console.debug = (...args: unknown[]) => seen.push(args);

    try {
      startLeakAssertion({ counts: () => counts(), clock });
      clock.scheduled[0]?.tick();
    } finally {
      console.debug = original;
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe(PROJECTION_LOG_TAG);
  });
});

suite('AC9 — the production clock is real, so the dev wiring is not a fiction', () => {
  it('runs the tick and cancels cleanly', async () => {
    const ticks: number[] = [];

    // 1 ms rather than 60,000: what is under test is that `browserInterval`
    // schedules and cancels at all. The interval *value* is asserted above,
    // where it costs nothing.
    const stop = browserInterval.every(1, () => ticks.push(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    const afterStop = ticks.length;
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(afterStop).toBeGreaterThan(0);
    expect(ticks).toHaveLength(afterStop);
  });
});
