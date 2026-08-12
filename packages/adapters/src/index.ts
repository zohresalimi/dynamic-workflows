/**
 * @DeFlow/adapters — the ACP client, the per-vendor CLI exec shims, capability
 * probing and persistence, and the golden-recording tee.
 *
 * This file is the package's whole contract: re-exports only, no logic
 * (docs/16-repo-layout.md §8).
 *
 * KAR-05.1 ships the client: `initialize` with a fixed, minimal capability
 * set, `session/new` into the node's worktree, and the `session.nextUpdate()`
 * pull loop that awaits the durable append before asking the agent for more.
 * The rest of EPIC-05 fills in probing, the registry, the frame guard, resume,
 * the MCP host and the conformance suite.
 */
// KAR-05.2 — admission control: the last question before a spawn, answered
// from the probed row.
export {
  ADAPTER_REQUIREMENT_CAPABILITIES,
  type AdmissionRequest,
  admit,
  CAPABILITY_REQUIREMENTS,
  type CapabilityRequirement,
} from './admission.ts';
// KAR-05.3 — an absolute path or a failure that names what was looked for and
// where. PATH is never consulted (§4.3).
export type { ResolveContext, ResolvedProvider, SearchedPath } from './binary-resolver.ts';
export { resolveExecutable } from './binary-resolver.ts';
// KAR-05.2 — every routing question, answered from the probed row and from
// nothing else. There is no provider name in that module, by construction.
export {
  additionalDirectories,
  CAPABILITY_PATHS,
  type CapabilityAnswer,
  type CapabilityKey,
  type CapabilityReason,
  type CapabilityRow,
  canClose,
  canDelete,
  canFork,
  canList,
  canResume,
  capability,
  // KAR-14.4 AC7 — the two questions a quota re-route has to answer, both
  // computed from the probed row.
  capabilitySuperset,
  loadSession,
  mcpAcp,
  mediatedExecution,
  mediationUnchanged,
  missingCapabilities,
  supportsSteering,
  supportsTerminal,
} from './capabilities.ts';
export { CLIENT_CAPABILITIES, CLIENT_INFO } from './client-capabilities.ts';
// KAR-09.6 — the compaction lever as one vendor's environment, and the shape
// check that catches the day a decoded constant stops being true.
export {
  autoCompactConstants,
  checkCompactionShape,
  compactionEnv,
  vendorTranscriptPath,
} from './compaction.ts';
// KAR-05.7 — Layer B: the eight-assertion behavioural contract, as data rather
// than as test bodies, so `DeFlow doctor` can run it against installed CLIs.
export type {
  AdapterFactory,
  ConformanceAdapter,
  ConformanceCase,
  ConformancePorts,
  ConformanceReport,
  ConformanceResult,
  ConformanceStage,
  ConformanceStatus,
  ConformanceTarget,
  ConformanceUnavailable,
} from './conformance.ts';
export {
  CONFORMANCE_CASES,
  CONFORMANCE_FRAME_CAP_BYTES,
  describeConformance,
  HONESTY_METHODS,
  METHOD_NOT_FOUND,
  runProviderConformance,
  UNADVERTISED_METHOD,
} from './conformance.ts';
export type { AcpRateLimitContext } from './failures.ts';
export {
  ACP_ASSIGNED_ERROR_CODES,
  ACP_PROTOCOL_VERSION,
  acpRateLimit,
  advertisedButUnimplemented,
  agentExited,
  agentTimedOut,
  argvRejected,
  frameTooLarge,
  handshakeMismatch,
  InvalidRecordingKey,
  isMethodNotFound,
  METHOD_NOT_FOUND_CODE,
  NotImplementedOnWin32,
  offendingFrameHead,
  protocolError,
  RECORDING_DIR_SHAPE,
  registryRefused,
  resolutionFailed,
  SANDBOX_UNAVAILABLE_CAUSE,
  sandboxUnavailable,
  spawnRefused,
  toAdapterFailure,
  UnsignalablePid,
  undeclarableRateLimitCode,
} from './failures.ts';
// KAR-05.4 — the 8 MiB cap, counted upstream of the SDK's unbounded line
// buffer as bytes since the last newline.
export type { FrameGuard, FrameTooLargeReport } from './frame-guard.ts';
export {
  DEFAULT_MAX_FRAME_BYTES,
  FRAME_EVIDENCE_BYTES,
  frameGuard,
  InvalidFrameLimit,
  parseFrameLimit,
} from './frame-guard.ts';
// KAR-10.2 AC3 — the framing node's own admission: structured output at the
// adapter boundary, or refuse to schedule. There is no prose fallback.
export {
  admitFraming,
  type FramingAdmissionRequest,
  type FramingSchemaRequest,
  framingSchemaContract,
} from './framing-admission.ts';
// KAR-05.9 — the one abstraction allowed to send a signal, plus the PID-reuse
// guard's input. POSIX at M1; win32 throws rather than silently no-opping.
export type {
  DrainPorts,
  GroupMember,
  KillOutcome,
  KillTreePorts,
  SweepPorts,
} from './kill-tree.ts';
export {
  awaitGroupDrained,
  GROUP_POLL_MS,
  KILL_VERIFY_WINDOW_MS,
  killTree,
  liveGroupMembers,
  liveGroupRows,
  processStartTime,
  SWEEP_KILL_GRACE_MS,
  startTimeSource,
  sweepTree,
} from './kill-tree.ts';
// KAR-05.3 — spawning a provider, with the one bounded retry a flag
// mid-deprecation earns and no vendor knowledge of its own.
export type { LaunchOutcome, LaunchPorts, LaunchRequest } from './launch.ts';
export { LAUNCH_EXIT_GRACE_MS, launchProvider, STDERR_TAIL_BYTES } from './launch.ts';
// KAR-12.2 — reviewer provider routing: §3.1's preference written as a total
// rule, whose empty branch refuses rather than fabricating a verdict.
export {
  NO_CAPABLE_REVIEWER,
  pickReviewer,
  REVIEW_CONTEXT_HEADROOM,
  type ReviewerCandidate,
  type ReviewerDecision,
  type ReviewerExclusion,
  type ReviewerRequirementFailure,
  type ReviewerRouting,
} from './pick-reviewer.ts';
// KAR-11.2 — the same rows, projected into what plan validation may know about
// an adapter (06 §3.2). Read from the row; never a table.
export { planTimeCapabilities } from './plan-time-capabilities.ts';
// KAR-11.1 — the planner's third input, projected from probed rows, and the
// reasoning-effort control the initial plan is compiled at (06 §2.2, §6).
export type { ProbedRow } from './planner-capabilities.ts';
export { PLANNER_CAPABILITY_KEYS, plannerCapabilityList } from './planner-capabilities.ts';
export type { PlannerEffort, ResolvedEffort } from './planner-effort.ts';
export { PLANNER_EFFORTS, strongestEffort } from './planner-effort.ts';
export type {
  AcpNodeRequest,
  AcpPorts,
  AgentBinary,
  AgentProcessKey,
  AgentProcessRecord,
  CapabilityStore,
  ClientHandlers,
  EventRecord,
  IoRecord,
  LedgerSink,
  NodeWakeRow,
  ProcessRegistry,
  WakeRegistry,
} from './ports.ts';
// KAR-05.2 — spawn, one `initialize`, terminate. Never `session/new`, so a
// probe costs no quota.
export {
  PROBE_HANDSHAKE_TIMEOUT_MS,
  PROBE_TERMINATE_GRACE_MS,
  type ProbeOutcome,
  type ProbePorts,
  type ProbeRequest,
  probeProvider,
} from './probe.ts';
// KAR-05.3 — availability as a value the planner routes around (NF7), and an
// `authMethods` payload rendered for a human. Never executed (AR-1).
export type {
  AuthInstruction,
  AvailabilityInput,
  AvailabilityStatus,
  ProviderAvailability,
} from './provider-availability.ts';
export { renderAuthMethods, reportAvailability } from './provider-availability.ts';
// KAR-18.8 and KAR-19.2 — what this machine has installed, in one sentence per
// provider, and the admission decision `POST /api/runs` makes from it. One
// renderer: `doctor`'s Agents section and the daemon's refusal are the same
// string, byte for byte.
export type {
  AgentInstallState,
  ProviderResolution,
  ProviderVerdict,
  RefusedProvider,
  RunAdmission,
  RunRefusalCode,
} from './provider-install.ts';
export {
  admitRun,
  installCommand,
  installPrompt,
  isRunRefusalCode,
  MOCK_AGENT_FLAG,
  MOCK_AGENT_SENTENCE,
  providerVerdict,
  RUN_REFUSAL_CODES,
  renderRefusal,
  resolveProviderState,
  resolveProviderStates,
} from './provider-install.ts';
// KAR-05.3 — the verified provider table, encoded once. The only file in this
// package that names a vendor, and it names no capability.
export type {
  CompactionSpec,
  KnownProviderId,
  ProviderKind,
  ProviderSpec,
  ShimContext,
  ShimDialect,
  ShimFormat,
  ShimPlan,
  ShimSpec,
  SpawnContext,
  SpawnPlan,
} from './provider-registry.ts';
export {
  DEFAULT_MODEL_FAMILY,
  PROVIDER_SPECS,
  providerFamily,
  providerSpec,
  providerTokenAccounting,
  SHIM_FORMATS,
  shimPlan,
  spawnPlan,
  UNMEASURED_TOKEN_ACCOUNTING,
} from './provider-registry.ts';
// KAR-11.6 — where a rate-limited node goes next, decided from the probed rows
// and the recorded limits, or nowhere at all (F3.9, NF7).
export type {
  NodeRequirement,
  ProviderLimit,
  QuotaRoute,
  QuotaRouteInput,
  RerouteEquivalenceAnswer,
  RerouteEquivalenceInput,
} from './quota-route.ts';
export {
  capabilityQuestions,
  chooseQuotaRoute,
  providerIsHealthy,
  rerouteEquivalence,
} from './quota-route.ts';
export { sliceMember } from './raw-frame.ts';
// KAR-05.7 — the golden-recording tee, and the exact-version key that makes a
// vendor bump a new directory rather than a silent invalidation.
export type {
  RecordedDirection,
  RecorderOptions,
  RecordingHeader,
  RecordingIdentity,
  TransportRecorder,
} from './recorder.ts';
export {
  DEFAULT_RECORDING_ROOT,
  HOME_PLACEHOLDER,
  machineIdentity,
  openTransportRecorder,
  RECORD_CASE_ENV,
  RECORD_DIR_ENV,
  RECORD_ENV,
  recordingDirName,
  redactRecordingText,
  TMPDIR_PLACEHOLDER,
  USER_PLACEHOLDER,
} from './recorder.ts';
// KAR-05.5 — the prompt a replay resume sends, rebuilt from the ledger and
// from DeFlow's own blob store. No vendor session file, no vendor API.
export type {
  LedgerEventRow,
  PacketSources,
  ReconstructedPacket,
} from './replay-packet.ts';
export { reconstructPacket, renderPrompt, SEGMENT_SEPARATOR } from './replay-packet.ts';
// KAR-05.5 — two strategies behind one interface, selected from the probed
// row, plus the guard that refuses to resume across a changed binary.
export type {
  BinaryDriftField,
  BinaryIdentity,
  CrossVersionGateInput,
  ResumePolicy,
  ResumeStrategyName,
} from './resume.ts';
export {
  binaryDrift,
  crossVersionGatePrompt,
  crossVersionRefusal,
  RESUME_GATE_OPTIONS,
  RESUME_OVERRIDE_OPTION_ID,
  RESUME_REFUSE_OPTION_ID,
  selectResumeStrategy,
} from './resume.ts';
// KAR-05.5 — resuming one node: read the ledger, check the binary identity,
// select the strategy from the probed row, run the same turn either way.
export type {
  ResumeNodeOutcome,
  ResumeNodeRequest,
  ResumeOverride,
  ResumePorts,
} from './resume-node.ts';
export { DEFAULT_CONTINUATION, resumeAcpNode } from './resume-node.ts';
export type { AcpNodeOutcome, ProcessExit } from './run-node.ts';
export {
  AGENT_TURN_SCHEMA_ID,
  CANCEL_GRACE_MS,
  CONTENT_SPILL_BYTES,
  estimateUsage,
  KILL_GRACE_MS,
  OUTPUT_INLINE_LIMIT_BYTES,
  runAcpNode,
} from './run-node.ts';
// KAR-05.8 — the CLI exec shim: the documented, permanently-retained fallback
// for an agent with no ACP path. It gives up mediation, and refuses rather
// than hides that.
export type { ShimNodeOutcome, ShimNodeRequest, ShimPorts } from './run-shim-node.ts';
export { runShimNode, shimCapabilityRow, WAKE_REASON_QUOTA } from './run-shim-node.ts';
// KAR-08.5 — the node's sandbox policy, on the argv. D12: DeFlow owns policy,
// the vendor owns enforcement, and nothing here opens a user config directory.
export type { SandboxedShimPlan, SandboxInvocation } from './sandbox.ts';
export {
  checkSandboxDependencies,
  SANDBOX_RUNTIME_SETTINGS_FILE,
  sandboxedShimPlan,
} from './sandbox.ts';
// KAR-08.7 AC3, AC5 — the completion-time scope backstop: the one place a node
// runner asks "did this land outside what the plan declared", and the one place
// `node.scope_warning` is written.
export type {
  NodeScopeWarning,
  ScopeAudit,
  ScopeAuditPorts,
  ScopeAuditRequest,
  ScopeAuditSubject,
} from './scope-audit.ts';
export { auditCompletionScope, scopeAuditRefusal } from './scope-audit.ts';
// KAR-05.5 AC6 — `session/load` is not `session/resume`: bounded, deduped on
// DeFlow's own event ids, and never selected automatically.
export type {
  LoadDedupeResult,
  NotificationScope,
  ReplayedNotification,
  SessionLoadOutcome,
  SessionLoadPorts,
  SessionLoadRequest,
} from './session-load.ts';
export {
  dedupeReplayedNotifications,
  deflowNotificationId,
  diagnoseSessionLoad,
  loadWouldFlood,
  MAX_LOAD_REPLAY_NOTIFICATIONS,
} from './session-load.ts';
// KAR-05.8 — the per-line parser: uuid as the dedup key, the vendor-reported
// usage envelope, and the rate limit's epoch-seconds `resetsAt`.
export type {
  ShimCompactBoundary,
  ShimLine,
  ShimRateLimit,
  VendorUsageReport,
} from './shim-frames.ts';
export {
  COMPACT_BOUNDARY_SUBTYPE,
  parseShimLine,
  RESULT_SUBTYPE_REASONS,
  shimCompactBoundary,
  shimRateLimit,
  shimResultCostUsd,
  shimResultFailure,
  shimResultReport,
  shimResultUsage,
  shimStructuredOutput,
  shimText,
} from './shim-frames.ts';
// KAR-09.9 — which mechanism carried the return schema to this vendor, and the
// manifest field that says so when the answer is the softer one.
export type {
  StructuredOutputContract,
  StructuredOutputManifest,
  StructuredOutputMechanism,
  StructuredOutputRequest,
} from './structured-output.ts';
export {
  providerStructuredOutput,
  SCHEMA_PLACEHOLDER,
  STRUCTURED_OUTPUT_MECHANISMS,
  structuredOutputContract,
} from './structured-output.ts';
export type { AgentTransport, ReadGate, TransportOptions } from './transport.ts';
export { agentTransport } from './transport.ts';
// KAR-09.7 — Tier 1 on the jsonl dialect, normalised into the same report.
export { TURN_COMPLETED_TYPE, turnCompletedReport } from './turn-frames.ts';
export type { UpdateDescription } from './updates.ts';
export { describeUpdate, toolCallContentText } from './updates.ts';
