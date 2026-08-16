/**
 * KAR-21.1 AC6 — the frame is a footer, and the transcript scrolls above it.
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
 * which is why `Screen` needs only the two operations AC2 gives it. It is also
 * free on a chatty run: a screen that is already showing nothing writes zero
 * bytes for a frame that is still nothing.
 *
 * No module-level state (AC9). A session is a closure over the screen it was
 * handed, so two of them in one process are two values that cannot see each
 * other.
 */
import type { RunState } from '@DeFlow/core';
import type { Screen } from '../../render/screen.ts';
import type { Style } from '../../render/style.ts';
import type { SessionState } from './state.ts';
import { renderFrame } from './view.ts';

export interface Session {
  /**
   * Transcript bytes, written under the frame rather than into it.
   *
   * The chunk is passed through untouched — this is `RunRenderer`'s output and
   * the goldens that pin it are the contract.
   */
  write(chunk: string): void;
  /** Repaint the frame from the run's current state and the session's own. */
  update(run: RunState, state: SessionState): void;
  /** Erase the frame and give the terminal back. Idempotent. */
  close(): void;
}

export interface SessionOptions {
  readonly screen: Screen;
  /** Where transcript bytes go — `process.stdout.write`, unchanged. */
  readonly stdout: (chunk: string) => void;
  readonly style: Style;
}

export function createSession(options: SessionOptions): Session {
  /** What is currently painted, so it can be put back after a transcript line. */
  let frame: readonly string[] = [];

  return {
    write(chunk) {
      if (chunk === '') return;
      options.screen.render([]);
      options.stdout(chunk);
      options.screen.render(frame);
    },

    update(run, state) {
      frame = renderFrame(run, state, options.style);
      options.screen.render(frame);
    },

    close() {
      frame = [];
      options.screen.close();
    },
  };
}
