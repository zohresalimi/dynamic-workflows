/**
 * EPIC-05-S1 — a node's turn, end to end, through the one ACP client.
 *
 * A real child process over real pipes and a real file-backed SQLite ledger.
 * Nothing here mocks `child_process`: the spawn, the ndjson framing, the
 * `nextUpdate()` pull loop and the teardown are the surface under test, and
 * they all live on the other side of that boundary.
 *
 * Verifies: EPIC-05-S1 · AC1, AC2, AC3, AC4 · test plan #1, #3
 */

import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { CLIENT_CAPABILITIES, runAcpNode } from '../../src/index.ts';
import {
  eventOf,
  mockAgentBinary,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  type TestLedger,
} from './support/harness.ts';

let dir = '';
let worktree = '';
let ledger: TestLedger;

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  await mkdir(worktree, { recursive: true });
  ledger = openTestLedger(dir);
});

afterEach(async () => {
  ledger.close();
  await removeTempDir(dir);
});

/** Live processes in the group, ignoring zombies: after a successful reap the
 * OS still lists a `Z` entry until the parent collects it. */
function liveInGroup(pgid: number): string[] {
  try {
    return execFileSync('ps', ['-o', 'pid=,stat=', '-g', String(pgid)], { encoding: 'utf8' })
      .split('\n')
      .map((row) => row.trim())
      .filter((row) => row !== '' && !/\sZ/.test(row) && !row.endsWith('Z'));
  } catch {
    // `ps` exits non-zero when the group is empty, which is the answer.
    return [];
  }
}

suite('a full prompt cycle', () => {
  it('runs the turn and leaves the ledger able to explain every step of it', async () => {
    const binary = mockAgentBinary();
    const mcpServers = [
      { name: 'deflow', command: '/usr/bin/deflow-mcp', args: ['--stdio'], env: [] },
    ];

    const outcome = await runAcpNode(
      {
        runId: RUN_ID,
        nodeId: NODE_ID,
        attempt: 0,
        provider: PROVIDER,
        permission: 'worktree',
        worktree,
        binary,
        argv: ['--seed', '42'],
        mcpServers,
        prompt: 'hello',
      },
      { clock: new TestClock(), ledger: ledger.sink, captureEvidence: ledger.captureEvidence },
    );

    expect(outcome.status).toBe('completed');
    if (outcome.status !== 'completed') return;

    // ── the handshake ────────────────────────────────────────────────────
    expect(outcome.protocolVersion).toBe(1);
    expect(typeof outcome.protocolVersion).toBe('number');
    expect(outcome.clientCapabilities).toEqual(CLIENT_CAPABILITIES);
    expect(JSON.stringify(outcome.clientCapabilities)).not.toMatch(/mcp|elicitation/i);

    // ── session/new carried the worktree and the MCP servers ────────────
    expect(outcome.newSessionRequest.cwd).toBe(worktree);
    expect(outcome.newSessionRequest.mcpServers).toEqual(mcpServers);
    expect(outcome.sessionId).toBeTruthy();

    const events = ledger.events();
    const kinds = events.map((event) => event.kind);

    // ── the scheduling decision, then the record written before the work ──
    expect(kinds[0]).toBe('node.scheduled');
    expect(eventOf(events, 'node.scheduled')).toMatchObject({
      node: NODE_ID,
      provider: PROVIDER,
      permission: 'worktree',
    });

    expect(kinds[1]).toBe('node.started');
    expect(eventOf(events, 'node.started')).toMatchObject({
      node: NODE_ID,
      attempt: 0,
      binary: { path: binary.path, version: binary.version, sha256: binary.sha256 },
    });

    // AC3: the sessionId is in the ledger, against the node, before any
    // update can refer to it.
    const opened = events.find((event) => event.payload.phase === 'session.opened');
    expect(opened?.payload.message).toContain(outcome.sessionId);
    expect(opened?.seq).toBeGreaterThan(events[1]?.seq ?? 0);

    // ── every chunk became one event, in arrival order ───────────────────
    const chunkEvents = events.filter((event) => event.payload.phase === 'agent_message_chunk');
    expect(chunkEvents.length).toBeGreaterThanOrEqual(2);
    expect(chunkEvents.map((event) => event.seq)).toEqual(
      [...chunkEvents.map((event) => event.seq)].sort((a, b) => a - b),
    );
    expect(chunkEvents.map((event) => event.payload.message).join('')).toContain('You said: hello');

    // The frames themselves are in the data plane, one row per event, and the
    // control-plane row points at the row rather than carrying it.
    const io = ledger.chunks();
    const pointing = events.filter((event) => event.payload.ioChunkSeq !== undefined);
    expect(io).toHaveLength(pointing.length);
    expect(io.length).toBe(chunkEvents.length);
    expect(chunkEvents.every((event) => typeof event.payload.ioChunkSeq === 'number')).toBe(true);
    expect(JSON.parse(io[0]?.text ?? '{}')).toMatchObject({ method: 'session/update' });

    // ── the turn ended cleanly, and is recorded as having ────────────────
    expect(outcome.stopReason).toBe('end_turn');
    const completed = eventOf(events, 'node.completed');
    expect(completed).toMatchObject({ node: NODE_ID, attempt: 0 });
    const result = completed?.result as { usage: { source: string }; status: string };
    expect(result.status).toBe('completed');
    // F3.6/§8: a token count without a source is a number with no meaning.
    expect(['vendor-reported', 'estimated']).toContain(result.usage.source);

    // ── and the process is gone, with nothing left in its group ──────────
    expect(outcome.exit).toEqual({ code: 0, signal: null });
    expect(liveInGroup(outcome.pgid)).toEqual([]);
  });
});
