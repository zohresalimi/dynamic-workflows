/**
 * KAR-19.8 AC1, AC5, AC6 / EPIC-19-S52, EPIC-19-S55 — the framing turn survives
 * the vendor's **own** argument validation, and an argument it refuses is
 * reported as an argument.
 *
 * This is the regression test for the defect observed by hand on 2026-08-13.
 * `deflow run --file task.md` reached framing — the whole of KAR-19.3 working —
 * and then failed on every attempt with `claude exited 1 without completing the
 * turn: Error: Invalid session ID. Must be a valid UUID.`, because
 * `live-chain.ts` filled the shim's session id with `` `${runId}-framing` ``.
 *
 * **The clause that carries the file is the fake that refuses.** Until this
 * story, `@DeFlow/testkit`'s exec-shim agent accepted whatever it was handed,
 * which is precisely why the entire provider-contract suite was green while the
 * product could not complete a turn on the machine it ships to. So the double
 * now enforces the vendor's rule (`packages/testkit/src/exec-shim/dialects.ts`),
 * and both halves are asserted here: the derived id passes it, and the id that
 * failed on 2026-08-13 still fails — loudly, permanently, and by name.
 *
 * Verifies: EPIC-19-S52, EPIC-19-S55 · KAR-19.8 AC1, AC5, AC6
 */
import { vendorSessionId } from '@DeFlow/adapters';
import { NodeFailureError, NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { DIALECT_ENV, it, linkFakeAgent, SCENARIO_ENV } from '@DeFlow/testkit';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { type LiveTurnOptions, liveFramingAgent } from '../../src/pipeline/live-agents.ts';
import { PRE_EXECUTION_NODES } from '../../src/pipeline/live-chain.ts';
import { writeRunSchemas } from '../../src/run-schemas.ts';

/** The run from the 2026-08-13 log, verbatim — the id an operator greps for. */
const RUN = RunIdSchema.parse('run_20260813T110608Z_379fc8');

/** What the failing build put on the flag. Kept as the literal it was. */
const THE_2026_08_13_VALUE = `${RUN}-framing`;

const childEnv = (): Record<string, string> => ({
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
});

interface Scene {
  readonly options: LiveTurnOptions;
}

/** A framing turn wired exactly as `live-chain.ts` wires one, onto the fake
 * vendor CLI linked under the name it is impersonating. */
async function scene(
  tmp: string,
  sessionId: string,
  script: Record<string, unknown> = {},
): Promise<Scene> {
  const agent = await linkFakeAgent(tmp, 'claude');
  const scenario = join(tmp, 'scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      steps: [{ type: 'message', text: 'framing' }],
      result: {
        structuredOutput: { schemaId: 'DeFlow.taskspecdraft.v1', goal: 'Ship the health check.' },
      },
      ...script,
    }),
    'utf8',
  );

  return {
    options: {
      provider: 'claude',
      binaryPath: agent.binary,
      cwd: tmp,
      schemasDir: writeRunSchemas(tmp),
      // KAR-19.13 — each child opens its own session. This file hands the same
      // value every time on purpose: what it asserts is the *form* the vendor
      // validates, and one turn per scene is all it runs.
      openSession: () => ({ id: sessionId, attempt: 0 }),
      env: {
        ...childEnv(),
        [DIALECT_ENV]: 'claude-stream-json',
        [SCENARIO_ENV]: scenario,
      },
    },
  };
}

suite('KAR-19.8 AC1 — the framing turn survives the vendor’s argument validation', () => {
  it('completes against a fake that refuses any non-uuid --session-id', async ({ tmp }) => {
    const sessionId = vendorSessionId({
      runId: RUN,
      nodeId: PRE_EXECUTION_NODES.framing,
      attempt: 0,
    });
    const { options } = await scene(tmp, sessionId);

    const { turn } = await liveFramingAgent(options).open('Frame this task.');

    expect(turn.structuredOutput).toEqual({
      present: true,
      value: { schemaId: 'DeFlow.taskspecdraft.v1', goal: 'Ship the health check.' },
    });
  });

  it('derives the same id for the recon and planner turns, which reach the same shim', async ({
    tmp,
  }) => {
    for (const node of [PRE_EXECUTION_NODES.recon, PRE_EXECUTION_NODES.planner]) {
      const sessionId = vendorSessionId({ runId: RUN, nodeId: node, attempt: 0 });
      const { options } = await scene(join(tmp, node), sessionId);

      await expect(liveFramingAgent(options).open('Frame this.')).resolves.toBeDefined();
    }
  });
});

suite('KAR-19.8 AC5, AC6 — an argument the vendor refuses is named, and is permanent', () => {
  it('reports the flag, the value and the child’s own words', async ({ tmp }) => {
    const { options } = await scene(tmp, THE_2026_08_13_VALUE);

    const thrown = await liveFramingAgent(options)
      .open('Frame this task.')
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(thrown).toBeInstanceOf(NodeFailureError);
    const failure = (thrown as NodeFailureError).deflowFailure;
    expect(failure.detail?.flag).toBe('--session-id');
    expect(failure.detail?.value).toBe(THE_2026_08_13_VALUE);
    // Trimmed, not paraphrased: the operator has to be able to search the
    // vendor's own message.
    expect(String(failure.detail?.stderr)).toContain('Invalid session ID. Must be a valid UUID.');
    // And no stack trace is needed to learn which argument was wrong.
    expect((thrown as NodeFailureError).message).toContain('--session-id');
    expect((thrown as NodeFailureError).message).toContain(THE_2026_08_13_VALUE);
  });

  it('classes it permanent, because retrying it thirty times changes nothing', async ({ tmp }) => {
    const { options } = await scene(tmp, THE_2026_08_13_VALUE);

    const thrown = (await liveFramingAgent(options)
      .open('Frame this.')
      .catch((error: unknown) => error)) as NodeFailureError;

    // The 2026-08-13 ledger said `transient`, and a transient classification is
    // a standing instruction to try again: the identical error at 11:07:13,
    // 11:07:44, 11:08:14, … is what that looks like from the outside.
    expect(thrown.deflowFailure.class).toBe('permanent');
  });

  it('does not blame an argument when the child failed for some other reason', async ({ tmp }) => {
    const sessionId = vendorSessionId({
      runId: RUN,
      nodeId: PRE_EXECUTION_NODES.framing,
      attempt: 0,
    });
    // The child exits non-zero for a reason that has nothing to do with the
    // argv DeFlow chose. A classifier that blamed the argv for every non-zero
    // exit would turn an ordinary vendor error into a permanent failure nobody
    // retries — worse than not classifying at all.
    const { options } = await scene(tmp, sessionId, {
      exitCode: 1,
      stderr: 'Error: the model endpoint reset the connection',
    });

    const thrown = (await liveFramingAgent(options)
      .open('Frame this.')
      .catch((error: unknown) => error)) as NodeFailureError;

    expect(thrown.deflowFailure.detail?.flag).toBeUndefined();
    expect(thrown.deflowFailure.class).toBe('transient');
  });
});
