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
 * Still to come: the fake agent's full F3.4 scenario vocabulary (EPIC-04/05),
 * the FakeEffectRunner (EPIC-06) and the crash-fuzz harness (EPIC-03).
 */
export { type AgentOnPath, FAKE_AGENT_BIN, linkFakeAgent } from './agent.ts';
export { TestClock } from './clock.ts';
export { dbContract } from './db-contract.ts';
export { FakeDb, FakeDbClosed, FakeDbUnsupportedSql } from './fake-db.ts';
export { type DeFlowFixtures, it } from './fixtures.ts';
export { GIT_ENV, type GitResult, git, tryGit } from './git.ts';
export { type MakeRepoOptions, makeRepo, type Repo } from './repo.ts';
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
