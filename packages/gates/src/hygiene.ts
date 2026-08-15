/**
 * KAR-12.6 AC6, AC7 — the gate-hygiene projection: a gate that is defined but
 * never scheduled is decoration, and the first-pass rate is informative at
 * both tails (docs/10-verification-gates.md §2, §9.1).
 *
 * A pure projection over `gate.evaluated` samples, computed **per gate id**
 * (AC7's third scenario: pooling every gate's passes and fails into one
 * number would hide exactly the case the metric exists to show — a 100%
 * gate and a 10% gate sitting side by side reads nothing like a 55% gate).
 *
 * This story specifies the projection and its threshold; EPIC-18's
 * `deflow doctor` (KAR-18.4) is what prints it.
 *
 * **Where the sample comes from is not this file's business, and is not
 * nobody's.** "The last N runs" is a window over the ledger, and it is
 * `sampleGateHygiene()` in `@DeFlow/ledger` — which runs are in the window,
 * ranked by where they started in `seq` order, and every `gates.loaded` and
 * `gate.evaluated` inside them. That half is exercised against a real
 * file-backed ledger in `test/integration/gate-hygiene.test.ts`; a
 * hand-written `GateEvaluationSample[]` only ever proves the arithmetic.
 */
import type { GateId, VerdictOutcome } from '@DeFlow/core';

/** One `gate.evaluated` occurrence, reduced to what this projection reads. */
export interface GateEvaluationSample {
  readonly gate: GateId;
  readonly outcome: VerdictOutcome;
}

export interface GateHygieneInput {
  /** Every gate `gates.loaded` named, this run and the sampled ones before it. */
  readonly definedGates: readonly GateId[];
  /** How many recent runs were sampled — "the last N runs" of AC6. */
  readonly sampledRuns: number;
  /** Every `gate.evaluated` occurrence across those runs, for every gate. */
  readonly evaluations: readonly GateEvaluationSample[];
}

export interface GateHygieneReport {
  readonly gate: GateId;
  readonly sampledRuns: number;
  /** How many times this gate was evaluated at all, any outcome. */
  readonly evaluations: number;
  readonly passes: number;
  readonly fails: number;
  /** True when this gate has zero evaluations across the sampled runs (AC6). */
  readonly neverEvaluated: boolean;
  /** `passes / (passes + fails)`, rounded to two places. `null` when there is
   * nothing to divide by — a rate of zero would claim a gate that never ran
   * failed every time, which is not what "never evaluated" means. */
  readonly firstPassRate: number | null;
  readonly advice: string;
}

/** PRD §12's floor: below this, the plan or the spec is wrong (AC7). */
export const GATE_HYGIENE_LOW_THRESHOLD = 0.4;

const round2 = (value: number): number => Math.round(value * 100) / 100;

function adviceFor(sampledRuns: number, neverEvaluated: boolean, rate: number | null): string {
  if (neverEvaluated) {
    return `defined but never evaluated across the last ${sampledRuns} runs`;
  }
  if (rate === null) return 'no pass or fail evaluations to rate';
  if (rate < GATE_HYGIENE_LOW_THRESHOLD) return 'below 40%: the plan or the spec is wrong';
  if (rate >= 1) return 'at 100%: testing nothing, or being written to';
  return 'healthy';
}

/**
 * AC6, AC7 — one report per defined gate.
 *
 * `needs-human` evaluations count toward "was this gate ever scheduled" but
 * never toward the rate: a gate whose tooling failed every time has not been
 * shown to pass or to fail, and folding it into either bucket would invent a
 * verdict the gate never gave.
 */
export function gateHygiene(input: GateHygieneInput): readonly GateHygieneReport[] {
  return input.definedGates.map((gate) => {
    const forGate = input.evaluations.filter((sample) => sample.gate === gate);
    const passes = forGate.filter((sample) => sample.outcome === 'pass').length;
    const fails = forGate.filter((sample) => sample.outcome === 'fail').length;
    const rated = passes + fails;
    const neverEvaluated = forGate.length === 0;
    const firstPassRate = rated === 0 ? null : round2(passes / rated);

    return {
      gate,
      sampledRuns: input.sampledRuns,
      evaluations: forGate.length,
      passes,
      fails,
      neverEvaluated,
      firstPassRate,
      advice: adviceFor(input.sampledRuns, neverEvaluated, firstPassRate),
    };
  });
}
