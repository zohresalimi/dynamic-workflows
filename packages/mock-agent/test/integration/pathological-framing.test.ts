/**
 * EPIC-04-S12 — framing hazards: one enormous line, and an agent that never
 * ends a line at all.
 *
 * This is the verified hazard behind KAR-05.4. `@agentclientprotocol/sdk`'s
 * `LineBuffer` (dist/line-buffer.js) has **no maximum line length** — `push()`
 * accumulates chunks into a private `#pending` array and only emits on finding
 * a `0x0a`. DeFlowd is a long-lived daemon supervising runs for days, so an
 * agent that floods without ever terminating a line is an availability bug,
 * not a curiosity. Neither case can be produced by a mocked stream: the
 * question is what a real pipe delivers to a real reader, in pieces.
 *
 * Verifies: EPIC-04-S12 · KAR-04.3 AC6, AC7 · test plan rows 7, 8
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { patternSlice } from '../../src/pathological.ts';
import {
  CLIENT_CAPABILITIES,
  connectClient,
  killProcessGroup,
  type SpawnedAgent,
  scenarioPath,
  spawnMockAgent,
} from '../support/harness.ts';

const MIB = 1024 * 1024;

let cwd = '';
const spawned: SpawnedAgent[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'DeFlow-'));
});

afterEach(async () => {
  for (const agent of spawned.splice(0)) killProcessGroup(agent);
  if (process.env.DeFlow_KEEP_TMP === undefined) await rm(cwd, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

suite('EPIC-04-S12 — one enormous line', () => {
  it('writes ≥ 10 MiB with no 0x0a in it, in pieces rather than atomically', async () => {
    const agent = spawnMockAgent(['--seed', '42', '--huge-line']);
    spawned.push(agent);

    // A second listener on an already-flowing stream: the harness tees bytes
    // into one buffer, and "did it arrive in pieces?" is a question about the
    // reads, which a concatenated buffer has already thrown away.
    const reads: number[] = [];
    agent.child.stdout.on('data', (bytes: Buffer) => reads.push(bytes.length));

    const { connection } = connectClient(agent);
    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await connection.agent.request('session/new', { cwd, mcpServers: [] });
    const readsBeforePrompt = reads.length;
    void connection.agent
      .request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'flood me' }],
      })
      .catch(() => null);

    const longestRun = (): number =>
      agent
        .stdout()
        .toString('utf8')
        .split('\n')
        .reduce((longest, segment) => Math.max(longest, segment.length), 0);

    await waitFor('10 MiB on one line', () => longestRun() >= 10 * MIB, 20_000);

    const segments = agent.stdout().toString('utf8').split('\n');
    const huge = segments.reduce((longest, segment) =>
      segment.length > longest.length ? segment : longest,
    );

    expect(huge.length).toBeGreaterThanOrEqual(10 * MIB);
    expect(huge).not.toContain('\n');
    // A generated repeating pattern, not random bytes: the fixtures stay out
    // of git and --seed keeps meaning something.
    expect(huge).toContain(patternSlice(0, 64 * 1024));

    // The client's byte counter saw it grow. One read of 10 MiB would mean the
    // cap in KAR-05.4 could only ever fire after the memory was already spent.
    expect(reads.length - readsBeforePrompt).toBeGreaterThan(8);

    killProcessGroup(agent);
  });
});

suite('EPIC-04-S12 — an agent that never emits a newline at all', () => {
  it('floods past 8 MiB with zero 0x0a bytes, and has to be killed', async () => {
    const agent = spawnMockAgent(['--seed', '42', '--scenario', scenarioPath('no-newline.jsonc')]);
    spawned.push(agent);

    const { connection } = connectClient(agent);
    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await connection.agent.request('session/new', { cwd, mcpServers: [] });

    // The handshake frames are newline-terminated and already on the wire, so
    // the claim is about everything the agent writes from the prompt onwards.
    const offset = agent.stdout().length;
    void connection.agent
      .request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'never finish a line' }],
      })
      .catch(() => null);

    const tail = (): Buffer => agent.stdout().subarray(offset);
    // Up to five seconds, which is the point at which a daemon left alone with
    // this agent is already carrying it all in one unbounded buffer.
    await waitFor('8 MiB of unterminated output', () => tail().length >= 8 * MIB, 5_000);

    const flood = tail();
    expect(flood.length).toBeGreaterThanOrEqual(8 * MIB);
    expect(flood.indexOf(0x0a)).toBe(-1);

    // Still running, still writing, still no frame emitted by the SDK's
    // LineBuffer. Nothing short of killing the process group ends this.
    expect(agent.child.exitCode).toBeNull();
    killProcessGroup(agent);
    expect(await agent.exited()).toMatchObject({ signal: 'SIGKILL' });
  });
});
