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
import { initialCeilings, type RunCeilings, RunCeilingsSchema } from './budget-ceiling.ts';
import { type BudgetRollup, BudgetRollupSchema, initialBudgetRollup } from './cost-rollup.ts';
import {
  CANCEL_MODES,
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
import {
  CHURN_WINDOW,
  type CompletedAttempt,
  DEFAULT_NO_PROGRESS_POLICY,
  INITIAL_REPLAN_STREAK,
  type NoProgressPolicy,
  type ReplanStreak,
} from './no-progress.ts';
import { type BudgetBreach, type NodeFailure, NodeFailureSchema } from './node-failure.ts';
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

/**
 * The run's lifecycle, as the ledger can prove it.
 *
 * `paused` is here rather than as a boolean beside `running` because F4.4
 * requires pause to be an event: a flag does not survive the restart it exists
 * to protect against.
 */
export const RUN_STATUSES = [
  'created',
  /**
   * KAR-10.3 — the F1.3 gate is open: framing produced a `TaskSpec` and a
   * blocking `human` node is waiting for the operator to approve, edit, reject
   * or abandon it (docs/06-planning-and-replanning.md §1.3).
   *
   * A status rather than a flag beside `created`, and folded from
   * `human.requested` on the gate node rather than set by whoever opened it,
   * because docs/05 §'s rule about pause applies here word for word: a boolean
   * does not survive the restart it exists to protect against, and a six-hour
   * think about a spec is exactly the wait a restart happens inside of.
   */
  'awaiting-spec-approval',
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
  /**
   * KAR-07.6 / Decision D14. Demoted because `git merge-tree` found this
   * node's branch conflicting with an earlier-started node's
   * (docs/09-workspace-and-safety.md §7.3).
   *
   * Not `suspended`: a suspension is something the node itself asked for and
   * carries what it is waiting for, while this is done *to* the node by the
   * scheduler on evidence from outside it. And not terminal — the work is
   * still on the branch and still wanted; what changed is that it may not
   * proceed in parallel with the node it collides with. `ADMISSIBLE_STATUSES`
   * in ./decide.ts does not include it, which is the whole of the scheduling
   * effect.
   */
  'blocked',
  'completed',
  'failed',
  /**
   * Stopped by the F5.7 kill switch (KAR-06.7). Terminal, and deliberately not
   * folded into `failed`: the scheduler treats them identically — neither is
   * running, neither is admissible, both give their locks back — but a run's
   * own history has to be able to say "the operator stopped this" rather than
   * "the agent broke", and a status that cannot express that makes every
   * cancelled node look like an incident afterwards.
   */
  'cancelled',
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
   * KAR-06.8. The `requestHash` of the first effect this node's *current*
   * attempt journalled — the digest of what was asked for, from
   * `effect.started` (./effect-request.ts).
   *
   * It is the churn breaker's only input that cannot be recomputed inside
   * `decide()`: the digest is a sha256, `sha256Hex` is asynchronous, and
   * `decide` is a synchronous pure function of two arguments. So the one place
   * it can arrive from is the ledger, and the one place a scheduler may read it
   * from is the projection. `null` means the attempt journalled no effect yet —
   * a completion the window still counts, but cannot call "the same work" as
   * any other.
   *
   * Reset when the attempt index advances, because it describes an attempt and
   * not a node.
   */
  readonly requestHash: string | null;
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
   * KAR-14.2. The envelope `ts` of the node's **first** `node.started`, which a
   * per-node wall-clock ceiling is measured from. `0` before it has ever run.
   *
   * First rather than latest, and across attempts rather than per attempt: a
   * repair loop that burned ten minutes over three tries has burned ten
   * minutes, and a per-attempt measure would never notice. It is not reset by a
   * retry for the same reason `startedTs` is not reset by a pause.
   */
  readonly startedTs: number;
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

/**
 * One F4.6 ceiling breach, kept because it pauses the run rather than failing
 * it. Declared beside the failure taxonomy — a breach reaches the projection as
 * the `detail` of a `gate`-class `NodeFailure` (KAR-06.5 AC9), and one shape
 * with two declarations is one shape that can disagree with itself.
 */
export type { BudgetBreach };

/**
 * KAR-14.1 — the accounting projection, per node, per provider and per run.
 *
 * It is `BudgetRollup` rather than a scalar and a token pair because a run's
 * spend is not one number: subscription quota and real currency are different
 * substances (docs/07-provider-adapter-layer.md §12) and vendor-reported and
 * estimated figures are different claims (docs/08-context-and-memory.md §7).
 * ./cost-rollup.ts is where the shape and the reasons live.
 */
export type BudgetState = BudgetRollup;

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
  /**
   * F4.7's tuning constants (KAR-06.8). Config for the same reason the slot
   * count is: the stall threshold will look wrong the first time a thirty-minute
   * test suite runs under it, and an operator has to be able to fix that without
   * a release.
   */
  readonly noProgress: NoProgressPolicy;
}

export const DEFAULT_SCHEDULING_POLICY: SchedulingPolicy = Object.freeze({
  globalAgentSlots: 3,
  noProgress: DEFAULT_NO_PROGRESS_POLICY,
});

/**
 * The kill switch as reduced state (F5.7, KAR-06.7).
 *
 * `status: 'cancelling'` alone says a cancel was asked for; this says **which
 * ladder**, which is the part `decide()` has to still know after a restart. A
 * daemon that came back to a cancelling run and had to guess between asking the
 * agent politely and signalling its process group would either leave a wedged
 * agent burning tokens or throw away a transcript somebody is waiting for.
 */
export interface CancelState {
  readonly mode: 'cooperative' | 'forceful';
  /** The `seq` of the `run.cancel.requested` that asked, for the timeline. */
  readonly requestedSeq: number;
}

/** Why the circuit breaker asked for a human (§9). */
export interface NeedsHumanState {
  readonly reason: (typeof RUN_NEEDS_HUMAN_REASONS)[number];
  readonly detail: string;
}

/** KAR-10.3 — F1.3's answer, as the ledger recorded it. */
export interface SpecApprovalState {
  /** The digest that was approved — never recomputed, always the one on the event. */
  readonly specHash: string;
  readonly by: 'ui' | 'cli';
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
  /**
   * KAR-10.3 AC3 — the approval, as the ledger recorded it, or `null` while
   * F1.3's gate has not been answered.
   *
   * This is the scheduling gate's only input, and it is the reason the gate is
   * a *property of `decide()`* rather than a check somewhere on the way in:
   * *"before `run.spec.approved` exists in the ledger, no node other than
   * framing and recon is ever scheduled"* is asserted over events, so the
   * scheduler has to be unable to admit anything without one — including after
   * a restart, including on a replay, including when a plan was somehow already
   * proposed.
   *
   * `specHash` is the digest that was approved, which is not necessarily the
   * run's current one: a mid-run edit (AC8) moves `specHash` below and
   * re-approves, and a verdict carrying the older digest is void
   * (docs/10-verification-gates.md §5.2).
   */
  readonly specApproved: SpecApprovalState | null;
  /**
   * The `specHash` of the spec the run is currently judged against — from
   * `run.created`, then moved by each `spec.amended`. `null` before framing has
   * produced one.
   */
  readonly specHash: string | null;
  readonly outcome: RunOutcome | null;
  readonly criteriaSatisfied: readonly CriterionId[];
  readonly needsHuman: NeedsHumanState | null;
  /** The cancel the operator asked for, or `null` while nobody has. */
  readonly cancel: CancelState | null;
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
   * KAR-14.2 — F4.6's ceilings, as the ledger has pinned them.
   *
   * Reduced from `budget.ceiling.set` rather than read from
   * `.DeFlow/config.yaml` on each tick, which is the whole of AC1: a mid-run
   * edit to the file cannot move a ceiling a running run is measured against,
   * and a ceiling an operator raised to answer a pause survives the restart
   * that so often follows one.
   */
  readonly ceilings: RunCeilings;
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
  /**
   * F4.7, KAR-06.8. The envelope `ts` of that same event — the instant the run
   * last actually got somewhere, which is what `now - watermarkTs` in §11.2 is
   * measured against.
   *
   * `ts` is informational for *ordering* (order is `seq`, always), but it is
   * the only wall-clock fact the ledger records about when a transition
   * happened, and the stall detector is a question about wall-clock time by
   * construction. Monotone, so a laptop whose clock steps backwards mid-run
   * cannot make the projection claim the run got somewhere earlier than it did.
   *
   * `0` means "nothing has been projected yet".
   */
  readonly watermarkTs: number;
  /**
   * KAR-06.8. The `ts` of the `run.started` that put this run in flight, which
   * §11.4's `maxRunWallClock` is measured from. `0` before the run starts.
   *
   * It is not reset by a pause: an operator who pauses a run for a week and
   * resumes it has a run that really has been alive for a week, and a cap that
   * quietly forgave the pause would be a cap on nothing in particular.
   */
  readonly startedTs: number;
  /**
   * KAR-06.8 AC2. The `watermarkSeq` a `run.stalled` has already been appended
   * for, so a stall is reported once per *episode* rather than once per tick.
   * `0` means no episode has been reported.
   *
   * This is the one field whose event — `run.stalled` — is folded *without*
   * advancing the watermark, and it has to be: an episode is identified by the
   * seq the run stopped progressing at, so a report that moved the watermark
   * would end the very episode it describes and re-report it ten minutes later,
   * for ever.
   */
  readonly stalledAtSeq: number;
  /**
   * §11.3's sliding window: the last `CHURN_WINDOW` completed node attempts,
   * oldest first. Bounded by construction, so it costs a fixed number of bytes
   * in `run.state_json` however long the run is.
   */
  readonly churnWindow: readonly CompletedAttempt[];
  /** §11.3's second detector: consecutive replans that moved nothing. */
  readonly replans: ReplanStreak;
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
 * the cache is a pure optimisation, free to be thrown away and never to be
 * believed when stale.
 *
 * The same applies to how an existing field is *derived*. The bumps:
 * 4 `NodeState.wakeAt`; 5 `RunState.cancel`; 6 F4.7's no-progress fields;
 * 7 the per-node cost rollup; 8 `ceilings` and `NodeState.startedTs`;
 * 9 the reconciled estimate; 10 `CostRollup.authModes`; 11 KAR-10.3's
 * `specApproved`, without which a daemon restored from a cached checkpoint
 * would derive a ready set for a run nobody approved — F1.3 lost to a cache.
 */
export const CHECKPOINT_VERSION = 11;

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
    requestHash: null,
    wakeAt: null,
    startedTs: 0,
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
    specApproved: null,
    specHash: null,
    outcome: null,
    criteriaSatisfied: [],
    needsHuman: null,
    cancel: null,
    planHash: null,
    planVersion: 0,
    plan: null,
    proposedPlans: {},
    nodes: {},
    locks: {},
    nodeIds: { active: [], retired: [] },
    policy: { ...DEFAULT_SCHEDULING_POLICY },
    budget: initialBudgetRollup(),
    ceilings: initialCeilings(),
    watermarkSeq: 0,
    watermarkTs: 0,
    startedTs: 0,
    stalledAtSeq: 0,
    churnWindow: [],
    replans: INITIAL_REPLAN_STREAK,
    epoch: 0,
    staleEpochSkipped: 0,
  };
}

// ── decoding a checkpoint ────────────────────────────────────────────────────

/** A count, an index or a watermark: `0` is legal, a fraction is not. */
const wholeCount = z.number().int().nonnegative();

/** The `sha256-<64 hex>` shape `effect.started.requestHash` and `specHash`
 * both carry. Spelled again rather than imported because ./event-payloads.ts
 * keeps its copy private, and a checkpoint decoder that accepted any string
 * here would let a corrupted window key the churn detector on garbage. */
const sha256Digest = z.string().regex(/^sha256-[0-9a-f]{64}$/, 'must be sha256-<64 hex>');

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
  requestHash: sha256Digest.nullable(),
  wakeAt: wholeCount.nullable(),
  startedTs: wholeCount,
  updatedSeq: wholeCount,
});

const CompletedAttemptSchema: z.ZodType<CompletedAttempt, unknown> = z.strictObject({
  node: NodeIdSchema,
  requestHash: sha256Digest.nullable(),
  attempt: wholeCount,
  /** The seq of the completion, and no event has seq 0. */
  seq: z.number().int().positive(),
});

const ReplanStreakSchema: z.ZodType<ReplanStreak, unknown> = z.strictObject({
  flat: wholeCount,
  completed: wholeCount,
  versions: z.array(z.number().int().positive()),
});

const NoProgressPolicySchema: z.ZodType<NoProgressPolicy, unknown> = z.strictObject({
  detectors: z.boolean(),
  stallThresholdMs: wholeCount,
  churnRepeats: wholeCount,
  flatReplans: wholeCount,
  maxAttemptsPerNode: z.number().int().positive(),
  maxRunWallClockMs: wholeCount.nullable(),
  maxTotalNodeExecutions: wholeCount.nullable(),
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
  specApproved: z.strictObject({ specHash: sha256Digest, by: z.enum(['ui', 'cli']) }).nullable(),
  specHash: sha256Digest.nullable(),
  outcome: z.enum(RUN_OUTCOMES).nullable(),
  criteriaSatisfied: z.array(CriterionIdSchema),
  needsHuman: z
    .strictObject({ reason: z.enum(RUN_NEEDS_HUMAN_REASONS), detail: singleLine() })
    .nullable(),
  cancel: z
    .strictObject({
      mode: z.enum(CANCEL_MODES),
      /** The `seq` of the request, and no event has seq 0. */
      requestedSeq: z.number().int().positive(),
    })
    .nullable(),
  planHash: PlanHashSchema.nullable(),
  planVersion: wholeCount,
  plan: PlanGraphSchema.nullable(),
  proposedPlans: z.record(z.string(), PlanGraphSchema),
  nodes: z.record(z.string(), NodeStateSchema),
  locks: z.record(z.string(), LockStateSchema),
  nodeIds: NodeIdRegistryStateSchema,
  policy: z.strictObject({
    globalAgentSlots: z.number().int().nonnegative(),
    noProgress: NoProgressPolicySchema,
  }),
  budget: BudgetRollupSchema,
  ceilings: RunCeilingsSchema,
  watermarkSeq: wholeCount,
  watermarkTs: wholeCount,
  startedTs: wholeCount,
  stalledAtSeq: wholeCount,
  churnWindow: z.array(CompletedAttemptSchema).max(CHURN_WINDOW),
  replans: ReplanStreakSchema,
  epoch: wholeCount,
  staleEpochSkipped: wholeCount,
});
