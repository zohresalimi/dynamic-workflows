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
import { isVerdictVoid } from './acceptance-board.ts';
import { addConsumption } from './cost-rollup.ts';
import type { EventPayloadOf } from './event-payloads.ts';
import { isEventKind } from './event-payloads.ts';
import type { Event } from './events.ts';
import { type HumanGateState, humanGateWakeAt } from './human-gate.ts';
import type { CriterionId, NodeId, PlanHash, RunId } from './ids.ts';
import {
  CHURN_WINDOW,
  type CompletedAttempt,
  INITIAL_REPLAN_STREAK,
  type ReplanStreak,
} from './no-progress.ts';
import type { PlanGraph } from './plan-graph.ts';
import type { ProposedBy } from './plan-patch.ts';
import {
  initialNodeState,
  type LockState,
  lockKey,
  type NodeState,
  type NodeStatus,
  type RunState,
  type RunStatus,
} from './run-state.ts';
import { SPEC_GATE_NODE } from './spec-approval.ts';

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
    // KAR-10.1: intake's one event. It carries the raw task and its
    // provenance for the ledger to answer "what did I actually ask for?" —
    // nothing in it is projection state. `run.created` (below) is what moves
    // `RunState`, once framing has produced a spec to run against.
    case 'task.submitted':
      return null;

    // `cwd` is the repository the run executes against, and it is folded here
    // rather than read from the daemon's process because F5.2's write lock is
    // keyed on it: a scheduler that asked `process.cwd()` would key the lock
    // differently during a replay than it did live.
    case 'run.created': {
      const repoRoot = event.payload.cwd;
      const specHash = event.payload.spec.specHash;
      return state.runId === event.runId &&
        state.status === 'created' &&
        state.repoRoot === repoRoot &&
        state.specHash === specHash
        ? null
        : { ...state, runId: event.runId, status: 'created', repoRoot, specHash };
    }

    /**
     * KAR-10.3 AC5, AC8. An amendment moves the run's *current* identity and
     * touches nothing else — in particular it does not clear `specApproved`,
     * because a mid-run edit is the operator approving the edited spec in the
     * same breath (the daemon appends the approval beside it) and a projection
     * that un-approved the run here would stop the world between two rows of
     * one transaction.
     *
     * The pre-edit spec is untouched, as it must be: it is still
     * `run.created.spec`, still at `from`, and every verdict that cited it is
     * still addressable (EPIC-10-S29's last scenario).
     */
    case 'spec.amended':
      return state.specHash === event.payload.to ? null : { ...state, specHash: event.payload.to };

    /**
     * KAR-10.3 AC4 / KAR-10.4. The digests are evidence, not projection state:
     * what a packet re-injects is rebuilt from the spec by
     * `buildPinnedSegments`, and `assertPinIntegrity` compares the render
     * against this row in the ledger. Folding it would create a second copy of
     * the pinned set that could disagree with the first.
     */
    case 'spec.pinned':
      return null;

    /**
     * KAR-10.3 AC4. The approval is folded as a *fact* — which digest, approved
     * by which surface — and the status only advances from the gate.
     *
     * A run that is already `running` stays running: a mid-run edit re-approves
     * at the new hash (AC8) in the same transaction as the amendment, and a
     * transition back to `spec-approved` there would un-start a run that never
     * stopped, throwing away `planHash` in `withStatus`'s wake for a decision
     * that changed no plan.
     *
     * KAR-10.4 AC5 — **an approval at a new hash empties `criteriaSatisfied`.**
     * Every verdict in the ledger was formed against the contract that was in
     * force when it ran; moving the contract voids all of them at once
     * (EPIC-10-S29's third scenario), and the epic's notes are explicit that
     * the rule must not be softened by keeping the criteria whose text happens
     * not to have changed. The verdicts themselves are untouched and still
     * addressable at their own hash — this clears a *fold*, not history — and a
     * re-run at the new hash puts each row back as it earns it. Re-approving an
     * unchanged spec clears nothing, which is the same rule: nothing moved.
     *
     * KAR-12.4 AC6 — **and it empties `gateVerdicts` for the same reason.** The
     * criterion half and the ladder half of "void" have to move together: AC6
     * is one sentence — a verdict at a superseded hash "does not satisfy a
     * criterion, does not advance a milestone, and the gate is re-scheduled" —
     * and `gateVerdicts` is the only thing `decide()` reads to know a gate has
     * been answered. The `gate.evaluated` arm below already refuses a verdict
     * that *arrives* naming a hash nobody approved; that catches the impostor
     * and misses the ordinary case, because a mid-run edit arrives **after** the
     * greens it voids. Left standing, those greens keep their gates answered,
     * `decide()` schedules nothing, and the run walks the rest of the ladder on
     * verdicts about a contract it is no longer held to — while
     * `criteriaSatisfied` next door reports the same run as having satisfied
     * nothing. Clearing here is what makes each gate admissible again, which is
     * precisely EPIC-12-S27's "decide() re-schedules the review gate".
     */
    case 'run.spec.approved': {
      const approved = { specHash: event.payload.specHash, by: event.payload.by };
      const moves =
        state.specApproved !== null && state.specApproved.specHash !== approved.specHash;
      const same =
        state.specApproved?.specHash === approved.specHash && state.specApproved.by === approved.by;
      const advances = state.status === 'created' || state.status === 'awaiting-spec-approval';
      if (same && !advances) return null;
      const moved = advances ? { ...state, status: 'spec-approved' as RunStatus } : state;
      return {
        ...moved,
        specApproved: approved,
        ...(moves ? { criteriaSatisfied: [], gateVerdicts: {} } : {}),
      };
    }

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
        // KAR-13.2 AC1 — the `seq` travels with the reason, because the queue
        // orders on the seq of the event that *created* the item and deep-links
        // to it (NF10). Deriving it from the watermark afterwards would name
        // whichever event happened to land next.
        needsHuman: { reason: event.payload.reason, detail: event.payload.detail, seq },
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

    case 'plan.validation_failed':
      // 06 §3.5. A version that did not validate never became a plan: no row,
      // no ids allocated, nothing to promote. Recording it changes the ledger
      // and not the projection, which is what "diagnostics are events, not
      // exceptions" means at this end — the retry is scheduled by the compiler
      // from the returned diagnostics, not by a flag the reducer sets.
      return null;

    case 'plan.patched': {
      const patched = withActivePlan(
        {
          ...state,
          planHash: event.payload.toHash,
          planVersion: Math.max(state.planVersion, event.payload.version),
          replans: replanned(state, event.payload.version),
        },
        event.payload.toHash,
      );
      // `withActivePlan` always returns a state here — a plan.patched moves
      // `planHash`, so there is no "nothing changed" arm to fall through.
      return rescuedByHuman(patched, event.payload.proposedBy);
    }

    /**
     * KAR-11.4 AC10. The rule table this run is judged by, pinned once. The
     * *rules* are folded and not only their digest, which is what makes a
     * replay reach the decisions the run actually made rather than the ones
     * today's `.DeFlow/config.yaml` would produce.
     */
    case 'policy.patch.loaded':
      return {
        ...state,
        patchPolicy: {
          hash: event.payload.hash,
          source: event.payload.source,
          rules: event.payload.rules,
          drift: null,
        },
      };

    /**
     * The file on disk stopped matching. Nothing about the run's rules moves —
     * that is the whole point — so all this records is *which* on-disk digest
     * has already been reported, so the operator is told once per edit rather
     * than once per patch.
     */
    case 'policy.patch.drifted':
      return state.patchPolicy === null
        ? null
        : {
            ...state,
            patchPolicy: { ...state.patchPolicy, drift: event.payload.configHash },
          };

    case 'plan.patch.queued':
      // F8.3's queue is projected from the event log, not from the run
      // projection: a pending patch changes nothing about what `decide()` may
      // schedule, and *"the patch is pending, not the run"* is exactly that
      // sentence (06 §4.3).
      return null;

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

    /**
     * F7.4: which criteria are actually satisfied is a run-level fact, and it
     * is what `run.completed`'s `partial` outcome is measured against.
     *
     * KAR-10.4 AC5 — **and only against the spec now in force.** A verdict
     * carries the `specHash` it was judged under, and one that does not name
     * the run's current hash is void: not counted here, not counted on F7.4's
     * board, and its gate re-scheduled (./acceptance-board.ts). A verdict that
     * names none at all is void too — it cannot be shown to have judged this
     * contract, and "it did not say" is not a citation.
     *
     * A run whose spec was never approved counts nothing, which is the same
     * rule from the other side: F1.3 schedules no work before approval, so a
     * verdict that arrived before one is judging a draft.
     *
     * KAR-12.1 — the same event is also the ladder's only input. The outcome is
     * recorded against the gate's *own* node (`verdict.by.node`), which is what
     * `decide()` withholds the next tier on, and it is recorded under exactly
     * the same void test: a verdict that is not evidence about this contract
     * must not open a tier, and leaving no entry is what makes the gate
     * admissible again rather than answered.
     */
    case 'gate.evaluated': {
      const current = state.specApproved?.specHash;
      const verdict = event.payload.verdict;
      if (current === undefined || isVerdictVoid(verdict, current)) return null;
      const withGate: RunState = {
        ...state,
        gateVerdicts: {
          ...state.gateVerdicts,
          [verdict.by.node]: {
            gate: verdict.gate,
            outcome: verdict.outcome,
            seq: event.seq,
            // KAR-13.2 AC2 — a `needs-human` verdict is an approval-queue item,
            // and *"judge, or accept a red gate explicitly"* is not a decision
            // anybody can make from an outcome word. The findings and the
            // one-line summary travel into the projection so the queue carries
            // them without a second request; they are bounded by the gate's own
            // output and already in the ledger.
            summary: verdict.summary,
            findings: verdict.findings.map((finding) => ({ ...finding })),
          },
        },
      };
      // `withCriteria` answers `null` when it added nothing, which is the right
      // answer for the watermark and the wrong one here: a `fail` verdict
      // satisfies no criterion and is still the event that closes the ladder.
      return (
        withCriteria(
          withGate,
          verdict.criteria
            .filter((criterion) => criterion.status === 'satisfied')
            .map((criterion) => criterion.id),
        ) ?? withGate
      );
    }

    /**
     * KAR-10.3 AC1. Every `human.requested` suspends its node; the one on the
     * F1.3 gate node *also* moves the run, which is what makes
     * `awaiting-spec-approval` a fold of the log rather than a status somebody
     * set (EPIC-10-S13's third scenario).
     *
     * Keyed on the node id and not on the option set, because the options are
     * the operator's affordances and a future story is free to add a fifth. The
     * id is `SPEC_GATE_NODE` — one gate per run, so the projection can answer
     * "is the spec still waiting?" without scanning the log.
     *
     * A gate opened after an approval — a re-opened gate following an edit
     * (AC8) — moves the status back, which is correct: work stops until the
     * operator answers again. `specApproved` is left where it is; it records
     * what was approved, not whether anything is pending.
     */
    case 'human.requested': {
      const withGate = withHumanGate(state, seq, event.payload);
      const suspended =
        withNode(withGate, seq, event.payload.node, (current) => ({
          ...current,
          status: 'suspended',
          suspension: { kind: 'human' },
          // KAR-13.1 AC1, AC7. An open gate always has a `node_wake` row, and
          // its due time comes from the request rather than from whatever the
          // node was waiting for before. A gate that declares no deadline is
          // due at an instant no clock reaches — the row is what makes the
          // suspension durable and what answers *"why is this node asleep"*,
          // so it exists even for a wait nothing will ever fire. And an
          // `escalate` re-asks *without* a deadline, which has to clear the
          // original one: leaving it would make the row due on every tick for
          // ever, which is a spin loop wearing a suspension's name.
          wakeAt: humanGateWakeAt(event.payload.deadline ?? null),
        })) ?? withGate;
      if (event.payload.node !== SPEC_GATE_NODE) return suspended;
      return suspended.status === 'awaiting-spec-approval'
        ? suspended
        : { ...suspended, status: 'awaiting-spec-approval' };
    }

    /**
     * KAR-13.1 AC3, AC9. The answer closes the gate and resumes the node **on
     * the same attempt** — a human gate is not a retry, so nothing here touches
     * `attempt` and no idempotency key is minted.
     *
     * The gate entry is kept, now carrying its response: it is what a second
     * `respond` echoes in its `409` (AC9) and what *"the operator approved this
     * at 14:12"* is read from three days later. What *completes* the node is
     * the `node.completed` or `node.failed` appended in the same transaction —
     * this event records the decision, and the decision's consequence is a
     * transition the taxonomy already owns.
     */
    case 'human.responded': {
      const withGate = answerHumanGate(state, seq, event.payload);
      return (
        withNode(withGate, seq, event.payload.node, (current) =>
          current.status === 'suspended'
            ? { ...current, status: 'running', suspension: null, wakeAt: null }
            : current,
        ) ?? withGate
      );
    }

    /**
     * KAR-13.3 AC1, AC4, AC8, AC9. The correction is recorded and **nothing
     * else moves**: no attempt, no status, no cancellation. What `pause-and-inject`
     * changes is carried by the `node.suspended` appended beside it, in the same
     * transaction, and folded by the case that already owns that transition.
     *
     * Appended to the node's list rather than replacing it, because three
     * corrections typed before the next turn are three corrections. Coalescing
     * them would be indistinguishable, afterwards, from losing two.
     */
    case 'human.interjected':
      return {
        ...state,
        interjections: {
          ...state.interjections,
          [event.payload.node]: [
            ...(state.interjections[event.payload.node] ?? []),
            {
              seq,
              node: event.payload.node,
              text: event.payload.text,
              mode: event.payload.mode,
              delivery: event.payload.delivery,
            },
          ],
        },
      };

    /**
     * KAR-13.3 AC2, AC3, AC4, AC9. The receipt, folded onto the interjection it
     * delivers — and, for `pause-and-inject`, the end of the pause.
     *
     * The guidance reaches the node one of two ways: as a mid-turn
     * `session/prompt` on an adapter that advertises steering, or as a segment
     * in the re-assembled packet. In the second case the receipt is also the
     * moment the node has everything it was paused for, so it returns to
     * `running` **on the attempt it was suspended on** — nothing here touches
     * `attempt`, no idempotency key is minted, and no retry is scheduled,
     * because an interjection is not a retry. A pause that outlived its reason
     * would be a node asleep with nothing left to wait for.
     *
     * A receipt naming an interjection this projection has never seen changes
     * nothing — an older binary reading a ledger whose `human.interjected` is at
     * a payload version it skipped, or a truncated replay window. Inventing an
     * entry from the receipt alone would put text in the projection that the
     * receipt does not carry, and a delivered guidance bubble with no guidance
     * in it is worse than an absent one.
     */
    case 'human.interjection.delivered': {
      const existing = state.interjections[event.payload.node];
      if (existing === undefined) return state;

      const delivered = existing.find((one) => one.seq === event.payload.interjectedSeq);
      const recorded: RunState = {
        ...state,
        interjections: {
          ...state.interjections,
          [event.payload.node]: existing.map((one) =>
            one === delivered ? { ...one, delivery: 'delivered' } : one,
          ),
        },
      };
      if (delivered?.mode !== 'pause-and-inject') return recorded;

      return (
        withNode(recorded, seq, event.payload.node, (current) =>
          current.status === 'suspended' && current.suspension?.kind === 'human'
            ? { ...current, status: 'running', suspension: null, wakeAt: null }
            : current,
        ) ?? recorded
      );
    }

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
          // KAR-14.3 AC8 — the estimate this attempt was admitted on, folded
          // into the run's accuracy figure beside what it actually cost.
          estimate: event.payload.estimate ?? null,
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
              // KAR-13.2 AC1 — the event that created the queue item, for the
              // same reason `needsHuman` carries one.
              seq,
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
      // KAR-13.2 AC8 — `setSeq` is what takes a ceiling breach out of the
      // approval queue: an answer that arrived after the question.
      const ceilings = { ...state.ceilings, setSeq: seq };
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
    // KAR-19.13 — the vendor session a pre-execution turn opened is a record,
    // not a state change: it exists to be *counted* by the next turn's
    // derivation and to be recomputed offline. A `running` node here would be
    // a `framing` node nothing ever completes.
    case 'provider.session_opened':
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
 * KAR-11.4 AC8 — applying a **human-authored** patch clears the churn breaker
 * and empties the sliding window (docs/06-planning-and-replanning.md §7).
 *
 * *"A human-supplied insight invalidates the window."* The window is evidence
 * that the run has been redoing itself; a premise that was not available to any
 * of those attempts makes the evidence stale rather than merely old, and
 * leaving it in place would trip the breaker again on the first patch after the
 * rescue — which is a run that cannot be rescued.
 *
 * Only a `churn` escalation is cleared. A run paused at its budget ceiling is
 * also `needs-human`, and a patch is not a raised ceiling; forgetting that
 * would let any human patch resume a run that has spent its money.
 */
function rescuedByHuman(state: RunState, proposedBy: ProposedBy | undefined): RunState {
  if (proposedBy !== 'human' || state.needsHuman?.reason !== 'churn') return state;

  return {
    ...state,
    status: state.status === 'needs-human' ? 'running' : state.status,
    needsHuman: null,
    churnWindow: [],
    replans: INITIAL_REPLAN_STREAK,
  };
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

/**
 * KAR-13.1 — the gate record `human.requested` opens or re-opens.
 *
 * A second request for the same node is a **re-ask**, not a duplicate: the F1.3
 * spec gate re-opens after an edit (KAR-10.3 AC8) and a deadline's `escalate`
 * re-asks more visibly (AC7). Both must clear the previous answer, or the run
 * would show a question with an answer already attached to it.
 *
 * `requestedSeq` therefore names the *current* ask rather than the first one
 * ever made about this node. That is what the approval queue orders by and what
 * F10.3's deep link points at, and for an escalation the newer ask is the one
 * the operator is being shown.
 */
function withHumanGate(
  state: RunState,
  seq: number,
  payload: EventPayloadOf<'human.requested'>,
): RunState {
  const gate: HumanGateState = {
    node: payload.node,
    prompt: payload.prompt,
    options: payload.options.map((option) => ({ ...option })),
    deadline: payload.deadline ?? null,
    escalated: payload.escalated ?? false,
    // KAR-13.2 AC2. Both are copied rather than looked up later: the approval
    // queue must carry enough to decide without a second request, and the
    // request event is the only place this context ever exists.
    reason: payload.reason === undefined ? null : { ...payload.reason },
    permission: payload.permission === undefined ? null : { ...payload.permission },
    requestedSeq: seq,
    response: null,
  };
  return { ...state, humanGates: { ...state.humanGates, [payload.node]: gate } };
}

/**
 * KAR-13.1 AC9 — the answer, recorded on the gate it answers.
 *
 * A response for a node with no open gate is folded anyway, against a gate
 * reconstructed from the response alone. An older daemon's ledger, a
 * `human.requested` this build skipped because its payload version is newer:
 * either way the *answer* is a fact, and dropping it would leave a projection
 * claiming a decision was never made.
 *
 * `by` defaults to `operator` because that is what every v1 response was —
 * nothing but a person could append one before the deadline path existed.
 */
function answerHumanGate(
  state: RunState,
  seq: number,
  payload: EventPayloadOf<'human.responded'>,
): RunState {
  const existing = state.humanGates[payload.node];
  const gate: HumanGateState = {
    node: payload.node,
    prompt: existing?.prompt ?? `(the request for ${payload.node} is not in this projection)`,
    options: existing?.options ?? [],
    deadline: existing?.deadline ?? null,
    escalated: existing?.escalated ?? false,
    reason: existing?.reason ?? null,
    permission: existing?.permission ?? null,
    requestedSeq: existing?.requestedSeq ?? seq,
    response: {
      optionId: payload.optionId,
      text: payload.text ?? null,
      by: payload.by ?? 'operator',
      at: payload.at,
      seq,
    },
  };
  return { ...state, humanGates: { ...state.humanGates, [payload.node]: gate } };
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
