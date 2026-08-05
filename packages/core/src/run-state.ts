/**
 * KAR-03.5 — `RunState`, the value every view, gate and scheduler decision
 * reads (docs/05-durable-execution.md §3 primitive 2 and §4).
 *
 * It is a plain, deeply immutable object graph and nothing else: no class, no
 * `Map`, no `Set`, no `Date`. That is not stylistic. `RunState` is
 * `structuredClone`d into a checkpoint, `JSON.stringify`d into
 * `run.state_json`, diffed by a snapshot and sent over SSE, and every one of
 * those loses a `Map` silently — `JSON.stringify(new Map([['a',1]]))` is
 * `"{}"`, with no error anywhere. A repo write lock that evaporates into `{}`
 * on the way to disk is F5.2 broken in the one situation the lock exists for.
 *
 * Two conventions hold throughout:
 *
 * - **Absent is `null`, never `undefined`.** `exactOptionalPropertyTypes` makes
 *   the difference load-bearing, and `{ provider: undefined }` and `{}` are not
 *   the same object to `toEqual`, to a snapshot or to `JSON.stringify`.
 * - **Records, not maps**, keyed by a string the domain already owns, so the
 *   projection round-trips through JSON unchanged.
 *
 * The shape of this file is what `checkpoint_version` guards (KAR-03.6): a
 * field added or removed here invalidates every cached checkpoint, which is
 * exactly the intent — the cache is a pure optimisation and is allowed to be
 * thrown away, never to be wrong.
 */
import type { RunOutcome } from './event-payloads.ts';
import type { CriterionId, NodeId, PlanHash, ProviderId, RunId } from './ids.ts';
import type { NodeFailure } from './node-failure.ts';
import type { CompletedNodeResult, NodeSuspension } from './node-result.ts';
import type { PermissionLevel } from './plan-graph.ts';
import type { UsageTotals } from './token-usage.ts';

/**
 * The run's lifecycle, as the ledger can prove it.
 *
 * `paused` is here rather than as a boolean beside `running` because F4.4
 * requires pause to be an event: a flag does not survive the restart it exists
 * to protect against.
 */
export const RUN_STATUSES = [
  'created',
  'spec-approved',
  'running',
  'paused',
  'needs-human',
  'cancelling',
  'completed',
  'aborted',
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * A node's lifecycle within the current run.
 *
 * `awaiting-retry` is distinct from `failed` because the scheduler treats them
 * differently: one has a wake time and one is terminal for the attempt budget.
 */
export const NODE_STATUSES = [
  'scheduled',
  'running',
  'awaiting-retry',
  'suspended',
  'completed',
  'failed',
] as const;

export type NodeStatus = (typeof NODE_STATUSES)[number];

export interface NodeState {
  readonly status: NodeStatus;
  /** The highest attempt index observed for this node; 0-based, as §9's envelope is. */
  readonly attempt: number;
  /**
   * `attempt + 1`, monotone. Derived rather than counted so that a ledger
   * whose `node.started` was skipped — an older binary reading a newer
   * ledger — still cannot produce a node that completed without having run.
   */
  readonly attempts: number;
  readonly provider: ProviderId | null;
  readonly model: string | null;
  readonly permission: PermissionLevel | null;
  readonly result: CompletedNodeResult | null;
  readonly failure: NodeFailure | null;
  /** What a suspended node is waiting for; `null` unless `status` is `suspended`. */
  readonly suspension: NodeSuspension | null;
  /** ms epoch a retry or a wake is due at, from the event that scheduled it. */
  readonly wakeAt: number | null;
}

/**
 * One held lock. Keyed in `RunState.locks` by `${lock}:${key}` — the pair the
 * domain treats as the lock's identity (F5.2), so a repo lock and a worktree
 * lock over the same key are two locks.
 */
export interface LockState {
  readonly lock: 'repo' | 'worktree';
  readonly key: string;
  readonly node: NodeId;
  /** The `seq` of the `node.lock.acquired` that took it. */
  readonly sinceSeq: number;
}

/** The `key` a lock is held under in `RunState.locks`. */
export const lockKey = (lock: string, key: string): string => `${lock}:${key}`;

/**
 * The run-scoped `NodeId` registry of §1.1, as a value the ledger can rebuild.
 *
 * `retired` never shrinks: an id that leaves the active plan is retired
 * forever, including after the branch it belonged to was abandoned, because
 * the effect journal's idempotency key is `(runId, nodeId, attempt, ordinal)`
 * and a reused id hands a node a memoised result belonging to a different one.
 */
export interface NodeIdRegistryState {
  readonly active: readonly NodeId[];
  readonly retired: readonly NodeId[];
}

/** One F4.6 ceiling breach, kept because it pauses the run rather than failing it. */
export interface BudgetBreach {
  readonly scope: 'node' | 'run';
  readonly dimension: 'cost' | 'wallclock';
  readonly limit: number;
  readonly actual: number;
}

export interface BudgetState {
  readonly costUsd: number;
  /**
   * Vendor-reported and estimated totals, kept apart all the way to the chart
   * (§8). A single mixed number is not a slightly-wrong number, it is a number
   * with no meaning, and a ceiling computed from it fires at the wrong time in
   * both directions.
   */
  readonly usage: UsageTotals;
  readonly breaches: readonly BudgetBreach[];
}

/** Why the circuit breaker asked for a human (§9). */
export interface NeedsHumanState {
  readonly reason: 'churn' | 'budget' | 'reconcile-unknown';
  readonly detail: string;
}

export interface RunState {
  readonly runId: RunId | null;
  readonly status: RunStatus;
  readonly outcome: RunOutcome | null;
  readonly criteriaSatisfied: readonly CriterionId[];
  readonly needsHuman: NeedsHumanState | null;
  /** The plan the run is executing, not the newest one proposed. */
  readonly planHash: PlanHash | null;
  readonly planVersion: number;
  readonly nodes: Readonly<Record<string, NodeState>>;
  readonly locks: Readonly<Record<string, LockState>>;
  readonly nodeIds: NodeIdRegistryState;
  readonly budget: BudgetState;
  /**
   * F4.7. The `seq` of the last event that actually changed this projection —
   * which is why `node.progress` and agent output cannot advance it. An agent
   * producing megabytes while accomplishing nothing leaves it where it was,
   * and an agent thinking silently for eight minutes before a real transition
   * does not falsely trip the stall detector.
   *
   * `0` means "nothing has been projected yet"; a real `EventSeq` is positive.
   */
  readonly watermarkSeq: number;
  /** The highest daemon epoch seen (KAR-03.7). */
  readonly epoch: number;
  /** How many events were skipped for carrying an older epoch (AC8). */
  readonly staleEpochSkipped: number;
}

/**
 * The state a run has before its first event. A constant would be shared
 * across folds, so this is a factory: two callers must never be handed the
 * same object to build different runs from.
 */
export function initialRunState(): RunState {
  return {
    runId: null,
    status: 'created',
    outcome: null,
    criteriaSatisfied: [],
    needsHuman: null,
    planHash: null,
    planVersion: 0,
    nodes: {},
    locks: {},
    nodeIds: { active: [], retired: [] },
    budget: { costUsd: 0, usage: { vendorReported: null, estimated: null }, breaches: [] },
    watermarkSeq: 0,
    epoch: 0,
    staleEpochSkipped: 0,
  };
}
