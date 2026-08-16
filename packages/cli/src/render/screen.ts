/**
 * KAR-21.1 AC1, AC2, AC5 — the one module in `packages/cli` allowed to move or
 * erase anything.
 *
 * EPIC-21's own stated biggest risk is a second presentation layer growing
 * beside the one KAR-18.9 shipped. A repaint is where that starts, because a
 * repaint needs escape sequences and escape sequences are the thing a second
 * layer is made of. So they live here, in a module that knows nothing else:
 * it spells no glyph, picks no colour and derives no width — the width is
 * **passed in** — and `../../test/render-guard.test.ts` fails the day a second
 * file writes one.
 *
 * Two operations, and the smallness is the design. `render(frame)` and
 * `close()` are enough for everything this epic does, including printing a
 * transcript line under a live frame: render `[]`, write the line, render the
 * frame again. A third operation for "write a line" would have put the
 * transcript inside the screen, and the transcript is KAR-18.3's and must not
 * move.
 *
 * **The erase count is the number of rows the previous frame *occupied*.** Not
 * the number of entries it contained: an entry wider than the terminal occupies
 * two rows, and a screen that erased `frame.length` would strand a line on
 * screen for the rest of the run. The caller hands over already-wrapped lines
 * (`run/session/view.ts`), and this module wraps nothing — it only *counts*
 * what the terminal will do to a line that is too long anyway.
 *
 * **An identical frame writes zero bytes.** That is what stops the region
 * flickering on a chatty run, and it removes the temptation to solve flicker
 * later with a timer — a second scheduling mechanism beside the one KAR-21.5
 * defines.
 */
import { DEFAULT_WIDTH } from './style.ts';

const CSI = '\u001B[';

/** Erase the whole of the row the cursor is on, cursor unmoved. */
export const ERASE_LINE = `${CSI}2K`;
/** Up one row, column unchanged. */
export const CURSOR_UP = `${CSI}1A`;
/** To column 1 of the current row. */
export const COLUMN_ZERO = `${CSI}G`;
export const HIDE_CURSOR = `${CSI}?25l`;
export const SHOW_CURSOR = `${CSI}?25h`;

/**
 * A region of the terminal that is redrawn in place.
 *
 * Two operations, and no way to ask it what is on screen: what is on screen is
 * the frame the caller last handed it, which the caller already has.
 */
export interface Screen {
  /** Replace the region with `frame`, erasing exactly what the last one took. */
  render(frame: readonly string[]): void;
  /**
   * KAR-21.5 AC4 — the window changed size; lay everything **after this** out
   * at `width`.
   *
   * Deliberately **not** a recount of what is already on screen. A resize
   * changes how many rows the *previous* frame is occupying, and a screen that
   * recomputed the old height at the new width would erase the wrong number of
   * rows exactly once per resize — leaving debris that gets blamed on the
   * terminal. The rows already drawn were drawn at the old width and are erased
   * at the old count; the new width applies from the next frame on.
   */
  resize(width: number): void;
  /** Erase the region and give the terminal back. Idempotent. */
  close(): void;
}

export interface ScreenOptions {
  /** Where the bytes go. `process.stdout.write` in `bin.ts`, an array in a spec. */
  readonly write: (chunk: string) => void;
  /**
   * The terminal's width, in columns — **passed**, never derived (AC1).
   *
   * Used for one thing: deciding how many rows a line that is too long will
   * occupy once the terminal has wrapped it, which is the number that must be
   * erased next time.
   */
  readonly width: number;
}

/**
 * How wide a line is on screen, ignoring anything that paints rather than
 * prints.
 *
 * Split on the CSI introducer rather than matched with one regular expression:
 * a pattern containing the escape byte is a control character in a regex
 * literal, which `no-control-regex` rightly objects to. The parameter and final
 * bytes of each sequence are dropped, which is exactly what a terminal does
 * with them — they cost no columns.
 */
function visibleWidth(line: string): number {
  return line
    .split(CSI)
    .map((part, index) => (index === 0 ? part : part.replace(/^[0-9;?]*[A-Za-z]/, '')))
    .join('').length;
}

/** How many terminal rows `frame` occupies once the terminal has wrapped it. */
export function occupiedRows(frame: readonly string[], width: number): number {
  if (width <= 0) return frame.length;
  return frame.reduce((rows, line) => rows + Math.max(1, Math.ceil(visibleWidth(line) / width)), 0);
}

/**
 * The control stream that clears `count` rows ending at the cursor's own,
 * leaving the cursor at column 1 of the topmost one.
 */
function eraseRows(count: number): string {
  if (count <= 0) return '';
  let out = `${COLUMN_ZERO}${ERASE_LINE}`;
  for (let row = 1; row < count; row += 1) out += `${CURSOR_UP}${ERASE_LINE}`;
  return out;
}

const sameFrame = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((line, index) => line === right[index]);

export function createScreen(options: ScreenOptions): Screen {
  let previous: readonly string[] = [];
  /** Rows, not entries. The distinction is the whole of AC5. */
  let occupied = 0;
  /** The width the *next* frame is measured at. `occupied` above was measured
   * at whatever it was when that frame was drawn, and stays that way (AC4). */
  let width = options.width;
  let hidden = false;
  let closed = false;

  return {
    render(frame) {
      if (closed || sameFrame(frame, previous)) return;

      const hide = !hidden && frame.length > 0 ? HIDE_CURSOR : '';
      if (hide !== '') hidden = true;
      options.write(`${eraseRows(occupied)}${hide}${frame.join('\n')}`);

      previous = [...frame];
      occupied = occupiedRows(previous, width);
    },

    resize(next) {
      width = next;
    },

    close() {
      if (closed) return;
      closed = true;
      const chunk = `${eraseRows(occupied)}${hidden ? SHOW_CURSOR : ''}`;
      if (chunk !== '') options.write(chunk);
      previous = [];
      occupied = 0;
    },
  };
}

/**
 * A screen that keeps what it was given instead of writing it (AC2).
 *
 * Every *"what was on screen"* assertion in EPIC-21 is made against one of
 * these, which is what keeps the epic free of scenarios that could only be
 * checked by a person looking at a terminal. The control stream is produced by
 * the real `createScreen` and kept in `bytes()`, so a spec asserting about
 * erases is asserting about the bytes a terminal would actually have received.
 */
export interface HeadlessScreen extends Screen {
  /** Every frame `render` was given that differed from the one before it. */
  readonly frames: readonly (readonly string[])[];
  /** The bytes a terminal screen would have written for those frames. */
  bytes(): string;
}

export function createHeadlessScreen(options: { readonly width?: number } = {}): HeadlessScreen {
  const frames: (readonly string[])[] = [];
  const chunks: string[] = [];
  const inner = createScreen({
    width: options.width ?? DEFAULT_WIDTH,
    write: (chunk) => chunks.push(chunk),
  });

  return {
    frames,
    bytes: () => chunks.join(''),
    render(frame) {
      // Recorded on the same rule the bytes are written on, so a repaint that
      // changed nothing is one entry here as well as zero bytes there.
      const last = frames.at(-1);
      if (last === undefined || !sameFrame(last, frame)) frames.push([...frame]);
      inner.render(frame);
    },
    resize: (width) => {
      inner.resize(width);
    },
    close: () => inner.close(),
  };
}
