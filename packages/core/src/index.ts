/**
 * @DeFlow/core — the pure domain and engine logic. Zero I/O.
 *
 * This file is the package's whole contract: re-exports only, no logic
 * (docs/16-repo-layout.md §8). Deep imports across packages are banned, so
 * anything meant to be shared is exported here or it is internal.
 *
 * R1: this package depends on nothing in the workspace and on nothing that can
 * perform I/O — zod and nothing else. Time, randomness and ids arrive through
 * ports declared here and implemented in @DeFlow/daemon or @DeFlow/testkit.
 *
 * EPIC-02 fills this in: TaskSpec, PlanGraph, PlanPatch, Fact, ContextPacket,
 * the Event union, reduce, decide, the patch policy and the permission ladder.
 */

// KAR-02.9 — the canonical JSON encoder and the content hashes built on it.
export { CanonicalJsonCycle, CanonicalJsonUnsupported, canonicalJson } from './canonical-json.ts';
export type { Clock, TimerHandle } from './clock.ts';
// KAR-02.6 — ContextPacket and typed segments.
export type {
  ContextBudget,
  ContextPacket,
  ContextTotals,
  PacketTotalsResult,
  Segment,
  SegmentKind,
  TokenCount,
  TokenCountMethod,
} from './context-packet.ts';
export {
  CONTEXTPACKET_SCHEMA_ID,
  ContextBudgetSchema,
  ContextPacketSchema,
  packetTotalsAreConsistent,
  renderOrderOf,
  SEGMENT_KINDS,
  SegmentKindSchema,
  SegmentSchema,
  TOKEN_COUNT_METHODS,
  TokenCountMethodSchema,
  TokenCountSchema,
} from './context-packet.ts';
// KAR-02.5 — Fact, Provenance and the blackboard vocabulary.
export type { Confidence, Fact, FactKind, Provenance } from './fact.ts';
export {
  CONFIDENCE_LEVELS,
  ConfidenceSchema,
  compareFactsByEventOrder,
  FACT_KINDS,
  FactKindSchema,
  FactSchema,
  keyMatchesKind,
  ProvenanceSchema,
} from './fact.ts';
export { contentHash, planHash, sha256Hex, specHash } from './hash.ts';

// KAR-02.1 — identifier types and the stable-NodeId invariant.
export type {
  Brand,
  CriterionId,
  EventSeq,
  FactId,
  GateId,
  Handle,
  IdempotencyKey,
  NodeId,
  NodeLifecycle,
  PlanHash,
  ProviderId,
  RunId,
  SchemaId,
  SegmentId,
} from './ids.ts';
export {
  CriterionIdSchema,
  EventSeqSchema,
  FactIdSchema,
  GateIdSchema,
  HandleSchema,
  NodeIdSchema,
  NodeLifecycleSchema,
  PlanHashSchema,
  ProviderIdSchema,
  RunIdSchema,
  SchemaIdSchema,
  SegmentIdSchema,
} from './ids.ts';
export type { ParsedIkey } from './ikey.ts';
// IdempotencyKeySchema is deliberately not exported (AC4) — ikey() below is
// the only legal constructor.
export { ikey, parseIkey } from './ikey.ts';
export type { ItemIdFrom } from './map-child-id.ts';
export { mapChildId } from './map-child-id.ts';
// KAR-02.10 — NodeResult, NodeFailure and the closed failure taxonomy.
export type {
  FailureClass,
  FailureTag,
  NodeFailure,
  NodeFailureReason,
  ToNodeFailureContext,
} from './node-failure.ts';
export {
  FAILURE_CLASSES,
  FAILURE_TAG,
  FailureClassSchema,
  GATE_ONLY_REASONS,
  NODE_FAILURE_REASONS,
  NodeFailureError,
  NodeFailureReasonSchema,
  NodeFailureSchema,
  readInternalFailureCount,
  resetInternalFailureCount,
  toNodeFailure,
} from './node-failure.ts';
export { NodeIdRegistry, NodeIdReused } from './node-id-registry.ts';
export type { NodeResult } from './node-result.ts';
export { CANCELLATION_SOURCES, NodeResultSchema, SUSPENSION_KINDS } from './node-result.ts';
// KAR-02.3 — PlanGraph, the seven node types and the reads reachability walk.
export type {
  AdapterRequirement,
  AgentNode,
  GateNode,
  HumanNode,
  LoopNode,
  MapNode,
  NodeBudget,
  NodeReturns,
  NodeType,
  ParsedPlanGraph,
  PathScope,
  PermissionLevel,
  PlanEdge,
  PlanGraph,
  PlanIssue,
  PlanNode,
  ReadDecl,
  RetryPolicy,
  SubgraphNode,
  ToolNode,
  WriteDecl,
} from './plan-graph.ts';
export {
  AdapterRequirementSchema,
  AgentNodeSchema,
  DEFAULT_ITEM_ID_FROM,
  DEFAULT_RETRY_POLICY,
  DEFAULT_RETURNS_MAX_TOKENS,
  GateNodeSchema,
  HumanNodeSchema,
  LoopNodeSchema,
  MapNodeSchema,
  NODE_TYPES,
  NodeBudgetSchema,
  NodeReturnsSchema,
  PathScopeSchema,
  PERMISSION_LEVELS,
  PermissionLevelSchema,
  PLANGRAPH_SCHEMA_ID,
  PlanEdgeSchema,
  PlanGraphSchema,
  PlanNodeSchema,
  parsePlanGraph,
  ReadDeclSchema,
  RetryPolicySchema,
  SubgraphNodeSchema,
  ToolNodeSchema,
  WriteDeclSchema,
} from './plan-graph.ts';
export type { UnsatisfiedRead } from './reads-satisfiable.ts';
export { readsAreSatisfiable } from './reads-satisfiable.ts';
export { mintRunId } from './run-id.ts';
// KAR-02.2 — TaskSpec schema, specHash identity and the pinning selector.
export type {
  AcceptanceCriterion,
  AcceptanceCriterionCheck,
  FailureMode,
  PinnedField,
  PinnedNodeContext,
  PinnedSegmentInput,
  PriorDecision,
  TaskSpec,
  TaskSpecApproval,
} from './task-spec.ts';
export {
  AcceptanceCriterionCheckSchema,
  AcceptanceCriterionSchema,
  FailureModeSchema,
  PINNED_SPEC_FIELDS,
  PriorDecisionSchema,
  pinnedSegmentsOf,
  TASKSPEC_SCHEMA_ID,
  TaskSpecApprovalSchema,
  TaskSpecSchema,
} from './task-spec.ts';
export { SINGLE_LINE_MAX, singleLine, toSingleLine } from './text.ts';
export type { TokenUsage, TokenUsageSource, UsageTotals } from './token-usage.ts';
export { sumUsage, TokenUsageSchema, TokenUsageSourceSchema } from './token-usage.ts';
export type { Finding, Verdict } from './verdict.ts';
export {
  CRITERION_STATUSES,
  CriterionStatusSchema,
  FINDING_SEVERITIES,
  FindingSchema,
  FindingSeveritySchema,
  VERDICT_OUTCOMES,
  VerdictOutcomeSchema,
  VerdictSchema,
} from './verdict.ts';
