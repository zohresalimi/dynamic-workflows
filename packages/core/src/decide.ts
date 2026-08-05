/**
 * KAR-06.1 — `decide(state, now)`: the scheduler's entire policy as one pure
 * function (docs/05-durable-execution.md §4, primitive 3 of §3).
 *
 * The loop is `reduce` the log into `RunState` → call `decide` → hand the
 * `Command[]` to the `EffectRunner` → append the `Event[]` it returns →
 * `reduce` those → repeat. Nothing else mutates run state, ever.
 *
 * Three rules govern every line below.
 *
 * 1. **Two inputs, and only two.** `now` is a parameter, not a call. The
 *    capability manifest, the git head and the wall clock all arrive through
 *    `RunState` or through `now`; the first "just one lookup" is what NF9 dies
 *    of. `packages/core/test/purity.test.ts` fails the build if a clock, a
 *    timer or a random source appears anywhere under `packages/core/src`.
 * 2. **Nothing is mutated, including the inputs.** Every derivation below
 *    builds new arrays, so a caller may hand in a deeply frozen state and get
 *    the same answer.
 * 3. **No iteration order reaches the output.** The ready set is derived from
 *    the plan and sorted by `(enabling seq, node id)`, so shuffling the keys
 *    of `state.nodes` or the entries of `plan.nodes` cannot change a single
 *    command. That is what makes a snapshot of a command list stable, and it
 *    is a bug that only shows up once a plan has enough parallel branches to
 *    matter.
 *
 * Verifies: EPIC-06-S1, EPIC-06-S2, EPIC-06-S3, EPIC-06-S4 ·
 * AC1, AC3, AC4, AC5, AC6, AC7, AC8
 */
import type {
  Command,
  EmitEvent,
  ReleaseLock,
  ScheduleWake,
  StartNode,
  WakeReason,
} from './command.ts';
import type { EventSeq, NodeId, RunId } from './ids.ts';
import type { PlanGraph, PlanNode } from './plan-graph.ts';
import { initialNodeState, lockKey, type NodeState, type RunState } from './run-state.ts';

/**
 * The two node statuses that describe work not yet in flight: never started,
 * and started-then-scheduled-to-start-again.
 *
 * §3's sketch calls this one status, `pending`. This projection splits it
 * because the scheduler treats the halves differently — `awaiting-retry`
 * carries a `wakeAt` and has already spent attempts — but both are the same
 * answer to the question this set asks: is there an attempt left to launch?
 */
const ADMISSIBLE_STATUSES = ['scheduled', 'awaiting-retry'] as const;

/** A run in one of these states is over; nothing more is derived from it. */
const ENDED_STATUSES = ['completed', 'aborted'] as const;

/**
 * Given this state, at this instant, what should happen next?
 *
 * Total: an empty ledger reduces to a state with no run id, and that yields
 * `[]` rather than a throw. Deterministic: the same `(state, now)` produces a
 * deeply equal array on every call, forever.
 */
export function decide(state: RunState, now: number): Command[] {
  const runId = state.runId;
  if (runId === null) return [];

  const ended = (ENDED_STATUSES as readonly string[]).includes(state.status);
  const plan = state.plan;
  const poisoned = ended ? new Map<NodeId, number>() : poisonedBranches(state, plan);

  // Concatenated in COMMAND_ORDER, each group sorted by the seq of the event
  // that enabled it and then by node id (AC6). Grouping first and sorting
  // within is the same total order as one comparator over the whole list, and
  // it keeps each rule's ordering argument beside the rule.
  return [
    ...propagateDependencyFailures(state, runId, poisoned),
    ...releaseFinishedLocks(state, runId),
    ...startReadyNodes(state, runId, now, plan, poisoned),
    ...scheduleWakes(state, runId, now),
  ];
}

// ── the ready set ────────────────────────────────────────────────────────────

/**
 * AC3, AC4, AC7. A node is ready when its plan says it may run and its
 * projection says it is not already doing so:
 *
 *   - its `lifecycle` is `active` — a `superseded` or `abandoned` node is
 *     never ready regardless of anything else, because a `plan.patched`
 *     already replaced it and running it would spend money on work the plan
 *     has moved past;
 *   - every entry in `deps` has reduced to `completed`;
 *   - it has an attempt left inside `retry.maxAttempts`;
 *   - `wakeAt` is absent or `<= now` — inclusive, because the ticker fires on
 *     a due row and calls `decide` with that same instant, so `<` would make
 *     every 2-second backoff take three seconds;
 *   - and it is not downstream of a permanent failure.
 *
 * Admission on top of that is F5.2's bound: no `StartNode` at all unless the
 * run is `running` (a paused, cancelling or needs-human run starts nothing),
 * and never more in flight than `policy.globalAgentSlots`.
 */
function startReadyNodes(
  state: RunState,
  runId: RunId,
  now: number,
  plan: PlanGraph | null,
  poisoned: ReadonlyMap<NodeId, number>,
): StartNode[] {
  if (plan === null || state.status !== 'running') return [];

  const slots = state.policy.globalAgentSlots - countRunning(state);
  if (slots <= 0) return [];

  const ready = plan.nodes.filter((node) => isReady(state, node, now, poisoned));

  return sortByEnablement(
    ready.map((node) => ({
      seq: enablingSeq(state, node),
      id: node.id,
      value: startNode(state, runId, node),
    })),
  ).slice(0, slots);
}

function isReady(
  state: RunState,
  node: PlanNode,
  now: number,
  poisoned: ReadonlyMap<NodeId, number>,
): boolean {
  if (node.lifecycle !== 'active') return false;
  if (poisoned.has(node.id)) return false;

  const current = nodeState(state, node.id);
  if (!(ADMISSIBLE_STATUSES as readonly string[]).includes(current.status)) return false;
  if (current.attempts >= node.retry.maxAttempts) return false;
  if ((current.wakeAt ?? 0) > now) return false;

  return node.deps.every((dep) => nodeState(state, dep).status === 'completed');
}

/**
 * Everything the runner needs to perform the attempt, so it never consults
 * state. The provider and model prefer what the ledger already recorded for
 * this node over what the plan asked for: a `node.scheduled` means the
 * resolution against probed capabilities has happened, and re-deriving it from
 * `prefer[0]` would silently undo it after a restart.
 */
function startNode(state: RunState, runId: RunId, node: PlanNode): StartNode {
  const current = nodeState(state, node.id);
  const preferred = node.type === 'agent' ? (node.provider.prefer[0] ?? null) : null;
  const planModel = node.type === 'agent' ? (node.model ?? null) : null;

  return {
    kind: 'StartNode',
    runId,
    node: node.id,
    // The 0-based index of the attempt about to run — `attempts` is how many
    // have happened, which is the same number. It goes straight into the
    // idempotency key, so a retry mints a new key by construction.
    attempt: current.attempts,
    nodeType: node.type,
    title: node.title,
    provider: current.provider ?? preferred,
    model: current.model ?? planModel,
    // The permission level comes from the plan and never from the projection:
    // the ladder is a safety claim (F5.4), and a defaulted or remembered one
    // is how a system silently escalates.
    permission: node.permission,
    pathScopes: node.pathScopes,
    retry: node.retry,
  };
}

/** F5.2's global bound counts what is *in flight*, not what is ready. */
function countRunning(state: RunState): number {
  return Object.values(state.nodes).filter((node) => node.status === 'running').length;
}

// ── poisoned branches ────────────────────────────────────────────────────────

/**
 * AC5. The nodes downstream of a permanent failure, each mapped to the `seq`
 * of the failure that poisoned it.
 *
 * A `transient` failure poisons nothing: it is about to be retried, and
 * failing its dependents would be the scheduler pre-empting its own retry
 * policy. Only `permanent` propagates, and it propagates transitively —
 * `recon` failing takes `implement` and, through it, `gate-typecheck`.
 *
 * The fixpoint takes the *minimum* originating seq rather than the first one
 * it happens to find, which is what makes the answer independent of the order
 * `plan.nodes` is written in: with two poisoned dependencies, the earlier
 * failure is the cause, whichever way the array is sorted.
 */
function poisonedBranches(state: RunState, plan: PlanGraph | null): Map<NodeId, number> {
  const poisoned = new Map<NodeId, number>();
  if (plan === null) return poisoned;

  for (let pass = 0; pass <= plan.nodes.length; pass += 1) {
    let changed = false;
    for (const node of plan.nodes) {
      if (failedPermanently(nodeState(state, node.id))) continue;

      const causes = node.deps
        .map((dep) => causeSeq(state, dep, poisoned))
        .filter((seq): seq is number => seq !== null);
      if (causes.length === 0) continue;

      const cause = Math.min(...causes);
      const held = poisoned.get(node.id);
      if (held !== undefined && held <= cause) continue;
      poisoned.set(node.id, cause);
      changed = true;
    }
    if (!changed) break;
  }

  return poisoned;
}

function causeSeq(
  state: RunState,
  dep: NodeId,
  poisoned: ReadonlyMap<NodeId, number>,
): number | null {
  const current = nodeState(state, dep);
  if (failedPermanently(current)) return current.updatedSeq;
  return poisoned.get(dep) ?? null;
}

const failedPermanently = (node: NodeState): boolean =>
  node.status === 'failed' && node.failure?.class === 'permanent';

/**
 * AC5. The propagation is a `Command`, not a silent exclusion from the ready
 * set: a branch that will never run has to say so on the log, or the board
 * shows a node stuck at `scheduled` forever and nothing explains why.
 *
 * A node the ledger already records as failed or completed is not told twice —
 * the command is only emitted while the conclusion is still missing from the
 * log, so the next tick over the reduced result returns nothing.
 */
function propagateDependencyFailures(
  state: RunState,
  runId: RunId,
  poisoned: ReadonlyMap<NodeId, number>,
): EmitEvent[] {
  const pending = [...poisoned]
    .filter(([id]) => {
      const status = nodeState(state, id).status;
      return status !== 'failed' && status !== 'completed' && status !== 'running';
    })
    .map(([id, seq]) => ({ seq, id, value: dependencyFailed(state, runId, id, seq) }));

  return sortByEnablement(pending);
}

/**
 * `EventSeq` is positive by construction, and a cause of `0` can only come
 * from an envelope that never carried a `seq` — something `parseEvent` would
 * have refused. `decide` is total, so it names the first legal seq rather than
 * throwing on a ledger it did not write.
 */
const eventSeq = (seq: number): EventSeq => (seq > 0 ? seq : 1) as EventSeq;

function dependencyFailed(state: RunState, runId: RunId, node: NodeId, cause: number): EmitEvent {
  const attempt = nodeState(state, node).attempt;
  return {
    kind: 'EmitEvent',
    runId,
    node,
    attempt,
    event: {
      kind: 'node.failed',
      payload: {
        node,
        attempt,
        failure: {
          reason: 'dependency.failed',
          class: 'permanent',
          message: 'a dependency failed permanently, so this node can never run',
          evidence: [],
          // The seq of the failure that caused it — the one thing that turns a
          // wall of poisoned nodes back into the single event to look at.
          occurredAtEvent: eventSeq(cause),
          attempt,
        },
      },
    },
  };
}

// ── locks and wakes ──────────────────────────────────────────────────────────

/**
 * AC7. A lock is released when the node holding it is no longer running —
 * including while the run is paused, because a pause that leaves the
 * repository write lock held blocks the next run as well as this one, and the
 * lock lives in the ledger precisely so it cannot be forgotten.
 */
function releaseFinishedLocks(state: RunState, runId: RunId): ReleaseLock[] {
  const stale = Object.values(state.locks)
    .filter((held) => nodeState(state, held.node).status !== 'running')
    .map((held) => ({
      seq: held.sinceSeq,
      id: `${held.node}/${lockKey(held.lock, held.key)}`,
      value: {
        kind: 'ReleaseLock' as const,
        runId,
        node: held.node,
        lock: held.lock,
        key: held.key,
      },
    }));

  return sortByEnablement(stale);
}

/**
 * §10.1. Every wait in the system is a `node_wake` row and zero CPU, so a node
 * whose `wakeAt` is still in the future asks for the row rather than for a
 * timer — and asks again on every tick, because the write is an upsert and an
 * idempotent restatement is what makes the row survive a crash between the
 * event that scheduled it and the row that records it.
 *
 * Emitted while the run is paused too (AC7): the six-hour gate a run was
 * paused in the middle of is still due at the same instant.
 */
function scheduleWakes(state: RunState, runId: RunId, now: number): ScheduleWake[] {
  const waiting = Object.entries(state.nodes)
    .filter(([, node]) => node.wakeAt !== null && node.wakeAt > now)
    .map(([id, node]) => ({
      seq: node.updatedSeq,
      id,
      value: {
        kind: 'ScheduleWake' as const,
        runId,
        node: id as NodeId,
        wakeAt: node.wakeAt ?? 0,
        reason: wakeReason(node),
      },
    }));

  return sortByEnablement(waiting);
}

function wakeReason(node: NodeState): WakeReason {
  if (node.status === 'awaiting-retry') return 'backoff';
  if (node.suspension?.kind === 'human') return 'human-gate';
  return 'poll';
}

// ── ordering ─────────────────────────────────────────────────────────────────

interface Enabled<T> {
  /** The `seq` of the event that made this command necessary. */
  readonly seq: number;
  /** The node id, or a node-scoped key, that breaks a tie. */
  readonly id: string;
  readonly value: T;
}

/**
 * AC6. `(seq, id)` and nothing else — never the order a key happened to be
 * inserted into an object, which is stable within one process and not across
 * a checkpoint round trip.
 */
function sortByEnablement<T>(entries: readonly Enabled<T>[]): T[] {
  return [...entries]
    .sort(
      (left, right) =>
        left.seq - right.seq || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
    )
    .map((entry) => entry.value);
}

/**
 * The `seq` of the event that made a node ready: its last dependency
 * completing, or — for a node coming back from a backoff — the retry that was
 * scheduled for it. A root node at the start of a run has neither, and `0`
 * sorts it first, which is where it belongs.
 */
function enablingSeq(state: RunState, node: PlanNode): number {
  const current = nodeState(state, node.id);
  const own = current.status === 'awaiting-retry' ? current.updatedSeq : 0;
  const deps = node.deps.map((dep) => nodeState(state, dep).updatedSeq);
  return Math.max(own, ...deps, 0);
}

/** A node the plan names but no event has touched yet is not an error. */
function nodeState(state: RunState, id: NodeId | string): NodeState {
  return state.nodes[id] ?? initialNodeState();
}
