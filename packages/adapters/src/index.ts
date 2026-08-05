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
  ClientHandlers,
  EventRecord,
  IoRecord,
  LedgerSink,
} from './ports.ts';
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
