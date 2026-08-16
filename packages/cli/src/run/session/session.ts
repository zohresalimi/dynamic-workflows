/**
 * KAR-21.1 AC6 — the frame is a footer, and the transcript scrolls above it.
 * KAR-21.5 AC4, AC6 — at a stated frame rate, and at the width the window has
 * now.
 *
 * The whole of the interleaving rule is three lines of `write()`: erase the
 * frame, write the transcript bytes exactly as `RunRenderer` produced them, put
 * the frame back. `deflow run`'s output is a **fixed point** in this epic —
 * `test/integration/terminal-output.test.ts` and `run-json.test.ts` pin it and
 * must pass unmodified — so nothing here may prefix, wrap or re-colour a byte
 * on its way past. In particular the agent's own `io_chunk` bytes reach the
 * terminal unedited, which is KAR-19.4 AC3's decision and not this story's to
 * revisit.
 *
 * Erasing is expressed as `screen.render([])` rather than as an erase call,
 * which is why `Screen` needs only the three operations AC2 gives it. It is
 * also free on a chatty run: a screen that is already showing nothing writes
 * zero bytes for a frame that is still nothing.
 *
 * ## Why the sandwich is made once per *window* rather than once per event
 *
 * KAR-21.5 AC6. One repaint per event is what makes a TUI unusable over ssh:
 * the erase-write-repaint sandwich costs a full frame of bytes, a run producing
 * a hundred events a second spends a hundred frames a second on the link, and
 * the region on screen ends up describing a run that finished a minute ago. So
 * both halves are held for at most one window and flushed together — one erase,
 * the transcript bytes that accumulated, one repaint.
 *
 * Two properties keep that from becoming a correctness bug, and both are
 * asserted in `session.test.ts`: **repaints may be dropped, events may not.**
 * Every byte handed to `write` is written, in order, exactly once; only the
 * intermediate *frames* — a projection nobody needed to see — are skipped. And
 * `close()` flushes what it is holding before it erases, so the tail of a run
 * that ended inside a window is not the tail that got lost.
 *
 * Time is the injected `Clock` (NF9), which is what makes the window a value a
 * spec sets rather than a race a spec hopes for.
 *
 * No module-level state (AC9). A session is a closure over the screen it was
 * handed, so two of them in one process are two values that cannot see each
 * other.
 */
import type { Clock, RunState, TimerHandle } from '@DeFlow/core';
import type { Screen } from '../../render/screen.ts';
import type { Style } from '../../render/style.ts';
import type { SessionState } from './state.ts';
import { renderFrame } from './view.ts';

/**
 * KAR-21.5 AC6 — the ceiling, as a **frame rate**.
 *
 * The one judgement number in EPIC-21, recorded here so it can be argued with.
 * 20 Hz is the rate at which a change reads as immediate to a person watching a
 * status region — fast enough that a gate opening does not feel like a pause,
 * slow enough that a burst of events costs twenty frames a second on the link
 * rather than hundreds. `session.test.ts` asserts a **bound** rather than this
 * value, so tuning it after the performed acceptance does not require rewriting
 * the specification.
 */
export const REPAINT_CEILING_HZ = 20;

/** The window derived from the ceiling. Derived, so the two cannot disagree. */
export const REPAINT_INTERVAL_MS = Math.ceil(1000 / REPAINT_CEILING_HZ);

export interface Session {
  /**
   * Transcript bytes, written under the frame rather than into it.
   *
   * The chunk is passed through untouched — this is `RunRenderer`'s output and
   * the goldens that pin it are the contract. It may be held for up to one
   * repaint window and written with whatever else accumulated, which changes
   * when the bytes are written and never which bytes they are.
   */
  write(chunk: string): void;
  /** Repaint the frame from the run's current state and the session's own. */
  update(run: RunState, state: SessionState): void;
  /**
   * KAR-21.5 AC4 — the window changed size; here is the `Style` for the new one.
   *
   * A whole `Style` rather than a width, because the width is not the only
   * thing that is computed from the terminal and this module is not allowed to
   * compute any of them: `render/style.ts` owns that decision (the render
   * guard's third rule), and this takes its answer.
   */
  resize(style: Style): void;
  /** Flush what is held, erase the frame, give the terminal back. Idempotent. */
  close(): void;
}

export interface SessionOptions {
  readonly screen: Screen;
  /** Where transcript bytes go — `process.stdout.write`, unchanged. */
  readonly stdout: (chunk: string) => void;
  readonly style: Style;
  /**
   * The clock the repaint window is measured on (NF9).
   *
   * Absent means every update repaints immediately, which is the behaviour
   * KAR-21.1 shipped — a caller that has no clock to lend gets no coalescing
   * rather than a private `Date.now()` growing in here.
   */
  readonly clock?: Clock | undefined;
}

export function createSession(options: SessionOptions): Session {
  /** What is currently painted, so it can be put back after a transcript line. */
  let frame: readonly string[] = [];
  let style = options.style;

  /** Transcript bytes owed to stdout, in the order they were handed over. */
  let owed = '';
  /**
   * The newest state the caller handed over, kept after it was painted.
   *
   * Kept rather than consumed because a resize has to lay the *same* state out
   * again at a new width, and refolding a projection to find out what the run
   * looked like would be the second answer KAR-21.1 exists to avoid.
   */
  let latest: { readonly run: RunState; readonly state: SessionState } | null = null;
  /** Whether `frame` is still what `latest` and `style` would produce. */
  let stale = false;
  let timer: TimerHandle | null = null;
  /** When the last flush happened, on the injected clock. */
  let lastFlushMs = Number.NEGATIVE_INFINITY;
  let closed = false;

  const flush = (): void => {
    if (timer !== null) {
      timer.cancel();
      timer = null;
    }
    lastFlushMs = options.clock?.now() ?? 0;

    if (stale && latest !== null) {
      frame = renderFrame(latest.run, latest.state, style);
      stale = false;
    }
    if (owed !== '') {
      // The sandwich, made once for everything that accumulated: the frame
      // comes down, the transcript goes out exactly as it arrived, the frame
      // goes back.
      options.screen.render([]);
      options.stdout(owed);
      owed = '';
    }
    options.screen.render(frame);
  };

  /** Flush now if the window has passed, and otherwise at the end of it. */
  const request = (): void => {
    const clock = options.clock;
    if (clock === undefined) {
      flush();
      return;
    }
    const waited = clock.now() - lastFlushMs;
    if (waited >= REPAINT_INTERVAL_MS) {
      flush();
      return;
    }
    // One timer per window, not one per event: the second event in a window
    // joins the flush the first one already scheduled.
    timer ??= clock.setTimer(REPAINT_INTERVAL_MS - waited, () => {
      timer = null;
      flush();
    });
  };

  return {
    write(chunk) {
      if (chunk === '') return;
      // After `close` the screen is gone and there is nothing to interleave
      // with, so the bytes go straight out. `run.ts` writes the run's verdict
      // through here after taking the frame down, and a session that swallowed
      // it would lose the one line a run exists to print.
      if (closed) {
        options.stdout(chunk);
        return;
      }
      owed += chunk;
      request();
    },

    update(run, state) {
      if (closed) return;
      latest = { run, state };
      stale = true;
      request();
    },

    resize(next) {
      if (closed) return;
      style = next;
      // The screen is told too. It keeps the row count it already measured —
      // the rows on screen were drawn at the old width and must be erased at
      // the old count — and lays out everything after this at the new one (AC4).
      options.screen.resize(next.width);
      if (latest === null) return;
      // Nothing new to fold in, but the same state has to be laid out again. A
      // resize with no event behind it is the common case.
      stale = true;
      request();
    },

    close() {
      if (closed) return;
      closed = true;
      if (timer !== null) {
        timer.cancel();
        timer = null;
      }
      // What was held is owed regardless of the window: a run that ended inside
      // one must not lose its last lines.
      if (owed !== '') {
        options.screen.render([]);
        options.stdout(owed);
        owed = '';
      }
      latest = null;
      stale = false;
      frame = [];
      options.screen.close();
    },
  };
}
