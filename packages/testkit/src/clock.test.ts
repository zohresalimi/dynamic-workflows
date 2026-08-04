/**
 * KAR-01.4 AC7 — the TestClock, advanced manually.
 *
 * This exists so the F4.5–F4.8 paths (retry backoff, budget ceilings,
 * no-progress detection, long suspension) can be tested in microseconds without
 * faking a single timer — because faking timers is exactly what deadlocks a
 * spec that also has a child process alive (EPIC-01-S16).
 *
 * Verifies: EPIC-01-S16 (TestClock alternative scenario) · AC7
 */
import { describe as suite, expect, it } from 'vitest';
import { TestClock } from './clock.ts';

const SIX_HOURS = 6 * 60 * 60 * 1000;

suite('TestClock', () => {
  it('starts at the epoch it was given and does not move on its own', () => {
    const clock = new TestClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.now()).toBe(1_000);
  });

  it('fires a six-hour timer exactly once when advanced six hours', async () => {
    const clock = new TestClock();
    let fired = 0;
    clock.setTimer(SIX_HOURS, () => {
      fired += 1;
    });

    expect(fired).toBe(0);
    await clock.advance(SIX_HOURS);

    expect(fired).toBe(1);
    expect(clock.now()).toBe(SIX_HOURS);

    await clock.advance(SIX_HOURS);
    expect(fired).toBe(1);
  });

  it('does not fire a timer that is not yet due, and leaves it pending', async () => {
    const clock = new TestClock();
    let fired = false;
    clock.setTimer(SIX_HOURS, () => {
      fired = true;
    });

    await clock.advance(SIX_HOURS - 1);
    expect(fired).toBe(false);
    expect(clock.pending).toBe(1);

    await clock.advance(1);
    expect(fired).toBe(true);
    expect(clock.pending).toBe(0);
  });

  it('fires timers in due order and moves now() to each due time as it fires', async () => {
    const clock = new TestClock();
    const seen: [string, number][] = [];
    clock.setTimer(30, () => seen.push(['late', clock.now()]));
    clock.setTimer(10, () => seen.push(['early', clock.now()]));
    clock.setTimer(20, () => seen.push(['middle', clock.now()]));

    await clock.advance(100);

    expect(seen).toEqual([
      ['early', 10],
      ['middle', 20],
      ['late', 30],
    ]);
    expect(clock.now()).toBe(100);
  });

  it('fires a timer registered from inside a callback if it also comes due', async () => {
    const clock = new TestClock();
    const seen: number[] = [];
    clock.setTimer(10, () => {
      seen.push(clock.now());
      clock.setTimer(5, () => seen.push(clock.now()));
    });

    await clock.advance(20);
    expect(seen).toEqual([10, 15]);
  });

  it('cancels a timer, idempotently, so it never fires', async () => {
    const clock = new TestClock();
    let fired = false;
    const timer = clock.setTimer(10, () => {
      fired = true;
    });
    timer.cancel();
    timer.cancel();

    await clock.advance(100);
    expect(fired).toBe(false);
    expect(clock.pending).toBe(0);
  });

  it('resolves sleep() only once the clock has been advanced far enough', async () => {
    const clock = new TestClock();
    let resolved = false;
    const sleeping = clock.sleep(SIX_HOURS).then(() => {
      resolved = true;
    });

    await clock.advance(SIX_HOURS - 1);
    expect(resolved).toBe(false);

    await clock.advance(1);
    await sleeping;
    expect(resolved).toBe(true);
  });

  it('rejects a sleep whose signal aborts, and drops the pending timer', async () => {
    const clock = new TestClock();
    const controller = new AbortController();
    const sleeping = clock.sleep(SIX_HOURS, controller.signal);

    controller.abort();

    await expect(sleeping).rejects.toThrow(/abort/i);
    expect(clock.pending).toBe(0);
  });

  it('rejects immediately when handed an already-aborted signal', async () => {
    const clock = new TestClock();
    await expect(clock.sleep(10, AbortSignal.abort())).rejects.toThrow(/abort/i);
  });

  it('refuses to go backwards', async () => {
    const clock = new TestClock();
    await expect(clock.advance(-1)).rejects.toThrow(/backwards/i);
  });
});
