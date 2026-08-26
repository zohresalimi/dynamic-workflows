/**
 * KAR-27.9 AC1, AC4 — the cooperative rung, driven by the loop rather than by a
 * spec that wired the port itself.
 *
 * **What was missing.** `cancel.ts` has always documented rung 1 as *"performed
 * by the live turn through `protocolCancel`"*, and until this story the only
 * things that ever supplied that port were two integration specs which
 * constructed the `AbortController` next to their own `runAcpNode` call. The
 * operator's cancel does not arrive there: it arrives at the drive, one tick
 * later and three modules away from whoever is holding the connection. So the
 * default cancel asked nobody anything and the run parked (KAR-27.6).
 *
 * This file is the same real mock agent as `./cancel-cooperative.test.ts`, with
 * the wiring under test rather than in the fixture: the turn registers itself in
 * `LiveTurns`, the driver is given that registry, and **the tick** is what
 * reaches the agent. Everything asserted afterwards is what an operator gets
 * out of it — a flushed transcript, a terminal record, a run that ends, and not
 * one signal anywhere.
 *
 * Verifies: EPIC-27-S41, EPIC-27-S44 · KAR-27.9 AC1, AC4
 */
import { runAcpNode } from '@DeFlow/adapters';
import type { Db, NodeId, ProviderId, RunId } from '@DeFlow/core';
import {
  COOPERATIVE_CANCEL_UNANSWERED_MS,
  cancelWaiting,
  NodeIdSchema,
  ProviderIdSchema,
  RunIdSchema,
} from '@DeFlow/core';
import { appendEvents, readEpoch, readProcesses, replayRun } from '@DeFlow/ledger';
import { it, TestClock, waitFor } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { createRunDriver, type KillRunner } from '../../src/drive.ts';
import { createLiveTurns } from '../../src/exec/live-turns.ts';
import { AUTH, CANCEL_RUN, draft, seedRunningRun, T0 } from './support/cancel-run.ts';
import { openTestLedger } from './support/ledger.ts';

const RUN: RunId = RunIdSchema.parse(CANCEL_RUN);
const NODE: NodeId = NodeIdSchema.parse(AUTH);
const PROVIDER: ProviderId = ProviderIdSchema.parse('mock');
const REQUESTED_AT = T0 + 1_000;

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);
const HANG_FOREVER = fileURLToPath(
  new URL('../../../mock-agent/scenarios/hang-forever.jsonc', import.meta.url),
);

const binary = () => ({
  path: MOCK_AGENT_BIN,
  version: '0.0.0',
  sha256: createHash('sha256').update(readFileSync(MOCK_AGENT_BIN)).digest('hex'),
});

/** A kill runner that records every call. It must never be called: a cooperative
 * cancel that reached the ladder would be EPIC-19-S38's forbidden escalation. */
function recordingKill(): { readonly calls: string[]; readonly kill: KillRunner } {
  const calls: string[] = [];
  return {
    calls,
    kill: (runId, mode) => {
      calls.push(`${runId}/${mode}`);
      return Promise.resolve({ outcome: 'stopped' as const });
    },
  };
}

const kindsOf = (db: Db): string[] =>
  db
    .prepare<{ kind: string }>('SELECT kind FROM event WHERE run_id = ? ORDER BY seq')
    .all(RUN)
    .map((row) => row.kind);

const liveRowCount = (db: Db): number =>
  readProcesses(db).filter((row) => row.runId === RUN && row.state === 'live').length;

suite('EPIC-27-S41 — a cooperative cancel reaches the agent (AC1)', () => {
  it('asks over the protocol from the tick, flushes, ends the run, and signals nothing', async ({
    tmp,
  }) => {
    const worktree = join(tmp, 'wt');
    await mkdir(worktree, { recursive: true });

    const ledger = openTestLedger(tmp, RUN);
    const epoch = readEpoch(ledger.db);
    try {
      seedRunningRun(ledger.db);

      // The live turn, exactly as `liveAgentPerformer` starts one: an
      // `AbortController` whose abort is `session/cancel`, and a registration
      // that lets anything holding the ledger reach it.
      const turns = createLiveTurns();
      const controller = new AbortController();
      const turn = runAcpNode(
        {
          runId: RUN,
          nodeId: NODE,
          attempt: 0,
          provider: PROVIDER,
          permission: 'worktree',
          worktree,
          binary: binary(),
          argv: ['--seed', '42', '--scenario', HANG_FOREVER],
          mcpServers: [],
          prompt: 'do something long',
        },
        {
          clock: new TestClock(T0),
          ledger: ledger.sink,
          processes: ledger.processes,
          captureEvidence: (evidence: string | Uint8Array) =>
            `artifact://${createHash('sha256').update(evidence).digest('hex')}` as never,
          signal: controller.signal,
          // What production passes, and the reason it must: an unanswered
          // cooperative cancel may not become a forceful one on a timer
          // (EPIC-19-S38, EPIC-27-S30).
          escalateUnansweredCancel: false,
        },
      );
      const dispose = turns.register(
        { runId: RUN, nodeId: NODE, attempt: 0 },
        {
          cancel: () => controller.abort(),
          cancelled: turn.then((outcome) => outcome.status === 'cancelled'),
        },
      );

      await waitFor(
        () => ledger.events().some((event) => event.payload.phase === 'agent_message_chunk'),
        { describe: 'the agent to be streaming', timeoutMs: 20_000 },
      );
      expect(liveRowCount(ledger.db)).toBe(1);

      // The operator's request, as the API records it.
      appendEvents(ledger.db, [
        draft('run.cancel.requested', { mode: 'cooperative' }, { ts: REQUESTED_AT }),
      ]);

      const killer = recordingKill();
      const driver = createRunDriver({
        db: ledger.db,
        clock: new TestClock(REQUESTED_AT),
        epoch,
        startedAt: T0,
        killRun: killer.kill,
        liveTurns: turns,
      });

      // *This* is the line that did not exist: one ordinary tick, and the agent
      // is asked.
      await driver.tick(REQUESTED_AT + 10);

      const outcome = await turn;
      expect(outcome.status).toBe('cancelled');
      if (outcome.status !== 'cancelled') return;
      expect(outcome.stopReason).toBe('cancelled');
      // The child ended itself. A signal would show here as the reason it died.
      await driver.settle();
      dispose();

      // AC1 — no signal, and the ladder was never entered. The `protocol` rung
      // is the only one on the log.
      expect(killer.calls).toEqual([]);
      const stages = ledger.eventsOf('node.cancel.stage').map((payload) => payload.stage as string);
      expect(stages).toEqual(['protocol']);

      // The attempt has a terminal record, which is what stops the scheduler
      // treating it as in flight — and it says who stopped it.
      expect(ledger.eventsOf('node.cancelled')).toEqual([
        { node: NODE, attempt: 0, result: { status: 'cancelled', by: 'user' } },
      ]);
      expect(liveRowCount(ledger.db)).toBe(0);

      // And the run itself ends on the next tick, without anybody typing
      // `--force` and without the wait KAR-27.6 exists to describe.
      await driver.tick(REQUESTED_AT + 20);
      expect(kindsOf(ledger.db)).toContain('run.aborted');
      expect(kindsOf(ledger.db)).not.toContain('run.cancel.unanswered');
      expect(cancelWaiting(replayRun(ledger.db, RUN).state, RUN)).toBeNull();
    } finally {
      ledger.close();
    }
  });
});

suite('EPIC-27-S44 — the transcript is readable afterwards (AC4)', () => {
  it('keeps the tail the agent flushed after the cancel, ahead of the terminal record', async ({
    tmp,
  }) => {
    const worktree = join(tmp, 'wt');
    await mkdir(worktree, { recursive: true });

    const ledger = openTestLedger(tmp, RUN);
    const epoch = readEpoch(ledger.db);
    try {
      seedRunningRun(ledger.db);

      const turns = createLiveTurns();
      const controller = new AbortController();
      const turn = runAcpNode(
        {
          runId: RUN,
          nodeId: NODE,
          attempt: 0,
          provider: PROVIDER,
          permission: 'worktree',
          worktree,
          binary: binary(),
          argv: ['--seed', '42', '--scenario', HANG_FOREVER],
          mcpServers: [],
          prompt: 'do something long',
        },
        {
          clock: new TestClock(T0),
          ledger: ledger.sink,
          processes: ledger.processes,
          captureEvidence: (evidence: string | Uint8Array) =>
            `artifact://${createHash('sha256').update(evidence).digest('hex')}` as never,
          signal: controller.signal,
          escalateUnansweredCancel: false,
        },
      );
      turns.register(
        { runId: RUN, nodeId: NODE, attempt: 0 },
        {
          cancel: () => controller.abort(),
          cancelled: turn.then((outcome) => outcome.status === 'cancelled'),
        },
      );

      await waitFor(
        () => ledger.events().some((event) => event.payload.phase === 'agent_message_chunk'),
        { describe: 'the agent to be streaming', timeoutMs: 20_000 },
      );
      appendEvents(ledger.db, [
        draft('run.cancel.requested', { mode: 'cooperative' }, { ts: REQUESTED_AT }),
      ]);

      const driver = createRunDriver({
        db: ledger.db,
        clock: new TestClock(REQUESTED_AT),
        epoch,
        startedAt: T0,
        killRun: recordingKill().kill,
        liveTurns: turns,
      });
      await driver.tick(REQUESTED_AT + 10);
      await turn;
      await driver.settle();

      // The whole reason this ladder exists: read the run's output *after* the
      // cancel completed, and the tail the agent wrote on its way out is there.
      const events = ledger.events();
      const tail = events.filter((event) => `${event.payload.message}`.startsWith('flushing tail'));
      expect(tail.length).toBe(2);
      const terminal = events.find((event) => event.kind === 'node.cancelled');
      expect(terminal).toBeDefined();
      for (const chunk of tail) expect(chunk.seq).toBeLessThan(terminal?.seq ?? 0);

      // Long past the window KAR-27.6 bounds the wait with, nothing reports a
      // wait: there is nothing left to wait for.
      await driver.tick(REQUESTED_AT + COOPERATIVE_CANCEL_UNANSWERED_MS * 3);
      expect(kindsOf(ledger.db)).not.toContain('run.cancel.unanswered');
    } finally {
      ledger.close();
    }
  });
});
