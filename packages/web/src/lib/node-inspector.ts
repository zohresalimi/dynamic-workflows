/**
 * KAR-17.3 — the joins behind the node inspector (F10.3, F6.1, F6.2, F6.3,
 * NF10).
 *
 * Verifies: EPIC-17-S12, EPIC-17-S13, EPIC-17-S14, EPIC-17-S15, EPIC-17-S16 ·
 * AC1, AC2, AC3, AC5, AC6, AC7, AC8, AC9, AC10
 *
 * Pure. It takes the five projections the inspector reads and returns what the
 * panel draws; it touches no DOM and mounts nothing — the same split
 * `./criteria-board.ts` and `./review-index.ts` make, for the same reason. The
 * question this view answers is *"was the agent wrong, or was it given the
 * wrong information"*, and that question is a join over five projections
 * keyed five different ways. Doing the join in a template would walk four maps
 * per render and put the answer somewhere no test can reach without a browser.
 *
 * ## Three refusals, and each is the point of the view
 *
 * **Nothing is recomputed that the ledger already states.** The packet carries
 * both `totals.tokens` and a token count per segment, written by the same
 * builder. `reconcileTokens` returns *both* and a boolean saying whether they
 * agree, rather than returning one derived from the other. A builder that
 * shipped a header its own segments contradict is a real bug, and an inspector
 * that quietly rendered the sum would erase the only evidence of it — which is
 * exactly why AC3 asks for the sum to be *asserted* rather than displayed.
 *
 * **Absence is a value.** A node that died at `adapter.spawn-failed` has no
 * packet, and `packetSection` says `status: 'none'` with the typed
 * `NodeFailure` that explains it — never an empty group list that reads as "a
 * packet with nothing in it", and never a fabricated one (AC9). The same rule
 * runs through the cost column: a provider that reports no usage is *named* in
 * `unaccounted` and its money stays `null`, because a `0` is a claim that the
 * vendor billed nothing and nobody measured that (AC10).
 *
 * **Every figure carries the `seq` that produced it.** Not as decoration: NF10
 * says any state in the UI is traceable to specific ledger events, and the only
 * way to demonstrate rather than claim it is for the number and its provenance
 * to travel together. A view model that returned bare numbers would push the
 * lookup into a component, where it becomes a scan of a 2,000-envelope ring
 * that silently finds nothing on a long run.
 *
 * ## Why the packet diff is over segments and not over text
 *
 * EPIC-17-S13 compares attempt 1 with attempt 3 of a repair loop. Diffing the
 * two rendered prompts reports *"these differ"*, which an operator cannot act
 * on. Diffing segment by segment answers the question actually being asked —
 * did the repair change what this node was given, and which part of it — and it
 * makes the no-op case a **positive result**: `identical: true` says the repair
 * changed nothing about the context, which is a diagnosis. An empty changed-row
 * list and a diff that failed to run look the same otherwise.
 */
import { line } from 'd3-shape';
import type {
  BlackboardProjection,
  ConsumerVM,
  InvalidationVM,
} from '../ledger/projections/blackboard.ts';
import {
  type ContextProjection,
  type PacketVM,
  packetKey,
  SEGMENT_KINDS,
  type SegmentKind,
  type SegmentVM,
} from '../ledger/projections/context.ts';
import { attemptKey, type CostProjection } from '../ledger/projections/cost.ts';
import type {
  NodeBinaryVM,
  NodeFailureVM,
  NodeResultVM,
  PlanProjection,
} from '../ledger/projections/plan.ts';
import type { SpanOutcome, TimelineProjection } from '../ledger/projections/timeline.ts';

/**
 * The five projections the inspector reads.
 *
 * Taken as one bag rather than five parameters so a caller cannot pass them in
 * the wrong order — they are all `{ appliedSeq, …}` shapes and four of the five
 * would type-check transposed.
 */
export interface InspectorSources {
  readonly plan: PlanProjection;
  readonly context: ContextProjection;
  readonly cost: CostProjection;
  readonly timeline: TimelineProjection;
  readonly blackboard: BlackboardProjection;
}

// ── the context packet ───────────────────────────────────────────────────────

/** One of the nine kinds, its segments, and the two totals for it. */
export interface SegmentGroupVM {
  readonly kind: SegmentKind;
  /** In the packet's own order within the kind. Never re-sorted by size. */
  readonly segments: readonly SegmentVM[];
  /** Summed from `segments`. */
  readonly tokens: number;
  /** What `totals.byKind` says. Kept beside the sum, never replaced by it. */
  readonly declared: number;
  /** Whether every segment of this kind is pinned — the three `pinned.*`. */
  readonly pinned: boolean;
}

/**
 * The nine kinds, in `SEGMENT_KINDS` order, always all nine.
 *
 * The order is the **prompt's**: the three `pinned.*` kinds first, because that
 * is where the builder puts them and AC2 asks for the panel to match; then the
 * brief, the facts, the handles, the retrieved chunks, the history summary and
 * the tool output. Not sorted by token count and not alphabetical — an operator
 * reading this panel is reconstructing what the model read, in the order it
 * read it.
 *
 * A kind the packet has nothing of is an **empty group, not a missing row**.
 * "This packet carried no tool output" is an answer to a question somebody is
 * asking; a row that silently vanishes makes them count kinds to notice.
 */
export function segmentGroups(packet: PacketVM): readonly SegmentGroupVM[] {
  return SEGMENT_KINDS.map((kind) => {
    const segments = packet.segments.filter((segment) => segment.kind === kind);
    return {
      kind,
      segments,
      tokens: segments.reduce((sum, segment) => sum + segment.tokens.estimated, 0),
      declared: packet.totals.byKind[kind] ?? 0,
      pinned: segments.length > 0 && segments.every((segment) => segment.pinned),
    };
  });
}

/** The two totals for one kind, side by side. */
export interface KindReconciliation {
  readonly declared: number;
  readonly summed: number;
}

export interface TokenReconciliation {
  /** `totals.tokens`, as the builder wrote it. */
  readonly headerTotal: number;
  /** The per-segment counts, added up here. */
  readonly segmentSum: number;
  readonly byKind: Readonly<Record<SegmentKind, KindReconciliation>>;
  /** AC3: the whole assertion, as one boolean. */
  readonly reconciles: boolean;
}

/**
 * AC3 — *"the per-segment token counts sum to the header total"*.
 *
 * Returns both numbers and their agreement rather than one number. See the
 * module note: the header and the breakdown come from the same builder, so a
 * disagreement is a defect worth surfacing, and a function that returned only
 * the sum would make the defect unobservable by construction.
 */
export function reconcileTokens(packet: PacketVM): TokenReconciliation {
  const groups = segmentGroups(packet);
  const byKind = Object.fromEntries(
    groups.map((group) => [group.kind, { declared: group.declared, summed: group.tokens }]),
  ) as Record<SegmentKind, KindReconciliation>;

  const segmentSum = groups.reduce((sum, group) => sum + group.tokens, 0);
  const headerTotal = packet.totals.tokens;

  return {
    headerTotal,
    segmentSum,
    byKind,
    reconciles:
      segmentSum === headerTotal && groups.every((group) => group.tokens === group.declared),
  };
}

export type SegmentChange = 'unchanged' | 'added' | 'removed' | 'changed';

export interface PacketDiffRowVM {
  readonly id: string;
  readonly kind: SegmentKind;
  readonly change: SegmentChange;
  /** `null` where the segment is absent from that side. */
  readonly leftHash: string | null;
  readonly rightHash: string | null;
  readonly leftTokens: number | null;
  readonly rightTokens: number | null;
}

export interface PacketDiffVM {
  readonly rows: readonly PacketDiffRowVM[];
  /**
   * AC6 / EPIC-17-S13 — *"a repair that produced an identical packet is a
   * visible, diagnosable no-op"*. Stated rather than left to be inferred from
   * an absence of changed rows, which is indistinguishable from a diff that
   * never ran.
   */
  readonly identical: boolean;
}

/**
 * AC6 — attempt N's packet against attempt M's, segment by segment.
 *
 * Keyed on segment `id` and compared on `contentHash`, so a segment whose
 * content changed is reported as **changed** rather than as one removal and one
 * addition. That distinction is the diagnosis: "the fact this node read was
 * rewritten" and "the fact was dropped and a different one added" are different
 * events with different causes.
 *
 * Rows come back in the same nine-kind order the panel renders, so a reader can
 * follow the diff down the same axis as the packet above it.
 */
export function diffPackets(left: PacketVM, right: PacketVM): PacketDiffVM {
  const leftById = new Map(left.segments.map((segment) => [segment.id, segment]));
  const rightById = new Map(right.segments.map((segment) => [segment.id, segment]));

  const rows: PacketDiffRowVM[] = [];
  for (const kind of SEGMENT_KINDS) {
    // The left packet's order first, then whatever only the right one has —
    // so an added segment appears where it sits in the packet that gained it.
    const ids = [
      ...left.segments.filter((segment) => segment.kind === kind).map((segment) => segment.id),
      ...right.segments
        .filter((segment) => segment.kind === kind && !leftById.has(segment.id))
        .map((segment) => segment.id),
    ];

    for (const id of ids) {
      const before = leftById.get(id) ?? null;
      const after = rightById.get(id) ?? null;
      rows.push({
        id,
        kind,
        change: classify(before, after),
        leftHash: before?.contentHash ?? null,
        rightHash: after?.contentHash ?? null,
        leftTokens: before?.tokens.estimated ?? null,
        rightTokens: after?.tokens.estimated ?? null,
      });
    }
  }

  return { rows, identical: rows.every((row) => row.change === 'unchanged') };
}

function classify(before: SegmentVM | null, after: SegmentVM | null): SegmentChange {
  if (before === null) return 'added';
  if (after === null) return 'removed';
  return before.contentHash === after.contentHash ? 'unchanged' : 'changed';
}

// ── the packet section, including its absence ────────────────────────────────

export interface PacketSectionVM {
  /** `'none'` is a rendered state with a reason, never a blank panel (AC9). */
  readonly status: 'built' | 'none';
  readonly nodeId: string;
  readonly attempt: number;
  readonly groups: readonly SegmentGroupVM[];
  /** `null` when no packet was built — never `0`, which is a measurement. */
  readonly headerTotal: number | null;
  readonly segmentSum: number | null;
  readonly reconciles: boolean | null;
  /** The `seq` of the `context.built` that recorded it (AC7). */
  readonly builtAtSeq: number | null;
  /**
   * The handle of the exact prompt this packet rendered to (AC4).
   *
   * A handle and not the text: the prompt is fetched from
   * `GET /api/artifacts/:sha` when the pane is opened. It is also *derived* —
   * the manifest above is what the daemon assembled and is authoritative, and
   * the panel says so, because a rendered prompt that disagreed with its
   * manifest would otherwise silently win the argument.
   */
  readonly promptHandle: string | null;
  /** F6.6 — a pinned segment's digest no longer matches what was pinned. */
  readonly pinViolated: boolean;
  /** Why there is no packet. Present exactly when `status` is `'none'`. */
  readonly absence: NodeFailureVM | null;
}

/**
 * AC2 and AC9 — the packet for one attempt, or an honest account of its
 * absence.
 *
 * The two failure modes AC9 names — `adapter.spawn-failed`,
 * `safety.permission-unschedulable` — happen *before* context assembly, so
 * there is genuinely nothing to show. What is shown instead is the typed
 * `NodeFailure`: reason, class, one-line message and evidence handles. A blank
 * panel and a fabricated empty packet are both worse than that, and they are
 * the two things a naive implementation produces.
 */
export function packetSection(
  sources: InspectorSources,
  nodeId: string,
  attempt: number,
): PacketSectionVM {
  const packet = sources.context.packets.get(packetKey(nodeId, attempt));
  if (packet === undefined) {
    const node = sources.plan.nodes.get(nodeId);
    return {
      status: 'none',
      nodeId,
      attempt,
      groups: [],
      headerTotal: null,
      segmentSum: null,
      reconciles: null,
      builtAtSeq: null,
      promptHandle: null,
      pinViolated: false,
      absence: node?.failures.find((one) => one.attempt === attempt) ?? node?.failure ?? null,
    };
  }

  const check = reconcileTokens(packet);
  return {
    status: 'built',
    nodeId,
    attempt,
    groups: segmentGroups(packet),
    headerTotal: check.headerTotal,
    segmentSum: check.segmentSum,
    reconciles: check.reconciles,
    builtAtSeq: packet.builtAtSeq,
    promptHandle: packet.renderedPromptHandle,
    pinViolated: packet.violated,
    absence: null,
  };
}

// ── the attempt history ──────────────────────────────────────────────────────

/** What one attempt spent, and the event that last said so. */
export interface AttemptCostVM {
  readonly vendorReported: number | null;
  readonly estimated: number | null;
  /** AC10 — providers that reported nothing pricable. Named, never zeroed. */
  readonly unaccounted: readonly string[];
  /** The `seq` of the `budget.consumed` that last moved it; `0` for none. */
  readonly seq: number;
}

export interface AttemptRowVM {
  /**
   * `${nodeId}#${attempt}` — the same pair the ledger's idempotency key is
   * built from, so "which attempt is this row" has one answer system-wide.
   */
  readonly key: string;
  readonly attempt: number;
  readonly outcome: SpanOutcome | 'running';
  readonly failure: NodeFailureVM | null;
  /** The `seq` of the event that ended the attempt in failure. */
  readonly failureAtSeq: number | null;
  readonly startedAtSeq: number;
  readonly endedAtSeq: number | null;
  /** `null` while the attempt is still open. Never `now - start`. */
  readonly durationMs: number | null;
  readonly cost: AttemptCostVM;
  /** Whether a context packet exists for this attempt, for the selector. */
  readonly hasPacket: boolean;
}

const NO_COST: AttemptCostVM = { vendorReported: null, estimated: null, unaccounted: [], seq: 0 };

/**
 * AC1 / EPIC-17-S13 — *"every attempt shows its outcome, its typed NodeFailure
 * reason and class where it failed, its duration, its cost, and the `seq` of
 * its `node.started`"*.
 *
 * Driven off the timeline's spans, because a span **is** an attempt: it is
 * created by `node.started` and closed by the terminal event, which is exactly
 * the interval the row describes. The failure comes from the plan projection's
 * per-attempt list and the money from the cost projection's per-attempt bucket
 * — three projections, joined on the one key all three already use.
 */
export function attemptRows(sources: InspectorSources, nodeId: string): readonly AttemptRowVM[] {
  const node = sources.plan.nodes.get(nodeId);

  return [...sources.timeline.spans.values()]
    .filter((span) => span.nodeId === nodeId)
    .toSorted((left, right) => left.attempt - right.attempt)
    .map((span) => {
      const key = attemptKey(nodeId, span.attempt);
      const bucket = sources.cost.byAttempt.get(key);
      const failure = node?.failures.find((one) => one.attempt === span.attempt) ?? null;

      return {
        key,
        attempt: span.attempt,
        outcome: span.outcome ?? 'running',
        failure,
        // The event that closed the span *is* the `node.failed` that carries
        // the failure, so the link is the span's own end rather than a second
        // scan of the ring for an envelope naming this attempt.
        failureAtSeq: failure === null ? null : span.endSeq,
        startedAtSeq: span.startSeq,
        endedAtSeq: span.endSeq,
        // `null` while open. An elapsed time computed against the wall clock
        // would tick on a finished run and would make this view time-dependent,
        // which docs/12 §3 forbids for exactly this reason.
        durationMs: span.endTs === null ? null : span.endTs - span.startTs,
        cost:
          bucket === undefined
            ? NO_COST
            : {
                vendorReported: bucket.costUsd.vendorReported,
                estimated: bucket.costUsd.estimated,
                unaccounted: bucket.unaccounted,
                seq: bucket.lastSeq,
              },
        hasPacket: sources.context.packets.has(packetKey(nodeId, span.attempt)),
      };
    });
}

// ── the provenance table ─────────────────────────────────────────────────────

export interface ProvenanceRowVM {
  readonly factId: string;
  readonly key: string;
  /** A short rendering of the value. The full object is one click away. */
  readonly valueSummary: string;
  readonly byNode: string;
  readonly byProvider: string;
  readonly byModel: string;
  readonly evidence: readonly string[];
  /** ISO 8601, display only. `atEvent` is the ordering key. */
  readonly at: string;
  readonly atEvent: number;
  readonly confidence: 'asserted' | 'verified' | 'speculative';
  /** The `seq` of the `fact.written` that produced it (AC7). */
  readonly writtenAtSeq: number;
  /** The `seq` of this node's own `fact.read` (AC7). */
  readonly readAtSeq: number;
  readonly invalidated: InvalidationVM | null;
}

/**
 * AC8 / EPIC-17-S15 — *"every fact this node read: key, value summary, writing
 * node, evidence handles, timestamp, confidence, and whether the fact has since
 * been invalidated"*.
 *
 * The read set comes from `fact.read` and never from the plan's declared data
 * edges — which is the entire reason `fact.read` is an event (see
 * `../ledger/projections/blackboard.ts`). A table built from declared edges
 * would list what this node *could* have read, and the question being asked is
 * what it *did*.
 *
 * Per roadmap §3 this table is M1's coverage of F10.4 if the memory graph
 * (KAR-17.9) slips: it answers *"which node produced the wrong assumption"* for
 * one node, where the graph answers it across the whole run.
 */
export function provenanceRows(
  sources: InspectorSources,
  nodeId: string,
): readonly ProvenanceRowVM[] {
  const rows: ProvenanceRowVM[] = [];

  for (const fact of sources.blackboard.facts.values()) {
    const read = fact.consumers.find((consumer: ConsumerVM) => consumer.node === nodeId);
    if (read === undefined) continue;

    rows.push({
      factId: fact.id,
      key: fact.key,
      valueSummary: summarise(fact.value),
      byNode: fact.provenance.byNode,
      byProvider: fact.provenance.byProvider,
      byModel: fact.provenance.byModel,
      evidence: fact.provenance.fromEvidence,
      at: fact.provenance.at,
      atEvent: fact.provenance.atEvent,
      confidence: fact.provenance.confidence,
      writtenAtSeq: fact.writtenAtSeq,
      readAtSeq: read.seq,
      invalidated: fact.invalid,
    });
  }

  // By when this node read them, so the table reads in the order the node
  // actually consumed its inputs.
  return rows.toSorted((left, right) => left.readAtSeq - right.readAtSeq);
}

/** 120 characters of JSON. The row is a summary; the fact is one click away. */
function summarise(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length <= 120 ? text : `${text.slice(0, 119)}…`;
}

// ── the whole panel ──────────────────────────────────────────────────────────

export interface InspectorHeaderVM {
  readonly id: string;
  readonly title: string;
  readonly type: string | null;
  readonly state: string;
  readonly provider: string | null;
  readonly model: string | null;
  readonly permission: string | null;
  readonly pathScopes: {
    readonly write: readonly string[];
    readonly read: readonly string[];
  } | null;
  readonly worktree: string | null;
  /** CLI version and binary sha256, from `node.started` (AC1). */
  readonly binary: NodeBinaryVM | null;
}

/** The validator's own words, beside the output that failed it (AC5). */
export interface SchemaErrorVM {
  readonly instancePath: string;
  readonly schemaPath: string;
  readonly keyword: string;
  readonly message: string;
}

export interface SchemaErrorsVM {
  readonly schemaId: string;
  readonly errors: readonly SchemaErrorVM[];
}

export interface NodeInspectionVM {
  readonly header: InspectorHeaderVM;
  readonly attempt: number;
  readonly attempts: readonly AttemptRowVM[];
  readonly packet: PacketSectionVM;
  readonly provenance: readonly ProvenanceRowVM[];
  /** EPIC-17-S15 — this node read something since proven wrong. */
  readonly tainted: boolean;
  /** The normalised, schema-validated object a completed node returned. */
  readonly normalisedOutput: NodeResultVM | null;
  /** Handles for the raw bytes. Never the bytes — see `PacketSectionVM`. */
  readonly rawOutputHandles: readonly string[];
  /** Present only on a `contract.schema-invalid` failure. */
  readonly schemaErrors: SchemaErrorsVM | null;
}

/**
 * The whole panel for one node at one attempt.
 *
 * `attempt` is a parameter rather than "the latest": the attempt selector is
 * half of what makes this a diagnostic tool (AC6), and a view model that could
 * only describe the last attempt would make the selector a lie.
 */
export function inspectNode(
  sources: InspectorSources,
  nodeId: string,
  attempt: number,
): NodeInspectionVM {
  const node = sources.plan.nodes.get(nodeId);
  const attempts = attemptRows(sources, nodeId);
  const failure = node?.failures.find((one) => one.attempt === attempt) ?? null;
  const result = node?.result ?? null;

  return {
    header: {
      id: nodeId,
      title: node?.title ?? nodeId,
      type: node?.type ?? null,
      state: node?.state ?? 'pending',
      provider: node?.provider ?? null,
      model: node?.model ?? null,
      permission: node?.permission ?? null,
      pathScopes: node?.pathScopes ?? null,
      worktree: node?.worktree ?? null,
      binary: node?.binary ?? null,
    },
    attempt,
    attempts,
    packet: packetSection(sources, nodeId, attempt),
    provenance: provenanceRows(sources, nodeId),
    tainted: (sources.blackboard.taints.get(nodeId)?.length ?? 0) > 0,
    // The result belongs to the attempt that produced it: showing attempt 2's
    // output under attempt 0's tab would be a fabrication of the quiet kind.
    normalisedOutput: result !== null && result.attempt === attempt ? result : null,
    rawOutputHandles: failure?.evidence ?? result?.artifacts ?? [],
    schemaErrors: schemaErrorsOf(failure),
  };
}

/**
 * AC5 — *"a `contract.schema-invalid` failure shows the Ajv error beside the
 * offending output rather than a generic message"*.
 *
 * `NodeFailure.detail` is *"reason-specific and JSON-only"* (docs/04 §8), so it
 * is `unknown` here and is narrowed rather than cast: a detail that does not
 * carry the expected shape yields `null` and the panel falls back to the
 * failure's own message, which is honest. Casting would put a runtime crash in
 * a diagnostic view at the exact moment somebody is using it to diagnose
 * something else.
 */
function schemaErrorsOf(failure: NodeFailureVM | null): SchemaErrorsVM | null {
  if (failure === null || failure.reason !== 'contract.schema-invalid') return null;

  const detail = failure.detail;
  if (detail === null) return null;

  const schemaId = detail['schemaId'];
  const ajv = detail['ajv'];
  if (typeof schemaId !== 'string' || !Array.isArray(ajv)) return null;

  const errors: SchemaErrorVM[] = [];
  for (const entry of ajv) {
    if (typeof entry !== 'object' || entry === null) continue;
    const one = entry as Record<string, unknown>;
    errors.push({
      instancePath: typeof one['instancePath'] === 'string' ? one['instancePath'] : '',
      schemaPath: typeof one['schemaPath'] === 'string' ? one['schemaPath'] : '',
      keyword: typeof one['keyword'] === 'string' ? one['keyword'] : '',
      message: typeof one['message'] === 'string' ? one['message'] : '',
    });
  }

  return { schemaId, errors };
}

// ── the sparkline ────────────────────────────────────────────────────────────

export interface SparklineVM {
  /** An SVG path `d`. The component renders `<path :d>` and owns the subtree. */
  readonly path: string;
  /** The values behind it, so a data-table twin can state them. */
  readonly points: readonly number[];
}

export interface SparklineBox {
  readonly width: number;
  readonly height: number;
}

/**
 * AC11 — how the packet grew across a node's attempts, as one `<path>`.
 *
 * `d3-shape`'s `line()` and nothing else: it is a **generator**, it takes an
 * array and returns a string, and it never touches the DOM. That is the whole
 * reason the architecture allows `d3-shape` and forbids `d3-selection`
 * (docs/12 §6.9) — a path string cannot become a second owner of a subtree Vue
 * is already rendering, and `test/no-d3-selection-in-web.test.ts` keeps the
 * distinction from eroding.
 *
 * `null` for a node with no packets at all. A flat line at zero would draw a
 * measurement of something nobody measured, which is AC10's mistake in another
 * medium.
 */
export function attemptSparkline(
  sources: InspectorSources,
  nodeId: string,
  box: SparklineBox,
): SparklineVM | null {
  const points = [...sources.context.packets.values()]
    .filter((packet) => packet.nodeId === nodeId)
    .toSorted((left, right) => left.attempt - right.attempt)
    .map((packet) => packet.totals.tokens);

  if (points.length === 0) return null;

  // A single attempt spans no range, and a scale over a zero-width domain
  // divides by zero. It is drawn at the left edge as one point, which is what
  // one measurement looks like.
  const span = points.length - 1;
  const low = Math.min(...points);
  const high = Math.max(...points);
  // Likewise for a flat series: every attempt built the same size packet, which
  // is a real and interesting answer, and it draws as a horizontal line at the
  // middle rather than as a division by zero.
  const range = high - low;

  const path = line<number>()
    .x((_, index) => (span === 0 ? 0 : (index / span) * box.width))
    .y((value) =>
      range === 0 ? box.height / 2 : box.height - ((value - low) / range) * box.height,
    )(points);

  return path === null ? null : { path, points };
}
