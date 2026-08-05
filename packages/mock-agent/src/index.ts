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
 * that fails loudly. KAR-04.2 adds the scripted scenario format — plans,
 * chunks at a declared cadence, tool-call status walks, permission branching
 * and the seven client callbacks — plus the per-invocation side-effect log.
 * Hang, mid-turn crash, malformed frames, the 10 MB line, configurable
 * `agentCapabilities` and recording replay are KAR-04.3 to KAR-04.5.
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
  SCENARIO_ENV,
  USAGE,
} from './cli.ts';
export { type Clock, createSyntheticClock, MOCK_CLOCK_STEP_MS, MOCK_EPOCH_MS } from './clock.ts';
export { createIdFactory, type IdFactory } from './ids.ts';
export { type Io, run, SCENARIO_EXIT_CODE, serve } from './main.ts';
export { mulberry32 } from './random.ts';
export {
  type Branch,
  type ChunksStep,
  CLIENT_METHODS,
  type ClientCallStep,
  type ClientMethod,
  type MessageStep,
  PERMISSION_OPTION_KINDS,
  type PermissionStep,
  type PlanStep,
  parseScenario,
  type Scenario,
  type ScenarioParseResult,
  STOP_REASONS,
  type Step,
  stripJsonComments,
  TOOL_CALL_STATUSES,
  TOOL_KINDS,
  type ToolCallStep,
} from './scenario.ts';
export {
  realSleep,
  runScenario,
  type TraceEntry,
  type TurnIo,
  type TurnResult,
} from './scripted.ts';
export {
  IDEMPOTENCY_FIELDS,
  IDEMPOTENCY_FLAGS,
  readInvocation,
  recordInvocation,
  SIDE_EFFECT_LOG_ENV,
  type SideEffectRecord,
} from './side-effect-log.ts';
