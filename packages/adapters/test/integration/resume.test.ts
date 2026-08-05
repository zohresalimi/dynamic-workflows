/**
 * EPIC-05-S19 — a node survives a daemon restart on every provider, not only
 * on the three that can resume.
 *
 * Every case here is two daemon *lives* over one ledger file: the first runs
 * until the agent dies mid-turn, then `db.close()`; the second opens a fresh
 * engine over the same file and resumes. That is AC7's code path, and it is
 * also the only honest way to test the claim — a resume inside one process
 * shares the caches that a real crash destroys.
 *
 * The witness for "which frames were sent" is the mock's `--wire-log`: every
 * line the client wrote, recorded on the agent's side of the pipe. It is the
 * only observation that separates "DeFlow chose not to send `session/resume`"
 * from "DeFlow sent it and the agent had no handler".
 *
 * Verifies: EPIC-05-S19 · AC1, AC2, AC3, AC4, AC7 · test plan #2, #3, #4
 */

import type { CapabilityProfileName } from '@DeFlow/mock-agent';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { resumeAcpNode, runAcpNode } from '../../src/index.ts';
import {
  eventOf,
  mockAgentBinary,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  scenario,
  type TestLedger,
} from './support/harness.ts';
import {
  capabilityRowFor,
  RESUME_SEGMENTS,
  seedContextBuilt,
  wireFrames,
  wireMethods,
} from './support/resume-fixture.ts';

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

interface Interrupted {
  readonly prompt: string;
  readonly sessionId: string;
  readonly firstLifeWire: string;
}

/**
 * Life one: build the packet, start the node, let the agent die mid-turn, and
 * close the database — a daemon that was killed with a turn in flight.
 */
async function interruptedFirstLife(profile: CapabilityProfileName): Promise<Interrupted> {
  const binary = mockAgentBinary();
  const fixture = await seedContextBuilt({
    dataDir: dir,
    ledger,
    runId: RUN_ID,
    nodeId: NODE_ID,
    attempt: 0,
    provider: PROVIDER,
  });
  const firstLifeWire = join(dir, `wire-1-${profile}.ndjson`);

  const outcome = await runAcpNode(
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
        profile,
        '--scenario',
        scenario('exit-mid-turn.jsonc'),
        '--wire-log',
        firstLifeWire,
      ],
      mcpServers: [],
      prompt: fixture.prompt,
    },
    {
      clock: new TestClock(),
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      capabilityRow: capabilityRowFor(profile, binary),
    },
  );

  // The agent really died mid-turn: this is the interruption, not a stub.
  expect(outcome.status).toBe('failed');
  expect(outcome.sessionId).not.toBeNull();

  ledger.close();
  return {
    prompt: fixture.prompt,
    sessionId: outcome.sessionId as string,
    firstLifeWire,
  };
}

/** Life two: a brand new engine over the same file, and a resume. */
async function resumeInSecondLife(profile: CapabilityProfileName, wire: string) {
  ledger = openTestLedger(dir);
  const binary = mockAgentBinary();
  return await resumeAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: 'worktree',
      worktree,
      binary,
      argv: ['--capabilities', profile, '--wire-log', wire],
      mcpServers: [],
    },
    {
      clock: new TestClock(),
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      capabilityRow: capabilityRowFor(profile, binary),
      history: async () => ledger.events(),
      readSegmentText: ledger.readSegmentText,
    },
  );
}

suite('the strategy follows the capability, not the vendor name', () => {
  const cases: readonly [CapabilityProfileName, 'ResumeNative' | 'ResumeByReplay'][] = [
    ['claude', 'ResumeNative'],
    ['codex', 'ResumeNative'],
    ['opencode', 'ResumeNative'],
    ['copilot', 'ResumeByReplay'],
    ['gemini', 'ResumeByReplay'],
  ];

  for (const [profile, strategy] of cases) {
    it(`${profile}: resumes by ${strategy} after a restart, and completes`, async () => {
      const first = await interruptedFirstLife(profile);
      const wire = join(dir, `wire-2-${profile}.ndjson`);
      const outcome = await resumeInSecondLife(profile, wire);

      expect(outcome.strategy).toBe(strategy);
      expect(outcome.status).toBe('completed');

      const methods = wireMethods(wire);
      if (strategy === 'ResumeNative') {
        // The stored session id, and no new session: that is the whole
        // token-cost optimisation.
        expect(methods).toContain('session/resume');
        expect(methods).not.toContain('session/new');
        const resumed = wireFrames(wire).find((frame) => frame.method === 'session/resume');
        expect((resumed?.params as { sessionId?: string }).sessionId).toBe(first.sessionId);
      } else {
        expect(methods).not.toContain('session/resume');
        expect(methods).toContain('session/new');
      }
      // `session/load` is never a substitute, on either path (AC6).
      expect(methods).not.toContain('session/load');

      // One completion for the attempt, written by the life that finished it.
      const completions = ledger.events().filter((event) => event.kind === 'node.completed');
      expect(completions).toHaveLength(1);
      // The packet is *read* on resume, never rebuilt: a second context.built
      // would mean the replay invented a prompt rather than recovering one.
      expect(ledger.events().filter((event) => event.kind === 'context.built')).toHaveLength(1);
    });
  }
});

suite('ResumeNative does not re-send the context packet (AC2)', () => {
  it('prompts without the pinned spec segment, and records that it resumed natively', async () => {
    await interruptedFirstLife('claude');
    const wire = join(dir, 'wire-2-native.ndjson');
    const outcome = await resumeInSecondLife('claude', wire);
    expect(outcome.status).toBe('completed');

    const prompt = wireFrames(wire).find((frame) => frame.method === 'session/prompt');
    const sent = JSON.stringify(prompt?.params ?? {});
    expect(sent).not.toContain(RESUME_SEGMENTS[0]?.text as string);
    expect(sent).not.toContain(RESUME_SEGMENTS[2]?.text as string);

    const resumeRow = ledger
      .events()
      .find((event) => event.kind === 'node.progress' && event.payload.phase === 'resume.native');
    expect(resumeRow).toBeDefined();
  });
});

suite('ResumeByReplay reconstructs the packet from the ledger alone (AC3)', () => {
  it('sends bytes identical to the ones context.built recorded', async () => {
    const first = await interruptedFirstLife('gemini');
    const wire = join(dir, 'wire-2-replay.ndjson');
    const outcome = await resumeInSecondLife('gemini', wire);
    expect(outcome.status).toBe('completed');

    const prompt = wireFrames(wire).find((frame) => frame.method === 'session/prompt');
    const blocks = (prompt?.params as { prompt?: { type: string; text?: string }[] }).prompt ?? [];
    expect(blocks.map((block) => block.text).join('')).toBe(first.prompt);

    const resumeRow = ledger
      .events()
      .find((event) => event.kind === 'node.progress' && event.payload.phase === 'resume.replay');
    expect(resumeRow).toBeDefined();
  });
});

suite('the same outcome, a different token cost (AC4)', () => {
  it('records fewer input tokens for a native resume than for a replay', async () => {
    await interruptedFirstLife('claude');
    const native = await resumeInSecondLife('claude', join(dir, 'wire-native-cost.ndjson'));
    const nativeUsage = eventOf(ledger.events(), 'budget.consumed');
    expect(native.status).toBe('completed');

    // A second, independent run of the same story on a provider that cannot
    // resume — same scripted agent behaviour, same node, different strategy.
    ledger.close();
    await removeTempDir(dir);
    dir = await makeTempDir();
    worktree = join(dir, 'wt', 'n1');
    await mkdir(worktree, { recursive: true });
    ledger = openTestLedger(dir);

    await interruptedFirstLife('gemini');
    const replay = await resumeInSecondLife('gemini', join(dir, 'wire-replay-cost.ndjson'));
    const replayUsage = eventOf(ledger.events(), 'budget.consumed');
    expect(replay.status).toBe('completed');

    const nativeIn = (nativeUsage?.usage as { inputTokens: number }).inputTokens;
    const replayIn = (replayUsage?.usage as { inputTokens: number }).inputTokens;
    expect(nativeIn).toBeLessThan(replayIn);
    // Both strategies produced the same observable outcome; only the cost
    // differs, and the cost is in the ledger rather than inferred.
    expect(native.status).toBe(replay.status);
  });
});

suite('the resumed node spawns exactly one agent per daemon life', () => {
  it('leaves one invocation from each life in the side-effect log', async () => {
    const log = join(dir, 'side-effects.ndjson');
    process.env.DeFlow_SIDE_EFFECT_LOG = log;
    try {
      await interruptedFirstLife('gemini');
      const outcome = await resumeInSecondLife('gemini', join(dir, 'wire-2-count.ndjson'));
      expect(outcome.status).toBe('completed');

      const lines = (await readFile(log, 'utf8')).split('\n').filter((line) => line.trim() !== '');
      // Two invocations, one per life. The node had *not* completed when the
      // daemon died, so re-invoking the agent is the correct behaviour;
      // memoising a node that *did* complete is EPIC-06's scheduler, not this
      // adapter's business.
      expect(lines).toHaveLength(2);
    } finally {
      delete process.env.DeFlow_SIDE_EFFECT_LOG;
    }
  });
});
