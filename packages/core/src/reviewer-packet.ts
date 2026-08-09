/**
 * KAR-12.2 AC10 — the reviewer's context packet
 * ([docs/10-verification-gates.md §3.3](../../../docs/10-verification-gates.md)).
 *
 * *"The reviewer's context packet contains the pinned spec, the diff, the
 * deterministic and structural gate output, and nothing else. Specifically
 * **not** the producer's transcript."*
 *
 * This is a thin composition over `buildPacket` and it deliberately adds
 * nothing to the budget ladder, the fill order or the demotion rules — one
 * packet builder, because two would eventually disagree about what a pinned
 * segment is. What it adds is a **refusal**.
 *
 * **Why a refusal rather than a default.** Leaving the transcript out of the
 * caller's `segments` array works right up until somebody, reasonably, decides
 * the reviewer needs more context and adds it — the same instinct that makes
 * `session/fork` look like the obvious way to brief a reviewer (§3.2). F6.1's
 * no-implicit-inheritance rule is measured here: a reviewer that has read the
 * producer's rationale is primed to accept it, and the resulting green is a
 * self-assessment wearing a second model's name. So a segment whose provenance
 * is the producer's transcript throws, and `history.summary` — the transcript
 * compacted — throws with it. Refusing the *compacted* form matters more than
 * refusing the raw one: a summary is smaller, reads as helpful background, and
 * carries exactly the conclusions the review exists to re-derive.
 *
 * **The two positive refusals are the same argument run forwards.** A reviewer
 * packet with no diff is judging a description of a change; one with no gate
 * output is guessing whether the code compiles. Both produce a verdict, and
 * both produce one that means nothing, so neither can be built.
 *
 * Verifies: EPIC-12-S16 · AC10
 */
import { buildPacket, type PacketBuild, type PacketBuildInput } from './build-packet.ts';
import type { Segment, SegmentRecord } from './context-packet.ts';
import type { EventSeq } from './ids.ts';
import { contextSegment } from './pinned-set.ts';

/** The segment id the producer's unified diff always takes. Fixed rather than
 * caller-chosen so the manifest assertion, the golden file and the renderer
 * name one thing. */
export const REVIEW_DIFF_SEGMENT_ID = 'review-diff';

/** The segment id one gate's output takes. */
export function reviewerGateSegmentId(gate: string): string {
  return `review-gate-${gate}`;
}

/**
 * The one segment kind that *is* a transcript.
 *
 * `history.summary` is what a compaction leaves behind, and its whole content
 * is the earlier turns' conclusions. Refusing it by kind rather than by
 * provenance catches the case where the summary was written under an event id
 * the caller did not list — which is the case that would actually happen.
 */
const TRANSCRIPT_KINDS: readonly string[] = ['history.summary'];

/** A piece of evidence the reviewer judges against. */
export interface ReviewerEvidence {
  readonly text: string;
  /** Which event put these bytes here — F10.3's click-through, and what makes
   * the provenance check below an assertion rather than a convention. */
  readonly sourceEvent: EventSeq;
}

/** One gate's output, named by the gate that produced it. */
export interface ReviewerGateEvidence extends ReviewerEvidence {
  readonly gate: string;
}

export interface ReviewerPacketInput extends Omit<PacketBuildInput, 'segments'> {
  /**
   * The node under review, and the ledger events that make up its transcript.
   *
   * The event list is what turns *"no segment whose provenance is the
   * producer's transcript"* into something checkable. An empty list is
   * accepted — a producer whose io was never journaled has no transcript to
   * inherit — and the kind check below still applies.
   */
  readonly producer: {
    readonly node: string;
    readonly transcriptEvents?: readonly EventSeq[];
  };
  /**
   * The unified diff of the producer's branch. Required by the type, and
   * required to be non-empty at runtime — an empty diff reaches the same place
   * a missing one would, which is a reviewer judging a description of a change.
   */
  readonly diff: ReviewerEvidence;
  /** The deterministic and structural tiers' output. At least one. */
  readonly gateOutput: readonly ReviewerGateEvidence[];
  /** Anything else the caller resolved — declared reads, facts. Checked. */
  readonly extra?: readonly Segment[];
}

/** A segment that would have handed the reviewer the producer's own thread. */
export class ReviewerContextInherited extends Error {
  readonly segment: string;
  readonly producer: string;

  constructor(segment: string, producer: string, why: string) {
    super(
      `the reviewer packet would have carried segment '${segment}', which ${why}. F6.1 forbids ` +
        `implicit context inheritance and F7.2 rests on it: a reviewer that has read ${producer}'s ` +
        'rationale is primed to accept it (docs/10-verification-gates.md §3.3)',
    );
    this.name = 'ReviewerContextInherited';
    this.segment = segment;
    this.producer = producer;
  }
}

/** A reviewer packet that could not have judged anything. */
export class ReviewerPacketIncomplete extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewerPacketIncomplete';
  }
}

/**
 * Whether a manifest is free of the producer's transcript.
 *
 * Exported because the assertion AC10 asks for is made against the
 * `context.built` payload — a `SegmentRecord[]` with no `text` — and a caller
 * reading a run back has the manifest and not the builder's inputs.
 */
export function reviewerManifestIsClean(
  segments: readonly SegmentRecord[],
  transcriptEvents: readonly EventSeq[],
): boolean {
  const producerEvents = new Set<number>(transcriptEvents.map(Number));
  return !segments.some(
    (segment) =>
      TRANSCRIPT_KINDS.includes(segment.kind) || producerEvents.has(Number(segment.sourceEvent)),
  );
}

function assertNotInherited(segment: Segment, producer: ReviewerPacketInput['producer']): void {
  if (TRANSCRIPT_KINDS.includes(segment.kind)) {
    throw new ReviewerContextInherited(
      segment.id,
      producer.node,
      `is a ${segment.kind} — the producer's transcript, compacted`,
    );
  }
  const events = new Set<number>((producer.transcriptEvents ?? []).map(Number));
  if (events.has(Number(segment.sourceEvent))) {
    throw new ReviewerContextInherited(
      segment.id,
      producer.node,
      `was written by event ${segment.sourceEvent}, which is part of ${producer.node}'s transcript`,
    );
  }
}

/**
 * §3.3's packet, or a refusal.
 *
 * The order is the fill order `buildPacket` applies: the pinned block first —
 * the spec goal and the acceptance criteria among them, and pinned means never
 * compactable — then the diff and the gate output as `tool.output`, then
 * whatever else the caller resolved.
 */
export async function buildReviewerPacket(input: ReviewerPacketInput): Promise<PacketBuild> {
  if (input.diff.text.trim() === '') {
    throw new ReviewerPacketIncomplete(
      `the reviewer packet for ${input.nodeId} carries no diff, so the reviewer would be judging ` +
        'a description of a change rather than the change (docs/10-verification-gates.md §3.3)',
    );
  }
  if (input.gateOutput.length === 0) {
    throw new ReviewerPacketIncomplete(
      `the reviewer packet for ${input.nodeId} carries no gate output, so the reviewer would be ` +
        'guessing whether the code it is judging even compiles',
    );
  }

  const segments: Segment[] = [
    await contextSegment({
      id: REVIEW_DIFF_SEGMENT_ID,
      kind: 'tool.output',
      text: input.diff.text,
      sourceEvent: input.diff.sourceEvent,
    }),
  ];

  for (const gate of input.gateOutput) {
    segments.push(
      await contextSegment({
        id: reviewerGateSegmentId(gate.gate),
        kind: 'tool.output',
        text: gate.text,
        sourceEvent: gate.sourceEvent,
      }),
    );
  }

  segments.push(...(input.extra ?? []));
  for (const segment of segments) assertNotInherited(segment, input.producer);

  const { producer: _producer, diff: _diff, gateOutput: _gates, extra: _extra, ...build } = input;
  return buildPacket({ ...build, segments });
}
