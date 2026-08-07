/**
 * KAR-09.3 — the five pinned content types, and the one producer of
 * `pinned: true`.
 *
 * docs/08-context-and-memory.md §4.1 lists the pinned set as a closed table of
 * five rows, and this module is that table plus the two rules that make the
 * flag worth having:
 *
 *   1. **Nothing else may set it.** `buildPinnedSegments` is the only function
 *      in the workspace that writes `pinned: true`; everything else goes
 *      through `contextSegment`, whose `kind` parameter cannot name a
 *      `pinned.*` kind and which has no `pinned` parameter to pass. The
 *      invalid combination is unrepresentable rather than rejected at runtime
 *      (EPIC-09-S15 second scenario), and
 *      `packages/core/test/pinned-flag-single-producer.test.ts` keeps it that
 *      way for the modules a type cannot reach.
 *   2. **Nothing may take it away.** `selectCompactionCandidates` cannot see a
 *      pinned segment and `demoteToBudget` never returns one changed. When the
 *      pinned set alone will not fit, the answer is `PinnedSetExceedsBudget` —
 *      *"if the pinned set alone exceeds the budget, that is a plan error, not
 *      a compaction problem — fail loudly"* (§5.2). The tempting alternative,
 *      a "just this once" truncation of the acceptance criteria, is precisely
 *      the failure this epic exists to prevent, and it would be invisible
 *      afterwards.
 *
 * The render is byte-stable by construction: the same spec and the same node
 * produce the same bytes and therefore the same `contentHash`, which is what
 * makes verbatim re-injection (AC4) a property of the builder rather than a
 * discipline applied at the re-injection site.
 *
 * Verifies: EPIC-09-S8, EPIC-09-S14, EPIC-09-S15 · AC1, AC2
 */
import { type Constraint, orderPinnedConstraints, restateAsRequirement } from './constraint.ts';
import type { ContextPacket, Segment, SegmentKind, TokenCount } from './context-packet.ts';
import { contentHash } from './hash.ts';
import { type EventSeq, type SegmentId, SegmentIdSchema } from './ids.ts';
import type { PinnedNodeContext, TaskSpec } from './task-spec.ts';

/** The three kinds a pinned segment may have. Derived from `SegmentKind` so
 * that a tenth kind added to the vocabulary cannot quietly become pinnable. */
export type PinnedSegmentKind = Extract<SegmentKind, `pinned.${string}`>;

/** Everything else — the only kinds `contextSegment` will build. */
export type UnpinnedSegmentKind = Exclude<SegmentKind, PinnedSegmentKind>;

export interface PinnedContentType {
  /** Stable identifier, and the `SegmentId` the built segment carries. */
  readonly id: string;
  readonly kind: PinnedSegmentKind;
  /** Where the bytes come from, quoting §4.1's third column. */
  readonly source: string;
}

/**
 * §4.1's table, in its order — which is also the render order of the pinned
 * block. Exactly five rows, and the count is asserted rather than assumed.
 */
export const PINNED_CONTENT_TYPES = [
  { id: 'pinned-spec-goal', kind: 'pinned.spec', source: 'F1.2, approved at F1.3' },
  { id: 'pinned-spec-criteria', kind: 'pinned.spec', source: 'F1.2 / F7.4' },
  {
    id: 'pinned-constraints-safety',
    kind: 'pinned.constraints',
    source: 'run config + F5.6 execution-boundary rules',
  },
  { id: 'pinned-pathscope', kind: 'pinned.pathscope', source: 'F5.3' },
  { id: 'pinned-constraints-permission', kind: 'pinned.constraints', source: 'F5.4' },
] as const satisfies readonly PinnedContentType[];

/**
 * How a segment's token cost is measured.
 *
 * A port rather than a call: KAR-09.7 owns the three tiers, and until it lands
 * the honest default is a labelled heuristic. `TokenCount.method` is required
 * and has no default precisely so that an estimate whose provenance is unknown
 * cannot exist.
 */
export type TokenEstimator = (text: string) => TokenCount;

/** Four characters per token, labelled `heuristic` so nobody mistakes it for a
 * tokenizer. KAR-09.7 replaces it behind this port. */
export const heuristicTokens: TokenEstimator = (text) => ({
  estimated: Math.ceil(text.length / 4),
  method: 'heuristic',
});

export interface PinnedBuildInput {
  readonly spec: TaskSpec;
  /** The active node's declared path scopes and permission level. */
  readonly node: PinnedNodeContext;
  /**
   * Safety constraints from run config and the F5.6 execution-boundary rules,
   * as structured objects. The spec's own prose constraints are folded in as
   * `require` statements, which is the honest reading of a hand-written line:
   * it is a commission-type constraint until somebody restates it.
   */
  readonly constraints?: readonly Constraint[];
  /** Which event put these bytes here (F10.3's click-through). */
  readonly sourceEvent: EventSeq;
  readonly estimate?: TokenEstimator;
}

const bullets = (lines: readonly string[]): string => lines.map((line) => `- ${line}`).join('\n');

/**
 * Every constraint that reaches the pinned block, in render order.
 *
 * The spec's own prose constraints are folded in as `require` statements, which
 * is the honest reading of a hand-written line: it is a commission-type
 * constraint until somebody restates it, and §4.2 measured that commission
 * compliance is the half that does not decay.
 *
 * Exported because `buildPacket` counts these (KAR-09.4 AC4) and must count the
 * same list this renders. Two implementations of "which constraints are pinned"
 * is how the doctor's forbid ratio and the prompt come to disagree.
 */
export function pinnedConstraintsOf(
  spec: TaskSpec,
  constraints: readonly Constraint[] = [],
): readonly Constraint[] {
  return orderPinnedConstraints([
    ...spec.constraints.map((statement): Constraint => ({ form: 'require', statement })),
    ...constraints,
  ]);
}

/**
 * The five pinned segments, in §4.1's order, as a pure function of the spec
 * and the node.
 *
 * Deliberately not a template anyone can extend: every line is composed here,
 * so "what exactly is pinned" is answerable by reading one function rather
 * than by tracing a formatter.
 */
export async function buildPinnedSegments(input: PinnedBuildInput): Promise<readonly Segment[]> {
  const { spec, node } = input;
  const estimate = input.estimate ?? heuristicTokens;

  const constraints = pinnedConstraintsOf(spec, input.constraints ?? []);

  const texts: readonly string[] = [
    `Goal (pinned, verbatim from the approved spec):\n${spec.goal}\n\nNon-goals:\n${
      spec.nonGoals.length === 0 ? '- (none declared)' : bullets(spec.nonGoals)
    }`,
    `Acceptance criteria (pinned, verbatim from the approved spec):\n${bullets(
      spec.acceptanceCriteria.map((criterion) => `${criterion.id}: ${criterion.statement}`),
    )}`,
    `Safety constraints (pinned):\n${
      constraints.length === 0
        ? '- (none declared)'
        : bullets(constraints.map(restateAsRequirement))
    }`,
    `Declared path scopes (pinned):\n${
      node.pathScopes.length === 0
        ? '- this node declares no write scope and must not write'
        : bullets(node.pathScopes.map((glob) => `write: ${glob}`))
    }`,
    `Permission level (pinned): ${node.permission}`,
  ];

  const segments: Segment[] = [];
  for (const [index, type] of PINNED_CONTENT_TYPES.entries()) {
    const text = texts[index] as string;
    segments.push({
      id: SegmentIdSchema.parse(type.id),
      kind: type.kind,
      sourceEvent: input.sourceEvent,
      contentHash: await contentHash(text),
      tokens: estimate(text),
      pinned: true,
      compactable: false,
      text,
    });
  }
  return segments;
}

export interface ContextSegmentInput {
  readonly id: string;
  /** A `pinned.*` kind is not in this vocabulary — see rule 1 in the header. */
  readonly kind: UnpinnedSegmentKind;
  readonly text: string;
  readonly sourceEvent: EventSeq;
  /** Defaults to `true`. A non-pinned segment may still be non-compactable —
   * the implication in §6 is one-way. */
  readonly compactable?: boolean;
  readonly estimate?: TokenEstimator;
}

/** Every segment that is not one of the five. Never pinned, by construction. */
export async function contextSegment(input: ContextSegmentInput): Promise<Segment> {
  const estimate = input.estimate ?? heuristicTokens;
  return {
    id: SegmentIdSchema.parse(input.id),
    kind: input.kind,
    sourceEvent: input.sourceEvent,
    contentHash: await contentHash(input.text),
    tokens: estimate(input.text),
    pinned: false,
    compactable: input.compactable ?? true,
    text: input.text,
  };
}

/** Anything with segments — a `ContextPacket`, or a bare list under test. */
export interface SegmentedPacket {
  readonly segments: readonly Segment[];
}

/**
 * What a compaction pass is allowed to look at (EPIC-09-S15 third scenario).
 *
 * A pinned segment is not merely skipped by the demotion loop: it is never
 * offered to it. The selector is the single place that decides, so a future
 * compaction strategy cannot reach the pinned set by accident.
 */
export function selectCompactionCandidates(packet: SegmentedPacket): readonly Segment[] {
  return packet.segments.filter((segment) => !segment.pinned && segment.compactable);
}

/**
 * The demotion ladder from §5.2, in its documented order: the largest
 * `tool.output` first, then `retrieved`, then `fact` bodies, then inlined
 * `artifact.handle` bodies.
 *
 * KAR-09.2 owns what a demoted segment *becomes* (a handle into the
 * content-addressed store). This story owns the half that must be true before
 * that matters: whatever the ladder does, it never reaches a pin.
 */
const DEMOTION_LADDER: readonly UnpinnedSegmentKind[] = [
  'tool.output',
  'retrieved',
  'fact',
  'artifact.handle',
];

/**
 * Every demotable segment, in the order the ladder offers them: rung-major,
 * and size-descending within a rung — which is what *"largest `tool.output`
 * first"* means when there are two of them.
 *
 * The one implementation of the order. `demoteToBudget` here and
 * `buildPacket`'s demotion pass (KAR-09.2) both call it rather than each
 * sorting for itself, because two implementations of "which body goes first"
 * is how the audit trail and the packet come to disagree about what happened.
 *
 * A kind the ladder does not name is **not offered at all**, rather than
 * offered last. §5.2 names four rungs and they are all bodies the agent can
 * pull back through `DeFlow_read_artifact`; the kinds it leaves out are the
 * node's own scoped instruction (`task.brief`) and a summary that is already
 * the compacted form of something else (`history.summary`). Replacing either
 * with a handle removes the thing the node needs in order to start, which is
 * a worse failure than being over budget and saying so.
 */
export function demotionLadder(packet: SegmentedPacket): Segment[] {
  const rungOf = (segment: Segment): number =>
    (DEMOTION_LADDER as readonly string[]).indexOf(segment.kind);
  return selectCompactionCandidates(packet)
    .filter((segment) => rungOf(segment) >= 0)
    .toSorted((a, b) => rungOf(a) - rungOf(b) || b.tokens.estimated - a.tokens.estimated);
}

export interface DemotionResult {
  /** Every surviving segment, in the packet's original order. Pinned segments
   * are the identical objects that went in. */
  readonly kept: readonly Segment[];
  /** What was demoted, in the order the ladder took it. */
  readonly demoted: readonly SegmentId[];
  /** False when the pass ran out of candidates before it reached the budget —
   * the caller's cue to raise `PinnedSetExceedsBudget` rather than to demote a
   * pin. */
  readonly reachedBudget: boolean;
  readonly pinnedTokens: number;
  /** The total after demotion. */
  readonly tokens: number;
}

const sumTokens = (segments: readonly Segment[]): number =>
  segments.reduce((sum, segment) => sum + segment.tokens.estimated, 0);

export function demoteToBudget(packet: ContextPacket): DemotionResult {
  const limit = packet.budget.limitTokens;
  const pinnedTokens = sumTokens(packet.segments.filter((segment) => segment.pinned));

  const demoted = new Set<SegmentId>();
  let tokens = sumTokens(packet.segments);
  for (const candidate of demotionLadder(packet)) {
    if (tokens <= limit) break;
    demoted.add(candidate.id);
    tokens -= candidate.tokens.estimated;
  }

  return {
    kept: packet.segments.filter((segment) => !demoted.has(segment.id)),
    demoted: [...demoted],
    reachedBudget: tokens <= limit,
    pinnedTokens,
    tokens,
  };
}

/**
 * §5.2's fail-loudly case, as a value with fields rather than a message.
 *
 * Deliberately **not** a `NodeFailureError`: this is a plan problem, not a way
 * work went wrong, and the closed `NodeFailureReason` taxonomy has no member
 * for it because plan problems surface as validation errors (see
 * `validateDeclaredReads`). KAR-09.2 decides where it surfaces; what this
 * story fixes is that it is raised at all, and that its message never suggests
 * the remedy the epic exists to forbid.
 */
export class PinnedSetExceedsBudget extends Error {
  readonly node: string;
  readonly pinnedTokens: number;
  readonly limitTokens: number;
  readonly provider: string;
  readonly maxContext: number;

  constructor(detail: {
    node: string;
    pinnedTokens: number;
    limitTokens: number;
    provider: string;
    model: string;
    maxContext: number;
  }) {
    super(
      `node "${detail.node}": the pinned set is ${detail.pinnedTokens} tokens and the budget is ` +
        `${detail.limitTokens} — the spec, its acceptance criteria or the declared path scopes are ` +
        `too large for ${detail.provider} ${detail.model}, whose maxContext is ${detail.maxContext}. ` +
        'Narrow the spec or the path scopes, or target an adapter with a larger window.',
    );
    this.name = 'PinnedSetExceedsBudget';
    this.node = detail.node;
    this.pinnedTokens = detail.pinnedTokens;
    this.limitTokens = detail.limitTokens;
    this.provider = detail.provider;
    this.maxContext = detail.maxContext;
  }
}

/** Raised before a packet is emitted and before a process is spawned: an
 * unbudgetable pinned set costs nothing to detect and everything to discover
 * an hour into a run. */
export function assertPinnedSetFitsBudget(packet: ContextPacket): void {
  const pinnedTokens = sumTokens(packet.segments.filter((segment) => segment.pinned));
  if (pinnedTokens <= packet.budget.limitTokens) return;
  throw new PinnedSetExceedsBudget({
    node: packet.nodeId,
    pinnedTokens,
    limitTokens: packet.budget.limitTokens,
    provider: packet.target.provider,
    model: packet.target.model,
    maxContext: packet.target.maxContext,
  });
}
