/**
 * KAR-19.6 AC2 — the sentence a client is told when it asks for a cancel mode
 * that does not exist.
 *
 * The wording lives here rather than at either end because both ends refuse:
 * the daemon's `POST /api/runs/:id/cancel` refuses an unknown `mode` with
 * `invalid_request`, and `DeFlow cancel --mode <x>` refuses it **before any
 * request is sent**, so the operator is not made to wait on a round trip to
 * learn they mistyped a word. Two refusals of one thing are two chances to
 * disagree about it — which is the failure this whole epic is about, one layer
 * down — so there is one sentence and the closed list is read from
 * `CANCEL_MODES` rather than typed out.
 *
 * The explanation is not decoration either. The two ladders differ in exactly
 * one operator-visible way — whether the agent gets to flush its transcript —
 * and that is the reason the daemon refuses to guess a default on a request
 * that named a mode at all.
 */
import { CANCEL_MODES } from './event-payloads.ts';

/** `"cooperative", "forceful"` — the closed list, quoted, in declared order. */
export function cancelModeList(): string {
  return CANCEL_MODES.map((mode) => `"${mode}"`).join(', ');
}

/** The one refusal both the daemon and the CLI speak. */
export function invalidCancelModeMessage(): string {
  return (
    `mode must be one of ${cancelModeList()}: ` +
    'one lets the agent flush its transcript and one does not, and guessing on the ' +
    "operator's behalf would be guessing about whether that transcript survives"
  );
}
