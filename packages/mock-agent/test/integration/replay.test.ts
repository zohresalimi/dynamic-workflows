/**
 * KAR-04.5 — `--replay <file>` serves a captured session as a provider.
 *
 * These run the real binary as a child process against real files on disk,
 * because every claim in the story is about a process: an exit code, a line on
 * stderr, the bytes on stdout, and how long the thing takes to give up. None
 * of that survives an in-process double.
 *
 * Verifies: EPIC-04-S15, EPIC-04-S16 · AC1, AC2, AC3, AC4, AC5, AC6
 * · test plan rows 1, 3, 4, 5, 6
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import type { Direction, JsonObject } from '../../src/recording.ts';
import { RECORDING_DIR_SHAPE } from '../../src/recording.ts';
import { REPLAY_MISMATCH_EXIT_CODE, REPLAY_TRUNCATED_EXIT_CODE } from '../../src/replay.ts';
import { CLIENT_CAPABILITIES, connectClient, spawnMockAgent } from '../support/harness.ts';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'DeFlow-replay-'));
});

afterEach(async () => {
  if (process.env.DeFlow_KEEP_TMP === undefined) await rm(root, { recursive: true, force: true });
});

interface Line {
  readonly t: number;
  readonly dir: Direction;
  readonly msg: JsonObject;
}

/** Writes a recording into `<root>/<dirName>/<case>.ndjson` and returns its path. */
async function writeRecording(
  dirName: string,
  caseName: string,
  lines: readonly Line[],
): Promise<string> {
  const dir = join(root, dirName);
  await mkdir(dir, { recursive: true });
  const path = join(dir, caseName);
  await writeFile(path, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return path;
}

const SESSION = 'replay-session-1';

const update = (text: string): JsonObject => ({
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: SESSION,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  },
});

/**
 * The six-line fixture of test-plan row 1: a handshake, a prompt, two chunks
 * and a stop. It carries no `session/new` because the file defines both sides
 * of the wire — the session id is a fact of the recording, not something the
 * agent invents.
 *
 * The recorded ids are 7 and 9 while the SDK's client numbers its requests
 * from 0, which is the ordinary case rather than a contrived one: the capture
 * under `recordings/claude-agent-acp@0.64.1/` was taken with a client that
 * numbered from 1. A replay that echoed the recorded id would leave both of
 * the client's promises pending for ever.
 */
function sixLineTurn(gapMs = 2): Line[] {
  return [
    {
      t: 0,
      dir: 'in',
      msg: {
        jsonrpc: '2.0',
        id: 7,
        method: 'initialize',
        params: { protocolVersion: 1, clientCapabilities: CLIENT_CAPABILITIES },
      },
    },
    {
      t: 5,
      dir: 'out',
      msg: {
        jsonrpc: '2.0',
        id: 7,
        result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
      },
    },
    {
      t: 10,
      dir: 'in',
      msg: {
        jsonrpc: '2.0',
        id: 9,
        method: 'session/prompt',
        params: { sessionId: SESSION, prompt: [{ type: 'text', text: 'hello' }] },
      },
    },
    { t: 12, dir: 'out', msg: update('I') },
    { t: 12 + gapMs, dir: 'out', msg: update("'ll do that.") },
    {
      t: 14 + gapMs,
      dir: 'out',
      msg: { jsonrpc: '2.0', id: 9, result: { stopReason: 'end_turn' } },
    },
  ];
}

const chunkTexts = (updates: readonly { update: Record<string, unknown> }[]): string[] =>
  updates
    .filter((notification) => notification.update['sessionUpdate'] === 'agent_message_chunk')
    .map((notification) => (notification.update['content'] as { text: string }).text);

suite('EPIC-04-S15 — a recording drives a full turn (AC1)', () => {
  it('completes a prompt cycle from the file alone, with no scenario present', async () => {
    const path = await writeRecording('mock-provider@1.2.3', 'hello.ndjson', sixLineTurn());
    const agent = spawnMockAgent(['--replay', path, '--replay-speed', 'max']);
    const { connection, updates } = connectClient(agent);

    const initialized = await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    expect(initialized.protocolVersion).toBe(1);

    const prompted = await connection.agent.request('session/prompt', {
      sessionId: SESSION,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(chunkTexts(updates)).toEqual(['I', "'ll do that."]);
    expect(prompted.stopReason).toBe('end_turn');

    const exit = await agent.finish();
    expect(exit).toEqual({ code: 0, signal: null });
    expect(agent.stderr()).toBe('');
  });
});

suite('EPIC-04-S15 — a genuine divergence fails loudly (AC2)', () => {
  it('exits non-zero with a unified diff naming the ndjson line number', async () => {
    const path = await writeRecording('mock-provider@1.2.3', 'hello.ndjson', sixLineTurn());
    const agent = spawnMockAgent(['--replay', path]);
    const { connection } = connectClient(agent);

    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    // A different prompt text: the one thing a replay must never wave through,
    // because a golden that accepts any prompt has stopped being a golden.
    connection.agent
      .request('session/prompt', {
        sessionId: SESSION,
        prompt: [{ type: 'text', text: 'something else entirely' }],
      })
      .catch(() => {
        // The child exits mid-request on purpose; the assertion is the exit.
      });

    const exit = await agent.exited();
    expect(exit.code).toBe(REPLAY_MISMATCH_EXIT_CODE);

    const stderr = agent.stderr();
    // The recorded prompt is the third line of the file.
    expect(stderr).toContain('hello.ndjson:3');
    expect(stderr).toContain('--- recorded');
    expect(stderr).toContain('+++ received');
    expect(stderr).toContain('something else entirely');
  });
});

suite('EPIC-04-S16 — the directory name is the version key (AC4)', () => {
  it('refuses a directory with no version, before emitting a single frame', async () => {
    const path = await writeRecording('claude-agent-acp', 'hello.ndjson', sixLineTurn());
    const agent = spawnMockAgent(['--replay', path]);

    const exit = await agent.finish();
    expect(exit.code).not.toBe(0);
    expect(agent.stdout()).toHaveLength(0);
    expect(agent.stderr()).toContain(RECORDING_DIR_SHAPE);
    expect(agent.stderr()).toContain('claude-agent-acp');
  });

  it('refuses a moving tag for the same reason', async () => {
    const path = await writeRecording('claude-agent-acp@latest', 'hello.ndjson', sixLineTurn());
    const agent = spawnMockAgent(['--replay', path]);

    const exit = await agent.finish();
    expect(exit.code).not.toBe(0);
    expect(agent.stdout()).toHaveLength(0);
    expect(agent.stderr()).toContain(RECORDING_DIR_SHAPE);
  });
});

suite('EPIC-04-S15 — a truncated recording does not hang (AC5)', () => {
  it('ends the turn with a non-end_turn stopReason and says so on stderr', async () => {
    // The file ends after the first chunk, as a crashed capture would.
    const path = await writeRecording(
      'mock-provider@1.2.3',
      'crashed.ndjson',
      sixLineTurn().slice(0, 4),
    );
    const started = performance.now();
    const agent = spawnMockAgent(['--replay', path]);
    const { connection } = connectClient(agent);

    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const prompted = await connection.agent.request('session/prompt', {
      sessionId: SESSION,
      prompt: [{ type: 'text', text: 'hello' }],
    });

    expect(prompted.stopReason).not.toBe('end_turn');
    expect(performance.now() - started).toBeLessThan(2_000);

    const exit = await agent.exited();
    expect(exit.code).toBe(REPLAY_TRUNCATED_EXIT_CODE);
    expect(agent.stderr()).toMatch(/truncat/i);
    expect(agent.stderr()).toContain('session/prompt');
  });
});

suite('EPIC-04-S16 — determinism does not depend on --seed (AC6)', () => {
  async function replayOnce(path: string, args: readonly string[] = []): Promise<Buffer> {
    const agent = spawnMockAgent(['--replay', path, ...args]);
    const { connection } = connectClient(agent);
    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    await connection.agent.request('session/prompt', {
      sessionId: SESSION,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    await agent.finish();
    return agent.stdout();
  }

  it('writes the same bytes twice, and the same bytes again under a seed', async () => {
    const path = await writeRecording('mock-provider@1.2.3', 'hello.ndjson', sixLineTurn());

    const first = await replayOnce(path);
    const second = await replayOnce(path);
    const seeded = await replayOnce(path, ['--seed', '99']);

    expect(first.length).toBeGreaterThan(0);
    expect(Buffer.compare(first, second)).toBe(0);
    // Every id, timestamp and chunk came out of the file, so --seed has
    // nothing to influence — which is the whole claim.
    expect(Buffer.compare(first, seeded)).toBe(0);
  });
});

suite('AC3 — --replay-speed picks the cadence', () => {
  const GAP_MS = 400;

  it('honours the recorded offsets under "real"', async () => {
    const path = await writeRecording('mock-provider@1.2.3', 'paced.ndjson', sixLineTurn(GAP_MS));
    const agent = spawnMockAgent(['--replay', path, '--replay-speed', 'real']);
    const { connection, arrivals } = connectClient(agent);

    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    await connection.agent.request('session/prompt', {
      sessionId: SESSION,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    await agent.finish();

    expect(arrivals).toHaveLength(2);
    expect((arrivals[1] as number) - (arrivals[0] as number)).toBeGreaterThan(GAP_MS * 0.7);
  });

  it('emits as fast as the pipe allows under "max", which is the CI default', async () => {
    const path = await writeRecording('mock-provider@1.2.3', 'paced.ndjson', sixLineTurn(GAP_MS));
    const agent = spawnMockAgent(['--replay', path]);
    const { connection, arrivals } = connectClient(agent);

    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    await connection.agent.request('session/prompt', {
      sessionId: SESSION,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    await agent.finish();

    expect(arrivals).toHaveLength(2);
    expect((arrivals[1] as number) - (arrivals[0] as number)).toBeLessThan(GAP_MS * 0.5);
  });
});

suite('--replay refuses to be combined with a script', () => {
  it('rejects --replay with --scenario', async () => {
    const path = await writeRecording('mock-provider@1.2.3', 'hello.ndjson', sixLineTurn());
    const agent = spawnMockAgent(['--replay', path, '--scenario', 'minimal-turn.jsonc']);
    const exit = await agent.finish();
    expect(exit.code).toBe(2);
    expect(agent.stderr()).toContain('--scenario');
  });

  it('rejects an unknown --replay-speed rather than defaulting', async () => {
    const path = await writeRecording('mock-provider@1.2.3', 'hello.ndjson', sixLineTurn());
    const agent = spawnMockAgent(['--replay', path, '--replay-speed', 'warp']);
    const exit = await agent.finish();
    expect(exit.code).toBe(2);
    expect(agent.stderr()).toContain('warp');
  });

  it('rejects --replay-speed on its own, which would silently do nothing', async () => {
    const agent = spawnMockAgent(['--replay-speed', 'real']);
    const exit = await agent.finish();
    expect(exit.code).toBe(2);
    expect(agent.stderr()).toContain('--replay');
  });

  it('reports a recording it cannot read, without opening the transport', async () => {
    const agent = spawnMockAgent(['--replay', join(root, 'mock-provider@1.2.3', 'missing.ndjson')]);
    const exit = await agent.finish();
    expect(exit.code).not.toBe(0);
    expect(agent.stdout()).toHaveLength(0);
    expect(agent.stderr()).toContain('missing.ndjson');
  });
});
