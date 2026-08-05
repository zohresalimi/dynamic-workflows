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

// KAR-02.8 — fact acceptance: shape, registration, then value.
export type {
  AcceptFactError,
  AcceptFactResult,
  FactSchemaRegistry,
  SchemaIssue,
} from './accept-fact.ts';
export { acceptFact } from './accept-fact.ts';
// KAR-02.9 — the canonical JSON encoder and the content hashes built on it.
export { CanonicalJsonCycle, CanonicalJsonUnsupported, canonicalJson } from './canonical-json.ts';
export type { Clock, TimerHandle } from './clock.ts';
// KAR-02.6 — ContextPacket and typed segments.
export type {
  ContextBudget,
  ContextPacket,
  ContextPacketRecord,
  ContextTotals,
  PacketTotalsResult,
  Segment,
  SegmentKind,
  SegmentRecord,
  TokenCount,
  TokenCountMethod,
} from './context-packet.ts';
export {
  CONTEXTPACKET_SCHEMA_ID,
  ContextBudgetSchema,
  ContextPacketRecordSchema,
  ContextPacketSchema,
  packetTotalsAreConsistent,
  renderOrderOf,
  SEGMENT_KINDS,
  SegmentKindSchema,
  SegmentRecordSchema,
  SegmentSchema,
  TOKEN_COUNT_METHODS,
  TokenCountMethodSchema,
  TokenCountSchema,
} from './context-packet.ts';
// KAR-03.1 — the Db port. The better-sqlite3 implementation lives in
// @DeFlow/ledger and the fake in @DeFlow/testkit; core never opens a database.
export type { Db, DbRunResult, DbStatement, DbValue } from './db.ts';
// KAR-02.7 — the ~40 event payload schemas and the §9 registry.
export type {
  CompactionFidelity,
  EffectKind,
  EventKind,
  EventPayloadOf,
  RunOutcome,
} from './event-payloads.ts';
export {
  BUDGET_DIMENSIONS,
  BUDGET_SCOPES,
  BudgetConsumedSchema,
  BudgetExceededSchema,
  COMPACTION_FIDELITIES,
  COMPACTION_SCOPES,
  COMPACTION_TRIGGERS,
  ContextBuiltSchema,
  ContextCompactedSchema,
  EFFECT_KINDS,
  EffectCompletedSchema,
  EffectFailedSchema,
  EffectStartedSchema,
  EVENT_CURRENT_VERSIONS,
  EVENT_KINDS,
  EVENT_SCHEMAS,
  EXPORT_BLOCK_REASONS,
  EXPORT_TARGETS,
  ExportBlockedSchema,
  FactInvalidatedSchema,
  FactReadSchema,
  FactWrittenSchema,
  GateEvaluatedSchema,
  HandoffOversizeSchema,
  HumanRequestedSchema,
  HumanRespondedSchema,
  isEventKind,
  LOCK_KINDS,
  NodeCompletedSchema,
  NodeFailedSchema,
  NodeLockSchema,
  NodeProgressSchema,
  NodeRetryScheduledSchema,
  NodeScheduledSchema,
  NodeStartedSchema,
  NodeSuspendedSchema,
  PinIntegrityViolatedSchema,
  PlanPatchedSchema,
  PlanPatchProposedSchema,
  PlanPatchRejectedSchema,
  PlanProposedSchema,
  ProviderProbedSchema,
  ProviderRateLimitedSchema,
  RUN_NEEDS_HUMAN_REASONS,
  RUN_OUTCOMES,
  RunCancelRequestedSchema,
  RunCreatedSchema,
  RunEndedSchema,
  RunNeedsHumanSchema,
  RunPauseToggledSchema,
  RunSpecApprovedSchema,
  RunStalledSchema,
  RunStartedSchema,
} from './event-payloads.ts';
// KAR-02.7 — the envelope and the total, forward-compatible reader.
export type { Event, EventEnvelope, ParseEventResult } from './events.ts';
export { EventEnvelopeSchema, parseEvent } from './events.ts';
// KAR-02.5 — Fact, Provenance and the blackboard vocabulary.
export type { Confidence, Fact, FactKind, Provenance } from './fact.ts';
export {
  CONFIDENCE_LEVELS,
  ConfidenceSchema,
  compareFactsByEventOrder,
  FACT_KINDS,
  FACT_SCHEMA_ID,
  FactKindSchema,
  FactSchema,
  keyMatchesKind,
  ProvenanceSchema,
} from './fact.ts';
// KAR-03.5 — the read path into the reducer: parse, upcast, fold, tally.
export type {
  FoldOptions,
  FoldRejection,
  FoldRejectionReason,
  FoldReport,
} from './fold-events.ts';
export { describeSkipped, foldEvents } from './fold-events.ts';
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
// KAR-02.8 — the schema registry and the pure JSON Schema 2020-12 emission.
export type { JsonSchemaDocument, SchemaRegistration } from './json-schema.ts';
export {
  AJV_2020_OPTIONS,
  JSON_SCHEMA_DIALECT,
  REGISTERED_SCHEMA_IDS,
  SCHEMA_ID_BASE,
  SCHEMA_REGISTRY,
  schemaFileName,
  schemaRegistrationOf,
  serializeSchemaDocument,
  toJsonSchemaDocument,
  toJsonSchemaDocuments,
  UnknownSchemaId,
} from './json-schema.ts';
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
export type { CompletedNodeResult, NodeResult, NodeSuspension } from './node-result.ts';
export {
  CANCELLATION_SOURCES,
  CompletedNodeResultSchema,
  NodeResultSchema,
  NodeSuspensionSchema,
  SUSPENSION_KINDS,
} from './node-result.ts';
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
// KAR-02.4 — PlanPatch, PatchDecision and the structural well-formedness check.
export type {
  BlastRadius,
  PatchDecision,
  PatchDecisionOutcome,
  PatchError,
  PatchErrorKind,
  PatchOp,
  PatchOpKind,
  PatchPolicy,
  PatchRetirement,
  PatchWellFormedness,
  PermissionEscalation,
  PlanPatch,
  ProposedBy,
} from './plan-patch.ts';
export {
  AbandonBranchOpSchema,
  BlastRadiusSchema,
  ExtendLoopOpSchema,
  InsertNodesOpSchema,
  PATCH_DECISIONS,
  PATCH_ERROR_KINDS,
  PATCH_OPS,
  PatchDecisionSchema,
  PatchOpSchema,
  PatchPolicySchema,
  PermissionEscalationSchema,
  PLANPATCH_SCHEMA_ID,
  PlanPatchSchema,
  ProposedBySchema,
  patchIsWellFormed,
  ReplaceProviderOpSchema,
  retirementsOf,
  SplitNodeOpSchema,
} from './plan-patch.ts';
export type { UnsatisfiedRead } from './reads-satisfiable.ts';
export { readsAreSatisfiable } from './reads-satisfiable.ts';
// KAR-03.5 — the pure, total reducer and the projection it folds into.
export { reduce } from './reduce.ts';
export { mintRunId } from './run-id.ts';
export type {
  BudgetBreach,
  BudgetState,
  LockState,
  NeedsHumanState,
  NodeIdRegistryState,
  NodeState,
  NodeStatus,
  RunState,
  RunStatus,
} from './run-state.ts';
// KAR-03.6 — CHECKPOINT_VERSION stamps the cache; RunStateSchema is what a
// decoded `run.state_json` has to survive before it may become state.
export {
  CHECKPOINT_VERSION,
  initialRunState,
  lockKey,
  NODE_STATUSES,
  RUN_STATUSES,
  RunStateSchema,
} from './run-state.ts';
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
export {
  sumUsage,
  TokenUsageSchema,
  TokenUsageSourceSchema,
  UsageTotalsSchema,
} from './token-usage.ts';
// KAR-02.7 — the read-time upcaster chain.
export type {
  MissingHop,
  Upcaster,
  UpcasterRegistration,
  UpcasterViolation,
} from './upcasters.ts';
export {
  assertUpcasterChainsComplete,
  checkUpcasterFixtures,
  checkUpcastersPreserveRequiredFields,
  DuplicateUpcaster,
  eventUpcasters,
  registerUpcaster,
  UnknownUpcasterKind,
  UpcasterChainIncomplete,
  UpcasterFutureVersion,
  UpcasterRegistry,
  upcast,
} from './upcasters.ts';
export type { Finding, Verdict } from './verdict.ts';
export {
  CRITERION_STATUSES,
  CriterionStatusSchema,
  FINDING_SCHEMA_ID,
  FINDING_SEVERITIES,
  FindingSchema,
  FindingSeveritySchema,
  VERDICT_OUTCOMES,
  VERDICT_SCHEMA_ID,
  VerdictOutcomeSchema,
  VerdictSchema,
} from './verdict.ts';
