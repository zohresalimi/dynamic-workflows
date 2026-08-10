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
// KAR-12.6 — discovering gate definitions from `.DeFlow/gates/*.{yaml,yml}`
// and from repo reconnaissance, hashed into the run manifest, and the
// mid-run divergence check.
export type {
  DiscoveredGate,
  DiscoverGatesInput,
  DivergenceCheck,
  GateManifestEntry,
  GateSource,
  SealDivergedVerdict,
} from './discovery.ts';
export {
  BUILTIN_GATE_SCRIPTS,
  builtinGateSources,
  checkGateDivergence,
  checkGateDivergenceOnDisk,
  discoverGateDefinitions,
  GATE_DEFINITION_DIVERGED,
  loadGateSource,
  readGatesDirectory,
  sealDivergedVerdict,
  sha256Hex,
} from './discovery.ts';
export type { FindingRange, GateFinding, GateSeverity, ParsedFinding } from './finding.ts';
export {
  findingId,
  GATE_SEVERITIES,
  normaliseMessage,
  repoRelativePosix,
  toPosix,
} from './finding.ts';
// KAR-12.6 AC6, AC7 — the gate-hygiene projection `DeFlow doctor` prints
// (EPIC-18 mounts the command; this story owns the projection).
export type { GateEvaluationSample, GateHygieneInput, GateHygieneReport } from './hygiene.ts';
export { GATE_HYGIENE_LOW_THRESHOLD, gateHygiene } from './hygiene.ts';
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
export { GATE_PARSERS, GateOutputUnparseable, parseFindings, TEST_FAILED_RULE } from './parsers.ts';
export type {
  AttemptVerdict,
  FindingDelta,
  ProjectedFinding,
  RenderedBlobSha,
} from './projection.ts';
export { findingDelta, projectFindings } from './projection.ts';
// KAR-12.5 — the surgical repair loop: what a failing gate proposes, what the
// fix node is given, what its branch has to show, and where it stops.
export type {
  RepairAttempt,
  RepairAttemptRecord,
  RepairContext,
  RepairDecision,
  RepairHumanReason,
  RepairNext,
  RepairNextInput,
  RepairTarget,
} from './repair.ts';
export {
  assertFreshRepairContext,
  fixNodeId,
  gatesAfterRepair,
  REPAIR_ATTEMPT_CAP,
  REPAIR_SEVERITY_FLOOR,
  RepairContextNotFresh,
  repairAttemptProjection,
  repairable,
  repairNext,
  repairPatchesFor,
  repairPatchId,
  repairReason,
} from './repair.ts';
export type {
  RepairCommit,
  RepairOrdering,
  RepairOrderingCode,
  RepairOrderingOptions,
} from './repair-ordering.ts';
export {
  DEFAULT_TEST_PATHS,
  isTestPath,
  REPAIR_NO_FAILING_TEST,
  REPAIR_STILL_FAILING,
  repairOrdering,
} from './repair-ordering.ts';
export type { RepairFile, RepairPacketInput } from './repair-packet.ts';
export { buildRepairPacket, REPAIR_SEGMENT_IDS } from './repair-packet.ts';
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
export type { ScopeGateInput } from './scope-gate.ts';
export {
  assertRepairScope,
  DEFAULT_PROTECTED_PATHS,
  RepairScopeViolation,
  SCOPE_UNDECLARED_WRITE,
  scopeGateFindings,
} from './scope-gate.ts';
export type { SealVerdict } from './verdict-of.ts';
export {
  criterionStatusFor,
  DETERMINISTIC_MODEL,
  DETERMINISTIC_PROVIDER,
  sealVerdict,
  toDomainFinding,
} from './verdict-of.ts';
