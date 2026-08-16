/**
 * KAR-21.4 AC7, AC8 — ending a run from the session, in two decisions.
 *
 * **`cancelRun` is called, not re-implemented.** `../cancel.ts` is the client
 * `deflow cancel` and the double-Ctrl-C window (KAR-18.3 AC3) already use, and
 * it is handed in as a function rather than reached for here — which is also
 * what keeps this file inside `../../../test/session-answer-guard.test.ts`'s
 * rule that no route and no request body exists under `run/session/`.
 *
 * **The default is no.** The confirmation is a typed row, so a bare Enter is an
 * empty line and an empty line is not a yes. That is the rule KAR-20.2 AC5
 * applies to editing a shell profile, and it matters more here: the thing on
 * the other side of the keypress may have hours of work in it, and `c` is next
 * to keys that do far less.
 *
 * **The session stays open afterwards (AC8).** Nothing in this file exits, and
 * nothing in it touches `../interrupt.ts`. A cooperative cancel gives the agent
 * the chance to flush its transcript first, so the interesting part happens
 * *after* the request returns — a session that exited on the request would hide
 * exactly the part the operator cancelled in order to look at. The screen comes
 * down where it always did: when `watch()` sees the run reach a terminal state
 * and `RunRenderer.final` prints the verdict.
 *
 * Verifies: EPIC-21-S35, EPIC-21-S36 · AC7, AC8 · test plan #7, #8
 */
import type { RunId } from '@DeFlow/core';
import type { CancelOutcome } from '../cancel.ts';
import type { Intent } from './keys.ts';
import type { SessionState } from './state.ts';

/** The intents the confirmation claims. `cancel` opens it; the other two answer
 * it. Everything else falls through, including Ctrl-C. */
const CANCEL_INTENTS = new Set<Intent>(['cancel', 'confirm', 'dismiss']);

/**
 * AC7 — the question, naming the run it would end.
 *
 * The run id is in it because a terminal watching one run still sits beside
 * terminals watching others, and *"cancel?"* is a question about nothing in
 * particular. `[y/N]` is the conventional spelling of a default, and the
 * capital is the answer a bare Enter gives.
 */
export function cancelPrompt(runId: string): string {
  return `cancel run ${runId}? [y/N]`;
}

/** What the frame says when the confirmation was answered with anything else. */
export const CANCEL_ABANDONED = 'not cancelled — the run continues';

/** What it says while the request is on the wire. */
export const CANCEL_SENDING = 'cancelling — waiting for the daemon';

/**
 * The answers that mean yes.
 *
 * A short closed set rather than "anything that is not no", because the
 * asymmetry is the whole point: a mistyped answer must not end a run.
 */
const YES = new Set(['y', 'yes']);

export interface CancelIntentInput {
  readonly runId: RunId;
  readonly state: SessionState;
  readonly intent: Intent;
}

export interface CancelIntentOutcome {
  /** The session afterwards — the same object when nothing changed. */
  readonly state: SessionState;
  /** Whether `cancelRun` is to be called. */
  readonly cancel: boolean;
}

/** `state` carrying one sentence about the cancel, and nothing else changed. */
function noticed(state: SessionState, message: string | null): SessionState {
  return { ...state, cancel: { ...state.cancel, notice: message } };
}

/**
 * What a key aimed at this verb does, as a pure function.
 *
 * `null` means *"not mine"*, exactly as in `./interject.ts` and `./gate.ts`:
 * the caller offers the key on to the next table.
 */
export function applyCancelIntent(input: CancelIntentInput): CancelIntentOutcome | null {
  const { state, intent } = input;
  if (!CANCEL_INTENTS.has(intent)) return null;

  const confirming =
    state.input !== null && state.input.kind === 'cancel-confirm' ? state.input : null;

  // Inert while the request is on the wire: a second press would be a second
  // cancel for a run the daemon is already stopping.
  if (state.cancel.sending) return { state, cancel: false };

  if (intent === 'cancel') {
    // A row of somebody else's is not this verb's to replace, and the `c` that
    // arrived while one was open was a letter (see `applyTyping`).
    if (state.input !== null) return null;
    return {
      state: noticed(
        {
          ...state,
          input: { kind: 'cancel-confirm', prompt: cancelPrompt(input.runId), text: '' },
        },
        null,
      ),
      cancel: false,
    };
  }

  if (confirming === null) return null;

  if (intent === 'dismiss') {
    return { state: noticed({ ...state, input: null }, CANCEL_ABANDONED), cancel: false };
  }

  const yes = YES.has(confirming.text.trim().toLowerCase());
  return {
    state: {
      ...state,
      input: null,
      cancel: { sending: yes, notice: yes ? CANCEL_SENDING : CANCEL_ABANDONED },
    },
    cancel: yes,
  };
}

/** AC8 — the session once `cancelRun` has answered: its outcome, in its own
 * words, and the screen still open behind it. */
export function cancelSettled(state: SessionState, outcome: CancelOutcome): SessionState {
  return { ...state, cancel: { sending: false, notice: outcome.message } };
}

export interface CancelSessionOptions {
  readonly runId: RunId;
  readonly state: () => SessionState;
  readonly onState: (state: SessionState) => void;
  /** `cancelRun` (`../cancel.ts`), handed in — the same client `deflow cancel`
   * and the double-Ctrl-C path already use. */
  readonly cancel: () => Promise<CancelOutcome>;
}

export interface CancelSession {
  /** Offer a key to this verb; `false` means the caller should handle it. */
  handle(intent: Intent): boolean;
  /** Resolves once nothing is on the wire — the seam a spec waits on. */
  settled(): Promise<void>;
}

export function createCancelSession(options: CancelSessionOptions): CancelSession {
  let inFlight: Promise<void> | null = null;

  return {
    handle(intent) {
      const before = options.state();
      const outcome = applyCancelIntent({ runId: options.runId, state: before, intent });
      if (outcome === null) return false;
      if (outcome.state !== before) options.onState(outcome.state);

      if (outcome.cancel) {
        inFlight = (async () => {
          const settled = await options.cancel().catch(
            (thrown: unknown): CancelOutcome => ({
              via: 'cancel',
              message: thrown instanceof Error ? thrown.message : String(thrown),
            }),
          );
          options.onState(cancelSettled(options.state(), settled));
        })().finally(() => {
          inFlight = null;
        });
      }
      return true;
    },

    async settled() {
      while (inFlight !== null) await inFlight;
    },
  };
}
