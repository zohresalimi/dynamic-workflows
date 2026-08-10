/**
 * KAR-15.6 AC3, AC5, AC6 — the projections the inspection surfaces read.
 *
 * Pure functions of what the ledger already holds. Every one of these exists
 * because a specific P0 view would otherwise reconstruct server-side state in
 * the browser:
 *
 * - `nodeBundle` is F10.3's node inspector header — provider, model, binary
 *   version, permission, duration, cost, retries and worktree in one object,
 *   because a panel that had to join four endpoints would render four times.
 * - `packetView` is F10.3's context breakdown, served **from the stored
 *   manifest**. It re-derives nothing. A per-segment breakdown recomputed from
 *   the rendered prompt is the failure this whole endpoint exists to prevent,
 *   and its visible symptom is a breakdown that does not sum to its header.
 * - `findingsByFile` and `gatesView` are F7.3/F7.4's verdict surfaces.
 * - `factsPage` is F10.4's memory graph, with provenance on every row —
 *   *"which node wrote it, from what evidence, at what time, at what
 *   confidence"* is the question the view is for, so it is never a join.
 */
import type {
  BudgetRollup,
  ContextPacketRecord,
  FindingV2,
  GateVerdictState,
  NodeCostRollup,
  NodeState,
  RunId,
  SegmentRecord,
} from '@DeFlow/core';
import type { NodeTiming, StoredFact } from '@DeFlow/ledger';

/* ── the node inspector bundle ─────────────────────────────────────────── */

export interface NodeBundle {
  readonly runId: RunId;
  readonly nodeId: string;
  /** 0-based, as §9's envelope is. */
  readonly attempt: number;
  readonly status: NodeState['status'];
  readonly provider: string | null;
  readonly model: string | null;
  /**
   * The version of the binary this node's provider was probed at, from the
   * capability manifest (KAR-05.2). `null` when nothing has probed it — never
   * a guess, because "which binary produced this output" is the first question
   * asked of a result that looks wrong.
   */
  readonly binaryVersion: string | null;
  readonly permission: string | null;
  readonly worktree: string | null;
  readonly startedTs: number | null;
  readonly endedTs: number | null;
  /** `null` while the node is still running — never `now - startedTs`. */
  readonly durationMs: number | null;
  /** Attempts beyond the first. `attempts` is 1-based; this is not. */
  readonly retries: number;
  /** KAR-14.1's per-node accounting, passed through whole. */
  readonly cost: NodeCostRollup | null;
  readonly result: NodeState['result'];
  readonly failure: NodeState['failure'];
  readonly suspension: NodeState['suspension'];
  /** The `seq` of the last event that moved this node (NF10). */
  readonly updatedSeq: number;
}

export interface NodeBundleInput {
  readonly runId: RunId;
  readonly nodeId: string;
  readonly attempt: number;
  readonly node: NodeState;
  readonly budget: BudgetRollup;
  readonly timing: NodeTiming;
  readonly binaryVersion: string | null;
}

export function nodeBundle(input: NodeBundleInput): NodeBundle {
  const { node } = input;
  return {
    runId: input.runId,
    nodeId: input.nodeId,
    attempt: input.attempt,
    status: node.status,
    provider: node.provider,
    model: node.model,
    binaryVersion: input.binaryVersion,
    permission: node.permission,
    worktree: node.worktree,
    startedTs: input.timing.startedTs,
    endedTs: input.timing.endedTs,
    durationMs: input.timing.durationMs,
    // `attempts` is `attempt + 1` and monotone, so this is the count of times
    // the node was tried again — 0 for a node that ran once, whatever the
    // 0-based attempt index says.
    retries: Math.max(0, node.attempts - 1),
    cost: input.budget.nodes[input.nodeId] ?? null,
    result: node.result,
    failure: node.failure,
    suspension: node.suspension,
    updatedSeq: node.updatedSeq,
  };
}

/* ── the context packet breakdown ──────────────────────────────────────── */

/**
 * The packet as the inspector renders it: the stored manifest, with pinned
 * segments first.
 *
 * Segment `text` is deliberately absent. The text of every segment *is* the
 * rendered prompt, and inlining it would make the inspector's own request the
 * largest in the API; `renderedPromptHandle` and each segment's `contentHash`
 * are how a client fetches the bytes it actually wants, through
 * `GET /api/artifacts/:sha`.
 */
export interface PacketView extends Omit<ContextPacketRecord, 'segments'> {
  readonly segments: readonly SegmentRecord[];
}

export function packetView(record: ContextPacketRecord): PacketView {
  // Stable within each group, so the order a packet was *built* in survives —
  // which is the order the agent read it in, and therefore the order the
  // inspector must show it in.
  const pinned = record.segments.filter((segment) => segment.pinned);
  const rest = record.segments.filter((segment) => !segment.pinned);

  // `totals` is copied through untouched. Recomputing it here would make this
  // endpoint a second source for a number the ledger already recorded, and the
  // two would disagree the first time the tokenizer was upgraded.
  return { ...record, segments: [...pinned, ...rest] };
}

/* ── gates, criteria and findings ──────────────────────────────────────── */

export interface GateRow {
  /** The gate *node*; one definition can be scheduled more than once. */
  readonly node: string;
  readonly gate: string;
  readonly outcome: GateVerdictState['outcome'];
  readonly seq: number;
  readonly summary: string;
  readonly findings: number;
}

/** Every gate this run has answered, oldest verdict first. */
export function gatesView(
  verdicts: Readonly<Record<string, GateVerdictState>>,
): readonly GateRow[] {
  return Object.entries(verdicts)
    .map(([node, verdict]) => ({
      node,
      gate: verdict.gate,
      outcome: verdict.outcome,
      seq: verdict.seq,
      summary: verdict.summary,
      findings: verdict.findings.length,
    }))
    .toSorted((left, right) => left.seq - right.seq || left.node.localeCompare(right.node));
}

/** A finding with the gate that reported it — so the panel needs no join. */
export interface AttributedFinding extends FindingV2 {
  readonly gate: string;
  readonly node: string;
}

export interface FindingGroup {
  /** `null` for findings about the change as a whole, which have no file. */
  readonly file: string | null;
  readonly findings: readonly AttributedFinding[];
}

/**
 * AC6 — findings grouped by file and ordered by line.
 *
 * A finding with no `location` is kept and grouped under `null`, last. Dropping
 * it would hide a judgement that is still exactly as true as a located one —
 * "this change does the wrong thing" has no line number and is the most
 * important thing on the panel.
 */
export function findingsByFile(
  verdicts: Readonly<Record<string, GateVerdictState>>,
  file: string | undefined,
): readonly FindingGroup[] {
  const groups = new Map<string | null, AttributedFinding[]>();

  for (const [node, verdict] of Object.entries(verdicts)) {
    for (const finding of verdict.findings) {
      const key = finding.location?.file ?? null;
      if (file !== undefined && key !== file) continue;
      const bucket = groups.get(key) ?? [];
      bucket.push({ ...finding, gate: verdict.gate, node });
      groups.set(key, bucket);
    }
  }

  return [...groups.entries()]
    .toSorted(([left], [right]) => {
      // The unlocated group sorts last, whatever its neighbours are called.
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      return left.localeCompare(right);
    })
    .map(([key, findings]) => ({
      file: key,
      findings: findings.toSorted(
        (left, right) =>
          (left.location?.line ?? 0) - (right.location?.line ?? 0) ||
          left.id.localeCompare(right.id),
      ),
    }));
}

/* ── the memory graph ──────────────────────────────────────────────────── */

export interface FactProvenance {
  readonly node: string;
  readonly provider: string;
  readonly model: string;
  readonly evidence: readonly string[];
  /** ISO-8601, as the fact recorded it. */
  readonly at: string;
  /** The `seq` the fact claims it was established at. */
  readonly atEvent: number;
  /** The `seq` of the `fact.written` that put it in the blackboard (NF10). */
  readonly writtenSeq: number;
  readonly confidence: string;
}

export interface FactRow {
  readonly id: string;
  readonly key: string;
  readonly kind: string;
  readonly schemaId: string;
  readonly value: unknown;
  readonly supersedes: string | null;
  /** `null` unless something has invalidated it; the fact itself stays. */
  readonly invalidated: { readonly reason: string } | null;
  readonly provenance: FactProvenance;
}

export interface FactsQuery {
  readonly limit: number;
  readonly key?: string | undefined;
  /** The writing node, as `?by=` names it. */
  readonly by?: string | undefined;
}

/**
 * AC5 — one row per fact, with provenance attached rather than joinable.
 *
 * An invalidated fact is still a row. History is never rewritten, and a memory
 * graph that hid stale facts would leave a node that read one showing an input
 * from nowhere.
 */
export function factsPage(facts: readonly StoredFact[], query: FactsQuery): readonly FactRow[] {
  return facts
    .filter((entry) => query.key === undefined || entry.fact.key === query.key)
    .filter((entry) => query.by === undefined || entry.fact.provenance.byNode === query.by)
    .slice(0, query.limit)
    .map((entry) => ({
      id: entry.fact.id,
      key: entry.fact.key,
      kind: entry.fact.kind,
      schemaId: entry.fact.schemaId,
      value: entry.fact.value,
      supersedes: entry.fact.supersedes ?? null,
      invalidated: entry.invalidatedReason === null ? null : { reason: entry.invalidatedReason },
      provenance: {
        node: entry.fact.provenance.byNode,
        provider: entry.fact.provenance.byProvider,
        model: entry.fact.provenance.byModel,
        evidence: entry.fact.provenance.fromEvidence,
        at: entry.fact.provenance.at,
        atEvent: entry.fact.provenance.atEvent,
        writtenSeq: entry.writtenSeq,
        confidence: entry.fact.provenance.confidence,
      },
    }));
}
