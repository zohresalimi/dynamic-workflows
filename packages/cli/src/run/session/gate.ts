/**
 * KAR-21.3 — answering the open gate from the terminal the operator is already
 * looking at.
 *
 * **Nothing about what an answer means is decided here.** Which HTTP request
 * answers which gate is `gateAnswerRequest`'s (`@DeFlow/core`, KAR-22.5), the
 * transport is `../gate-answer.ts`'s, and what an answer *does* is the daemon's.
 * This session is that function's third caller and its second surface, and it
 * adds no branch of its own — `test/session-answer-guard.test.ts` asserts that
 * no route string and no request body exists anywhere in this directory,
 * because the thing being protected is invisible in a diff that looks locally
 * reasonable.
 *
 * Three consequences of that rule are worth stating, because each one removes a
 * special case that would otherwise have had to be written and got wrong.
 *
 * **This file spells no option id.** Not `approve`, not `reject`, not `edit`.
 * The rows come from `gate.options`, and the two options that behave
 * differently are recognised from `gateAnswerRequest`'s own answer rather than
 * by name: a pair no endpoint answers comes back as `null` (the F1.3 gate's
 * `edit`, and `SPEC_EDIT_NEEDS_A_DOCUMENT` is the exported sentence saying
 * why), and an option that still needs words comes back with a **blank field in
 * its body** — the empty string `gate-answer.ts` deliberately passes through
 * rather than withholds. A plan gate that declares a fifth option therefore
 * works here on the day it is declared.
 *
 * **The session holds no opinion about whether a gate is open.** `pendingGate`
 * over the reduced state is the only reader, exactly as `watch()` in
 * `../run.ts` already does it. So an answer that arrives from the browser, a
 * second terminal or a deadline policy closes the prompt here through the
 * `human.responded` event already on the stream (AC6), a run holding two gates
 * offers the oldest (AC8), and a re-delivered event changes nothing — three
 * behaviours that are properties of the projection rather than code in this
 * file.
 *
 * **One gate gets one answer.** `GateState.sending` names the option on the
 * wire and every gate key is swallowed while it is set (AC7), because without
 * that window the second press is refused by the daemon for a gate that is now
 * closed and the operator reads a refusal that looks like a bug in a tool that
 * just did what they asked.
 *
 * The pure half (`applyGateIntent`) and the half that opens a socket
 * (`createGateSession`) are separated for the reason the whole epic is shaped
 * this way: the decisions are a table test, and only the sending needs a
 * daemon.
 *
 * Verifies: EPIC-21-S18, EPIC-21-S20, EPIC-21-S21, EPIC-21-S22, EPIC-21-S23,
 * EPIC-21-S24, EPIC-21-S25, EPIC-21-S26 · AC1–AC8
 */
import type { GateAnswerRequest, PendingGate, PendingGateOption, RunState } from '@DeFlow/core';
import { gateAnswerRequest, pendingGate, SPEC_EDIT_NEEDS_A_DOCUMENT } from '@DeFlow/core';
import type { DaemonEndpoint } from '../daemon.ts';
import type { GateAnswerOutcome, GateAnswerSender } from '../gate-answer.ts';
import { createGateAnswerSender, REJECTION_NEEDS_A_REASON } from '../gate-answer.ts';
import type { Intent } from './keys.ts';
import type { GateState, SessionState } from './state.ts';

/** The intents a gate prompt claims; everything else falls through to
 * `SESSION_ACTIONS`, which stays the one table AC8 of KAR-21.2 is about. */
const GATE_INTENTS = new Set<Intent>(['select-up', 'select-down', 'confirm', 'dismiss']);

/** Which row the keyboard is on, clamped to the option set the gate offered. */
function clamp(gate: PendingGate, at: number): number {
  return Math.min(Math.max(0, at), Math.max(0, gate.options.length - 1));
}

/** The option the highlighted row names, or `null` for a gate offering none. */
export function selectedOption(gate: PendingGate, state: GateState): PendingGateOption | null {
  return gate.options.length === 0 ? null : (gate.options[clamp(gate, state.selected)] ?? null);
}

/**
 * The field of `body` the operator still has to fill, or `null`.
 *
 * The empty string is `gateAnswerRequest`'s own signal and its comment says so:
 * a rejection's `reason` is *"passed through rather than withheld"*, so the
 * request it built for an option with nothing typed carries a blank where the
 * words go. Reading that is how this file knows which option opens an input row
 * without spelling one — and the field's own name is what the row asks for.
 */
function blankFieldOf(body: Readonly<Record<string, unknown>>): string | null {
  for (const [field, value] of Object.entries(body)) {
    if (value === '') return field;
  }
  return null;
}

/** What the frame says when a row was confirmed with nothing in it (AC3). */
export function needsTextNotice(field: string): string {
  return `a ${field} is required, and nothing is sent without one. ${REJECTION_NEEDS_A_REASON}`;
}

export interface GateIntentInput {
  readonly runId: string;
  /** `pendingGate(run)` — read by the caller so this stays pure. */
  readonly gate: PendingGate | null;
  readonly state: SessionState;
  readonly intent: Intent;
}

export interface GateIntentOutcome {
  /** The session afterwards — the same object when nothing changed. */
  readonly state: SessionState;
  /** The request `gateAnswerRequest` built, or `null` when none is to be sent. */
  readonly request: GateAnswerRequest | null;
}

/** `state` carrying one sentence about `gate`, and nothing else changed. */
function noticed(state: SessionState, gate: PendingGate, message: string): SessionState {
  return { ...state, gate: { ...state.gate, notice: { node: gate.node, message } } };
}

/**
 * What a key aimed at the gate does, as a pure function.
 *
 * `null` means *"not mine"* — the key was not one this prompt claims, or there
 * is no gate, or the keyboard is aimed elsewhere — and the caller then hands it
 * to `applyIntent`. Returning `null` rather than the unchanged state is what
 * keeps the two tables from having to agree about anything: this one is
 * consulted first and claims what it can act on.
 */
export function applyGateIntent(input: GateIntentInput): GateIntentOutcome | null {
  const { gate, state, intent } = input;
  if (gate === null || !GATE_INTENTS.has(intent)) return null;

  const typing = state.input !== null && state.input.kind === 'gate-text' ? state.input : null;
  if (typing === null && state.focus !== 'gate') return null;

  // AC7 — the rows are inert while an answer is on the wire. Swallowed rather
  // than passed on, so a second press cannot become a second answer by falling
  // through to something else.
  if (state.gate.sending !== null) return { state, request: null };

  if (intent === 'dismiss') {
    // A gate with no row open is left to `SESSION_ACTIONS`, which is what takes
    // the keyboard back off it. An open row is abandoned here, and the gate
    // stays exactly as open and as unanswered as it was (AC3).
    if (typing === null) return null;
    return {
      state: { ...state, input: null, gate: { ...state.gate, notice: null } },
      request: null,
    };
  }

  if (intent === 'select-up' || intent === 'select-down') {
    // The cursor is not what is being edited while a row is open.
    if (typing !== null) return { state, request: null };
    const next = clamp(
      gate,
      clamp(gate, state.gate.selected) + (intent === 'select-down' ? 1 : -1),
    );
    if (next === state.gate.selected && state.gate.notice === null) return { state, request: null };
    return {
      state: { ...state, gate: { ...state.gate, selected: next, notice: null } },
      request: null,
    };
  }

  const option =
    typing === null
      ? selectedOption(gate, state.gate)
      : (gate.options.find((one) => one.id === typing.optionId) ?? null);
  if (option === null) return { state, request: null };

  const request = gateAnswerRequest({
    runId: input.runId,
    gate: gate.node,
    optionId: option.id,
    text: typing === null ? null : typing.text,
  });

  // AC4 — no endpoint answers this pair, and the sentence saying why is the one
  // `deflow answer` prints and the browser's gate panel shows.
  if (request === null)
    return { state: noticed(state, gate, SPEC_EDIT_NEEDS_A_DOCUMENT), request: null };

  const blank = blankFieldOf(request.body);
  if (blank !== null) {
    // AC3 — the request still has a blank in it. First press opens the row to
    // fill it; a second press with the row still empty is refused here rather
    // than sent, because the daemon's refusal would cost a round trip to say
    // something this surface already knows.
    if (typing === null) {
      return {
        state: {
          ...state,
          input: { kind: 'gate-text', prompt: blank, text: '', optionId: option.id },
          gate: { ...state.gate, notice: null },
        },
        request: null,
      };
    }
    return { state: noticed(state, gate, needsTextNotice(blank)), request: null };
  }

  return {
    state: {
      ...state,
      input: null,
      gate: { selected: state.gate.selected, sending: option.id, notice: null },
    },
    request,
  };
}

/** The session once the daemon has answered: nothing in flight, and its words. */
export function gateSettled(
  state: SessionState,
  node: string,
  outcome: GateAnswerOutcome,
): SessionState {
  const message = outcome.ok ? null : outcome.message;
  return {
    ...state,
    gate: {
      ...state.gate,
      sending: null,
      // AC5 — verbatim, and only when there is something to forward. There is
      // no retry and no re-send: the daemon's sentence is the whole response.
      notice: message === null || message === '' ? null : { node, message },
    },
  };
}

export interface GateSessionOptions {
  readonly runId: string;
  /** The daemon this session is already connected to, and its own token. */
  readonly endpoint: Pick<DaemonEndpoint, 'baseUrl' | 'token'>;
  /** The projection right now — read at each key, never held. */
  readonly run: () => RunState;
  readonly state: () => SessionState;
  readonly onState: (state: SessionState) => void;
  /** Injected so a spec can record what left without mocking a module. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected whole for the specs that need no HTTP at all. */
  readonly send?: GateAnswerSender;
}

export interface GateSession {
  /** Offer a key to the gate; `false` means the caller should handle it. */
  handle(intent: Intent): boolean;
  /** Resolves once nothing is on the wire — the seam a spec waits on. */
  settled(): Promise<void>;
}

/**
 * The gate prompt, wired to a daemon.
 *
 * A closure over the four functions it was handed rather than a holder of
 * state, per `state.ts`: two sessions in one process are two values that cannot
 * see each other, and there is no module-level variable anywhere under
 * `run/session/`.
 */
export function createGateSession(options: GateSessionOptions): GateSession {
  const send = options.send ?? createGateAnswerSender(options.endpoint, options.fetch);
  let inFlight: Promise<void> | null = null;

  return {
    handle(intent) {
      const gate = pendingGate(options.run());
      const before = options.state();
      const outcome = applyGateIntent({ runId: options.runId, gate, state: before, intent });
      if (outcome === null) return false;
      if (outcome.state !== before) options.onState(outcome.state);

      const request = outcome.request;
      if (request !== null && gate !== null) {
        const node = gate.node;
        inFlight = (async () => {
          const settled = await send(request).catch(
            (thrown: unknown): GateAnswerOutcome => ({
              ok: false,
              status: 0,
              code: null,
              message: thrown instanceof Error ? thrown.message : String(thrown),
            }),
          );
          // Read again rather than closed over: an event may have folded a
          // `human.responded` into the projection while this was on the wire,
          // and the state that comes back is the one that arrived, not the one
          // that left (AC6, the race in EPIC-21-S24).
          options.onState(gateSettled(options.state(), node, settled));
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
