/**
 * KAR-13.3 — an interjection into a running node, as a value
 * (docs/11-api-and-realtime.md §7.5, docs/08-context-and-memory.md §4.2).
 *
 * The story is *"hand a node a correction without throwing the run away"*, and
 * three decisions carry the module.
 *
 * **`unsupported` is an answer, not an error.** F8.5 is P1 and
 * adapter-dependent; two of the five probed adapters cannot even resume a
 * session (**verified 2026-08-02**). So the delivery vocabulary has a word for
 * *"this adapter cannot be steered mid-turn"*, it travels on a `202`, and it is
 * folded into the projection the UI reads. An error status would imply the
 * Operator did something wrong and would invite a retry that also cannot work.
 * The answer is read off the **probed capability row** and off nothing else —
 * there is no provider name in this file, exactly as there is none in
 * `@DeFlow/adapters`' `capabilities.ts`.
 *
 * **An interjection is never a retry.** Nothing here mints an attempt, and
 * `node.retry.scheduled` is not among the events any path returns. `attempt` is
 * part of the idempotency key (docs/05-durable-execution.md §9.2), so a
 * re-attempt would re-execute completed effects — which is precisely the
 * "throwing the run away" the story forbids. `pause-and-inject` suspends and
 * resumes on the same attempt, and the effect journal answers the rest.
 *
 * **The guidance is an attributed segment, not a spliced prompt.** It enters the
 * next packet as its own segment carrying the Operator's bytes verbatim and the
 * `seq` of the event that produced it, so the node inspector (F10.3) can render
 * it beside everything else the node received with its own token count. It is
 * *not* pinned: the pinned set is what the F6.6 integrity check asserts on every
 * render, and growing it without bound is how that check starts failing on long
 * runs (docs/04-domain-model.md §2). Guidance that must survive belongs in the
 * spec, where editing it produces a new `specHash`.
 *
 * **Why provenance is derived rather than stored.** `DeFlow.contextpacket.v1`
 * is shipped, copied into every run directory as `.DeFlow/schemas/`, and
 * content-hash-pinned by `packages/core/test/schemas-append-only.test.ts`.
 * Adding a `provenance` field to `Segment` for one derivable fact would publish
 * a `.v2` of the whole packet document — so the fact travels in the one place
 * a segment already has room for it, its **id namespace**: `human-<seq>`, read
 * back by `segmentProvenance`. The id also carries the `seq`, which is the
 * other half of what S21 asks the manifest to say.
 *
 * Verifies: EPIC-13-S17 (the planning half), EPIC-13-S18, EPIC-13-S20,
 * EPIC-13-S21 · AC1, AC2, AC3, AC5, AC6, AC7, AC8, AC9
 */
import type { EmittedEvent } from './command.ts';
import type { Segment } from './context-packet.ts';
import type { InterjectionDelivery, InterjectionMode } from './event-payloads.ts';
import { openHumanGate } from './human-gate.ts';
import { type EventSeq, EventSeqSchema, type NodeId } from './ids.ts';
import { contextSegment, type TokenEstimator } from './pinned-set.ts';
import type { NodeStatus, RunState } from './run-state.ts';
import { toSingleLine } from './text.ts';

export type { InterjectionDelivery, InterjectionMode } from './event-payloads.ts';
export { INTERJECTION_DELIVERIES, INTERJECTION_MODES } from './event-payloads.ts';

/** The route an Operator is pointed at when they reach for the wrong one (AC7). */
export const RESPOND_ROUTE = 'POST /runs/:id/nodes/:nodeId/respond';

/** A node that has finished is a node no guidance can reach. */
const TERMINAL_NODE_STATUSES: readonly NodeStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * One interjection as the projection holds it, with the `seq` that recorded it.
 *
 * `delivery` is mutable state in the sense that a receipt moves it from
 * `queued` to `delivered` — but it is moved by folding a *second event*, never
 * by rewriting the first, because events are never rewritten on disk.
 */
export interface InterjectionState {
  /** The `seq` of the `human.interjected` that recorded it. */
  readonly seq: number;
  readonly node: NodeId;
  /** Byte-identical to what the Operator posted. */
  readonly text: string;
  readonly mode: InterjectionMode;
  readonly delivery: InterjectionDelivery;
}

export interface InterjectionRequest {
  readonly node: NodeId;
  readonly text: string;
  readonly mode: InterjectionMode;
  /**
   * What the node's adapter advertised about mid-turn steering, from its probed
   * capability row. `undefined` — never advertised — is treated exactly like a
   * refusal, for the reason `reinjection.ts` gives: the decision is driven by
   * the capability, never by a provider name.
   */
  readonly steering: boolean | undefined;
}

export interface InterjectionAccepted {
  readonly status: 'ok';
  /** Accept-time only. `delivered` is a later observation, never this. */
  readonly delivery: Exclude<InterjectionDelivery, 'delivered'>;
  /** What to append, in order. Never a retry and never a new attempt. */
  readonly events: readonly EmittedEvent[];
  /** The attempt the node is on, unchanged by this interjection (AC3). */
  readonly attempt: number;
}

export type InterjectionRefusal =
  | { readonly status: 'node_not_found'; readonly message: string }
  | {
      readonly status: 'node_not_running';
      readonly message: string;
      readonly nodeStatus: NodeStatus;
    }
  | { readonly status: 'use_respond'; readonly message: string }
  | { readonly status: 'empty_text'; readonly message: string };

export type InterjectionOutcome = InterjectionAccepted | InterjectionRefusal;

/**
 * AC1, AC2, AC3, AC6, AC7 — what posting an interjection appends, or why it may
 * not be posted.
 *
 * Total, and a value rather than a throw, for the same reason
 * `planHumanResponse` is: every refusal here is something a client did, and the
 * API turns each into its own status code. **A refusal appends nothing at all**
 * — an interjection recorded against a completed node would be a ledger entry
 * with no possible effect, which is worse than an error because it is an audit
 * trail implying something happened.
 */
export function planInterjection(
  state: RunState,
  request: InterjectionRequest,
): InterjectionOutcome {
  if (request.text.trim() === '') {
    return {
      status: 'empty_text',
      message: toSingleLine(
        `an interjection into '${request.node}' carries the Operator's words into the node's ` +
          'next packet, so text is required; empty guidance is a recorded correction that ' +
          'corrected nothing, and nobody could tell that apart from text that was lost',
      ),
    };
  }

  // Checked before the node's status, because a suspended `human` node is
  // *also* not running and the "use respond" answer is the useful one (AC7).
  // Two mechanisms for "tell the run something" is confusing enough without
  // them silently overlapping, and more so if one of them answers with the
  // other's error.
  if (openHumanGate(state, request.node) !== null) {
    return {
      status: 'use_respond',
      message: toSingleLine(
        `node '${request.node}' is a suspended human node waiting for an answer, not a running ` +
          `node that can be steered: use ${RESPOND_ROUTE} to answer it. An interjection and a ` +
          'gate response are different acts, and only one of them advances this node',
      ),
    };
  }

  const node = state.nodes[request.node];
  const planned = (state.plan?.nodes ?? []).some((candidate) => candidate.id === request.node);
  if (node === undefined && !planned) {
    return {
      status: 'node_not_found',
      message: toSingleLine(
        `run '${state.runId ?? 'unknown'}' has no node '${request.node}': the executing plan does ` +
          'not name it and no event has ever mentioned it',
      ),
    };
  }

  const status = node?.status ?? 'scheduled';
  if (TERMINAL_NODE_STATUSES.includes(status)) {
    return {
      status: 'node_not_running',
      nodeStatus: status,
      message: toSingleLine(
        `node '${request.node}' is ${status} and cannot be steered: it finished between the read ` +
          'and this post. Nothing was appended — an interjection on a finished node would be an ' +
          'audit trail implying something happened',
      ),
    };
  }

  const delivery = deliveryFor(request);
  const interjected: EmittedEvent = {
    kind: 'human.interjected',
    payload: { node: request.node, text: request.text, mode: request.mode, delivery },
  };

  // The pause is what makes `pause-and-inject` work on every adapter: the node
  // stops at the next safe boundary, the packet is re-assembled with the
  // guidance in it, and the node resumes on the attempt it was already on. A
  // node that is not running has no boundary to stop at and needs no pause.
  const suspend: readonly EmittedEvent[] =
    request.mode === 'pause-and-inject' && status === 'running'
      ? [{ kind: 'node.suspended', payload: { node: request.node, until: { kind: 'human' } } }]
      : [];

  return {
    status: 'ok',
    delivery,
    events: [interjected, ...suspend],
    attempt: node?.attempt ?? 0,
  };
}

/**
 * AC2 — the capability row's answer, and the one exception to it.
 *
 * `pause-and-inject` asks nothing of the live session, so no capability gates
 * it: the guidance travels in the next packet, which every adapter reads
 * because reading a prompt is the whole of what an adapter does.
 */
function deliveryFor(request: InterjectionRequest): Exclude<InterjectionDelivery, 'delivered'> {
  if (request.mode === 'pause-and-inject') return 'queued';
  return request.steering === true ? 'queued' : 'unsupported';
}

/** Every interjection recorded against `node`, in `seq` order (AC8). */
export function interjectionsOf(state: RunState, node: NodeId): readonly InterjectionState[] {
  return state.interjections[node] ?? [];
}

/** One queued interjection, as the adapter is offered it between turns. */
export interface PendingInterjection {
  readonly seq: EventSeq;
  readonly text: string;
}

/**
 * AC2, AC8 — what a live session still owes, oldest first.
 *
 * Three exclusions, each for its own reason. `unsupported` is excluded because
 * nothing will ever hand it over; `delivered` because something already did;
 * and `pause-and-inject` because that mode is delivered by the *packet*, and
 * sending it mid-turn as well would put the same correction in front of the
 * agent twice — which teaches it that operator guidance is noise, the same
 * failure interval re-injection is careful to avoid
 * (docs/08-context-and-memory.md §4.2).
 *
 * What is left is exactly the set a steerable adapter should send at its next
 * turn boundary, in the order the Operator typed it — none coalesced, none
 * dropped.
 */
export function undeliveredInterjections(
  state: RunState,
  node: NodeId,
): readonly PendingInterjection[] {
  return interjectionsOf(state, node)
    .filter((one) => one.mode === 'next-turn' && one.delivery === 'queued')
    .map((one) => ({ seq: EventSeqSchema.parse(one.seq), text: one.text }));
}

/* -------------------------------------------------------------------------- *
 * the packet segment
 * -------------------------------------------------------------------------- */

/**
 * The id namespace that *is* the provenance record — see the header for why it
 * is not a `Segment` field.
 */
export const HUMAN_SEGMENT_PREFIX = 'human-';

/** Where a segment's bytes came from, as the manifest records it. */
export type SegmentProvenance = 'human' | 'deflow';

/**
 * AC5 — `human` for an Operator's own words, `deflow` for everything the system
 * assembled on their behalf.
 *
 * The distinction is what keeps the node inspector honest: *"the Operator told
 * it this"* and *"we retrieved this"* are different claims about the same
 * prompt, and a reader who cannot tell them apart cannot audit either.
 */
export function segmentProvenance(segment: Pick<Segment, 'id'>): SegmentProvenance {
  return String(segment.id).startsWith(HUMAN_SEGMENT_PREFIX) ? 'human' : 'deflow';
}

export interface InterjectionSegmentsInput {
  readonly interjections: readonly InterjectionState[];
  /** The `Tokenizer` port. Defaults to the labelled heuristic. */
  readonly estimate?: TokenEstimator;
}

/**
 * AC5, AC8 — the guidance as packet segments, in `seq` order.
 *
 * `task.brief` because operator guidance is an *instruction*, not evidence: it
 * belongs beside the brief in the fill order, not among the facts and tool
 * output a node was handed to reason over. `sourceEvent` is the interjection's
 * own `seq`, which is F10.3's click-through, and the text is passed through
 * untouched — `contextSegment` hashes exactly the bytes it was given.
 *
 * Every delivery state is rendered, including `unsupported`. That is the point:
 * an adapter that could not be steered mid-turn still reads its next packet, so
 * the guidance that could not interrupt it is not thereby lost.
 */
export async function interjectionSegments(
  input: InterjectionSegmentsInput,
): Promise<readonly Segment[]> {
  const ordered = [...input.interjections].toSorted((left, right) => left.seq - right.seq);
  const segments: Segment[] = [];

  for (const one of ordered) {
    segments.push(
      await contextSegment({
        id: `${HUMAN_SEGMENT_PREFIX}${one.seq}`,
        kind: 'task.brief',
        text: one.text,
        sourceEvent: EventSeqSchema.parse(one.seq),
        ...(input.estimate === undefined ? {} : { estimate: input.estimate }),
      }),
    );
  }

  return segments;
}
