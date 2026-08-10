/**
 * KAR-16.3 — `plan.ts`: the node and edge view-models behind F10.1
 * (docs/12-frontend-architecture.md §3.3).
 *
 * Verifies: EPIC-16-S16, EPIC-16-S23 · AC3, AC10, AC11
 *
 * Nothing here imports `vue`. No `ref`, no `reactive`, no `computed`, no
 * component — that is what lets the whole of it be exercised in Vitest's node
 * environment in milliseconds, and it is checked rather than trusted by
 * `./purity.test.ts`.
 *
 * ## The seven states are a mapping, not a switch
 *
 * `PlanNodeVM.state` is never assigned a literal. It is derived from the two
 * facts the ledger actually carries — the domain `NodeStatus` the last
 * lifecycle event implied, and whether a patch has abandoned the node — through
 * `NODE_STATUS_DISPLAY`, which is a **total** `Record<NodeStatus, DisplayState>`
 * in `../../lib/state-palette.ts`. So the answer to "can this projection
 * produce an eighth state?" is no by construction rather than by test, and a
 * ninth domain status added in `@DeFlow/core` fails the build in the palette
 * rather than rendering as `pending` here.
 *
 * ## Why the patch ops arrive on a different event
 *
 * `plan.patched` carries `{ version, fromHash, toHash, patchId, decision }` and
 * **not** the patch. The ops live on `plan.patch.proposed`, because a proposal
 * is recorded whether or not it is ever applied (F2.4). So this projection holds
 * proposals by `patchId` and applies one when a `plan.patched` names it: "which
 * node did this patch abandon" is otherwise unanswerable from the ledger alone,
 * and a view that guessed would be inventing history.
 *
 * ## Idempotency is a per-projection seq guard
 *
 * Subscribe-backfill legitimately re-sends events at or below the client's
 * cursor (docs/11 §5), so applying the same envelope twice must change nothing.
 * The guard is the highest `seq` *this projection* has folded, and never a
 * global dedupe set — that is unbounded memory, which is exactly what KAR-16.4
 * exists to prevent.
 */
import type { Event, NodeLifecycle, NodeStatus } from '@DeFlow/core';
import { type DisplayState, NODE_STATUS_DISPLAY } from '../../lib/state-palette.ts';
import { type Ignorable, ignored } from './kinds.ts';

/** What ran a node's attempt, as `node.started` records it. */
export interface NodeBinaryVM {
  readonly path: string;
  readonly version: string;
  readonly sha256: string;
}

export interface NodeFailureVM {
  readonly reason: string;
  readonly class: string;
  readonly message: string;
  readonly attempt: number;
  readonly evidence: readonly string[];
}

export interface NodeBlockedVM {
  readonly conflictsWith: string;
  readonly branch: string;
  readonly otherBranch: string;
  readonly paths: readonly string[];
}

export interface NodeRetryVM {
  readonly nextAttempt: number;
  /** ms epoch — an instant, so it survives a restart that outlives the timer. */
  readonly wakeAt: number;
}

export interface PlanNodeVM {
  readonly id: string;
  title: string;
  /** `null` until a plan document has been seen naming this node. */
  type: string | null;
  /** `active | superseded | abandoned` — the plan's word, not the palette's. */
  lifecycle: NodeLifecycle;
  /** The domain status the last lifecycle event implied. */
  status: NodeStatus;
  /** `NODE_STATUS_DISPLAY[status]`, or `abandoned`. Never assigned directly. */
  state: DisplayState;
  provider: string | null;
  model: string | null;
  permission: string | null;
  worktree: string | null;
  binary: NodeBinaryVM | null;
  attempt: number;
  /** The live phase from `node.progress`. Not a state. */
  phase: string | null;
  progressMessage: string | null;
  failure: NodeFailureVM | null;
  suspendedUntil: { readonly kind: string; readonly wakeAt?: string | undefined } | null;
  blocked: NodeBlockedVM | null;
  retry: NodeRetryVM | null;
  /** Why the node never began, when it never could (`node.unschedulable`). */
  unschedulable: { readonly provider: string; readonly reason: string } | null;
}

export interface PlanEdgeVM {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly kind: 'control' | 'data';
  /** F10.1: what flows across it. `[]` for a control edge, never `undefined`. */
  readonly carries: readonly string[];
}

/** One patch proposal, held until a `plan.patched` names it. */
interface HeldProposal {
  readonly patchId: string;
  readonly reason: string;
  readonly ops: readonly PatchOpShape[];
}

export interface PlanProjection {
  /** The highest `seq` folded. The idempotency guard, per projection. */
  appliedSeq: number;
  version: number;
  planHash: string | null;
  nodes: Map<string, PlanNodeVM>;
  edges: Map<string, PlanEdgeVM>;
  /** `patchId` → the ops that patch carries, from `plan.patch.proposed`. */
  proposals: Map<string, HeldProposal>;
}

export function emptyPlan(): PlanProjection {
  return {
    appliedSeq: 0,
    version: 0,
    planHash: null,
    nodes: new Map(),
    edges: new Map(),
    proposals: new Map(),
  };
}

export const edgeId = (from: string, to: string, kind: string): string => `${from}→${to}:${kind}`;

/**
 * Folds one event into `state`.
 *
 * Mutates in place and returns nothing — the store swaps the container and
 * bumps a counter (docs/12 §3.3 rule 3), so a projection that returned a new
 * object every event would allocate a graph per frame on a chatty run.
 */
export function applyPlan(state: PlanProjection, event: Event): void {
  // Strictly greater than what this projection has folded. Not `previous + 1`:
  // `4, 5, 7` is a healthy log (docs/11 §4.2).
  if (event.seq <= state.appliedSeq) return;
  state.appliedSeq = event.seq;

  switch (event.kind) {
    case 'plan.proposed': {
      absorbGraph(state, event.payload.graph);
      state.version = event.payload.version;
      state.planHash = event.payload.planHash;
      return;
    }

    case 'plan.patch.proposed': {
      const patch = event.payload.patch;
      state.proposals.set(patch.id, {
        patchId: patch.id,
        reason: patch.reason,
        ops: patch.ops as readonly PatchOpShape[],
      });
      return;
    }

    case 'plan.patched': {
      state.version = event.payload.version;
      state.planHash = event.payload.toHash;
      const held = state.proposals.get(event.payload.patchId);
      if (held !== undefined) for (const op of held.ops) applyOp(state, op);
      return;
    }

    case 'node.scheduled': {
      const node = upsert(state, event.payload.node);
      node.provider = event.payload.provider;
      node.model = event.payload.model ?? null;
      node.permission = event.payload.permission;
      node.worktree = event.payload.worktree ?? null;
      restate(node, 'scheduled');
      return;
    }

    case 'node.started': {
      const node = upsert(state, event.payload.node);
      node.attempt = event.payload.attempt;
      node.binary = event.payload.binary;
      // A started attempt is no longer waiting on the thing that suspended it,
      // and a stale `suspendedUntil` beside a `running` chip is the kind of
      // disagreement an operator reads as a bug in the run.
      node.suspendedUntil = null;
      restate(node, 'running');
      return;
    }

    case 'node.progress': {
      const node = upsert(state, event.payload.node);
      node.phase = event.payload.phase;
      node.progressMessage = event.payload.message ?? null;
      // Deliberately no `restate`. See the module note.
      return;
    }

    case 'node.completed': {
      const node = upsert(state, event.payload.node);
      node.attempt = event.payload.attempt;
      restate(node, 'completed');
      return;
    }

    case 'node.failed': {
      const node = upsert(state, event.payload.node);
      node.attempt = event.payload.attempt;
      node.failure = {
        reason: event.payload.failure.reason,
        class: event.payload.failure.class,
        message: event.payload.failure.message,
        attempt: event.payload.failure.attempt,
        evidence: [...event.payload.failure.evidence],
      };
      restate(node, 'failed');
      return;
    }

    case 'node.retry.scheduled': {
      const node = upsert(state, event.payload.node);
      node.retry = { nextAttempt: event.payload.nextAttempt, wakeAt: event.payload.wakeAt };
      restate(node, 'awaiting-retry');
      return;
    }

    case 'node.suspended': {
      const node = upsert(state, event.payload.node);
      node.suspendedUntil = event.payload.until;
      restate(node, 'suspended');
      return;
    }

    case 'node.blocked': {
      const node = upsert(state, event.payload.node);
      node.blocked = {
        conflictsWith: event.payload.conflictsWith,
        branch: event.payload.branch,
        otherBranch: event.payload.otherBranch,
        paths: [...event.payload.paths],
      };
      restate(node, 'blocked');
      return;
    }

    case 'node.unschedulable': {
      const node = upsert(state, event.payload.node);
      node.unschedulable = { provider: event.payload.provider, reason: event.payload.reason };
      // Never began rather than ended: `blocked` is the honest chip, and the
      // inspector is where "which capability bit" is answered.
      restate(node, 'blocked');
      return;
    }

    case 'node.cancelled': {
      const node = upsert(state, event.payload.node);
      restate(node, 'cancelled');
      return;
    }

    default:
      // Unknown kinds are ignored, exactly as the backend reducer ignores them
      // (docs/11 §3.2). The type parameter is what makes a kind this module
      // *claims* and forgot to handle a compile error — see ./kinds.ts.
      ignored<'plan'>(event as Ignorable<'plan'>);
      return;
  }
}

// ── the plan document ────────────────────────────────────────────────────────

interface GraphNodeShape {
  readonly id: string;
  readonly title: string;
  readonly type: string;
  readonly deps: readonly string[];
  readonly lifecycle: NodeLifecycle;
  readonly permission?: string | undefined;
  readonly provider?: { readonly prefer: readonly string[] } | undefined;
  readonly model?: string | undefined;
}

interface GraphEdgeShape {
  readonly from: string;
  readonly to: string;
  readonly kind: 'control' | 'data';
  readonly carries?: readonly string[] | undefined;
}

interface GraphShape {
  readonly nodes: readonly GraphNodeShape[];
  readonly edges: readonly GraphEdgeShape[];
}

function absorbGraph(state: PlanProjection, graph: GraphShape): void {
  for (const node of graph.nodes) {
    const vm = upsert(state, node.id);
    vm.title = node.title;
    vm.type = node.type;
    vm.lifecycle = node.lifecycle;
    // The plan's *intent* about the provider, which the scheduler resolves
    // later: `node.scheduled` overwrites it with what was actually chosen, and
    // until then "prefers claude-code" is better than a blank cell.
    vm.provider ??= node.provider?.prefer[0] ?? null;
    vm.model ??= node.model ?? null;
    vm.permission ??= node.permission ?? null;
    restate(vm, vm.status);
  }

  for (const edge of graph.edges) {
    const id = edgeId(edge.from, edge.to, edge.kind);
    state.edges.set(id, {
      id,
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      carries: [...(edge.carries ?? [])],
    });
  }
}

// ── patch ops ────────────────────────────────────────────────────────────────

type PatchOpShape =
  | {
      readonly op: 'insert-nodes';
      readonly nodes: readonly GraphNodeShape[];
      readonly edges: readonly GraphEdgeShape[];
    }
  | {
      readonly op: 'split-node';
      readonly node: string;
      readonly into: readonly GraphNodeShape[];
      readonly edges: readonly GraphEdgeShape[];
    }
  | {
      readonly op: 'replace-provider';
      readonly node: string;
      readonly provider: string;
      readonly model?: string | undefined;
    }
  | { readonly op: 'extend-loop'; readonly node: string }
  | { readonly op: 'abandon-branch'; readonly root: string; readonly reason: string };

function applyOp(state: PlanProjection, op: PatchOpShape): void {
  switch (op.op) {
    case 'insert-nodes':
      absorbGraph(state, { nodes: op.nodes, edges: op.edges });
      return;

    case 'split-node': {
      absorbGraph(state, { nodes: op.into, edges: op.edges });
      // The node that was split is gone as work, and it is *abandoned* rather
      // than deleted: the scrubber animates a split as a split, and a node that
      // vanished from the map cannot be animated into anything.
      abandon(state, op.node);
      return;
    }

    case 'replace-provider': {
      const node = state.nodes.get(op.node);
      if (node === undefined) return;
      node.provider = op.provider;
      node.model = op.model ?? null;
      return;
    }

    case 'extend-loop':
      return;

    case 'abandon-branch': {
      for (const id of branchFrom(state, op.root)) abandon(state, id);
      return;
    }
  }
}

/** `root` and everything downstream of it, by the edges the plan declares. */
function branchFrom(state: PlanProjection, root: string): Set<string> {
  const reached = new Set<string>([root]);
  const queue = [root];
  while (queue.length > 0) {
    const from = queue.shift();
    if (from === undefined) continue;
    for (const edge of state.edges.values()) {
      if (edge.from !== from || reached.has(edge.to)) continue;
      reached.add(edge.to);
      queue.push(edge.to);
    }
  }
  return reached;
}

function abandon(state: PlanProjection, id: string): void {
  const node = state.nodes.get(id);
  if (node === undefined) return;
  node.lifecycle = 'abandoned';
  restate(node, node.status);
}

// ── node view-models ─────────────────────────────────────────────────────────

function upsert(state: PlanProjection, id: string): PlanNodeVM {
  const held = state.nodes.get(id);
  if (held !== undefined) return held;

  const fresh: PlanNodeVM = {
    id,
    title: id,
    type: null,
    lifecycle: 'active',
    status: 'scheduled',
    state: NODE_STATUS_DISPLAY.scheduled,
    provider: null,
    model: null,
    permission: null,
    worktree: null,
    binary: null,
    attempt: 0,
    phase: null,
    progressMessage: null,
    failure: null,
    suspendedUntil: null,
    blocked: null,
    retry: null,
    unschedulable: null,
  };
  state.nodes.set(id, fresh);
  return fresh;
}

/**
 * The only writer of `state`.
 *
 * `abandoned` wins over every status, because it is a statement about the plan
 * rather than about the attempt: a node abandoned by a patch after it failed
 * renders as abandoned, and an operator reading the board is told "we stopped
 * doing this" rather than "the agent broke".
 */
function restate(node: PlanNodeVM, status: NodeStatus): void {
  node.status = status;
  node.state = node.lifecycle === 'abandoned' ? 'abandoned' : NODE_STATUS_DISPLAY[status];
}
