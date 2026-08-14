/**
 * KAR-05.7 AC7 — both layers of assertion, on a recording the tee just wrote.
 *
 * `test/recordings-conformance.test.ts` runs the same two layers over the
 * committed vendor corpus, offline and without a subprocess. This file closes
 * the loop the other way: a **real** turn against a real child process, teed at
 * the transport, and then held to the same two standards. It is the spec that
 * says the tee produces a recording the rest of the machinery can actually
 * read — that the format it writes and the format Layer A and
 * `deflow-mock-agent --replay` expect are one format and not three.
 *
 * It is also test plan row 2: the mock agent's own emitted frames must
 * validate against `schema.json`. A mock that could emit a frame no real agent
 * could would be an oracle that certifies DeFlow against a protocol nobody
 * speaks, and every conformance result taken against it would be worthless.
 *
 * Verifies: EPIC-05-S25 (scenario 3), EPIC-05-S28 (scenario 3) · AC7 ·
 * test plan #2
 */

import { parseRecording } from '@DeFlow/mock-agent';
import {
  describeViolations,
  makeTempDir,
  readCapturedFrames,
  removeTempDir,
  TestClock,
  validateAcpFrames,
} from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  describeUpdate,
  RECORD_CASE_ENV,
  RECORD_DIR_ENV,
  RECORD_ENV,
  runAcpNode,
} from '../../src/index.ts';
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

const CASE = 'tool-call-statuses';

/** One recorded turn, at a fixed seed, through the tee. */
async function recordATurn(): Promise<string> {
  const outcome = await runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: 'worktree',
      worktree,
      binary: mockAgentBinary(),
      argv: ['--seed', '42', '--scenario', scenario('tool-call-statuses.jsonc')],
      mcpServers: [],
      prompt: 'record a turn',
    },
    {
      clock: new TestClock(),
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      record: {
        ...process.env,
        [RECORD_ENV]: '1',
        [RECORD_DIR_ENV]: corpus,
        [RECORD_CASE_ENV]: CASE,
      },
    },
  );
  expect(outcome.status).toBe('completed');
  return join(corpus, `${PROVIDER}@0.0.0`, `${CASE}.ndjson`);
}

suite('Layer A over a recording the transport just wrote', () => {
  it('validates every frame the mock emitted — it cannot invent a frame', async () => {
    const path = await recordATurn();
    const frames = readCapturedFrames(readFileSync(path, 'utf8'), path);

    expect(frames.length).toBeGreaterThan(4);
    expect(describeViolations(validateAcpFrames(frames))).toBe('');
  });

  it('recorded what the client sent as well as what the agent answered', async () => {
    const path = await recordATurn();
    const frames = readCapturedFrames(readFileSync(path, 'utf8'), path);
    const methods = frames
      .filter((frame) => frame.dir === 'in')
      .map((frame) => frame.msg?.['method']);
    expect(methods).toContain('initialize');
    expect(methods).toContain('session/new');
    expect(methods).toContain('session/prompt');
  });
});

suite('AC7 — and the normalised vocabulary of the same recording', () => {
  it('snapshots the DeFlow event vocabulary through the normalising serializer', async () => {
    const path = await recordATurn();
    const vocabulary = readCapturedFrames(readFileSync(path, 'utf8'), path)
      .filter((frame) => frame.dir === 'out' && frame.msg?.['method'] === 'session/update')
      .map((frame) => describeUpdate((frame.msg?.['params'] as { update: never }).update));

    expect(vocabulary.length).toBeGreaterThan(0);
    expect(vocabulary).toMatchSnapshot();
  });

  it('agrees with what the ledger recorded for the same turn', async () => {
    // The two layers are complementary only if they are looking at the same
    // turn from opposite ends: the recording is the bytes, the ledger is what
    // DeFlow made of them, and a divergence means the normaliser and the tee
    // are not seeing the same session.
    const path = await recordATurn();
    const recorded = readCapturedFrames(readFileSync(path, 'utf8'), path)
      .filter((frame) => frame.dir === 'out' && frame.msg?.['method'] === 'session/update')
      .map((frame) => describeUpdate((frame.msg?.['params'] as { update: never }).update).phase);

    const durable = ledger
      .events()
      .filter((event) => event.kind === 'node.progress')
      .map((event) => (event.payload as { phase: string }).phase)
      .filter((phase) => phase !== 'session.opened');

    expect(durable).toEqual(recorded);
  });
});

suite('the tee writes a file the replay engine can serve', () => {
  it('parses as an agent-perspective replay recording, first frame inbound', async () => {
    // The payoff of flipping the direction labels once, in the tee: no
    // conversion step stands between a capture and a replay of it.
    const path = await recordATurn();
    const parsed = parseRecording(readFileSync(path, 'utf8'), path);

    expect(parsed.ok, parsed.ok ? '' : parsed.message).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frames[0]?.dir).toBe('in');
    expect(parsed.frames[0]?.msg['method']).toBe('initialize');
    expect(parsed.header).toMatchObject({ perspective: 'agent', version: '0.0.0' });
    // The stderr and exit lines are facts about the process, not frames: the
    // replay parser skips them rather than choking on them.
    expect(parsed.frames.every((frame) => frame.dir === 'in' || frame.dir === 'out')).toBe(true);
  });
});
