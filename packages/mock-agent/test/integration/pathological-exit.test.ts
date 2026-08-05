/**
 * EPIC-04-S9 — `process.exit(1)` mid-turn, and what it leaves behind.
 *
 * The truncated final line is the point. A crash-recovery path that assumes
 * every line it reads is complete reports `adapter.malformed-output` for what
 * is actually `agent.nonzero-exit` — two different `NodeFailureReason`s with
 * two different `class` values and therefore two different scheduler decisions
 * (docs/04-domain-model.md §8). The only way to keep those honest is to
 * produce a real half-written line from a real dead process.
 *
 * The grandchildren spec is the other half of the same crash: a process group
 * outlives its leader. That row is what the orphan reaper in KAR-05.9 has to
 * find in SQLite on the next daemon boot, and it cannot be written without a
 * process that really was reparented.
 *
 * Verifies: EPIC-04-S9 · KAR-04.3 AC3 · test plan row 4
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  CLIENT_CAPABILITIES,
  connectClient,
  scenarioPath,
  spawnMockAgent,
} from '../support/harness.ts';

let cwd = '';
const strays: number[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'DeFlow-'));
});

afterEach(async () => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already gone, which is the only other acceptable state.
    }
  }
  if (process.env.DeFlow_KEEP_TMP === undefined) await rm(cwd, { recursive: true, force: true });
});

/** `ppid` and `pgid` as the OS reports them, for a pid that may already be gone. */
function processTable(pid: number): { ppid: number; pgid: number } | null {
  try {
    const row = execFileSync('ps', ['-o', 'ppid=,pgid=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    const [ppid, pgid] = row.split(/\s+/).map(Number);
    return { ppid: ppid as number, pgid: pgid as number };
  } catch {
    return null;
  }
}

suite('EPIC-04-S9 — the agent dies with a half-written line', () => {
  it('exits 1 with no signal, and the last line neither parses nor ends in 0x0a', async () => {
    const agent = spawnMockAgent([
      '--seed',
      '42',
      '--scenario',
      scenarioPath('exit-mid-turn.jsonc'),
    ]);
    const { connection, updates } = connectClient(agent);

    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await connection.agent.request('session/new', { cwd, mcpServers: [] });

    let responded = false;
    const prompted = connection.agent
      .request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'crash please' }],
      })
      .then(() => {
        responded = true;
      })
      // The connection dies with the child; the rejection is the observation,
      // not a failure.
      .catch(() => null);

    expect(await agent.exited()).toEqual({ code: 1, signal: null });
    await prompted;

    const stdout = agent.stdout().toString('utf8');
    expect(stdout.endsWith('\n')).toBe(false);

    const lines = stdout.split('\n');
    const last = lines.at(-1) as string;
    expect(last).not.toBe('');
    expect(() => JSON.parse(last)).toThrow(SyntaxError);

    // Everything before it is intact: the crash cut one frame, not the stream.
    for (const line of lines.slice(0, -1)) expect(() => JSON.parse(line)).not.toThrow();

    // Two frames, then the knife — the scenario's declared budget.
    expect(updates).toHaveLength(2);

    // The prompt response never arrives: two results on the wire (initialize
    // and session/new) and nothing for the prompt.
    expect(responded).toBe(false);
    const results = lines
      .slice(0, -1)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((frame) => 'result' in frame);
    expect(results).toHaveLength(2);
  });
});

suite('EPIC-04-S9 — grandchildren survive the agent’s own exit', () => {
  it('reparents them to pid 1 while their pgid stays the dead agent’s pid', async () => {
    const agent = spawnMockAgent([
      '--seed',
      '42',
      '--scenario',
      scenarioPath('exit-with-grandchildren.jsonc'),
    ]);
    const agentPid = agent.child.pid as number;
    const { connection, updates } = connectClient(agent);

    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await connection.agent.request('session/new', { cwd, mcpServers: [] });
    const prompted = connection.agent
      .request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'leave orphans' }],
      })
      .catch(() => null);

    expect(await agent.exited()).toEqual({ code: 1, signal: null });
    await prompted;

    const announcement = updates
      .map((notification) =>
        notification.update.sessionUpdate === 'agent_message_chunk' &&
        notification.update.content.type === 'text'
          ? notification.update.content.text
          : '',
      )
      .find((text) => text.startsWith('grandchildren:'));
    expect(announcement, 'the agent announced the pids it spawned').toBeDefined();

    const pids = (announcement as string)
      .slice('grandchildren:'.length)
      .split(',')
      .map((value) => Number(value.trim()));
    strays.push(...pids);
    expect(pids).toHaveLength(2);

    for (const pid of pids) {
      const row = processTable(pid);
      expect(row, `grandchild ${pid} outlived the agent`).not.toBeNull();
      // Reparented to init. A process-group kill aimed at the agent's pid is
      // the only thing that can still reach these, which is exactly why
      // DeFlowd stores the pgid rather than the pid.
      expect(row?.ppid).toBe(1);
      expect(row?.pgid).toBe(agentPid);
    }
  });
});
