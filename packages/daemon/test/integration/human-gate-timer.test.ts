/**
 * KAR-13.1 AC6 — EPIC-13-S4's third scenario: *"the implementation uses a
 * `node_wake` row instead"*.
 *
 * The other three scenarios of EPIC-13-S4 are already asserted, in
 * `packages/core/test/integration/timer-overflow.test.ts`: that
 * `setTimeout(fn, 2 ** 31)` fires after about a millisecond with only a
 * `TimeoutOverflowWarning` to show for it, that a thirty-day wait written that
 * way therefore resolves instantly, and that `oxlint` refuses a `setTimeout`
 * used as a wait anywhere under an engine package's `src`. Those are claims
 * about Node and about the lint config, and they hold for every wait in the
 * system.
 *
 * This file asserts the half that is specific to a *human gate*, and that no
 * amount of linting can give you: that admitting a thirty-day gate really does
 * put the wait in the table at the thirty-day mark, and that the scheduler
 * driving it never asks a timer for a delay it could not honour. A lint rule
 * says nobody wrote `setTimeout`; only running the loop says the delay that
 * reaches the `Clock` port is a second.
 *
 * The observation point is a `Clock` that records every delay handed to it and
 * then defers to a `TestClock`. That is deliberately the port itself rather
 * than the global: `packages/daemon/src/clock.ts` is the one place in the
 * daemon allowed to name `setTimeout`, so every delay the scheduler can
 * possibly express passes through `setTimer`/`sleep` on its way there. No fake
 * timers — the whole point is to watch real numbers arrive at a real seam.
 *
 * Verifies: EPIC-13-S4 (scenario 3) · AC6
 */
import type { Clock, Db, RunState, TimerHandle } from '@DeFlow/core';
import { initialRunState } from '@DeFlow/core';
import { openLedger, readWakes, replayAll } from '@DeFlow/ledger';
import { it, TestClock } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { expireDueHumanGates } from '../../src/human/gate.ts';
import { startTicker, TICK_INTERVAL_MS } from '../../src/ticker.ts';
import {
  type Deadline,
  days,
  driveToTheGate,
  EPOCH,
  GATE,
  HUMAN_RUN,
  seedHumanRun,
  T0,
} from './support/human-gate-run.ts';

/** Node's ceiling, and the reason none of this can be a timer: the maximum
 * delay is `2 ** 31 - 1` ms = 24.9 days, and a millisecond past it fires
 * immediately rather than throwing or clamping. */
const MAX_TIMER_DELAY = 2 ** 31 - 1;

const THIRTY_DAYS_OUT = T0 + days(30);

const thirtyDayGate = (): Deadline => ({
  wakeAt: new Date(THIRTY_DAYS_OUT).toISOString(),
  onTimeout: 'fail',
});

const stateOf = (db: Db): RunState => replayAll(db).runs.get(HUMAN_RUN) ?? initialRunState();

/**
 * The `Clock` port, with a note taken of every delay that crosses it.
 *
 * Nothing is faked and nothing is intercepted: the delays are recorded on the
 * way to a real `TestClock`, so the scheduler under observation behaves exactly
 * as it does in the specs that do not watch.
 */
class RecordingClock implements Clock {
  /** Every delay asked of a timer, in the order it was asked, in ms. */
  readonly delays: number[] = [];

  constructor(readonly inner: TestClock) {}

  now(): number {
    return this.inner.now();
  }

  setTimer(ms: number, fn: () => void): TimerHandle {
    this.delays.push(ms);
    return this.inner.setTimer(ms, fn);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.delays.push(ms);
    return this.inner.sleep(ms, signal);
  }
}

suite('EPIC-13-S4 scenario 3 — a thirty-day gate is a row, not a timer (AC6)', () => {
  it('writes the wake at the thirty-day mark, which is past what a timer can express', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedHumanRun(db, thirtyDayGate());
      const clock = new RecordingClock(new TestClock(T0));

      await driveToTheGate(db, clock);

      expect(readWakes(db, HUMAN_RUN)).toEqual([
        { runId: HUMAN_RUN, nodeId: GATE, wakeAt: THIRTY_DAYS_OUT, reason: 'human_gate' },
      ]);
      // Why it has to be a row: as a *delay* this number is not expressible.
      expect(days(30)).toBeGreaterThan(MAX_TIMER_DELAY);
      // And admitting it asked no timer for anything remotely that long.
      expect(clock.delays.filter((ms) => ms > TICK_INTERVAL_MS)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('never hands the scheduler a delay longer than one tick while the gate waits', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      seedHumanRun(db, thirtyDayGate());
      const clock = new RecordingClock(new TestClock(T0));
      await driveToTheGate(db, clock);

      // The real loop, over the real row, at the production interval.
      let ticks = 0;
      const ticker = startTicker({
        clock,
        onTick: () => {
          ticks += 1;
          expireDueHumanGates({ db, clock, epoch: EPOCH });
        },
        nextWakeAt: () => readWakes(db, HUMAN_RUN)[0]?.wakeAt ?? null,
      });

      try {
        await clock.inner.advance(5 * TICK_INTERVAL_MS);
      } finally {
        ticker.stop();
      }

      // The claim, stated as the scenario states it — and stated first, so a
      // regression reads as the number that was asked for rather than as a
      // downstream symptom.
      expect(Math.max(...clock.delays)).toBeLessThanOrEqual(TICK_INTERVAL_MS);
      expect(clock.delays).not.toContain(days(30));

      // It really did run. "No delay over a second" would also hold of a loop
      // that had stopped scheduling altogether, and a wake thirty days out is
      // precisely the case where sleeping until it looks like the right answer:
      // the ticker has to keep turning over, one second at a time.
      expect(ticks).toBeGreaterThanOrEqual(5);
      expect(clock.delays).toContain(TICK_INTERVAL_MS);

      // Five seconds later the gate is exactly where it was, for one row and
      // no events — which is the only reason a thirty-day wait is affordable.
      expect(stateOf(db).nodes[GATE]?.status).toBe('suspended');
      expect(readWakes(db, HUMAN_RUN)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
