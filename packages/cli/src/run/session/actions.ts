/**
 * KAR-21.2 AC7, AC8 — what each intent does to the session, as a table.
 *
 * A `Record<Intent, …>` rather than a `switch`, which buys AC8's first half at
 * compile time: an intent added to `INTENTS` without an entry here does not
 * build. The half a type cannot check — a key *removed* from `KEY_BINDINGS`
 * leaving an action stranded, or an action added with no key to reach it — is
 * `actions.test.ts`'s two set differences, and the hint line `view.ts` prints is
 * built from the same `KEY_BINDINGS`, so all three agree by construction rather
 * than by vigilance.
 *
 * Every action is a **pure function of the state it was handed**, per
 * `state.ts`: no module-level variable, nothing read from the environment, and
 * the caller owns the value. That is what makes "press i, then Escape, then the
 * up arrow" three lines in a test instead of a person at a terminal.
 *
 * An action that changes nothing returns **the same object**, not an equal one.
 * AC7 says an unrecognised key causes no repaint, and the cheapest way for a
 * caller to know whether to repaint is a reference comparison — so identity here
 * is part of the contract, not an optimisation.
 *
 * Two things this story deliberately does not do. Nothing here talks to a
 * daemon: `confirm` closes the row and KAR-21.3/KAR-21.4 are what send the
 * answer and the interjection. And `interrupt` changes no state at all — it is
 * reported as an effect for the caller to hand to `../interrupt.ts`, because
 * KAR-18.3 AC3 owns what Ctrl-C means and a session that decided for itself
 * would have added the third meaning AC5 forbids.
 */
import type { Intent } from './keys.ts';
import type { SessionFocus, SessionState } from './state.ts';

/**
 * What the caller must do that the state cannot express.
 *
 * Only two values, and the asymmetry is the point: everything a session can
 * answer by itself is a new `SessionState`, and the one thing it cannot is
 * named rather than smuggled out as a mutation.
 */
export type IntentEffect = 'none' | 'interrupt';

export interface IntentOutcome {
  /** The session afterwards — the same object when nothing changed. */
  readonly state: SessionState;
  readonly effect: IntentEffect;
}

export interface SessionAction {
  readonly effect: IntentEffect;
  readonly apply: (state: SessionState) => SessionState;
}

/** What the interjection row asks for. Also the string the frame prints before
 * the caret, so it is stated once rather than in the view and here. */
export const INTERJECT_PROMPT = 'interject';

/**
 * The regions the arrows move between, bottom to top.
 *
 * An ordered list rather than a pair of `switch`es so "up" and "down" are one
 * index step in opposite directions and cannot disagree about the order. It does
 * **not** wrap: a list that wraps means the operator holding the up arrow ends
 * up somewhere they were not looking, and there are three regions here, not
 * thirty.
 */
const FOCUS_LADDER: readonly SessionFocus[] = ['transcript', 'plan', 'gate'];

/** `state` with the focus moved one rung, clamped at both ends. */
function moveFocus(state: SessionState, step: 1 | -1): SessionState {
  const at = FOCUS_LADDER.indexOf(state.focus);
  const next = FOCUS_LADDER[Math.min(FOCUS_LADDER.length - 1, Math.max(0, at + step))];
  return next === undefined || next === state.focus ? state : { ...state, focus: next };
}

export const SESSION_ACTIONS: Readonly<Record<Intent, SessionAction>> = {
  /** Aim the keyboard at the gate; KAR-21.3 is what answers one. */
  answer: {
    effect: 'none',
    apply: (state) => (state.focus === 'gate' ? state : { ...state, focus: 'gate' }),
  },

  /** Open the row. KAR-21.4 is what types into it and sends it. */
  interject: {
    effect: 'none',
    apply: (state) => ({
      ...state,
      input: { kind: 'interject', prompt: INTERJECT_PROMPT, text: '' },
    }),
  },

  'select-up': { effect: 'none', apply: (state) => moveFocus(state, 1) },
  'select-down': { effect: 'none', apply: (state) => moveFocus(state, -1) },

  /** Close the row. What to *do* with what was typed belongs to the two stories
   * that put something in it; leaving it open would be the half-open state
   * `state.ts` exists to make unrepresentable. */
  confirm: {
    effect: 'none',
    apply: (state) => (state.input === null ? state : { ...state, input: null }),
  },

  /** Back out of whatever is open, in one keystroke, from anywhere. */
  dismiss: {
    effect: 'none',
    apply: (state) =>
      state.input === null && state.focus === 'transcript'
        ? state
        : { ...state, input: null, focus: 'transcript' },
  },

  /** KAR-18.3 AC3's, untouched. @see `../interrupt.ts` */
  interrupt: { effect: 'interrupt', apply: (state) => state },

  /** AC7 — an unrecognised key does nothing at all: no beep, no error line, and
   * the same object back so the caller does not repaint. */
  none: { effect: 'none', apply: (state) => state },
};

export function applyIntent(state: SessionState, intent: Intent): IntentOutcome {
  const action = SESSION_ACTIONS[intent];
  return { state: action.apply(state), effect: action.effect };
}
