/**
 * KAR-21.5 AC1, AC3, AC7 — *may a region of this terminal be redrawn?*, asked
 * once.
 *
 * Every rung of the degradation ladder is the same question with a different
 * answer, so it is one function rather than four guards scattered down
 * `run.ts`. A guard at a call site is how a fallback stops being a fallback:
 * the fourth condition gets added to three of the four places, and the one that
 * was missed is a terminal filling with literal escape text.
 *
 * **Two of the four answers are silent, and that is the interesting part.** AC1
 * is this epic's regression bar — piped, redirected and under `--json` the
 * command writes exactly the bytes it wrote before KAR-21.1 existed — so a
 * sentence explaining a live view the operator never asked for would break the
 * golden as surely as an escape sequence would. `TERM=dumb` and a window too
 * short are the other kind: the operator *is* at a terminal and *would* have
 * had a frame, and silently doing less is the failure KAR-20.2 names. So those
 * two say so, in one line, naming the cause and the remedy.
 *
 * A pure function of four facts it is **given**. It reads no stream, no
 * environment of its own and no terminal size — `isTty` and `rows` are decided
 * where the streams are known and passed down, which is KAR-18.9 AC7's rule and
 * the render guard's third.
 *
 * Verifies: EPIC-21-S39, EPIC-21-S43 · AC1, AC3, AC7
 */
import { FRAME_ROW_FRACTION, MIN_FRAME_ROWS } from './view.ts';

/**
 * The shortest window a footer frame can honestly live in.
 *
 * Derived rather than chosen. The frame is allowed `FRAME_ROW_FRACTION` of the
 * window (KAR-21.1 AC7) and is not a summary below `MIN_FRAME_ROWS` — so the
 * shortest window in which both hold is the one where the fraction buys exactly
 * the minimum. Anything shorter and each repaint scrolls the one before it, and
 * the region becomes the flickering ladder of half-frames that makes people say
 * TUIs are broken over ssh.
 */
export const MIN_TERMINAL_ROWS = Math.ceil(MIN_FRAME_ROWS / FRAME_ROW_FRACTION);

/** Why the live view is not open. `null` when it is. */
export type LiveViewRefusal = 'json' | 'not-a-terminal' | 'dumb-terminal' | 'too-short';

export interface LiveViewDecision {
  readonly live: boolean;
  readonly refusal: LiveViewRefusal | null;
  /**
   * The one line the command prints about it, or `null` for the two refusals
   * that must stay byte-silent (AC1).
   */
  readonly line: string | null;
}

export interface LiveViewInput {
  /** Whether **stdout** is a terminal. Decided by `bin.ts`, never derived here. */
  readonly isTty: boolean;
  /** `--json` was given, and the consumer downstream is a parser. */
  readonly json: boolean;
  /** The environment this process was given — `TERM` is read from it, and
   * nothing else. Never `process.env` in here. */
  readonly env: NodeJS.ProcessEnv;
  /** The terminal's height in rows, passed for the same reason the width is. */
  readonly rows: number;
}

/**
 * AC3's sentence.
 *
 * It names `TERM` because that is the thing the operator can change, and it
 * names the consequence rather than the mechanism: *the run is still printed*
 * is the fact somebody who just lost a feature needs first.
 */
export const DUMB_TERMINAL_LINE =
  'live view off: TERM=dumb cannot address the cursor, so this run is printed as a plain stream.';

/**
 * AC7's sentence, with the height it needs in it.
 *
 * Naming the number is what lets the operator fix it in one action — resize, or
 * accept the stream — instead of guessing at how much taller is tall enough.
 */
export const shortTerminalLine = (rows: number): string =>
  `live view off: this terminal is ${String(rows)} rows and the live view needs ` +
  `${String(MIN_TERMINAL_ROWS)}; this run is printed as a plain stream.`;

const refused = (refusal: LiveViewRefusal, line: string | null): LiveViewDecision => ({
  live: false,
  refusal,
  line,
});

/**
 * Whether this invocation gets a live frame, and what to say if it does not.
 *
 * The order **is** the specification, the way `shouldStyle`'s is. `--json` and
 * the pipe come first because AC1 outranks everything: a redirected `TERM=dumb`
 * run is a pipe first, and a pipe's bytes are the golden's.
 */
export function liveViewDecision(input: LiveViewInput): LiveViewDecision {
  if (input.json) return refused('json', null);
  if (!input.isTty) return refused('not-a-terminal', null);
  if (input.env.TERM === 'dumb') return refused('dumb-terminal', DUMB_TERMINAL_LINE);
  if (input.rows < MIN_TERMINAL_ROWS) return refused('too-short', shortTerminalLine(input.rows));
  return { live: true, refusal: null, line: null };
}
