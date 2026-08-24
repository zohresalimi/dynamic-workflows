/**
 * KAR-23.11 — the built-in turn keeps its node's promise, over a real process
 * and a real wire.
 *
 * The unit spec beside this one decides *what* the path and the bytes are. What
 * can only be answered here is whether the frame is ever sent: `session/prompt`
 * has to call back **into the client** while it is still pending, which is the
 * one thing an in-process call cannot demonstrate and the exact shape of the
 * defect this story exists for — an agent that concluded it was read-only and
 * completed anyway.
 *
 * Verifies: KAR-23.11
 */
import { WORK_PRODUCT_BASENAME } from '@DeFlow/mock-agent';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  CLIENT_CAPABILITIES,
  type ClientStubs,
  connectClient,
  spawnMockAgent,
} from '../support/harness.ts';

let cwd = '';

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'DeFlow-'));
});

afterEach(async () => {
  if (process.env.DeFlow_KEEP_TMP === undefined) await rm(cwd, { recursive: true, force: true });
});

/** The pinned path-scope segment DeFlow puts in every agent node's packet. */
const brief = (globs: readonly string[]): string =>
  [
    'Goal (pinned, verbatim from the approved spec):',
    'Carry out the submitted task in this repository, and leave it green.',
    '',
    'Declared path scopes (pinned):',
    ...(globs.length === 0
      ? ['- this node declares no write scope and must not write']
      : globs.map((glob) => `- write: ${glob}`)),
    '',
    `Permission level (pinned): ${globs.length === 0 ? 'read' : 'worktree'}`,
  ].join('\n');

async function turn(input: {
  readonly prompt: string;
  readonly capabilities?: unknown;
  readonly stubs?: ClientStubs;
}): Promise<{ readonly calls: readonly { method: string; params: Record<string, unknown> }[] }> {
  const agent = spawnMockAgent(['--seed', '42']);
  const { connection, calls } = connectClient(agent, input.stubs ?? {});
  await connection.agent.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: (input.capabilities ?? CLIENT_CAPABILITIES) as acp.ClientCapabilities,
  });
  const session = await connection.agent.request('session/new', { cwd, mcpServers: [] });
  const prompted = await connection.agent.request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: input.prompt }],
  });

  // Whatever happened to the write, the turn ends the way a turn ends. A
  // refusal is an answer, not a crash.
  expect(prompted.stopReason).toBe('end_turn');
  await agent.finish();
  return { calls };
}

suite('KAR-23.11 — a node that declared a write scope writes something', () => {
  it('sends one fs/write_text_file, absolute and inside the declared scope', async () => {
    const { calls } = await turn({ prompt: brief(['src/**']) });

    const writes = calls.filter((call) => call.method === 'fs/write_text_file');
    expect(writes.length).toBe(1);
    // Absolute, resolved against the cwd `session/new` opened the session with:
    // that is what ACP's WriteTextFileRequest asks for, and a client that
    // mediates paths has to be given something real to resolve.
    expect(writes[0]?.params.path).toBe(join(cwd, 'src', `${WORK_PRODUCT_BASENAME}.md`));
    expect(String(writes[0]?.params.content).length).toBeGreaterThan(0);
  });

  it('writes nothing for a node the plan told not to write', async () => {
    // The reviewer / verifier case. `auditCompletionScope` returns early for it
    // and never asks for a diff — so an agent that wrote here would be writing
    // outside a scope it does not have.
    const { calls } = await turn({ prompt: brief([]) });

    expect(calls.filter((call) => call.method === 'fs/write_text_file')).toEqual([]);
  });

  it('writes nothing when the client never advertised fs.writeTextFile', async () => {
    // The same rule ./../../src/scripted.ts keeps for a scripted `clientCall`:
    // ACP v2 removes the seven client methods, and an agent that called one
    // regardless would hide that migration behind a client stub that answers
    // anyway.
    const { calls } = await turn({
      prompt: brief(['**']),
      capabilities: { fs: { readTextFile: true, writeTextFile: false }, terminal: true },
    });

    expect(calls.filter((call) => call.method === 'fs/write_text_file')).toEqual([]);
  });

  it('reports a refused write rather than claiming it happened', async () => {
    const { calls } = await turn({
      prompt: brief(['**']),
      stubs: {
        respond: (method) => {
          if (method !== 'fs/write_text_file') return undefined;
          throw new acp.RequestError(-32_000, 'fs/write_text_file denied: level-read');
        },
      },
    });

    expect(calls.filter((call) => call.method === 'fs/write_text_file').length).toBe(1);
  });
});
