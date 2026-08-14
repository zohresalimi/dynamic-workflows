/**
 * KAR-19.3 AC1, AC2 — the **production** resolver: the one `DeFlow up` binds.
 *
 * `./live-chain.test.ts` drives `createRunChain` against scripted agent ports
 * and a resolver written in that file. It is green, and it was green on
 * 2026-08-12 while every operator's run stopped at its framing wake, because
 * the resolver a spec writes is not the resolver that ships. This file is about
 * the shipped one: real `PROVIDER_SPECS` resolution against a `PATH` root, the
 * real probed capability row out of the ledger, the run's own `.DeFlow/schemas`
 * written for real, and real child processes for all three turns.
 *
 * The one thing it does not do is start a daemon — `e2e/live-chain.test.ts`
 * does that, over the real binary. What is settled here is everything between
 * `boot()`'s ports and a child process, at a level where a failure names the
 * step that broke rather than "the run never reached plan.proposed".
 *
 * Verifies: EPIC-19-S16, EPIC-19-S21 · KAR-19.3 AC1, AC2 · test plan #1, #2
 */
import type { Db, RunId } from '@DeFlow/core';
import { openLedger, readFacts, readRange, recordProviderCapabilities } from '@DeFlow/ledger';
import { it, makeRepo, TestClock } from '@DeFlow/testkit';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { createRunDriver } from '../../src/drive.ts';
import { submitTask } from '../../src/intake/intake.ts';
import { createLiveRunChain } from '../../src/pipeline/live-chain.ts';
import { approveSpec } from '../../src/spec/gate.ts';

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

const T0 = 1_786_000_000_000;
const EPOCH = 7;
const RAW_TASK = 'Add a GET /health endpoint that returns 200.';

/**
 * A `PATH` root holding a `node` and nothing else.
 *
 * The bundled agent is a `#!/usr/bin/env node` script, so the child needs a
 * `node` on the `PATH` DeFlow hands it — and putting *node's own directory*
 * there would bring the npm global bin directory with it on a normal
 * installation, which is where a developer's real vendor CLI lives. The same
 * correction `e2e/support/up.ts` makes, for the same reason.
 */
async function nodeOnlyDir(tmp: string): Promise<string> {
  const dir = join(tmp, 'nodebin');
  await mkdir(dir, { recursive: true });
  await symlink(process.execPath, join(dir, 'node'));
  return dir;
}

const kinds = (db: Db, runId: RunId): string[] =>
  readRange(db, runId, 0, 500).events.map((event) => event.kind);

const seqOf = (db: Db, runId: RunId, kind: string): number =>
  readRange(db, runId, 0, 500).events.find((event) => event.kind === kind)?.seq ?? -1;

interface Scene {
  readonly db: Db;
  readonly runId: RunId;
  readonly clock: TestClock;
  readonly driver: ReturnType<typeof createRunDriver>;
  close(): void;
}

/**
 * A machine whose only agent is the bundled one, as the boot probe would have
 * left it: the binary resolvable on one `PATH` root, and one probed capability
 * row in the ledger.
 */
async function scene(tmp: string): Promise<Scene> {
  const repoDir = join(tmp, 'repo');
  await makeRepo({
    dir: repoDir,
    files: { 'package.json': '{"name":"target","scripts":{"test":"vitest run"}}\n' },
  });

  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const binDir = join(tmp, 'bin');
  await mkdir(binDir, { recursive: true });
  await symlink(MOCK_AGENT_BIN, join(binDir, 'DeFlow-mock-agent'));
  const nodeDir = await nodeOnlyDir(tmp);

  const db = openLedger(dataDir);
  recordProviderCapabilities(db, {
    provider: 'mock',
    version: '0.0.0',
    binarySha256: 'c'.repeat(64),
    binaryPath: join(binDir, 'DeFlow-mock-agent'),
    capsJson: JSON.stringify({ agentCapabilities: {} }),
    probedAt: T0,
  });

  const clock = new TestClock(T0);
  const chain = createLiveRunChain({
    dataDir,
    clock,
    providerRoots: [binDir, nodeDir],
    daemonEnv: { HOME: tmp },
  });

  const submitted = await submitTask(
    {
      body: { input: { kind: 'text', text: RAW_TASK }, cwd: repoDir, permission: 'worktree' },
      by: 'cli',
    },
    { db, epoch: EPOCH, clock, dataDir, randomHex: () => '0b0b0b' },
  );
  if (submitted.outcome !== 'created') throw new Error('the submission was refused');

  const driver = createRunDriver({
    db,
    clock,
    epoch: EPOCH,
    runFraming: chain.runFraming,
    advanceRun: chain.advanceRun,
  });

  return { db, runId: submitted.runId, clock, driver, close: () => db.close() };
}

suite('KAR-19.3 — the shipped resolver carries a run from intake to a plan', () => {
  it('frames against the bundled binary and opens the F1.3 gate', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      await s.driver.tick(s.clock.now());

      expect(kinds(s.db, s.runId)).toContain('run.created');
      expect(kinds(s.db, s.runId)).toContain('human.requested');
      // AC3 — and nothing was planned while the operator is still reading.
      expect(kinds(s.db, s.runId)).not.toContain('plan.proposed');
    } finally {
      s.close();
    }
  });

  it('pins, surveys and compiles once the spec is approved', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      await s.driver.tick(s.clock.now());
      s.clock.advance(1_000);
      await approveSpec({ db: s.db, runId: s.runId, epoch: EPOCH, ts: s.clock.now(), by: 'cli' });

      s.clock.advance(1_000);
      await s.driver.tick(s.clock.now());

      const order = kinds(s.db, s.runId);
      // The whole stream, and any validation diagnostics, in the failure
      // message: "expected to contain plan.proposed" on its own sends the
      // reader back to the daemon log to find out which step refused.
      const refused = readRange(s.db, s.runId, 0, 500).events.find(
        (event) => event.kind === 'plan.validation_failed',
      );
      expect(
        order,
        `${order.join(',')}\n${JSON.stringify(refused?.payload ?? null, null, 2)}`,
      ).toContain('plan.proposed');
      for (const [before, after] of [
        ['task.submitted', 'run.created'],
        ['run.created', 'run.spec.approved'],
        ['run.spec.approved', 'spec.pinned'],
        ['spec.pinned', 'plan.proposed'],
      ] as const) {
        expect(seqOf(s.db, s.runId, before)).toBeLessThan(seqOf(s.db, s.runId, after));
      }

      // AC2 / test plan #2 — the planner was reached with recon input, and
      // every fact recon recorded carries provenance.
      const facts = readFacts(s.db, s.runId);
      expect(facts.length).toBeGreaterThan(0);
      for (const stored of facts) {
        expect(stored.fact.provenance.atEvent).toBeGreaterThan(0);
      }
      expect(seqOf(s.db, s.runId, 'fact.written')).toBeLessThan(
        seqOf(s.db, s.runId, 'plan.proposed'),
      );
    } finally {
      s.close();
    }
  });

  it('does nothing at all on a machine whose only adapter was never probed', async ({ tmp }) => {
    const repoDir = join(tmp, 'repo');
    await makeRepo({ dir: repoDir });
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    const db = openLedger(dataDir);
    const clock = new TestClock(T0);

    // No `recordProviderCapabilities`: the binary is there, nothing has shaken
    // hands with it, and a capability read from anywhere but a probed row is a
    // constant wearing a capability's clothes (KAR-05.2).
    const binDir = join(tmp, 'bin');
    await mkdir(binDir, { recursive: true });
    await symlink(MOCK_AGENT_BIN, join(binDir, 'DeFlow-mock-agent'));

    const chain = createLiveRunChain({
      dataDir,
      clock,
      providerRoots: [binDir, await nodeOnlyDir(tmp)],
      daemonEnv: { HOME: tmp },
    });

    const submitted = await submitTask(
      {
        body: { input: { kind: 'text', text: RAW_TASK }, cwd: repoDir, permission: 'worktree' },
        by: 'cli',
      },
      { db, epoch: EPOCH, clock, dataDir, randomHex: () => '0c0c0c' },
    );
    if (submitted.outcome !== 'created') throw new Error('the submission was refused');

    const driver = createRunDriver({
      db,
      clock,
      epoch: EPOCH,
      runFraming: chain.runFraming,
      advanceRun: chain.advanceRun,
    });
    try {
      await driver.tick(clock.now());
      expect(kinds(db, submitted.runId)).not.toContain('run.created');
    } finally {
      db.close();
    }
  });
});
