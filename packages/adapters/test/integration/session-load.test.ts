/**
 * EPIC-05-S21 — `session/load` is not a substitute for `session/resume`.
 *
 * `loadSession` is advertised `true` by every adapter probed, which makes it a
 * tempting stand-in for a capability two of them do not have. It is not one:
 * it streams the entire conversation history back as `session/update`
 * notifications. The mock reproduces that faithfully — `--load-history 400`
 * really does write 400 frames at the client before answering — so the two
 * guards can be tested against a real subprocess rather than a stub that
 * agrees with them.
 *
 * "Never chosen automatically" is asserted in resume.test.ts, which checks
 * that no `session/load` frame appears on the wire for any of the five
 * profiles. This file is about the deliberate diagnostic path.
 *
 * Verifies: EPIC-05-S21 (scenarios 2, 3) · AC6 · test plan #7
 */
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  capability,
  deflowNotificationId,
  diagnoseSessionLoad,
  MAX_LOAD_REPLAY_NOTIFICATIONS,
  selectResumeStrategy,
} from '../../src/index.ts';
import {
  MOCK_AGENT_BIN,
  mockAgentBinary,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  type TestLedger,
} from './support/harness.ts';
import { capabilityRowFor } from './support/resume-fixture.ts';

let dir = '';
let worktree = '';
let ledger: TestLedger;
let child: ChildProcessWithoutNullStreams | null = null;

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  await mkdir(worktree, { recursive: true });
  ledger = openTestLedger(dir);
});

afterEach(async () => {
  child?.stdin.end();
  child = null;
  ledger.close();
  await removeTempDir(dir);
});

const SCOPE = { nodeId: NODE_ID, attempt: 0 };
const SESSION_ID = 'sess_days_long';

/**
 * A real agent that floods `historyLength` notifications on `session/load`,
 * and the port `diagnoseSessionLoad` issues the request through.
 */
function loadPort(historyLength: number): (sessionId: string) => Promise<readonly unknown[]> {
  const replayed: unknown[] = [];
  child = spawn(
    MOCK_AGENT_BIN,
    ['--capabilities', 'gemini', '--load-history', String(historyLength)],
    { stdio: ['pipe', 'pipe', 'pipe'], detached: true },
  );
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const app = acp.client({ name: 'DeFlow' }).onNotification('session/update', ({ params }) => {
    replayed.push(params);
  });
  const connection = app.connect(stream);

  return async (sessionId: string) => {
    await connection.agent.request('initialize', {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'DeFlow', version: '0.0.0' },
    });
    replayed.length = 0;
    await connection.agent.request('session/load', {
      sessionId: sessionId as acp.SessionId,
      cwd: worktree,
      mcpServers: [],
    });
    return [...replayed];
  };
}

const ioRows = (): number => ledger.chunks(0).length;

/** DeFlow's own ids for every notification it has already appended. */
async function knownIds(): Promise<string[]> {
  return await Promise.all(
    ledger.chunks(0).map(async (chunk) => {
      const frame = JSON.parse(chunk.text) as { params: unknown };
      return await deflowNotificationId(SCOPE, frame.params);
    }),
  );
}

suite('a deliberate load is bounded and deduped (EPIC-05-S21 scenario 2)', () => {
  it('appends the history once and gains zero rows the second time', async () => {
    const load = loadPort(400);
    const ports = { clock: new TestClock(), ledger: ledger.sink, load };

    const first = await diagnoseSessionLoad({ ...SCOPE, sessionId: SESSION_ID, known: [] }, ports);
    expect(first).toMatchObject({ status: 'loaded', appended: 400, discarded: 0 });
    expect(ioRows()).toBe(400);

    // The same 400 frames, replayed at DeFlow a second time — the flood a
    // reconnect produces. Keyed on the agent's own ids this would look like
    // 400 new events, because those ids are re-minted across a reconnect.
    const second = await diagnoseSessionLoad(
      { ...SCOPE, sessionId: SESSION_ID, known: await knownIds() },
      ports,
    );
    expect(second).toMatchObject({ status: 'loaded', appended: 0, discarded: 400 });
    expect(ioRows()).toBe(400);

    const warnings = ledger
      .events()
      .filter(
        (event) => event.kind === 'node.progress' && event.payload.phase === 'session.load.deduped',
      );
    expect(warnings).toHaveLength(2);
    expect(warnings.at(-1)?.payload.message).toContain('400');
  });
});

suite('a days-long run is protected (EPIC-05-S21 scenario 3)', () => {
  it('refuses before the frame is sent, and leaves replay as the way home', async () => {
    let asked = 0;
    const outcome = await diagnoseSessionLoad(
      {
        ...SCOPE,
        sessionId: SESSION_ID,
        known: Array.from({ length: 20_000 }, (_, index) => `n1#0#sha256-${index}`),
      },
      {
        clock: new TestClock(),
        ledger: ledger.sink,
        load: async () => {
          asked += 1;
          return [];
        },
      },
    );

    expect(outcome.status).toBe('refused');
    expect(asked).toBe(0);
    if (outcome.status === 'refused') {
      expect(outcome.failure.message).toContain('20000');
      expect(outcome.failure.deflowFailure.detail).toMatchObject({
        cap: MAX_LOAD_REPLAY_NOTIFICATIONS,
      });
    }
    expect(ioRows()).toBe(0);

    // And the run's way home is the one that never needed the agent: the same
    // probed row that advertises loadSession still selects replay.
    const row = capabilityRowFor('gemini', mockAgentBinary());
    expect(capability(row, 'loadSession').supported).toBe(true);
    expect(selectResumeStrategy(row)).toBe('ResumeByReplay');
    expect(PROVIDER).toBeDefined();
  });
});
