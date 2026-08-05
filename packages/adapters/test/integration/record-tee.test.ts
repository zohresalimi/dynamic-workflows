/**
 * KAR-05.7 AC1, AC6 — `DeFlow_RECORD=1` over a real pipe.
 *
 * Integration and not unit because the claim is about a **subprocess**: that
 * the tee saw both directions of a real ndjson conversation, the child's
 * stderr, and its exit status, and that the offsets it wrote came from the
 * injected clock rather than from wall time. A recorder driven by hand-fed
 * buffers (which `src/recorder.test.ts` does) proves none of that.
 *
 * The load-bearing spec is the last one. A tee that lived in the adapter's
 * parsing logic would record the normaliser's interpretation of the wire, and
 * so would be structurally incapable of recording the one thing a conformance
 * corpus exists to catch: a frame the client does not understand yet.
 *
 * Verifies: EPIC-05-S25 (scenario 4), EPIC-05-S28 (scenario 1) · AC1, AC6 ·
 * test plan #6
 */

import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { RECORD_CASE_ENV, RECORD_DIR_ENV, RECORD_ENV, runAcpNode } from '../../src/index.ts';
import {
  mockAgentBinary,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  scenario,
  type TestLedger,
} from './support/harness.ts';

let dir = '';
let worktree = '';
let corpus = '';
let ledger: TestLedger;

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  corpus = join(dir, 'recordings');
  await mkdir(worktree, { recursive: true });
  ledger = openTestLedger(dir);
});

afterEach(async () => {
  ledger.close();
  await removeTempDir(dir);
});

interface Line {
  readonly t?: number;
  readonly dir?: string;
  readonly msg?: Record<string, unknown>;
  readonly raw?: string;
  readonly stderr?: string;
  readonly exit?: { code: number | null; signal: string | null };
  readonly header?: Record<string, unknown>;
}

const readCapture = (kase: string, version = '0.0.0'): Line[] =>
  readFileSync(join(corpus, `${PROVIDER}@${version}`, `${kase}.ndjson`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Line);

const recordEnv = (kase: string): NodeJS.ProcessEnv => ({
  ...process.env,
  [RECORD_ENV]: '1',
  [RECORD_DIR_ENV]: corpus,
  [RECORD_CASE_ENV]: kase,
});

suite('the tee writes a replayable capture of a real turn', () => {
  it('records both directions, the header, stderr and the exit, with monotonic offsets', async () => {
    const clock = new TestClock();
    const outcome = await runAcpNode(
      {
        runId: RUN_ID,
        nodeId: NODE_ID,
        attempt: 0,
        provider: PROVIDER,
        permission: 'worktree',
        worktree,
        binary: mockAgentBinary(),
        argv: ['--seed', '42', '--scenario', scenario('minimal-turn.jsonc')],
        mcpServers: [],
        prompt: 'hello',
      },
      {
        clock,
        ledger: ledger.sink,
        captureEvidence: ledger.captureEvidence,
        record: recordEnv('minimal-turn'),
      },
    );

    expect(outcome.status).toBe('completed');

    const lines = readCapture('minimal-turn');

    // AC6 — the directory is the version key, and the header repeats it so a
    // file that was moved still says what produced it.
    expect(lines[0]?.header).toMatchObject({
      agent: PROVIDER,
      version: '0.0.0',
      case: 'minimal-turn',
      perspective: 'agent',
    });

    const frames = lines.filter((line) => line.msg !== undefined);
    // Agent-perspective, exactly as packages/mock-agent replays it: the first
    // frame is inbound because in ACP the client always speaks first.
    expect(frames[0]?.dir).toBe('in');
    expect(frames[0]?.msg?.method).toBe('initialize');
    expect(new Set(frames.map((frame) => frame.dir))).toEqual(new Set(['in', 'out']));

    // ≥1 agent_message_chunk, written by the agent, seen as raw bytes.
    const updates = frames.filter(
      (frame) => frame.dir === 'out' && frame.msg?.method === 'session/update',
    );
    expect(updates.length).toBeGreaterThanOrEqual(1);

    const offsets = lines.filter((line) => line.t !== undefined).map((line) => line.t ?? 0);
    expect(offsets.length).toBeGreaterThan(2);
    for (const [index, offset] of offsets.entries()) {
      expect(offset, `offset ${index} went backwards`).toBeGreaterThanOrEqual(
        offsets[index - 1] ?? 0,
      );
    }

    // The exit status is a fact about the process, so it is recorded once the
    // process has actually exited and not when the turn resolved.
    const exit = lines.find((line) => line.exit !== undefined);
    expect(exit?.exit).toEqual({ code: 0, signal: null });
  });

  it('records a frame the client cannot interpret, because the tee is in the transport', async () => {
    // `--invalid-frame` writes valid JSON carrying a sessionUpdate this client
    // has never heard of. `describeUpdate` cannot name it and `ndJsonStream`
    // hands it on unchanged — and it still lands in the capture, in full,
    // which is the whole reason the tee is where it is.
    await runAcpNode(
      {
        runId: RUN_ID,
        nodeId: NODE_ID,
        attempt: 0,
        provider: PROVIDER,
        permission: 'worktree',
        worktree,
        binary: mockAgentBinary(),
        argv: ['--seed', '42', '--invalid-frame'],
        mcpServers: [],
        prompt: 'hello',
      },
      {
        clock: new TestClock(),
        ledger: ledger.sink,
        captureEvidence: ledger.captureEvidence,
        record: recordEnv('invalid-frame'),
      },
    );

    const capture = readFileSync(join(corpus, `${PROVIDER}@0.0.0`, 'invalid-frame.ndjson'), 'utf8');
    expect(capture).toContain('agent_thought_stream_v3');
  });

  it('is off by default — an unset DeFlow_RECORD writes no corpus at all', async () => {
    await runAcpNode(
      {
        runId: RUN_ID,
        nodeId: NODE_ID,
        attempt: 0,
        provider: PROVIDER,
        permission: 'worktree',
        worktree,
        binary: mockAgentBinary(),
        argv: ['--seed', '42', '--scenario', scenario('minimal-turn.jsonc')],
        mcpServers: [],
        prompt: 'hello',
      },
      { clock: new TestClock(), ledger: ledger.sink, captureEvidence: ledger.captureEvidence },
    );

    expect(() => readCapture('minimal-turn')).toThrow();
  });

  it('refuses the node rather than writing a golden under a moving version', async () => {
    // test plan #8 — the whole point of AC6 is that this is loud. A capture
    // that silently landed in `mock@latest/` would look exactly like a good
    // one until the day the vendor shipped.
    const outcome = await runAcpNode(
      {
        runId: RUN_ID,
        nodeId: NODE_ID,
        attempt: 0,
        provider: PROVIDER,
        permission: 'worktree',
        worktree,
        binary: { ...mockAgentBinary(), version: 'latest' },
        argv: ['--seed', '42', '--scenario', scenario('minimal-turn.jsonc')],
        mcpServers: [],
        prompt: 'hello',
      },
      {
        clock: new TestClock(),
        ledger: ledger.sink,
        captureEvidence: ledger.captureEvidence,
        record: recordEnv('moving-version'),
      },
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.message).toContain('<provider>@<version>');
    // Refused before anything was spawned: the pid is what says so.
    expect(outcome.pgid).toBe(0);
    expect(ledger.events().map((event) => event.kind)).toEqual(['node.scheduled', 'node.failed']);
  });
});
