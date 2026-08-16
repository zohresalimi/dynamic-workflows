/**
 * KAR-21.5 AC4, AC6 / EPIC-21-S40, S42 — a fast run over a slow link, and a
 * window that changed size while it was running.
 *
 * One repaint per event is the failure that makes people turn TUIs off over
 * ssh: a run producing a hundred events a second produces a hundred full
 * redraws a second, the link falls behind, and the region on screen describes a
 * run that finished a minute ago. So repaints are **coalesced to a frame rate**,
 * and the two clauses that stop coalescing from becoming a correctness bug are
 * asserted beside it: repaints may be dropped, **events may not** — every
 * transcript line is written, and the last frame reflects the last event.
 *
 * The ceiling is asserted as a **bound** rather than as a value. It is the one
 * judgement number in this epic, and tuning it after the performed acceptance
 * must not require rewriting this file.
 *
 * Time is the injected `Clock` throughout (NF9). `vi.useFakeTimers()` is not an
 * option here for the reason `TestClock` exists at all, and a spec that slept
 * for 50 ms to watch a 50 ms window would be stating a hope.
 *
 * Verifies: EPIC-21-S40 (its layout half), EPIC-21-S42 · AC4, AC6 · test plan
 * #4, #6
 */
import type { RunId, RunState } from '@DeFlow/core';
import { initialRunState } from '@DeFlow/core';
import { TestClock } from '@DeFlow/testkit';
import { expect, it, describe as suite } from 'vitest';
import { createHeadlessScreen, type HeadlessScreen } from '../../render/screen.ts';
import { createStyle, type Style } from '../../render/style.ts';
import { createSession, REPAINT_CEILING_HZ, REPAINT_INTERVAL_MS, type Session } from './session.ts';
import { initialSessionState, type SessionState } from './state.ts';

const RUN_ID = 'run_20260816T101500Z_0a0a0a' as RunId;
const NOW = 1_760_000_000_000;

const styleAt = (width: number): Style =>
  createStyle({ isTty: false, env: { LANG: 'en_US.UTF-8' }, columns: width });

const session = (over: Partial<SessionState> = {}): SessionState => ({
  ...initialSessionState(),
  nowMs: NOW,
  rows: 24,
  ...over,
});

/** A run whose frame changes on every event, so a dropped repaint is visible. */
function afterEvents(count: number): RunState {
  const base = initialRunState();
  return {
    ...base,
    runId: RUN_ID,
    status: 'running',
    budget: {
      ...base.budget,
      run: {
        ...base.budget.run,
        costUsd: { subscription: 0, apiKey: count / 100, vendorReported: null, estimated: null },
      },
    },
  };
}

interface Harness {
  readonly clock: TestClock;
  readonly screen: HeadlessScreen;
  readonly live: Session;
  /** Everything the transcript sink received, in order. */
  readonly transcript: () => string;
}

function open(width = 80): Harness {
  const clock = new TestClock(NOW);
  const screen = createHeadlessScreen({ width });
  const chunks: string[] = [];
  const live = createSession({
    screen,
    stdout: (chunk) => chunks.push(chunk),
    style: styleAt(width),
    clock,
  });
  return { clock, screen, live, transcript: () => chunks.join('') };
}

suite('EPIC-21-S42 — a burst of two hundred events is not two hundred repaints (AC6)', () => {
  it('records no more frames than the stated ceiling for 200 events in one tick', async () => {
    const { clock, screen, live } = open();

    for (let event = 1; event <= 200; event += 1) {
      live.write(`event ${String(event)}\n`);
      live.update(afterEvents(event), session());
    }
    // The trailing repaint is what carries the last state; nothing has yielded
    // yet, so it is still owed.
    await clock.advance(REPAINT_INTERVAL_MS);

    expect(screen.frames.length).toBeLessThanOrEqual(REPAINT_CEILING_HZ);
    // And it really did coalesce: 200 events producing 200 frames is the
    // failure, and a suite that only bounded the count would pass against a
    // session that rendered nothing at all.
    expect(screen.frames.length).toBeGreaterThan(0);
    expect(screen.frames.length).toBeLessThan(200);
  });

  it('bounds the bytes it wrote by the ceiling times the frame size', async () => {
    const { clock, screen, live } = open();

    for (let event = 1; event <= 200; event += 1) {
      live.write(`event ${String(event)}\n`);
      live.update(afterEvents(event), session());
    }
    await clock.advance(REPAINT_INTERVAL_MS);

    const frameSize = Math.max(...screen.frames.map((frame) => frame.join('\n').length), 1);
    expect(screen.bytes().length).toBeLessThanOrEqual(REPAINT_CEILING_HZ * frameSize);
  });

  it('reflects all 200 events in the final frame', async () => {
    const { clock, screen, live } = open();

    for (let event = 1; event <= 200; event += 1) {
      live.write(`event ${String(event)}\n`);
      live.update(afterEvents(event), session());
    }
    await clock.advance(REPAINT_INTERVAL_MS);

    // Repaints may be dropped; the *last* one may not be, or the region would
    // describe a run that has moved on.
    const last = screen.frames.at(-1) ?? [];
    expect(last.join('\n')).toContain('2.00');
  });

  it('writes every one of the 200 transcript lines', async () => {
    const { clock, live, transcript } = open();

    for (let event = 1; event <= 200; event += 1) {
      live.write(`event ${String(event)}\n`);
      live.update(afterEvents(event), session());
    }
    await clock.advance(REPAINT_INTERVAL_MS);

    // The transcript is append-only and nothing about it is coalesced away.
    // Order too: a buffer that reassembled chunks out of order would still
    // contain all 200.
    const lines = transcript()
      .split('\n')
      .filter((line) => line !== '');
    expect(lines).toHaveLength(200);
    for (let event = 1; event <= 200; event += 1) {
      expect(lines[event - 1]).toBe(`event ${String(event)}`);
    }
  });

  it('repaints again once the window has passed, rather than once per second', async () => {
    const { clock, screen, live } = open();

    live.update(afterEvents(1), session());
    const first = screen.frames.length;
    await clock.advance(REPAINT_INTERVAL_MS);

    live.update(afterEvents(2), session());
    expect(screen.frames.length).toBeGreaterThan(first);
    // A ceiling that was really a one-shot would leave the frame frozen after
    // the first burst, which is worse than repainting too often.
    expect((screen.frames.at(-1) ?? []).join('\n')).toContain('0.02');
  });

  it('flushes what it was holding when the session closes', () => {
    const { live, transcript } = open();

    live.write('the verdict is owed\n');
    live.write('and so is this line\n');
    live.close();

    // Nothing was advanced: a session that dropped its buffer on close would
    // lose the tail of every run that ended inside one repaint window.
    expect(transcript()).toBe('the verdict is owed\nand so is this line\n');
  });

  it('passes writes straight through once it is closed', () => {
    const { live, transcript } = open();

    live.close();
    live.write("the run's verdict\n");

    expect(transcript()).toBe("the run's verdict\n");
  });

  it('states the ceiling as a frame rate, and derives the window from it', () => {
    expect(REPAINT_CEILING_HZ).toBeGreaterThan(0);
    expect(REPAINT_INTERVAL_MS).toBe(Math.ceil(1000 / REPAINT_CEILING_HZ));
  });
});

suite('EPIC-21-S40 — a resized window re-lays the frame out (AC4)', () => {
  it('lays the next frame out at the new width', async () => {
    const { clock, screen, live } = open(80);

    live.update(afterEvents(1), session());
    await clock.advance(REPAINT_INTERVAL_MS);
    const wide = (screen.frames.at(-1) ?? []).map((line) => line.length);

    live.resize(styleAt(40));
    live.update(afterEvents(2), session());
    await clock.advance(REPAINT_INTERVAL_MS);
    const narrow = screen.frames.at(-1) ?? [];

    expect(Math.max(...wide)).toBeGreaterThan(40);
    for (const line of narrow) {
      if (line.length <= 40) continue;
      expect(line.trim().split(/\s+/), `"${line}" ran off the edge after the resize`).toHaveLength(
        1,
      );
    }
  });

  it('takes the new width from the Style it is handed, never from the terminal', () => {
    // AC4's second half, and the render guard's third rule: the session module
    // does not know what `stdout.columns` is. The only way its layout changes
    // is a `Style` somebody computed in `render/style.ts` and passed in.
    const { screen, live } = open(80);

    live.resize(styleAt(20));
    live.update(afterEvents(1), session());

    for (const line of screen.frames.at(-1) ?? []) {
      if (line.length <= 20) continue;
      expect(line.trim().split(/\s+/)).toHaveLength(1);
    }
  });
});
