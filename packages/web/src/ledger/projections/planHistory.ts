/**
 * KAR-16.3 — `planHistory.ts`: the version rail behind F10.2's scrubber
 * (docs/12-frontend-architecture.md §6.2).
 *
 * Verifies: EPIC-16-S17, EPIC-16-S23 · AC4, AC10, AC11
 *
 * ## The rail is not a list of versions
 *
 * A patch that was **refused** never produces a version, and it is still the
 * most interesting row on the rail: *"the run wanted to do X and was not
 * allowed to"* is the state NF10 exists to make legible, and a rail built only
 * from `plan.patched` cannot say it. So the rail is a chronology of *decisions*
 * — versions and rejections in `seq` order — and `versionsOf()` is the four
 * entries that moved the plan.
 *
 * ## `planHash` is never recomputed here
 *
 * The daemon computes it with its own canonical encoder over the whole document
 * (docs/04 §3), and the UI carries whatever the event said. The per-node
 * `contentHash` below is a different thing entirely and is labelled as such: a
 * **change-detection** hash over the fields the scrubber highlights, used to
 * answer "did this node change between v3 and v4", and never as an identity or
 * a primary key. It is computed over `@DeFlow/core`'s own `canonicalJson`,
 * which is the repository's one answer to "stable key ordering" — `ohash` would
 * be a second one, and two encoders is two answers to a question that only has
 * value if it has one.
 */
import type { Event } from '@DeFlow/core';
import { canonicalJson } from '@DeFlow/core';
import { type Ignorable, ignored } from './kinds.ts';

export type PatchDecisionOutcome = 'auto' | 'approved' | 'rejected' | 'queued';

/** One version of the plan, as the rail renders it. */
export interface PlanVersionEntry {
  readonly kind: 'version';
  readonly version: number;
  readonly seq: number;
  readonly planHash: string;
  /** `null` on v1: the initial compile was not decided by a patch rule. */
  readonly decision: PatchDecisionOutcome | null;
  readonly by: 'policy' | 'human' | null;
  readonly rule: string | null;
  /** The patch's own `reason`, verbatim — never summarised (docs/04 §3). */
  readonly reason: string;
  readonly patchId: string | null;
  readonly proposedBy: string | null;
  /** `nodeId` → change-detection hash, for this version. */
  readonly nodes: ReadonlyMap<string, string>;
}

/** A proposal that was recorded and refused. */
export interface RejectedProposalEntry {
  readonly kind: 'rejected';
  readonly seq: number;
  readonly patchId: string;
  readonly rule: string;
  readonly by: 'policy' | 'human' | 'validation';
  readonly reason: string;
  readonly proposedBy: string | null;
  readonly diagnostics: readonly string[];
}

/** A proposal waiting on a human — the approval queue's own row (F2.5). */
export interface QueuedProposalEntry {
  readonly kind: 'queued';
  readonly seq: number;
  readonly patchId: string;
  readonly rule: string;
  readonly reason: string;
  readonly costUsdDelta: number | null;
  readonly blastRadiusFiles: number;
  readonly maxPermission: string;
  readonly replanDepth: number;
}

/** A plan version that did not validate — a diagnosis, never an exception. */
export interface InvalidPlanEntry {
  readonly kind: 'invalid';
  readonly seq: number;
  readonly version: number;
  readonly planHash: string;
  readonly attempt: number;
  readonly diagnostics: readonly string[];
}

export type RailEntry =
  | PlanVersionEntry
  | RejectedProposalEntry
  | QueuedProposalEntry
  | InvalidPlanEntry;

interface HeldProposal {
  readonly patchId: string;
  readonly reason: string;
  readonly proposedBy: string;
  readonly ops: readonly PatchOpShape[];
}

export interface PlanHistoryProjection {
  appliedSeq: number;
  /** The version the plan is on. Unmoved by a rejection, by construction. */
  version: number;
  /** Versions, rejections, queued proposals and validation failures, in order. */
  rail: RailEntry[];
  /** `version` → the `seq` it was written at. `replayTo(planVersionSeq[N])`. */
  planVersionSeq: Map<number, number>;
  /** Proposals by id, so `plan.patched` can find the ops it names. */
  proposals: Map<string, HeldProposal>;
  /** The node documents as of the newest version, keyed by id. */
  nodes: Map<string, NodeDocument>;
}

export function emptyPlanHistory(): PlanHistoryProjection {
  return {
    appliedSeq: 0,
    version: 0,
    rail: [],
    planVersionSeq: new Map(),
    proposals: new Map(),
    nodes: new Map(),
  };
}

/** The rail entries that moved the plan, in order. */
export function versionsOf(state: PlanHistoryProjection): readonly PlanVersionEntry[] {
  return state.rail.filter((entry): entry is PlanVersionEntry => entry.kind === 'version');
}

export function applyPlanHistory(state: PlanHistoryProjection, event: Event): void {
  if (event.seq <= state.appliedSeq) return;
  state.appliedSeq = event.seq;

  switch (event.kind) {
    case 'plan.proposed': {
      state.nodes = new Map(
        event.payload.graph.nodes.map((node) => [node.id as string, node as NodeDocument]),
      );
      state.version = event.payload.version;
      state.planVersionSeq.set(event.payload.version, event.seq);
      state.rail.push({
        kind: 'version',
        version: event.payload.version,
        seq: event.seq,
        planHash: event.payload.planHash,
        decision: null,
        by: null,
        rule: null,
        // Overwritten by the `plan.patched` that promotes it, when there is
        // one; v1 has none, and *"the initial plan"* is the whole of its story.
        // A later version whose promotion has not arrived yet says so, because
        // it is a real state a tab can be in for the length of one transaction.
        reason: event.payload.version === 1 ? 'the initial plan' : 'proposed; not yet promoted',
        patchId: null,
        proposedBy: String(event.payload.by),
        nodes: hashNodes(state.nodes),
      });
      return;
    }

    case 'plan.patch.proposed': {
      const patch = event.payload.patch;
      state.proposals.set(patch.id, {
        patchId: patch.id,
        reason: patch.reason,
        proposedBy: String(patch.proposedBy),
        ops: patch.ops as readonly PatchOpShape[],
      });
      return;
    }

    case 'plan.patched': {
      const held = state.proposals.get(event.payload.patchId);
      state.version = event.payload.version;

      /**
       * The promotion of a version this rail already has a row for.
       *
       * `applyPatchedPlanVersion` writes **both** `plan.proposed` (carrying the
       * successor document) and `plan.patched` (carrying the hashes and the
       * decision) in one transaction, because *"`plan.patched` carries hashes
       * and no document"* — so on a real ledger every version above v1 arrives
       * as a pair. One rung per version, not two: the proposal contributes the
       * document and the promotion contributes why it happened, and a rail that
       * pushed both would double every step of the scrubber.
       */
      const proposal = state.rail.at(-1);
      if (
        proposal !== undefined &&
        proposal.kind === 'version' &&
        proposal.version === event.payload.version &&
        proposal.planHash === event.payload.toHash
      ) {
        state.rail[state.rail.length - 1] = {
          ...proposal,
          decision: event.payload.decision.decision,
          by: event.payload.decision.by,
          rule: event.payload.decision.rule ?? null,
          reason: held?.reason ?? 'the proposal for this patch is not in this window',
          patchId: event.payload.patchId,
          proposedBy:
            event.payload.proposedBy === undefined
              ? (held?.proposedBy ?? proposal.proposedBy)
              : String(event.payload.proposedBy),
        };
        // `planVersionSeq` keeps the *proposal's* seq, which is the number the
        // daemon's own `GET /api/runs/:id/plans` reports for the version
        // (`min(seq)` over `plan.proposed`). Two rails naming two different
        // seqs for one version is how a scrubber and a snapshot request end up
        // one event apart.
        return;
      }

      // No proposal in this window — an older ledger, or a tab that joined
      // mid-run. The ops are then the only description of the successor there
      // is, so they are applied, and the row says the reason is missing rather
      // than leaving the cell blank: a hole the operator can see is worth more
      // than one they cannot.
      if (held !== undefined) for (const op of held.ops) applyOp(state.nodes, op);
      state.planVersionSeq.set(event.payload.version, event.seq);
      state.rail.push({
        kind: 'version',
        version: event.payload.version,
        seq: event.seq,
        planHash: event.payload.toHash,
        decision: event.payload.decision.decision,
        by: event.payload.decision.by,
        rule: event.payload.decision.rule ?? null,
        reason: held?.reason ?? 'the proposal for this patch is not in this window',
        patchId: event.payload.patchId,
        proposedBy:
          event.payload.proposedBy === undefined
            ? (held?.proposedBy ?? null)
            : String(event.payload.proposedBy),
        nodes: hashNodes(state.nodes),
      });
      return;
    }

    case 'plan.patch.rejected': {
      const held = state.proposals.get(event.payload.patchId);
      state.rail.push({
        kind: 'rejected',
        seq: event.seq,
        patchId: event.payload.patchId,
        rule: event.payload.rule,
        by: event.payload.by,
        reason: held?.reason ?? 'the proposal for this patch is not in this window',
        proposedBy: held?.proposedBy ?? null,
        diagnostics: (event.payload.diagnostics ?? []).map(
          (one) => `${one.code} ${one.node}: ${one.message}`,
        ),
      });
      return;
    }

    case 'plan.patch.queued': {
      const held = state.proposals.get(event.payload.patchId);
      state.rail.push({
        kind: 'queued',
        seq: event.seq,
        patchId: event.payload.patchId,
        rule: event.payload.rule,
        reason: held?.reason ?? 'the proposal for this patch is not in this window',
        costUsdDelta: event.payload.estimate.costUsdDelta,
        blastRadiusFiles: event.payload.estimate.blastRadiusFiles,
        maxPermission: event.payload.estimate.maxPermission,
        replanDepth: event.payload.estimate.replanDepth,
      });
      return;
    }

    case 'plan.validation_failed': {
      state.rail.push({
        kind: 'invalid',
        seq: event.seq,
        version: event.payload.version,
        planHash: event.payload.planHash,
        attempt: event.payload.attempt,
        diagnostics: event.payload.diagnostics.map(
          (one) => `${one.code} ${one.node}: ${one.message}`,
        ),
      });
      return;
    }

    default:
      ignored<'planHistory'>(event as Ignorable<'planHistory'>);
      return;
  }
}

// ── the node set per version ─────────────────────────────────────────────────

/** The fields the scrubber highlights a change in. */
export interface NodeDocument {
  readonly id: string;
  readonly type?: string;
  readonly permission?: string;
  readonly brief?: string;
  readonly reads?: unknown;
  readonly writes?: unknown;
  readonly retry?: unknown;
  readonly provider?: { readonly prefer: readonly string[] };
  readonly model?: string;
}

type PatchOpShape =
  | { readonly op: 'insert-nodes'; readonly nodes: readonly NodeDocument[] }
  | { readonly op: 'split-node'; readonly node: string; readonly into: readonly NodeDocument[] }
  | {
      readonly op: 'replace-provider';
      readonly node: string;
      readonly provider: string;
      readonly model?: string;
    }
  | { readonly op: 'extend-loop'; readonly node: string }
  | { readonly op: 'abandon-branch'; readonly root: string };

function applyOp(nodes: Map<string, NodeDocument>, op: PatchOpShape): void {
  switch (op.op) {
    case 'insert-nodes':
      for (const node of op.nodes) nodes.set(node.id, node);
      return;
    case 'split-node':
      nodes.delete(op.node);
      for (const node of op.into) nodes.set(node.id, node);
      return;
    case 'replace-provider': {
      const node = nodes.get(op.node);
      if (node === undefined) return;
      nodes.set(op.node, {
        ...node,
        provider: { prefer: [op.provider] },
        ...(op.model === undefined ? {} : { model: op.model }),
      });
      return;
    }
    case 'extend-loop':
      return;
    case 'abandon-branch':
      nodes.delete(op.root);
      return;
  }
}

function hashNodes(nodes: ReadonlyMap<string, NodeDocument>): ReadonlyMap<string, string> {
  return new Map([...nodes].map(([id, node]) => [id, contentHash(node)]));
}

/**
 * A change-detection hash over the fields F2.5's scrubber highlights.
 *
 * FNV-1a over `canonicalJson`, and both halves are deliberate. `canonicalJson`
 * is the project's own stable encoder — `JSON.stringify` orders keys by
 * insertion, so two structurally identical nodes built by different code paths
 * hash differently and every version looks changed. FNV-1a rather than sha256
 * because a projection is synchronous and `crypto.subtle` is not, and because
 * this value must never be mistaken for an identity: the `h-` prefix is there
 * so that a hash which leaked into a key or a URL is obvious on sight.
 */
export function contentHash(node: NodeDocument): string {
  const material = canonicalJson({
    type: node.type ?? null,
    provider: node.provider?.prefer ?? null,
    model: node.model ?? null,
    permission: node.permission ?? null,
    brief: node.brief ?? null,
    reads: node.reads ?? null,
    writes: node.writes ?? null,
    retry: node.retry ?? null,
  });

  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < material.length; index += 1) {
    hash ^= material.charCodeAt(index);
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return `h-${hash.toString(16).padStart(8, '0')}`;
}
