/**
 * KAR-12.1 — sealing a deterministic gate's result as a `Verdict`
 * (docs/10-verification-gates.md §4, docs/04-domain-model.md §7).
 *
 * The requirement this file exists for is one sentence: **a deterministic
 * verdict has the same shape as an adversarial one.** The diff surface, the
 * acceptance-criteria board and the repair loop each read exactly one shape; if
 * the two tiers diverged, EPIC-17 grows two renderers and they drift.
 *
 * Two mappings are stated here rather than assumed, because both are places a
 * later reader will ask "why".
 *
 * **Severity.** The gate tier speaks the tools' vocabulary
 * (`error | warning | info`, §4) and the domain model speaks the board's
 * (`blocker | major | minor | info`, 04 §7). They are different questions — how
 * loudly the tool complained, and what it costs — and the map below is the one
 * the ladder needs: an `error` at or above the floor is what stops a milestone,
 * so it is a `blocker`. KAR-12.3 owns reconciling the two vocabularies properly;
 * until it does, the map is in one place rather than at each call site.
 *
 * **`by.provider` and `by.model`.** A deterministic gate has no model. The
 * fields are required by the shipped `DeFlow.verdict.v1` shape, and naming the
 * runner — `deflow` / `deterministic-gate` — is more honest than naming a model
 * that never ran or than leaving a field that says a gate had a provider empty.
 */
import {
  type CriterionId,
  type CriterionStatus,
  type Finding,
  type GateId,
  type Handle,
  type NodeId,
  toSingleLine,
  VERDICT_V2_SCHEMA_ID,
  type VerdictOutcome,
  type VerdictV2,
  VerdictV2Schema,
} from '@DeFlow/core';
import type { GateFinding, GateSeverity } from './finding.ts';

/** The provider a verdict computed by DeFlowd itself names. */
export const DETERMINISTIC_PROVIDER = 'deflow';

/** The model field's value for a gate that ran a process rather than a model. */
export const DETERMINISTIC_MODEL = 'deterministic-gate';

const SEVERITY_TO_DOMAIN: Readonly<Record<GateSeverity, Finding['severity']>> = {
  error: 'blocker',
  warning: 'minor',
  info: 'info',
};

/**
 * What a gate concluded about a criterion it declared it speaks to.
 *
 * `needs-human` maps to `unverifiable` rather than to `unsatisfied`, and the
 * distinction is the whole reason `unverifiable` exists: a gate whose binary
 * was missing has not shown the work to be wrong, and routing that into a
 * repair loop asks a fix node to repair a missing binary.
 */
export function criterionStatusFor(outcome: VerdictOutcome): CriterionStatus {
  if (outcome === 'pass') return 'satisfied';
  return outcome === 'fail' ? 'unsatisfied' : 'unverifiable';
}

/** One gate finding as the domain model's `Finding`. */
export function toDomainFinding(finding: GateFinding, evidence: readonly Handle[]): Finding {
  return {
    id: finding.id,
    severity: SEVERITY_TO_DOMAIN[finding.severity],
    ...(finding.criterion === undefined ? {} : { criterion: finding.criterion }),
    location: {
      file: finding.file,
      line: finding.range.startLine,
      ...(finding.range.endLine === undefined ? {} : { endLine: finding.range.endLine }),
    },
    message: toSingleLine(`${finding.rule}: ${finding.message}`),
    evidence: [...evidence],
  };
}

export interface SealVerdict {
  readonly gate: GateId;
  /** The gate's own node. */
  readonly node: NodeId;
  /** Whose work was judged. */
  readonly evaluatedNode: NodeId;
  readonly outcome: VerdictOutcome;
  readonly specHash: string;
  readonly criteria: readonly CriterionId[];
  readonly findings: readonly GateFinding[];
  /** The full tool output, when there was any. */
  readonly evidence: readonly Handle[];
  readonly summary: string;
}

/**
 * Builds the verdict and validates it against the shipped schema before
 * returning it.
 *
 * Validated here rather than at the ledger boundary because a verdict that does
 * not parse is a bug in this file, and the useful place to find out is the call
 * that produced it — not three layers later, in an append that fails for a run
 * nobody can now reproduce.
 */
export function sealVerdict(input: SealVerdict): VerdictV2 {
  const status = criterionStatusFor(input.outcome);
  return VerdictV2Schema.parse({
    schemaId: VERDICT_V2_SCHEMA_ID,
    outcome: input.outcome,
    gate: input.gate,
    evaluatedNode: input.evaluatedNode,
    by: {
      node: input.node,
      provider: DETERMINISTIC_PROVIDER,
      model: DETERMINISTIC_MODEL,
    },
    criteria: input.criteria.map((id) => ({ id, status })),
    findings: input.findings.map((finding) => toDomainFinding(finding, input.evidence)),
    summary: toSingleLine(input.summary),
    specHash: input.specHash,
  });
}
