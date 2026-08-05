/**
 * EPIC-04-S5 — `tool_call` walks every status the ACP schema defines.
 *
 * `ToolCallStatus` is `pending | in_progress | completed | failed`, and an
 * adapter that only ever sees `pending` and `completed` in its fixtures will
 * happily ship a projection that drops the other two. `ToolCallLocation.path`
 * is asserted on every frame for a sharper reason: it is what lets EPIC-08
 * enforce path scope **at request time** rather than detect a violation after
 * the fact (F5.3), so a scenario that omitted it would leave the permission
 * ladder's best lever untested.
 *
 * Verifies: EPIC-04-S5 · AC3 · test plan row 3
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import {
  CLIENT_CAPABILITIES,
  connectClient,
  scenarioPath,
  spawnMockAgent,
} from '../support/harness.ts';

let cwd = '';
let updates: acp.SessionNotification[] = [];

// One turn, read by every assertion below. The nine tool calls are independent
// of each other, so nine spawns would cost nine process starts to learn the
// same thing.
beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'DeFlow-'));
  const agent = spawnMockAgent([
    '--seed',
    '42',
    '--scenario',
    scenarioPath('tool-call-statuses.jsonc'),
  ]);
  const client = connectClient(agent);
  await client.connection.agent.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: CLIENT_CAPABILITIES,
  });
  const session = await client.connection.agent.request('session/new', { cwd, mcpServers: [] });
  const prompted = await client.connection.agent.request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'use every tool' }],
  });
  expect(prompted.stopReason).toBe('end_turn');
  expect(await agent.finish()).toEqual({ code: 0, signal: null });
  updates = client.updates;
});

afterAll(async () => {
  if (process.env.DeFlow_KEEP_TMP === undefined) await rm(cwd, { recursive: true, force: true });
});

/** The status path declared for each `ToolKind` in EPIC-04-S5's Examples table. */
const examples = [
  ['read', ['pending', 'in_progress', 'completed']],
  ['edit', ['pending', 'in_progress', 'completed']],
  ['execute', ['pending', 'in_progress', 'failed']],
  ['search', ['pending', 'completed']],
  ['delete', ['pending', 'in_progress', 'completed']],
  ['move', ['pending', 'in_progress', 'failed']],
  ['think', ['pending', 'completed']],
  ['fetch', ['pending', 'in_progress', 'completed']],
  ['other', ['pending', 'failed']],
] as const;

/** Every notification belonging to the one tool call of kind `toolKind`. */
function toolCallFrames(toolKind: string) {
  const opening = updates.find(
    (notification) =>
      notification.update.sessionUpdate === 'tool_call' &&
      (notification.update as { kind?: string }).kind === toolKind,
  );
  const toolCallId = (opening?.update as { toolCallId?: string } | undefined)?.toolCallId;
  return updates.filter(
    (notification) =>
      (notification.update as { toolCallId?: string }).toolCallId === toolCallId &&
      toolCallId !== undefined,
  );
}

suite.each(examples)('EPIC-04-S5 — kind %s', (toolKind, statusPath) => {
  it(`walks ${statusPath.join(',')} in order`, () => {
    const frames = toolCallFrames(toolKind);
    expect(frames).toHaveLength(statusPath.length);

    // The first frame opens the call; every later one updates it.
    expect(frames[0]?.update.sessionUpdate).toBe('tool_call');
    for (const frame of frames.slice(1)) {
      expect(frame.update.sessionUpdate).toBe('tool_call_update');
    }

    expect(frames.map((frame) => (frame.update as { status?: string }).status)).toEqual([
      ...statusPath,
    ]);
  });

  it('carries a ToolCallLocation with a non-empty path on every frame', () => {
    for (const frame of toolCallFrames(toolKind)) {
      const locations = (frame.update as { locations?: { path?: string }[] }).locations ?? [];
      expect(locations.length).toBeGreaterThanOrEqual(1);
      expect(locations[0]?.path).toBeTruthy();
    }
  });
});

suite('EPIC-04-S5 — the ids are the agent’s own, and distinct', () => {
  it('gives each tool call its own toolCallId', () => {
    const ids = new Set(
      updates
        .filter((notification) => notification.update.sessionUpdate === 'tool_call')
        .map((notification) => (notification.update as { toolCallId: string }).toolCallId),
    );
    expect(ids.size).toBe(examples.length);
  });
});
