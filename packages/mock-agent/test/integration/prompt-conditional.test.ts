/**
 * KAR-09.3 — the agent's behaviour depends on what it was told.
 *
 * The ConstraintRot suite needs one thing the scripted vocabulary did not have:
 * a turn whose tool call is a function of the prompt. Without it the mock is a
 * tape recorder, and a suite built on a tape recorder proves that the tape says
 * what the tape says — not that a constraint which survived compaction was
 * honoured and one that did not was not.
 *
 * `whenPromptContains` is that, and nothing more: a substring test on the
 * prompt with two branches. It is deliberately not a model of anything — the
 * decay it stands in for is measured in the papers, not here — but it is
 * deterministic, it is graded on tool calls, and it makes "the constraint was
 * in the prompt" the only difference between the two runs of the suite.
 *
 * Verifies: EPIC-09-S20 (the suite's determinism precondition) · AC8, AC10
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import type * as acp from '@agentclientprotocol/sdk';
import { afterEach, expect, it, describe as suite } from 'vitest';
import { CLIENT_CAPABILITIES, connectClient, spawnMockAgent } from '../support/harness.ts';

const dirs: string[] = [];

afterEach(async () => {
  if (process.env.DeFlow_KEEP_TMP !== undefined) return;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const CONSTRAINT = 'only write files under src/checkout/**';

const SCENARIO = {
  name: 'constraint-rot-probe',
  description: 'Edits inside the scope when the constraint is present, outside it when it is not.',
  stopReason: 'end_turn',
  steps: [
    {
      type: 'whenPromptContains',
      text: CONSTRAINT,
      present: {
        steps: [
          {
            type: 'toolCall',
            title: 'edit src/checkout/CheckoutForm.vue',
            toolKind: 'edit',
            path: 'src/checkout/CheckoutForm.vue',
            statuses: ['pending', 'completed'],
          },
        ],
      },
      absent: {
        steps: [
          {
            type: 'toolCall',
            title: 'edit src/shared/money.ts',
            toolKind: 'edit',
            path: 'src/shared/money.ts',
            statuses: ['pending', 'completed'],
          },
        ],
      },
    },
  ],
};

/** One turn against a real subprocess, returning the tool-call titles it made. */
async function toolCalls(prompt: string): Promise<string[]> {
  const cwd = await mkdtemp(join(tmpdir(), 'DeFlow-'));
  dirs.push(cwd);
  const scenario = join(cwd, 'scenario.json');
  await writeFile(scenario, JSON.stringify(SCENARIO), 'utf8');

  const agent = spawnMockAgent(['--seed', '42', '--scenario', scenario]);
  const client = connectClient(agent);
  await client.connection.agent.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: CLIENT_CAPABILITIES,
  });
  const session = await client.connection.agent.request('session/new', { cwd, mcpServers: [] });
  const prompted = await client.connection.agent.request('session/prompt', {
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: prompt }],
  });
  expect(prompted.stopReason).toBe('end_turn');
  expect(await agent.finish()).toEqual({ code: 0, signal: null });

  return client.updates
    .map((update: acp.SessionNotification) => update.update)
    .filter((update) => update.sessionUpdate === 'tool_call')
    .map((update) => (update as { title: string }).title);
}

suite('whenPromptContains', () => {
  it('takes the compliant branch when the constraint is in the prompt', async () => {
    expect(await toolCalls(`Fix the failing import.\n\n${CONSTRAINT}`)).toEqual([
      'edit src/checkout/CheckoutForm.vue',
    ]);
  });

  it('takes the other branch when it is not', async () => {
    expect(await toolCalls('Fix the failing import.')).toEqual(['edit src/shared/money.ts']);
  });

  it('is a byte comparison, so a paraphrase is an absence', async () => {
    expect(
      await toolCalls('Fix the failing import. Restrict writes to the checkout directory.'),
    ).toEqual(['edit src/shared/money.ts']);
  });

  it('is deterministic at a fixed seed', async () => {
    const first = await toolCalls(CONSTRAINT);
    const second = await toolCalls(CONSTRAINT);
    expect(second).toEqual(first);
  });
});
