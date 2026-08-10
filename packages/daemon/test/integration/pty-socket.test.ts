/**
 * EPIC-15-S48 — the interactive terminal channel, end to end.
 *
 * Integration and nothing else, because every claim in the scenario is about a
 * boundary: a real `server.on('upgrade', …)` on the same `node:http` server
 * Hono serves from, a real socket that must be **refused before it exists**, a
 * real pty whose child observes real keystrokes and a real `SIGWINCH`, and a
 * real `io_chunk` table that keeps filling after the viewer has gone. Every one
 * of those is exactly what a unit test would replace.
 *
 * The refusal assertions are the ones worth reading twice. "No `connection`
 * event fires" is not observable by asking the socket — there is no socket —
 * so it is asserted from the other side: the session's viewer count never
 * moves, and the daemon answers on the connection with an ordinary HTTP
 * envelope, which is what an upgrade refused *before* the handshake looks like
 * on the wire.
 *
 * Verifies: EPIC-15-S48 · KAR-15.8 AC1, AC2, AC3, AC4, AC5 · test plan #1–#4
 */
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { type Db, openLedger, openRead, readIoChunks } from '@DeFlow/ledger';
import { it, TEST_DAEMON_TOKEN, waitFor } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { systemClock } from '../../src/clock.ts';
import { installPtyUpgrade } from '../../src/http/pty-socket.ts';
import { clearUpgradeHandler, startHttp } from '../../src/http/server.ts';
import { ledgerPtySink } from '../../src/pty/ledger-pty-sink.ts';
import { openPtySession, type PtySession } from '../../src/pty/pty-session.ts';
import { clearPtySessions, registerPtySession } from '../../src/pty/pty-sessions.ts';
import { openWs, UpgradeRefused } from './support/ws-client.ts';

const CHILD = fileURLToPath(new URL('./support/pty-child.ts', import.meta.url));

const RUN = RunIdSchema.parse('run_20260810T101500Z_ac1542');
const NODE = NodeIdSchema.parse('n-impl');
const OTHER = NodeIdSchema.parse('n-review');

const bearer = { Authorization: `Bearer ${TEST_DAEMON_TOKEN}` };

interface Terminal {
  readonly origin: string;
  readonly url: string;
  readonly session: PtySession;
  readonly tmp: string;
  close(): Promise<void>;
}

const opened: Terminal[] = [];

afterEach(async () => {
  for (const terminal of opened.splice(0)) await terminal.close();
  clearPtySessions();
  clearUpgradeHandler();
});

/** A daemon on an ephemeral port with one live pty registered against a node. */
async function terminal(tmp: string): Promise<Terminal> {
  const db: Db = openLedger(tmp);
  const session = await openPtySession({
    runId: RUN,
    nodeId: NODE,
    attempt: 1,
    command: process.execPath,
    args: [CHILD],
    cwd: tmp,
    env: { PATH: process.env.PATH ?? '', TERM: 'xterm-256color' },
    cols: 80,
    rows: 24,
    sink: ledgerPtySink({ db, runId: RUN, nodeId: NODE, attempt: 1, clock: systemClock }),
  });
  registerPtySession(session);
  installPtyUpgrade();

  const started = await startHttp({
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
    token: TEST_DAEMON_TOKEN,
  });
  const { port } = started.server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  const live: Terminal = {
    origin,
    url: `${origin}/api/pty/${RUN}/${NODE}`,
    session,
    tmp,
    close: async () => {
      session.kill();
      await started.close();
      db.close();
    },
  };
  opened.push(live);
  return live;
}

const durableOutput = (tmp: string): string => {
  const db = openRead(join(tmp, 'ledger.db'));
  try {
    const page = readIoChunks(db, { runId: RUN, nodeId: NODE, attempt: 1 }, 0, 10_000);
    return page.chunks.map((chunk) => Buffer.from(chunk.data).toString('utf8')).join('');
  } finally {
    db.close();
  }
};

suite('an unauthenticated upgrade (AC2, test plan #1)', () => {
  it('is refused before the socket is accepted, and no viewer ever attaches', async ({ tmp }) => {
    const live = await terminal(tmp);

    const refusal = await openWs(live.url).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(UpgradeRefused);
    expect((refusal as UpgradeRefused).status).toBe(401);
    expect((refusal as UpgradeRefused).code).toBe('missing_token');
    // The scenario's "no connection event fires", asserted from the only place
    // it is observable: nothing ever attached to the pty.
    expect(live.session.viewers).toBe(0);
  });

  it('is refused for a hostile Origin even with a valid token (DNS rebinding)', async ({ tmp }) => {
    const live = await terminal(tmp);

    const refusal = await openWs(live.url, {
      headers: { ...bearer, Origin: 'http://attacker.example' },
    }).catch((error: unknown) => error);

    expect((refusal as UpgradeRefused).status).toBe(403);
    expect((refusal as UpgradeRefused).code).toBe('bad_origin');
    expect(live.session.viewers).toBe(0);
  });

  it('is refused with 404 for a node that has no live terminal', async ({ tmp }) => {
    const live = await terminal(tmp);

    const refusal = await openWs(`${live.origin}/api/pty/${RUN}/${OTHER}`, {
      headers: bearer,
    }).catch((error: unknown) => error);

    expect((refusal as UpgradeRefused).status).toBe(404);
    expect(live.session.viewers).toBe(0);
  });

  it('is refused when the WebSocket handshake headers are missing', async ({ tmp }) => {
    const live = await terminal(tmp);

    const refusal = await openWs(live.url, { headers: bearer, handshake: false }).catch(
      (error: unknown) => error,
    );

    expect((refusal as UpgradeRefused).status).toBe(400);
    expect(live.session.viewers).toBe(0);
  });
});

suite('an authenticated session (AC1, AC3, test plan #2, #3)', () => {
  it('upgrades on the same node:http server that answers /api/health (AC1)', async ({ tmp }) => {
    const live = await terminal(tmp);

    const health = await fetch(`${live.origin}/api/health`);
    const socket = await openWs(live.url, { headers: bearer });

    expect(health.status).toBe(200);
    expect(socket.headers['upgrade']?.toLowerCase()).toBe('websocket');
    // One port, one server, one origin (D10): the upgrade did not open a
    // second listener, and the same daemon answered both.
    expect(live.session.viewers).toBe(1);
    await socket.close();
  });

  it('writes binary frames into the pty, and the child answers on it', async ({ tmp }) => {
    const live = await terminal(tmp);
    const socket = await openWs(live.url, { headers: bearer });

    socket.sendBinary(Buffer.from('echo alpha\r'));

    await waitFor(() => socket.output().includes('echoed alpha'), {
      describe: `the child's answer to arrive as a binary frame (saw ${JSON.stringify(socket.output())})`,
    });
    await socket.close();
  });

  it('resizes the pty, and the child observes the new dimensions', async ({ tmp }) => {
    const live = await terminal(tmp);
    const socket = await openWs(live.url, { headers: bearer });

    socket.sendBinary(Buffer.from('size\r'));
    await waitFor(() => socket.output().includes('size 80x24'), {
      describe: 'the child to report the dimensions it started with',
    });

    socket.sendText('{"t":"resize","cols":120,"rows":40}');

    // Not the daemon's own bookkeeping: this line is the child's, printed from
    // inside the pty on SIGWINCH.
    await waitFor(() => socket.output().includes('size 120x40'), {
      describe: `the child to observe the resize (saw ${JSON.stringify(socket.output())})`,
    });
    await socket.close();
  });

  it('delivers {"t":"exit","code":N} and then closes (AC5)', async ({ tmp }) => {
    const live = await terminal(tmp);
    const socket = await openWs(live.url, { headers: bearer });

    socket.sendBinary(Buffer.from('bye 0\r'));

    await socket.ended;
    expect(socket.texts()).toEqual(['{"t":"exit","code":0}']);
  });

  it('reports a non-zero code rather than a generic failure', async ({ tmp }) => {
    const live = await terminal(tmp);
    const socket = await openWs(live.url, { headers: bearer });

    socket.sendBinary(Buffer.from('bye 3\r'));

    await socket.ended;
    expect(socket.texts()).toEqual(['{"t":"exit","code":3}']);
  });

  it('closes the socket on a text frame it does not understand', async ({ tmp }) => {
    const live = await terminal(tmp);
    const socket = await openWs(live.url, { headers: bearer });

    socket.sendText('{"t":"kill"}');

    await socket.ended;
    // Refused, not obeyed: the socket carries keystrokes, and a node's life is
    // decided through the run-control endpoints (KAR-15.5) where it is audited.
    expect(live.session.exit).toBeNull();
    expect(live.session.viewers).toBe(0);
  });
});

suite('closing the panel loses nothing (AC4, test plan #4)', () => {
  it('keeps appending io_chunk and runs the node to completion', async ({ tmp }) => {
    const live = await terminal(tmp);
    const socket = await openWs(live.url, { headers: bearer });

    socket.sendBinary(Buffer.from('emit 6\r'));
    await waitFor(() => socket.output().includes('line 1'), {
      describe: 'the first line to reach the panel',
    });

    // The operator closes the tab halfway through the output.
    await socket.close();
    expect(live.session.viewers).toBe(0);

    await waitFor(() => durableOutput(tmp).includes('emitted 6'), {
      describe: 'the rest of the output to land in io_chunk after the panel closed',
    });

    // The node is still running: closing a view is not a kill.
    expect(live.session.exit).toBeNull();

    // And the whole conversation is on disk, including what the panel saw.
    const durable = durableOutput(tmp);
    expect(durable).toContain('line 1');
    expect(durable).toContain('line 6');
  });

  it('lets a second panel attach to the same node and see live output', async ({ tmp }) => {
    const live = await terminal(tmp);
    const first = await openWs(live.url, { headers: bearer });
    const second = await openWs(live.url, { headers: bearer });

    expect(live.session.viewers).toBe(2);
    second.sendBinary(Buffer.from('echo shared\r'));

    await waitFor(() => first.output().includes('echoed shared'), {
      describe: 'the first panel to see what the second one typed',
    });
    await waitFor(() => second.output().includes('echoed shared'), {
      describe: 'the second panel to see its own echo',
    });

    await first.close();
    expect(live.session.viewers).toBe(1);
    await second.close();
  });
});
