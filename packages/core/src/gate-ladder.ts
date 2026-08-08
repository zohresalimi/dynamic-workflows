/**
 * KAR-12.1 — the gate ladder (docs/10-verification-gates.md §1).
 *
 * `deterministic → structural → adversarial → human`, and the first non-`pass`
 * stops the rest. The reason is economic *and* qualitative: there is no point
 * paying a model to review code that does not compile, and the resulting review
 * is actively worse — a reviewer looking at broken code spends its attention on
 * the breakage and misses the design problem you needed it to find.
 *
 * Two properties this file exists to hold.
 *
 * **The order is derived, never incidental.** A gate set arrives from a plan in
 * whatever order the planner emitted it, and sorting by array position would
 * produce the right answer on the plans that happen to be authored in ladder
 * order and the wrong one on the rest. `orderGates` ranks by class, and
 * `ladder.test.ts` inserts a set adversarial-first specifically to stop someone
 * "simplifying" this into a no-op.
 *
 * **`needs-human` is a stop, not a pass.** A gate whose own tooling failed has
 * not said the work is good; it has said it could not tell. Opening the next
 * tier on it would buy a review on the strength of a check that never ran.
 *
 * Pure: no I/O, no clock, no state. `decide()` consumes it through `RunState`
 * (./decide.ts), and `@DeFlow/gates` re-exports it for the daemon's gate-set
 * evaluation. One implementation, because two orderings is how the scheduler
 * and the runner come to disagree about which gate ran first.
 */
import type { GateId, NodeId } from './ids.ts';
import type { VerdictOutcome } from './verdict.ts';

/** §1's four classes, in the order the scheduler admits them. */
export const GATE_CLASSES = ['deterministic', 'structural', 'adversarial', 'human'] as const;

export type GateClass = (typeof GATE_CLASSES)[number];

/**
 * Where a class sits on the ladder. Lower runs first.
 *
 * Derived from `GATE_CLASSES` rather than written out a second time: two
 * spellings of one ordering is how the array and the ranking come to disagree.
 */
export function ladderRank(kind: GateClass): number {
  return GATE_CLASSES.indexOf(kind);
}

/** A gate as the ladder sees it: which node runs it, which definition it is,
 * and which tier it belongs to. Nothing about how it is executed. */
export interface LadderGate {
  readonly node: NodeId;
  readonly gate: GateId;
  readonly kind: GateClass;
}

/**
 * The gate set in ladder order, stable within a tier.
 *
 * Stable because two deterministic gates have no ordering argument between
 * them — the plan's order is as good as any, and re-sorting them would make
 * `node.scheduled` sequences differ between two runs of the same plan for no
 * reason a reader could explain.
 */
export function orderGates(gates: readonly LadderGate[]): readonly LadderGate[] {
  return [...gates]
    .map((gate, at) => ({ gate, at }))
    .sort(
      (left, right) =>
        ladderRank(left.gate.kind) - ladderRank(right.gate.kind) || left.at - right.at,
    )
    .map((entry) => entry.gate);
}

/**
 * Which gates may run right now, given what has been recorded so far.
 *
 * The whole tier opens at once — two deterministic gates are cheap, independent
 * and both need to pass, so running them one at a time buys nothing and costs a
 * scheduler round trip each. The *next* tier opens only once every gate below
 * it has a `pass`.
 *
 * Returns `[]` in three cases that mean different things and need no
 * distinguishing here: a tier below has failed (AC2's short-circuit), a tier
 * below is still running, or every gate has been evaluated and passed.
 */
export function admitGates(
  gates: readonly LadderGate[],
  outcomes: ReadonlyMap<NodeId, VerdictOutcome>,
): readonly LadderGate[] {
  const ordered = orderGates(gates);

  for (const kind of GATE_CLASSES) {
    const tier = ordered.filter((gate) => gate.kind === kind);
    if (tier.length === 0) continue;

    const pending = tier.filter((gate) => outcomes.get(gate.node) === undefined);
    if (pending.length > 0) return pending;
    // Every gate in this tier has answered. Only `pass` opens the next one.
    if (tier.some((gate) => outcomes.get(gate.node) !== 'pass')) return [];
  }

  return [];
}
