/**
 * KAR-21.1 AC3, AC9 — everything the session knows about itself, in one value.
 *
 * A testability constraint before it is a correctness one. Screen state kept in
 * a module-level variable is the reason TUI code is usually tested by hand: the
 * second test in a file inherits the first one's open input box, and the
 * failures are order-dependent and unreproducible. So there is no module-level
 * variable anywhere under `run/session/` — the state is a plain object the
 * caller owns, `view.ts` reads it and never writes it, and two sessions in one
 * process are two values that cannot see each other (EPIC-21-S09).
 *
 * The two fields that look like they should have been read rather than passed
 * are the two NF9 is about. `nowMs` is the instant the caller measured through
 * its injected `Clock`, so an elapsed time in a frame is a value a test set
 * rather than a race a test hopes for; `rows` is the terminal's height, passed
 * for the same reason `Style.width` is (KAR-18.9 AC7) — one call site deriving
 * its own is how a fallback stops being a fallback.
 */

/** Which region of the session the keyboard is aimed at. KAR-21.2 moves it. */
export type SessionFocus = 'transcript' | 'plan' | 'gate';

/**
 * A line the operator is part-way through typing.
 *
 * `kind` is carried rather than inferred so KAR-21.3's gate answer and
 * KAR-21.4's interjection can share the row without either having to guess
 * which one is open.
 */
export interface SessionInput {
  readonly kind: 'interject';
  /** What the session is asking for, in words the operator reads. */
  readonly prompt: string;
  /** What has been typed so far. Never `null` — an empty line is a value. */
  readonly text: string;
}

export interface SessionState {
  readonly focus: SessionFocus;
  /** The open input, or `null` when the session is only watching. */
  readonly input: SessionInput | null;
  /** ms epoch, measured by the caller through its injected `Clock` (NF9). */
  readonly nowMs: number;
  /** The terminal's height in rows — passed, never derived (AC1, AC7). */
  readonly rows: number;
}

/** What a session looks like the instant before anything has happened in it. */
export function initialSessionState(): SessionState {
  return { focus: 'transcript', input: null, nowMs: 0, rows: DEFAULT_ROWS };
}

/**
 * The height assumed for a terminal that will not say, matching `style.ts`'s
 * 80-column fallback: 24 rows is what every terminal emulator opens at and what
 * a CI runner reports when it reports anything.
 */
export const DEFAULT_ROWS = 24;
