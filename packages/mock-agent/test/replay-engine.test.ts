/**
 * KAR-04.5 — the replay engine, driven entirely by a recording.
 *
 * Everything the engine writes comes out of the file: there is no id factory,
 * no clock and no scenario in this path, which is what makes AC6 (two replays,
 * byte-identical, independent of `--seed`) true by construction rather than by
 * discipline.
 *
 * The one place a recorded byte is *not* echoed verbatim is the id of a
 * response to a client request, and that is forced by JSON-RPC: the SDK's
 * client numbers its outbound requests from 0 while the capture in
 * `recordings/claude-agent-acp@0.64.1/` numbers them from 1, so a response
 * carrying the recorded id would never resolve the client's promise and the
 * "compare modulo id" rule in AC2 would be a tolerance with nothing behind it.
 * The recorded id decides *which* pending request is being answered; the
 * client's own id goes on the wire.
 *
 * Verifies: EPIC-04-S15 · AC1, AC2, AC3, AC5, AC6
 */
import { expect, it, describe as suite } from 'vitest';
import {
  type Direction,
  type JsonObject,
  parseRecording,
  type RecordedFrame,
} from '../src/recording.ts';
import { REPLAY_MISMATCH_EXIT_CODE, REPLAY_TRUNCATED_EXIT_CODE, runReplay } from '../src/replay.ts';

function frames(...lines: readonly { t?: number; dir: Direction; msg: JsonObject }[]) {
  const text = lines
    .map((entry) => JSON.stringify({ t: entry.t ?? 0, dir: entry.dir, msg: entry.msg }))
    .join('\n');
  const parsed = parseRecording(text, 'a.ndjson');
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.frames;
}

interface Replayed {
  readonly code: number;
  readonly stdout: readonly JsonObject[];
  readonly stderr: string;
  readonly slept: readonly number[];
}

/**
 * Runs the engine against a scripted client: the nth line the client sends is
 * handed over when the engine asks for the nth inbound frame. `undefined`
 * stands for the client closing stdin.
 */
async function replay(
  recorded: readonly RecordedFrame[],
  clientLines: readonly JsonObject[],
  speed: 'real' | 'max' = 'max',
): Promise<Replayed> {
  const stdout: JsonObject[] = [];
  const stderr: string[] = [];
  const slept: number[] = [];
  let next = 0;

  const inbound: AsyncIterator<string> = {
    next: async () => {
      const line = clientLines[next];
      next += 1;
      return line === undefined
        ? { done: true, value: undefined }
        : { done: false, value: JSON.stringify(line) };
    },
  };

  const code = await runReplay(recorded, {
    io: {
      inbound,
      write: async (text) => {
        for (const line of text.split('\n')) {
          if (line.trim() !== '') stdout.push(JSON.parse(line) as JsonObject);
        }
      },
      warn: (text) => {
        stderr.push(text);
      },
    },
    speed,
    path: 'a.ndjson',
    sleep: async (ms) => {
      slept.push(ms);
    },
  });

  return { code, stdout, stderr: stderr.join(''), slept };
}

const initialize = (id: number): JsonObject => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion: 1 },
});
const initialized = (id: number): JsonObject => ({
  jsonrpc: '2.0',
  id,
  result: { protocolVersion: 1, agentCapabilities: {} },
});
const prompt = (id: number): JsonObject => ({
  jsonrpc: '2.0',
  id,
  method: 'session/prompt',
  params: { sessionId: 's-1', prompt: [{ type: 'text', text: 'hello' }] },
});
const chunkUpdate = (text: string): JsonObject => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: 's-1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  },
});
const stopped = (id: number, stopReason: string): JsonObject => ({
  jsonrpc: '2.0',
  id,
  result: { stopReason },
});

const FULL_TURN = () =>
  frames(
    { dir: 'in', msg: initialize(1), t: 0 },
    { dir: 'out', msg: initialized(1), t: 10 },
    { dir: 'in', msg: prompt(2), t: 20 },
    { dir: 'out', msg: chunkUpdate('I'), t: 30 },
    { dir: 'out', msg: chunkUpdate("'ll do that."), t: 330 },
    { dir: 'out', msg: stopped(2, 'end_turn'), t: 340 },
  );

suite('AC1 — a recording drives a whole turn', () => {
  it('emits every out frame in file order and exits 0', async () => {
    const result = await replay(FULL_TURN(), [initialize(1), prompt(2)]);

    expect(result.code).toBe(0);
    expect(result.stdout).toEqual([
      initialized(1),
      chunkUpdate('I'),
      chunkUpdate("'ll do that."),
      stopped(2, 'end_turn'),
    ]);
    expect(result.stderr).toBe('');
  });

  it('emits nothing before the client has spoken', async () => {
    // The client's first frame gates the first emission: an agent that wrote
    // its initialize response before the request arrived would pass a replay
    // and deadlock a real client.
    const result = await replay(FULL_TURN(), []);
    expect(result.stdout).toEqual([]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/stdin|closed/i);
  });
});

suite('AC2 — client frames are compared modulo id and _meta', () => {
  it('accepts a client whose ids and _meta differ, and answers with its ids', async () => {
    const result = await replay(FULL_TURN(), [
      { ...initialize(0), _meta: { from: 'DeFlowd' } },
      { ...prompt(1), _meta: { attempt: 2 } },
    ]);

    expect(result.code).toBe(0);
    // The recorded ids were 1 and 2; the client used 0 and 1. Every response
    // carries the id of the request it answers, or nothing resolves.
    expect(result.stdout[0]).toEqual(initialized(0));
    expect(result.stdout[3]).toEqual(stopped(1, 'end_turn'));
    // Notifications have no id and are echoed byte for byte.
    expect(result.stdout[1]).toEqual(chunkUpdate('I'));
  });

  it('fails loudly on a genuine divergence, naming the ndjson line number', async () => {
    const diverged = {
      ...prompt(2),
      params: { sessionId: 's-1', prompt: [{ type: 'text', text: 'something else entirely' }] },
    };
    const result = await replay(FULL_TURN(), [initialize(1), diverged]);

    expect(result.code).toBe(REPLAY_MISMATCH_EXIT_CODE);
    // The recorded prompt is the third line of the fixture.
    expect(result.stderr).toContain('a.ndjson:3');
    expect(result.stderr).toContain('--- recorded');
    expect(result.stderr).toContain('+++ received');
    expect(result.stderr).toContain('something else entirely');
    // It stops at the divergence rather than emitting the rest of the turn.
    expect(result.stdout).toEqual([initialized(1)]);
  });
});

suite('AC3 — --replay-speed chooses between recorded cadence and the pipe', () => {
  it('honours the recorded offsets between consecutive out frames under "real"', async () => {
    const result = await replay(FULL_TURN(), [initialize(1), prompt(2)], 'real');
    // 30-20 before the first chunk, 330-30 before the second, 340-330 before
    // the stop. Deltas, not absolutes: the wait for a client frame is the
    // client's latency, not the agent's cadence, and adding the two would
    // stretch every replay by however slow the harness happened to be.
    expect(result.slept).toEqual([10, 10, 300, 10]);
  });

  it('never sleeps under "max", which is what CI runs', async () => {
    const result = await replay(FULL_TURN(), [initialize(1), prompt(2)], 'max');
    expect(result.slept).toEqual([]);
  });
});

suite('AC5 — a truncated recording terminates the session', () => {
  const truncated = () =>
    frames(
      { dir: 'in', msg: initialize(1), t: 0 },
      { dir: 'out', msg: initialized(1), t: 10 },
      { dir: 'in', msg: prompt(2), t: 20 },
      { dir: 'out', msg: chunkUpdate('I'), t: 30 },
    );

  it('answers the unanswered prompt with a non-end_turn stopReason', async () => {
    const result = await replay(truncated(), [initialize(1), prompt(7)]);

    expect(result.code).toBe(REPLAY_TRUNCATED_EXIT_CODE);
    expect(result.stdout.at(-1)).toEqual(stopped(7, 'cancelled'));
    expect(result.stderr).toMatch(/truncat/i);
    expect(result.stderr).toContain('session/prompt');
  });

  it('answers any other dangling request with an error rather than hanging', async () => {
    const dangling = frames(
      { dir: 'in', msg: initialize(1), t: 0 },
      { dir: 'out', msg: initialized(1), t: 10 },
      { dir: 'in', msg: { jsonrpc: '2.0', id: 2, method: 'session/new', params: {} }, t: 20 },
    );
    const result = await replay(dangling, [
      initialize(1),
      { jsonrpc: '2.0', id: 5, method: 'session/new', params: {} },
    ]);

    expect(result.code).toBe(REPLAY_TRUNCATED_EXIT_CODE);
    const last = result.stdout.at(-1) as JsonObject;
    expect(last['id']).toBe(5);
    expect(last['error']).toBeTypeOf('object');
    expect(result.stderr).toMatch(/truncat/i);
  });

  it('says nothing about truncation when the recording ends cleanly', async () => {
    const result = await replay(FULL_TURN(), [initialize(1), prompt(2)]);
    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
  });
});
