/**
 * EPIC-04-S15 — replaying a golden recording as a provider.
 *
 * The fixture here is not an invention: it is
 * `recordings/claude-agent-acp@0.64.1/simple-edit.ndjson`, derived by
 * `packages/mock-agent/scripts/capture-to-replay.ts` from the transport tee
 * that spike M0-S1 ran against the real, authenticated `claude-agent-acp`
 * 0.64.1 — a prompt asking for a file, a `session/request_permission` the
 * client denied, and the model explaining that the write did not happen. Every
 * byte the mock writes in this spec was written by that vendor CLI.
 *
 * That is what makes the replay a flag-churn detector rather than a second
 * mock: a re-record against 0.65.0 lands as a *new directory in a pull
 * request*, and any frame whose shape moved shows up as a diff there rather
 * than as a mystery in a three-hour run.
 *
 * Verifies: EPIC-04-S15 · AC1, AC2, AC6
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import type { JsonObject, RecordedFrame } from '../../src/recording.ts';
import { parseRecording } from '../../src/recording.ts';
import { connectClient, spawnMockAgent } from '../support/harness.ts';

const GOLDEN = fileURLToPath(
  new URL('../../../../recordings/claude-agent-acp@0.64.1/simple-edit.ndjson', import.meta.url),
);

function goldenFrames(): readonly RecordedFrame[] {
  const parsed = parseRecording(readFileSync(GOLDEN, 'utf8'), GOLDEN);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.frames;
}

/** The params the recorded client sent with `method`, replayed verbatim. */
function recordedParams(frames: readonly RecordedFrame[], method: string): JsonObject {
  const frame = frames.find((entry) => entry.dir === 'in' && entry.msg['method'] === method);
  if (frame === undefined) throw new Error(`the golden has no inbound ${method}`);
  return frame.msg['params'] as JsonObject;
}

/** Every `agent_message_chunk` the vendor CLI emitted, in file order. */
function recordedChunks(frames: readonly RecordedFrame[]): string[] {
  return frames
    .filter((frame) => frame.dir === 'out' && frame.msg['method'] === 'session/update')
    .map((frame) => (frame.msg['params'] as JsonObject)['update'] as JsonObject)
    .filter((update) => update['sessionUpdate'] === 'agent_message_chunk')
    .map((update) => (update['content'] as { text: string }).text);
}

suite('a captured real session becomes a free provider', () => {
  it('drives a whole turn from the file, permission request and all', async () => {
    const frames = goldenFrames();
    const agent = spawnMockAgent(['--replay', GOLDEN, '--replay-speed', 'max']);

    const { connection, updates, calls } = connectClient(agent, {
      // What the human at the keyboard actually answered on 2026-08-04.
      permission: () => ({ outcome: 'selected', optionId: 'reject' }),
    });

    const initialized = await connection.agent.request(
      'initialize',
      recordedParams(frames, 'initialize') as never,
    );
    // Straight from claude-agent-acp 0.64.1, not from anything this repo wrote.
    expect(initialized.protocolVersion).toBe(1);
    expect(initialized.agentCapabilities?.loadSession).toBe(true);

    const session = await connection.agent.request(
      'session/new',
      recordedParams(frames, 'session/new') as never,
    );
    expect(session.sessionId).toBe('a54d92c7-c390-4042-8a61-ada78417aad6');

    const prompted = await connection.agent.request(
      'session/prompt',
      recordedParams(frames, 'session/prompt') as never,
    );

    // The chunk texts, in the recorded order.
    const observed = updates
      .filter((notification) => notification.update.sessionUpdate === 'agent_message_chunk')
      .map((notification) => (notification.update as { content: { text: string } }).content.text);
    expect(observed).toEqual(recordedChunks(frames));
    // An anchor that is a fact about the capture rather than a restatement of
    // it: if the file were ever regenerated from something other than that
    // session, this is the line that would notice.
    expect(observed.join('')).toContain("I'll create that file.");
    expect(observed.join('')).toContain('permission for that tool call was refused');

    // The agent asked the client for permission and was refused, which is the
    // one place in the capture where the client had to answer a request.
    expect(calls.map((call) => call.method)).toEqual(['session/request_permission']);

    expect(prompted.stopReason).toBe('end_turn');

    const exit = await agent.finish();
    expect(exit).toEqual({ code: 0, signal: null });
    expect(agent.stderr()).toBe('');
  });

  it('is byte-identical on a second replay, with and without a seed', async () => {
    const frames = goldenFrames();

    const once = async (args: readonly string[]): Promise<Buffer> => {
      const agent = spawnMockAgent(['--replay', GOLDEN, ...args]);
      const { connection } = connectClient(agent, {
        permission: () => ({ outcome: 'selected', optionId: 'reject' }),
      });
      await connection.agent.request('initialize', recordedParams(frames, 'initialize') as never);
      await connection.agent.request('session/new', recordedParams(frames, 'session/new') as never);
      await connection.agent.request(
        'session/prompt',
        recordedParams(frames, 'session/prompt') as never,
      );
      await agent.finish();
      return agent.stdout();
    };

    const first = await once([]);
    const second = await once([]);
    const seeded = await once(['--seed', '4242']);

    expect(first.length).toBeGreaterThan(1_000);
    expect(Buffer.compare(first, second)).toBe(0);
    expect(Buffer.compare(first, seeded)).toBe(0);
  });
});
