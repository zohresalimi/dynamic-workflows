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
 * KAR-04.5 adds `--replay <file>`, which serves a golden recording of a real,
 * authenticated vendor session instead of generating a turn — the one mode in
 * which nothing here decides what the bytes say.
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
  MOCK_AGENT_VERSION,
  type MockAgentOptions,
  PATHOLOGICAL_FLAGS,
  type ParsedArgv,
  parseArgv,
  type ReplaySelection,
  SCENARIO_ENV,
  USAGE,
  VERSION_ENV,
} from './cli.ts';
export { type Clock, createSyntheticClock, MOCK_CLOCK_STEP_MS, MOCK_EPOCH_MS } from './clock.ts';
export { type UnifiedDiffOptions, unifiedDiff } from './diff.ts';
export { createIdFactory, type IdFactory } from './ids.ts';
export {
  CAPABILITIES_EXIT_CODE,
  type Io,
  RECORDING_EXIT_CODE,
  run,
  SCENARIO_EXIT_CODE,
  serve,
} from './main.ts';
export {
  HUGE_LINE_TOTAL_BYTES,
  hugeLineFrameParts,
  hugeLinePayloadBytes,
  INVALID_FRAME_VARIANTS,
  type InvalidFrameSpec,
  type InvalidFrameVariant,
  invalidFrame,
  MALFORMED_LINE,
  malformedLine,
  NO_NEWLINE_INTERVAL_MS,
  patternSlice,
  RAW_CHUNK_BYTES,
  sizedToolContent,
  TRUNCATED_FRAME_PREFIX,
  truncatedFrame,
} from './pathological.ts';
export { createProcessPorts, type MockAgentPorts } from './ports.ts';
export { mulberry32 } from './random.ts';
export {
  type CaptureConversionOptions,
  comparableText,
  type Direction,
  frameDiff,
  framesEqual,
  fromTransportCapture,
  type Json,
  type JsonObject,
  parseRecording,
  parseRecordingKey,
  RECORDING_DIR_SHAPE,
  type RecordedFrame,
  type RecordingKey,
  type RecordingKeyResult,
  type RecordingResult,
} from './recording.ts';
export {
  HOME_PLACEHOLDER,
  RecordingRedactor,
  type RedactionOptions,
  redactRecording,
  TMPDIR_PLACEHOLDER,
} from './redaction.ts';
export {
  DEFAULT_REPLAY_SPEED,
  lines,
  REPLAY_MISMATCH_EXIT_CODE,
  REPLAY_SPEEDS,
  REPLAY_STDIN_EXIT_CODE,
  REPLAY_TRUNCATED_EXIT_CODE,
  type ReplayIo,
  type ReplayRun,
  type ReplaySpeed,
  runReplay,
} from './replay.ts';
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
// KAR-19.7 — the structured-output path. `MOCK_STRUCTURED_OUTPUT_FLAG` is
// exported for `provider-registry.ts`, which declares it as this provider's
// `structuredOutputFlag`: one constant, so a rename cannot leave the registry
// claiming a capability the binary does not have.
export {
  BUNDLED_PROVIDER_ID,
  canServe,
  DRAFT_SCHEMA_ID,
  type GeneratorInput,
  MOCK_PROMPT_FLAG,
  MOCK_STRUCTURED_OUTPUT_FLAG,
  PLAN_SCHEMA_ID,
  RECON_FACT_SCHEMA_ID,
  RECON_SURVEY_SCHEMA_ID,
  renderReturn,
  SCHEMA_GENERATORS,
  type ScriptedReturn,
  SERVABLE_SCHEMA_IDS,
  schemaIdFromPath,
  schemaIdOf,
  serveSchema,
} from './structured.ts';
