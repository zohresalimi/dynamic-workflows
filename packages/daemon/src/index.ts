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
  GitWorktreeAddInput,
  WorktreeAddResult,
} from './effects/git-effect.ts';
export { gitCommitEffect, gitWorktreeAddEffect } from './effects/git-effect.ts';
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
// KAR-06.4 — the spawn half of the git wrapper KAR-07.1 completes.
export type { GitResult, RunGitOptions } from './git/run-git.ts';
export { GIT_TIMEOUT_MS, gitChildEnv, runGit } from './git/run-git.ts';
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
