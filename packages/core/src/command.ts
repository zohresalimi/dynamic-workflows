/**
 * KAR-06.1 — `Command`, the closed union `decide()` returns and the
 * `EffectRunner` performs (docs/05-durable-execution.md §4).
 *
 * One design rule governs every member, and it is the rule the whole epic
 * rests on: **a command carries everything the runner needs**. A `StartNode`
 * that named a node and let the runner look up its provider would have moved
 * policy out of the pure function and into the imperative shell, where it is
 * no longer a unit test over a plain object. So the provider, the model, the
 * permission level and the retry policy travel with the command, and
 * `EffectRunner.run(command, ctx)` never reads `RunState`.
 *
 * The union is closed for the same reason `Event`'s is: a `switch` over it in
 * the runner is exhaustive, and a member added here is a compile error in
 * every shell that has not handled it yet.
 *
 * Verifies: EPIC-06-S1, EPIC-06-S3, EPIC-06-S4 · AC5, AC6, AC7
 */
import type { EventKind, EventPayloadOf, LockReleaseReason } from './event-payloads.ts';
import type { NodeId, ProviderId, RunId } from './ids.ts';
import type { NodeType, PathScope, PermissionLevel, RetryPolicy } from './plan-graph.ts';

/**
 * Start one attempt of one node.
 *
 * `attempt` is the 0-based index of the attempt that is about to run — the
 * value that goes into `ikey = ${runId}/${nodeId}/${attempt}/${ordinal}` — and
 * it is derived from state, never counted by the runner. Retrying mints a new
 * key by construction, which is exactly what distinguishes a retry (re-execute)
 * from a crash-resume of the same attempt (memoise).
 */
export interface StartNode {
  readonly kind: 'StartNode';
  readonly runId: RunId;
  readonly node: NodeId;
  readonly attempt: number;
  readonly nodeType: NodeType;
  readonly title: string;
  /**
   * The adapter to run, resolved here rather than by the runner. `null` means
   * the plan expressed no preference and the node is not an agent node — a
   * `gate` evaluated deterministically has no provider at all.
   */
  readonly provider: ProviderId | null;
  readonly model: string | null;
  readonly permission: PermissionLevel;
  readonly pathScopes: PathScope;
  /**
   * The worktree this attempt runs in, or `null` for the main checkout. The
   * scheduler has already taken the per-worktree exclusive lock over this path
   * by the time the runner sees the command (F5.2), so the runner spawns into
   * it without asking anything.
   */
  readonly worktree: string | null;
  /** Carried so the runner can classify and schedule a failure without state. */
  readonly retry: RetryPolicy;
}

/**
 * Stop an attempt that is already in flight (F4.4's cancel ladder).
 *
 * `mode` is the stage of the ladder, not a preference: `cooperative` asks the
 * child to stop, `forceful` is the escalation. Which one is a scheduling
 * decision, so it is decided here.
 */
export interface CancelNode {
  readonly kind: 'CancelNode';
  readonly runId: RunId;
  readonly node: NodeId;
  readonly attempt: number;
  readonly mode: 'cooperative' | 'forceful';
}

/**
 * Take or give back one of F5.2's locks. `key` is the resource the lock is
 * over — a repository path for `repo`, a worktree path for `worktree` — so a
 * repo lock and a worktree lock over the same key are two different locks.
 *
 * Both are commands rather than in-memory operations because the lock lives in
 * the ledger: a `Map` in the daemon evaporates on the restart the lock exists
 * to protect against.
 */
export interface AcquireLock {
  readonly kind: 'AcquireLock';
  readonly runId: RunId;
  readonly node: NodeId;
  readonly lock: 'repo' | 'worktree';
  readonly key: string;
}

/**
 * Give a lock back.
 *
 * `node` is the node that **held** it, never the one waiting for it: the
 * release is a fact about the old owner, and an event naming the new one would
 * make a reclaimed lock indistinguishable from a handover in the timeline.
 *
 * Every `ReleaseLock` `decide()` returns carries `reason: 'reclaimed'`, because
 * the only lock a pure scheduler can see is one whose holder has already
 * stopped running — a node that finished its attempt cleanly and gave the lock
 * back inside the same transaction never reaches this command at all.
 */
export interface ReleaseLock {
  readonly kind: 'ReleaseLock';
  readonly runId: RunId;
  readonly node: NodeId;
  readonly lock: 'repo' | 'worktree';
  readonly key: string;
  readonly reason: LockReleaseReason;
}

/**
 * Why a node is asleep. Mirrors the `node_wake.reason` column (§5) verbatim,
 * underscore included, so the value the timeline renders is the value on the
 * row and no translation table sits between them (KAR-06.6 AC4).
 */
export const WAKE_REASONS = ['backoff', 'human_gate', 'poll'] as const;

export type WakeReason = (typeof WAKE_REASONS)[number];

/**
 * Write the `node_wake` row that replaces `setTimeout` for every wait in the
 * system, from a 2-second backoff to a 30-day human gate (§10.1).
 *
 * `wakeAt` is an absolute instant rather than a duration on purpose: a
 * duration is only meaningful relative to a clock that is still running, and
 * the whole point of the row is to survive a process that is not.
 */
export interface ScheduleWake {
  readonly kind: 'ScheduleWake';
  readonly runId: RunId;
  readonly node: NodeId;
  readonly wakeAt: number;
  readonly reason: WakeReason;
}

/**
 * One event `decide()` wants appended, already shaped as the §9 registry
 * requires. Discriminated over `EventKind`, so the payload type follows the
 * kind and a `node.failed` carrying a `node.completed` payload does not
 * compile.
 */
export type EmittedEvent = {
  [K in EventKind]: { readonly kind: K; readonly payload: EventPayloadOf<K> };
}[EventKind];

/**
 * Append an event that is a *conclusion*, not the record of an effect —
 * something the scheduler knows purely from state, with nothing to perform.
 * The propagation of `dependency.failed` down a poisoned branch is the first
 * one: no subprocess is involved, and the fact is derivable the instant its
 * dependency failed permanently.
 *
 * `node` and `attempt` are the ledger's envelope columns, carried beside the
 * payload so the append needs no second lookup.
 */
export interface EmitEvent {
  readonly kind: 'EmitEvent';
  readonly runId: RunId;
  readonly node: NodeId | null;
  readonly attempt: number | null;
  readonly event: EmittedEvent;
}

export type Command = StartNode | CancelNode | AcquireLock | ReleaseLock | ScheduleWake | EmitEvent;

/**
 * The order commands are returned in when two are enabled by the same event
 * (AC6). It is a rank rather than an alphabetical accident because it is also
 * the order they should be *performed* in: a conclusion the scheduler already
 * knows is recorded first, capacity is given back before it is taken, work
 * starts before anything is put to sleep.
 */
export const COMMAND_ORDER = [
  'EmitEvent',
  'ReleaseLock',
  'AcquireLock',
  'StartNode',
  'CancelNode',
  'ScheduleWake',
] as const satisfies readonly Command['kind'][];
