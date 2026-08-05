/**
 * EPIC-05-S3 — the pull loop awaits the durable append before asking for more.
 *
 * This is the single most important API detail in the layer.
 * `session.nextUpdate()` is a pull loop, not a callback registration, and the
 * difference is load-bearing twice: it is the only legal place to `await` the
 * SQLite append, and — with a transport that only reads when the loop is ready
 * — it is what makes the OS pipe, rather than the daemon's heap, the place a
 * fast agent's output waits.
 *
 * The second scenario is the one that catches flowing mode. With `.on('data')`
 * plus an `async` handler you are in flowing mode with an unbounded in-memory
 * queue, and Node will happily buffer hundreds of megabytes while you await
 * SQLite. Here the assertion is quantitative: the reader is never more than a
 * pipe's worth of bytes ahead of the durable writes, which is only possible if
 * the child is blocking in `write()`.
 *
 * Verifies: EPIC-05-S3 · AC4 · test plan #4, #5
 */

import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import type { EventRecord, IoRecord, LedgerSink } from '../../src/index.ts';
import { runAcpNode } from '../../src/index.ts';
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

/** A scenario that floods `count` chunks with no scripted delay, so the only
 * thing pacing the turn is the consumer. */
async function floodScenario(count: number, sizeBytes?: number): Promise<string> {
  const path = join(dir, `flood-${count}.json`);
  await writeFile(
    path,
    JSON.stringify({
      name: `flood-${count}`,
      steps: [
        {
          type: 'chunks',
          count,
          delayMs: 0,
          text: 'flood',
          ...(sizeBytes === undefined ? {} : { sizeBytes }),
        },
      ],
      stopReason: 'end_turn',
    }),
  );
  return path;
}

/** The append port, instrumented: a real delay per write, and a record of when
 * each one started and finished. */
function instrumented(
  sink: LedgerSink,
  delayMs: number,
): {
  readonly sink: LedgerSink;
  readonly finished: number[];
  bytesAppended(): number;
} {
  const finished: number[] = [];
  let bytes = 0;
  const wait = (): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    });

  return {
    finished,
    bytesAppended: () => bytes,
    sink: {
      async append(event: EventRecord) {
        await wait();
        const seq = await sink.append(event);
        finished.push(performance.now());
        return seq;
      },
      async appendIo(chunk: IoRecord) {
        await wait();
        bytes += chunk.data.byteLength;
        return sink.appendIo(chunk);
      },
    },
  };
}

suite('the next frame is not requested until the append resolves', () => {
  it('interleaves 50 chunks strictly: pull n+1 happens after append n', async () => {
    const writes = instrumented(ledger.sink, 5);
    const pulls: number[] = [];

    const outcome = await runAcpNode(
      {
        runId: RUN_ID,
        nodeId: NODE_ID,
        attempt: 0,
        provider: PROVIDER,
        permission: 'read',
        worktree,
        binary: mockAgentBinary(),
        argv: ['--seed', '7', '--scenario', await floodScenario(50)],
        mcpServers: [],
        prompt: 'flood me',
      },
      {
        clock: new TestClock(),
        ledger: writes.sink,
        captureEvidence: ledger.captureEvidence,
        onPull: () => pulls.push(performance.now()),
      },
    );

    expect(outcome.status).toBe('completed');

    const chunkEvents = ledger
      .events()
      .filter((event) => event.payload.phase === 'agent_message_chunk');
    expect(chunkEvents).toHaveLength(50);

    // Exactly once, in emission order. The mock numbers its own chunks, so
    // this compares what the agent sent with what the ledger kept.
    expect(chunkEvents.map((event) => event.payload.message)).toEqual(
      Array.from({ length: 50 }, (_unused, index) => `${index + 1}/50 flood`),
    );

    // The interleave itself: every pull after the first happens after some
    // append has already resolved, and no two pulls are separated by zero
    // completed writes.
    expect(pulls.length).toBeGreaterThanOrEqual(50);
    for (let n = 1; n < 50; n += 1) {
      expect(pulls[n]).toBeGreaterThanOrEqual(writes.finished[n - 1] as number);
    }
  });
});

suite('a slow consumer stalls the producer, it does not buffer it', () => {
  it('keeps 200 x 8 KiB out of the heap and loses none of it', async () => {
    const writes = instrumented(ledger.sink, 5);
    const readAhead: number[] = [];

    const outcome = await runAcpNode(
      {
        runId: RUN_ID,
        nodeId: NODE_ID,
        attempt: 0,
        provider: PROVIDER,
        permission: 'read',
        worktree,
        binary: mockAgentBinary(),
        argv: ['--seed', '7', '--scenario', await floodScenario(200, 8192)],
        mcpServers: [],
        prompt: 'flood me',
      },
      {
        clock: new TestClock(),
        ledger: writes.sink,
        captureEvidence: ledger.captureEvidence,
        onPull: (_pull, bytesRead) => readAhead.push(bytesRead - writes.bytesAppended()),
      },
    );

    expect(outcome.status).toBe('completed');

    const chunkEvents = ledger
      .events()
      .filter((event) => event.payload.phase === 'agent_message_chunk');
    expect(chunkEvents).toHaveLength(200);
    expect(chunkEvents.at(-1)?.payload.message).toContain('200/200');
    // One frame in the data plane per control-plane row that points at one:
    // nothing was dropped, and nothing was recorded twice.
    expect(ledger.chunks()).toHaveLength(
      ledger.events().filter((event) => event.payload.ioChunkSeq !== undefined).length,
    );

    // The retention bound, which is what EPIC-05-S3's "RSS growth < 32 MiB"
    // was a proxy for.
    //
    // RSS itself is measured here and deliberately **not** asserted on: over a
    // three-second window V8 does not collect, so RSS tracks allocation churn
    // (each frame is decoded, re-serialised and copied into a SQLite blob)
    // rather than what is *held*. It grows by tens of megabytes for a 1.6 MB
    // stream whether or not anything is buffered, which makes it an instrument
    // that cannot tell a pass from a failure. This assertion can: 200 x 8 KiB
    // is 1.6 MB, and a reader in flowing mode would have all of it in the heap
    // within milliseconds. A reader that stalls cannot get further ahead than
    // one frame plus the OS pipe, because the child is blocked in `write()`
    // for the rest of the turn — and the whole flood never exists in this
    // process at once.
    expect(Math.max(...readAhead)).toBeLessThan(256 * 1024);
    // Sanity on the instrument itself: a `readAhead` that is always zero would
    // mean the samples were not measuring the stream at all.
    expect(Math.max(...readAhead)).toBeGreaterThan(0);
  });
});
