/**
 * KAR-04.1 AC4 — the same seed produces the same bytes.
 *
 * Byte-identity, not snapshot-equality after normalisation, is the bar. This is
 * what makes the crash-fuzz suite's pre-crash side deterministic so that the
 * only variable left is where the knife lands
 * (docs/14-testing-strategy.md §11). A normalising comparison would hide
 * exactly the nondeterminism that matters: a `crypto.randomUUID()` in the id
 * factory survives every serializer this repo owns.
 *
 * Verifies: EPIC-04-S2 · AC4
 */
import { expect, it, describe as suite } from 'vitest';
import { connectClient, frames, spawnMockAgent } from '../support/harness.ts';

/** Identical for every run, so the child's input is identical too. */
const CWD = process.cwd();

/** What `crypto.randomUUID()` emits. Its absence is the assertion. */
const UUID_V4 = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

async function runTurn(seed: string): Promise<Buffer> {
  const agent = spawnMockAgent(['--seed', seed]);
  const { connection } = connectClient(agent);

  await connection.agent.request('initialize', { protocolVersion: 1 });
  const session = await connection.agent.request('session/new', { cwd: CWD, mcpServers: [] });
  await connection.agent.request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'hello' }],
  });
  await connection.agent.request('session/close', { sessionId: session.sessionId });

  const exit = await agent.finish();
  expect(exit.code).toBe(0);
  return agent.stdout();
}

function sessionIdOf(stdout: Buffer): string {
  for (const frame of frames(stdout)) {
    const result = frame.result as { sessionId?: string } | undefined;
    if (result?.sessionId !== undefined) return result.sessionId;
  }
  throw new Error('no session/new response found in the captured stdout');
}

suite('EPIC-04-S2 — byte-reproducible output under --seed', () => {
  it('produces byte-identical stdout across two runs at the same seed', async () => {
    const first = await runTurn('42');
    const second = await runTurn('42');

    expect(first.length).toBeGreaterThan(0);
    expect(Buffer.compare(first, second)).toBe(0);
    expect(first.toString('utf8')).not.toMatch(UUID_V4);
  });

  it('changes every generated id at a different seed, and nothing else', async () => {
    const at42 = await runTurn('42');
    const at43 = await runTurn('43');

    expect(sessionIdOf(at43)).not.toBe(sessionIdOf(at42));
    // A constant frame count across seeds is what proves the seed drives ids
    // and the clock only, never control flow.
    expect(frames(at43)).toHaveLength(frames(at42).length);
  });
});
