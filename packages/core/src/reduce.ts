/**
 * KAR-03.5 — the reducer: one pure, total function folding events into
 * `RunState` (docs/05-durable-execution.md §3 primitive 2 and §4,
 * docs/04-domain-model.md §9.2).
 *
 * Three rules govern every line below, and all three are load-bearing:
 *
 * 1. **Unknown kinds return `state` itself.** Not a copy, not a throw, not an
 *    `assertNever`. A user who installs a newer DeFlowd, starts a run, then
 *    downgrades must get a degraded projection rather than a crash loop — this
 *    is the single forward-compatibility mechanism in the system, and the
 *    reference-equality check in ./reduce.test.ts is what keeps it honest.
 * 2. **No I/O, no clock, no randomness.** `Date.now()` inside a fold would
 *    make replay produce a different answer than the live run did, which is
 *    the one thing an event-sourced system may never do. Instants arrive
 *    *inside payloads* (`wakeAt`, `at`), where they are as immutable as any
 *    other recorded fact.
 * 3. **The version never reaches here.** Upcasting happens on the way in
 *    (./fold-events.ts → ./events.ts → ./upcasters.ts), so this file branches
 *    on `kind` and on nothing else. ../test/reducer-structure.test.ts fails
 *    the build if a version comparison appears.
 *
 * The progress watermark falls out of the same design rather than being
 * maintained: it is the `seq` of the last event that *changed* the projection,
 * so a transition that returns "no change" — `node.progress`, and every byte
 * of agent output, which lives in the data plane and never reaches a reducer
 * at all — cannot advance it. That is what makes F4.7's stall detector
 * meaningful without a line of code written for it.
 *
 * Verifies: EPIC-03-S15, EPIC-03-S16, EPIC-03-S17 · AC1, AC2, AC3, AC5, AC6,
 * AC7, AC8
 */
import { isEventKind } from './event-payloads.ts';
import type { Event } from './events.ts';
import type { CriterionId, NodeId, PlanHash, RunId } from './ids.ts';
import type { PlanGraph } from './plan-graph.ts';
import {
  initialNodeState,
  type LockState,
  lockKey,
  type NodeState,
  type RunState,
  type RunStatus,
} from './run-state.ts';
import { sumUsage, type TokenUsage, type UsageTotals } from './token-usage.ts';

/** A node nothing is yet known about — see `initialNodeState`. */
const UNKNOWN_NODE: NodeState = initialNodeState();

/** A transition's answer. `null` is "this event changed nothing" — see the watermark. */
type Transition = RunState | null;

/**
 * Folds one event into `state`.
 *
 * Total: every input returns a `RunState`, including an event kind this build
 * has never heard of, including an object that never came from `parseEvent`.
 * Pure: neither argument is mutated, and nothing outside them is read.
 */
export function reduce(state: RunState, event: Event): RunState {
  const envelope = event as Partial<{
    kind: unknown;
    payload: unknown;
    seq: unknown;
    epoch: unknown;
    runId: unknown;
  }>;

  // Rule 1, first and unconditionally: a kind this build does not know is
  // data to be skipped, and skipping it must not move the projection in *any*
  // respect — not the epoch, not the watermark, not a counter.
  if (typeof envelope.kind !== 'string' || !isEventKind(envelope.kind)) return state;
  // Every payload in the §9 table is an object. Anything else did not come
  // through parseEvent, and totality means answering it rather than throwing.
  if (envelope.payload === null || typeof envelope.payload !== 'object') return state;

  const epoch = typeof envelope.epoch === 'number' ? envelope.epoch : state.epoch;
  // AC8. A write from a fenced-out daemon is ignored and counted, never
  // applied: the counter is what turns "we think this cannot happen" into a
  // number KAR-03.7 can put in front of someone.
  if (epoch < state.epoch) {
    return { ...state, staleEpochSkipped: state.staleEpochSkipped + 1 };
  }

  const projected = project(state, event);
  if (projected === null) {
    // Nothing was projected, so the watermark stays where it is. The epoch is
    // envelope bookkeeping rather than part of the projection, which is why it
    // may move on an event that changed nothing else.
    return epoch > state.epoch ? { ...state, epoch } : state;
  }

  const seq = typeof envelope.seq === 'number' ? envelope.seq : state.watermarkSeq;
  const runId =
    projected.runId ?? (typeof envelope.runId === 'string' ? (envelope.runId as RunId) : null);

  return {
    ...projected,
    runId,
    epoch,
    // Monotone by construction: `seq` is the total order of the system, and a
    // cursor that can go backwards is a cursor that can lie.
    watermarkSeq: Math.max(state.watermarkSeq, seq),
  };
}

/**
 * The per-kind transitions. Returns `null` when the event leaves the
 * projection exactly as it was, which is how the watermark stays honest.
 *
 * The order of the cases is the order of docs/04-domain-model.md §9's table,
 * so the two can be read side by side.
 */
function project(state: RunState, event: Event): Transition {
  // Read defensively for the same reason `reduce` does: totality means an
  // envelope that never came through `parseEvent` is answered, not thrown at.
  const rawSeq: unknown = (event as { seq?: unknown }).seq;
  const seq = typeof rawSeq === 'number' ? rawSeq : 0;

  switch (event.kind) {
    case 'run.created':
      return state.runId === event.runId && state.status === 'created'
        ? null
        : { ...state, runId: event.runId, status: 'created' };

    case 'run.spec.approved':
      return withStatus(state, 'spec-approved');

    case 'run.started': {
      const planHash = event.payload.planHash;
      if (state.status === 'running' && state.planHash === planHash) return null;
      return withActivePlan({ ...state, status: 'running', planHash }, planHash);
    }

    // F4.4: pause is an event and never an in-memory flag, because a flag does
    // not survive the restart it exists to protect against.
    case 'run.paused':
      return withStatus(state, 'paused');

    case 'run.resumed':
      return withStatus(state, 'running');

    case 'run.cancel.requested':
      return withStatus(state, 'cancelling');

    case 'run.completed':
      return endRun(state, 'completed', event.payload.outcome, event.payload.criteriaSatisfied);

    case 'run.aborted':
      return endRun(state, 'aborted', event.payload.outcome, event.payload.criteriaSatisfied);

    // F4.7 is surfaced, never auto-killed — and it is *derived* from the
    // watermark, so recording it would be the projection reading its own
    // reflection. A long build and a wedged agent look identical from here.
    case 'run.stalled':
      return null;

    case 'run.needs_human': {
      const flagged = withStatus(state, 'needs-human') ?? state;
      return {
        ...flagged,
        needsHuman: { reason: event.payload.reason, detail: event.payload.detail },
      };
    }

    // The plan the run *executes* comes from run.started and plan.patched. A
    // proposal only allocates ids: §1.1's registry lives in the ledger, not in
    // a counter in memory, and it is rebuilt from here on every replay.
    case 'plan.proposed':
      return withPlanNodes(
        { ...state, planVersion: Math.max(state.planVersion, event.payload.version) },
        event.payload.graph,
      );

    case 'plan.patch.proposed':
    case 'plan.patch.rejected':
      // F2.4 records the proposal and the rejection precisely so that neither
      // changes state. The audit trail is the event, not the projection.
      return null;

    case 'plan.patched':
      return withActivePlan(
        {
          ...state,
          planHash: event.payload.toHash,
          planVersion: Math.max(state.planVersion, event.payload.version),
        },
        event.payload.toHash,
      );

    case 'node.scheduled':
      return withNode(state, seq, event.payload.node, (current) => ({
        ...current,
        status: 'scheduled',
        provider: event.payload.provider,
        model: event.payload.model ?? null,
        permission: event.payload.permission,
      }));

    // F5.2: the repo write lock lives in the ledger, so it survives a restart
    // instead of evaporating with a JavaScript Map.
    case 'node.lock.acquired':
      return withLock(state, {
        lock: event.payload.lock,
        key: event.payload.key,
        node: event.payload.node,
        sinceSeq: event.seq,
      });

    case 'node.lock.released':
      return withoutLock(state, event.payload.lock, event.payload.key);

    case 'node.started':
      return withNode(state, seq, event.payload.node, (current) => ({
        ...current,
        ...attemptOf(current, event.payload.attempt),
        status: 'running',
        failure: null,
        suspension: null,
        wakeAt: null,
      }));

    // F10.1/F10.6 — cheap, frequent, and deliberately not a state change: this
    // is the single line that keeps the stall detector meaningful (AC6).
    case 'node.progress':
      return null;

    case 'node.completed':
      return withNode(state, seq, event.payload.node, (current) => ({
        ...current,
        ...attemptOf(current, event.payload.attempt),
        status: 'completed',
        result: event.payload.result,
        failure: null,
        suspension: null,
        wakeAt: null,
      }));

    case 'node.failed':
      return withNode(state, seq, event.payload.node, (current) => ({
        ...current,
        ...attemptOf(current, event.payload.attempt),
        status: 'failed',
        failure: event.payload.failure,
        suspension: null,
      }));

    case 'node.retry.scheduled':
      return withNode(state, seq, event.payload.node, (current) => ({
        ...current,
        status: 'awaiting-retry',
        // The attempt has not happened yet, so `attempt` does not move; only
        // the ceiling does, and only upwards.
        attempts: Math.max(current.attempts, event.payload.nextAttempt),
        wakeAt: event.payload.wakeAt,
      }));

    case 'node.suspended':
      return withNode(state, seq, event.payload.node, (current) => ({
        ...current,
        status: 'suspended',
        suspension: event.payload.until,
      }));

    // The effect journal is its own table (§8.3) and its own read model: a
    // memoised effect result is not run state, and duplicating it here would
    // give the same fact two homes that can disagree.
    case 'effect.started':
    case 'effect.completed':
    case 'effect.failed':
      return null;

    // Context is rebuilt per attempt from the ledger (F6.x); the packet record
    // is evidence, not state the scheduler reads.
    case 'context.built':
    case 'context.compacted':
    case 'pin.integrity_violated':
      return null;

    // The blackboard is a projection of its own (KAR-09.8), deliberately kept
    // out of `RunState`: the moment it has a second home it starts lying.
    case 'fact.written':
    case 'fact.read':
    case 'fact.invalidated':
    case 'handoff.oversize':
      return null;

    // F7.4: which criteria are actually satisfied is a run-level fact, and it
    // is what `run.completed`'s `partial` outcome is measured against.
    case 'gate.evaluated':
      return withCriteria(
        state,
        event.payload.verdict.criteria
          .filter((criterion) => criterion.status === 'satisfied')
          .map((criterion) => criterion.id),
      );

    case 'human.requested':
      return withNode(state, seq, event.payload.node, (current) => ({
        ...current,
        status: 'suspended',
        suspension: { kind: 'human' },
      }));

    case 'human.responded':
      return withNode(state, seq, event.payload.node, (current) =>
        current.status === 'suspended'
          ? { ...current, status: 'running', suspension: null, wakeAt: null }
          : current,
      );

    case 'budget.consumed':
      return {
        ...state,
        budget: {
          ...state.budget,
          costUsd: addMoney(state.budget.costUsd, event.payload.costUsd),
          usage: addUsage(state.budget.usage, event.payload.usage),
        },
      };

    // F4.6 pauses the run rather than failing it — and the pause arrives as
    // its own `run.paused` event, because that is the only kind of pause that
    // survives a restart.
    case 'budget.exceeded':
      return {
        ...state,
        budget: {
          ...state.budget,
          breaches: [
            ...state.budget.breaches,
            {
              scope: event.payload.scope,
              dimension: event.payload.dimension,
              limit: event.payload.limit,
              actual: event.payload.actual,
            },
          ],
        },
      };

    // Provider capabilities and rate-limit frames are per-binary facts read
    // from the probe cache, not per-run state; an export decision is an
    // outcome of F5.9's redaction pass and belongs to the export, not the run.
    case 'provider.probed':
    case 'provider.rate_limited':
    case 'export.blocked':
      return null;

    default:
      // Unreachable: `isEventKind` guarded the entrance. It is `return state`
      // rather than `assertNever` on purpose — see rule 1.
      return null;
  }
}

/** Only a real change is a change: an idempotent repeat returns `null`. */
function withStatus(state: RunState, status: RunStatus): Transition {
  return state.status === status ? null : { ...state, status };
}

function endRun(
  state: RunState,
  status: RunStatus,
  outcome: RunState['outcome'],
  criteria: readonly CriterionId[],
): Transition {
  const withOutcome = withCriteria(state, criteria) ?? state;
  return { ...withOutcome, status, outcome };
}

function withCriteria(state: RunState, criteria: readonly CriterionId[]): Transition {
  const added = criteria.filter((criterion) => !state.criteriaSatisfied.includes(criterion));
  if (added.length === 0) return null;
  // Append rather than sort: the order criteria were satisfied in is itself
  // information, and it is stable across a replay because `seq` is.
  return { ...state, criteriaSatisfied: [...state.criteriaSatisfied, ...dedupe(added)] };
}

const dedupe = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** `attempt` is the observed index; `attempts` is derived from it, never counted. */
function attemptOf(current: NodeState, attempt: number): Pick<NodeState, 'attempt' | 'attempts'> {
  return {
    attempt: Math.max(current.attempt, attempt),
    attempts: Math.max(current.attempts, attempt + 1),
  };
}

function withNode(
  state: RunState,
  seq: number,
  id: NodeId,
  patch: (current: NodeState) => NodeState,
): Transition {
  const current = state.nodes[id] ?? UNKNOWN_NODE;
  const next = patch(current);
  const known = state.nodes[id] !== undefined;
  if (known && sameNode(current, next)) return null;

  return {
    ...state,
    // `updatedSeq` is stamped here rather than by each transition, and only on
    // the path where something else changed: an event that leaves the node
    // exactly as it was returned above, so it moves neither the run's
    // watermark nor the node's.
    nodes: { ...state.nodes, [id]: { ...next, updatedSeq: Math.max(next.updatedSeq, seq) } },
    // A node the run has touched is an id the run has allocated (§1.1),
    // whether or not a `plan.proposed` was ever folded.
    nodeIds: known ? state.nodeIds : allocate(state, id),
  };
}

/**
 * Every field but `updatedSeq`, which is bookkeeping about the fold rather
 * than part of the projection — comparing it would make every event look like
 * a change and quietly turn the watermark into an event counter.
 */
function sameNode(left: NodeState, right: NodeState): boolean {
  if (left === right) return true;
  const keys = (Object.keys(left) as (keyof NodeState)[]).filter((key) => key !== 'updatedSeq');
  return keys.every((key) => Object.is(left[key], right[key]));
}

function allocate(state: RunState, id: NodeId): RunState['nodeIds'] {
  if (state.nodeIds.active.includes(id) || state.nodeIds.retired.includes(id)) {
    return state.nodeIds;
  }
  return { ...state.nodeIds, active: [...state.nodeIds.active, id] };
}

/**
 * The plan's own view of which ids exist. An id that leaves the active plan is
 * retired rather than dropped, and `retired` never shrinks: the effect
 * journal's idempotency key is `(runId, nodeId, attempt, ordinal)`, so a
 * reused id hands a node a memoised result belonging to a different one.
 *
 * The graph itself is held too, because `decide(state, now)` reads `deps`,
 * `lifecycle` and `retry` off it and is not allowed a third input (NF9). It is
 * held as a *proposal* until an event activates it: §9 is explicit that the
 * plan a run executes comes from `run.started` and `plan.patched`, never from
 * the act of proposing one.
 */
function withPlanNodes(state: RunState, graph: PlanGraph): Transition {
  const proposed = graph.nodes.map((node) => node.id);
  const retiring = state.nodeIds.active.filter((id) => !proposed.includes(id));
  const active = dedupe([
    ...state.nodeIds.active.filter((id) => proposed.includes(id)),
    ...proposed.filter((id) => !state.nodeIds.retired.includes(id)),
  ]);
  const retired = dedupe([...state.nodeIds.retired, ...retiring]);
  const held = state.plan?.planHash === graph.planHash;

  return {
    ...state,
    nodeIds: { active, retired },
    proposedPlans: held ? state.proposedPlans : { ...state.proposedPlans, [graph.planHash]: graph },
  };
}

/**
 * Promotes the proposal `planHash` names into the executing plan, and empties
 * the waiting room — every other proposal was either superseded or rejected,
 * and keeping them would grow `run.state_json` by one plan document per
 * replan for no reader.
 *
 * A hash with no proposal folded (an older binary, a truncated ledger) leaves
 * the previous graph in place rather than clearing it: a scheduler with no
 * plan schedules nothing, and silently stopping a run is a worse answer than
 * continuing on the last plan the ledger could actually prove.
 */
function withActivePlan(state: RunState, planHash: PlanHash): RunState {
  const activated = state.proposedPlans[planHash];
  if (activated === undefined) {
    return Object.keys(state.proposedPlans).length === 0 ? state : { ...state, proposedPlans: {} };
  }
  return { ...state, plan: activated, proposedPlans: {} };
}

function withLock(state: RunState, lock: LockState): Transition {
  const key = lockKey(lock.lock, lock.key);
  const held = state.locks[key];
  // Re-acquiring a lock you already hold keeps the `seq` you took it at: the
  // lock has been held since then, and a refreshed timestamp would hide it.
  if (held !== undefined && held.node === lock.node) return null;

  return { ...state, locks: { ...state.locks, [key]: lock } };
}

function withoutLock(state: RunState, lock: string, key: string): Transition {
  const held = lockKey(lock, key);
  if (state.locks[held] === undefined) return null;

  const { [held]: _released, ...remaining } = state.locks;
  return { ...state, locks: remaining };
}

/**
 * Money to the micro-dollar. Token prices are quoted per million tokens, so
 * six decimals is the smallest unit that is real; the rounding is what stops a
 * 2,000-event fold from accumulating `8.610000000000001` in a snapshot.
 */
const addMoney = (total: number, amount: number): number =>
  Math.round((total + amount) * 1_000_000) / 1_000_000;

/**
 * Vendor-reported and estimated totals stay apart all the way to the chart
 * (§8). `sumUsage` is the only function allowed to add two usages, and it
 * refuses to add across sources — a mixed total is not a slightly-wrong
 * number, it is a number with no meaning.
 */
function addUsage(totals: UsageTotals, usage: TokenUsage): UsageTotals {
  const contributions: TokenUsage[] = [];
  if (totals.vendorReported !== null) contributions.push(totals.vendorReported);
  if (totals.estimated !== null) contributions.push(totals.estimated);
  contributions.push(usage);
  return sumUsage(contributions);
}
