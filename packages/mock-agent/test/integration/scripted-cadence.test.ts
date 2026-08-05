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
    const prompted = await connection.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'stream please' }],
    });

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

    // Four gaps between the five chunks. 40 ms rather than 50 because the
    // assertion is "the agent slept" and a scheduler may round a timer down by
    // a millisecond or two; a burst would put every gap under one.
    const chunkGaps = gaps(arrivals.slice(1));
    expect(chunkGaps).toHaveLength(4);
    for (const gap of chunkGaps) expect(gap).toBeGreaterThanOrEqual(40);

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

    const baselineRss = process.memoryUsage().rss;
    let peakRss = baselineRss;

    const session = await connection.agent.buildSession({ cwd, mcpServers: [] }).start();
    const promptDone = session.prompt([{ type: 'text', text: 'flood me' }]);

    const texts: string[] = [];
    for (;;) {
      const message = await session.nextUpdate();
      if (message.kind === 'stop') break;
      if (message.update.sessionUpdate === 'agent_message_chunk') {
        const content = message.update.content;
        if (content.type === 'text') texts.push(content.text);
      }
      // The simulated durable write. This is the only legal place to await a
      // SQLite append, so the loop has to survive one.
      await new Promise((resolve) => setTimeout(resolve, 5));
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

    expect(peakRss - baselineRss).toBeLessThan(32 * 1024 * 1024);

    session.dispose();
    expect(await agent.finish()).toEqual({ code: 0, signal: null });
  });
});
