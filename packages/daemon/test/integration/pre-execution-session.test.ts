/**
 * KAR-19.13 / EPIC-19-S84, EPIC-19-S85, EPIC-19-S86, EPIC-19-S87 — a
 * pre-execution turn that runs twice does not spend the same vendor session id
 * twice.
 *
 * This is the regression test for `run_20260816T194933Z_839b9b`, which reached
 * `compilePlanV1` and died on
 *
 * ```
 * Session ID 5f2b8935-25e5-5c1c-83c6-a97d1b151f08 is already in use
 * ```
 *
 * — the exact value of `vendorSessionId({ runId, nodeId: 'planner', attempt: 0
 * })`, because `live-chain.ts` pinned the attempt at 0 and Claude Code's
 * `--session-id` **creates** a session rather than attaching to one.
 *
 * **Two clauses carry this file.**
 *
 * The first is the fake that *refuses a second presentation*, the same shape as
 * EPIC-19-S52's and for the same reason: a double that creates a session for
 * whatever it is handed is green on the machine where the product is wedged.
 * `DeFlow_FAKE_SESSION_STORE` is the directory it records the ids it has
 * created in, and the two processes that share it are the two daemon lives.
 *
 * The second is that each life opens **its own handle** on one ledger file and
 * carries nothing else across. The cheap version of this fix is a counter on
 * the chain's context object; it passes every assertion that can be made inside
 * one process and fails the only situation the defect occurs in.
 *
 * Verifies: EPIC-19-S84, EPIC-19-S85, EPIC-19-S86, EPIC-19-S87 · KAR-19.13
 * AC1, AC2, AC3, AC5
 */
import { vendorSessionId } from '@DeFlow/adapters';
import type { Db, NodeId, RunId } from '@DeFlow/core';
import { NodeFailureError, RunIdSchema } from '@DeFlow/core';
import { openLedger, readRange } from '@DeFlow/ledger';
import {
  DIALECT_ENV,
  it,
  linkFakeAgent,
  readSideEffectLog,
  SCENARIO_ENV,
  SESSION_STORE_ENV,
  SIDE_EFFECT_LOG_ENV,
} from '@DeFlow/testkit';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  type LiveTurnOptions,
  liveFramingAgent,
  livePlannerAgent,
  liveReconAgent,
  schemaPathFor,
} from '../../src/pipeline/live-agents.ts';
import {
  openPreExecutionSession,
  PRE_EXECUTION_NODES,
} from '../../src/pipeline/pre-execution-session.ts';
import { writeRunSchemas } from '../../src/run-schemas.ts';

/** The run from the 2026-08-16 log, verbatim. */
const RUN = RunIdSchema.parse('run_20260816T194933Z_839b9b');
const EPOCH = 3;
const T0 = 1_786_000_000_000;

/** The id the vendor refused, and the whole diagnosis. */
const THE_SPENT_ID = '5f2b8935-25e5-5c1c-83c6-a97d1b151f08';

interface Scene {
  /** One daemon life: its own ledger handle over the one file on disk. */
  life(): { db: Db; options(nodeId: NodeId): LiveTurnOptions; close(): void };
  /** Every session this run has recorded, oldest first. */
  recorded(): readonly { node: string; attempt: number; id: string }[];
  /** How many children the fake binary has been invoked as. */
  spawns(): number;
}

async function scene(tmp: string, script: Record<string, unknown> = {}): Promise<Scene> {
  const agent = await linkFakeAgent(tmp, 'claude');
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });
  const sessionStore = join(tmp, 'vendor-sessions');
  const sideEffects = join(tmp, 'invocations.ndjson');
  const schemasDir = writeRunSchemas(tmp);

  const scenario = join(tmp, 'scenario.json');
  writeFileSync(
    scenario,
    JSON.stringify({
      steps: [{ type: 'message', text: 'a turn' }],
      result: {
        structuredOutput: { schemaId: 'DeFlow.taskspecdraft.v1', goal: 'Ship the health check.' },
      },
      ...script,
    }),
    'utf8',
  );

  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    [DIALECT_ENV]: 'claude-stream-json',
    [SCENARIO_ENV]: scenario,
    [SESSION_STORE_ENV]: sessionStore,
    [SIDE_EFFECT_LOG_ENV]: sideEffects,
  } as const;

  const read = (): readonly { node: string; attempt: number; id: string }[] => {
    const db = openLedger(dataDir);
    try {
      return readRange(db, RUN, 0, 500)
        .events.filter((event) => event.kind === 'provider.session_opened')
        .map((event) => {
          const payload = event.payload as {
            node: string;
            attempt: number;
            session: { id: string };
          };
          return { node: payload.node, attempt: payload.attempt, id: payload.session.id };
        });
    } finally {
      db.close();
    }
  };

  return {
    life: () => {
      const db = openLedger(dataDir);
      return {
        db,
        options: (nodeId: NodeId): LiveTurnOptions => ({
          provider: 'claude',
          binaryPath: agent.binary,
          cwd: tmp,
          schemasDir,
          env,
          openSession: () =>
            openPreExecutionSession({
              db,
              runId: RUN,
              nodeId,
              provider: 'claude',
              epoch: EPOCH,
              ts: T0,
            }),
        }),
        close: () => db.close(),
      };
    },
    recorded: read,
    spawns: () => readSideEffectLog(sideEffects).entries.length,
  };
}

/** One turn of `turn`'s kind, in its own daemon life. */
async function oneTurn(s: Scene, turn: keyof typeof PRE_EXECUTION_NODES): Promise<void> {
  const life = s.life();
  try {
    const options = life.options(PRE_EXECUTION_NODES[turn]);
    if (turn === 'recon') await liveReconAgent(options).open('Survey this.');
    else if (turn === 'framing') await liveFramingAgent(options).open('Frame this.');
    else {
      await livePlannerAgent(options).plan({
        prompt: 'Compile a plan.',
        attempt: 0,
        schemaPath: schemaPathFor(options.schemasDir, 'DeFlow.plangraph.v1'),
      });
    }
  } finally {
    life.close();
  }
}

suite('KAR-19.13 AC1 — the second process is not refused', () => {
  it('opens a session the fake has never seen, on a fresh daemon life', async ({ tmp }) => {
    const s = await scene(tmp);

    await oneTurn(s, 'planner');
    // A second daemon life: a new handle on the same ledger file and nothing
    // else carried across. This is the restart that produced the report.
    await oneTurn(s, 'planner');

    const ids = s.recorded();
    expect(ids.map((one) => one.id)).toEqual([
      THE_SPENT_ID,
      vendorSessionId({ runId: RUN, nodeId: PRE_EXECUTION_NODES.planner, attempt: 1 }),
    ]);
  });

  // The pin is in one shared helper that all three turns call, so a fix applied
  // to the planner alone would leave the identical bug one wake away. `it.each`
  // cannot be used: the testkit's `it` delivers `tmp` through the fixture
  // context, and `each` takes that argument slot for its own row.
  for (const turn of ['framing', 'recon', 'planner'] as const) {
    it(`derives from the recorded turn for the ${turn} turn too`, async ({ tmp }) => {
      const s = await scene(tmp);
      const nodeId = PRE_EXECUTION_NODES[turn];

      await oneTurn(s, turn);
      await oneTurn(s, turn);

      const ids = s.recorded();
      expect(ids.map((one) => one.attempt)).toEqual([0, 1]);
      expect(ids[1]?.id).toBe(vendorSessionId({ runId: RUN, nodeId, attempt: 1 }));
    });
  }
});

suite('KAR-19.13 AC2 — the attempt is a fact in the ledger, not a number in a process', () => {
  it('does not start counting again after a restart', async ({ tmp }) => {
    const s = await scene(tmp);
    const nodeId = PRE_EXECUTION_NODES.framing;

    for (let turn = 0; turn < 2; turn += 1) {
      const life = s.life();
      try {
        await liveFramingAgent(life.options(nodeId)).open('Frame this.');
      } finally {
        life.close();
      }
    }

    // A daemon that has just booted and executed nothing this life.
    const booted = s.life();
    try {
      await liveFramingAgent(booted.options(nodeId)).open('Frame this again.');
    } finally {
      booted.close();
    }

    const ids = s.recorded();
    expect(ids.at(-1)?.attempt).toBe(2);
    expect(ids.at(-1)?.id).toBe(vendorSessionId({ runId: RUN, nodeId, attempt: 2 }));
    expect(ids.at(-1)?.id).not.toBe(vendorSessionId({ runId: RUN, nodeId, attempt: 0 }));
  });

  it('recomputes every past id from the ledger alone', async ({ tmp }) => {
    const s = await scene(tmp);

    for (const turn of ['framing', 'recon', 'planner'] as const) await oneTurn(s, turn);

    const ids = s.recorded();
    expect(ids).toHaveLength(3);
    for (const one of ids) {
      // Offline, from `(runId, nodeId, attempt)` and nothing else — no clock,
      // no environment variable, no unseeded random source.
      expect(
        vendorSessionId({ runId: RUN, nodeId: one.node as NodeId, attempt: one.attempt }),
      ).toBe(one.id);
    }
  });
});

suite('KAR-19.13 AC3 — a repair replays into a new session, not the spent one', () => {
  it('hands the repair’s child an id the original turn did not spend', async ({ tmp }) => {
    const s = await scene(tmp);
    const life = s.life();

    try {
      const { session } = await liveFramingAgent(life.options(PRE_EXECUTION_NODES.framing)).open(
        'Frame this.',
      );

      const repaired = await session.repair('That document was invalid. Try again.');

      // The child exited 0, which is only possible against a fake that refuses
      // a second presentation if the id really was new.
      expect(repaired.present).toBe(true);
    } finally {
      life.close();
    }

    const ids = s.recorded();
    expect(ids).toHaveLength(2);
    expect(ids[0]?.id).not.toBe(ids[1]?.id);
    // Neither transcript overwrites the other: both are still derivable, and
    // the original's record is untouched by the repair.
    expect(ids[0]?.id).toBe(
      vendorSessionId({ runId: RUN, nodeId: PRE_EXECUTION_NODES.framing, attempt: 0 }),
    );
    expect(ids[1]?.id).toBe(
      vendorSessionId({ runId: RUN, nodeId: PRE_EXECUTION_NODES.framing, attempt: 1 }),
    );
  });
});

suite('KAR-19.13 AC5 — "already in use" is an argument refusal, permanent, tried once', () => {
  it('names the flag and the value, and carries the child’s own words', async ({ tmp }) => {
    const s = await scene(tmp);
    // Some other process already created the id this run's first framing turn
    // will derive — which is exactly the state a crashed daemon leaves behind.
    const store = join(tmp, 'vendor-sessions');
    mkdirSync(store, { recursive: true });
    const spent = vendorSessionId({
      runId: RUN,
      nodeId: PRE_EXECUTION_NODES.framing,
      attempt: 0,
    });
    writeFileSync(join(store, encodeURIComponent(spent)), '', 'utf8');

    const life = s.life();
    const thrown = await liveFramingAgent(life.options(PRE_EXECUTION_NODES.framing))
      .open('Frame this.')
      .then(
        () => null,
        (error: unknown) => error,
      );
    life.close();

    expect(thrown).toBeInstanceOf(NodeFailureError);
    const failure = (thrown as NodeFailureError).deflowFailure;
    expect(failure.detail?.flag).toBe('--session-id');
    expect(failure.detail?.value).toBe(spent);
    expect(String(failure.detail?.stderr)).toContain(`Session ID ${spent} is already in use`);
    expect((thrown as NodeFailureError).message).toContain('--session-id');
    expect((thrown as NodeFailureError).message).toContain(spent);
  });

  it('classes it permanent and spawns exactly one child for the turn', async ({ tmp }) => {
    const s = await scene(tmp);
    const store = join(tmp, 'vendor-sessions');
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(
        store,
        encodeURIComponent(
          vendorSessionId({ runId: RUN, nodeId: PRE_EXECUTION_NODES.planner, attempt: 0 }),
        ),
      ),
      '',
      'utf8',
    );

    const life = s.life();
    const options = life.options(PRE_EXECUTION_NODES.planner);
    const thrown = (await livePlannerAgent(options)
      .plan({
        prompt: 'Compile a plan.',
        attempt: 0,
        schemaPath: schemaPathFor(options.schemasDir, 'DeFlow.plangraph.v1'),
      })
      .catch((error: unknown) => error)) as NodeFailureError;
    life.close();

    // `transient` was a standing instruction to try the identical id every
    // tick, for ever. An argument this vendor refuses now is one it refuses on
    // every attempt.
    expect(thrown.deflowFailure.class).toBe('permanent');
    expect(s.spawns()).toBe(1);
  });
});
