/**
 * EPIC-04-S4 — a scripted turn arrives incrementally, over a real pipe.
 *
 * Cadence is only observable at the far end of a real subprocess: an in-process
 * double resolves the same promises in the same order and would pass this file
 * while proving nothing about whether the frames were flushed. The delays are
 * real sleeps for the same reason — docs/14-testing-strategy.md §8 forbids fake
 * timers while a child process is alive, because freezing the event loop's
 * timers stops the child's real I/O from ever being read.
 *
 * Verifies: EPIC-04-S4 · AC2 · test plan row 2
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  CLIENT_CAPABILITIES,
  connectClient,
  scenarioPath,
  spawnMockAgent,
} from '../support/harness.ts';

let cwd = '';

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'DeFlow-'));
});

afterEach(async () => {
  if (process.env.DeFlow_KEEP_TMP === undefined) await rm(cwd, { recursive: true, force: true });
});

/** The gaps between consecutive arrivals, in milliseconds. */
function gaps(arrivals: readonly number[]): number[] {
  return arrivals.slice(1).map((at, index) => at - (arrivals[index] as number));
}

suite('EPIC-04-S4 — chunks arrive one at a time, not in one burst', () => {
  it('emits a plan then five 50 ms-spaced chunks', async () => {
    const agent = spawnMockAgent([
      '--seed',
      '42',
      '--scenario',
      scenarioPath('streaming-cadence.jsonc'),
    ]);
    const { connection, updates, arrivals } = connectClient(agent);

    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await connection.agent.request('session/new', { cwd, mcpServers: [] });
    const startedAt = performance.now();
    const prompted = await connection.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'stream please' }],
    });
    const turnMs = performance.now() - startedAt;

    expect(updates[0]?.update.sessionUpdate).toBe('plan');
    const kinds = updates.map((notification) => notification.update.sessionUpdate);
    expect(kinds).toEqual([
      'plan',
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_message_chunk',
    ]);

    // "The agent slept", asserted where no scheduler can forge it: the scenario
    // sleeps 50 ms *between* chunks — four sleeps for five chunks — so the turn
    // cannot come back in under 200 ms however the reader was scheduled. A late
    // reader can only make this number bigger. 190 rather than 200 leaves a
    // millisecond per timer for a runtime that rounds a sleep down.
    expect(turnMs).toBeGreaterThanOrEqual(190);

    // Four gaps between the five chunks, and none of them the sub-millisecond
    // spacing of frames read out of one buffer. The floor is 10 ms rather than
    // the scripted 50 because arrival times are the *reader's*: descheduling
    // this process for a few milliseconds delays chunk N and leaves chunk N+1
    // already waiting in the pipe, which moves time out of one gap and into its
    // neighbour without the agent having behaved differently. That redistribution
    // is what a 39.9 ms gap next to a 60 ms one is, and it is why the "it slept"
    // half of the claim is asserted on the turn's duration above instead.
    const chunkGaps = gaps(arrivals.slice(1));
    expect(chunkGaps).toHaveLength(4);
    for (const gap of chunkGaps) expect(gap).toBeGreaterThanOrEqual(10);

    // No two chunks share an arrival instant — the failure a single
    // read()-of-everything at the end would produce.
    expect(new Set(arrivals).size).toBe(arrivals.length);

    expect(prompted.stopReason).toBe('end_turn');
    expect(await agent.finish()).toEqual({ code: 0, signal: null });
  });

  it('delivers every chunk exactly once, in order, while the consumer stalls', async () => {
    // The pull-loop scenario: 200 chunks of 8 KiB with a simulated durable
    // write between each nextUpdate(). Enforcing backpressure is EPIC-05's
    // (KAR-05.4) — what this asserts of the *stimulus* is that a slow consumer
    // loses nothing and reorders nothing, which is the property every ledger
    // append downstream depends on.
    const agent = spawnMockAgent([
      '--seed',
      '42',
      '--scenario',
      scenarioPath('streaming-backpressure.jsonc'),
    ]);
    const { connection } = connectClient(agent);

    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });

    // Sampled for a human debugging a regression, and deliberately not asserted
    // on — see the note above the `peakLead` assertion below.
    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;
    // The furthest the *harness* ever got ahead of the consumer, in bytes of
    // stream: what it had drained off the pipe, less what the consumer had
    // taken, sampled every iteration and kept at its maximum.
    let peakLead = 0;
    let consumedBytes = 0;

    const session = await connection.agent.buildSession({ cwd, mcpServers: [] }).start();
    const promptDone = session.prompt([{ type: 'text', text: 'flood me' }]);

    const texts: string[] = [];
    for (;;) {
      const message = await session.nextUpdate();
      if (message.kind === 'stop') break;
      if (message.update.sessionUpdate === 'agent_message_chunk') {
        const content = message.update.content;
        if (content.type === 'text') {
          texts.push(content.text);
          consumedBytes += content.text.length;
        }
      }
      // The simulated durable write. This is the only legal place to await a
      // SQLite append, so the loop has to survive one.
      await new Promise((resolve) => setTimeout(resolve, 5));
      peakLead = Math.max(peakLead, agent.stdout().length - consumedBytes);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }

    expect(await promptDone).toMatchObject({ stopReason: 'end_turn' });
    expect(texts).toHaveLength(200);
    // Each chunk carries its own index, so "in order, exactly once" is a
    // comparison against the sequence rather than a count.
    expect(texts.map((text) => text.slice(0, text.indexOf(' ')))).toEqual(
      Array.from({ length: 200 }, (_unused, index) => `${index + 1}/200`),
    );
    for (const text of texts) expect(text.length).toBeGreaterThanOrEqual(8 * 1024);

    // This spec used to close with `peakRss - baselineRss < 32 MiB`, on the
    // theory that unbounded RSS growth here would mean someone had reintroduced
    // flowing mode. It could never have caught that, and it flaked for the
    // reason it could never catch it.
    //
    // `spawnMockAgent` tees the child's stdout with `child.stdout.on('data')`,
    // and attaching a `data` listener *is* flowing mode: the harness drains the
    // pipe as fast as the kernel fills it, so the child is never blocked in
    // `write()` no matter what the session does — it drains the whole
    // 1,682,049-byte turn long before the consumer's 200 × 5 ms loop is done.
    // The assertion was passing because 1.6 MiB of payload cannot reach 32 MiB,
    // not because backpressure was working.
    //
    // What it measured instead was V8's heap growth over the loop's ~1 s, whose
    // run-to-run spread on identical code is wider than its own threshold:
    // 12.1, 12.7, 13.1, 15.0, 15.6, 16.1, 16.7, 17.0 MiB across isolated runs,
    // and 38.5 MiB beside a full suite — which is the red this gate opened on.
    // An assertion whose noise exceeds its budget cannot tell a pass from a
    // failure, so RSS is sampled here and not asserted on, exactly as
    // `packages/adapters/test/integration/backpressure-soak.test.ts` records
    // for the same quantity at the same layer.
    //
    // The exact instrument replaces it. `peakLead` is measured in bytes of
    // stream rather than bytes of heap, and it pins the stimulus this spec is
    // actually about: the reader runs far ahead of the consumer, so the
    // exactly-once and in-order assertions above are being made against a
    // genuinely stalled reader rather than against a producer that was politely
    // waiting for it.
    //
    // It is the *peak* lead over the whole loop, not a sample at a fixed chunk,
    // and that distinction is the difference between an instrument and a race.
    // A single reading at the consumer's fifth chunk asks how far the producer
    // happened to have got in the first ~25 ms, which is exactly the quantity a
    // loaded box perturbs: it measured 1,682,049 bytes idle, 1,491,808 beside a
    // full suite, and 518,208 beside a heavier one — a 3x swing on identical
    // code, and the last of those went red against a 512 KiB floor. The peak is
    // stable instead because it does not care *when* the producer finishes,
    // only that it finishes while the consumer is still sleeping its way
    // through a 1 s loop, which it always does when nothing throttles it.
    //
    // The two regimes are an order of magnitude apart. A backpressured pull-loop
    // reader can never lead by more than one 64 KiB pipe plus a frame in hand —
    // about 72 KiB, since the child is blocked in `write()` for the rest of the
    // turn. This harness leads by megabytes. 256 KiB sits ~3.5x above what
    // backpressure permits and far below what flowing mode produces, so neither
    // a busy box nor a quiet one can move it across.
    //
    // Flowing mode in the *product* is caught where it is observable through
    // the real transport, quantitatively and in bytes of read-ahead:
    // `packages/adapters/test/integration/pull-loop.test.ts` (EPIC-05-S3 · AC4).
    expect(peakLead).toBeGreaterThan(256 * 1024);
    expect(peakRss).toBeGreaterThanOrEqual(baselineRss);

    session.dispose();
    expect(await agent.finish()).toEqual({ code: 0, signal: null });
  });
});
