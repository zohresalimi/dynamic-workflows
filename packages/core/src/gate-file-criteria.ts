/**
 * KAR-12.4 AC4 — the `GATE_UNKNOWN_CRITERION` rule (docs/10-verification-gates.md
 * §5.1): a discovered gate file's `satisfies:` list is a **declaration**
 * against the pinned spec's own criteria, and a typo in it must not quietly
 * cover nothing.
 *
 * `AcceptanceCriterion.verifiedBy` (author's declaration), `GateNode.criteria`
 * (planner's declaration) and this file's `satisfies:` (repo author's
 * declaration for a reusable gate) are three of the epic's "four names for one
 * relation" — see the reconciliation table in
 * docs/delivery/epics/EPIC-12-verification-gates.md, KAR-12.4. All three name
 * the same set of ids, and all three are checked against the one place that
 * set is authoritative: `spec.acceptanceCriteria`.
 *
 * Deliberately not the file-discovery mechanism itself — walking
 * `.DeFlow/gates/*.{yaml,yml}` and parsing them is KAR-12.6, which this story
 * blocks. What lives here is the one rule that walk will call before it lets a
 * gate file's declared coverage anywhere near a plan.
 */
import type { TaskSpec } from './task-spec.ts';

export interface GateFileCriterionIssue {
  /** The gate file's path, exactly as discovered — never resolved further,
   * because the message is read by a human deciding which file to fix. */
  readonly file: string;
  /** The unrecognised criterion id, verbatim from `satisfies:`. */
  readonly id: string;
  readonly message: string;
}

/**
 * AC4, test plan #4 — every `satisfies:` entry `file` declares that names no
 * criterion in `spec.acceptanceCriteria`, in the order `satisfies` lists them.
 *
 * Every unknown id is reported, not only the first: a gate file with two typos
 * is two fixes, and a caller that stops at the first makes the second typo
 * look fixed on the next run when it was never looked at.
 */
export function unknownGateCriteria(
  file: string,
  satisfies: readonly string[],
  spec: TaskSpec,
): readonly GateFileCriterionIssue[] {
  const known = new Set<string>(spec.acceptanceCriteria.map((criterion) => criterion.id));
  return satisfies
    .filter((id) => !known.has(id))
    .map((id) => ({
      file,
      id,
      message:
        `gate file '${file}' declares satisfies: [${id}], which is not a criterion in the ` +
        'pinned spec. A typo here would quietly cover nothing.',
    }));
}
