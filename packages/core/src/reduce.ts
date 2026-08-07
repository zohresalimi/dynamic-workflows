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
import { addConsumption } from './cost-rollup.ts';
import { isEventKind } from './event-payloads.ts';
import type { Event } from './events.ts';
import type { CriterionId, NodeId, PlanHash, RunId } from './ids.ts';
import { CHURN_WINDOW, type CompletedAttempt, type ReplanStreak } from './no-progress.ts';
import type { PlanGraph } from './plan-graph.ts';
import {
  initialNodeState,
  type LockState,
  lockKey,
  type NodeState,
  type NodeStatus,
  type RunState,
  type RunStatus,
} from './run-state.ts';

/** A node nothing is yet known about — see `initialNodeState`. */
const UNKNOWN_NODE: NodeState = initialNodeState();

/** The statuses an attempt does not come back from. */
const TERMINAL_NODE_STATUSES: readonly NodeStatus[] = ['completed', 'failed', 'cancelled'];

/** A transition's answer. `null` is "this event changed nothing" — see the watermark. */
type Transition = RunState | null;

/**
 * The one kind that is *derived from* the watermark, and therefore may not
 * advance it (KAR-06.8 AC2).
 *
 * `run.stalled` says "the projection has not moved since seq N". Folding it is
 * necessary — the seq it names is how the next tick knows the episode has
 * already been reported — but letting it move the watermark would end the very
 * episode it describes, and the run would be re-reported as freshly stalled
 * every ten minutes, for ever. It is the projection reading its own reflection,
 * and the fix is one line rather than a special case in the detector.
 */
const DERIVED_FROM_WATERMARK: readonly string[] = ['run.stalled'];

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
    ts: unknown;
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
  const ts = typeof envelope.ts === 'number' ? envelope.ts : state.watermarkTs;
  const runId =
    projected.runId ?? (typeof envelope.runId === 'string' ? (envelope.runId as RunId) : null);
  const advances = !DERIVED_FROM_WATERMARK.includes(envelope.kind);

  return {
    ...projected,
    runId,
    epoch,
    // Monotone by construction: `seq` is the total order of the system, and a
    // cursor that can go backwards is a cursor that can lie.
    watermarkSeq: advances ? Math.max(state.watermarkSeq, seq) : state.watermarkSeq,
    // Monotone for a different reason: `ts` is a wall clock, and a laptop that
    // stepped its clock backwards mid-run must not be able to make the run look
    // like it progressed earlier than it did — which is what would let a stall
    // go unreported for as long as the step was large.
    watermarkTs: advances ? Math.max(state.watermarkTs, ts) : state.watermarkTs,
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
  const rawTs: unknown = (event as { ts?: unknown }).ts;
  const ts = typeof rawTs === 'number' ? rawTs : 0;

  switch (event.kind) {
    // `cwd` is the repository the run executes against, and it is folded here
    // rather than read from the daemon's process because F5.2's write lock is
    // keyed on it: a scheduler that asked `process.cwd()` would key the lock
    // differently during a replay than it did live.
    case 'run.created': {
      const repoRoot = event.payload.cwd;
      return state.runId === event.runId &&
        state.status === 'created' &&
        state.repoRoot === repoRoot
        ? null
        : { ...state, runId: event.runId, status: 'created', repoRoot };
    }

    case 'run.spec.approved':
      return withStatus(state, 'spec-approved');

    case 'run.started': {
      const planHash = event.payload.planHash;
      if (state.status === 'running' && state.planHash === planHash) return null;
      // §11.4's `maxRunWallClock` runs from here, and only from the first one:
      // a `run.started` folded a second time is a re-adoption of a plan, not a
      // second birth, and restarting the clock would make the cap forgive
      // everything that came before it (KAR-06.8 AC8).
      const startedTs = state.startedTs === 0 ? ts : state.startedTs;
      return withActivePlan({ ...state, status: 'running', planHash, startedTs }, planHash);
    }

    // F4.4: pause is an event and never an in-memory flag, because a flag does
    // not survive the restart it exists to protect against.
    case 'run.paused':
      return withStatus(state, 'paused');

    // F4.4's other half, and KAR-14.2 AC4's: a resume is the human's answer, so
    // it clears the ask as well as the pause. Leaving `needsHuman` set would
    // make a resumed run one `decide()` halts on for ever — the operator raised
    // the ceiling, said continue, and nothing moved.
    case 'run.resumed':
      return state.status === 'running' && state.needsHuman === null
        ? null
        : { ...state, status: 'running', needsHuman: null };

    // KAR-06.7. The *mode* is folded, not just the status: `decide()` has two
    // inputs, so the only way it can tell a cooperative ladder from a forceful
    // one after a restart is for the projection to carry it. A later request
    // replaces an earlier one — an escalation from cooperative to forceful is
    // the operator saying "stop asking nicely", and a sticky first answer would
    // ignore them.
    case 'run.cancel.requested': {
      const cancel = { mode: event.payload.mode, requestedSeq: seq };
      if (
        state.status === 'cancelling' &&
        state.cancel?.mode === cancel.mode &&
        state.cancel.requestedSeq === cancel.requestedSeq
      ) {
        return null;
      }
      return { ...(withStatus(state, 'cancelling') ?? state), cancel };
    }

    case 'run.completed':
      return endRun(state, 'completed', event.payload.outcome, event.payload.criteriaSatisfied);

    case 'run.aborted':
      return endRun(state, 'aborted', event.payload.outcome, event.payload.criteriaSatisfied);

    // F4.7 is surfaced, never auto-killed: a long build and a wedged agent look
    // identical from here. What *is* recorded is which episode has already been
    // reported, so the next tick does not report it again (KAR-06.8 AC2) — and
    // recording it must not advance the watermark, which is what
    // `DERIVED_FROM_WATERMARK` above guarantees.
    case 'run.stalled': {
      const episode = event.payload.watermarkSeq;
      return state.stalledAtSeq === episode ? null : { ...state, stalledAtSeq: episode };
    }

    case 'run.needs_human': {
      // A paused run that also needs a human is still **paused** (KAR-14.2
      // AC5): pause is the stronger statement about admission and the one a
      // resume reverses, and F4.6's trip appends both. Both facts are kept —
      // the status says paused, `needsHuman` says why — so a restart
      // reconstructs the pause rather than a needs-human run nobody can resume.
      const flagged =
        state.status === 'paused' ? state : (withStatus(state, 'needs-human') ?? state);
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
          replans: replanned(state, event.payload.version),
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
        // Absent means the main checkout, and it must not un-assign a worktree
        // a previous `node.scheduled` already named — a re-schedule that
        // resolved only the provider would otherwise silently drop the lock
        // key the node is serialised on.
        worktree: event.payload.worktree ?? current.worktree,
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
        // KAR-14.2. The instant a per-node wall-clock ceiling is measured from,
        // and it is the *first* start rather than this one: three attempts that
        // burned ten minutes between them burned ten minutes.
        startedTs: current.startedTs === 0 ? ts : current.startedTs,
        // The request hash describes an attempt, not a node: a new attempt has
        // not asked for anything yet, and inheriting the previous attempt's
        // digest would let the churn window count work that was never redone.
        requestHash: event.payload.attempt > current.attempt ? null : current.requestHash,
        wakeAt: null,
      }));

    // F10.1/F10.6 — cheap, frequent, and deliberately not a state change: this
    // is the single line that keeps the stall detector meaningful (AC6).
    case 'node.progress':
      return null;

    case 'node.completed': {
      const node = event.payload.node;
      const attempt = event.payload.attempt;
      const asked = (state.nodes[node] ?? UNKNOWN_NODE).requestHash;
      const closed = withNode(state, seq, node, (current) => ({
        ...current,
        ...attemptOf(current, attempt),
        status: 'completed',
        result: event.payload.result,
        failure: null,
        suspension: null,
        wakeAt: null,
      }));
      if (closed === null) return null;

      // §11.3's window is of *completed attempts*, not of events and not of
      // seconds, which is why it is appended to here and nowhere else.
      return {
        ...closed,
        churnWindow: slideWindow(closed.churnWindow, {
          node,
          requestHash: asked,
          attempt,
          seq,
        }),
      };
    }

    case 'node.failed':
      return withNode(state, seq, event.payload.node, (current) => ({
        ...current,
        ...attemptOf(current, event.payload.attempt),
        status: 'failed',
        failure: event.payload.failure,
        suspension: null,
      }));

    // KAR-06.7 AC9. Terminal, like `node.completed` and `node.failed`, and for
    // the property that matters most here: a node that is no longer `running`
    // is a node whose locks the next `decide()` reclaims. A cancelled attempt
    // that stayed `running` in the projection would hold the repository write
    // lock for ever, and the next run would block on a node nobody is waiting
    // for.
    //
    // A node that already reached a terminal status is left alone. That is not
    // defensive coding, it is the kill switch's real race: `decide()` returns a
    // `CancelNode`, the node completes while the ladder is being climbed, and
    // the driver's terminal record lands after it. Overwriting the completion
    // would discard a result the run has already paid for and tell every
    // dependent node that its dependency never finished.
    case 'node.cancelled':
      return withNode(state, seq, event.payload.node, (current) =>
        TERMINAL_NODE_STATUSES.includes(current.status)
          ? current
          : {
              ...current,
              ...attemptOf(current, event.payload.attempt),
              status: 'cancelled',
              failure: null,
              suspension: null,
              wakeAt: null,
            },
      );

    // The rungs of the ladder and the report of a kill that did not take are
    // evidence for a human, not scheduling input: `decide()` reads the run's
    // `cancel` and the node's status, and nothing else about cancellation.
    case 'node.cancel.stage':
    case 'node.cancel.failed':
    // KAR-08.6 AC6 is the run-scoped version of the same thing: the operator
    // has to be told which pids outlived the kill switch, and `decide()` has
    // nothing to do about it — a process DeFlow cannot signal is not a
    // scheduling problem it can solve by scheduling differently.
    case 'run.kill_failed':
      return null;

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
        // KAR-06.6. A suspension with a deadline is a `node_wake` row and
        // nothing else — a six-hour human gate, a poll for an external signal
        // and a 2-second retry backoff all reach `decide()` through this one
        // field. The payload carries the instant as ISO-8601 and the
        // projection as an integer ms epoch; both are instants rather than
        // durations, because a duration is only meaningful relative to a
        // process that is still running, and the point of the row is to
        // outlive one that is not.
        wakeAt: suspensionWakeAt(event.payload.until.wakeAt) ?? current.wakeAt,
      }));

    /**
     * KAR-07.6 AC6. A detected conflict is a scheduling demotion, not a
     * failure and not a result: nothing about the node's attempt, its
     * suspension or its retry budget changes, only its admissibility.
     *
     * A node that already reached a terminal status is left alone, for the
     * same race `node.cancelled` documents next door — the probe runs on the
     * back of a commit, and the node can complete while its own commit is
     * still being probed. Recording a completed node as blocked would hold a
     * conflict against work that is already done.
     */
    case 'node.blocked':
      return withNode(state, seq, event.payload.node, (current) =>
        TERMINAL_NODE_STATUSES.includes(current.status)
          ? current
          : { ...current, status: 'blocked' },
      );

    /**
     * KAR-08.1 AC4. Deliberately no status transition: the refusal is a fact
     * about the *decision*, and the `node.failed` written in the same breath
     * is what moves the node. Transitioning here too would give the same
     * transition two authors, and the second one would win by ordering.
     */
    case 'node.unschedulable':
      return null;

    /**
     * KAR-08.2 AC7/AC8. Also no transition, and for a stronger reason than
     * above: a denial is explicitly **not** a failure. The agent receives the
     * rejection and carries on, so a node that had one is still running, and
     * anything that moved it here would turn "the safety model worked" into
     * "the node broke".
     */
    case 'permission.denied':
      return null;

    /**
     * KAR-08.7 AC3. Also evidence, not run state, and for the same reason as
     * `permission.denied` above: D14 makes a declared-scope violation a
     * warning, never a gate, so nothing about scheduling may change because
     * one landed. A node that triggers this is still `completed`.
     */
    case 'node.scope_warning':
      return null;

    /**
     * KAR-08.4 AC6 — evidence for the node inspector and the run report, not
     * run state: nothing about scheduling changes because a variable reached
     * the child, and the ledger scan for its *value* is a property of the
     * schema (no `value` field exists to find), not of anything reduced here.
     */
    case 'env.declared':
      return null;

    /**
     * KAR-08.8 — evidence for the run report and the cost report, not run
     * state: the effective auth mode a provider ran under does not change
     * what is schedulable, and recording it here would give the same fact a
     * second, disagreeable home (docs/15-security-model.md §2.3).
     */
    case 'provider.auth_mode':
    case 'provider.auth_shadow_stripped':
      return null;

    /**
     * KAR-08.5 AC6 — also evidence rather than run state. A degraded key does
     * not change what is schedulable: the disposition that produced it already
     * did that, by either omitting the key or refusing the node outright, and
     * a second decision here would be able to disagree with the first.
     */
    case 'sandbox.degraded':
      return null;

    /**
     * The effect journal is its own table (§8.3) and its own read model — a
     * memoised effect *result* is not run state, and duplicating it here would
     * give the same fact two homes that can disagree.
     *
     * The one field taken off it is `requestHash`, and only for the attempt's
     * first effect. It is not a copy of the journal: it is the churn breaker's
     * sole input that cannot be recomputed inside `decide()`, because the
     * digest is asynchronous and `decide` is a synchronous function of state
     * and `now` (KAR-06.8 AC5). A later ordinal in the same attempt does not
     * overwrite it — an agent node's first effect is the agent invocation, and
     * the git commit that follows it is not what was asked for.
     */
    case 'effect.started': {
      const node = event.nodeId;
      const attempt = event.attempt;
      if (node === undefined || attempt === undefined) return null;
      return withNode(state, seq, node, (current) => {
        if (attempt < current.attempt) return current;
        if (attempt === current.attempt && current.requestHash !== null) return current;
        return {
          ...current,
          ...attemptOf(current, attempt),
          requestHash: event.payload.requestHash,
        };
      });
    }

    case 'effect.completed':
    case 'effect.failed':
    case 'effect.cancelled':
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

    /**
     * KAR-14.1 — the one accounting record, folded into the one accounting
     * projection. There is no second mutable table and no running total in the
     * daemon, which is what makes the rollup survive a `kill -9` for free
     * (EPIC-14-S6).
     */
    case 'budget.consumed':
      return {
        ...state,
        budget: addConsumption(state.budget, {
          node: event.payload.node ?? null,
          attempt: event.payload.attempt ?? null,
          provider: event.payload.provider,
          usage: event.payload.usage,
          costUsd: event.payload.costUsd,
          authMode: event.payload.authMode,
        }),
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
              ...(event.payload.node === undefined ? {} : { node: event.payload.node }),
              dimension: event.payload.dimension,
              limit: event.payload.limit,
              actual: event.payload.actual,
              firedBy: event.payload.firedBy,
            },
          ],
        },
      };

    /**
     * KAR-14.2 AC1 — the ceiling in force, from this seq onwards.
     *
     * The same event sets the ceiling at run creation and raises it afterwards,
     * because both are the same fact. Folding it here rather than reading
     * `.DeFlow/config.yaml` per tick is what makes a mid-run edit to that file
     * unable to move a ceiling silently, and what makes a raised ceiling
     * survive the restart that so often follows the pause it answered.
     */
    case 'budget.ceiling.set': {
      const ceiling = {
        costUsd: event.payload.costUsd,
        wallclockMs: event.payload.wallclockMs,
      };
      const ceilings = state.ceilings;
      if (event.payload.scope === 'run') {
        return { ...state, ceilings: { ...ceilings, run: ceiling, hash: event.payload.hash } };
      }
      const node = event.payload.node;
      return {
        ...state,
        ceilings: {
          ...ceilings,
          ...(node === undefined
            ? { node: ceiling }
            : { nodes: { ...ceilings.nodes, [node]: ceiling } }),
          hash: event.payload.hash,
        },
      };
    }

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

/**
 * KAR-06.8 §11.3. Appends one completed attempt and drops whatever falls off
 * the front, so the window is `CHURN_WINDOW` entries at its widest and
 * `run.state_json` costs the same whether the run has ten attempts behind it or
 * ten thousand.
 */
function slideWindow(
  window: readonly CompletedAttempt[],
  entry: CompletedAttempt,
): readonly CompletedAttempt[] {
  return [...window, entry].slice(-CHURN_WINDOW);
}

/**
 * KAR-06.8 §11.3. The replan streak after one more `plan.patched`.
 *
 * A replan that follows real progress restarts the count *from itself* rather
 * than zeroing it: the planner patching a plan on the back of a completed node
 * is doing its job, and the next two flat patches after it are two, not three.
 * `completed` is therefore the count as of the replan the streak began at, and
 * the comparison is against that rather than against the previous patch —
 * three patches that each fail to move a count of 7 are the deck chairs §11.3
 * names, whichever order the nodes finished in.
 */
function replanned(state: RunState, version: number): ReplanStreak {
  const completed = Object.values(state.nodes).filter((node) => node.status === 'completed').length;
  const streak = state.replans;

  if (completed > streak.completed) return { flat: 1, completed, versions: [version] };

  return {
    flat: streak.flat + 1,
    completed,
    versions: [...streak.versions, version].slice(-MAX_STREAK_VERSIONS),
  };
}

/** See `no-progress.ts`: the streak trips long before this, so the bound only
 * matters to a run whose detectors are switched off. */
const MAX_STREAK_VERSIONS = 8;

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

/**
 * KAR-06.6. A suspension's deadline as the integer ms epoch the `node_wake`
 * row stores, or `null` for an indefinite wait — a human gate with no timeout
 * is woken by `human.responded`, not by the ticker, and giving it a wake row
 * would poll a question nobody has answered.
 *
 * `Date.parse` is arithmetic over a string, not a clock read: the same input
 * yields the same number in this process, in a replay and on another machine,
 * which is the only property the purity rule is protecting. An unparseable
 * instant reads as absent rather than as `NaN`, so a payload from a newer
 * DeFlowd degrades the projection instead of poisoning every comparison
 * against it — `NaN > now` is false, which would silently mean "due now".
 */
function suspensionWakeAt(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : null;
}

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
