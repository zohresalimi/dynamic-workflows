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
import { z } from 'zod';
import {
  BUDGET_DIMENSIONS,
  BUDGET_SCOPES,
  LOCK_KINDS,
  RUN_NEEDS_HUMAN_REASONS,
  RUN_OUTCOMES,
  type RunOutcome,
} from './event-payloads.ts';
import {
  type CriterionId,
  CriterionIdSchema,
  type NodeId,
  NodeIdSchema,
  type PlanHash,
  PlanHashSchema,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
} from './ids.ts';
import { type NodeFailure, NodeFailureSchema } from './node-failure.ts';
import {
  type CompletedNodeResult,
  CompletedNodeResultSchema,
  type NodeSuspension,
  NodeSuspensionSchema,
} from './node-result.ts';
import {
  type PermissionLevel,
  PermissionLevelSchema,
  type PlanGraph,
  PlanGraphSchema,
} from './plan-graph.ts';
import { singleLine } from './text.ts';
import { type UsageTotals, UsageTotalsSchema } from './token-usage.ts';

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
  /**
   * The worktree this node was assigned, from `node.scheduled`; `null` for the
   * main checkout.
   *
   * F5.2's per-worktree exclusive lock is keyed on it, which is why it is a
   * projection rather than something the daemon remembers: two nodes sharing a
   * checkout have to still be serialised on the first tick after a crash, and
   * an assignment that lived in a `Map` would let both in.
   */
  readonly worktree: string | null;
  readonly result: CompletedNodeResult | null;
  readonly failure: NodeFailure | null;
  /** What a suspended node is waiting for; `null` unless `status` is `suspended`. */
  readonly suspension: NodeSuspension | null;
  /**
   * ms epoch a retry or a suspension is due at, from the event that scheduled
   * it — `node.retry.scheduled`'s `wakeAt`, or a `node.suspended` whose
   * `until` carries a deadline. It is what `decide()` turns into the one
   * `node_wake` row that *is* the wait (KAR-06.6), so a suspension with no
   * deadline leaves it `null` and is woken by an event rather than by the
   * ticker.
   */
  readonly wakeAt: number | null;
  /**
   * The `seq` of the last event that *changed* this node's projection — the
   * per-node counterpart of `watermarkSeq`, and for the same reason.
   *
   * `decide()` orders its commands by the `seq` of the event that enabled them
   * (KAR-06.1 AC6), and for a node becoming ready that event is the last of its
   * dependencies completing. Without this field the only total order available
   * to the scheduler is the node id, and a snapshot of a command list would
   * stop reflecting the order the run actually unfolded in.
   *
   * `0` means "no event has moved this node yet", which is what a node named
   * only by a plan looks like; a real `EventSeq` is positive.
   */
  readonly updatedSeq: number;
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

/**
 * The bounds `decide()` admits work within (F5.2, EPIC-06-S4).
 *
 * It lives on `RunState` rather than in a module constant because an operator
 * must be able to turn the slot count down after a rate-limit episode — mid
 * run, without a code change and without killing anything in flight. It is the
 * one part of the projection the reducer does not produce: no event carries it,
 * so the daemon stamps the value from `.DeFlow/config.yaml` onto the state it
 * hands `decide()`. A checkpointed copy is therefore last week's config and is
 * always overwritten rather than believed.
 */
export interface SchedulingPolicy {
  /**
   * How many nodes may be in flight across the whole run. The default of 3 is
   * bounded by laptop RAM and vendor rate limits, not by anything intrinsic.
   */
  readonly globalAgentSlots: number;
}

export const DEFAULT_SCHEDULING_POLICY: SchedulingPolicy = Object.freeze({ globalAgentSlots: 3 });

/** Why the circuit breaker asked for a human (§9). */
export interface NeedsHumanState {
  readonly reason: 'churn' | 'budget' | 'reconcile-unknown';
  readonly detail: string;
}

export interface RunState {
  readonly runId: RunId | null;
  readonly status: RunStatus;
  /**
   * The repository the run executes against, from `run.created.cwd`; `null`
   * before that event is folded.
   *
   * F5.2's per-repository write lock is keyed on it. It is read out of the
   * projection rather than out of the daemon's own working directory for the
   * usual reason: `decide()` has two inputs, and a scheduler that asks the
   * process where it is running would give a different answer during a replay
   * than it gave live.
   */
  readonly repoRoot: string | null;
  readonly outcome: RunOutcome | null;
  readonly criteriaSatisfied: readonly CriterionId[];
  readonly needsHuman: NeedsHumanState | null;
  /** The plan the run is executing, not the newest one proposed. */
  readonly planHash: PlanHash | null;
  readonly planVersion: number;
  /**
   * The graph `planHash` names, so the scheduler can read a node's `deps`,
   * `lifecycle` and `retry` without a lookup.
   *
   * `decide(state, now)` has exactly two inputs, and the temptation to give it
   * a third — "just fetch the plan row" — is what NF9 dies of. The plan is a
   * ledger fact (`plan.proposed` carries the whole document), so folding it in
   * costs nothing and keeps the scheduler a function of a plain object.
   */
  readonly plan: PlanGraph | null;
  /**
   * Proposed graphs that are not the executing one yet, keyed by plan hash.
   *
   * A proposal is not an adoption (§9: "the plan the run *executes* comes from
   * run.started and plan.patched"), so a `plan.proposed` waits here until the
   * event that activates it names its hash. Emptied on activation, which is
   * what keeps the checkpoint bounded rather than accumulating one full plan
   * document per replan.
   */
  readonly proposedPlans: Readonly<Record<string, PlanGraph>>;
  readonly nodes: Readonly<Record<string, NodeState>>;
  readonly locks: Readonly<Record<string, LockState>>;
  readonly nodeIds: NodeIdRegistryState;
  /** The admission bounds `decide()` works within — config, not a fold. */
  readonly policy: SchedulingPolicy;
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
 * The shape stamp the checkpoint cache is written under (KAR-03.6,
 * docs/05-durable-execution.md §5.1).
 *
 * **Bump this whenever the shape of `RunState` above changes** — a field
 * added, removed, renamed or retyped, at any depth, including inside
 * `NodeState`, `LockState`, `BudgetState` or anything they reference. It sits
 * here, three lines from the type, because that is the only place the next
 * person to edit the shape will read it.
 *
 * A mismatch between this number and `run.checkpoint_version` means exactly
 * one thing: ignore the cached state and replay the run's events from zero.
 * That is why forgetting to bump it is the only way the checkpoint can be
 * wrong, and why bumping it costs nothing but a few milliseconds of replay —
 * the cache is a pure optimisation and is allowed to be thrown away, never to
 * be believed when it is stale.
 *
 * The same applies to a change in how an existing field is *derived*, which is
 * what took it to 4: `node.suspended` now fills `NodeState.wakeAt` from its
 * suspension deadline (KAR-06.6). A checkpoint written by 3 has the field, and
 * has it empty for every suspended node — so believing it would leave a
 * six-hour human gate with no wake row and no way to ever come back.
 */
export const CHECKPOINT_VERSION = 4;

/**
 * A node nothing is yet known about: named by a plan, or named by an event
 * this build folded before any `node.scheduled` arrived.
 *
 * `attempts: 0` matters. It is derived from the attempt index of the events
 * that arrive, never counted, so a ledger whose `node.started` was skipped —
 * an older binary reading a newer ledger — still cannot produce a node that
 * completed without having run.
 */
export function initialNodeState(): NodeState {
  return {
    status: 'scheduled',
    attempt: 0,
    attempts: 0,
    provider: null,
    model: null,
    permission: null,
    worktree: null,
    result: null,
    failure: null,
    suspension: null,
    wakeAt: null,
    updatedSeq: 0,
  };
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
    repoRoot: null,
    outcome: null,
    criteriaSatisfied: [],
    needsHuman: null,
    planHash: null,
    planVersion: 0,
    plan: null,
    proposedPlans: {},
    nodes: {},
    locks: {},
    nodeIds: { active: [], retired: [] },
    policy: { ...DEFAULT_SCHEDULING_POLICY },
    budget: { costUsd: 0, usage: { vendorReported: null, estimated: null }, breaches: [] },
    watermarkSeq: 0,
    epoch: 0,
    staleEpochSkipped: 0,
  };
}

// ── decoding a checkpoint ────────────────────────────────────────────────────

/** A count, an index or a watermark: `0` is legal, a fraction is not. */
const wholeCount = z.number().int().nonnegative();

const NodeStateSchema = z.strictObject({
  status: z.enum(NODE_STATUSES),
  attempt: wholeCount,
  attempts: wholeCount,
  provider: ProviderIdSchema.nullable(),
  model: z.string().min(1).nullable(),
  permission: PermissionLevelSchema.nullable(),
  worktree: z.string().min(1).nullable(),
  result: CompletedNodeResultSchema.nullable(),
  failure: NodeFailureSchema.nullable(),
  suspension: NodeSuspensionSchema.nullable(),
  wakeAt: wholeCount.nullable(),
  updatedSeq: wholeCount,
});

const LockStateSchema = z.strictObject({
  lock: z.enum(LOCK_KINDS),
  key: z.string().min(1),
  node: NodeIdSchema,
  /** The `seq` of the event that took it, and no event has seq 0. */
  sinceSeq: z.number().int().positive(),
});

const NodeIdRegistryStateSchema = z.strictObject({
  active: z.array(NodeIdSchema),
  retired: z.array(NodeIdSchema),
});

const BudgetStateSchema = z.strictObject({
  costUsd: z.number().nonnegative(),
  usage: UsageTotalsSchema,
  breaches: z.array(
    z.strictObject({
      scope: z.enum(BUDGET_SCOPES),
      dimension: z.enum(BUDGET_DIMENSIONS),
      limit: z.number().nonnegative(),
      actual: z.number().nonnegative(),
    }),
  ),
});

/**
 * `RunState` as a value that can be *validated*, which is what a checkpoint
 * decoder needs and `JSON.parse` cannot give it (KAR-03.6 AC5).
 *
 * Strict at every level, on purpose. The dangerous input is not the truncated
 * file — that throws, and a `try` catches it. It is `run.state_json` written
 * by last month's binary: valid JSON, an object, every field it kept holding
 * the right kind of value, and a shape the current reducer would never have
 * produced. `strictObject` is what turns "a field this build has never heard
 * of" and "a field this build requires, missing" into a refusal instead of a
 * run that is quietly wrong from its first tick.
 *
 * Annotated as `z.ZodType<RunState, unknown>` rather than inferred so the
 * compiler holds the two halves together: add a field to `RunState` without
 * adding it here and this assignment stops type-checking.
 */
export const RunStateSchema: z.ZodType<RunState, unknown> = z.strictObject({
  runId: RunIdSchema.nullable(),
  status: z.enum(RUN_STATUSES),
  repoRoot: z.string().min(1).nullable(),
  outcome: z.enum(RUN_OUTCOMES).nullable(),
  criteriaSatisfied: z.array(CriterionIdSchema),
  needsHuman: z
    .strictObject({ reason: z.enum(RUN_NEEDS_HUMAN_REASONS), detail: singleLine() })
    .nullable(),
  planHash: PlanHashSchema.nullable(),
  planVersion: wholeCount,
  plan: PlanGraphSchema.nullable(),
  proposedPlans: z.record(z.string(), PlanGraphSchema),
  nodes: z.record(z.string(), NodeStateSchema),
  locks: z.record(z.string(), LockStateSchema),
  nodeIds: NodeIdRegistryStateSchema,
  policy: z.strictObject({ globalAgentSlots: z.number().int().nonnegative() }),
  budget: BudgetStateSchema,
  watermarkSeq: wholeCount,
  epoch: wholeCount,
  staleEpochSkipped: wholeCount,
});
