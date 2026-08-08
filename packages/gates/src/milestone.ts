/**
 * KAR-12.1 — the milestone rule (docs/10-verification-gates.md §1).
 *
 * > A milestone does not advance until every gate in its `requires` list has a
 * > `pass` verdict recorded at a ledger offset after the last write to the
 * > paths in its scope.
 *
 * Two halves, both load-bearing, and the second is the one that is easy to
 * leave out. A `pass` from before the last three commits proves nothing, and it
 * is exactly the shape a run drifts into when a repair loop touches files after
 * the gate ran — the gate was green, the fix landed, and the green is now about
 * a tree nobody has.
 *
 * **The comparison is on `seq` and never on `ts`.** The wall clock is not
 * monotonic (docs/05-durable-execution.md §9.6), so a laptop that slept through
 * a daylight-saving transition would reorder a run's history under a timestamp
 * comparison. `GateVerdictRecord` and `WriteRecord` carry no timestamp at all,
 * which makes that a property of the types rather than a habit.
 *
 * **There is no third input.** `MILESTONE_ADVANCE_INPUTS` says so out loud and
 * ../test/no-escape-hatch.test.ts asserts it: the only path past a red gate is
 * a `human` node whose `human.responded` event carries an identity and a
 * timestamp (§9.1), never a flag on the milestone.
 */
import { type GateId, pathScopeMatches, VERDICT_OUTCOMES, type VerdictOutcome } from '@DeFlow/core';

/**
 * What decides whether a milestone advances — the whole list.
 *
 * Exported so the assertion in ../test/no-escape-hatch.test.ts is against a
 * value rather than against a comment: a third input added here is a failure,
 * and a third input added *without* touching this is a signature change the
 * type checker rejects.
 */
export const MILESTONE_ADVANCE_INPUTS = ['verdicts', 'writes'] as const;

export interface Milestone {
  readonly id: string;
  /** Gate ids, not node ids: the same definition may be scheduled more than
   * once across a repair loop, and it is the definition that is required. */
  readonly requires: readonly GateId[];
  /** Repo-relative globs, `.gitignore` semantics (core's `pathScopeMatches`). */
  readonly scope: readonly string[];
}

/** One `gate.evaluated`, reduced to what the rule reads. */
export interface GateVerdictRecord {
  readonly gate: GateId;
  readonly outcome: VerdictOutcome;
  /** The ledger `seq` the verdict was recorded at. */
  readonly seq: number;
}

/** One event that wrote to the tree, reduced to what the rule reads. */
export interface WriteRecord {
  readonly seq: number;
  /** Repo-relative, POSIX. */
  readonly paths: readonly string[];
}

/**
 * Why a milestone is not advancing.
 *
 * Three arms rather than one, because each is a different operator action: a
 * gate that has never run needs scheduling, a gate that failed needs a repair
 * loop or a human, and a stale green needs neither — it needs the same gate run
 * again over the tree as it now is.
 */
export type MilestoneReason = 'gate-not-evaluated' | 'gate-not-passed' | 'stale-green';

export interface MilestoneStatus {
  readonly milestone: string;
  readonly advanced: boolean;
  readonly reason: MilestoneReason | null;
  /** The required gates `decide()` should schedule again. Empty when advanced. */
  readonly rescheduled: readonly GateId[];
  /** The `seq` of the last write inside the milestone's scope, or `null` when
   * nothing has been written there. Part of the projection because "why is this
   * green stale" is unanswerable without it. */
  readonly lastWriteSeq: number | null;
}

/** The envelope fields this projection reads — everything else is ignored, so
 * a caller can hand it whatever its ledger reader returns. */
export interface LedgerEventLike {
  readonly seq: number;
  readonly kind: string;
  readonly payload: unknown;
}

/**
 * The verdict half of the rule, read straight off the ledger.
 *
 * `seq` comes from the row rather than from the payload, which is the point:
 * the position a verdict was recorded at is assigned by SQLite and cannot be
 * claimed by whatever produced the event.
 *
 * A payload that does not carry a readable `gate` and `outcome` is skipped
 * rather than guessed at — the forward-compatibility rule of
 * docs/04-domain-model.md §9.2, applied to a projection.
 */
export function gateVerdictsFromEvents(
  events: readonly LedgerEventLike[],
): readonly GateVerdictRecord[] {
  const records: GateVerdictRecord[] = [];
  for (const event of events) {
    if (event.kind !== 'gate.evaluated') continue;
    const payload = event.payload as { gate?: unknown; verdict?: { outcome?: unknown } } | null;
    const gate = payload?.gate;
    const outcome = payload?.verdict?.outcome;
    if (typeof gate !== 'string') continue;
    if (!(VERDICT_OUTCOMES as readonly string[]).includes(outcome as string)) continue;
    records.push({ gate: gate as GateId, outcome: outcome as VerdictOutcome, seq: event.seq });
  }
  return records;
}

/** The latest verdict per gate — a re-run is a later verdict, not a second opinion. */
function latestPerGate(
  verdicts: readonly GateVerdictRecord[],
): ReadonlyMap<GateId, GateVerdictRecord> {
  const latest = new Map<GateId, GateVerdictRecord>();
  for (const verdict of verdicts) {
    const held = latest.get(verdict.gate);
    if (held === undefined || verdict.seq >= held.seq) latest.set(verdict.gate, verdict);
  }
  return latest;
}

/**
 * The milestone rule, as a projection over what the ledger recorded.
 *
 * Total and pure: every input answers, and the answer is the same on every
 * replay of the same events.
 */
export function milestoneStatus(
  milestone: Milestone,
  verdicts: readonly GateVerdictRecord[],
  writes: readonly WriteRecord[],
): MilestoneStatus {
  const inScope = writes.filter((write) =>
    write.paths.some((path) => pathScopeMatches(milestone.scope, path)),
  );
  const lastWriteSeq = inScope.reduce<number | null>(
    (held, write) => (held === null || write.seq > held ? write.seq : held),
    null,
  );

  const latest = latestPerGate(verdicts);
  const missing: GateId[] = [];
  const red: GateId[] = [];
  const stale: GateId[] = [];

  for (const gate of milestone.requires) {
    const verdict = latest.get(gate);
    if (verdict === undefined) {
      missing.push(gate);
      continue;
    }
    if (verdict.outcome !== 'pass') {
      red.push(gate);
      continue;
    }
    if (lastWriteSeq !== null && verdict.seq < lastWriteSeq) stale.push(gate);
  }

  // Ordered so the sharpest reason wins: a gate that failed is a more useful
  // sentence than a gate that never ran, and both are more useful than a green
  // that went stale.
  const reason: MilestoneReason | null =
    red.length > 0
      ? 'gate-not-passed'
      : missing.length > 0
        ? 'gate-not-evaluated'
        : stale.length > 0
          ? 'stale-green'
          : null;

  return {
    milestone: milestone.id,
    advanced: reason === null,
    reason,
    rescheduled: [...red, ...missing, ...stale],
    lastWriteSeq,
  };
}
