/**
 * KAR-10.2 AC9 — the framing agent's context packet: the raw task, the
 * repository at `read`, and nothing else (F6.1).
 *
 * **Why the framing node cannot use `buildPacket`.** `buildPacket` pins the
 * five §4.1 rows, and three of them — the goal, the non-goals, the acceptance
 * criteria — are read off a `TaskSpec`. At framing time there is no `TaskSpec`;
 * producing one is what this node is *for*. Handing the builder a placeholder
 * spec so the shape lines up would pin invented text under the heading
 * *"verbatim from the approved spec"*, which is the exact sentence EPIC-09
 * exists to make trustworthy. So this builder pins the two rows that are real
 * before a spec exists — the run's safety constraints (F5.6) and the node's
 * permission level (F5.4) — and pins nothing else.
 *
 * **What makes F6.1 structural here rather than a review comment.** A framing
 * agent that inherits the previous attempt's transcript is the smallest
 * possible violation of "no implicit context inheritance" and the easiest to
 * introduce, because *"just resume the session"* looks like an optimisation.
 * `FRAMING_SEGMENT_KINDS` is therefore an allowlist and a supplied segment
 * outside it is **refused**, not dropped: a silently dropped segment is a
 * caller who still believes the context arrived.
 *
 * A rejected spec is not a transcript. A second framing attempt is given the
 * document the operator rejected and the reason they gave, because that is the
 * instruction — and it arrives as its own `task.brief` segment with the
 * `sourceEvent` of the rejection, so the inspector's click-through lands on the
 * event rather than on a paragraph nobody can trace.
 *
 * Verifies: EPIC-10-S12 · AC1, AC9
 */

import { resolveContextBudget } from './build-packet.ts';
import type { Constraint } from './constraint.ts';
import {
  type ContextPacket,
  ContextPacketSchema,
  SEGMENT_KINDS,
  type Segment,
  type SegmentKind,
} from './context-packet.ts';
import { FRAMING_PERMISSION } from './framing.ts';
import { contentHash } from './hash.ts';
import { EventSeqSchema } from './ids.ts';
import {
  buildFramingPinnedSegments,
  contextSegment,
  heuristicTokens,
  type TokenEstimator,
} from './pinned-set.ts';
import { renderPacket } from './render-packet.ts';
import type { TaskSpec } from './task-spec.ts';

/**
 * Every segment kind a framing packet may carry.
 *
 * `history.summary` is absent and that absence is the whole of AC9: it is the
 * kind a carried-over transcript would arrive as, and there is no framing
 * situation in which one is legitimate — the rejected *spec* is a document, not
 * a conversation.
 */
export const FRAMING_SEGMENT_KINDS = [
  'pinned.constraints',
  'task.brief',
] as const satisfies readonly SegmentKind[];

export type FramingSegmentKind = (typeof FRAMING_SEGMENT_KINDS)[number];

/** A caller handing framing a segment it may not carry. */
export class ForeignSegmentInFramingPacket extends Error {
  readonly segment: string;
  readonly kind: string;

  constructor(id: string, kind: string) {
    super(
      `segment "${id}" is a ${kind} and the framing packet may only carry ` +
        `${FRAMING_SEGMENT_KINDS.join(', ')}. The framing agent receives the raw task and the ` +
        'repository and nothing else (F6.1): a segment sourced from another node makes the edges ' +
        'in the plan graph mean nothing, and "just resume the session" is how it gets in.',
    );
    this.name = 'ForeignSegmentInFramingPacket';
    this.segment = id;
    this.kind = kind;
  }
}

/** The document the operator rejected, and why — a second attempt's instruction. */
export interface RejectedFraming {
  readonly spec: TaskSpec;
  readonly reason: string;
  /** The `seq` of the event that recorded the rejection. */
  readonly sourceEvent: number;
}

export interface FramingPacketInput {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly builtAtEvent: number;
  readonly target: {
    readonly provider: string;
    readonly model: string;
    readonly maxContext: number;
  };
  /** From `.DeFlow/config.yaml`. Absent means the 0.5 default. */
  readonly configuredFraction?: number;
  /** The submitted task, exactly as `task.submitted` recorded it. */
  readonly task: { readonly text: string; readonly sourceEvent: number };
  /** The run's safety constraints (F5.6). */
  readonly constraints?: readonly Constraint[];
  readonly rejected?: RejectedFraming;
  /**
   * Anything else the caller assembled. Every entry is checked against
   * `FRAMING_SEGMENT_KINDS`; there is deliberately no way past that check.
   */
  readonly segments?: readonly Segment[];
  readonly estimate?: TokenEstimator;
}

const bullets = (lines: readonly string[]): string => lines.map((line) => `- ${line}`).join('\n');

/** The rejected document as text a model can read, and no more than that: the
 * fields it was judged on, not a re-serialisation of every key. */
function rejectedText(rejected: RejectedFraming): string {
  const spec = rejected.spec;
  return [
    'A previous framing attempt produced the spec below and the operator rejected it.',
    `Rejection reason: ${rejected.reason}`,
    '',
    `Rejected goal:\n${spec.goal}`,
    `\nRejected non-goals:\n${
      spec.nonGoals.length === 0 ? '- (none declared)' : bullets([...spec.nonGoals])
    }`,
    `\nRejected acceptance criteria:\n${bullets(
      spec.acceptanceCriteria.map((criterion) => `${criterion.id}: ${criterion.statement}`),
    )}`,
  ].join('\n');
}

/** An unpinned framing segment. The pinned two come from `pinned-set.ts`,
 * which is the workspace's only producer of `pinned: true`. */
function segment(
  input: {
    readonly id: string;
    readonly kind: Extract<FramingSegmentKind, 'task.brief'>;
    readonly text: string;
    readonly sourceEvent: number;
  },
  estimate: TokenEstimator,
): Promise<Segment> {
  return contextSegment({
    id: input.id,
    kind: input.kind,
    text: input.text,
    sourceEvent: EventSeqSchema.parse(input.sourceEvent),
    estimate,
  });
}

const sumTokens = (of: readonly Segment[]): number =>
  of.reduce((total, entry) => total + entry.tokens.estimated, 0);

function totalsOf(segments: readonly Segment[]) {
  return {
    tokens: sumTokens(segments),
    byKind: Object.fromEntries(
      SEGMENT_KINDS.map((kind) => [
        kind,
        sumTokens(segments.filter((entry) => entry.kind === kind)),
      ]),
    ),
  };
}

/**
 * AC9 — the framing node's packet.
 *
 * The pinned block is `buildFramingPinnedSegments`': two of `PINNED_CONTENT_TYPES`'
 * five rows, built by the same producer every other packet's pinned block goes
 * through, so `assertPinIntegrity` and the F10.3 inspector read one vocabulary
 * across every node type.
 */
export async function buildFramingPacket(input: FramingPacketInput): Promise<ContextPacket> {
  const estimate = input.estimate ?? heuristicTokens;

  for (const supplied of input.segments ?? []) {
    if (!(FRAMING_SEGMENT_KINDS as readonly string[]).includes(supplied.kind)) {
      throw new ForeignSegmentInFramingPacket(supplied.id, supplied.kind);
    }
  }

  const pinned = await buildFramingPinnedSegments({
    constraints: input.constraints ?? [],
    permission: FRAMING_PERMISSION,
    sourceEvent: EventSeqSchema.parse(input.builtAtEvent),
    estimate,
  });

  const brief = await segment(
    {
      id: 'task-raw',
      kind: 'task.brief',
      sourceEvent: input.task.sourceEvent,
      text: `The submitted task, verbatim:\n${input.task.text}`,
    },
    estimate,
  );

  const rejected =
    input.rejected === undefined
      ? []
      : [
          await segment(
            {
              id: 'task-rejected-spec',
              kind: 'task.brief',
              sourceEvent: input.rejected.sourceEvent,
              text: rejectedText(input.rejected),
            },
            estimate,
          ),
        ];

  const segments = [...pinned, brief, ...rejected, ...(input.segments ?? [])];
  const prompt = renderPacket({ segments });
  const { budget } = resolveContextBudget({
    maxContext: input.target.maxContext,
    ...(input.configuredFraction === undefined
      ? {}
      : { configuredFraction: input.configuredFraction }),
  });

  return ContextPacketSchema.parse({
    schemaId: 'DeFlow.contextpacket.v1',
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    builtAtEvent: input.builtAtEvent,
    target: input.target,
    budget,
    totals: totalsOf(segments),
    renderedPromptHandle: `artifact://${(await contentHash(prompt)).slice('sha256-'.length)}`,
    pinnedDigests: segments.filter((entry) => entry.pinned).map((entry) => entry.contentHash),
    segments,
  });
}
