/**
 * KAR-09.2 — `buildPacket()`: selection, ordering and a token budget
 * (docs/08-context-and-memory.md §3 and §5.2).
 *
 * The builder does **selection and ordering**. It does not tokenise (that is
 * the `Tokenizer` port, arriving here as the `TokenEstimator` parameter), it
 * does not fetch (that is the blackboard and the CAS), and it does not
 * summarise — nothing does, except the explicit continuation path, which is a
 * separate declared step. If a change makes this module need a network call,
 * the change is wrong, and
 * `packages/core/test/demotion-is-provider-free.test.ts` is what says so after
 * everyone who read this paragraph has moved on.
 *
 * **Two orders, and they are different on purpose.**
 *
 *   - *Fill order* is the `segments` array: the pinned block first — in §4.1's
 *     five-row order, which KAR-09.3 owns — then the task brief, any carried
 *     history, declared reads, tool output, retrieved facts and artifact
 *     handles. That is what §5.2 lists, and it is what the F10.3 inspector and
 *     the F10.5 budget bar read.
 *   - *Render order* is `renderOrderOf` (KAR-02.6): pinned first, then
 *     everything else in `sourceEvent` order. That is what puts a
 *     `history.summary` in the chronological position of the turns it replaced
 *     rather than in a preamble (AC8), and it is the one refinement worth
 *     taking from the OpenAI Agents SDK's `nest_handoff_history`.
 *
 * Collapsing the two into one array order would cost one of them. The manifest
 * is the audit record and wants the fill order; the prompt is a conversation
 * and wants the chronology.
 *
 * **Offload, don't summarise.** When the assembled packet is over budget, a
 * body is replaced by a handle into the content-addressed store — never
 * compressed, never truncated, never summarised. The handle is derived from
 * the segment's own `contentHash`, so demotion needs no I/O and no port: the
 * bytes are already addressed by their own digest, and persisting them is the
 * caller's step (`persistContextPacket` in `@DeFlow/ledger`). Handles are
 * lossless and cheap; summaries are lossy and unauditable.
 *
 * **An unbudgetable pinned set is a plan error.** If the five pinned segments
 * alone will not fit, this throws `PinnedSetExceedsBudget` before it builds
 * anything — no packet, no `context.built`, no spawned process. The tempting
 * alternative, a "just this once" truncation of the acceptance criteria, is
 * precisely the failure this epic exists to prevent and would be invisible
 * afterwards.
 *
 * Verifies: EPIC-09-S6, EPIC-09-S7, EPIC-09-S8, EPIC-09-S9, EPIC-09-S10,
 * EPIC-09-S11, EPIC-09-S12, EPIC-09-S28 · AC1-AC9
 */
import {
  defaultDescription,
  exceedsInlineThreshold,
  handleForSegment,
  handleStubText,
  INLINE_THRESHOLD_BYTES_DEFAULT,
} from './artifact-offload.ts';
import { type Constraint, type ConstraintCounts, countConstraintForms } from './constraint.ts';
import {
  type ContextBudget,
  type ContextPacket,
  ContextPacketSchema,
  SEGMENT_KINDS,
  type Segment,
} from './context-packet.ts';
import { contentHash } from './hash.ts';
import { EventSeqSchema, type Handle, type SegmentId } from './ids.ts';
import {
  buildPinnedSegments,
  demotionLadder,
  heuristicTokens,
  PinnedSetExceedsBudget,
  pinnedConstraintsOf,
  type TokenEstimator,
  type UnpinnedSegmentKind,
} from './pinned-set.ts';
import { reinjectionPlanningWarning } from './reinjection.ts';
import { renderPacket } from './render-packet.ts';
import type { PinnedNodeContext, TaskSpec } from './task-spec.ts';

/* -------------------------------------------------------------------------- *
 * The budget
 * -------------------------------------------------------------------------- */

/** §5.2: *"Default 0.5, never above 0.6."* */
export const BUDGET_FRACTION_DEFAULT = 0.5;

/**
 * The ceiling, and it is not arbitrary. §5.1 measured the vendor's internal
 * summariser bounds at `{ minTokens: 10_000, maxTokens: 40_000 }`, so a
 * compaction summary can consume up to 40k on its own: if the packet occupies
 * 50% of the window and the vendor then compacts, the post-compaction floor is
 * the packet plus up to 40k. Above 0.6 there is no room left for that floor.
 */
export const BUDGET_FRACTION_CEILING = 0.6;

export interface BudgetResolution {
  readonly budget: ContextBudget;
  /** Names the configured value, or `null` when nothing was clamped. A
   * silently corrected number is a configuration the operator still believes
   * is in force. */
  readonly warning: string | null;
}

export interface BudgetInput {
  /** The target adapter's declared `maxContext`, from its F3.5 capability
   * manifest. There is no window-size table anywhere in this repository: a
   * table of per-model windows is wrong within a month of the next release,
   * silently, and in the direction that overfills. */
  readonly maxContext: number;
  readonly configuredFraction?: number;
}

/** AC3: the default, the ceiling and the one warning, in one place. */
export function resolveContextBudget(input: BudgetInput): BudgetResolution {
  const configured = input.configuredFraction;
  if (configured === undefined) {
    return { budget: budgetOf(BUDGET_FRACTION_DEFAULT, input.maxContext), warning: null };
  }
  if (configured <= BUDGET_FRACTION_CEILING) {
    return { budget: budgetOf(configured, input.maxContext), warning: null };
  }
  return {
    budget: budgetOf(BUDGET_FRACTION_CEILING, input.maxContext),
    warning:
      `the configured context budget fraction ${configured} is above the ${BUDGET_FRACTION_CEILING} ` +
      `ceiling and was clamped to ${BUDGET_FRACTION_CEILING}. The vendor's own compaction summary ` +
      'can consume up to 40,000 tokens on its own (docs/08-context-and-memory.md §5.1), so a ' +
      'packet larger than this leaves no room for the post-compaction floor.',
  };
}

const budgetOf = (fraction: number, maxContext: number): ContextBudget => ({
  fraction,
  limitTokens: Math.floor(maxContext * fraction),
});

/* -------------------------------------------------------------------------- *
 * Fill order
 * -------------------------------------------------------------------------- */

/**
 * §5.2's fill order for everything that is not pinned. Position 1 — the pinned
 * block — is not in this list because it is not a kind: it is the closed
 * five-row table of §4.1, built by `buildPinnedSegments` and always first.
 *
 * `history.summary` sits directly after the brief: a continuation node's
 * carried history is context for the instruction, not a declared read. Its
 * *rendered* position is chronological and is decided by `renderOrderOf`, not
 * here (AC8).
 *
 * `tool.output` follows `fact` because both are declared reads resolved from
 * somewhere else — a blackboard entry and a prior node's captured output — and
 * a fact is the smaller, more load-bearing of the two.
 */
export const FILL_ORDER = [
  'task.brief',
  'history.summary',
  'fact',
  'tool.output',
  'retrieved',
  'artifact.handle',
] as const satisfies readonly UnpinnedSegmentKind[];

/** A kind the fill order does not name sorts last: an unranked segment is one
 * nobody has decided about, and guessing costs context. */
const fillRank = (segment: Segment): number => {
  const index = (FILL_ORDER as readonly string[]).indexOf(segment.kind);
  return index < 0 ? FILL_ORDER.length : index;
};

/* -------------------------------------------------------------------------- *
 * Demotion
 * -------------------------------------------------------------------------- */

/**
 * Why a body left the packet.
 *
 * - `inline-threshold` — KAR-09.5 AC1: it was over the configured inline size,
 *   and would have been offloaded inside a budget ten times its own.
 * - `budget` — KAR-09.2 AC5: the packet did not fit, and the ladder reached it.
 *
 * Recorded per body rather than per build because a packet routinely has both,
 * and *"was this offloaded because it is big, or because the packet is full?"*
 * is the first question anyone asks of an F10.5 bar that looks wrong.
 */
export const DEMOTION_REASONS = ['inline-threshold', 'budget'] as const;

export type DemotionReason = (typeof DEMOTION_REASONS)[number];

/**
 * A body that left the packet, and the bytes it left behind.
 *
 * Carried out of the build rather than dropped, because "handles are lossless"
 * is only true while somebody stores the body: the handle addresses these
 * exact bytes, and `persistContextPacket` puts them in the content-addressed
 * store so `DeFlow_read_artifact` can hand them back.
 */
export interface DemotedBody {
  readonly segment: SegmentId;
  readonly handle: Handle;
  readonly text: string;
  /** What the handle line said this body is — carried through so the run's
   * artifact index can describe it without re-parsing the stub. */
  readonly description: string;
  readonly reason: DemotionReason;
}

export interface PacketDemotion {
  /** The order the ladder offered segments, recorded whether or not the pass
   * got that far — "demotion stops as soon as the packet fits" is only
   * checkable against the order it would have continued in. */
  readonly ladder: readonly SegmentId[];
  /** What was demoted, in the order the ladder took it. */
  readonly droppedSegments: readonly SegmentId[];
  /** One handle per demoted body, in the same order. */
  readonly demotedToHandles: readonly Handle[];
  /** The demoted bodies themselves, for the caller to persist. */
  readonly bodies: readonly DemotedBody[];
  readonly before: number;
  readonly after: number;
  /** False when the pass ran out of candidates before it reached the budget.
   * The packet is still built and still honest about its total: an over-budget
   * packet nobody can shrink further is a fact the caller has to see, not a
   * reason to reach for a pin. */
  readonly fits: boolean;
}

/* -------------------------------------------------------------------------- *
 * The build
 * -------------------------------------------------------------------------- */

export interface PacketPinnedInput {
  readonly spec: TaskSpec;
  readonly node: PinnedNodeContext;
  readonly constraints?: readonly Constraint[];
  /** Which event put the pinned bytes here (F10.3's click-through). */
  readonly sourceEvent: number;
}

export interface PacketTarget {
  readonly provider: string;
  readonly model: string;
  readonly maxContext: number;
}

export interface PacketBuildInput {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly builtAtEvent: number;
  readonly target: PacketTarget;
  /** From `.DeFlow/config.yaml`. Absent means the 0.5 default (AC3). */
  readonly configuredFraction?: number;
  readonly pinned: PacketPinnedInput;
  /**
   * Everything that is not pinned, already resolved by the caller — the
   * blackboard resolved the declared reads, the CAS resolved the artifacts.
   * Order is irrelevant: the fill order is applied here.
   */
  readonly segments?: readonly Segment[];
  /**
   * KAR-09.5 AC1 — the configured inline threshold in bytes
   * (`context.inlineThresholdBytes`). Absent means the 8 KB default.
   */
  readonly inlineThresholdBytes?: number;
  /**
   * KAR-09.5 AC3 — what a demoted body *is*, by segment id, for the handle
   * line: `build-log for \`pnpm -r build\` (fail)`.
   *
   * A build input rather than a `Segment` field, and deliberately: the packet
   * schema is `DeFlow.contextpacket.v1` and shipped, and a description is not
   * a property of the bytes — it is a property of the sentence DeFlow writes
   * about them, which is exactly what the stub's `text` already is. A segment
   * with no entry here is described by its kind and id.
   */
  readonly descriptions?: Readonly<Record<string, string>>;
  /** The `Tokenizer` port. Defaults to the labelled heuristic. */
  readonly estimate?: TokenEstimator;
  /**
   * KAR-09.4 AC6 — what the interval re-injection mechanism knows at build
   * time: the configured interval, whether the target adapter can be steered
   * mid-session, and what the plan expects this node to cost in turns.
   *
   * Absent means the caller has not wired it, and the builder says nothing —
   * a warning derived from three values none of which were supplied would be
   * an invention. Present and unsteerable produces exactly one warning.
   */
  readonly reinjection?: PacketReinjectionInput;
}

export interface PacketReinjectionInput {
  readonly pinReinjectTurns: number;
  /** From the probed capability manifest. `undefined` — never advertised — is
   * treated exactly like a refusal (EPIC-09-S24's outline). */
  readonly steering: boolean | undefined;
  readonly expectedTurns?: number;
}

export interface PacketBuild {
  readonly packet: ContextPacket;
  /**
   * The budget clamp and the AC6 planning warning, when either happened.
   * Carried out rather than logged: this module has no logger and should not
   * acquire one.
   */
  readonly warnings: readonly string[];
  readonly demotion: PacketDemotion;
  /**
   * KAR-09.4 AC4 — how many constraints of each form this build pinned.
   *
   * Recorded per build rather than derived later because the ratio is a leading
   * indicator: `DeFlow doctor` reports forbid-over-allow-only, and a rising one
   * is the early warning for exactly the decay §4.2 describes.
   */
  readonly constraints: ConstraintCounts;
}

/**
 * A segment whose `contentHash` is not the sha256 of its own `text`.
 *
 * Refused rather than recomputed. `contentHash` is what the pin integrity
 * check, the CAS and the demotion handle all address content by; a builder
 * that quietly corrected it would turn a caller's bug into three components
 * disagreeing about which bytes a run actually used.
 */
export class SegmentContentHashMismatch extends Error {
  readonly segment: string;

  constructor(id: string, declared: string, actual: string) {
    super(
      `segment "${id}" declares contentHash ${declared} but its text hashes to ${actual}. ` +
        'contentHash is how the pin integrity check, the content-addressed store and every ' +
        'demoted handle address these bytes — build segments with contextSegment() rather than ' +
        'as object literals, so the digest cannot drift from the text.',
    );
    this.name = 'SegmentContentHashMismatch';
    this.segment = id;
  }
}

/** A caller trying to add a sixth pinned segment after the fact. */
export class PinnedSegmentSuppliedLate extends Error {
  readonly segment: string;

  constructor(id: string) {
    super(
      `segment "${id}" arrived in buildPacket's segment list already flagged as pinned. The set is ` +
        'fill-order position 1 and cannot be added afterwards: it is exactly the five content ' +
        'types of docs/08-context-and-memory.md §4.1, built from the spec and the node by ' +
        'buildPinnedSegments(). A sixth one is never compacted, always rendered first and ' +
        'hash-checked before every dispatch, and nothing about it looks wrong until a packet ' +
        'stops fitting.',
    );
    this.name = 'PinnedSegmentSuppliedLate';
    this.segment = id;
  }
}

const sumTokens = (segments: readonly Segment[]): number =>
  segments.reduce((total, segment) => total + segment.tokens.estimated, 0);

/** AC1: `totals.byKind` is a full record — every kind, 0 where there are none. */
function totalsOf(segments: readonly Segment[]) {
  return {
    tokens: sumTokens(segments),
    byKind: Object.fromEntries(
      SEGMENT_KINDS.map((kind) => [
        kind,
        sumTokens(segments.filter((segment) => segment.kind === kind)),
      ]),
    ),
  };
}

export async function buildPacket(input: PacketBuildInput): Promise<PacketBuild> {
  const estimate = input.estimate ?? heuristicTokens;
  const { budget, warning } = resolveContextBudget({
    maxContext: input.target.maxContext,
    ...(input.configuredFraction === undefined
      ? {}
      : { configuredFraction: input.configuredFraction }),
  });

  // Position 1, and the only producer of `pinned: true`.
  const pinned = await buildPinnedSegments({
    spec: input.pinned.spec,
    node: input.pinned.node,
    ...(input.pinned.constraints === undefined ? {} : { constraints: input.pinned.constraints }),
    sourceEvent: EventSeqSchema.parse(input.pinned.sourceEvent),
    estimate,
  });

  // AC6, before anything else is assembled: an unbudgetable pinned set costs
  // nothing to detect here and everything to discover an hour into a run.
  const pinnedTokens = sumTokens(pinned);
  if (pinnedTokens > budget.limitTokens) {
    throw new PinnedSetExceedsBudget({
      node: input.nodeId,
      pinnedTokens,
      limitTokens: budget.limitTokens,
      provider: input.target.provider,
      model: input.target.model,
      maxContext: input.target.maxContext,
    });
  }

  const supplied: Segment[] = [];
  for (const segment of input.segments ?? []) {
    if (segment.pinned) throw new PinnedSegmentSuppliedLate(segment.id);
    const actual = await contentHash(segment.text);
    if (actual !== segment.contentHash) {
      throw new SegmentContentHashMismatch(segment.id, segment.contentHash, actual);
    }
    // Re-measured through this build's estimator, so one packet never mixes
    // two counting tiers (§7).
    supplied.push({ ...segment, tokens: estimate(segment.text) });
  }

  const assembled = [...pinned, ...supplied.toSorted((a, b) => fillRank(a) - fillRank(b))];
  const demotion = await demote(assembled, {
    limitTokens: budget.limitTokens,
    estimate,
    thresholdBytes: input.inlineThresholdBytes ?? INLINE_THRESHOLD_BYTES_DEFAULT,
    descriptions: input.descriptions ?? {},
  });

  const segments = demotion.segments;
  const prompt = renderPacket({ segments });
  const packet = ContextPacketSchema.parse({
    schemaId: 'DeFlow.contextpacket.v1',
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    builtAtEvent: input.builtAtEvent,
    target: input.target,
    budget,
    totals: totalsOf(segments),
    renderedPromptHandle: `artifact://${(await contentHash(prompt)).slice('sha256-'.length)}`,
    pinnedDigests: segments.filter((s) => s.pinned).map((s) => s.contentHash),
    segments,
  });

  // AC6 — the planning smell, raised beside the budget clamp because both are
  // facts about this build that only the caller can act on.
  const planning =
    input.reinjection === undefined
      ? null
      : reinjectionPlanningWarning({
          node: input.nodeId,
          pinReinjectTurns: input.reinjection.pinReinjectTurns,
          steering: input.reinjection.steering,
          ...(input.reinjection.expectedTurns === undefined
            ? {}
            : { expectedTurns: input.reinjection.expectedTurns }),
        });

  return {
    packet,
    warnings: [warning, planning].filter((text): text is string => text !== null),
    demotion: demotion.result,
    // The same list `buildPinnedSegments` rendered, counted rather than
    // re-derived — see `pinnedConstraintsOf`.
    constraints: countConstraintForms(
      pinnedConstraintsOf(input.pinned.spec, input.pinned.constraints ?? []),
    ),
  };
}

/**
 * The demoted form of `segment`: same slot, same id, same provenance, body
 * replaced by the handle that addresses it.
 *
 * `contentHash` is the stub's own digest, not the original's — every segment's
 * hash is the sha256 of its own `text` without exception, which is what lets
 * the CAS round-trip a packet from its manifest. The original's digest is not
 * lost: it *is* the handle in the stub's text, and the bytes travel out in
 * `PacketDemotion.bodies`.
 *
 * `compactable: false` because a handle has nothing left to offload.
 */
async function asHandle(
  segment: Segment,
  estimate: TokenEstimator,
  description: string | undefined,
): Promise<Segment> {
  const text = handleStubText(segment, description);
  return {
    id: segment.id,
    kind: 'artifact.handle',
    sourceEvent: segment.sourceEvent,
    contentHash: await contentHash(text),
    tokens: estimate(text),
    pinned: false,
    compactable: false,
    text,
  };
}

interface DemotionPass {
  readonly segments: readonly Segment[];
  readonly result: PacketDemotion;
}

interface DemotionInput {
  readonly limitTokens: number;
  readonly estimate: TokenEstimator;
  readonly thresholdBytes: number;
  readonly descriptions: Readonly<Record<string, string>>;
}

/**
 * Two passes over one ladder, in the order the two rules apply.
 *
 * The threshold pass runs first and unconditionally (AC1): a body that big is
 * carried by reference whatever the budget says, so it is gone before the
 * budget is even consulted. The budget pass then walks the same ladder for
 * whatever is left, in §5.2's order.
 *
 * Both produce the same thing — a stub whose `text` is the handle line, and
 * the bytes carried out for the caller to store — and both are recorded in one
 * `PacketDemotion`, tagged with which rule fired. A stub is never demoted
 * twice: `asHandle` marks it `compactable: false`, and `selectCompactionCandidates`
 * (KAR-09.3) never offers a non-compactable segment.
 */
async function demote(assembled: readonly Segment[], input: DemotionInput): Promise<DemotionPass> {
  const { limitTokens, estimate, thresholdBytes, descriptions } = input;
  const before = sumTokens(assembled);
  const ladder = demotionLadder({ segments: assembled });
  const replacements = new Map<SegmentId, Segment>();
  const droppedSegments: SegmentId[] = [];
  const demotedToHandles: Handle[] = [];
  const bodies: DemotedBody[] = [];

  let tokens = before;
  const take = async (candidate: Segment, reason: DemotionReason): Promise<void> => {
    const description = descriptions[candidate.id];
    const stub = await asHandle(candidate, estimate, description);
    const handle = handleForSegment(candidate);
    replacements.set(candidate.id, stub);
    droppedSegments.push(candidate.id);
    demotedToHandles.push(handle);
    bodies.push({
      segment: candidate.id,
      handle,
      text: candidate.text,
      description: description ?? defaultDescription(candidate),
      reason,
    });
    tokens -= candidate.tokens.estimated - stub.tokens.estimated;
  };

  for (const candidate of ladder) {
    if (exceedsInlineThreshold(candidate, thresholdBytes))
      await take(candidate, 'inline-threshold');
  }

  for (const candidate of ladder) {
    if (tokens <= limitTokens) break;
    if (replacements.has(candidate.id)) continue;
    await take(candidate, 'budget');
  }

  const segments = assembled.map((segment) => replacements.get(segment.id) ?? segment);
  return {
    segments,
    result: {
      ladder: ladder.map((segment) => segment.id),
      droppedSegments,
      demotedToHandles,
      bodies,
      before,
      after: tokens,
      fits: tokens <= limitTokens,
    },
  };
}
