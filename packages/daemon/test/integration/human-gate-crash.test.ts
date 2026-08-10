/**
 * KAR-13.1 AC4 / EPIC-13-S3 — `SIGKILL` the daemon while a `human` node is
 * pending, and the gate is still there afterwards.
 *
 * This is the scenario that proves the epic's thesis, and it is why the three
 * writes are one transaction. Nothing about the wait is held in process memory,
 * so the restart case falls out for free rather than needing a recovery path:
 * the new engine replays the ledger, reduces to a state in which the node is
 * suspended, finds the `node_wake` row, and carries on waiting. It is the same
 * code path a running daemon takes on every tick.
 *
 * `SIGKILL` rather than `SIGTERM` is deliberate — *"SIGTERM tests your shutdown
 * handler; SIGKILL tests your durability"* — and the ledger is a real file for
 * the same reason: `:memory:` cannot be reopened after a simulated crash, which
 * is the one property that matters most here (docs/14-testing-strategy.md §7,
 * §11).
 *
 * Its own file rather than a case in ./human-gate.test.ts: this one spawns and
 * kills a process group, and a leaked child poisoning its neighbours is exactly
 * what the integration slice's `pool: 'forks'` is arranged to contain.
 *
 * Verifies: EPIC-13-S3 · AC4
 */
import type { Db } from '@DeFlow/core';
import { initialRunState, NO_DEADLINE_WAKE_AT, openHumanGate } from '@DeFlow/core';
import { openLedger, readRange, readWakes, replayAll } from '@DeFlow/ledger';
import { type Crashable, it, startCrashable, TestClock, waitFor } from '@DeFlow/testkit';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { respondToHumanNode } from '../../src/human/gate.ts';
import {
  driveToTheGate,
  EPOCH,
  GATE,
  HUMAN_RUN,
  PROMPT,
  T0,
  WRITER,
} from './support/human-gate-run.ts';

const HANG_SCRIPT = fileURLToPath(new URL('./support/hang-at-human-gate.ts', import.meta.url));

const alive: Crashable[] = [];

afterEach(async () => {
  await Promise.all(alive.splice(0).map((child) => child.sigkill()));
});

const events = (db: Db) => readRange(db, HUMAN_RUN, 0, 500).events;

suite('EPIC-13-S3 — the gate survives kill -9 (AC4)', () => {
  it('comes back pending, with one request, its row intact and an ok integrity check', async ({
    tmp,
  }) => {
    const readyFile = join(tmp, 'ready.json');
    const child = startCrashable({ script: HANG_SCRIPT, args: [tmp, readyFile] });
    alive.push(child);

    await waitFor(() => existsSync(readyFile), {
      describe: 'the child to reach the human gate',
      timeoutMs: 20_000,
    });

    // No cleanup, no flush, no handlers.
    await child.sigkill();
    alive.splice(alive.indexOf(child), 1);

    const restarted = openLedger(tmp);
    try {
      expect(
        restarted.prepare<{ integrity_check: string }>('PRAGMA integrity_check').get(),
      ).toEqual({ integrity_check: 'ok' });

      const state = replayAll(restarted).runs.get(HUMAN_RUN) ?? initialRunState();

      // Still waiting for the same person about the same question.
      expect(state.status).toBe('running');
      expect(state.nodes[GATE]?.status).toBe('suspended');
      expect(openHumanGate(state, GATE)).toMatchObject({ prompt: PROMPT, response: null });

      // The restart did not re-request: exactly one, not one per daemon life.
      const requested = events(restarted).filter((event) => event.kind === 'human.requested');
      expect(requested).toHaveLength(1);

      // One row, at the same instant, still costing nothing.
      expect(readWakes(restarted, HUMAN_RUN)).toEqual([
        { runId: HUMAN_RUN, nodeId: GATE, wakeAt: NO_DEADLINE_WAKE_AT, reason: 'human_gate' },
      ]);

      // AC1's invariant, asked of a ledger a crash really did produce: never a
      // request without its row, never a `human_gate` row without its request.
      const gated = readWakes(restarted, HUMAN_RUN).filter((row) => row.reason === 'human_gate');
      expect(gated.map((row) => row.nodeId)).toEqual(
        requested.map((event) => (event.payload as { node: string }).node),
      );
    } finally {
      restarted.close();
    }
  });

  it('is still answerable, and the run finishes on a second daemon life', async ({ tmp }) => {
    const readyFile = join(tmp, 'ready.json');
    const child = startCrashable({ script: HANG_SCRIPT, args: [tmp, readyFile] });
    alive.push(child);

    await waitFor(() => existsSync(readyFile), {
      describe: 'the child to reach the human gate',
      timeoutMs: 20_000,
    });
    await child.sigkill();
    alive.splice(alive.indexOf(child), 1);

    const restarted = openLedger(tmp);
    try {
      // A *later* epoch, as a restarted daemon always has. The gate does not
      // care: it is a row and two events, not a lease.
      const answered = respondToHumanNode({
        db: restarted,
        runId: HUMAN_RUN,
        nodeId: GATE,
        optionId: 'yes',
        epoch: EPOCH + 1,
        ts: T0 + 3_600_000,
      });
      expect(answered).toMatchObject({ status: 'ok', http: 200, effect: 'approve' });

      const { started, state } = await driveToTheGate(
        restarted,
        new TestClock(T0 + 3_600_000),
        EPOCH + 1,
      );

      // Nothing from before the crash is re-executed: the sibling completed in
      // the first daemon life and is not started again.
      expect(started).toEqual([WRITER]);
      expect(state.status).toBe('completed');
      expect(events(restarted).filter((event) => event.kind === 'human.responded')).toHaveLength(1);
      expect(readWakes(restarted, HUMAN_RUN)).toEqual([]);
    } finally {
      restarted.close();
    }
  });
});
