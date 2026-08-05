/**
 * EPIC-04-S10 and EPIC-04-S11 — the two ways a frame can be wrong, kept apart.
 *
 * `adapter.malformed-output` and `adapter.protocol-error` are separate reasons
 * in docs/04-domain-model.md §8: one means the agent is broken, the other means
 * the agent and the SDK disagree about the wire shape — typically after an
 * upstream SDK bump. A parser that conflates them cannot report honestly, so
 * the stimuli are asserted against two different oracles here: `JSON.parse`
 * for the first, and `@agentclientprotocol/sdk/schema/schema.json` for the
 * second, which is the only conformance oracle ACP has.
 *
 * Verifies: EPIC-04-S10, EPIC-04-S11 · KAR-04.3 AC4, AC5, AC8 · test plan rows 5, 6
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { invalidFrame } from '../../src/pathological.ts';
import {
  CLIENT_CAPABILITIES,
  connectClient,
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

const acpSchema = JSON.parse(
  readFileSync(
    fileURLToPath(import.meta.resolve('@agentclientprotocol/sdk/schema/schema.json')),
    'utf8',
  ),
) as Record<string, unknown>;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

/** Every non-empty line the child wrote, unparsed — the bytes are the record. */
function lines(stdout: Buffer): string[] {
  return stdout
    .toString('utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function parses(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

suite('EPIC-04-S10 — an unbalanced brace on its own line', () => {
  it('writes a complete line that JSON.parse rejects, then valid frames after it', async () => {
    const agent = spawnMockAgent([
      '--seed',
      '42',
      '--scenario',
      scenarioPath('malformed-line.jsonc'),
    ]);
    const { connection } = connectClient(agent);

    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await connection.agent.request('session/new', { cwd, mcpServers: [] });
    const prompted = await connection.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'lie to me' }],
    });
    expect(prompted.stopReason).toBe('end_turn');

    const written = lines(agent.stdout());
    const at = written.findIndex((line) => !parses(line));
    expect(at, 'a malformed line was written').toBeGreaterThan(-1);

    const malformed = written[at] as string;
    expect(() => JSON.parse(malformed)).toThrow(SyntaxError);
    expect(malformed).toContain('{');
    // A *complete* line: it was terminated by a newline, so a line reader
    // hands the whole broken thing to the parser rather than waiting forever.
    expect(agent.stdout().toString('utf8')).toContain(`${malformed}\n`);

    // The two well-formed frames that follow. This is what makes the client's
    // recovery-vs-teardown decision testable rather than academic.
    const after = written.slice(at + 1);
    expect(after.length).toBeGreaterThanOrEqual(2);
    for (const line of after) expect(parses(line)).toBe(true);

    expect(await agent.finish()).toEqual({ code: 0, signal: null });
  });

  it('pins what the stock SDK does with it: skip and carry on', async () => {
    // Recorded deliberately, because it is the behaviour DeFlow must NOT
    // inherit. `ndJsonStream` (dist/stream.js) catches the parse error, logs to
    // console.error and keeps reading, so the frames after a malformed line are
    // delivered as if nothing happened — half a turn silently accepted. The
    // architecture's position is that a malformed frame tears the session down;
    // enforcing that is KAR-05.4's job, and this assertion is the reason it has
    // one. If a future SDK starts tearing down here, this spec goes red and the
    // decision gets revisited on purpose instead of by accident.
    const agent = spawnMockAgent(['--seed', '42', '--malformed-line']);
    const { connection, updates } = connectClient(agent);

    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await connection.agent.request('session/new', { cwd, mcpServers: [] });
    await connection.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'lie to me' }],
    });

    expect(updates).toHaveLength(3);
    expect(await agent.finish()).toEqual({ code: 0, signal: null });
  });
});

suite('EPIC-04-S11 — valid JSON that the ACP schema rejects', () => {
  it('puts a frame on the wire that parses and fails ajv at params.update.sessionUpdate', async () => {
    const agent = spawnMockAgent(['--seed', '42', '--invalid-frame']);
    const { connection } = connectClient(agent);

    await connection.agent.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: CLIENT_CAPABILITIES,
    });
    const session = await connection.agent.request('session/new', { cwd, mcpServers: [] });
    // Not awaited: an unknown `sessionUpdate` is precisely the kind of frame a
    // client's own parser may reject, and the assertion is about the bytes the
    // agent wrote, not about whether this client survived reading them.
    void connection.agent
      .request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'send me nonsense' }],
      })
      .catch(() => null);

    await waitFor('the invalid frame', () =>
      agent.stdout().toString('utf8').includes('agent_thought_stream_v3'),
    );

    const frame = lines(agent.stdout())
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .find(
        (parsed) =>
          parsed !== null &&
          (parsed.params as { update?: { sessionUpdate?: string } } | undefined)?.update
            ?.sessionUpdate === 'agent_thought_stream_v3',
      );

    expect(frame, 'the invalid frame parsed as JSON').toBeDefined();

    const ajv = new Ajv2020.default({ allErrors: true, strict: false, logger: false });
    ajv.addSchema(acpSchema, 'acp');
    const validate = ajv.compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $ref: 'acp#/$defs/SessionNotification',
    });

    expect(validate((frame as Record<string, unknown>).params)).toBe(false);
    expect((validate.errors ?? []).map((error) => error.instancePath).join(' ')).toContain(
      '/update/sessionUpdate',
    );

    // The two failures are distinguishable, which is the whole reason
    // `adapter.protocol-error` and `adapter.malformed-output` are separate.
    expect(() => JSON.stringify(frame)).not.toThrow();

    expect(await agent.finish()).toEqual({ code: 0, signal: null });
  });

  it('offers the other schema violations EPIC-04-S11 tabulates', () => {
    // The wire-level spec above covers one variant end to end; the remaining
    // four are covered against the same oracle in ../pathological-frames.test.ts,
    // which is a unit test because compiling 262 $defs per variant does not
    // need a subprocess.
    expect(invalidFrame('unknownStopReason', { sessionId: 's', requestId: 3 }).subject).toBe(
      'result',
    );
  });
});
