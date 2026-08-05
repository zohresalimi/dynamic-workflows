/**
 * EPIC-05-S16, EPIC-05-S17 — a tool result too large for the control plane
 * goes to the content-addressed blob store, and identical results across
 * retries are one object on disk.
 *
 * **Replay time is a function of event-log size, and un-spilled tool output is
 * what makes it explode** (F4.2, NF3). `event` is append-only and is re-read in
 * full by every daemon start for the life of the run, so a 300 KiB tool result
 * written into it is permanent *and* recurring cost. The rule the ledger states
 * (`io_chunk`'s module doc, rule 3) is that a `node.progress` row may **point
 * at** the output and never carry it — so what this file asserts is that the
 * adapter keeps the row small, keeps the bytes, and keeps them exactly once.
 *
 * Integration, over a real subprocess and a real directory: the shard layout,
 * the atomic rename and "one file, not three" are filesystem properties, and
 * KAR-03.9's unit-level coverage of the store cannot say whether the *adapter*
 * reaches it.
 *
 * Verifies: EPIC-05-S16, EPIC-05-S17 · AC5, AC6 · test plan #6, #7
 */

import { canonicalJson, type Handle } from '@DeFlow/core';
import { BLOB_DIR, blobPath } from '@DeFlow/ledger';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { CONTENT_SPILL_BYTES, runAcpNode } from '../../src/index.ts';
import {
  mockAgentBinary,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
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

/** Every file under `<dataDir>/blobs/`, relative to it. Absent reads as none. */
function blobFiles(dir_: string, at = join(dir_, BLOB_DIR), prefix = ''): string[] {
  if (!existsSync(at)) return [];
  let found: string[] = [];
  for (const entry of readdirSync(at, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : 1,
  )) {
    const full = join(at, entry.name);
    found = entry.isDirectory()
      ? [...found, ...blobFiles(dir_, full, `${prefix}${entry.name}/`)]
      : [...found, `${prefix}${entry.name}`];
  }
  return found;
}

/** A turn whose one tool call reports `contentBytes` of generated output. */
async function toolCallScenario(name: string, contentBytes: number): Promise<string> {
  const path = join(dir, `${name}.json`);
  await writeFile(
    path,
    JSON.stringify({
      name,
      steps: [
        {
          type: 'toolCall',
          title: 'run the test suite',
          toolKind: 'execute',
          path: join(worktree, 'package.json'),
          statuses: ['pending', 'completed'],
          contentBytes,
        },
      ],
      stopReason: 'end_turn',
    }),
  );
  return path;
}

const runAttempt = async (scenario: string, attempt = 0): ReturnType<typeof runAcpNode> =>
  runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt,
      provider: PROVIDER,
      permission: 'read',
      worktree,
      binary: mockAgentBinary(),
      argv: ['--seed', '7', '--scenario', scenario],
      mcpServers: [],
      prompt: 'run the tests',
    },
    { clock: new TestClock(), ledger: ledger.sink, captureEvidence: ledger.captureEvidence },
  );

/** The encoded size of every event row's payload, which is what replay pays. */
const payloadBytes = (): number[] =>
  ledger.events().map((event) => Buffer.byteLength(canonicalJson(event.payload), 'utf8'));

/**
 * The artifacts one attempt's `node.completed` recorded. Selected **by
 * attempt** rather than by taking the first row: three attempts of the same
 * node write three completions, and a helper that always read the first would
 * agree with itself no matter what attempts 2 and 3 actually did.
 */
const artifactsOf = (attempt = 0): Handle[] => {
  const completed = ledger
    .events()
    .find((event) => event.kind === 'node.completed' && event.payload.attempt === attempt);
  const result = completed?.payload.result as { artifacts?: Handle[] } | undefined;
  return result?.artifacts ?? [];
};

suite('a 300 KiB tool result spills (EPIC-05-S16)', () => {
  it('keeps the event row tiny and the bytes on disk under their own digest', async () => {
    const outcome = await runAttempt(await toolCallScenario('big-tool', 300 * 1024));
    expect(outcome.status).toBe('completed');

    // The control plane stays cheap: no row anywhere near the 256 KiB ceiling,
    // and none over the ~4 KiB the test plan names.
    expect(Math.max(...payloadBytes())).toBeLessThan(4 * 1024);

    // The bytes are kept, at the path their content determines.
    const [handle] = artifactsOf();
    expect(handle).toMatch(/^artifact:\/\/[0-9a-f]{64}$/);
    const sha256 = (handle ?? '').slice('artifact://'.length);
    expect(blobFiles(dir)).toEqual([`${sha256.slice(0, 2)}/${sha256}`]);

    const stored = readFileSync(blobPath(dir, sha256));
    expect(stored.byteLength).toBe(300 * 1024);
    expect(createHash('sha256').update(stored).digest('hex')).toBe(sha256);

    // …and the progress row points at it rather than carrying it.
    const progress = ledger
      .events()
      .filter((event) => event.payload.phase === 'tool_call_update')
      .map((event) => String(event.payload.message ?? ''));
    expect(progress.some((message) => message.includes(sha256))).toBe(true);

    // The raw frame is still in the data plane, verbatim: the reducer never
    // reads io_chunk, so a replay pays for none of this.
    expect(ledger.chunks().some((chunk) => chunk.text.length > 300 * 1024)).toBe(true);
  }, 60_000);

  it('leaves a 100 KiB result inline, with no blob at all', async () => {
    const outcome = await runAttempt(await toolCallScenario('small-tool', 100 * 1024));

    expect(outcome.status).toBe('completed');
    expect(blobFiles(dir)).toEqual([]);
    expect(artifactsOf()).toEqual([]);
  }, 60_000);

  it('spills at the threshold the domain model states, and not before', () => {
    expect(CONTENT_SPILL_BYTES).toBe(256 * 1024);
  });
});

suite('identical output across three attempts deduplicates (EPIC-05-S17)', () => {
  it('writes one file and references it from all three attempts', async () => {
    const scenario = await toolCallScenario('retry-log', 400 * 1024);
    const handles: Handle[] = [];

    // Three attempts of the same node, which is what a repair loop does. The
    // mock's output is a function of the requested size alone, so all three
    // capture the byte-identical failing test log — the common real case.
    for (const attempt of [0, 1, 2]) {
      const outcome = await runAttempt(scenario, attempt);
      expect(outcome.status).toBe('completed');
      handles.push(...artifactsOf(attempt));
    }

    const completed = ledger.events().filter((event) => event.kind === 'node.completed');
    expect(completed).toHaveLength(3);
    expect(new Set(handles).size).toBe(1);
    expect(handles).toHaveLength(3);

    // One object on disk, ~400 KiB rather than ~1.2 MB.
    const files = blobFiles(dir);
    expect(files).toHaveLength(1);
    const sha256 = (handles[0] ?? '').slice('artifact://'.length);
    expect(readFileSync(blobPath(dir, sha256)).byteLength).toBe(400 * 1024);
  }, 90_000);

  it('writes a second file when the third attempt differs by one byte', async () => {
    const same = await toolCallScenario('same-log', 400 * 1024);
    // The generated payload is a prefix of itself at the next size, so this is
    // literally the same log with one more byte on the end.
    const different = await toolCallScenario('longer-log', 400 * 1024 + 1);

    await runAttempt(same, 0);
    await runAttempt(same, 1);
    await runAttempt(different, 2);

    expect(blobFiles(dir)).toHaveLength(2);
    const completed = ledger.events().filter((event) => event.kind === 'node.completed');
    const digests = completed.map((event) =>
      ((event.payload.result as { artifacts: string[] }).artifacts[0] ?? '').slice(11),
    );
    expect(digests[0]).toBe(digests[1]);
    expect(digests[2]).not.toBe(digests[0]);
  }, 90_000);
});
