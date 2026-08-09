/**
 * `@DeFlow/gates` — the verification gate ladder, the deterministic runner and
 * the milestone rule (docs/10-verification-gates.md).
 *
 * Everything above the runner is pure: the ladder, the milestone rule, the
 * seven parsers, the severity floor and the finding id are functions of their
 * arguments, so the ordering guarantees are testable with no I/O at all. The
 * runner is the one module that spawns anything, and it is the only one that
 * takes a `dataDir` or a `Clock`.
 *
 * There is deliberately nothing in this package that advances a milestone past
 * a non-`pass` verdict — no field, no flag, no config key, no environment
 * variable — and ../test/no-escape-hatch.test.ts is what keeps that true.
 */

export type { GateClass, LadderGate } from '@DeFlow/core';
export { admitGates, GATE_CLASSES, ladderRank, orderGates } from '@DeFlow/core';
export type { AdmitVerdict } from './agent-verdict.ts';
export { admitVerdict, GATE_RETURN_BUDGET, gateVerdictContract } from './agent-verdict.ts';
export type { BlobShaOf } from './anchor.ts';
export { anchorFindings, blobShaIn, gitBlobSha } from './anchor.ts';
export type {
  GateDefinition,
  GateLoadCode,
  LoadGateOptions,
} from './definition.ts';
export {
  GATE_LOAD_CODES,
  GateDefinitionSchema,
  GateFindingsSchema,
  GateLoadError,
  GateTimeoutSchema,
  loadGateDefinition,
} from './definition.ts';
export type { FindingRange, GateFinding, GateSeverity, ParsedFinding } from './finding.ts';
export {
  findingId,
  GATE_SEVERITIES,
  normaliseMessage,
  repoRelativePosix,
  toPosix,
} from './finding.ts';
export type {
  GateVerdictRecord,
  LedgerEventLike,
  Milestone,
  MilestoneReason,
  MilestoneStatus,
  WriteRecord,
} from './milestone.ts';
export {
  gateVerdictsFromEvents,
  MILESTONE_ADVANCE_INPUTS,
  milestoneStatus,
} from './milestone.ts';
export type { OutcomeInput } from './outcome.ts';
export { blockingFindings, gateOutcome, meetsFloor } from './outcome.ts';
export type { GateParser, ParseInput } from './parsers.ts';
export { GATE_PARSERS, parseFindings, TEST_FAILED_RULE } from './parsers.ts';
export type {
  AttemptVerdict,
  FindingDelta,
  ProjectedFinding,
  RenderedBlobSha,
} from './projection.ts';
export { findingDelta, projectFindings } from './projection.ts';
// KAR-12.2 — an adversarial verdict, sealed with how its reviewer was routed.
export type { ReviewRouting } from './review-verdict.ts';
export { sealReviewVerdict } from './review-verdict.ts';
export type { GateEvidence, GateRun, GateToolReason, RunGateOptions } from './run-gate.ts';
export {
  GATE_OUTPUT_MIME,
  GATE_TOOL_REASONS,
  GateExecutionRefused,
  runArtifactDir,
  runGate,
  splitCommandLine,
} from './run-gate.ts';
export type { SealVerdict } from './verdict-of.ts';
export {
  criterionStatusFor,
  DETERMINISTIC_MODEL,
  DETERMINISTIC_PROVIDER,
  sealVerdict,
  toDomainFinding,
} from './verdict-of.ts';
