/**
 * KAR-22.5 AC2 — *which* request answers a gate, decided once.
 *
 * There are two ways to answer a human gate and the choice between them is not
 * a preference. The F1.3 spec gate's four decisions are **four endpoints**
 * (KAR-10.3): approving pins the spec, rejecting mints a reframing attempt and
 * abandoning ends the run, and each of those is a different transaction on the
 * daemon's side. Every other gate — a plan `human` node, a permission
 * escalation, a repair loop that ran out of attempts — is one endpoint and an
 * option id (`POST /runs/:id/nodes/:nodeId/respond`, KAR-13.1).
 *
 * Until this module there was exactly one caller that had to make that choice,
 * `deflow answer`, and it made it privately. KAR-22.5 adds a second — the gate
 * panel in the browser — and a second private copy is how the day a fifth spec
 * decision is added ends with one surface still answering the old way. So the
 * decision moved here, beside `SPEC_DECISIONS` and `SPEC_APPROVAL_OPTIONS`,
 * which is where the vocabulary it branches on already lives.
 *
 * Two things are deliberately **not** here. The **transport** is the caller's:
 * `deflow answer` reads a token file and `fetch`es, the browser goes through
 * the typed client, and neither of those is a domain fact. And the
 * `X-DeFlow-Submitted-By` header is the caller's too — it is a statement about
 * *who* is answering, and the whole reason it exists is that the two surfaces
 * give different answers.
 *
 * Verifies: EPIC-22-S60 · KAR-22.5 AC2, AC4
 */
import type { NodeId } from './ids.ts';
import { SPEC_GATE_NODE_ID } from './spec-gate-node.ts';

/** The one option no surface can answer by naming it. @see the constant below. */
const EDIT = 'edit';

/**
 * Why the F1.3 gate's `edit` is not answerable by choosing it (AC4).
 *
 * One exported sentence with two renderers: `deflow answer` prints it when the
 * argv names `--option edit`, and the browser's gate panel shows it beside the
 * option it will not submit. A limitation explained two ways is a limitation an
 * operator has to discover twice, which is the whole of R4.
 *
 * It does **not** name a surface that can do it instead, because none can yet:
 * `POST /api/runs/:id/spec/edit` takes the whole replacement document, and
 * pointing an operator at a screen that does not exist is worse than telling
 * them plainly that this one cannot.
 */
export const SPEC_EDIT_NEEDS_A_DOCUMENT =
  "'edit' replaces the whole amended framed document (DeFlow.taskspecdraft.v1), not one field — " +
  'the gate computes the RFC 6902 patch itself, so there is nothing an option id could carry that ' +
  'the ledger could record honestly. Answer with approve, reject or abandon.';

/** What a surface knows when an operator presses a button. */
export interface GateAnswer {
  readonly runId: string;
  /** The gate's node id, exactly as `pendingGate` reported it. */
  readonly gate: NodeId | string;
  /** One of the ids the gate's own option set offered. */
  readonly optionId: string;
  /** `reject`'s reason, `inject`'s guidance, or a note on any option. */
  readonly text?: string | null | undefined;
}

/**
 * Which endpoint answers, as a value a typed client can switch on.
 *
 * `path` alone is enough for a caller holding a `fetch`; it is not enough for
 * one holding `hc<ApiType>`, whose route accessors are properties rather than
 * strings. Both travel together so neither caller has to re-derive the other,
 * and the browser spec asserts the URL it really sent against `path`.
 */
export type GateAnswerTarget =
  | { readonly kind: 'spec-decision'; readonly decision: 'approve' | 'reject' | 'abandon' }
  | { readonly kind: 'node-response'; readonly node: NodeId | string };

export interface GateAnswerRequest {
  readonly target: GateAnswerTarget;
  /** The absolute API path, `/api` included. */
  readonly path: string;
  /** The JSON body that endpoint takes, and nothing beyond it. */
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * The request that answers `answer`, or `null` when no request can.
 *
 * `null` is reachable for exactly one pair — the F1.3 gate's `edit` — and
 * `SPEC_EDIT_NEEDS_A_DOCUMENT` is why. A non-spec gate's `edit` is an ordinary
 * `HumanOptionEffect` that supplies the node's output, and `respond` takes it,
 * so it routes like every other option: the two share a word and nothing else.
 */
export function gateAnswerRequest(answer: GateAnswer): GateAnswerRequest | null {
  const { runId, gate, optionId } = answer;

  if (gate === SPEC_GATE_NODE_ID) {
    if (optionId === EDIT) return null;
    if (optionId !== 'approve' && optionId !== 'reject' && optionId !== 'abandon') return null;
    return {
      target: { kind: 'spec-decision', decision: optionId },
      path: `/api/runs/${runId}/spec/${optionId}`,
      // A rejection carries a reason and the route refuses one without it; the
      // empty string is passed through rather than withheld, so the refusal an
      // operator sees is the daemon's sentence about a blank reason and not a
      // client-side guess at what the route wanted.
      body: optionId === 'reject' ? { reason: answer.text ?? '' } : {},
    };
  }

  return {
    target: { kind: 'node-response', node: gate },
    path: `/api/runs/${runId}/nodes/${gate}/respond`,
    body: {
      optionId,
      ...(answer.text === null || answer.text === undefined || answer.text === ''
        ? {}
        : { text: answer.text }),
    },
  };
}
