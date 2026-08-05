/**
 * @DeFlow/testkit — fake agent binaries, hermetic git fixtures, tmpdir
 * fixtures, TestClock, file-backed SQLite and the normalising snapshot
 * serializer.
 *
 * Fake binaries, not mocked modules: everything here is a real executable on a
 * temp PATH, a real directory on disk, a real `git` child process or a real
 * SQLite file. Mocking the process boundary would test the mock — the spawn
 * logic, the argv construction, the stream parser, the backpressure handling,
 * the timeout and the kill path all live on the other side of it.
 *
 * KAR-03.8 adds what the crash-fuzz suite runs on: a real child that can be
 * SIGKILLed together with everything it spawned, the fake agents' own
 * side-effect log, and the seed that makes a failing kill point reproducible.
 *
 * KAR-04.6 adds the exec-shim half: the same binary, told which vendor CLI to
 * impersonate, reproducing the F3.4 conformance battery on the non-ACP path.
 *
 * Still to come: the FakeEffectRunner (EPIC-06).
 */
export { type AgentOnPath, FAKE_AGENT_BIN, linkFakeAgent } from './agent.ts';
export { TestClock } from './clock.ts';
export {
  type Crashable,
  type CrashableOptions,
  type Exit,
  sleep,
  startCrashable,
  type WaitForOptions,
  waitFor,
} from './crash.ts';
export { dbContract } from './db-contract.ts';
export {
  CLAUDE_VERBOSE_REQUIRED,
  type CliDecision,
  DIALECT_ENV,
  DIALECTS,
  type Dialect,
  decideCli,
  type OutputFormat,
  readDialect,
} from './exec-shim/dialects.ts';
export {
  type ClaudeStreamJson,
  claudeStreamJson,
  codexJsonl,
  copilotJson,
  type FrameContext,
  patternSlice,
  uuidsFromSeed,
} from './exec-shim/frames.ts';
export { createProcessPorts } from './exec-shim/ports.ts';
export {
  EXIT_CODE_ENV,
  type ExecShimPorts,
  NOW_ENV,
  runExecShim,
  SEED_ENV,
  seedFrom,
} from './exec-shim/run.ts';
export {
  EXEC_SHIM_SCENARIO_DIR,
  type ExecShimScenario,
  type ExecStep,
  loadExecShimScenario,
  parseExecShimScenario,
  RESULT_SUBTYPES,
  type ResultScript,
  type ResultSubtype,
  SCENARIO_ENV,
} from './exec-shim/scenario.ts';
export { FakeDb, FakeDbClosed, FakeDbUnsupportedSql } from './fake-db.ts';
export { type DeFlowFixtures, it } from './fixtures.ts';
export { GIT_ENV, type GitResult, git, tryGit } from './git.ts';
export {
  CI_RUN_ID_ENV,
  CRASH_SEED_ENV,
  type CrashSeed,
  crashSeed,
  mulberry32,
  type SeedEnv,
} from './random.ts';
export { type MakeRepoOptions, makeRepo, type Repo } from './repo.ts';
export {
  type DuplicateEffect,
  duplicateIdempotencyKeys,
  IDEMPOTENCY_FIELDS,
  IDEMPOTENCY_FLAGS,
  LEGACY_SIDE_EFFECT_LOG_ENV,
  readInvocation,
  readSideEffectLog,
  recordInvocation,
  SIDE_EFFECT_LOG_ENV,
  type SideEffect,
  type SideEffectLog,
} from './side-effect-log.ts';
export {
  createSnapshotSerializers,
  normaliseSnapshotObject,
  normaliseSnapshotText,
  repoRoot,
} from './snapshot.ts';
export { openTestDatabase, TEST_PRAGMAS } from './sqlite.ts';
export {
  KEEP_TMP_ENV,
  makeTempDir,
  removeTempDir,
  shouldRemoveTempDir,
  TMP_PREFIX,
} from './tmp.ts';
