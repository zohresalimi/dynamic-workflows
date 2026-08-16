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
 * which one is open. The gate variant carries the option it was opened *for*
 * rather than reading the highlighted row back at send time: the highlight is a
 * cursor and the answer is a decision, and an arrow key pressed while the row
 * is open must not quietly change which option is about to be rejected.
 */
export type SessionInput =
  | {
      readonly kind: 'interject';
      /** What the session is asking for, in words the operator reads. */
      readonly prompt: string;
      /** What has been typed so far. Never `null` — an empty line is a value. */
      readonly text: string;
    }
  | {
      readonly kind: 'gate-text';
      readonly prompt: string;
      readonly text: string;
      /** The gate's own option id, carried from `pendingGate`, never spelled. */
      readonly optionId: string;
    }
  | {
      /**
       * KAR-21.4 AC7 — the second decision a cancel takes.
       *
       * A typed row rather than a one-key confirmation, because the default has
       * to be **no**: a bare Enter on an empty row cancels nothing. That is the
       * rule KAR-20.2 AC5 applies to editing a shell profile, and it matters
       * more here — the thing on the other side of the keypress may have hours
       * of work in it.
       */
      readonly kind: 'cancel-confirm';
      readonly prompt: string;
      readonly text: string;
    };

/**
 * KAR-21.3 — the gate prompt's own state, and the only three things it has.
 *
 * Deliberately not *"which gate is open"*: that is `pendingGate` over the
 * reduced state and the session holds no second opinion about it, which is why
 * an answer arriving from the browser, a second gate and a re-delivered event
 * are already correct here rather than three special cases.
 */
export interface GateState {
  /** Which offered row the keyboard is on, clamped to the gate's own option set. */
  readonly selected: number;
  /** The option id whose request is on the wire, or `null` — AC7's inert window. */
  readonly sending: string | null;
  /** The last thing that has to be said about an answer, or `null`. */
  readonly notice: GateNotice | null;
}

/**
 * A sentence the frame shows about one gate.
 *
 * Carried with the node it is about, so a refusal that arrived for one gate is
 * not still on screen under the next one's options. It is the daemon's own
 * words whenever the daemon spoke (AC5).
 */
export interface GateNotice {
  readonly node: string;
  readonly message: string;
}

/**
 * KAR-21.4 — what the interject verb is doing, and nothing about what it means.
 *
 * `notice` is the daemon's own sentence whenever the daemon spoke: an
 * `unsupported` delivery, a refusal, or the one thing this session answers by
 * itself — that no node is running to interject into (AC4). `offer` is what the
 * daemon named as the mode that *would* work, held so one keypress can re-send
 * with it; it is never acted on without that keypress (AC3).
 */
export interface InterjectState {
  /** Whether an interjection is on the wire — the rows are inert while it is. */
  readonly sending: boolean;
  /** The last thing that has to be said about an interjection, or `null`. */
  readonly notice: string | null;
  /** An `unsupported` answer's alternative, waiting for the operator. */
  readonly resend: ResendOffer | null;
}

/** What a re-send would send: the daemon's mode, and the operator's own text. */
export interface ResendOffer {
  readonly node: string;
  readonly text: string;
  /** The `alternative` off the response — never a mode this package spelled. */
  readonly mode: string;
}

/** KAR-21.4 AC8 — what `cancelRun` answered, and whether it is still answering. */
export interface CancelState {
  readonly sending: boolean;
  readonly notice: string | null;
}

export interface SessionState {
  readonly focus: SessionFocus;
  /** The open input, or `null` when the session is only watching. */
  readonly input: SessionInput | null;
  /** KAR-21.3 — what the gate prompt is doing. @see `gate.ts` */
  readonly gate: GateState;
  /** KAR-21.4 — what the interject verb is doing. @see `interject.ts` */
  readonly interject: InterjectState;
  /** KAR-21.4 — what the cancel verb is doing. @see `cancel.ts` */
  readonly cancel: CancelState;
  /** ms epoch, measured by the caller through its injected `Clock` (NF9). */
  readonly nowMs: number;
  /** The terminal's height in rows — passed, never derived (AC1, AC7). */
  readonly rows: number;
  /**
   * KAR-21.2 AC3, AC6 — whether anything out there can actually press a key.
   *
   * Carried in the state for the same reason `rows` is, and it is KAR-18.9 AC7's
   * rule applied to input rather than output: the decision is made once, where
   * the streams are known, and passed. A view that re-derived it would print a
   * list of keys into a CI log where no key can be pressed — a smaller failure
   * than calling `setRawMode` on a pipe, but still a lie.
   *
   * Deliberately separate from the output half. Piping `deflow run` into a pager
   * with a keyboard still attached, and running it from a terminal with the
   * input closed, are both real; one flag standing for both would get one of
   * them wrong.
   */
  readonly keyboard: boolean;
}

/** What a session looks like the instant before anything has happened in it. */
export function initialSessionState(): SessionState {
  return {
    focus: 'transcript',
    input: null,
    gate: initialGateState(),
    interject: initialInterjectState(),
    cancel: initialCancelState(),
    nowMs: 0,
    rows: DEFAULT_ROWS,
    keyboard: false,
  };
}

/** Nothing typed, nothing on the wire, nothing to say about either verb. */
export function initialInterjectState(): InterjectState {
  return { sending: false, notice: null, resend: null };
}

export function initialCancelState(): CancelState {
  return { sending: false, notice: null };
}

/** A gate prompt nobody has touched: the first row, nothing in flight. */
export function initialGateState(): GateState {
  return { selected: 0, sending: null, notice: null };
}

/**
 * The height assumed for a terminal that will not say, matching `style.ts`'s
 * 80-column fallback: 24 rows is what every terminal emulator opens at and what
 * a CI runner reports when it reports anything.
 */
export const DEFAULT_ROWS = 24;
