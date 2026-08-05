/**
 * EPIC-04-S7 — the agent calls back into the client.
 *
 * These seven methods are where the whole permission ladder lives: DeFlow sits
 * in the path of every file access and every command execution, which is what
 * collapses an N-vendors × M-levels matrix into one pure policy function
 * (docs/07-provider-adapter-layer.md §1). The third suite is here because
 * ACP v2 removes all seven from the client and pushes them onto MCP — an agent
 * that calls methods the client never advertised would hide that migration
 * behind a stub that answers anyway.
 *
 * Verifies: EPIC-04-S7 · AC5 · test plan row 6
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  CLIENT_CAPABILITIES,
  CLIENT_METHODS,
  connectClient,
  frames,
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

/** The `_meta.trace` the agent attaches to its own PromptResponse (AC5). */
interface TraceEntry {
  readonly method: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: string;
  readonly skipped?: boolean;
}

function traceOf(response: acp.PromptResponse): TraceEntry[] {
  return ((response._meta ?? {}) as { trace?: TraceEntry[] }).trace ?? [];
}

suite('EPIC-04-S7 — all seven client methods, in the declared order', () => {
  it('invokes each exactly once and releases the terminal last', async () => {
    const agent = spawnMockAgent([
      '--seed',
      '42',
      '--scenario',
      scenarioPath('client-callbacks.jsonc'),
    ]);
    const client = connectClient(agent);

    await client.connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await client.connection.agent.request('session/new', { cwd, mcpServers: [] });
    const prompted = await client.connection.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'do the work' }],
    });

    expect(client.calls.map((call) => call.method)).toEqual([...CLIENT_METHODS]);
    expect(client.calls.map((call) => call.method).indexOf('terminal/release')).toBeGreaterThan(
      client.calls.map((call) => call.method).indexOf('terminal/wait_for_exit'),
    );

    // Every request carries the session it belongs to, and the terminal
    // lifecycle calls carry the id the *client* minted rather than one the
    // agent invented.
    for (const call of client.calls) expect(call.params.sessionId).toBe(session.sessionId);
    for (const call of client.calls.filter((c) => c.method.startsWith('terminal/'))) {
      if (call.method === 'terminal/create') continue;
      expect(call.params.terminalId).toBe('stub-terminal-1');
    }

    // AC5: the agent recorded what it saw, so a spec downstream can assert on
    // the answer rather than on the fact that a call was made.
    const trace = traceOf(prompted);
    expect(trace.map((entry) => entry.method)).toEqual([...CLIENT_METHODS]);
    expect(trace.every((entry) => entry.ok)).toBe(true);
    expect(trace[0]?.result).toMatchObject({ content: 'stub file content\n' });

    expect(prompted.stopReason).toBe('end_turn');
    expect(await agent.finish()).toEqual({ code: 0, signal: null });
  });
});

suite('EPIC-04-S7 — the agent records what the client answered', () => {
  it('takes onError, echoes the message verbatim, and still stops', async () => {
    const agent = spawnMockAgent([
      '--seed',
      '42',
      '--scenario',
      scenarioPath('client-error.jsonc'),
    ]);
    const client = connectClient(agent, {
      respond: (method) => {
        if (method !== 'fs/write_text_file') return undefined;
        throw new acp.RequestError(-32602, 'path outside worktree');
      },
    });

    await client.connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await client.connection.agent.request('session/new', { cwd, mcpServers: [] });
    const prompted = await client.connection.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'write outside' }],
    });

    const chunks = client.updates
      .filter((notification) => notification.update.sessionUpdate === 'agent_message_chunk')
      .map((notification) => {
        const content = (notification.update as { content: acp.ContentBlock }).content;
        return content.type === 'text' ? content.text : '';
      });
    expect(chunks.join('')).toContain('path outside worktree');

    const trace = traceOf(prompted);
    expect(trace).toHaveLength(1);
    expect(trace[0]).toMatchObject({ method: 'fs/write_text_file', ok: false });
    expect(trace[0]?.error).toContain('path outside worktree');

    // A stopReason rather than a hang: the failure this guards against is an
    // agent that awaits a response it will never get.
    expect(prompted.stopReason).toBe('refusal');
    expect(await agent.finish()).toEqual({ code: 0, signal: null });
  });
});

suite('EPIC-04-S7 — the agent does not call what the client did not advertise', () => {
  it('skips the step and names the missing capability', async () => {
    const agent = spawnMockAgent([
      '--seed',
      '42',
      '--scenario',
      scenarioPath('client-error.jsonc'),
    ]);
    const client = connectClient(agent);

    await client.connection.agent.request('initialize', {
      protocolVersion: 1,
      // Read only. writeTextFile is absent, not false: "absent" and "false"
      // are different answers and the five real adapters disagree about which
      // they send.
      clientCapabilities: { fs: { readTextFile: true } },
    });
    const session = await client.connection.agent.request('session/new', { cwd, mcpServers: [] });
    const prompted = await client.connection.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'write outside' }],
    });

    expect(client.calls).toEqual([]);
    // Not "the client did not see it" — no such request was ever *written*.
    // The trace names the method too, so this has to look at the frame's own
    // `method` field rather than grep the bytes.
    expect(frames(agent.stdout()).map((frame) => frame.method)).not.toContain('fs/write_text_file');

    const diagnostics = client.updates
      .filter((notification) => notification.update.sessionUpdate === 'agent_message_chunk')
      .map((notification) => {
        const content = (notification.update as { content: acp.ContentBlock }).content;
        return content.type === 'text' ? content.text : '';
      })
      .join('');
    expect(diagnostics).toContain('fs.writeTextFile');

    const trace = traceOf(prompted);
    expect(trace[0]).toMatchObject({ method: 'fs/write_text_file', ok: false, skipped: true });
    expect(prompted.stopReason).toBe('end_turn');
    expect(await agent.finish()).toEqual({ code: 0, signal: null });
  });
});
