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
// KAR-06.7 — the kill switch's mechanics: the four rungs of the escalation
// ladder, each of them an event, and the pid-reuse refusal in front of them.
export type { CancelOutcome, CancelPorts, CancelReport } from './cancel.ts';
export { cancelNode, KILL_VERIFY_MS, TERM_GRACE_MS } from './cancel.ts';
export { systemClock } from './clock.ts';
export { DATA_DIR_ENV, type DataDirEnv, resolveDataDir } from './data-dir.ts';
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
export type { StartedHttp, StartHttpOptions } from './http/server.ts';
export { DEFAULT_HOSTNAME, DEFAULT_PORT, startHttp } from './http/server.ts';
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
  ArtifactStore,
  FactStore,
  McpGrant,
  McpGrantRequest,
  McpHost,
  McpHostOptions,
} from './mcp/host.ts';
export { MCP_SOCKET_DIR, MCP_SOCKET_FILE, startMcpHost } from './mcp/host.ts';
export type { HostFrame, ShimFrame } from './mcp/protocol.ts';
export { BRIDGE_VERSION, BridgeProtocolError } from './mcp/protocol.ts';
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
export type { SchemaRegistryCheck } from './preflight.ts';
export { checkSchemaRegistry, EX_CONFIG } from './preflight.ts';
export type { DaemonSeed, SeedEnv } from './random.ts';
export { daemonRandom, daemonSeed, RANDOM_SEED_ENV } from './random.ts';
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
// KAR-06.5 — the imperative half of the retry ladder: the classified failure,
// the wake row and the events, in one transaction.
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
export { acpFsHandlers } from './services/fronts/acp-fs.ts';
export { acpPermissionHandlers } from './services/fronts/acp-permission.ts';
export { acpTerminalHandlers } from './services/fronts/acp-terminal.ts';
// KAR-05.1 — the transport-neutral fs/terminal/permission services, and the
// thin ACP fronts wired into the client. ACP v2 deletes the fronts; the
// services outlive them.
export type {
  FsService,
  FsServiceOptions,
  PathPolicy,
  ReadTextRequest,
  WriteTextRequest,
} from './services/fs-service.ts';
export { createFsService } from './services/fs-service.ts';
export type {
  PermissionDecider,
  PermissionDecision,
  PermissionOption,
  PermissionQuery,
  PermissionService,
  ToolKind,
} from './services/permission-service.ts';
export { createPermissionService } from './services/permission-service.ts';
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
