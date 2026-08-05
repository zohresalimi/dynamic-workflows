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
  loadSession,
  mcpAcp,
  mediatedExecution,
  supportsTerminal,
} from './capabilities.ts';
export { CLIENT_CAPABILITIES, CLIENT_INFO } from './client-capabilities.ts';
export {
  ACP_PROTOCOL_VERSION,
  agentExited,
  agentTimedOut,
  argvRejected,
  frameTooLarge,
  handshakeMismatch,
  NotImplementedOnWin32,
  offendingFrameHead,
  protocolError,
  registryRefused,
  resolutionFailed,
  spawnRefused,
  toAdapterFailure,
  UnsignalablePid,
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
// KAR-05.9 — the one abstraction allowed to send a signal, plus the PID-reuse
// guard's input. POSIX at M1; win32 throws rather than silently no-opping.
export type { KillOutcome, KillTreePorts, SweepPorts } from './kill-tree.ts';
export {
  killTree,
  processStartTime,
  SWEEP_KILL_GRACE_MS,
  startTimeSource,
  sweepTree,
} from './kill-tree.ts';
// KAR-05.3 — spawning a provider, with the one bounded retry a flag
// mid-deprecation earns and no vendor knowledge of its own.
export type { LaunchOutcome, LaunchPorts, LaunchRequest } from './launch.ts';
export { LAUNCH_EXIT_GRACE_MS, launchProvider, STDERR_TAIL_BYTES } from './launch.ts';
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
  ProcessRegistry,
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
// KAR-05.3 — the verified provider table, encoded once. The only file in this
// package that names a vendor, and it names no capability.
export type {
  KnownProviderId,
  ProviderKind,
  ProviderSpec,
  SpawnContext,
  SpawnPlan,
} from './provider-registry.ts';
export { PROVIDER_SPECS, providerSpec, spawnPlan } from './provider-registry.ts';
export { sliceMember } from './raw-frame.ts';
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
export type { AgentTransport, ReadGate, TransportOptions } from './transport.ts';
export { agentTransport } from './transport.ts';
export type { UpdateDescription } from './updates.ts';
export { describeUpdate, toolCallContentText } from './updates.ts';
