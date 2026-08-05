/**
 * EPIC-04-S8 — a genuinely wedged agent, and cancelling through it.
 *
 * A wedge is not an EOF. An agent that closed stdout would give the client a
 * clean end-of-stream and a `null` exit code is never observed; every timeout
 * path downstream would be dead code. So this file asserts the *absence* of
 * bytes over a real interval, with a real child alive — which is also why
 * there are no fake timers anywhere near it (docs/14-testing-strategy.md §8:
 * freezing the loop's timers stops the child's real I/O from being read at
 * all, and the spec would hang instead of failing).
 *
 * The middle spec encodes the requirement that is easy to get backwards: after
 * `session/cancel` a client MUST keep accepting `session/update` notifications
 * (adapter layer §2.5). Stage 1 of the three-stage cancellation is the only
 * stage that produces a clean transcript, and it only works if the agent is
 * allowed to flush its tail before answering the prompt.
 *
 * Verifies: EPIC-04-S8 · KAR-04.3 AC1, AC2 · test plan rows 1, 2, 3
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  CLIENT_CAPABILITIES,
  connectClient,
  frames,
  killProcessGroup,
  type SpawnedAgent,
  scenarioPath,
  spawnMockAgent,
} from '../support/harness.ts';

let cwd = '';
const spawned: SpawnedAgent[] = [];

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'DeFlow-'));
});

afterEach(async () => {
  // A wedged agent never exits on its own: every spec here has to reap its
  // own process group or the slice leaks a child per run.
  for (const agent of spawned.splice(0)) killProcessGroup(agent);
  if (process.env.DeFlow_KEEP_TMP === undefined) await rm(cwd, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Polls until `predicate` holds, or throws once `timeoutMs` has passed. */
async function waitFor(what: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

function start(scenario: string): SpawnedAgent {
  const agent = spawnMockAgent(['--seed', '42', '--scenario', scenarioPath(scenario)]);
  spawned.push(agent);
  return agent;
}

suite('EPIC-04-S8 — the agent stops emitting and does not exit', () => {
  it('writes nothing for 500 ms, stays alive, and leaves stdout open', async () => {
    const agent = start('hang-forever.jsonc');
    const { connection, updates } = connectClient(agent);

    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await connection.agent.request('session/new', { cwd, mcpServers: [] });
    const prompted = connection.agent
      .request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'wedge please' }],
      })
      // The turn is never answered in this spec; without a handler the kill in
      // afterEach surfaces as an unhandled rejection in a neighbouring file.
      .catch(() => null);

    await waitFor('the two chunks before the wedge', () => updates.length >= 2);
    const bytesAtWedge = agent.stdout().length;

    await sleep(500);

    expect(agent.stdout().length).toBe(bytesAtWedge);
    expect(updates).toHaveLength(2);
    expect(agent.child.exitCode).toBeNull();
    expect(agent.child.signalCode).toBeNull();
    // Not an EOF: a client that saw end-of-stream would tear down and call it
    // a clean finish, and the timeout path would never be reached.
    expect(agent.child.stdout.readableEnded).toBe(false);
    expect(agent.child.stdout.destroyed).toBe(false);

    connection.close();
    await prompted;
  });
});

suite('EPIC-04-S8 — cancel flushes the tail and then stops the turn', () => {
  it('delivers the declared trailing updates before the cancelled response', async () => {
    const agent = start('hang-forever.jsonc');
    const { connection, updates } = connectClient(agent);

    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await connection.agent.request('session/new', { cwd, mcpServers: [] });
    const prompted = connection.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'wedge please' }],
    });

    await waitFor('the two chunks before the wedge', () => updates.length >= 2);
    await connection.agent.notify('session/cancel', { sessionId: session.sessionId });

    expect(await prompted).toMatchObject({ stopReason: 'cancelled' });

    // The client kept its reader running throughout — four notifications, not
    // two, and the last two only exist because the turn was cancelled.
    expect(updates).toHaveLength(4);
    const texts = updates.map((notification) =>
      notification.update.sessionUpdate === 'agent_message_chunk' &&
      notification.update.content.type === 'text'
        ? notification.update.content.text
        : '',
    );
    expect(texts.slice(2)).toEqual(['flushing tail 1', 'flushing tail 2']);

    // Ordering is asserted on the wire rather than on arrival timestamps: the
    // bytes are the record, and two async handlers in one client could resolve
    // in either order without the agent having done anything wrong.
    const wire = frames(agent.stdout());
    const last = wire.at(-1) as { result?: { stopReason?: string } };
    expect(last.result?.stopReason).toBe('cancelled');
    expect(wire.slice(-3, -1).map((frame) => frame.method)).toEqual([
      'session/update',
      'session/update',
    ]);

    expect(await agent.finish()).toEqual({ code: 0, signal: null });
  });
});

suite('EPIC-04-S8 — an agent that ignores cancel', () => {
  it('never answers the prompt and is still alive a second later', async () => {
    const agent = start('hang-forever-ignoring-cancel.jsonc');
    const { connection, updates } = connectClient(agent);

    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await connection.agent.request('session/new', { cwd, mcpServers: [] });

    let settled = false;
    const prompted = connection.agent
      .request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'ignore my cancel' }],
      })
      .catch(() => null)
      .finally(() => {
        settled = true;
      });

    await waitFor('the chunk before the wedge', () => updates.length >= 1);
    await connection.agent.notify('session/cancel', { sessionId: session.sessionId });
    await sleep(1_000);

    expect(settled).toBe(false);
    expect(agent.child.exitCode).toBeNull();
    expect(agent.child.signalCode).toBeNull();
    // Still there. This is precisely the state the SIGTERM escalation in
    // KAR-05.9 has to resolve; nothing at this layer can.
    expect(() => process.kill(agent.child.pid as number, 0)).not.toThrow();

    connection.close();
    await prompted;
  });
});
