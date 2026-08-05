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
  ReconcileProbe,
} from './effects/durable.ts';
export {
  createEffectRunner,
  EffectFailed,
  EffectNeedsReconciliation,
  EffectRequestHashMismatch,
} from './effects/durable.ts';
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
