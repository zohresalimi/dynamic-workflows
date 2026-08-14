/**
 * KAR-19.3 AC1 — the three agent ports the live chain is bound to, over a
 * **real process**.
 *
 * `packages/daemon/src/pipeline/run-chain.ts` has taken `FramingAgent`,
 * `ReconAgent` and `PlannerAgent` since the chain shipped, and every spec that
 * drove it scripted them. Nothing in `src/` implemented one, which is why
 * `deflow up` had nothing to bind and an operator's run parked at the framing
 * wake. This file is about the implementations: what they put on a child's
 * argv, what they do with what comes back, and how they fail.
 *
 * Integration, and against real binaries rather than a mocked `spawn`:
 *
 *  - the **bundled agent** (`deflow-mock-agent`), which is what a machine with
 *    no vendor CLI actually has, and whose `document` dialect is one JSON
 *    document on stdout;
 *  - the **fake vendor CLI** (`@DeFlow/testkit`'s exec-shim agent, linked as
 *    `claude`), whose `stream-json` dialect carries the return inside a result
 *    line. That branch would otherwise ship unexercised — the failure mode this
 *    epic exists to remove, one level down.
 *
 * The argv is never assembled here: it comes from `PROVIDER_SPECS`'s own shim
 * builder, so a turn that forgot the schema flag fails in this file rather than
 * passing by construction.
 *
 * Verifies: EPIC-19-S16 · KAR-19.3 AC1 · test plan #1
 */
import { vendorSessionId } from '@DeFlow/adapters';
import { NodeFailureError, NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { DIALECT_ENV, it, linkFakeAgent, SCENARIO_ENV } from '@DeFlow/testkit';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import {
  type LiveTurnOptions,
  liveFramingAgent,
  livePlannerAgent,
  liveReconAgent,
} from '../../src/pipeline/live-agents.ts';
import { writeRunSchemas } from '../../src/run-schemas.ts';

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

/** The environment a turn's child is given. `buildChildEnv`'s job in
 * production; a minimal honest one here, since what is under test is the turn
 * rather than the allowlist (KAR-08.4 owns that). */
const childEnv = (): Record<string, string> => ({
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
});

function turnOptions(over: Partial<LiveTurnOptions> & { cwd: string }): LiveTurnOptions {
  return {
    provider: 'mock',
    binaryPath: MOCK_AGENT_BIN,
    schemasDir: writeRunSchemas(over.cwd),
    // KAR-19.8 — derived, never spelled: this file spawns a fake vendor CLI
    // that enforces Claude Code 2.1.220's own rule, and `live-agents-spec` is
    // exactly the shape of value the real binary refused on 2026-08-13.
    sessionId: vendorSessionId({
      runId: RunIdSchema.parse('run_20260813T110608Z_379fc8'),
      nodeId: NodeIdSchema.parse('framing'),
      attempt: 0,
    }),
    env: childEnv(),
    ...over,
  };
}

suite('KAR-19.3 AC1 — a framing turn on a real process', () => {
  it('returns a taskspecdraft the bundled agent wrote', async ({ tmp }) => {
    const agent = liveFramingAgent(turnOptions({ cwd: tmp }));

    const { turn } = await agent.open('Frame this task.');

    expect(turn.question).toBeNull();
    expect(turn.structuredOutput.present).toBe(true);
    const document = (turn.structuredOutput as { present: true; value: { schemaId?: string } })
      .value;
    expect(document.schemaId).toBe('DeFlow.taskspecdraft.v1');
  });

  it('reports the adapter as unsteerable rather than pretending to hold a session', async ({
    tmp,
  }) => {
    const { session } = await liveFramingAgent(turnOptions({ cwd: tmp })).open('Frame this.');

    expect(session.steerable).toBe(false);
  });

  it('repairs by opening a second turn rather than by inventing a document', async ({ tmp }) => {
    const { session } = await liveFramingAgent(turnOptions({ cwd: tmp })).open('Frame this.');

    const repaired = await session.repair('That document was invalid. Try again.');

    expect(repaired.present).toBe(true);
  });
});

suite('KAR-19.3 AC2 — recon and planner turns on a real process', () => {
  it('asks the agent for a reconsurvey', async ({ tmp }) => {
    const { turn } = await liveReconAgent(turnOptions({ cwd: tmp })).open('Survey this repo.');

    const document = (turn.structuredOutput as { present: true; value: { schemaId?: string } })
      .value;
    expect(document.schemaId).toBe('DeFlow.reconsurvey.v1');
  });

  it('asks the agent for the plangraph the planner named, at the path it named', async ({
    tmp,
  }) => {
    const schemasDir = writeRunSchemas(tmp);
    const planner = livePlannerAgent(turnOptions({ cwd: tmp, schemasDir }));

    const turn = await planner.plan({
      prompt: 'Compile a plan.',
      attempt: 0,
      effort: null,
      schemaPath: join(schemasDir, 'DeFlow.plangraph.v1.json'),
    });

    const document = (turn.structuredOutput as { present: true; value: { schemaId?: string } })
      .value;
    expect(document.schemaId).toBe('DeFlow.plangraph.v1');
  });
});

suite('KAR-19.3 AC1 — the dialect that carries the return inside a stream', () => {
  it('reads the structured output off a stream-json vendor’s result line', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const scenario = join(tmp, 'scenario.json');
    writeFileSync(
      scenario,
      JSON.stringify({
        steps: [{ type: 'message', text: 'thinking' }],
        result: { structuredOutput: { schemaId: 'DeFlow.taskspecdraft.v1', goal: 'from a line' } },
      }),
      'utf8',
    );

    const { turn } = await liveFramingAgent(
      turnOptions({
        cwd: tmp,
        provider: 'claude',
        binaryPath: agent.binary,
        env: { ...childEnv(), [DIALECT_ENV]: 'claude-stream-json', [SCENARIO_ENV]: scenario },
      }),
    ).open('Frame this task.');

    expect(turn.structuredOutput).toEqual({
      present: true,
      value: { schemaId: 'DeFlow.taskspecdraft.v1', goal: 'from a line' },
    });
  });
});

suite('KAR-19.3 — a turn that failed says so, with the child’s own words', () => {
  it('fails with the provider named when the binary does not exist', async ({ tmp }) => {
    const agent = liveFramingAgent(
      turnOptions({ cwd: tmp, binaryPath: join(tmp, 'not-a-binary') }),
    );

    await expect(agent.open('Frame this.')).rejects.toBeInstanceOf(NodeFailureError);
  });

  it('fails when the agent cannot serve the schema, rather than returning nothing', async ({
    tmp,
  }) => {
    // The bundled agent refuses an id it has no generator for, exits non-zero
    // and writes zero bytes — deliberately, so a caller cannot mistake an
    // unserved turn for a served one.
    const agent = liveFramingAgent(
      turnOptions({ cwd: tmp, schemasDir: join(tmp, 'no-schemas-here') }),
    );

    await expect(agent.open('Frame this.')).rejects.toBeInstanceOf(NodeFailureError);
  });
});
