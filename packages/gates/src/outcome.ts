/**
 * KAR-12.1 — what makes a gate red (docs/10-verification-gates.md §2, §6.2).
 *
 * Two inputs decide, and the order between them is the design:
 *
 * 1. **A finding at or above `severityFloor` fails the gate.** A tool that
 *    produced structured output has already said what is wrong, and the floor
 *    is the gate author's decision about which of those matter.
 * 2. **The exit code decides only when the parser found nothing to say.** This
 *    is the whole of the evidence for `findings.parser: none`, and it is what
 *    `expect.exitCode` exists for.
 *
 * Without that ordering the two acceptance criteria contradict each other:
 * oxlint exits non-zero the moment it has anything to report, so a gate with
 * `severityFloor: error` and two warnings would fail on the exit code alone —
 * which is precisely what AC9 says must not happen.
 *
 * **Sub-floor findings are recorded, never dropped.** §6.2's rule is that
 * violations are never free even when they do not fail a gate: they reach the
 * diff view and they feed the blast-radius estimate the patch policy engine
 * reads. A warning that is invisible is a warning that will be re-learned
 * expensively at merge time.
 */
import type { GateId } from '@DeFlow/core';
import { GATE_SEVERITIES, type GateFinding, type GateSeverity } from './finding.ts';

/** Severity as a number, most severe first — `GATE_SEVERITIES`' own order. */
const rank = (severity: GateSeverity): number => GATE_SEVERITIES.indexOf(severity);

/** Whether a finding of this severity is one the floor says fails the gate. */
export function meetsFloor(severity: GateSeverity, floor: GateSeverity): boolean {
  return rank(severity) <= rank(floor);
}

export interface OutcomeInput {
  readonly gate: GateId;
  readonly exitCode: number;
  readonly expectExitCode: number;
  readonly findings: readonly GateFinding[];
  readonly severityFloor: GateSeverity;
}

/**
 * `pass` or `fail`.
 *
 * Deliberately not `needs-human`: that outcome means the gate could not answer
 * at all, which is a property of the *run* of the command rather than of its
 * result, and it is decided in ./run-gate.ts before anything reaches here.
 */
export function gateOutcome(input: OutcomeInput): 'pass' | 'fail' {
  const blocking = input.findings.filter((finding) =>
    meetsFloor(finding.severity, input.severityFloor),
  );
  if (blocking.length > 0) return 'fail';
  if (input.findings.length > 0) return 'pass';
  return input.exitCode === input.expectExitCode ? 'pass' : 'fail';
}

/** The findings the floor says are blocking — the input to the repair loop's
 * one-fix-node-per-finding split (KAR-12.5). */
export function blockingFindings(
  findings: readonly GateFinding[],
  floor: GateSeverity,
): readonly GateFinding[] {
  return findings.filter((finding) => meetsFloor(finding.severity, floor));
}
