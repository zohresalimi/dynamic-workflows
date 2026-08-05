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
 * KAR-04.3 adds hang, mid-turn crash, malformed frames and the 10 MB line.
 * KAR-04.4 adds configurable `agentCapabilities` — named profiles generated
 * from `fixtures/capability-matrix.json`, an arbitrary `--capabilities-file`,
 * and `--dishonest-capabilities` for a capability advertised but refused.
 * Recording replay is KAR-04.5.
 */
export {
  AGENT_NAME,
  AGENT_VERSION,
  type CapabilitiesOptions,
  createMockAgent,
  DEFAULT_AGENT_CAPABILITIES,
  DEFAULT_CAPABILITIES_OPTIONS,
  turnChunks,
} from './agent.ts';
export {
  CAPABILITY_MATRIX_PATH,
  CAPABILITY_PROFILE_NAMES,
  CAPABILITY_PROFILES,
  type CapabilityMatrix,
  type CapabilityProfileName,
  type CapabilityProfiles,
  generateCapabilityProfiles,
} from './capability-profiles.ts';
export {
  BIN_NAME,
  BUILTIN_SCENARIO_DIR,
  type CapabilitiesSelection,
  DEFAULT_SEED,
  DISHONEST_CAPABILITY_METHODS,
  type DishonestCapability,
  type DishonestMethod,
  type MockAgentOptions,
  PATHOLOGICAL_FLAGS,
  type ParsedArgv,
  parseArgv,
  SCENARIO_ENV,
  USAGE,
} from './cli.ts';
export { type Clock, createSyntheticClock, MOCK_CLOCK_STEP_MS, MOCK_EPOCH_MS } from './clock.ts';
export { createIdFactory, type IdFactory } from './ids.ts';
export { CAPABILITIES_EXIT_CODE, type Io, run, SCENARIO_EXIT_CODE, serve } from './main.ts';
export {
  HUGE_LINE_TOTAL_BYTES,
  hugeLineFrameParts,
  INVALID_FRAME_VARIANTS,
  type InvalidFrameSpec,
  type InvalidFrameVariant,
  invalidFrame,
  MALFORMED_LINE,
  malformedLine,
  NO_NEWLINE_INTERVAL_MS,
  patternSlice,
  RAW_CHUNK_BYTES,
  TRUNCATED_FRAME_PREFIX,
  truncatedFrame,
} from './pathological.ts';
export { createProcessPorts, type MockAgentPorts } from './ports.ts';
export { mulberry32 } from './random.ts';
export {
  type Branch,
  type ChunksStep,
  CLIENT_METHODS,
  type ClientCallStep,
  type ClientMethod,
  type ExitStep,
  type HangForeverIgnoringCancelStep,
  type HangForeverStep,
  type HugeLineStep,
  type InvalidFrameStep,
  type MalformedLineStep,
  type MessageStep,
  type NoNewlineStep,
  PERMISSION_OPTION_KINDS,
  type PermissionStep,
  type PlanStep,
  parseScenario,
  type Scenario,
  type ScenarioParseResult,
  type SpawnGrandchildrenStep,
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
