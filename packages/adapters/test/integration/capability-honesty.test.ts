/**
 * KAR-05.7 AC5 — an agent that advertises a capability it does not honour.
 *
 * Assertion 6 is the one that catches a lying capability manifest, **which is
 * the single input the entire routing layer trusts**. Everything else in the
 * battery asks whether an adapter works; this asks whether the row DeFlow
 * routes from is true, and a row that lies about one thing cannot be trusted
 * about the rest.
 *
 * Two halves, and both matter:
 *
 *   - the **conformance** half: the battery fails, and its message names the
 *     capability and the method rather than merely the JSON-RPC code, because
 *     `-32601` alone does not tell an operator which promise was broken;
 *   - the **runtime** half: a resume onto a dishonest `session/resume` fails
 *     with `adapter.capability-missing` and **does not silently downgrade to
 *     ResumeByReplay**. An automatic fallback would paper over the dishonesty
 *     and let a broken adapter keep making routing promises it cannot keep.
 *     Fail, tell the operator, and let re-routing be an explicit `PlanPatch`
 *     (EPIC-11).
 *
 * Verifies: EPIC-05-S27 · AC5 · test plan #5
 */

import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type ConformanceCase,
  type ConformancePorts,
  describeConformance,
  resumeAcpNode,
  runAcpNode,
  runProviderConformance,
} from '../../src/index.ts';
import {
  liveInGroup,
  mockAgentBinary,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  scenario,
  type TestLedger,
} from './support/harness.ts';
import { mockAdapter } from './support/mock-adapter.ts';
import { capabilityRowFor, seedContextBuilt, wireMethods } from './support/resume-fixture.ts';

let dir = '';
let worktree = '';
let ledger: TestLedger;

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  await mkdir(worktree, { recursive: true });
  ledger = openTestLedger(dir);
});

afterEach(async () => {
  ledger.close();
  await removeTempDir(dir);
});

const ports = async (): Promise<ConformancePorts> => ({
  clock: new TestClock(),
  ledger: ledger.sink,
  captureEvidence: ledger.captureEvidence,
  worktree: async (kase: ConformanceCase): Promise<string> => {
    const path = join(dir, 'wt', kase);
    await mkdir(path, { recursive: true });
    return path;
  },
  runId: RUN_ID,
  nodeId: NODE_ID,
  provider: PROVIDER,
  liveInGroup,
});

suite('assertion 6 fails, and names what was broken', () => {
  it('names session.resume and session/resume for a dishonest resume', async () => {
    const report = await runProviderConformance(
      mockAdapter({
        profile: 'claude',
        ledger,
        clock: new TestClock(),
        dataDir: dir,
        dishonest: 'session.resume',
      }),
      await ports(),
    );

    expect(report.passed).toBe(false);
    const honesty = report.results.filter(
      (result) => result.assertion === 6 && result.subject === 'session.resume',
    );
    expect(honesty).toHaveLength(1);
    expect(honesty[0]?.status).toBe('failed');
    // Both halves of the pairing. `-32601` on its own says a method is
    // missing; it does not say which promise the manifest made.
    expect(honesty[0]?.detail).toContain('session.resume');
    expect(honesty[0]?.detail).toContain('session/resume');
    expect(honesty[0]?.detail).toContain('-32601');
    expect(describeConformance(report)).toContain('FAILED');
  }, 60_000);

  it.each([
    ['session.fork', 'session/fork'],
    ['session.list', 'session/list'],
    ['session.delete', 'session/delete'],
  ])(
    'names %s and %s',
    async (capabilityName, method) => {
      const report = await runProviderConformance(
        mockAdapter({
          profile: 'claude',
          ledger,
          clock: new TestClock(),
          dataDir: dir,
          dishonest: capabilityName,
        }),
        await ports(),
      );

      const honesty = report.results.find(
        (result) => result.assertion === 6 && result.subject === capabilityName,
      );
      expect(honesty?.status).toBe('failed');
      expect(honesty?.detail).toContain(capabilityName);
      expect(honesty?.detail).toContain(method);
    },
    60_000,
  );

  it('leaves the honest capabilities of the same adapter passing', async () => {
    // A battery that failed the whole adapter on one broken promise would be
    // useless for deciding what the adapter can still be trusted with.
    const report = await runProviderConformance(
      mockAdapter({
        profile: 'claude',
        ledger,
        clock: new TestClock(),
        dataDir: dir,
        dishonest: 'session.list',
      }),
      await ports(),
    );

    const fork = report.results.find(
      (result) => result.assertion === 6 && result.subject === 'session.fork',
    );
    expect(fork?.status).toBe('passed');
  }, 60_000);
});

suite('a dishonest resume fails as a capability, not as a mystery', () => {
  it('fails with adapter.capability-missing naming the capability and the method', async () => {
    const binary = mockAgentBinary();
    const fixture = await seedContextBuilt({
      dataDir: dir,
      ledger,
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
    });

    // Life one: a node that died mid-turn, so there is a session id to resume.
    const first = await runAcpNode(
      {
        runId: RUN_ID,
        nodeId: NODE_ID,
        attempt: 0,
        provider: PROVIDER,
        permission: 'worktree',
        worktree,
        binary,
        argv: ['--capabilities', 'claude', '--scenario', scenario('exit-mid-turn.jsonc')],
        mcpServers: [],
        prompt: fixture.prompt,
      },
      {
        clock: new TestClock(),
        ledger: ledger.sink,
        captureEvidence: ledger.captureEvidence,
        capabilityRow: capabilityRowFor('claude', binary),
      },
    );
    expect(first.status).toBe('failed');
    expect(first.sessionId).not.toBeNull();

    // Life two: the probed row still says resume, and the binary now lies.
    const wire = join(dir, 'wire-dishonest.ndjson');
    const outcome = await resumeAcpNode(
      {
        runId: RUN_ID,
        nodeId: NODE_ID,
        attempt: 0,
        provider: PROVIDER,
        permission: 'worktree',
        worktree,
        binary,
        argv: [
          '--capabilities',
          'claude',
          '--dishonest-capabilities',
          'session.resume',
          '--wire-log',
          wire,
        ],
        mcpServers: [],
      },
      {
        clock: new TestClock(),
        ledger: ledger.sink,
        captureEvidence: ledger.captureEvidence,
        capabilityRow: capabilityRowFor('claude', binary),
        history: async () => ledger.events(),
        readSegmentText: ledger.readSegmentText,
      },
    );

    // The row said resume, so the strategy was native. That is the point: the
    // decision was made from the manifest, and the manifest was wrong.
    expect(outcome.strategy).toBe('ResumeNative');
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.reason).toBe('adapter.capability-missing');
    expect(outcome.failure.message).toContain('session.resume');
    expect(outcome.failure.message).toContain('session/resume');
    expect(outcome.failure.detail).toMatchObject({
      capability: 'session.resume',
      method: 'session/resume',
    });

    const failed = ledger
      .events()
      .filter((event) => event.kind === 'node.failed')
      .at(-1);
    expect(failed?.payload).toMatchObject({
      failure: { reason: 'adapter.capability-missing' },
    });

    // AC: no silent downgrade. `session/resume` was sent and refused; there is
    // no `session/new` behind it pretending the node recovered.
    const methods = wireMethods(wire);
    expect(methods).toContain('session/resume');
    expect(methods).not.toContain('session/new');
  }, 60_000);
});
