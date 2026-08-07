/**
 * KAR-10.5 AC7 — the planner's packet: the pinned spec and the recon **facts**,
 * and no session's transcript (F6.1, docs/06-planning-and-planning §8).
 *
 * > Do not let the planner see another node's transcript. It gets the spec, the
 * > recon output and the capability list.
 *
 * The recon transcript is the temptation this builder exists to remove. It is
 * right there when the planner is assembled, it reads fluently, and it looks
 * like free context — and a planner that reads it plans against a conversation
 * rather than against verified facts, which makes the edges in the plan graph
 * mean nothing. So `PLANNER_SEGMENT_KINDS` is an allowlist with no
 * `history.summary` in it, and a supplied segment outside the list is **refused
 * rather than dropped**: a dropped segment leaves a caller who still believes
 * the context arrived.
 *
 * A fact renders as its key, its `confidence`, its value and its evidence
 * handles. `confidence` is on the line rather than in a footnote because *"the
 * repo probably uses Pinia"* and *"`package.json` lists `pinia@3.0.4`"* must not
 * be indistinguishable to the model that plans from them.
 *
 * **What this builder does not yet carry.** F2.2 names three planner inputs and
 * this is two of them: the provider capability list belongs to KAR-11.1, which
 * is where plan compilation lives. It is omitted rather than stubbed, for the
 * same reason `buildFramingPacket` omits the three spec-derived pinned rows —
 * an invented segment under a heading that claims provenance is worse than a
 * missing one.
 *
 * Verifies: EPIC-10-S24 (second scenario), EPIC-10-S28 (third scenario) · AC7
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
import type { Confidence } from './fact.ts';
import { contentHash } from './hash.ts';
import { EventSeqSchema } from './ids.ts';
import {
  buildSpecPinnedSegments,
  contextSegment,
  heuristicTokens,
  type TokenEstimator,
} from './pinned-set.ts';
import { renderPacket } from './render-packet.ts';
import type { TaskSpec } from './task-spec.ts';

/**
 * Every segment kind a planner packet may carry.
 *
 * `history.summary` is absent, and that absence is the whole of AC7.
 * `tool.output` and `retrieved` are absent for the same reason: both are a
 * node's own working material, and the planner is not resuming a node.
 */
export const PLANNER_SEGMENT_KINDS = [
  'pinned.constraints',
  'pinned.spec',
  'task.brief',
  'fact',
  'artifact.handle',
] as const satisfies readonly SegmentKind[];

export type PlannerSegmentKind = (typeof PLANNER_SEGMENT_KINDS)[number];

/** A caller handing the planner a segment it may not carry. */
export class ForeignSegmentInPlannerPacket extends Error {
  readonly segment: string;
  readonly kind: string;

  constructor(id: string, kind: string) {
    super(
      `segment "${id}" is a ${kind} and the planner packet may only carry ` +
        `${PLANNER_SEGMENT_KINDS.join(', ')}. The planner reads the spec and the recon facts ` +
        '(F6.1): a recon transcript is right there and it looks like free context, which is ' +
        'exactly why it is refused here rather than filtered out somewhere downstream.',
    );
    this.name = 'ForeignSegmentInPlannerPacket';
    this.segment = id;
    this.kind = kind;
  }
}

/** One blackboard fact, at the shape the packet renders it from. */
export interface PlannerFact {
  readonly key: string;
  readonly confidence: Confidence;
  readonly value: unknown;
  readonly fromEvidence: readonly string[];
  /** The `fact.written` event that put it on the blackboard — never the
   * `fact.read` this packet's assembly appended (F6.2). */
  readonly sourceEvent: number;
}

export interface PlannerPacketInput {
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
  /** The approved spec, pinned verbatim. */
  readonly spec: TaskSpec;
  /** The run's safety constraints (F5.6). */
  readonly constraints?: readonly Constraint[];
  /** The recon output, as facts. */
  readonly facts: readonly PlannerFact[];
  readonly segments?: readonly Segment[];
  readonly estimate?: TokenEstimator;
}

/** A fact as the planner reads it: what it says, how much it is worth, and
 * where to click through to. */
export function renderFactSegmentText(fact: PlannerFact): string {
  const evidence =
    fact.fromEvidence.length === 0
      ? "evidence: none — this is the surveying agent's own claim"
      : `evidence: ${fact.fromEvidence.join(', ')}`;
  return [
    `${fact.key} (confidence: ${fact.confidence})`,
    JSON.stringify(fact.value, null, 2),
    evidence,
  ].join('\n');
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

/** A fact key as a segment id: `finding/test-command` → `fact-finding-test-command`. */
function segmentIdFor(key: string): string {
  return `fact-${key.replaceAll(/[^a-z0-9]+/gi, '-')}`;
}

/** AC7 — the planner's packet. */
export async function buildPlannerPacket(input: PlannerPacketInput): Promise<ContextPacket> {
  const estimate = input.estimate ?? heuristicTokens;

  for (const supplied of input.segments ?? []) {
    if (!(PLANNER_SEGMENT_KINDS as readonly string[]).includes(supplied.kind)) {
      throw new ForeignSegmentInPlannerPacket(supplied.id, supplied.kind);
    }
  }

  const pinned = await buildSpecPinnedSegments({
    spec: input.spec,
    ...(input.constraints === undefined ? {} : { constraints: input.constraints }),
    sourceEvent: EventSeqSchema.parse(input.builtAtEvent),
    estimate,
  });

  const facts: Segment[] = [];
  for (const fact of input.facts) {
    facts.push(
      await contextSegment({
        id: segmentIdFor(fact.key),
        kind: 'fact',
        text: renderFactSegmentText(fact),
        sourceEvent: EventSeqSchema.parse(fact.sourceEvent),
        estimate,
      }),
    );
  }

  const segments = [...pinned, ...facts, ...(input.segments ?? [])];
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
