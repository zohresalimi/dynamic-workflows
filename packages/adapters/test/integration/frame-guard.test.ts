/**
 * EPIC-05-S13, EPIC-05-S14 — the 8 MiB frame guard, driven by a real agent
 * over a real pipe.
 *
 * Integration and not unit, because the claim is about a **subprocess**: the
 * counter is pure logic and is unit-tested next to it, but "the session is
 * aborted, the process group is killed and nothing is left running" is only
 * true of a real child. `packages/adapters/src/frame-guard.test.ts` owns the
 * arithmetic; this file owns the consequences.
 *
 * The stimulus is the mock agent's `hugeLine` and `noNewline` scenarios
 * (KAR-04.3), which write **raw** bytes outside `acp.ndJsonStream` — a mock
 * that could only emit valid framed ACP could not produce this stimulus at all.
 *
 * Verifies: EPIC-05-S13, EPIC-05-S14 · AC1, AC3
 */

import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { DEFAULT_MAX_FRAME_BYTES, FRAME_EVIDENCE_BYTES, runAcpNode } from '../../src/index.ts';
import {
  eventOf,
  liveInGroup,
  mockAgentBinary,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  readEvidence,
  type TestLedger,
} from './support/harness.ts';

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

async function scenarioFile(name: string, steps: unknown[]): Promise<string> {
  const path = join(dir, `${name}.json`);
  await writeFile(path, JSON.stringify({ name, steps, stopReason: 'end_turn' }));
  return path;
}

const turn = async (scenario: string, maxFrameBytes?: number): ReturnType<typeof runAcpNode> =>
  runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: 'read',
      worktree,
      binary: mockAgentBinary(),
      argv: ['--seed', '7', '--scenario', scenario],
      mcpServers: [],
      prompt: 'write me something enormous',
    },
    {
      clock: new TestClock(),
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      ...(maxFrameBytes === undefined ? {} : { maxFrameBytes }),
    },
  );

suite('a single 10 MB line trips the 8 MiB cap (EPIC-05-S13)', () => {
  it('aborts the session, kills the group and keeps 4 KiB of the offending frame', async () => {
    const scenario = await scenarioFile('huge', [
      { type: 'hugeLine', totalBytes: 10 * 1024 * 1024, chunkBytes: 64 * 1024 },
    ]);

    const baseline = process.memoryUsage().rss;
    const outcome = await turn(scenario);

    if (outcome.status !== 'failed') throw new Error(`expected a failure, got ${outcome.status}`);
    expect(outcome.failure.reason).toBe('adapter.frame-too-large');
    expect(outcome.failure.class).toBe('permanent');

    // The guard fired *at* the cap, not after the agent finished writing 10 MB:
    // the count is one read window past the limit at most, which is the whole
    // point of counting upstream of the SDK's line buffer.
    expect(outcome.failure.detail?.bytes).toBeGreaterThan(DEFAULT_MAX_FRAME_BYTES);
    expect(outcome.failure.detail?.bytes).toBeLessThan(DEFAULT_MAX_FRAME_BYTES + 1024 * 1024);

    // AC1: the first 4096 bytes of the offending frame, resolvable as a handle.
    const evidence = outcome.failure.evidence.map((handle) => readEvidence(dir, handle));
    expect(evidence.some((bytes) => bytes.byteLength === FRAME_EVIDENCE_BYTES)).toBe(true);
    const head = evidence.find((bytes) => bytes.byteLength === FRAME_EVIDENCE_BYTES) as Uint8Array;
    expect(Buffer.from(head).toString('utf8')).toContain('"method":"session/update"');

    // …and the ledger says the same thing, which is what a human reads back.
    const failed = eventOf(ledger.events(), 'node.failed');
    expect((failed?.failure as { reason: string } | undefined)?.reason).toBe(
      'adapter.frame-too-large',
    );

    // No recovery was attempted: nothing after the abort, and nothing alive.
    expect(ledger.events().at(-1)?.kind).toBe('node.failed');
    expect(liveInGroup(outcome.pgid)).toEqual([]);

    // The daemon never held the 10 MB. A generous bound on purpose — V8 does
    // not collect over a window this short, so RSS tracks allocation churn as
    // well as retention — but 10 MB accumulated in a line buffer and then
    // copied would clear it.
    expect(process.memoryUsage().rss - baseline).toBeLessThan(64 * 1024 * 1024);
  });
});

suite('a wedged agent that never emits a newline (EPIC-05-S14)', () => {
  it('trips on bytes since the last newline, not on a completed frame', async () => {
    // 64 KiB every 10 ms with no `0x0a`, for ever: `totalBytes` is omitted, and
    // omitted means the flood never ends. This is the case a cap on *completed
    // frames* cannot see, because this agent never completes one.
    const scenario = await scenarioFile('wedged', [
      { type: 'noNewline', chunkBytes: 64 * 1024, intervalMs: 10 },
    ]);

    const started = performance.now();
    const outcome = await turn(scenario);
    const elapsed = performance.now() - started;

    if (outcome.status !== 'failed') throw new Error(`expected a failure, got ${outcome.status}`);
    expect(outcome.failure.reason).toBe('adapter.frame-too-large');
    expect(outcome.failure.detail?.bytes).toBeGreaterThan(DEFAULT_MAX_FRAME_BYTES);
    // Zero complete frames ever reached the SDK's LineBuffer, so no progress
    // event for this attempt names one.
    expect(
      ledger.events().filter((event) => event.payload.phase === 'agent_message_chunk'),
    ).toEqual([]);
    expect(liveInGroup(outcome.pgid)).toEqual([]);
    // 128 chunks at 10 ms is 1.3 s of writing; the guard has to fire on the
    // chunk that crosses the cap rather than at some later checkpoint.
    expect(elapsed).toBeLessThan(3_000);
  });

  it('never fires on 6 MiB, a newline, and another 6 MiB', async () => {
    const scenario = await scenarioFile('two-large-frames', [
      { type: 'hugeLine', totalBytes: 6 * 1024 * 1024, chunkBytes: 64 * 1024 },
      { type: 'hugeLine', totalBytes: 6 * 1024 * 1024, chunkBytes: 64 * 1024 },
    ]);

    const outcome = await turn(scenario);

    expect(outcome.status).toBe('completed');
    // Two frames delivered, which is what proves the counter resets: 12 MiB
    // total is well over the cap and neither line is.
    expect(
      ledger.events().filter((event) => event.payload.phase === 'agent_message_chunk'),
    ).toHaveLength(2);
  }, 60_000);
});

suite('the cap boundary, from both sides (EPIC-05-S15)', () => {
  // Off-by-one on a cap like this rejects a legal frame from a real vendor,
  // which looks exactly like adapter breakage and sends you hunting in the
  // wrong place. `lineBytes` sizes the *whole line*, framing included, because
  // the framing's length depends on a session id only the agent knows.
  it.each([DEFAULT_MAX_FRAME_BYTES - 1, DEFAULT_MAX_FRAME_BYTES])(
    'delivers and parses a line of exactly %i bytes',
    async (lineBytes) => {
      const scenario = await scenarioFile(`line-${lineBytes}`, [
        { type: 'hugeLine', lineBytes, chunkBytes: 64 * 1024 },
      ]);

      const outcome = await turn(scenario);

      expect(outcome.status).toBe('completed');
      const chunks = ledger
        .events()
        .filter((event) => event.payload.phase === 'agent_message_chunk');
      expect(chunks).toHaveLength(1);
      // Delivered *intact*: the frame parsed, and the whole line is in the data
      // plane byte for byte.
      const [frame] = ledger.chunks();
      expect(frame?.text.trimEnd().length).toBeGreaterThanOrEqual(lineBytes - 200);
    },
    60_000,
  );

  it('aborts on a line one byte over the cap', async () => {
    const scenario = await scenarioFile('line-over', [
      { type: 'hugeLine', lineBytes: DEFAULT_MAX_FRAME_BYTES + 1, chunkBytes: 64 * 1024 },
    ]);

    const outcome = await turn(scenario);

    if (outcome.status !== 'failed') throw new Error(`expected a failure, got ${outcome.status}`);
    expect(outcome.failure.reason).toBe('adapter.frame-too-large');
    expect(outcome.failure.detail?.bytes).toBe(DEFAULT_MAX_FRAME_BYTES + 1);
  });
});

suite('the cap is configurable', () => {
  it('refuses an impossible cap as a filed failure, before anything is spawned', async () => {
    // A cap of 0 rejects the handshake itself, so it is a misconfiguration of
    // DeFlow rather than a fact about the agent. It still has to arrive as a
    // `NodeFailure` in the ledger: nothing leaves `runAcpNode` as a throw, or
    // the scheduler above it has an exception where it expected an outcome.
    const scenario = await scenarioFile('never-runs', [{ type: 'message', text: 'hello' }]);

    const outcome = await turn(scenario, 0);

    if (outcome.status !== 'failed') throw new Error(`expected a failure, got ${outcome.status}`);
    expect(outcome.failure.reason).toBe('internal');
    expect(outcome.failure.class).toBe('permanent');
    // Nothing was spawned: the refusal happened before the process existed.
    expect(outcome.pgid).toBe(0);
    expect(outcome.exit).toBeNull();
    expect(ledger.events().map((event) => event.kind)).toEqual(['node.scheduled', 'node.failed']);
  });

  // 64 bytes is below the size of the agent's own `initialize` response, so
  // this also asserts the guard covers the handshake — the abort has to
  // propagate from outside the `nextUpdate()` loop, which is a different code
  // path from every other spec in this file.
  it('fires at a limit the run lowered, even before the first prompt', async () => {
    const scenario = await scenarioFile('small-cap', [
      {
        type: 'message',
        text: 'this line is longer than sixty-four bytes and will not survive it',
      },
    ]);

    const outcome = await turn(scenario, 64);

    if (outcome.status !== 'failed') throw new Error(`expected a failure, got ${outcome.status}`);
    expect(outcome.failure.reason).toBe('adapter.frame-too-large');
    expect(outcome.failure.detail?.limit).toBe(64);
  });
});
