/**
 * KAR-06.8 — no-progress detection: the stall detector, the churn circuit
 * breaker and the hard caps behind them
 * (docs/05-durable-execution.md §11, F4.7).
 *
 * [PRD §7.4](../../../docs/prd.md) calls a livelock "the single most expensive
 * failure mode in autonomous loops", and the expense is entirely a function of
 * how long it takes to notice. Two detectors, both cheap, plus caps as a
 * backstop.
 *
 * Everything here is a pure function of `(RunState, now)`, which is what lets a
 * forty-minute stall and a twenty-attempt churn window be exercised in
 * microseconds with no database, no spawn and no timer (AC9). The reducer does
 * all the accumulating; this file only reads.
 *
 * Two restraints are load-bearing and are the reason the module is small:
 *
 * 1. **The stall detector does not act.** It reports. A legitimately long
 *    build, a large test suite and a wedged agent are indistinguishable from
 *    here, and killing a forty-minute integration run because it went quiet
 *    for ten minutes is a worse failure than the one being prevented. Nothing
 *    in this file returns a `CancelNode`, and nothing in `decide()` derives one
 *    from a `StallReport`.
 * 2. **The caps back the detectors, never the other way round.** They exist to
 *    bound the blast radius of a bug in the two functions above, so a detector
 *    trip is reported in preference to a cap breach when both fire, and the
 *    caps keep running when `detectors` is switched off.
 *
 * Verifies: EPIC-06-S26, EPIC-06-S27, EPIC-06-S28 · AC2–AC9
 */
import type { NodeId } from './ids.ts';
import type { NeedsHumanState, RunState } from './run-state.ts';
import { toSingleLine } from './text.ts';

/**
 * **M** — how many completed node attempts the churn window remembers (§11.3).
 *
 * A constant rather than config, unlike `churnRepeats` beside it, because this
 * is the one tuning number that is part of the *projection's shape*: the window
 * is accumulated by the reducer, so a checkpoint written under M = 20 and read
 * back under M = 50 is not a smaller answer to the same question, it is a
 * different fold. Changing it is a `CHECKPOINT_VERSION` bump, which is exactly
 * the ceremony a change to a reduced field should cost.
 *
 * 20 is a practitioner default mirroring what the agent-runtime ecosystem
 * converged on during 2026 — sliding-window tool-call dedup with small
 * consecutive-no-progress thresholds — not a measured value.
 */
export const CHURN_WINDOW = 20;

/**
 * One completed node attempt, as the window remembers it.
 *
 * `requestHash` is what makes this a churn signal rather than an activity
 * count: it is the digest of *what was asked for* (./effect-request.ts), so
 * "the same node ran again" and "the same node ran again with the same inputs"
 * are different facts, and only the second is a livelock. It is `null` for an
 * attempt that journalled no effect — a completion the window still has to
 * count, because it occupies a slot and ages older entries out, but that it
 * cannot claim was the same work as any other.
 */
export interface CompletedAttempt {
  readonly node: NodeId;
  readonly requestHash: string | null;
  readonly attempt: number;
  /** The `seq` of the `node.completed` that closed the attempt. */
  readonly seq: number;
}

/**
 * §11.3's second detector, as reduced state: how many `plan.patched` events in
 * a row have failed to raise the completed-node count, what that count is, and
 * which plan versions were involved.
 *
 * `completed` is the count as of the *first* replan in the streak, so a node
 * finishing part-way through resets it — the planner is only rearranging deck
 * chairs while nothing is actually getting done.
 */
export interface ReplanStreak {
  readonly flat: number;
  readonly completed: number;
  readonly versions: readonly number[];
}

export const INITIAL_REPLAN_STREAK: ReplanStreak = Object.freeze({
  flat: 0,
  completed: 0,
  versions: Object.freeze([]),
});

/** §11.4's three hard caps, by name. The name travels into the trip detail, so
 * the operator reads which one fired rather than inferring it from a number. */
export const RUN_CAPS = [
  'maxAttemptsPerNode',
  'maxRunWallClock',
  'maxTotalNodeExecutions',
] as const;

export type RunCap = (typeof RUN_CAPS)[number];

/** The typed failure a hard cap produces: which cap, its limit, what was
 * actually observed, and — for the per-node cap — whose attempts overran. */
export interface CapBreach {
  readonly cap: RunCap;
  readonly limit: number;
  readonly actual: number;
  readonly node: NodeId | null;
}

/** `run.stalled`'s payload, derived rather than recorded (AC2). */
export interface StallReport {
  readonly watermarkSeq: number;
  readonly idleMs: number;
  readonly runningNodes: readonly NodeId[];
}

/**
 * A churn trip. `reason` is always `churn` because that is the vocabulary
 * `run.needs_human` is closed over; `cause` says which of §11.3's two detectors
 * fired, which is what a reader of the timeline actually wants to know.
 */
export interface ChurnTrip {
  readonly reason: 'churn';
  readonly cause: 'repeat' | 'replan';
  readonly detail: string;
}

/**
 * The tuning constants, on `RunState.policy` rather than as module constants
 * for the reason `globalAgentSlots` is: the notes on this story say to expect
 * to tune them, and "the stall threshold will look wrong the first time a
 * thirty-minute test suite runs under it" is a thing an operator has to be able
 * to fix without a release.
 *
 * `detectors: false` switches off both of §11's detectors and leaves the caps
 * running, which is the configuration EPIC-06-S28's third scenario exists to
 * prove: the caps are a backstop, so they cannot be implemented *by* the
 * detectors they back.
 */
export interface NoProgressPolicy {
  readonly detectors: boolean;
  /** ms of no watermark movement, while at least one node runs, before
   * `run.stalled`. */
  readonly stallThresholdMs: number;
  /** **N** — occurrences of one `(node, requestHash)` pair within the window
   * that are still tolerated; the next one trips. */
  readonly churnRepeats: number;
  /** Consecutive replans with a flat completed-node count that trip. */
  readonly flatReplans: number;
  readonly maxAttemptsPerNode: number;
  /** `null` leaves the run uncapped in that dimension. */
  readonly maxRunWallClockMs: number | null;
  readonly maxTotalNodeExecutions: number | null;
}

const MINUTE = 60_000;

export const DEFAULT_NO_PROGRESS_POLICY: NoProgressPolicy = Object.freeze({
  detectors: true,
  stallThresholdMs: 10 * MINUTE,
  churnRepeats: 5,
  flatReplans: 3,
  /** F7.5's surgical repair cap, so a node cannot outlive the loop that repairs
   * it (docs/10-verification-gates.md §7). The one cap §11.4 states a default
   * for, and the one that needs no knowledge of the run to be right. */
  maxAttemptsPerNode: 3,
  /**
   * Unset, and deliberately so. §11.4 states a default for the attempt cap and
   * for neither of these two, and the reason shows up the moment you invent
   * one: KAR-06.6 ships a **thirty-day** human gate as a supported shape, so any
   * wall-clock default short enough to catch a runaway is also short enough to
   * abort a run that is doing exactly what it was asked to. A cap that fires on
   * correct behaviour is worse than no cap, because the next thing that happens
   * is somebody turns it off.
   *
   * `.DeFlow/config.yaml` supplies them per project, where the length of a
   * legitimate run is actually knowable.
   */
  maxRunWallClockMs: null,
  maxTotalNodeExecutions: null,
});

/** Everything the two detectors and the caps have to say about this instant. */
export interface NoProgress {
  readonly stall: StallReport | null;
  readonly churn: ChurnTrip | null;
  readonly cap: CapBreach | null;
}

const NOTHING: NoProgress = Object.freeze({ stall: null, churn: null, cap: null });

/**
 * Is this run getting anywhere, at this instant?
 *
 * Only a `running` run is asked: a paused run is quiet because somebody paused
 * it, a `needs-human` run has already asked, and an ended run has nothing left
 * to stall on. Reporting any of them would turn the one signal that means
 * "look at this" into noise.
 */
export function noProgress(state: RunState, now: number): NoProgress {
  if (state.status !== 'running') return NOTHING;
  const policy = state.policy.noProgress;

  return {
    stall: policy.detectors ? stallReport(state, now, policy) : null,
    churn: policy.detectors ? churnTrip(state, policy) : null,
    cap: capBreach(state, now, policy),
  };
}

/**
 * The human the run needs, or `null` while it is fine. The detectors take
 * precedence over the caps — §11.4's caps exist to bound the blast radius of a
 * detector bug, so a cap that fires alongside a detector is the less
 * informative of the two answers.
 *
 * A stall is deliberately absent: `run.stalled` is a report, and a report is
 * not a reason to stop.
 */
export function needsHumanOf(found: NoProgress): NeedsHumanState | null {
  if (found.churn !== null) return { reason: found.churn.reason, detail: found.churn.detail };
  if (found.cap !== null) {
    return { reason: CAP_CATEGORY[found.cap.cap], detail: capDetail(found.cap) };
  }
  return null;
}

// ── §11.2 the stall detector ─────────────────────────────────────────────────

/**
 * `now - watermarkTs > stallThreshold` while at least one node is `running`,
 * and not already reported for this episode.
 *
 * The episode is identified by `watermarkSeq` — the seq the run stopped
 * progressing at — which is why `run.stalled` is the one event in the system
 * that is reduced without advancing the watermark (./reduce.ts). An episode is
 * over the moment the projection moves, so the run that goes quiet, is
 * reported, makes one transition and goes quiet again is reported twice; the
 * run that goes quiet for four hours is reported once (AC2).
 */
function stallReport(state: RunState, now: number, policy: NoProgressPolicy): StallReport | null {
  if (state.watermarkSeq <= 0 || state.watermarkTs <= 0) return null;
  if (state.stalledAtSeq === state.watermarkSeq) return null;

  // Clamped, because `ts` is a wall clock and a laptop that slept through a
  // daylight-saving transition can put an event's instant ahead of `now`.
  const idleMs = Math.max(0, Math.trunc(now - state.watermarkTs));
  if (idleMs <= policy.stallThresholdMs) return null;

  const runningNodes = runningIds(state);
  if (runningNodes.length === 0) return null;

  return { watermarkSeq: state.watermarkSeq, idleMs, runningNodes };
}

/** Sorted, because the payload is snapshotted and object key order is not a
 * property of the run. */
function runningIds(state: RunState): NodeId[] {
  return Object.entries(state.nodes)
    .filter(([, node]) => node.status === 'running')
    .map(([id]) => id as NodeId)
    .toSorted();
}

// ── §11.3 the churn circuit breaker ──────────────────────────────────────────

function churnTrip(state: RunState, policy: NoProgressPolicy): ChurnTrip | null {
  return repeatedWork(state, policy) ?? flatReplans(state, policy);
}

/**
 * The same `(node, requestHash)` more than N times in the last M completed
 * attempts — the same work redone with the same inputs, which is the literal
 * definition of a livelock.
 *
 * Attempts with no `requestHash` are counted into the window's length and out
 * of its comparisons: they age other entries out, because they really did
 * happen, but nothing can be claimed about whether they were the same work.
 */
function repeatedWork(state: RunState, policy: NoProgressPolicy): ChurnTrip | null {
  const byRequest = new Map<string, CompletedAttempt[]>();

  for (const entry of state.churnWindow) {
    if (entry.requestHash === null) continue;
    const key = `${entry.node} ${entry.requestHash}`;
    const seen = byRequest.get(key);
    if (seen === undefined) byRequest.set(key, [entry]);
    else seen.push(entry);
  }

  // Insertion order is the window's order, so the pair that first reached the
  // threshold is the one reported — no iteration order of an object reaches
  // the answer.
  for (const repeats of byRequest.values()) {
    if (repeats.length <= policy.churnRepeats) continue;
    return { reason: 'churn', cause: 'repeat', detail: repeatDetail(state, repeats) };
  }

  return null;
}

/**
 * AC5's diagnosability requirement: the tuples that produced the trip, in the
 * detail, so the first few real trips are tunable rather than mysterious.
 *
 * The hash is abbreviated to its first twelve hex digits — the same prefix
 * length `shortIkeyHash` uses — because a `run.needs_human.detail` is one line
 * of at most 400 characters and six full sha256s are 426 of them.
 */
function repeatDetail(state: RunState, repeats: readonly CompletedAttempt[]): string {
  const first = repeats[0];
  const tuples = repeats.map((entry) => `${entry.attempt}/${entry.seq}`).join(', ');

  return toSingleLine(
    `churn: ${first?.node ?? '?'} redid the same request ${shortHash(first?.requestHash ?? null)} ` +
      `${repeats.length} times in the last ${state.churnWindow.length} completed attempts ` +
      `— attempt/seq ${tuples}`,
  );
}

const SHORT_HASH_HEX = 12;

const shortHash = (hash: string | null): string =>
  hash === null ? 'none' : hash.slice(0, 'sha256-'.length + SHORT_HASH_HEX);

/** The completed-node count has not increased across N consecutive replans —
 * the planner rearranging deck chairs (§11.3, AC6). */
function flatReplans(state: RunState, policy: NoProgressPolicy): ChurnTrip | null {
  const streak = state.replans;
  if (streak.flat < policy.flatReplans) return null;

  return {
    reason: 'churn',
    cause: 'replan',
    detail: toSingleLine(
      `churn: ${streak.flat} consecutive replans ` +
        `(plan versions ${streak.versions.join(', ')}) ` +
        `with the completed-node count flat at ${streak.completed}`,
    ),
  };
}

// ── §11.4 the hard caps ──────────────────────────────────────────────────────

/**
 * Which of the breaker's three categories each cap escalates under
 * (docs/04-domain-model.md §9). A wall-clock ceiling is a budget in the sense
 * F4.6 already uses the word; the other two mean "this run is redoing itself",
 * which is what `churn` means.
 */
const CAP_CATEGORY: Readonly<Record<RunCap, NeedsHumanState['reason']>> = Object.freeze({
  maxAttemptsPerNode: 'churn',
  maxRunWallClock: 'budget',
  maxTotalNodeExecutions: 'churn',
});

/**
 * The first cap this run has blown through, in the order a reader would want
 * them: the node-scoped one names a culprit and is therefore the most useful,
 * then elapsed time, then the whole-run execution count.
 */
function capBreach(state: RunState, now: number, policy: NoProgressPolicy): CapBreach | null {
  const nodes = Object.entries(state.nodes).toSorted(([left], [right]) => compare(left, right));

  for (const [id, node] of nodes) {
    if (node.attempts > policy.maxAttemptsPerNode) {
      return {
        cap: 'maxAttemptsPerNode',
        limit: policy.maxAttemptsPerNode,
        actual: node.attempts,
        node: id as NodeId,
      };
    }
  }

  const wallClock = policy.maxRunWallClockMs;
  if (wallClock !== null && state.startedTs > 0) {
    const elapsed = Math.max(0, Math.trunc(now - state.startedTs));
    if (elapsed > wallClock) {
      return { cap: 'maxRunWallClock', limit: wallClock, actual: elapsed, node: null };
    }
  }

  const ceiling = policy.maxTotalNodeExecutions;
  if (ceiling !== null) {
    const executions = nodes.reduce((total, [, node]) => total + node.attempts, 0);
    if (executions > ceiling) {
      return { cap: 'maxTotalNodeExecutions', limit: ceiling, actual: executions, node: null };
    }
  }

  return null;
}

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

function capDetail(breach: CapBreach): string {
  const whose = breach.node === null ? '' : ` on ${breach.node}`;
  return toSingleLine(
    `cap: ${breach.cap} exceeded${whose} — ${breach.actual} against a limit of ${breach.limit}`,
  );
}
