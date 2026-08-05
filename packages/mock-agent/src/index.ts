/**
 * @DeFlow/mock-agent — a real, seeded, deterministic ACP *agent* binary.
 *
 * It deliberately has zero workspace dependencies. If it depended on the
 * domain model, a bug there could be mirrored on both sides of the wire and
 * cancel itself out. It is an independent implementation of the agent side of
 * the same published schema, which is what makes it a useful oracle.
 *
 * KAR-04.1 ships the spine: a bin that speaks a full ACP prompt cycle over
 * stdin and stdout, seeded ids and a synthetic clock, and version negotiation
 * that fails loudly. Scripted chunks, permission requests, fs/terminal
 * callbacks, hang, mid-turn crash, malformed frames, the 10 MB line,
 * configurable `agentCapabilities` and recording replay are KAR-04.2 to
 * KAR-04.5.
 */
export {
  AGENT_NAME,
  AGENT_VERSION,
  createMockAgent,
  DEFAULT_AGENT_CAPABILITIES,
  turnChunks,
} from './agent.ts';
export {
  BIN_NAME,
  DEFAULT_SEED,
  type MockAgentOptions,
  type ParsedArgv,
  parseArgv,
  USAGE,
} from './cli.ts';
export { type Clock, createSyntheticClock, MOCK_CLOCK_STEP_MS, MOCK_EPOCH_MS } from './clock.ts';
export { createIdFactory, type IdFactory } from './ids.ts';
export { type Io, run, serve } from './main.ts';
export { mulberry32 } from './random.ts';
