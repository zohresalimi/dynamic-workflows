/**
 * @DeFlow/daemon — DeFlowd itself: the hono HTTP+SSE server, the orchestrator
 * tick loop, the Effect Runner, Planner, Context Builder, Blackboard, Gate
 * Runner, Workspace Manager and MCP host.
 *
 * R2: nothing depends on this package except packages/cli. It is a leaf, and
 * anything another package needs from it belongs in @DeFlow/core if it is pure,
 * or is a port that the daemon implements and injects if it is not.
 *
 * EPIC-06 and EPIC-15 fill in the orchestrator. What exists today is the
 * process shape from KAR-01.3: one HTTP server, one origin, and `src/main.ts`
 * as the `node --watch` entry point.
 */

// KAR-03.7 — the boot sequence, and the order its steps run in.
export {
  BOOT_STEPS,
  type Booted,
  type BootOptions,
  type BootStep,
  boot,
  EX_ALREADY_RUNNING,
} from './boot.ts';
// KAR-14.2 AC8 — the ceiling section of `DeFlow doctor` (the command is
// EPIC-18, KAR-18.4).
export type { BudgetCeilingReportInput } from './budget/doctor.ts';
export { budgetCeilingLines, renderBudgetCeilingReport } from './budget/doctor.ts';
// KAR-14.3 AC5, AC6 — the pre-flight gate a proposed patch passes through:
// estimate, then the F2.5 rule table, then the rejection on the record.
export type { PatchGateInput, PatchRuling } from './budget/patch-gate.ts';
export { rulePatch } from './budget/patch-gate.ts';
// KAR-06.7 — the kill switch's mechanics: the four rungs of the escalation
// ladder, each of them an event, and the pid-reuse refusal in front of them.
export type { CancelOutcome, CancelPorts, CancelReport } from './cancel.ts';
export { cancelNode, KILL_VERIFY_MS, TERM_GRACE_MS } from './cancel.ts';
export { systemClock } from './clock.ts';
// KAR-09.7 — token accounting in three tiers. `preflightBudget` reserves,
// `foldCalibrationSample` corrects, `o200kTokenizer` is the only implementation
// of core's `Tokenizer` port, and `exact-count.ts` is the tier-3 call site that
// nothing on the subscription path can reach.
// KAR-09.4 — `.DeFlow/config.yaml` off disk, and the constraint section of
// `DeFlow doctor` (the command itself is EPIC-18, KAR-18.4).
export { CONFIG_RELATIVE_PATH, loadWorkspaceConfig } from './config/workspace-config.ts';
export { renderConstraintReport, workspaceConstraintReport } from './constraints/doctor.ts';
// KAR-15.2 AC7 / KAR-18.2 AC1 — `.DeFlow/daemon.json` and the handoff URL that
// carries the token in its **fragment**, which is what keeps it out of every
// access log there will ever be.
export type { DaemonFile } from './daemon-file.ts';
export {
  DAEMON_FILE_MODE,
  DAEMON_FILE_NAME,
  daemonFilePath,
  handoffUrl,
  ownProcessStartTime,
  removeDaemonFile,
  writeDaemonFile,
} from './daemon-file.ts';
export { DATA_DIR_ENV, type DataDirEnv, resolveDataDir } from './data-dir.ts';
// KAR-19.1 — the run driver the ticker calls, and the framing port `DeFlow up`
// binds to a live ACP session (KAR-19.3).
export type {
  AdvanceInput,
  DriverPorts,
  ExecuteInput,
  FramingRunner,
  FramingWake,
  RunAdvancer,
  RunDriver,
  RunNodeExecutor,
  TickReport,
} from './drive.ts';
export { createRunDriver, FRAMING_RETRY_MS } from './drive.ts';
// KAR-06.3 — the Effect Runner: intent, act, record. The four branches of
// `durable()` are four genuinely different real situations.
export type {
  Effect,
  EffectCtx,
  EffectMode,
  EffectRunner,
  EffectRunnerOptions,
  ReconcileHashes,
  ReconcileProbe,
} from './effects/durable.ts';
export {
  createEffectRunner,
  EffectFailed,
  EffectNeedsReconciliation,
  EffectRequestHashMismatch,
} from './effects/durable.ts';
// KAR-06.4 — the file effect: an atomic write whose recovery story is a
// filename.
export type { FileWriteInput, FileWriteResult } from './effects/file-effect.ts';
export { fileWriteEffect } from './effects/file-effect.ts';
// KAR-06.4 — the git effects: a commit made findable by its trailer, and a
// worktree add whose "already exists" is a success.
export type {
  GitCommitInput,
  GitEffectPorts,
  GitIntegrationBranchInput,
  GitMergeInput,
  GitWorktreeAddInput,
  IntegrationBranchResult,
  MergeAttempt,
  WorktreeAddResult,
} from './effects/git-effect.ts';
export {
  gitCommitEffect,
  gitIntegrationBranchEffect,
  gitMergeEffect,
  gitWorktreeAddEffect,
} from './effects/git-effect.ts';
// KAR-06.4 — reconciliation per effect type: one probe per kind, and the
// escalation for the answer none of them can give.
export type {
  AgentReconcileInput,
  AgentReconcileOutcome,
  SessionIdQuery,
} from './effects/reconcile/agent.ts';
export {
  RESUME_PHASE,
  readSessionId,
  reconcileAgent,
  resumeProgress,
  SESSION_OPENED_PHASE,
} from './effects/reconcile/agent.ts';
export type {
  Escalation,
  EscalationInput,
  ReconcileEvidence,
} from './effects/reconcile/escalate.ts';
export {
  escalateReconcileUnknown,
  reconcileUnknownDetail,
  reconcileUnknownFailure,
  shortDigest,
} from './effects/reconcile/escalate.ts';
export type { FileReconcileInput, FileReconcileVerdict } from './effects/reconcile/file.ts';
export { TMP_SUFFIX, tmpPathFor } from './effects/reconcile/file.ts';
export type { CommandResult, WorktreeAddOutcome } from './effects/reconcile/git.ts';
export {
  classifyWorktreeAdd,
  commitArgs,
  commitShaFrom,
  EFFECT_TRAILER,
  findCommitArgs,
  isWorktreeAddSuccess,
  mergeArgs,
  trailerLine,
} from './effects/reconcile/git.ts';
export type {
  MutatingShellScaffold,
  ShellClassification,
  ShellReconcileInput,
  ShellReconcileVerdict,
} from './effects/reconcile/shell.ts';
export { porcelainHash, reconcileShell } from './effects/reconcile/shell.ts';
// KAR-06.4 — the shell effect: `pure` re-runs, `mutating` journals the
// worktree it found and the worktree it left.
export type { ShellEffectInput, ShellEffectPorts, ShellResult } from './effects/shell-effect.ts';
export { shellEffect } from './effects/shell-effect.ts';
// The `LedgerSink` @DeFlow/adapters writes through, over a real SQLite
// connection. Exported because `DeFlow doctor` (KAR-18.4) probes providers
// from the CLI process, and an adapter that was handed a sink inventing
// sequence numbers would be told its events were committed when they were not.
export type { LedgerSinkOptions } from './exec/ledger-sink.ts';
export { sqliteLedgerSink } from './exec/ledger-sink.ts';
// The orchestrator loop: reduce → decide → perform → append, with what a node
// *does* injected as a `NodePerformer`.
export type {
  ExecContext,
  NodePerformer,
  RunExecutionResult,
  RunExecutorOptions,
} from './exec/run-executor.ts';
export { executeRun } from './exec/run-executor.ts';
// KAR-12.1 — running a `gate` node: the join between the executor and
// @DeFlow/gates' deterministic runner.
export type { GateNodeResolution, GatePerformerOptions } from './gates/gate-performer.ts';
export { byNodeType, gateNodePerformer } from './gates/gate-performer.ts';
export type {
  GateRepairContext,
  GateRepairOutcome,
  GateRepairRequest,
  GateRepairRuling,
} from './gates/repair-loop.ts';
export { applyGateRepair, REPAIR_NOT_APPLICABLE } from './gates/repair-loop.ts';
export type { GateNodeOutcome, GateNodePorts, GateNodeRequest } from './gates/run-gate-node.ts';
export { GATE_NODE_SCHEMA_ID, runGateNode } from './gates/run-gate-node.ts';
// KAR-07.1 — the two forbidden-argument assertions the Git wrapper runs
// before every spawn (§3.3, §10.6).
export {
  assertNoForcedWorktreeAdd,
  assertNotDefaultBranchWrite,
  isDefaultBranchWriteShaped,
} from './git/assertions.ts';
// KAR-07.3 — the flat D13 branch scheme and the domain-layer half of
// ref-name validation: BRANCH_SAFE, applied to runId/nodeId separately,
// before either value can reach git (§2, §2.1).
export {
  type BranchIdComponent,
  integrationBranch,
  nodeBranch,
  salvageBranch,
  UnsafeRefError,
} from './git/branch-name.ts';
// KAR-07.1 — default branch resolution (§10.6): origin/HEAD, falling back to
// the HEAD symref. `Git.resolveDefaultBranch()` is the cached, per-instance
// entry point most callers want; this is the uncached primitive it wraps.
export {
  DefaultBranchUnresolvedError,
  resolveDefaultBranchUncached,
} from './git/default-branch.ts';
// KAR-07.3 AC6 — the static check behind "every call site that passes a
// generated name to git uses a '--' separator or '--branch=<value>'".
export type { UnguardedCall } from './git/generated-ref-usage.ts';
export { findUnguardedGeneratedRefCalls } from './git/generated-ref-usage.ts';
// KAR-07.1 — the Git wrapper itself: one chokepoint, built on the spawn half
// KAR-06.4 left in ./git/run-git.ts for exactly this.
export { Git, type GitOptions, type GitRunOptions } from './git/git.ts';
// KAR-07.6 — a git invocation whose non-zero exit is not a result the caller
// can read as a value. The wrapper itself still never throws.
export { GitError } from './git/git-error.ts';
// KAR-07.6 — `merge-tree --write-tree` as a side-effect-free conflict probe
// (Decision D14).
export type {
  ConflictStage,
  GitPort,
  MergeTreeResult,
  MergeTreeStages,
} from './git/merge-tree.ts';
export {
  MERGE_TREE_ARGS,
  MERGE_TREE_STAGES_ARGS,
  mergeTree,
  mergeTreeArgs,
  mergeTreeStagesArgs,
  parseMergeTreeOutput,
  parseMergeTreeStages,
} from './git/merge-tree.ts';
// KAR-07.3 AC3 — the git-verified half of ref-name validation:
// `check-ref-format --branch`, cached per composed name.
export { RefFormatChecker, type RefFormatRunner } from './git/ref-format.ts';
// KAR-06.4 — the spawn half of the git wrapper KAR-07.1 completes.
export type { GitResult, RunGitOptions } from './git/run-git.ts';
export { GIT_TIMEOUT_MS, gitChildEnv, runGit } from './git/run-git.ts';
// KAR-07.4 — the one way DeFlow reads a worktree's dirtiness (§4.4).
export type { StatusEntry, StatusEntryKind } from './git/status-porcelain.ts';
export { isDirty, parseStatusPorcelainV2, STATUS_ARGS } from './git/status-porcelain.ts';
// KAR-07.1 — the git version floor (§1.2): DeFlow doctor's git check
// (EPIC-18, KAR-18.4) and, ahead of that command existing, the run-start
// gate a below-floor git throws through.
export {
  assertGitVersionSupported,
  checkGitVersion,
  classifyGitVersion,
  type GitVersion,
  type GitVersionCheck,
  type GitVersionStatus,
  GitVersionTooOldError,
  MIN_GIT_VERSION,
  PREFERRED_GIT_VERSION,
  parseGitVersion,
} from './git/version.ts';
// KAR-07.2 — the worktree lifecycle's argv, stated once (§4.1, §4.3, §4.4).
// There is deliberately no `worktreeLockArgs`: --lock is inside the add.
export type {
  ReadWorktreeSpec,
  WorktreeMode,
  WorktreeSpec,
  WriteWorktreeSpec,
} from './git/worktree-args.ts';
export {
  lockReasonFor,
  parseLockReason,
  WORKTREE_LIST_ARGS,
  WORKTREE_PRUNE_ARGS,
  worktreeAddArgs,
  worktreePathFor,
  worktreeRemoveArgs,
  worktreeUnlockArgs,
} from './git/worktree-args.ts';
// KAR-07.2 AC7 — the double force, reachable only from KAR-07.8's reaper.
export { reaperForceRemoveArgs } from './git/worktree-force-remove.ts';
// KAR-07.2 AC5 — the static check behind "worktree list is only ever
// list --porcelain -z".
export type { UnporcelainedListCall } from './git/worktree-list-usage.ts';
export { findUnporcelainedWorktreeList } from './git/worktree-list-usage.ts';
// KAR-07.2 — the Workspace Manager: create locked in one invocation, refuse an
// occupied branch before git is asked, unlock then remove, reconcile against
// git rather than trusting SQLite.
export type {
  ProvisionRead,
  ProvisionRequest,
  ProvisionResult,
  ProvisionWrite,
  ReconcileReport,
  RemoveRequest,
  RemoveResult,
  SalvageResult,
  SalvageStep,
  WorkspaceGit,
  WorkspacePorts,
} from './git/worktree-manager.ts';
export {
  BranchOccupiedError,
  WipSalvageFailed,
  WorkspaceManager,
  WorktreeCreateFailed,
  WorktreeRemovalRefused,
} from './git/worktree-manager.ts';
// KAR-07.2 — the only way DeFlow reads git's worktree list, and the occupancy
// pre-check over it (§3.1, §4.3).
export type { WorktreeEntry, WorktreeOccupant } from './git/worktree-porcelain.ts';
export { findOccupant, parseWorktreeList, shortBranch } from './git/worktree-porcelain.ts';
// KAR-07.2 — one porcelain entry as one `worktrees` row, shared by the manager
// and by KAR-07.8's boot sweep so the two cannot disagree about ownership.
export { worktreeRowFor } from './git/worktree-projection.ts';
// KAR-07.4 — the salvage sequence's argv, and the single `--force` it is the
// only route to on the node-completion path (§4.4).
export {
  SALVAGE_COMMIT_SUBJECT,
  salvageAddArgs,
  salvageBranchArgs,
  salvageCommitArgs,
  salvagedRemoveArgs,
} from './git/worktree-salvage.ts';
// KAR-15.1 — the whole client contract (docs/11-api-and-realtime.md §9).
// `packages/web/src/api/client.ts` builds `hc<ApiType>` from this one type, and
// both the UI and the CLI import that module rather than writing a client each.
export type { ApiType } from './http/api.ts';
export { API_HEADER, api, apiErrorHandler, isPublicRoute, PUBLIC_ROUTES } from './http/api.ts';
// KAR-13.2 — `GET /api/approvals`, assembled from the ledger.
export type { ApprovalRow, ApprovalsResponse } from './http/approvals.ts';
export { approvalQueue } from './http/approvals.ts';
// KAR-15.1 — the closed error envelope and its status→code table.
export type {
  ApiErrorCode,
  ApiErrorEnvelope,
  ApiErrorOptions,
  ApiErrorStatus,
  ServiceRefusalCode,
} from './http/errors.ts';
export { API_ERROR_STATUS, apiError, isApiErrorCode, serviceError } from './http/errors.ts';
// KAR-14.1 AC8 — the read-only ledger the run summary and the SSE tail are
// served through, and the summary body itself.
export type { LedgerView, OpenedLedgerView } from './http/ledger-view.ts';
export {
  asRunId,
  clearLedgerView,
  ledgerView,
  openLedgerView,
  setLedgerView,
} from './http/ledger-view.ts';
// KAR-18.2 AC4 — step 5: 7777, or the next free one, and a pinned port that is
// refused rather than silently replaced.
export type { PickPortOptions } from './http/pick-port.ts';
export { PortInUse, pickPort } from './http/pick-port.ts';
// KAR-15.8 — the interactive terminal channel: the frame table's two text
// frames, the route parser, and the upgrade handler that carries them.
export type { ClientCommand, PtyTarget, ResizeCommand } from './http/pty-protocol.ts';
export {
  exitFrameText,
  MAX_DIMENSION,
  PTY_PATH_PREFIX,
  parseClientText,
  parsePtyPath,
} from './http/pty-protocol.ts';
export { installPtyUpgrade, ptyUpgradeHandler } from './http/pty-socket.ts';
// KAR-19.1 AC4 — the list `GET /api/runs` answers with, including the runs
// nothing has framed yet.
export type { RunListEntry, RunListPage, RunListQuery } from './http/run-list.ts';
export { RUN_LIST_DEFAULT_LIMIT, RUN_LIST_MAX_LIMIT, runList } from './http/run-list.ts';
export type { RunSummary } from './http/run-summary.ts';
export { runSummary } from './http/run-summary.ts';
export type { StartedHttp, StartHttpOptions } from './http/server.ts';
export {
  clearUpgradeHandler,
  DEFAULT_HOSTNAME,
  DEFAULT_PORT,
  setUpgradeHandler,
  startHttp,
  type UpgradeHandler,
} from './http/server.ts';
// KAR-15.8 — RFC 6455 framing, owned rather than imported: the socket must
// stay independent of any helper's opinion about when to accept one (AC1).
export type {
  DecoderOptions,
  EncodeOptions,
  FrameDecoder,
  Opcode,
  WsMessage,
} from './http/ws-frame.ts';
export {
  acceptKey,
  CLOSE_GOING_AWAY,
  CLOSE_NORMAL,
  CLOSE_PROTOCOL_ERROR,
  CLOSE_TOO_BIG,
  closePayload,
  createFrameDecoder,
  DEFAULT_MAX_PAYLOAD_BYTES,
  encodeFrame,
  newWebSocketKey,
  OPCODE,
  WsProtocolError,
} from './http/ws-frame.ts';
// KAR-13.4 — a permission escalation: the queue row, the durable wait, the
// run-scoped `_always`, and the `permission.decided` every mediated request
// leaves behind whether or not anybody saw it.
export type { EscalationPorts, PermissionEscalations } from './human/escalation.ts';
export { createPermissionEscalations, escalatesPermission } from './human/escalation.ts';
// KAR-13.1 — the two writes that close a blocking `human` node: the operator's
// answer, and the deadline nobody met. Both move their `node_wake` row in the
// same transaction as the event that explains it.
export type {
  ExpiredHumanGate,
  ExpireOptions,
  RespondOptions,
  RespondRefusalCode,
  RespondResult,
} from './human/gate.ts';
export { expireDueHumanGates, respondToHumanNode } from './human/gate.ts';
// KAR-13.3 — steering a running node: the accept-time write, the receipt that
// says the guidance arrived, and the capability row both are decided from.
export type {
  InterjectOptions,
  InterjectRefusalCode,
  InterjectResult,
} from './human/interject.ts';
export {
  interjectIntoNode,
  nodeMovedAfter,
  recordInterjectionsDelivered,
  steeringFor,
} from './human/interject.ts';
export type { ConfigValidation } from './init/config-schema.ts';
// KAR-18.1 — `DeFlow init`'s workspace bootstrap: the committed half of
// `.DeFlow/`, the `.gitignore` merge for the per-machine half, the global
// state directory, and the provider detection pass that writes only there.
export {
  CONFIG_SCHEMA_FILE,
  CONFIG_SCHEMA_ID,
  configJsonSchema,
  validateAgainstConfigSchema,
} from './init/config-schema.ts';
export type { GitignoreMerge } from './init/gitignore-merge.ts';
export { GITIGNORE_ENTRIES, mergeGitignore } from './init/gitignore-merge.ts';
export type { InitPorts, InitReport, PathReport, PathStatus } from './init/workspace-init.ts';
export {
  DataDirUnwritable,
  INIT_EX_REFUSED,
  initWorkspace,
  NotAGitWorkingTree,
} from './init/workspace-init.ts';
export type { CreateLoggerOptions } from './logging.ts';
export { CENSOR, createLogger, log, REDACT_PATHS } from './logging.ts';
export type { WorkflowPhase, WorkflowTool } from './mcp/catalog.ts';
export {
  ARTIFACT_INLINE_LIMIT_BYTES,
  isWorkflowPhase,
  M1_TOOLS,
  PROPOSE_PLAN_PATCH,
  READ_ARTIFACT,
  READ_FACT,
  toolByName,
  toolNamesForPhase,
  toolsForPhase,
  WORKFLOW_PHASES,
} from './mcp/catalog.ts';
// KAR-05.6 — the MCP host: the untagged stdio entry `session/new` carries,
// the UDS DeFlowd serves workflow tools on, and the `DeFlow-mcp` shim that
// bridges the two. The MCP SDK is reached through two deep subpaths only
// (`checkMcpSdkImports`); nothing here loads express or hono.
export type {
  FactStore,
  McpGrant,
  McpGrantRequest,
  McpHost,
  McpHostOptions,
} from './mcp/host.ts';
export { MCP_SOCKET_DIR, MCP_SOCKET_FILE, startMcpHost } from './mcp/host.ts';
export type { HostFrame, ShimFrame } from './mcp/protocol.ts';
export { BRIDGE_VERSION, BridgeProtocolError } from './mcp/protocol.ts';
// KAR-09.5 — handle resolution behind `DeFlow_read_artifact`: the run's
// artifact index, the line range, and the permission check that keeps a
// DeFlow-hosted tool from being a way around the ACP fs/* boundary.
export type {
  ArtifactResolveRequest,
  ArtifactStore,
  HandleResolution,
  RunArtifactStorePorts,
} from './mcp/resolve-handle.ts';
export { digestOf, runArtifactStore } from './mcp/resolve-handle.ts';
export type { McpServerEntryOptions } from './mcp/server-entry.ts';
export {
  DEFLOW_MCP_ENTRY,
  MCP_SERVER_NAME,
  mcpServerEntry,
  RUN_TOKEN_ENV,
} from './mcp/server-entry.ts';
export type { ShimOptions } from './mcp/shim.ts';
export { EX_REFUSED, EX_UNAVAILABLE, EX_USAGE, runMcpShim, SHIM_NAME } from './mcp/shim.ts';
export { API_VERSION, BOOT_ID, BUILD, uptimeMs } from './meta.ts';
export type { LiveTurnOptions } from './pipeline/live-agents.ts';
export {
  liveFramingAgent,
  livePlannerAgent,
  liveReconAgent,
  MAX_TURN_BYTES,
  structuredTurn,
} from './pipeline/live-agents.ts';
// KAR-19.3 — and the resolver itself: the binding that turns a daemon with a
// chain into a daemon that runs one. `DeFlow up` is its production caller.
export type { LiveChainOptions } from './pipeline/live-chain.ts';
export {
  ASSUMED_CONTEXT_FLOOR,
  createLiveRunChain,
  PROVIDER_DEFAULT_MODEL,
} from './pipeline/live-chain.ts';
// KAR-19.4 AC1 — the performer behind it: agent nodes on a real process in
// their own worktree, gate nodes through `gateNodePerformer`. The second half
// of the composition-root binding whose absence was the 2026-08-12 failure.
export type { LiveExecutionOptions } from './pipeline/live-nodes.ts';
export { createLiveRunExecution } from './pipeline/live-nodes.ts';
// KAR-19.3 — the live chain: the one shipped caller of `runFramingInterview`,
// `runReconNode` and `compilePlanV1`, and the resolver `DeFlow up` binds it to.
export type {
  RunChain,
  RunChainContext,
  RunChainPorts,
  RunChainResolver,
} from './pipeline/run-chain.ts';
export {
  createRunChain,
  PLANNER_NODE,
  RECON_NODE,
  reconWorktreePath,
} from './pipeline/run-chain.ts';
// KAR-19.4 — the live executor: the one shipped caller of `executeRun`, and the
// resolver `DeFlow up` binds it to a performer over a real worktree.
export type {
  RunExecution,
  RunExecutionContext,
  RunExecutionPorts,
  RunExecutionResolver,
} from './pipeline/run-execution.ts';
export { createRunExecution } from './pipeline/run-execution.ts';
// KAR-11.2 — plan validation's one entry point on this side of the boundary:
// git's verdict on every node id, and the gate a patched plan commits through.
export type {
  CommitPatchedPlanOutcome,
  CommitPatchedPlanRequest,
  NodeRefChecker,
  PlanValidationRequest,
} from './plan/validate.ts';
export {
  commitPatchedPlan,
  nodeRefOf,
  PATCH_REJECTED_AS_STALE,
  PATCH_REJECTED_BY_VALIDATION,
  validatePlanVersion,
} from './plan/validate.ts';
export type { SchemaRegistryCheck } from './preflight.ts';
export { checkSchemaRegistry, EX_CONFIG } from './preflight.ts';
// KAR-08.8 — auth-shadowing detection: what buildChildEnv()'s allowlist does
// quietly, said loudly (docs/15-security-model.md §2.3).
export type {
  AuthShadowDoctorRow,
  AuthShadowVar,
  ProviderAuthModePayload,
  ProviderAuthShadowStrippedPayload,
  ResolvedProviderAuth,
  ResolveProviderAuthInput,
} from './proc/auth-shadow.ts';
export {
  AUTH_SHADOW_VARS,
  checkAuthShadowing,
  resolveProviderAuth,
  shadowVarsFor,
} from './proc/auth-shadow.ts';
// KAR-08.4 — the child environment, built from an allowlist. The control
// that would actually have prevented the Kiro incident (docs/15-security-
// model.md §4).
export type { BuildChildEnvOptions, BuiltChildEnv } from './proc/env.ts';
export {
  AGENT_BASE_KEYS,
  AGENT_ENV_KEYS,
  buildChildEnv,
  createRunTmpdir,
  envDeclaredPayload,
  isNeverImplicit,
  resetLoginShellPathCache,
  resolveLoginShellPath,
  resolveLoginShellPathOnce,
  VENDOR_CONFIG_DIR_VARS,
} from './proc/env.ts';
// KAR-18.2 — step 4 of `DeFlow up`'s boot: the same detection with the probe
// cache turned on, so an unchanged binary costs no handshake (EPIC-18-S17).
export type { BootProbePorts } from './providers/boot-probe.ts';
export { availableCount, probeProvidersOnBoot } from './providers/boot-probe.ts';
export type {
  DetectProvidersPorts,
  ProviderDetectionEntry,
  ProviderDetectionStatus,
} from './providers/detect.ts';
export { detectProviders, pathRoots } from './providers/detect.ts';
// KAR-15.6 AC8 / KAR-18.4 — re-probe every recorded adapter and run the F3.4
// battery against it. `GET /api/providers/doctor` and `DeFlow doctor`'s
// Conformance section are the two callers, and they share one implementation
// so a CI exit code and an operator's terminal describe the same run.
export type {
  ProbeStatus,
  ProviderDoctorEntry,
  ProviderDoctorPorts,
  ProviderDoctorReport,
} from './providers/doctor.ts';
export {
  DOCTOR_DIR,
  runProviderDoctor,
  UNSTAGEABLE_CASES,
  UNSTAGEABLE_REASON,
} from './providers/doctor.ts';
// KAR-14.4 AC10 — the rate-limit section of `DeFlow doctor` (the command is
// EPIC-18, KAR-18.4): per provider, the most recent `provider.rate_limited`
// and its `resetsAt`, with an unknown reset said out loud rather than invented.
export type { RateLimitReportInput } from './providers/rate-limit-doctor.ts';
export { rateLimitLines, renderRateLimitReport } from './providers/rate-limit-doctor.ts';
// KAR-15.8 — one live pty per node, its durable `io_chunk` sink, and the
// registry the upgrade handler looks a node's terminal up in.
export type { LedgerPtySinkOptions } from './pty/ledger-pty-sink.ts';
export { ledgerPtySink } from './pty/ledger-pty-sink.ts';
export type {
  PtyAttachment,
  PtyExit,
  PtyOutputSink,
  PtySession,
  PtySessionOptions,
} from './pty/pty-session.ts';
export { DEFAULT_COLS, DEFAULT_ROWS, loadNodePty, openPtySession } from './pty/pty-session.ts';
export { clearPtySessions, ptySessionFor, registerPtySession } from './pty/pty-sessions.ts';
export type { DaemonSeed, SeedEnv } from './random.ts';
export { daemonRandom, daemonSeed, RANDOM_SEED_ENV } from './random.ts';
// KAR-05.9 / KAR-18.2 AC6 — what the boot reaper decided about each row a dead
// daemon left behind, and (KAR-18.2 AC7) the shutdown half: this daemon's own
// children, stopped and verified on the way out.
export type { ReapDecision, ReapOutcome, ReapPorts } from './reaper.ts';
export { reapOrphans } from './reaper.ts';
// KAR-06.9 — crash recovery: the fixed startup sequence, and the three things
// only a restart can settle — an effect whose fate the ledger cannot tell, an
// attempt whose daemon is gone, and a child that outlived its parent.
export type {
  ConcludedAttempt,
  ReclaimedLock,
  ReconciledEffect,
  ReconcileInheritedEffect,
  ReconcileVerdict,
  Recovery,
  RecoveryPorts,
  RecoveryStep,
} from './recovery.ts';
export { RECOVERED_STEPS, RECOVERY_STEPS, recover } from './recovery.ts';
// KAR-16.5 — `DeFlow replay <fixture> --speed <n>x --port <p>`: the daemon
// mode that serves a recorded run through the normal routes, so nine views can
// be developed offline and no frontend anywhere has to know it is a replay.
export {
  BadReplayArgv,
  CORPUS_DIR,
  corpus,
  DEFAULT_REPLAY_PORT,
  parseReplayArgv,
  type ReplayCommand,
  resolveFixture,
} from './replay/cli.ts';
export {
  loadFixture,
  type RecordedLedger,
  readFixture,
  UnreadableFixture,
} from './replay/fixture.ts';
export { type ReplayHarness, type ReplayOptions, startReplay } from './replay/harness.ts';
export { EMIT_BATCH, type Player, type PlayerOptions, startPlayer } from './replay/player.ts';
export { BadSpeed, emissionOffsets, parseSpeed, SPEEDS, type Speed } from './replay/speed.ts';
export type { RecordedFailure, RecordFailureInput } from './retry.ts';
export { recordNodeFailure } from './retry.ts';
export { daemonEpoch, headSeq, setDaemonEpoch, setHeadSeq } from './runtime.ts';
export type { SchemaDirectory, ValidateValue } from './schema-store.ts';
export {
  defaultSchemasDir,
  loadSchemaDirectory,
  makeValidator,
  SchemaCompilationFailed,
  UnknownSchemaFile,
} from './schema-store.ts';
// KAR-08.3 — the command half: default-deny on the binary, the syntactic
// second layer, and the human gate the rest is shaped to keep rare.
export type {
  CommandApproval,
  CommandDecision,
  CommandDenial,
  CommandGate,
  CommandGatePayload,
  CommandMediation,
  CommandMediator,
  CommandMediatorPorts,
  CommandRequest,
  HumanCommandGatePorts,
  ResolvedCommand,
  WorktreeCommandPolicyOptions,
} from './services/command-mediation.ts';
export {
  COMMAND_GATE_OPTIONS,
  commandGatePayload,
  createCommandMediator,
  humanCommandGate,
  worktreeCommandPolicy,
} from './services/command-mediation.ts';
export { acpFsHandlers } from './services/fronts/acp-fs.ts';
export { acpPermissionHandlers } from './services/fronts/acp-permission.ts';
export { acpTerminalHandlers } from './services/fronts/acp-terminal.ts';
// KAR-05.1 — the transport-neutral fs/terminal/permission services, and the
// thin ACP fronts wired into the client. ACP v2 deletes the fronts; the
// services outlive them.
export type {
  FsIo,
  FsService,
  FsServiceOptions,
  PathPolicy,
  ReadTextRequest,
  WriteTextRequest,
} from './services/fs-service.ts';
export { createFsService } from './services/fs-service.ts';
// KAR-08.2 — the fs half of the ladder: the agent's path resolved against the
// node's worktree, `realpath`ed, and decided before anything is opened.
export type {
  MediationDenial,
  PathContainment,
  PathDenial,
  PathEscapeRoute,
  PathFs,
  PathMediation,
  PathMediator,
  PathMediatorPorts,
  PathMethod,
  WorktreePathPolicyOptions,
} from './services/path-mediation.ts';
export {
  createPathMediator,
  nodePathFs,
  PATH_ESCAPE_ROUTES,
  PermissionDeniedError,
  permissionDeniedPayload,
  worktreePathPolicy,
} from './services/path-mediation.ts';
// KAR-08.1 — the decider that answers `session/request_permission` from
// @DeFlow/core's ladder, auto-answering routine requests and escalating only
// the gated categories.
export type {
  GatedPermissionRequest,
  LadderDecision,
  LadderPorts,
} from './services/permission-ladder.ts';
export { ladderDecider, ladderDeniedPayload } from './services/permission-ladder.ts';
export type {
  PermissionDecider,
  PermissionDecision,
  PermissionOption,
  PermissionQuery,
  PermissionService,
  ToolKind,
} from './services/permission-service.ts';
export { createPermissionService } from './services/permission-service.ts';
// KAR-08.7 AC3, AC5 — the completion-time backstop: diff the worktree with a
// real `git status`, and warn (never gate) on anything that landed outside
// the node's declared write scope.
export type { ScopeWarningPayload } from './services/scope-diff.ts';
export {
  changedPaths,
  createScopeAudit,
  outOfScopePaths,
  scopeWarningOf,
} from './services/scope-diff.ts';
export type {
  CommandPolicy,
  CreateTerminalRequest,
  TerminalCapture,
  TerminalExit,
  TerminalOutput,
  TerminalService,
  TerminalServiceOptions,
} from './services/terminal-service.ts';
export { createTerminalService, DEFAULT_CAPTURE_BYTES } from './services/terminal-service.ts';
export type { StopChildrenPorts, StoppedChild } from './shutdown.ts';
export { stopChildren } from './shutdown.ts';
export { amendSpec } from './spec/amend.ts';
// KAR-06.5 — the imperative half of the retry ladder: the classified failure,
// the wake row and the events, in one transaction.
// KAR-10.3 — the F1.3 approval gate: the blocking human node, its one
// `node_wake` row, and the four operator actions.
export type {
  AbandonOptions,
  Approval,
  ApproveOptions,
  EditOptions,
  GateOptions,
  OpenGateOptions,
  Rejection,
  RejectOptions,
  SpecDecidedBy,
  SpecEdit,
} from './spec/gate.ts';
export {
  abandonRun,
  approveSpec,
  editSpec,
  FRAMING_NODE,
  openSpecApprovalGate,
  rejectSpec,
  SPEC_REJECTION_LIMIT,
  SpecApprovalRefused,
  SpecGateNotOpen,
} from './spec/gate.ts';
export type { CalibrationSample, CalibrationTarget, PreflightBudget } from './tokens/calibrate.ts';
export { foldCalibrationSample, preflightBudget } from './tokens/calibrate.ts';
export {
  renderTokenCalibrationReport,
  tokenCalibrationLines,
  tokenCalibrationReport,
} from './tokens/doctor.ts';
export type {
  DirectApiCredential,
  ExactCountRequest,
  ExactCountTransport,
} from './tokens/exact-count.ts';
export {
  COUNT_TOKENS_PATH,
  countTokensExact,
  ExactCountUnavailable,
} from './tokens/exact-count.ts';
export { o200kTokenizer } from './tokens/tokenizer.ts';
// KAR-07.7 — the integration branch and the ordered merge loop: probe, sort,
// merge the cheapest, re-probe, re-sort, gate (§7).
export type { AutoResolveUse } from './workspace/auto-resolve-usage.ts';
export {
  findAutoResolveStrategies,
  stripComments,
} from './workspace/auto-resolve-usage.ts';
export type { ConflictedFile } from './workspace/conflict-hunks.ts';
export {
  conflictedFiles,
  conflictedPaths,
  extractConflictHunks,
  MalformedConflictError,
} from './workspace/conflict-hunks.ts';
// KAR-07.6 — the live conflict matrix: which pairs to probe, which stored row
// may still be believed, and which node a detected conflict demotes.
export type {
  Demotion,
  InFlightBranch,
  ProbedTips,
  ProbeVerdict,
} from './workspace/conflict-matrix.ts';
export { demotions, isProbeStale, probeTargets } from './workspace/conflict-matrix.ts';
export type {
  BranchTip,
  ConflictProberPorts,
  ProbeAfterCommitRequest,
  ProbeReport,
} from './workspace/conflict-prober.ts';
export { ConflictProber } from './workspace/conflict-prober.ts';
// KAR-07.5 — the three layers that make a fresh worktree usable: gitignored
// config copied by `.worktreeinclude`, the lockfile's own install, and
// `workspace.setup` cached on the sha256 of its inputs (§5).
export type {
  DiskEstimate,
  DiskEstimateInput,
  DiskEstimateTerm,
  MeasuredRepo,
} from './workspace/disk-estimate.ts';
export {
  estimateFanOutDisk,
  formatBytes,
  measureRepoDisk,
  renderDiskEstimate,
} from './workspace/disk-estimate.ts';
export type {
  GatePort,
  GateRequest,
  IntegrationOutcome,
  IntegrationPorts,
  IntegrationRun,
  MergedNode,
  MergeRecord,
  ResolutionConfig,
} from './workspace/integration-loop.ts';
export {
  INTEGRATION_NODE_ID,
  IntegrationLoop,
  IntentUnavailableError,
  integrationLockReason,
  ledgerIntent,
  mergeSubject,
  NoMergedCounterpartError,
  parseMergeSubject,
  remainingMergeQueue,
} from './workspace/integration-loop.ts';
export type { MergeCandidate, QueuedMerge } from './workspace/merge-queue.ts';
export {
  conflictCountAgainst,
  mergeQueue,
  queueOrder,
  reorderPayload,
  UnprobedBranchError,
} from './workspace/merge-queue.ts';
export type { PackageManager, PackageManagerSetup } from './workspace/package-manager.ts';
export {
  AmbiguousLockfileError,
  detectPackageManager,
  LOCKFILES,
} from './workspace/package-manager.ts';
export type {
  CloneStep,
  CopyStep,
  IncludedFile,
  PlanInput,
  ProvisionPlan,
  ProvisionStep,
  RunStep,
  SymlinkStep,
} from './workspace/provision-plan.ts';
export {
  assertNoSharedNodeModules,
  planWorktreeProvision,
  SharedNodeModulesRefused,
} from './workspace/provision-plan.ts';
export type {
  EnvironmentRequest,
  EnvironmentResult,
  ProvisionedWorkspace,
  ProvisionerPorts,
  ProvisionWorkspaceRequest,
  WorkspaceConfig,
} from './workspace/provisioner.ts';
export {
  SETUP_STDERR_TAIL_BYTES,
  WorkspaceProvisioner,
  WorkspaceSetupFailed,
} from './workspace/provisioner.ts';
export type { ReflinkProbe } from './workspace/reflink.ts';
export { cloneTree, probeReflink } from './workspace/reflink.ts';
export type {
  IntentSummary,
  ResolutionNodeSpec,
  ResolutionRequest,
} from './workspace/resolution-node.ts';
export {
  RESOLUTION_SEGMENT_KINDS,
  resolutionNode,
  resolutionNodeId,
} from './workspace/resolution-node.ts';
export type {
  SetupCommandRequest,
  SetupOutcome,
  SetupRunner,
  SetupStream,
} from './workspace/run-setup.ts';
export { setupChildEnv, spawnSetup } from './workspace/run-setup.ts';
export type { CacheKeyFile } from './workspace/setup-cache.ts';
export { markerFileName, setupCacheKey } from './workspace/setup-cache.ts';
export type { IncludeCandidate } from './workspace/worktree-include.ts';
export {
  GITIGNORED_AMONG_ARGS,
  INCLUDE_MATCH_ARGS_TRACKED,
  INCLUDE_MATCH_ARGS_UNTRACKED,
  includedFiles,
  splitNul,
  WORKTREE_INCLUDE_FILE,
} from './workspace/worktree-include.ts';
// KAR-07.8 — the boot sweep: reap, then unlock, then prune, and never a
// worktree whose owning process is still verifiably alive.
export type {
  PrunedEntry,
  ReapRepo,
  WorktreeReapAction,
  WorktreeReapDecision,
  WorktreeReapPorts,
  WorktreeReapReport,
} from './workspace/worktree-reaper.ts';
export { reapWorktrees } from './workspace/worktree-reaper.ts';
