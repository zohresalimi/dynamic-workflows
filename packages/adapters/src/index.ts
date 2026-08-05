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
  handshakeMismatch,
  protocolError,
  spawnRefused,
  toAdapterFailure,
} from './failures.ts';
export type {
  AcpNodeRequest,
  AcpPorts,
  AgentBinary,
  CapabilityStore,
  ClientHandlers,
  EventRecord,
  IoRecord,
  LedgerSink,
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
export { sliceMember } from './raw-frame.ts';
export type { AcpNodeOutcome, ProcessExit } from './run-node.ts';
export {
  AGENT_TURN_SCHEMA_ID,
  CANCEL_GRACE_MS,
  estimateUsage,
  KILL_GRACE_MS,
  runAcpNode,
} from './run-node.ts';
export type { AgentTransport, ReadGate } from './transport.ts';
export { agentTransport } from './transport.ts';
export type { UpdateDescription } from './updates.ts';
export { describeUpdate } from './updates.ts';
