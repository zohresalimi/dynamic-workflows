/**
 * KAR-07.7 — the conflict resolution node, and the two-segment packet that is
 * the whole reason it is affordable
 * (docs/09-workspace-and-safety.md §7.2; AC5).
 *
 * §7.2 in one sentence: *never let an agent auto-resolve blind, and never hand
 * a resolver the whole repository*. Both halves are structural here rather
 * than advisory.
 *
 * **Never blind** is the intent summaries. A text-only merge tool can see two
 * versions of a hunk and nothing about why either exists; a resolver that has
 * both sides' stated intent is answering "which of these two goals wins here,
 * and how" instead of "which of these two strings looks newer". Those
 * summaries exist only because the blackboard retained intent, which is what
 * makes this node shape possible at all — and this module *requires* exactly
 * two of them rather than accepting whatever the caller has, because a
 * resolution packet missing one side is the blind case wearing the safe case's
 * shape.
 *
 * **Never the whole repository** is the segment set. The packet is built from
 * the `merge-tree` output (../workspace/conflict-hunks.ts) and from the
 * blackboard, and never from the integration worktree — so "the packet
 * contains no file that was not conflicted" is a property of where the bytes
 * came from, not of a filter that a later refactor could widen. Two segment
 * kinds, `tool.output` for the hunks (they are literally the output of a
 * tool — `git merge-tree`) and `fact` for the intent summaries (they are
 * blackboard facts), and the unit spec asserts there is never a third.
 *
 * **Placement travels beside the node, not inside it.** §7.2 requires the
 * resolver to run *on the integration worktree*, and `PlanNode` (§3.1) has no
 * cwd — a node's working directory is the workspace layer's business, which is
 * this layer. So `cwd` is a field of the spec this module returns, and the
 * scheduler takes it from here rather than deriving `.DeFlow/wt/<runId>__<id>`
 * as it would for an ordinary node.
 *
 * Verifies: EPIC-07-S27 · AC5
 */
import {
  type ContextPacket,
  ContextPacketSchema,
  contentHash,
  type PlanNode,
  type PlanPatch,
  PlanPatchSchema,
  SEGMENT_KINDS,
  type SegmentKind,
  sha256Hex,
} from '@DeFlow/core';
import type { ConflictedFile } from './conflict-hunks.ts';

/** §7.2's "exactly two", named so the assertion and the builder read the same
 * list. Order is the order the resolver sees them in: what conflicted first,
 * then why each side wanted it. */
export const RESOLUTION_SEGMENT_KINDS: readonly SegmentKind[] = ['tool.output', 'fact'];

/** A node's stated intent, as retained on the blackboard. */
export interface IntentSummary {
  readonly nodeId: string;
  readonly text: string;
  /** The `EventSeq` this summary was read from — the packet's click-through
   * (F10.3), and the reason a segment is attributable at all. */
  readonly sourceEvent: number;
}

export interface ResolutionRequest {
  readonly runId: string;
  /** The node whose branch would not merge. */
  readonly nodeId: string;
  readonly branch: string;
  readonly integrationBranch: string;
  /** §7.2: the integration worktree. */
  readonly cwd: string;
  readonly conflicts: readonly ConflictedFile[];
  /** Exactly two: this branch's intent, and the already-merged counterpart's. */
  readonly intents: readonly IntentSummary[];
  readonly builtAtEvent: number;
  readonly target: {
    readonly provider: string;
    readonly model: string;
    readonly maxContext: number;
  };
  readonly budgetLimitTokens: number;
  /** The policy engine's inputs (F2.5). Supplied by the caller that has the
   * estimator; nothing here invents a number a rule would then be judged on. */
  readonly estimate: { readonly costUsd: number; readonly wallClockMs: number };
  readonly replanDepth: number;
}

export interface ResolutionNodeSpec {
  readonly node: PlanNode;
  readonly patch: PlanPatch;
  readonly packet: ContextPacket;
  /** Where the node runs. See the module note. */
  readonly cwd: string;
}

/** The resolution node's id, derived so that the same conflict proposes the
 * same id twice rather than two nodes. */
export function resolutionNodeId(nodeId: string): string {
  return `merge-resolve-${nodeId}`;
}

/** The `heuristic` method of `TokenCount` — four characters to a token. It is
 * an estimate and it says so; the vendor's own count replaces it once a turn
 * has actually run. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const emptyByKind = (): Record<SegmentKind, number> =>
  Object.fromEntries(SEGMENT_KINDS.map((kind) => [kind, 0])) as Record<SegmentKind, number>;

interface DraftSegment {
  readonly id: string;
  readonly kind: SegmentKind;
  readonly sourceEvent: number;
  readonly text: string;
}

/** One conflicted file, rendered as the resolver reads it: the path, then each
 * region git could not merge. Nothing between the regions — that is the whole
 * economy of this node shape. */
function hunkText(file: ConflictedFile): string {
  return [file.path, ...file.hunks].join('\n');
}

function intentText(intent: IntentSummary): string {
  return `${intent.nodeId} intended: ${intent.text}`;
}

function draftSegments(request: ResolutionRequest, conflictEvent: number): DraftSegment[] {
  const hunks = request.conflicts.map(
    (file, index): DraftSegment => ({
      id: `conflict-${index + 1}`,
      kind: 'tool.output',
      sourceEvent: conflictEvent,
      text: hunkText(file),
    }),
  );
  const intents = request.intents.map(
    (intent, index): DraftSegment => ({
      id: `intent-${index + 1}`,
      kind: 'fact',
      sourceEvent: intent.sourceEvent,
      text: intentText(intent),
    }),
  );
  return [...hunks, ...intents];
}

function brief(request: ResolutionRequest, paths: readonly string[]): string {
  return (
    `Resolve the merge conflict between ${request.branch} and ${request.integrationBranch} in ` +
    `${paths.join(', ')}. Every conflicted region is in this packet, together with what each ` +
    'side was trying to achieve. Rewrite each region so both intents survive where they can and ' +
    'the loser is stated where they cannot; leave no conflict marker behind. Do not read or ' +
    'change any other file.'
  );
}

function resolutionAgentNode(
  request: ResolutionRequest,
  paths: readonly string[],
): Record<string, unknown> {
  return {
    id: resolutionNodeId(request.nodeId),
    title: `Resolve ${request.branch} into ${request.integrationBranch}`,
    type: 'agent',
    deps: [],
    lifecycle: 'active',
    reads: [],
    writes: [],
    // §7.2: the resolver edits files in one worktree and needs nothing else.
    permission: 'worktree',
    pathScopes: { write: [...paths], read: [...paths] },
    returns: { schemaId: 'DeFlow.finding.v1' },
    brief: brief(request, paths),
    provider: { prefer: [request.target.provider], requires: [] },
    model: request.target.model,
    resume: 'always-replay',
  };
}

/**
 * AC5 — the patch, the node and the packet for one conflicted merge.
 *
 * Async because every segment carries a `contentHash` and the packet a handle
 * for the rendered prompt, and hashing is the one thing here that is not pure
 * arithmetic.
 */
export async function resolutionNode(request: ResolutionRequest): Promise<ResolutionNodeSpec> {
  if (request.conflicts.length === 0) {
    throw new Error(
      `no conflicts to resolve between ${request.branch} and ${request.integrationBranch}: a ` +
        'resolution node with nothing to resolve is a paid turn that can only do harm',
    );
  }
  if (request.intents.length !== 2) {
    throw new Error(
      `a resolution packet needs exactly two intent summaries (got ${request.intents.length}): ` +
        'one side without its intent is the blind resolution §7.2 forbids, wearing the safe ' +
        "case's shape",
    );
  }

  const paths = request.conflicts.map((file) => file.path);
  const drafts = draftSegments(request, request.builtAtEvent);

  const segments = await Promise.all(
    drafts.map(async (draft) => ({
      id: draft.id,
      kind: draft.kind,
      sourceEvent: draft.sourceEvent,
      contentHash: await contentHash(draft.text),
      tokens: { estimated: estimateTokens(draft.text), method: 'heuristic' as const },
      // Nothing in a packet this small is a compaction candidate, and nothing
      // is pinned either: pinning is for spec and constraint segments that
      // must survive compaction, and there is no compaction to survive here.
      pinned: false,
      compactable: false,
      text: draft.text,
    })),
  );

  const rendered = drafts.map((draft) => draft.text).join('\n\n');
  const byKind = emptyByKind();
  for (const segment of segments) byKind[segment.kind] += segment.tokens.estimated;

  const packet = ContextPacketSchema.parse({
    schemaId: 'DeFlow.contextpacket.v1',
    runId: request.runId,
    nodeId: resolutionNodeId(request.nodeId),
    attempt: 1,
    builtAtEvent: request.builtAtEvent,
    target: {
      provider: request.target.provider,
      model: request.target.model,
      maxContext: request.target.maxContext,
    },
    budget: { limitTokens: request.budgetLimitTokens },
    totals: {
      tokens: segments.reduce((sum, segment) => sum + segment.tokens.estimated, 0),
      byKind,
    },
    renderedPromptHandle: `artifact://${await sha256Hex(rendered)}`,
    pinnedDigests: [],
    segments,
  });

  const node = resolutionAgentNode(request, paths);
  const patch = PlanPatchSchema.parse({
    schemaId: 'DeFlow.planpatch.v1',
    id: `merge-conflict-${request.runId}-${request.nodeId}`,
    proposedBy: 'scheduler',
    reason:
      `merging ${request.branch} into ${request.integrationBranch} conflicts on ` +
      `${paths.join(', ')}; inserting a resolution node scoped to those paths`,
    ops: [{ op: 'insert-nodes', nodes: [node], edges: [] }],
    policy: {
      estimatedCostDeltaUsd: request.estimate.costUsd,
      estimatedWallClockDeltaMs: request.estimate.wallClockMs,
      blastRadius: { paths: [...paths], nodeCount: 1 },
      replanDepth: request.replanDepth,
      // A fresh node, not a change to an existing one: there is no `from`
      // level for this to have escalated from (KAR-02.4 AC1).
      escalatesPermission: null,
      addsWriteCapability: true,
    },
  });

  const inserted = patch.ops[0];
  if (inserted?.op !== 'insert-nodes' || inserted.nodes[0] === undefined) {
    throw new Error('resolution patch lost its inserted node');
  }

  return { node: inserted.nodes[0], patch, packet, cwd: request.cwd };
}
