/**
 * KAR-13.2 — the cross-run approval queue, as a pure projection
 * (docs/11-api-and-realtime.md §6, docs/06-planning-and-replanning.md §4.3).
 *
 * `GET /api/approvals` is one call over every run with something pending, and
 * the queue behind it is **derived, never accumulated**. That is not purity for
 * its own sake; it is the only way it can be correct. An in-memory pending map
 * evaporates on restart, and the first thing that happens after a restart is
 * that several runs resume at once — precisely when the queue matters most. It
 * is also NF10: every row must be traceable to the event that created it, which
 * is why every item here carries that event's `seq` and nothing here invents
 * one.
 *
 * Eight things can wait on a human and the queue is not useful unless it
 * carries all of them, so this file is a union of eight item shapes rather than
 * a list of `{ runId, nodeId }` links. *"Enough to decide without a second
 * request"* is the acceptance criterion (AC2), and a queue of links is a queue
 * that costs eight round trips to read.
 *
 * **Three sources, one shape.** Five kinds fold out of `RunState`; the patch
 * queue and the tainted-read list are projections of their own — over the
 * ledger (`pendingPatchApprovals`) and over the blackboard tables
 * (`readTaintedNodes`) — and are passed in rather than recomputed here, because
 * `@DeFlow/core` performs no I/O (docs/16-repo-layout.md R1). All three derive
 * from the same log, so deleting every cache and replaying from seq 0 produces
 * an identical queue (AC3).
 *
 * **Ordering is by `seq`, oldest first**, for the reason everything else in the
 * system orders by `seq`: it is the total order and the wall clock is not
 * monotone. Oldest-first is deliberate — the item that has been blocking
 * longest is the one costing the most.
 *
 * Verifies: EPIC-13-S10, EPIC-13-S11, EPIC-13-S15 · AC1, AC2, AC3, AC9
 */
import type { PermissionContext, RecordedPermissionReason } from './event-payloads.ts';
import { openHumanGates } from './human-gate.ts';
import type { FactId, GateId, NodeId, RunId } from './ids.ts';
import type { CompletedAttempt } from './no-progress.ts';
import type { BudgetBreach } from './node-failure.ts';
import type { HumanDeadline, HumanOption, PermissionLevel } from './plan-graph.ts';
import type { PatchOp } from './plan-patch.ts';
import type { RunState } from './run-state.ts';
import { toSingleLine } from './text.ts';
import type { FindingV2 } from './verdict.ts';

/** The eight things that can wait on a human (the epic's own table). */
export const APPROVAL_KINDS = [
  'human-node',
  'patch',
  'gate-needs-human',
  'reconcile-unknown',
  'budget',
  'churn',
  'tainted',
  'permission',
] as const;

export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

/** What every row carries, whatever it is about. */
export interface ApprovalItemBase {
  readonly runId: RunId;
  readonly kind: ApprovalKind;
  /**
   * The node the row deep-links to, or `null` for a run-level item — a budget
   * ceiling and a churn trip are facts about the run, and naming a node for
   * them would send the inspector somewhere the decision is not.
   */
  readonly node: NodeId | null;
  /** One line for the row. Never the evidence: the payload below is that. */
  readonly summary: string;
  /**
   * The `seq` of the event that created the item. The queue's order, and F10.3's
   * deep link — click a row and land on the event that put it there (NF10).
   */
  readonly seq: number;
}

export interface HumanNodeApproval extends ApprovalItemBase {
  readonly kind: 'human-node';
  readonly prompt: string;
  readonly options: readonly HumanOption[];
  readonly deadline: HumanDeadline | null;
  /** True when a `deadline.onTimeout: 'escalate'` has already re-asked. */
  readonly escalated: boolean;
}

export interface PermissionApproval extends ApprovalItemBase {
  readonly kind: 'permission';
  readonly prompt: string;
  readonly options: readonly HumanOption[];
  readonly deadline: HumanDeadline | null;
  /** The category the queue groups by; never `null` on this kind. */
  readonly reason: RecordedPermissionReason;
  /** The command, args, cwd, resolved path, matched rule and node scope —
   * `null` for a ledger written before the context existed (v3 and earlier). */
  readonly permission: PermissionContext | null;
}

/** The figures the rule table was applied to, as `plan.patch.queued` recorded
 * them — so an operator approves against the estimate that was actually ruled
 * on rather than one recomputed against a world that has moved. */
export interface QueuedPatchEstimate {
  readonly costUsdDelta: number | null;
  readonly blastRadiusFiles: number;
  readonly maxPermission: PermissionLevel;
  readonly replanDepth: number;
}

/**
 * A patch the run is waiting on a human about, as `@DeFlow/ledger`'s
 * `pendingPatchApprovals` projects it.
 *
 * Declared structurally rather than imported because the dependency runs the
 * other way: `@DeFlow/ledger` reads the log and `@DeFlow/core` performs no I/O,
 * so the ledger's row type is assignable to this and never the reverse.
 */
export interface QueuedPatch {
  readonly patchId: string;
  /** `queued` is waiting on a human; `rejected` was refused by a rule and may
   * still be approved by one — *"a rejection is a 'not without you', not a dead
   * end"* (06 §4.3). */
  readonly status: 'queued' | 'rejected';
  readonly rule: string;
  readonly patch: { readonly reason: string; readonly ops: readonly PatchOp[] };
  readonly estimate: QueuedPatchEstimate | null;
  /** The `seq` of `plan.patch.proposed` — the queue's order. */
  readonly proposedSeq: number;
  /** The `seq` of the ruling that queued or rejected it. */
  readonly decidedSeq: number;
}

export interface PatchApproval extends ApprovalItemBase {
  readonly kind: 'patch';
  readonly patchId: string;
  readonly status: 'queued' | 'rejected';
  /** The rule that queued or refused it. A decision with no named rule is
   * unanswerable, which is why it is never blank. */
  readonly rule: string;
  /** The finding that motivated the patch, from the proposal itself. */
  readonly reason: string;
  readonly estimate: QueuedPatchEstimate | null;
  /** The plan diff, as ops. What the operator is approving. */
  readonly ops: readonly PatchOp[];
  /** The `seq` of the ruling, for the timeline; the item's own `seq` is the
   * proposal's, because that is when the operator started waiting. */
  readonly decidedSeq: number;
}

export interface GateNeedsHumanApproval extends ApprovalItemBase {
  readonly kind: 'gate-needs-human';
  readonly gate: GateId;
  /** The verdict's one-line summary: why the gate could not tell. */
  readonly reason: string;
  readonly findings: readonly FindingV2[];
}

/** The two answers, and there is no third — see `RECONCILE_OPTIONS`. */
export const RECONCILE_OPTIONS: readonly HumanOption[] = Object.freeze([
  Object.freeze({ id: 'it-ran', label: 'It ran', effect: 'approve' as const }),
  Object.freeze({ id: 'it-did-not', label: 'It did not run', effect: 'reject' as const }),
]);

/**
 * What the operator is told before choosing, verbatim on the item.
 *
 * The warning is part of the payload rather than of the UI because it is the
 * whole reason this kind exists: *"there is no correct automatic action"*
 * (05 §9.3), and an operator shown two buttons without being told what each
 * risks is being asked to guess.
 */
export const RECONCILE_WARNING = toSingleLine(
  'nothing can tell whether this effect landed: answering "it ran" may drop work that never ' +
    'happened, and answering "it did not" retries work that may double-apply',
);

export interface ReconcileUnknownApproval extends ApprovalItemBase {
  readonly kind: 'reconcile-unknown';
  /** The effect row's identity, as the journal holds it. */
  readonly effect: {
    readonly ikey: string;
    readonly kind: string;
    readonly requestHash: string | null;
  };
  /** The reconciliation hashes: what was journalled either side, and what the
   * probe measured just now. `null` where nothing was journalled. */
  readonly hashes: {
    readonly before: string | null;
    readonly after: string | null;
    readonly observed: string | null;
  };
  readonly options: readonly HumanOption[];
  /** Always `null`: neither answer is preselected, because neither is safe. */
  readonly defaultOptionId: null;
  readonly warning: string;
}

export interface BudgetApproval extends ApprovalItemBase {
  readonly kind: 'budget';
  readonly scope: 'node' | 'run';
  readonly dimension: 'cost' | 'wallclock';
  readonly limit: number;
  readonly actual: number;
  /** Whose ceiling fired: DeFlow's own admission check, or the vendor's. */
  readonly firedBy: 'deflow' | 'vendor';
}

export interface ChurnApproval extends ApprovalItemBase {
  readonly kind: 'churn';
  readonly detail: string;
  /** The repeated `(node, requestHash)` the breaker tripped on, or `null` when
   * the window holds no repeat — a flat-replan trip has none. */
  readonly repeated: { readonly node: NodeId; readonly requestHash: string } | null;
  /** §11.3's sliding window itself, so the operator sees what was counted. */
  readonly window: readonly CompletedAttempt[];
}

export interface TaintedApproval extends ApprovalItemBase {
  readonly kind: 'tainted';
  readonly taint: 'stale-input';
  readonly factId: FactId;
  readonly key: string;
  /** Why the fact was invalidated. */
  readonly reason: string;
  /** When this node read it. Always strictly less than the item's `seq`. */
  readonly readAtSeq: number;
}

/** One node that read a fact which has since been invalidated, as
 * `@DeFlow/ledger`'s `readTaintedNodes` projects it. Structural, for the same
 * reason `QueuedPatch` is. */
export interface TaintedRead {
  readonly node: NodeId;
  readonly taint: 'stale-input';
  readonly factId: FactId;
  readonly key: string;
  readonly reason: string;
  /** The `fact.invalidated` event's seq. */
  readonly seq: number;
  readonly readAtSeq: number;
}

export type ApprovalItem =
  | HumanNodeApproval
  | PermissionApproval
  | PatchApproval
  | GateNeedsHumanApproval
  | ReconcileUnknownApproval
  | BudgetApproval
  | ChurnApproval
  | TaintedApproval;

/** One run's three sources, as the caller assembled them. */
export interface RunApprovals {
  readonly runId: RunId;
  readonly state: RunState;
  /** `pendingPatchApprovals(db, runId)`; omitted is "none". */
  readonly patches?: readonly QueuedPatch[] | undefined;
  /** `readTaintedNodes(db, runId)`; omitted is "none". */
  readonly taints?: readonly TaintedRead[] | undefined;
}

export interface ApprovalQueue {
  /** Every pending item across every run, oldest creating `seq` first. */
  readonly items: readonly ApprovalItem[];
  /** AC9 — per-run counts, so the run list renders a badge without a second
   * query. Runs with nothing pending do not appear. */
  readonly counts: Readonly<Record<string, number>>;
}

/** A run that has stopped is waiting on nobody, whatever it left behind. */
const OVER: readonly RunState['status'][] = ['completed', 'aborted'];

/**
 * The queue, across every run handed in.
 *
 * Total and pure: no clock (an item's age is the caller's join against the
 * event's `ts`, because a projection that read the clock would produce a
 * different answer on every replay), no I/O, no ordering that depends on a
 * `Map`'s insertion order.
 */
export function approvalsProjection(runs: readonly RunApprovals[]): ApprovalQueue {
  const items = runs.flatMap((run) => (OVER.includes(run.state.status) ? [] : itemsOf(run)));
  const sorted = items.toSorted((left, right) => left.seq - right.seq);

  const counts: Record<string, number> = {};
  for (const item of sorted) counts[item.runId] = (counts[item.runId] ?? 0) + 1;

  return { items: sorted, counts };
}

function itemsOf(run: RunApprovals): readonly ApprovalItem[] {
  return [
    ...humanItems(run),
    ...patchItems(run),
    ...gateItems(run),
    ...reconcileItems(run),
    ...budgetItems(run),
    ...churnItems(run),
    ...taintItems(run),
  ];
}

/**
 * The `human-node` and `permission` kinds, which are one fold and two shapes.
 *
 * A permission escalation *is* a `human` node — same suspension, same queue,
 * same `human.responded` — so it is the presence of a `PermissionReason` that
 * tells them apart and not a second event kind. Answering one is answering the
 * other, which is exactly the property that keeps KAR-13.4 from needing a
 * second respond path.
 */
function humanItems({ runId, state }: RunApprovals): readonly ApprovalItem[] {
  return openHumanGates(state).map((gate) => {
    const common = {
      runId,
      node: gate.node,
      seq: gate.requestedSeq,
      summary: toSingleLine(gate.prompt),
      prompt: gate.prompt,
      options: gate.options,
      deadline: gate.deadline,
    };
    return gate.reason === null
      ? ({ ...common, kind: 'human-node', escalated: gate.escalated } satisfies HumanNodeApproval)
      : ({
          ...common,
          kind: 'permission',
          reason: gate.reason,
          permission: gate.permission,
        } satisfies PermissionApproval);
  });
}

function patchItems({ runId, patches }: RunApprovals): readonly ApprovalItem[] {
  return (patches ?? []).map(
    (patch) =>
      ({
        runId,
        kind: 'patch',
        // A patch is about the plan rather than about one node: its ops may
        // touch several, and naming one of them would deep-link to a node the
        // decision is not about.
        node: null,
        seq: patch.proposedSeq,
        summary: toSingleLine(
          patch.status === 'rejected'
            ? `${patch.rule} refused this patch: ${patch.patch.reason}`
            : patch.patch.reason,
        ),
        patchId: patch.patchId,
        status: patch.status,
        rule: patch.rule,
        reason: patch.patch.reason,
        estimate: patch.estimate,
        ops: patch.patch.ops,
        decidedSeq: patch.decidedSeq,
      }) satisfies PatchApproval,
  );
}

function gateItems({ runId, state }: RunApprovals): readonly ApprovalItem[] {
  return Object.entries(state.gateVerdicts)
    .filter(([, verdict]) => verdict.outcome === 'needs-human')
    .map(
      ([node, verdict]) =>
        ({
          runId,
          kind: 'gate-needs-human',
          node: node as NodeId,
          seq: verdict.seq,
          summary: toSingleLine(`gate '${verdict.gate}' needs a human: ${verdict.summary}`),
          gate: verdict.gate,
          reason: verdict.summary,
          findings: verdict.findings,
        }) satisfies GateNeedsHumanApproval,
    );
}

/**
 * The one with no correct automatic answer (A1-5, 05 §9.3).
 *
 * Read off the node's own failure rather than off `run.needs_human`, because
 * the failure is where the evidence is: `escalateReconcileUnknown` writes both
 * in one transaction, and only one of them carries the effect row and the
 * hashes the decision turns on.
 */
function reconcileItems({ runId, state }: RunApprovals): readonly ApprovalItem[] {
  return Object.entries(state.nodes)
    .filter(([, node]) => node.failure?.reason === 'effect.reconcile-unknown')
    .map(([node, current]) => {
      const detail = (current.failure?.detail ?? {}) as Record<string, unknown>;
      return {
        runId,
        kind: 'reconcile-unknown',
        node: node as NodeId,
        // The `seq` of the event that moved this node last, which for a node in
        // a terminal `failed` status is its `node.failed`.
        seq: current.updatedSeq,
        summary: toSingleLine(current.failure?.message ?? 'reconcile returned unknown'),
        effect: {
          ikey: text(detail.ikey) ?? '',
          kind: text(detail.kind) ?? 'unknown',
          requestHash: text(detail.requestHash),
        },
        hashes: {
          before: text(detail.before),
          after: text(detail.after),
          observed: text(detail.observed),
        },
        options: RECONCILE_OPTIONS,
        defaultOptionId: null,
        warning: RECONCILE_WARNING,
      } satisfies ReconcileUnknownApproval;
    });
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * F4.6's ceilings, which **pause the run rather than failing it** — so the
 * decision is *raise the ceiling or stop*, and the breach stays in the queue
 * until a `budget.ceiling.set` answers it.
 *
 * Answered means "a ceiling was set after the breach was recorded", which is
 * what raising one looks like in the log. A breach with no `seq` came from a
 * ledger written before the field existed; it is listed rather than dropped,
 * because a queue that silently forgets a paused run is worse than one that
 * cannot deep-link a row.
 */
function budgetItems({ runId, state }: RunApprovals): readonly ApprovalItem[] {
  const answeredAt = state.ceilings.setSeq;
  return state.budget.breaches
    .filter((breach) => answeredAt === null || (breach.seq ?? 0) > answeredAt)
    .map(
      (breach) =>
        ({
          runId,
          kind: 'budget',
          node: breach.node ?? null,
          seq: breach.seq ?? 0,
          summary: budgetSummary(breach),
          scope: breach.scope,
          dimension: breach.dimension,
          limit: breach.limit,
          actual: breach.actual,
          firedBy: breach.firedBy ?? 'deflow',
        }) satisfies BudgetApproval,
    );
}

const budgetSummary = (breach: BudgetBreach): string =>
  toSingleLine(
    `${breach.scope} ${breach.dimension} ceiling exceeded: ${breach.actual} against a limit of ${breach.limit}`,
  );

/**
 * §11.3's circuit breaker, and only its `churn` reason.
 *
 * The other five `run.needs_human` reasons have their own kind in this queue —
 * a budget trip is a `budget` item, a reconcile ambiguity a `reconcile-unknown`
 * one, a refused patch the `patch` item with an approve button on it — and
 * listing them twice would double-count exactly the runs an operator is most
 * behind on.
 */
function churnItems({ runId, state }: RunApprovals): readonly ApprovalItem[] {
  const needs = state.needsHuman;
  if (needs === null || needs.reason !== 'churn') return [];

  return [
    {
      runId,
      kind: 'churn',
      node: null,
      seq: needs.seq,
      summary: toSingleLine(`the run is not getting anywhere on its own: ${needs.detail}`),
      detail: needs.detail,
      repeated: repeatedAttempt(state.churnWindow),
      window: state.churnWindow,
    } satisfies ChurnApproval,
  ];
}

/** The `(node, requestHash)` pair the window holds more than once, or `null`. */
function repeatedAttempt(
  window: readonly CompletedAttempt[],
): { readonly node: NodeId; readonly requestHash: string } | null {
  const seen = new Map<string, { node: NodeId; requestHash: string }>();
  for (const attempt of window) {
    if (attempt.requestHash === null) continue;
    const key = `${attempt.node} ${attempt.requestHash}`;
    const previous = seen.get(key);
    if (previous !== undefined) return previous;
    seen.set(key, { node: attempt.node, requestHash: attempt.requestHash });
  }
  return null;
}

/**
 * A node that consumed a fact which has since been invalidated.
 *
 * *"Automatic re-running on invalidation is a very efficient way to build a
 * loop that never terminates"* (06 §7), so this queue item **is** the entire
 * automatic response. Nothing here schedules anything.
 */
function taintItems({ runId, taints }: RunApprovals): readonly ApprovalItem[] {
  return (taints ?? []).map(
    (taint) =>
      ({
        runId,
        kind: 'tainted',
        node: taint.node,
        seq: taint.seq,
        summary: toSingleLine(
          `${taint.node} read '${taint.key}', which has since been invalidated: ${taint.reason}`,
        ),
        taint: taint.taint,
        factId: taint.factId,
        key: taint.key,
        reason: taint.reason,
        readAtSeq: taint.readAtSeq,
      }) satisfies TaintedApproval,
  );
}
