/**
 * EPIC-06-S24 scenario 1 — a cooperative cancel lets the agent flush
 * (KAR-06.7 AC5).
 *
 * A **real** mock agent, scripted to emit two `session/update` notifications
 * *after* the cancel, driven through the same `cancelNode` the scheduler's
 * `CancelNode` command reaches. What is being proved at this level is not that
 * the adapter keeps reading after `session/cancel` — EPIC-05 proved that — but
 * that the orchestrator's ladder **gives rung 1 its whole chance before
 * anything is signalled**, and that the run ends up with a terminal record
 * saying who stopped it.
 *
 * A client that tore its reader down on cancel would lose the tail and could
 * deadlock waiting for a prompt response stuck behind the updates it stopped
 * reading. So "the driver resolves at all" is half the assertion, and the
 * ordering of the flushed chunks against the terminal record is the other half.
 *
 * Verifies: EPIC-06-S24 (scenario 1) · AC5, AC9
 */
import { runAcpNode } from '@DeFlow/adapters';
import type { NodeId, ProviderId, RunId } from '@DeFlow/core';
import { NodeIdSchema, ProviderIdSchema, RunIdSchema } from '@DeFlow/core';
import { appendEvents, readProcesses } from '@DeFlow/ledger';
import { it, TestClock, waitFor } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { cancelNode } from '../../src/cancel.ts';
import { openTestLedger } from './support/ledger.ts';

const RUN: RunId = RunIdSchema.parse('run_20260805T151133Z_9f2a1c');
const NODE: NodeId = NodeIdSchema.parse('implement');
const PROVIDER: ProviderId = ProviderIdSchema.parse('mock');

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

suite('a cooperative cancel is rung 1, and rung 1 alone', () => {
  it('flushes the tail, ends with stopReason cancelled, and never signals (AC5)', async ({
    tmp,
  }) => {
    const worktree = join(tmp, 'wt');
    await mkdir(worktree, { recursive: true });

    const ledger = openTestLedger(tmp, RUN);
    try {
      // The operator's request, recorded by whoever received it (the API,
      // EPIC-15). The scheduler turns it into the CancelNode below.
      appendEvents(ledger.db, [
        {
          runId: RUN,
          ts: 1,
          kind: 'run.cancel.requested',
          v: 1,
          epoch: 1,
          payload: { mode: 'cooperative' },
        },
      ]);

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
          clock: new TestClock(1_754_313_000_000),
          ledger: ledger.sink,
          processes: ledger.processes,
          captureEvidence: (evidence: string | Uint8Array) =>
            `artifact://${createHash('sha256').update(evidence).digest('hex')}` as never,
          signal: controller.signal,
        },
      );

      // Wait until the agent is genuinely mid-turn, so the cancel interrupts
      // work rather than racing the handshake.
      await waitFor(
        () => ledger.events().some((event) => event.payload.phase === 'agent_message_chunk'),
        { describe: 'the agent to be streaming', timeoutMs: 20_000 },
      );

      const signalled: string[] = [];
      const report = await cancelNode(
        { kind: 'CancelNode', runId: RUN, node: NODE, attempt: 0, mode: 'cooperative' },
        {
          db: ledger.db,
          clock: new TestClock(1_754_313_000_000),
          epoch: 1,
          killTree: (_pid: number, signal: NodeJS.Signals) => {
            signalled.push(signal);
          },
          protocolCancel: async () => {
            controller.abort();
            return (await turn).status === 'cancelled';
          },
        },
      );

      const outcome = await turn;
      expect(outcome.status).toBe('cancelled');
      if (outcome.status !== 'cancelled') return;
      expect(outcome.stopReason).toBe('cancelled');

      // Rung 1 answered, so rungs 2 and 3 were never climbed.
      expect(report.outcome).toBe('flushed');
      expect(signalled).toEqual([]);

      const events = ledger.events();
      const stages = events.filter((event) => event.kind === 'node.cancel.stage');
      expect(stages.map((event) => event.payload.stage)).toEqual(['protocol']);
      // The pid and the pgid are on the stage event, read from the `process`
      // row the spawn wrote — not invented by the driver.
      expect(stages[0]?.payload).toMatchObject({ pid: outcome.pgid, pgid: outcome.pgid });

      // The tail the agent flushed after the cancel is on the log, and it is
      // there *before* the terminal record — which is what a client that tore
      // its reader down would have lost.
      const tail = events.filter((event) => `${event.payload.message}`.startsWith('flushing tail'));
      expect(tail.length).toBe(2);
      const terminal = events.find((event) => event.kind === 'node.cancelled');
      expect(terminal?.payload).toEqual({
        node: NODE,
        attempt: 0,
        result: { status: 'cancelled', by: 'user' },
      });
      for (const chunk of tail) expect(chunk.seq).toBeLessThan(terminal?.seq ?? 0);

      // And nothing is left claiming a live process for a future reaper.
      expect(readProcesses(ledger.db).filter((row) => row.state === 'live')).toEqual([]);
    } finally {
      ledger.close();
    }
  });
});
