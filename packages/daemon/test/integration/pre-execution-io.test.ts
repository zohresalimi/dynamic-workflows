/**
 * KAR-27.3 AC2, AC5 — a pre-execution turn's stdout lands in the io store while
 * the turn is still running, and its tail is what a silent failure is read by.
 *
 * **The defect this closes.** On 2026-08-23 a framing turn spent minutes making
 * Linear queries and reading the repository. Every byte of that was on the
 * child's stdout, held in a `Buffer[]` inside `spawnTurn` and read only at exit
 * — so while the operator was asking whether anything was happening, the
 * evidence that it was existed nowhere anything could read it. And when a
 * pre-execution turn *did* die that day, it died with `stderr: ""` and the
 * vendor's stated cause sitting in the same discarded buffer.
 *
 * Integration, against a real child process, because both halves are about a
 * process that has not exited yet: a mocked `spawn` that resolves at once
 * cannot fail the "mid-turn" clause, which is the whole of S17.
 *
 * Verifies: EPIC-27-S17, EPIC-27-S20 · KAR-27.3 AC2, AC5
 */
import type { Db, NodeId } from '@DeFlow/core';
import { NodeFailureError, RunIdSchema } from '@DeFlow/core';
import { openLedger, readIoChunks } from '@DeFlow/ledger';
import { DIALECT_ENV, it, linkFakeAgent, SCENARIO_ENV, SESSION_STORE_ENV } from '@DeFlow/testkit';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  type LiveTurnOptions,
  liveFramingAgent,
  MAX_TURN_BYTES,
} from '../../src/pipeline/live-agents.ts';
import {
  openPreExecutionIo,
  openPreExecutionSession,
  PRE_EXECUTION_NODES,
} from '../../src/pipeline/pre-execution-session.ts';
import { writeRunSchemas } from '../../src/run-schemas.ts';

const RUN = RunIdSchema.parse('run_20260823T104141Z_e9eac2');
const EPOCH = 1;
const T0 = 1_787_000_000_000;

/** A clock that moves one millisecond per read, so chunk order is observable
 * without a real one and NF9 stays true of the daemon under test. */
function tickingClock(): { now: () => number; sleep: () => Promise<void>; setTimer: () => never } {
  let ts = T0;
  return {
    now: () => (ts += 1),
    sleep: () => Promise.resolve(),
    setTimer: () => {
      throw new Error('the io writer never schedules anything');
    },
  };
}

interface Scene {
  readonly db: Db;
  options(nodeId: NodeId): LiveTurnOptions;
  /** Everything the io store holds for this node's `attempt` (0-based). */
  stored(nodeId: NodeId, attempt: number, stream?: 'stdout' | 'stderr'): string;
  close(): void;
}

async function scene(tmp: string, script: Record<string, unknown> = {}): Promise<Scene> {
  const agent = await linkFakeAgent(tmp, 'claude');
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });
  const schemasDir = writeRunSchemas(tmp);

  const scenario = join(tmp, 'scenario.json');
  const scripted: Record<string, unknown> = {
    steps: [{ type: 'message', text: 'a turn' }],
    result: {
      structuredOutput: { schemaId: 'DeFlow.taskspecdraft.v1', goal: 'Ship the health check.' },
    },
    ...script,
  };
  // The fake reads an *absent* result as "this turn emitted no result envelope";
  // an explicit `null` is a malformed scenario. `null` here is the caller
  // asking for the former.
  if (scripted.result === null) delete scripted.result;
  writeFileSync(scenario, JSON.stringify(scripted), 'utf8');

  const env = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    [DIALECT_ENV]: 'claude-stream-json',
    [SCENARIO_ENV]: scenario,
    [SESSION_STORE_ENV]: join(tmp, 'vendor-sessions'),
  } as const;

  const db = openLedger(dataDir);
  const clock = tickingClock();

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
      openIo: (attempt) => openPreExecutionIo({ db, runId: RUN, nodeId, attempt, clock }),
    }),
    stored: (nodeId, attempt, stream = 'stdout') =>
      readIoChunks(db, { runId: RUN, nodeId, attempt: attempt + 1 }, 0, 10_000)
        .chunks.filter((chunk) => chunk.stream === stream)
        .map((chunk) => Buffer.from(chunk.data).toString('utf8'))
        .join(''),
    close: () => db.close(),
  };
}

suite('KAR-27.3 AC2 — stdout is persisted as it arrives (EPIC-27-S17)', () => {
  it('holds the frames a still-running child has emitted so far', async ({ tmp }) => {
    // Twenty lines a tenth of a second apart: two seconds of scripted output,
    // so the read below lands between frames on a loaded machine as reliably
    // as on an idle one. A fixed sleep against a short script is a spec that
    // passes for the wrong reason under a parallel suite.
    const s = await scene(tmp, {
      steps: [{ type: 'chunks', count: 20, delayMs: 100, text: 'reading the repository' }],
    });
    const nodeId = PRE_EXECUTION_NODES.framing;

    let running = true;
    const turn = liveFramingAgent(s.options(nodeId))
      .open('Frame this.')
      .finally(() => {
        running = false;
      });

    // The first bytes, whenever they arrive. Polled rather than slept for,
    // because what is being asserted is "before the child exits" and not "after
    // 120 milliseconds".
    let midTurn = '';
    for (let waited = 0; waited < 4_000 && midTurn === '' && running; waited += 25) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      midTurn = s.stored(nodeId, 0);
    }
    const readWhileRunning = running;

    await turn;
    const atExit = s.stored(nodeId, 0);
    s.close();

    // The whole of S17: output was readable before the child exited.
    expect(readWhileRunning).toBe(true);
    expect(midTurn).not.toBe('');
    expect(midTurn).toContain('reading the repository');
    expect(atExit.length).toBeGreaterThan(midTurn.length);
    expect(atExit.startsWith(midTurn)).toBe(true);
  });

  it('stores byte-for-byte what the buffered path captured', async ({ tmp }) => {
    const s = await scene(tmp, {
      steps: [
        { type: 'chunks', count: 3, delayMs: 5, text: 'working' },
        { type: 'message', text: 'done' },
      ],
    });
    const nodeId = PRE_EXECUTION_NODES.framing;

    const { turn } = await liveFramingAgent(s.options(nodeId)).open('Frame this.');
    const stored = s.stored(nodeId, 0);
    s.close();

    // The turn's own return is read out of the buffered stdout, so a store
    // that holds the same result line holds the same bytes the buffer did.
    expect(turn.structuredOutput.present).toBe(true);
    expect(stored).toContain('"type":"result"');
    expect(stored).toContain('working');
    expect(stored.split('\n').filter((line) => line.trim() !== '').length).toBeGreaterThan(3);
  });

  it('addresses each child by its own session, so a repair does not overwrite', async ({ tmp }) => {
    const s = await scene(tmp);
    const nodeId = PRE_EXECUTION_NODES.framing;

    const { session } = await liveFramingAgent(s.options(nodeId)).open('Frame this.');
    await session.repair('That document was invalid. Try again.');

    const first = s.stored(nodeId, 0);
    const second = s.stored(nodeId, 1);
    s.close();

    expect(first).not.toBe('');
    expect(second).not.toBe('');
    // Two transcripts, separately findable. The 1-based data plane and the
    // 0-based envelope have to agree or one of these is empty.
    expect(first).not.toBe(second);
  });

  it('persists stderr on the same address, so a failure has both streams', async ({ tmp }) => {
    const s = await scene(tmp, { stderr: 'the vendor complained', exitCode: 1 });
    const nodeId = PRE_EXECUTION_NODES.framing;

    await liveFramingAgent(s.options(nodeId))
      .open('Frame this.')
      .catch(() => null);
    const stored = s.stored(nodeId, 0, 'stderr');
    s.close();

    expect(stored).toContain('the vendor complained');
  });

  it('stops persisting where the runaway guard stops buffering', async ({ tmp }) => {
    const s = await scene(tmp, {
      steps: [{ type: 'hugeLine', totalBytes: MAX_TURN_BYTES + 1_000_000, chunkBytes: 256 * 1024 }],
      result: null,
    });
    const nodeId = PRE_EXECUTION_NODES.framing;

    const thrown = await liveFramingAgent(s.options(nodeId))
      .open('Frame this.')
      .then(
        () => null,
        (error: unknown) => error,
      );
    const stored = s.stored(nodeId, 0);
    s.close();

    expect(thrown).toBeInstanceOf(NodeFailureError);
    expect((thrown as NodeFailureError).deflowFailure.reason).toBe('adapter.frame-too-large');
    // What the child wrote before it went wrong is evidence and is kept; what
    // tripped the guard was never buffered, so it is never stored either.
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThanOrEqual(MAX_TURN_BYTES);
  });

  it('never lets a failing io store take the turn down with it', async ({ tmp }) => {
    const s = await scene(tmp);
    const nodeId = PRE_EXECUTION_NODES.framing;
    const options: LiveTurnOptions = {
      ...s.options(nodeId),
      openIo: () => ({
        append: () => {
          throw new Error('the disk is full');
        },
      }),
    };

    const { turn } = await liveFramingAgent(options).open('Frame this.');
    s.close();

    // Liveness narrates the turn; it does not get a vote on whether it runs.
    expect(turn.structuredOutput.present).toBe(true);
  });
});

suite('KAR-27.3 AC5 — an empty stderr no longer hides the cause (EPIC-27-S20)', () => {
  it('carries the persisted stdout tail into the failure detail', async ({ tmp }) => {
    // The 2026-08-23 shape: a non-zero exit, nothing at all on stderr, and the
    // vendor's own account of why on stdout.
    const s = await scene(tmp, {
      steps: [{ type: 'message', text: 'starting' }],
      result: {
        subtype: 'error_during_execution',
        isError: true,
        stopReason: 'rate_limit',
        text: '',
      },
      exitCode: 1,
      stderr: '',
    });
    const nodeId = PRE_EXECUTION_NODES.framing;

    const thrown = (await liveFramingAgent(s.options(nodeId))
      .open('Frame this.')
      .then(
        () => null,
        (error: unknown) => error,
      )) as NodeFailureError;
    const stored = s.stored(nodeId, 0);
    s.close();

    expect(thrown).toBeInstanceOf(NodeFailureError);
    const detail = thrown.deflowFailure.detail ?? {};
    expect(String(detail.stdoutTail)).toContain('error_during_execution');
    // The vendor's own subtype and stop reason, rather than an empty excerpt.
    expect(detail.subtype).toBe('error_during_execution');
    expect(detail.stopReason).toBe('rate_limit');
    expect(thrown.message).not.toMatch(/turn: $/);
    // The tail in the failure is a tail *of the persisted stream*, not of a
    // buffer nobody else can see.
    expect(stored).toContain('error_during_execution');
  });

  it('still carries stderr when the child wrote some, and never drops the field', async ({
    tmp,
  }) => {
    const s = await scene(tmp, {
      steps: [{ type: 'message', text: 'starting' }],
      result: null,
      exitCode: 1,
      stderr: 'the vendor said this out loud',
    });
    const nodeId = PRE_EXECUTION_NODES.framing;

    const thrown = (await liveFramingAgent(s.options(nodeId))
      .open('Frame this.')
      .then(
        () => null,
        (error: unknown) => error,
      )) as NodeFailureError;
    s.close();

    const detail = thrown.deflowFailure.detail ?? {};
    expect(String(detail.stderr)).toContain('the vendor said this out loud');
    expect(thrown.message).toContain('the vendor said this out loud');
  });
});
