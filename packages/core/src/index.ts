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
// KAR-10.4 AC5 — a verdict is scoped to the spec it judged: F7.4's board, the
// void rule, and the gates a spec edit sends back.
export type {
  AcceptanceBoardInput,
  BoardCriterion,
  BoardRow,
  BoardStatus,
} from './acceptance-board.ts';
export {
  acceptanceBoard,
  CONSTRAINT_CRITERION_PREFIX,
  constraintCriteria,
  isVerdictVoid,
  staleGateNodes,
  verdictAgainst,
} from './acceptance-board.ts';
// KAR-09.5 — the inline threshold and the handle line an offloaded body leaves
// behind.
export {
  byteLengthOf,
  defaultDescription,
  exceedsInlineThreshold,
  formatByteSize,
  handleForSegment,
  handleStubText,
  INLINE_THRESHOLD_BYTES_DEFAULT,
  lineCountOf,
  READ_ARTIFACT_TOOL,
  truncatedDigest,
} from './artifact-offload.ts';
// KAR-14.2 — F4.6's ceilings: what is in force, and what has been crossed.
export type {
  BudgetEnforceability,
  BudgetTrip,
  Ceiling,
  EffectiveCeilings,
  RequestedBudget,
  RunCeilings,
  UnmeasurableProvider,
} from './budget-ceiling.ts';
export {
  BUDGET_FAILURE_CLASS,
  budgetEnforceability,
  budgetTripFailure,
  budgetTrips,
  ceilingHash,
  initialCeilings,
  nodeCeiling,
  plannedNodes,
  RunCeilingsSchema,
  resolveCeilings,
} from './budget-ceiling.ts';
// KAR-09.2 — packet assembly under a token budget: fill order, the budget
// ceiling, and the demotion ladder that offloads rather than summarises.
export type {
  BudgetInput,
  BudgetResolution,
  DemotedBody,
  DemotionReason,
  PacketBuild,
  PacketBuildInput,
  PacketDemotion,
  PacketPinnedInput,
  PacketReinjectionInput,
  PacketTarget,
} from './build-packet.ts';
export {
  BUDGET_FRACTION_CEILING,
  BUDGET_FRACTION_DEFAULT,
  buildPacket,
  DEMOTION_REASONS,
  FILL_ORDER,
  PinnedSegmentSuppliedLate,
  resolveContextBudget,
  SegmentContentHashMismatch,
} from './build-packet.ts';
// KAR-02.9 — the canonical JSON encoder and the content hashes built on it.
export { CanonicalJsonCycle, CanonicalJsonUnsupported, canonicalJson } from './canonical-json.ts';
export type { Clock, TimerHandle } from './clock.ts';
// KAR-06.1 — the closed Command union decide() returns and the EffectRunner
// performs. Every member carries what the runner needs, so the shell never
// reads RunState.
export type {
  AcquireLock,
  CancelNode,
  Command,
  EmitEvent,
  EmittedEvent,
  ReleaseLock,
  ScheduleWake,
  StartNode,
  WakeReason,
} from './command.ts';
export { COMMAND_ORDER, NO_DEADLINE_WAKE_AT, WAKE_REASONS } from './command.ts';
// KAR-09.6 — compaction with a fidelity discriminator: the union that makes
// "a vendor.session event is never exact" a compile error, the F10.5
// projection that labels an inferred figure, and the auto-compact arithmetic.
export type {
  AutoCompactConstants,
  Compaction,
  CompactionBar,
  CompactionBarStyle,
  CompactionChart,
  CompactionLever,
  CompactionTrigger,
  CompactionView,
  DroppedSegmentEntry,
  PacketCompaction,
  ReportedWindow,
  VendorCompaction,
  VendorCompactTrigger,
} from './compaction.ts';
export {
  AutoCompactDisableRefused,
  compactionChart,
  compactionLever,
  compactionTriggerOf,
  compactionView,
  DEFAULT_AUTOCOMPACT_PCT,
  defaultAutoCompactThreshold,
  effectiveWindowOf,
  INFERRED_AFTER_TOOLTIP,
  INFERRED_LABEL,
  NOT_REPORTED_LABEL,
  overriddenAutoCompactThreshold,
  packetCompaction,
  VENDOR_UNREPORTED_NOTE,
  vendorCompaction,
} from './compaction.ts';
// KAR-10.4 AC2 — the byte-preserving compiler behind the pinned set.
export type { CompiledPinnedSegment, PinnedQuote } from './compile-pinned.ts';
export { canonicalSpecText, compilePinnedSegments } from './compile-pinned.ts';
// KAR-09.3, KAR-09.4 — the Constraint union, §4.2's build-time restatement and
// the forbid ratio DeFlow doctor reports.
export type {
  AllowOnlyConstraint,
  AllowOnlySubject,
  Constraint,
  ConstraintCounts,
  ForbidConstraint,
} from './constraint.ts';
export {
  ALLOW_ONLY_SUBJECTS,
  AllowOnlyConstraintSchema,
  ConstraintSchema,
  convertibleForbids,
  countConstraintForms,
  ForbidConstraintSchema,
  forbidRatio,
  orderPinnedConstraints,
  RequireConstraintSchema,
  restateAsRequirement,
  restateForbidAsAllowOnly,
} from './constraint.ts';
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
// KAR-14.3 — the pre-flight estimator: what a plan, or a patch, is about to
// cost, with the method, the calibration factor and the price-table version on
// every figure — and `null`, never `0`, for anything it cannot price.
export type {
  AppliedCalibration,
  EstimatorInputs,
  ModelRate,
  NodeEstimate,
  PatchEstimate,
  PatchEstimatorInputs,
  PlanEstimate,
  PriceTable,
  UnpriceableNode,
  UnpriceableReason,
} from './cost-estimate.ts';
export {
  DEFAULT_PRICE_TABLE,
  estimateNode,
  estimatePatch,
  estimatePlan,
  PRICE_TABLE_VERSION,
  priceKey,
  UNPRICEABLE_REASONS,
} from './cost-estimate.ts';
// KAR-14.1 — the accounting projection: per node, per provider, per run, with
// subscription quota and real currency as two figures and `null` as the only
// honest blank.
export type {
  AttemptCostRollup,
  BudgetRollup,
  Consumption,
  CostFigures,
  CostRollup,
  EstimateAccuracy,
  NodeCostRollup,
  PreflightEstimate,
} from './cost-rollup.ts';
export {
  addConsumption,
  BudgetRollupSchema,
  CostRollupSchema,
  consumptionKey,
  emptyCostRollup,
  initialBudgetRollup,
} from './cost-rollup.ts';
// KAR-03.1 — the Db port. The better-sqlite3 implementation lives in
// @DeFlow/ledger and the fake in @DeFlow/testkit; core never opens a database.
export type { Db, DbRunResult, DbStatement, DbValue } from './db.ts';
// KAR-06.1 — the whole scheduling policy, as a pure function of state and one
// instant.
export { decide } from './decide.ts';
// KAR-08.3 — the cheap syntactic second layer (§10.4), orthogonal to the
// ladder: an allowlisted binary at an identity or infrastructure boundary.
// KAR-09.4 — the slice of .DeFlow/config.yaml the re-injection interval and the
// run-config constraints are read from. The file itself is read in the daemon.
export type {
  BudgetCeilingConfig,
  BudgetConfig,
  ContextConfig,
  DeFlowConfig,
  ProviderConfig,
} from './deflow-config.ts';
export {
  ContextConfigSchema,
  compactionLeverFor,
  configuredConstraints,
  DeFlowConfigSchema,
  inlineThresholdBytesOf,
  ProviderConfigSchema,
  parseDeFlowConfig,
  pinReinjectTurnsFor,
} from './deflow-config.ts';
export type { CommandContext, DestructiveReason } from './destructive-command.ts';
export { DESTRUCTIVE_COMMANDS, destructiveCommand } from './destructive-command.ts';
// KAR-06.3 — what the effect journal remembers about what was asked for, so a
// plan edit landing under a journalled effect cannot return the memoised
// result of the operation it replaced.
export type { EffectRequest } from './effect-request.ts';
export { requestHash } from './effect-request.ts';
// KAR-02.7 — the ~40 event payload schemas and the §9 registry.
export type {
  CancelMode,
  CancelStage,
  CompactionFidelity,
  EffectKind,
  EventKind,
  EventPayloadOf,
  LockReleaseReason,
  PlannerAttribution,
  PlannerTier,
  ProviderAuthMode,
  RunOutcome,
  WorktreeOccupantKind,
} from './event-payloads.ts';
export {
  BUDGET_DIMENSIONS,
  BUDGET_SCOPES,
  BudgetConsumedSchema,
  BudgetExceededSchema,
  CANCEL_MODES,
  CANCEL_STAGES,
  COMPACTION_FIDELITIES,
  COMPACTION_SCOPES,
  COMPACTION_TRIGGERS,
  ContextBuiltSchema,
  ContextCompactedSchema,
  EFFECT_KINDS,
  EffectCancelledSchema,
  EffectCompletedSchema,
  EffectFailedSchema,
  EffectStartedSchema,
  EnvDeclaredSchema,
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
  LOCK_RELEASE_REASONS,
  NodeBlockedSchema,
  NodeCancelFailedSchema,
  NodeCancelledSchema,
  NodeCancelStageSchema,
  NodeCompletedSchema,
  NodeFailedSchema,
  NodeLockReleasedSchema,
  NodeLockSchema,
  NodeProgressSchema,
  NodeRetryScheduledSchema,
  NodeScheduledSchema,
  // KAR-08.7 — the completion-time backstop for an adapter that never
  // populates ToolCallLocation.
  NodeScopeWarningSchema,
  NodeStartedSchema,
  NodeSuspendedSchema,
  NodeUnschedulableSchema,
  PermissionDeniedSchema,
  PinIntegrityViolatedSchema,
  PLANNER_TIERS,
  PlannerAttributionSchema,
  PlanPatchedSchema,
  PlanPatchProposedSchema,
  PlanPatchRejectedSchema,
  PlanProposedSchema,
  PlanValidationFailedSchema,
  PROVIDER_AUTH_MODES,
  ProviderAuthModeSchema,
  ProviderAuthShadowStrippedSchema,
  ProviderProbedSchema,
  ProviderRateLimitedSchema,
  // KAR-08.2 — the ceiling on the agent-supplied path a denial keeps verbatim.
  REQUESTED_PATH_MAX,
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
  WORKTREE_OCCUPANT_KINDS,
  WorkspaceBranchOccupiedSchema,
  WorkspaceDirtyOnRemoveSchema,
  WorkspaceIncludedFileSchema,
  WorkspaceMergeQueueReorderedSchema,
  WorkspaceOrphanReapedSchema,
  WorkspacePidRecycledSchema,
  WorkspaceReconciledSchema,
  WorkspaceSetupCacheHitSchema,
  WorkspaceStatusEntrySchema,
  WorkspaceWipSalvagedSchema,
  WorkspaceWorktreeCreatedSchema,
  WorkspaceWorktreeRemovedSchema,
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
// KAR-10.2 — the framing interview's return contract, its criteria contract,
// and the projection onto the `TaskSpec` `run.created` carries.
export type {
  ClarifyingExchange,
  DraftAcceptanceCriterion,
  DraftFailureMode,
  DraftIssue,
  DraftPriorDecision,
  PriorDecisionSource,
  TaskSpecDraft,
} from './framing.ts';
export {
  answersAsPriorDecisions,
  criteriaContractIssues,
  criterionOrdinal,
  DraftAcceptanceCriterionSchema,
  DraftFailureModeSchema,
  DraftPriorDecisionSchema,
  FRAMING_PERMISSION,
  FRAMING_RETURN_MAX_TOKENS,
  framingReturns,
  PRIOR_DECISION_SOURCES,
  sealTaskSpec,
  TASKSPEC_DRAFT_SCHEMA_ID,
  TaskSpecDraftInvalid,
  TaskSpecDraftSchema,
  validateTaskSpecDraft,
  withClarifyingAnswers,
} from './framing.ts';
// KAR-10.2 AC9 — what the framing agent is given: the raw task, the repository
// at `read`, and no other node's transcript (F6.1).
export type { FramingPacketInput, FramingSegmentKind, RejectedFraming } from './framing-packet.ts';
export {
  buildFramingPacket,
  ForeignSegmentInFramingPacket,
  FRAMING_SEGMENT_KINDS,
} from './framing-packet.ts';
// KAR-08.1 AC5 — `full` is an explicit per-run opt-in a PlanPatch cannot
// acquire on its own authority.
export type { FullEscalationRuling, FullPermissionOptIn } from './full-permission.ts';
export {
  FULL_IS_NOT_A_SANDBOX,
  FULL_OPT_IN_RULE,
  FullPermissionOptInSchema,
  fullEscalationRuling,
  fullPermissionIssues,
} from './full-permission.ts';
// KAR-09.4 AC8 / §4.3 — a gate's criteria come from the ledger, never from the
// agent's context.
export type { GateSpecUnavailableReason, LedgerSpec } from './gate-spec.ts';
export { GateSpecUnavailable, gateSpecFromLedger } from './gate-spec.ts';
// KAR-09.5 — the handle grammar, the line range, and the permission check
// DeFlow_read_artifact needs because it sits outside the ACP fs/* path.
export type {
  HandleDenial,
  HandleRefusal,
  HandleRefusalCode,
  NodeHandleAccess,
  ParsedArtifactHandle,
  ParsedFileHandle,
  ParsedHandle,
} from './handle-access.ts';
export { decideFileHandleAccess, parseHandle, sliceLines } from './handle-access.ts';
// KAR-09.9 — the enforced return budget, the one bounded repair, and the rule
// that there is no truncation path anywhere on the handoff.
export type {
  AgentRole,
  HandoffCause,
  HandoffInput,
  HandoffJudgement,
  HandoffOutcome,
  HandoffOversize,
  HandoffOversizeRate,
  HandoffSample,
  StructuredOutput,
} from './handoff.ts';
export {
  agentRoleOf,
  DEFAULT_RETURN_BUDGET,
  defaultReturnBudget,
  HANDOFF_REPAIR_LIMIT,
  handoffOversizeRates,
  judgeHandoff,
  judgeVendorFailure,
  RETURN_BUDGET_DEFAULTS,
  repairPromptFor,
  withReturnBudgetDefaults,
} from './handoff.ts';
export { contentHash, planHash, sha256Hex, sha256HexBytes, specHash } from './hash.ts';
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
  isNodeIdSlug,
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
// the only legal constructor. KAR-06.3 adds the short-hex form the atomic file
// write embeds in a temp filename, where the raw key's `/` cannot go.
export { IKEY_SHORT_HASH_LENGTH, ikey, parseIkey, shortIkeyHash } from './ikey.ts';
// KAR-02.8 — the schema registry and the pure JSON Schema 2020-12 emission.
// KAR-10.3 — RFC 6902 as a schema. The differ itself is @DeFlow/daemon's (R1).
export type { JsonPatchOperation } from './json-patch.ts';
export { JsonPatchOperationSchema } from './json-patch.ts';
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
// KAR-06.2 — F5.2's per-resource-class locks: what a node claims, and who
// holds it. State-derived; the ledger is the only record.
export type { LockClaim } from './locks.ts';
export { claimId, lockClaims, lockHolder, repoLockKey } from './locks.ts';
export type { ItemIdFrom } from './map-child-id.ts';
export { mapChildId } from './map-child-id.ts';
// §4.1's never-implicit environment families, shared by KAR-08.4's scrubbing
// and KAR-08.5's delegated credential policy so the two cannot drift.
export type { NeverImplicitFamily } from './never-implicit.ts';
export { isNeverImplicit, NEVER_IMPLICIT_FAMILIES } from './never-implicit.ts';
// KAR-06.8 — F4.7's stall detector, churn circuit breaker and hard caps, all
// pure reads of `(RunState, now)`.
export type {
  CapBreach,
  ChurnTrip,
  CompletedAttempt,
  NoProgress,
  NoProgressPolicy,
  ReplanStreak,
  RunCap,
  StallReport,
} from './no-progress.ts';
export {
  CHURN_WINDOW,
  DEFAULT_NO_PROGRESS_POLICY,
  INITIAL_REPLAN_STREAK,
  needsHumanOf,
  noProgress,
  RUN_CAPS,
} from './no-progress.ts';
// KAR-02.10 — NodeResult, NodeFailure and the closed failure taxonomy.
export type {
  FailureClass,
  FailureTag,
  NodeFailure,
  NodeFailureReason,
  ToNodeFailureContext,
} from './node-failure.ts';
export {
  budgetBreachOf,
  budgetExceededFailure,
  dependencyFailedFailure,
  escalatesToHuman,
  FAILURE_CLASSES,
  FAILURE_TAG,
  FailureClassSchema,
  GATE_ONLY_REASONS,
  NODE_FAILURE_REASONS,
  NodeFailureError,
  NodeFailureReasonSchema,
  NodeFailureSchema,
  needsHumanCategory,
  readInternalFailureCount,
  resetInternalFailureCount,
  toNodeFailure,
} from './node-failure.ts';
export { NodeIdRegistry, NodeIdReused } from './node-id-registry.ts';
export type {
  CancellationSource,
  CancelledNodeResult,
  CompletedNodeResult,
  NodeResult,
  NodeSuspension,
} from './node-result.ts';
export {
  CANCELLATION_SOURCES,
  CancelledNodeResultSchema,
  CompletedNodeResultSchema,
  NodeResultSchema,
  NodeSuspensionSchema,
  SUSPENSION_KINDS,
} from './node-result.ts';
// KAR-14.3 — F2.5's patch policy engine: the estimate turned into a decision,
// first match wins, and a `null` cost matching no numeric rule.
export type {
  PatchPolicyDecision,
  PatchPolicyInput,
  PatchPolicyRuling,
  PatchRule,
  RerouteEquivalence,
  RulablePatchEstimate,
} from './patch-policy.ts';
export {
  BUDGET_EXHAUSTED_FRACTION,
  DEFAULT_PATCH_RULES,
  EXPENSIVE_COST_USD,
  elapsedBudgetFraction,
  evaluatePatchPolicy,
  MAX_REPLAN_DEPTH,
  PATCH_POLICY_DECISIONS,
  patchDecisionOutcome,
  WIDE_BLAST_RADIUS_FILES,
} from './patch-policy.ts';
// KAR-08.7 — the declared-path-scope glob matcher, the normalizer that keeps
// it agreeing with KAR-08.2's containment check, and the plan-time check that
// a write node's pathScope is not empty.
export type { EmptyWriteScope } from './path-scope.ts';
export { emptyWriteScopes, pathScopeMatches, relativeToWorktree } from './path-scope.ts';
// KAR-08.1 — F5.4's four-level ladder as one pure function of
// `(level, request, scope)`. No I/O, no vendor CLI, no clock.
export type {
  CommandsConfig,
  OfferedPermissionOption,
  PermissionAnswer,
  PermissionDenyCode,
  PermissionGateCode,
  PermissionMethod,
  PermissionOptionKind,
  PermissionOutcomeKind,
  PermissionReason,
  PermissionRequest,
  PermissionScope,
} from './permission.ts';
export {
  decidePermission,
  EnvDeclarationAtReadLevelError,
  OFFERED_PERMISSION_OPTIONS,
  optionIdFor,
  PERMISSION_DENY_CODES,
  PERMISSION_GATE_CODES,
  PERMISSION_OPTION_KINDS,
  PERMISSION_OUTCOMES,
  permissionScopeFrom,
  reasonCode,
  validateEnvDeclaration,
} from './permission.ts';
// KAR-09.3 — the F6.6 integrity check: the pinned bytes are in the prompt that
// was actually sent, or the node fails and a human is asked.
export type {
  PinnedPacketView,
  PinnedSegmentView,
  PinViolation,
  PinViolationKind,
} from './pin-integrity.ts';
export {
  assertPinIntegrity,
  findPinViolations,
  PinIntegrityViolation,
  pinnedKept,
} from './pin-integrity.ts';
// KAR-09.3 — the five pinned content types and the one producer of the flag.
export type {
  ContextSegmentInput,
  DemotionResult,
  FramingPinnedInput,
  PinnedBuildInput,
  PinnedContentType,
  PinnedSegmentKind,
  SegmentedPacket,
  SpecPinnedInput,
  TokenEstimator,
  UnpinnedSegmentKind,
} from './pinned-set.ts';
export {
  assertPinnedSetFitsBudget,
  buildFramingPinnedSegments,
  buildPinnedSegments,
  buildSpecPinnedSegments,
  contextSegment,
  demoteToBudget,
  demotionLadder,
  heuristicTokens,
  PINNED_CONTENT_TYPES,
  PinnedSetExceedsBudget,
  pinnedConstraintsOf,
  selectCompactionCandidates,
} from './pinned-set.ts';
// KAR-11.1 — plan validation diagnostics as values (06 §3, §3.5). KAR-11.2
// grows the set; the shape and the rendering are fixed here.
export type {
  PlanDiagnostic,
  PlanDiagnosticCode,
  PlanDiagnosticSeverity,
} from './plan-diagnostics.ts';
export {
  hasBlockingDiagnostic,
  PLAN_DIAGNOSTIC_CODES,
  PLAN_DIAGNOSTIC_SEVERITIES,
  renderPlanDiagnostics,
} from './plan-diagnostics.ts';
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
  PatchCause,
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
  isReroutePatch,
  PATCH_CAUSES,
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
// KAR-10.5 AC7 — what the planner reads: the pinned spec and the recon facts,
// and no recon transcript (F6.1).
export type {
  PlannerCapability,
  PlannerCapabilityAnswer,
  PlannerFact,
  PlannerPacketInput,
  PlannerSegmentKind,
} from './planner-packet.ts';
export {
  buildPlannerPacket,
  CAPABILITY_SEGMENT_ID,
  ForeignSegmentInPlannerPacket,
  PLANNER_SEGMENT_KINDS,
  renderCapabilitySegmentText,
  renderFactSegmentText,
} from './planner-packet.ts';
export type { Random } from './random.ts';
export { seededRandom } from './random.ts';
// KAR-14.4 — a rate limit as a value: normalised with the vendor payload kept
// verbatim, classified `transient`, and turned into a durable wake at the
// vendor's own reset rather than a retry storm.
export type { QuotaWake, QuotaWakeInput, RateLimit } from './rate-limit.ts';
export {
  describeRateLimit,
  QUOTA_CAUSE,
  QUOTA_WAKE_REASON,
  quotaWake,
  RATE_LIMIT_BACKOFF,
  rateLimitedFailure,
  rateLimitFailureTag,
  rateLimitMessage,
  rateLimitOf,
  rateLimitResetsAt,
} from './rate-limit.ts';
// KAR-02.3 — the F6.2 read-reachability gate under its EPIC-02 name and
// `{ node, read }` return shape. One implementation, in
// ./validate-declared-reads.ts; this is a view over it, not a second walk.
export type { UnsatisfiedRead } from './reads-satisfiable.ts';
export { readsAreSatisfiable } from './reads-satisfiable.ts';
// KAR-10.5 — repository reconnaissance: the agent claims, the daemon observes,
// and `confidence` is what the join between them produces (F2.2).
export type {
  DeriveReconFactsInput,
  GateObservation,
  ManifestKind,
  ManifestObservation,
  ReconCommandRole,
  ReconFactCandidate,
  ReconFactValue,
  ReconSurvey,
  RepoObservation,
  ScopeObservation,
} from './recon.ts';
export {
  deriveReconFacts,
  fileEvidenceHandle,
  jsonScriptLineRange,
  MANIFEST_KINDS,
  RECON_COMMAND_ROLES,
  RECON_FACT_SCHEMA_ID,
  RECON_PERMISSION,
  RECON_RETURN_MAX_TOKENS,
  RECON_SURVEY_SCHEMA_ID,
  ReconFactValueSchema,
  ReconSurveySchema,
  reconReturns,
  scriptKeyOf,
} from './recon.ts';
// KAR-03.5 — the pure, total reducer and the projection it folds into.
export { reduce } from './reduce.ts';
// KAR-09.4 §4.2(a) — when the pinned set is due for re-injection, and the
// planning warning where a turn boundary cannot be steered.
export type { ReinjectCounter, ReinjectionPlanningInput, TurnTick } from './reinjection.ts';
export {
  afterReinjection,
  afterTurn,
  PIN_REINJECT_TURNS_DEFAULT,
  reinjectionPlanningWarning,
  startReinjection,
} from './reinjection.ts';
// KAR-09.3 — the pure render, whose only opinion this story owns is that the
// pinned block leads it.
export { FreeProsePinnedSegment, renderPacket } from './render-packet.ts';
// KAR-09.10 — an `artifact_fts` hit, turned into a `retrieved` segment: the
// pull-line text and the 20-row ceiling, single-sourced against the ledger's
// `LIMIT`.
export type { ArtifactRetrievalHit } from './retrieval.ts';
export {
  RETRIEVED_ARTIFACT_LIMIT,
  retrievedSegmentsOf,
  retrievedSegmentText,
} from './retrieval.ts';
// KAR-06.5 — the retry ladder: classified failure in, jittered schedule out.
export type { Backoff, ReroutePatchInput, RetryPlan, RetryPlanInput } from './retry.ts';
export { backoffDelay, backoffWindow, planRetry, reroutePatch } from './retry.ts';
export { mintRunId } from './run-id.ts';
export type {
  BudgetBreach,
  BudgetState,
  CancelState,
  LockState,
  NeedsHumanState,
  NodeIdRegistryState,
  NodeState,
  NodeStatus,
  RunState,
  RunStatus,
  SchedulingPolicy,
} from './run-state.ts';
// KAR-03.6 — CHECKPOINT_VERSION stamps the cache; RunStateSchema is what a
// decoded `run.state_json` has to survive before it may become state.
export {
  CHECKPOINT_VERSION,
  DEFAULT_SCHEDULING_POLICY,
  initialNodeState,
  initialRunState,
  lockKey,
  NODE_STATUSES,
  RUN_STATUSES,
  RunStateSchema,
} from './run-state.ts';
// KAR-08.5 — the per-node sandbox policy, in each enforcement engine's own
// dialect. Pure: this package generates the documents, `@DeFlow/adapters` puts
// them on an argv (D12 — DeFlow owns policy, the vendor owns enforcement).
export type {
  ClaudeGatedKey,
  ClaudeSandboxInput,
  ClaudeSandboxPolicy,
  ClaudeSandboxSettings,
  CodexSandboxPolicy,
  CodexWorkspaceWrite,
  GateDisposition,
  SandboxDegradation,
  SandboxPolicyInput,
  SandboxRuntimeConfig,
  SandboxStrategy,
} from './sandbox-policy.ts';
export {
  CLAUDE_SANDBOX_GATES,
  CODEX_WORKSPACE_WRITE_KEYS,
  CREDENTIAL_GATED_KEYS,
  claudeSandboxPolicy,
  codexSandboxPolicy,
  compareVersions,
  LINUX_SANDBOX_DEPENDENCIES,
  SANDBOX_CREDENTIAL_FILES,
  SANDBOX_DEPENDENCY_NAMES,
  SANDBOX_RUNTIME_BIN,
  SANDBOX_RUNTIME_PACKAGE,
  SANDBOX_RUNTIME_VERSION,
  SANDBOX_STRATEGIES,
  sandboxDependencies,
  sandboxRuntimeConfig,
  sandboxStrategy,
  VENDOR_SANDBOX_PROVIDERS,
} from './sandbox-policy.ts';
// The primitives both of the above are expressed in.
export {
  binaryName,
  domainAllowed,
  hostOf,
  isLoopback,
  pathDepth,
  pathIsInside,
  resolvePosix,
} from './scope.ts';
// KAR-07.6 AC7 — the one plan-time refusal declared path scopes still carry.
export type { ScopeCollision } from './scope-collision.ts';
export { scopeCollisions } from './scope-collision.ts';
// KAR-10.3 — the F1.3 approval gate's pure half: what the operator is shown,
// what an edit produces, and what a mid-run edit is revalidated against.
export type {
  SpecAmendment,
  SpecCoverageIssue,
  SpecDecision,
  SpecVersion,
} from './spec-approval.ts';
export {
  currentSpec,
  emptyEditRefusal,
  hashableSpec,
  renderSpecForReview,
  revalidateSpecAgainstPlan,
  SPEC_APPROVAL_OPTIONS,
  SPEC_DECISIONS,
  SPEC_GATE_NODE,
  SpecEditRefused,
  sealEditedSpec,
  specHistory,
} from './spec-approval.ts';
// KAR-10.1 — task intake: `normaliseInput` and the `task.submitted` payload shape.
export type {
  IntakeKind,
  IntakeSubmitter,
  NormaliseFileInput,
  NormaliseInput,
  NormaliseInputPorts,
  NormaliseIssueInput,
  NormaliseTextInput,
  TaskProvenance,
  TaskSubmitted,
} from './task-intake.ts';
export {
  INTAKE_INLINE_THRESHOLD_BYTES,
  INTAKE_KINDS,
  INTAKE_SUBMITTERS,
  normaliseInput,
  TaskProvenanceSchema,
  TaskSubmittedSchema,
} from './task-intake.ts';
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
// KAR-09.7 — three measurement tiers, and the honest blank when none can answer.
export type {
  NodeCostInput,
  ProjectedNodeCost,
  TokenAccounting,
  TokenTier,
  TokenTierInput,
} from './token-accounting.ts';
export {
  projectNodeCost,
  selectTokenTier,
  TOKEN_ACCOUNTING_MODES,
  TOKEN_TIERS,
  TokenAccountingSchema,
} from './token-accounting.ts';
// KAR-09.7 — the self-calibrating Tier-2 correction factor.
export type { Calibration } from './token-calibration.ts';
export {
  appliedFactor,
  CALIBRATION_ALPHA,
  CALIBRATION_MIN_SAMPLES,
  CALIBRATION_SEEDS,
  calibratedEstimate,
  seededCalibration,
  seedFactor,
  updateCalibration,
} from './token-calibration.ts';
export type { TokenUsage, TokenUsageSource, UsageTotals } from './token-usage.ts';
export {
  sumUsage,
  TokenUsageSchema,
  TokenUsageSourceSchema,
  UsageTotalsSchema,
} from './token-usage.ts';
// KAR-09.7 — the Tier-2 `Tokenizer` port. Implemented in @DeFlow/daemon, in the
// same style as `Clock` and `Db`; core owns no BPE table.
export type { Tokenizer } from './tokenizer.ts';
export { contextFillPercent } from './tokenizer.ts';
export { PlanCycleError, topoSort } from './topo-sort.ts';
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
// KAR-09.1 — declared reads validated at plan time: the cheapest correctness
// gate in the system, run on every plan.proposed and plan.patched.
export type { UndeclaredReadError } from './validate-declared-reads.ts';
export { PINNED_KEYS, satisfies, validateDeclaredReads } from './validate-declared-reads.ts';
// KAR-11.2 — the one entry point to plan validation (06 §3), plus the two
// values it is built on: `topoSort` throwing is the cycle check, and
// `PlanTimeCapability` is what a probed row projects to at plan time.
export type { PlanTimeCapability, ValidatePlanOptions } from './validate-plan.ts';
export { PLAN_SCOPE, resumeByReplayNodes, validatePlan } from './validate-plan.ts';
export type { CriterionStatus, Finding, Verdict, VerdictV2 } from './verdict.ts';
export {
  CRITERION_STATUSES,
  CriterionStatusSchema,
  FINDING_SCHEMA_ID,
  FINDING_SEVERITIES,
  FindingSchema,
  FindingSeveritySchema,
  VERDICT_OUTCOMES,
  VERDICT_SCHEMA_ID,
  VERDICT_V2_SCHEMA_ID,
  VerdictOutcomeSchema,
  VerdictSchema,
  VerdictV2Schema,
} from './verdict.ts';
