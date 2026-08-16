/**
 * KAR-21.4 — saying something to the node that is running, from the session the
 * operator is already in.
 *
 * F8.2 is *"interject at any time"*, and from a terminal the answer before this
 * story was never: `POST /api/runs/:id/interject` has existed since KAR-13.3
 * and no command reached it. **None of that mechanism moves here.** The
 * decision is `planInterjection`'s, the capability lookup is the daemon's, and
 * the delivery outcome is something this file *renders* rather than computes —
 * so there is no `provider_capabilities` read anywhere in it and no branch that
 * decides a run "looks steerable".
 *
 * Four consequences of that rule, each removing a special case that would
 * otherwise have had to be written and got wrong.
 *
 * **The node id is the projection's, read at send time.** The operator is never
 * asked for one — a node id is DeFlow's vocabulary, and an operator asked to
 * type one has to go and look it up while the thing they wanted to correct
 * carries on. Reading it when the request is built rather than when the row
 * opened is the difference between steering what is running and steering what
 * was running when the frame was last painted.
 *
 * **`ifLastSeq` travels with every request.** A frame is by construction a
 * moment behind the ledger, so the node may have finished between the repaint
 * and the keypress. `stale_cursor` is KAR-13.3 AC6's answer to exactly that,
 * and omitting the cursor would make the session the one surface that cannot be
 * told it was looking at the past. Nothing re-sends with a newer cursor on its
 * own: the node the operator addressed is gone, and silently re-addressing the
 * next one is not what they asked for.
 *
 * **The alternative mode is taken off the response.** An `unsupported` delivery
 * is a `202` carrying the daemon's sentence and the mode that does work; this
 * file offers a keypress to re-send with it and spells neither. A second copy
 * of a vocabulary the daemon owns drifts from it, and the drift shows up as
 * guidance that is silently never delivered.
 *
 * **Nothing is printed optimistically.** An accepted interjection reaches the
 * transcript when its `human.interjected` event arrives on the stream, through
 * the renderer every other event goes through (`../render.ts`). The frame says
 * what the *request* did; the transcript says what the *ledger* has. Without
 * that split a refused interjection reads on screen exactly like an accepted
 * one.
 *
 * Verifies: EPIC-21-S28, EPIC-21-S29, EPIC-21-S30, EPIC-21-S31, EPIC-21-S32,
 * EPIC-21-S33, EPIC-21-S34 · AC1–AC6
 */
import type { RunId, RunState } from '@DeFlow/core';
import type { DaemonEndpoint } from '../daemon.ts';
import type { InterjectionOutcome, InterjectionRequest, InterjectionSender } from '../interject.ts';
import { createInterjectionSender, SESSION_INTERJECTION_MODE } from '../interject.ts';
import { SESSION_ACTIONS } from './actions.ts';
import type { Intent } from './keys.ts';
import type { SessionState } from './state.ts';

/**
 * AC4 — what the frame says when the key is pressed between nodes.
 *
 * The daemon would refuse this anyway (`node_not_running`), and the reason for
 * refusing it locally is not efficiency: the refusal costs a round trip during
 * which the operator believes they have said something, and an interjection
 * recorded against a node that has finished is an audit trail implying
 * something happened.
 */
export const NOTHING_RUNNING = 'nothing is running to interject into';

/** AC3 — what the frame says while the request is on the wire. */
export const INTERJECTION_SENDING = 'sending — the row is inert until the daemon answers';

/** AC3, AC6 — what a `queued` delivery means, and what it deliberately is not.
 * The line about the interjection itself comes from the ledger. */
export const INTERJECTION_QUEUED =
  'interjection queued — it appears in the transcript when the ledger has it';

/** AC3 — the offer, naming the daemon's own alternative and the key that takes
 * it. One keypress, one further request, and no automatic retry. */
export function resendOffer(mode: string): string {
  return `press r to re-send with mode '${mode}', or any other key to leave it`;
}

/** The intents this verb can claim; everything else falls through to the gate
 * and then to the one `SESSION_ACTIONS` table. */
const INTERJECT_INTENTS = new Set<Intent>(['interject', 'confirm', 'dismiss', 'resend']);

/**
 * AC1, AC4 — the node an interjection is aimed at, or `null`.
 *
 * The reduced state's own answer, in the order the frame lists its rows, so the
 * node this steers is the one at the top of the region the operator is looking
 * at. Nothing here asks which node *should* be running.
 */
export function runningNode(run: RunState): string | null {
  return (
    Object.keys(run.nodes)
      .filter((id) => run.nodes[id]?.status === 'running')
      .toSorted((left, right) => left.localeCompare(right))[0] ?? null
  );
}

export interface InterjectIntentInput {
  readonly runId: RunId;
  /** The projection right now — read at each key, never held. */
  readonly run: RunState;
  readonly state: SessionState;
  readonly intent: Intent;
  /** The seq this session last rendered (AC2). */
  readonly lastSeq: number;
}

export interface InterjectIntentOutcome {
  /** The session afterwards — the same object when nothing changed. */
  readonly state: SessionState;
  /** What to send, or `null` when nothing is to be sent. */
  readonly request: InterjectionRequest | null;
}

/** `state` carrying one sentence about the interjection, and nothing else. */
function noticed(state: SessionState, message: string | null): SessionState {
  return { ...state, interject: { ...state.interject, notice: message, resend: null } };
}

/**
 * What a key aimed at this verb does, as a pure function.
 *
 * `null` means *"not mine"* — the caller then offers it to the gate and to
 * `applyIntent`. Returning `null` rather than the unchanged state is what keeps
 * the tables from having to agree about anything: this one is consulted first
 * and claims only what it can act on.
 */
export function applyInterjectIntent(input: InterjectIntentInput): InterjectIntentOutcome | null {
  const { run, state, intent } = input;
  const typing = state.input !== null && state.input.kind === 'interject' ? state.input : null;

  // Ctrl-C is never claimed, by anything here. KAR-18.3 AC3 owns it, and an
  // offer on screen must not be able to swallow the one key that gets an
  // operator out.
  if (intent === 'interrupt') return null;

  /**
   * AC3 — the offer is the question on screen, so the next key answers it.
   *
   * Modal on purpose: `r` re-sends, anything else dismisses it, and the key
   * that dismissed it is spent doing so. A key that both dismissed the offer
   * and did its own thing would make "one keypress, one further request" depend
   * on which key it was.
   */
  const offer = state.interject.resend;
  if (offer !== null) {
    if (intent !== 'resend') {
      return {
        state: { ...state, interject: { ...state.interject, resend: null } },
        request: null,
      };
    }
    return {
      state: {
        ...state,
        interject: { sending: true, notice: INTERJECTION_SENDING, resend: null },
      },
      request: {
        runId: input.runId,
        node: offer.node,
        text: offer.text,
        // The daemon's word for the mode that works, carried back unchanged.
        mode: offer.mode,
        ifLastSeq: input.lastSeq,
      },
    };
  }

  if (!INTERJECT_INTENTS.has(intent)) return null;

  // AC3 — inert while an interjection is on the wire, swallowed rather than
  // passed on: a second press must not become a second interjection by falling
  // through to something else.
  if (state.interject.sending) return { state, request: null };

  if (intent === 'resend') return null;

  if (intent === 'interject') {
    // A row of somebody else's is not this verb's to close.
    if (state.input !== null) return null;
    // AC4 — one explanatory line and zero requests. No row opens, because a row
    // that opens is a row the operator types a correction into.
    if (runningNode(run) === null) return { state: noticed(state, NOTHING_RUNNING), request: null };
    // Opened through the table rather than beside it, so there is one answer to
    // what the interjection row looks like when it opens (KAR-21.2 AC7).
    return { state: noticed(SESSION_ACTIONS.interject.apply(state), null), request: null };
  }

  if (typing === null) return null;

  if (intent === 'dismiss') {
    // AC1 — Escape abandons and sends nothing.
    return { state: noticed({ ...state, input: null }, null), request: null };
  }

  // `confirm`, with the row open: the whole of AC1's other half.
  const node = runningNode(run);
  if (node === null) {
    // The node finished while the row was open. Nothing is sent, for AC4's
    // reason, and the operator is told rather than left with a closed row.
    return { state: noticed({ ...state, input: null }, NOTHING_RUNNING), request: null };
  }

  return {
    state: {
      ...state,
      input: null,
      interject: { sending: true, notice: INTERJECTION_SENDING, resend: null },
    },
    request: {
      runId: input.runId,
      node,
      text: typing.text,
      mode: SESSION_INTERJECTION_MODE,
      ifLastSeq: input.lastSeq,
    },
  };
}

/**
 * AC3, AC5 — the session once the daemon has answered.
 *
 * Every sentence here is the daemon's whenever the daemon wrote one. The one
 * this file owns is the `queued` acknowledgement, which says only that the
 * request was accepted — what happened to the guidance is the ledger's to say.
 */
export function interjectSettled(
  state: SessionState,
  request: InterjectionRequest,
  outcome: InterjectionOutcome,
): SessionState {
  if (!outcome.ok) {
    // AC5 — verbatim, once, with no retry. `use_respond` in particular directs
    // the operator to the gate answer KAR-21.3 provides, in the daemon's words.
    return { ...state, interject: { sending: false, notice: outcome.message, resend: null } };
  }

  if (outcome.delivery === 'queued') {
    return { ...state, interject: { sending: false, notice: INTERJECTION_QUEUED, resend: null } };
  }

  // AC3 — an `unsupported` delivery is an outcome, not an error: the operator
  // did nothing wrong and retrying will not help. What helps is the alternative,
  // which is why the answer names it and why it is offered rather than taken.
  const alternative = outcome.alternative;
  return {
    ...state,
    interject: {
      sending: false,
      notice: outcome.message,
      resend:
        alternative === null ? null : { node: request.node, text: request.text, mode: alternative },
    },
  };
}

export interface InterjectSessionOptions {
  readonly runId: RunId;
  /** The daemon this session is already connected to, and its own token. */
  readonly endpoint: Pick<DaemonEndpoint, 'baseUrl' | 'token'>;
  /** The projection right now — read at each key, never held. */
  readonly run: () => RunState;
  readonly state: () => SessionState;
  readonly onState: (state: SessionState) => void;
  /** The seq this session last rendered (AC2). */
  readonly lastSeq: () => number;
  /** Injected so a spec can record what left without mocking a module. */
  readonly fetch?: typeof globalThis.fetch;
  /** Injected whole for the specs that need no HTTP at all. */
  readonly send?: InterjectionSender;
}

export interface InterjectSession {
  /** Offer a key to this verb; `false` means the caller should handle it. */
  handle(intent: Intent): boolean;
  /** Resolves once nothing is on the wire — the seam a spec waits on. */
  settled(): Promise<void>;
}

/**
 * The interject verb, wired to a daemon.
 *
 * A closure over the functions it was handed rather than a holder of state, per
 * `state.ts`: two sessions in one process are two values that cannot see each
 * other, and there is no module-level variable anywhere under `run/session/`.
 */
export function createInterjectSession(options: InterjectSessionOptions): InterjectSession {
  const send = options.send ?? createInterjectionSender(options.endpoint, options.fetch);
  let inFlight: Promise<void> | null = null;

  return {
    handle(intent) {
      const before = options.state();
      const outcome = applyInterjectIntent({
        runId: options.runId,
        run: options.run(),
        state: before,
        intent,
        lastSeq: options.lastSeq(),
      });
      if (outcome === null) return false;
      if (outcome.state !== before) options.onState(outcome.state);

      const request = outcome.request;
      if (request !== null) {
        inFlight = (async () => {
          const settled = await send(request).catch(
            (thrown: unknown): InterjectionOutcome => ({
              ok: false,
              status: 0,
              code: null,
              message: thrown instanceof Error ? thrown.message : String(thrown),
            }),
          );
          // Read again rather than closed over: events fold into the projection
          // while a request is on the wire, and the state that comes back is
          // the one that arrived rather than the one that left.
          options.onState(interjectSettled(options.state(), request, settled));
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
