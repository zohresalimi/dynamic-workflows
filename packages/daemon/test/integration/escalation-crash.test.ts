/**
 * KAR-13.4 test 11 / EPIC-13-S28 — `SIGKILL` the daemon with a permission
 * escalation outstanding, and it must not come back.
 *
 * This is the scenario that separates the two kinds of waiting in EPIC-13, and
 * the assertion is deliberately asymmetric: after the crash the `human` node is
 * **still pending** and the permission escalation is **gone**. A gate is durable
 * because it needs nothing but a row; an escalation is bound to a live ACP
 * session, and the daemon that held that pipe is dead. An item left in the queue
 * attached to it would be a decision nothing could act on — the Operator would
 * approve a command that can never be delivered to the agent that asked.
 *
 * `SIGKILL` rather than `SIGTERM`, and a real file-backed ledger, for the same
 * reasons ./human-gate-crash.test.ts gives: *"SIGTERM tests your shutdown
 * handler; SIGKILL tests your durability"*, and `:memory:` cannot be reopened
 * after a crash.
 *
 * Its own file rather than a case in ./permission-escalation.test.ts: this one
 * spawns and kills a process group.
 *
 * Verifies: EPIC-13-S28 · AC8
 */
import type { Db } from '@DeFlow/core';
import { approvalsProjection, initialRunState, openHumanGate, seededRandom } from '@DeFlow/core';
import { openLedger, readRange, readWakes, replayAll } from '@DeFlow/ledger';
import { type Crashable, it, startCrashable, TestClock, waitFor } from '@DeFlow/testkit';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { recover } from '../../src/recovery.ts';
import {
  AGENT,
  EPOCH,
  ESCALATION_RUN,
  GATE,
  GATE_PROMPT,
  SESSION_ID,
  T0,
} from './support/escalation-run.ts';

const HANG_SCRIPT = fileURLToPath(new URL('./support/hang-with-escalation.ts', import.meta.url));

const alive: Crashable[] = [];

afterEach(async () => {
  await Promise.all(alive.splice(0).map((child) => child.sigkill()));
});

const payloads = (db: Db, kind: string): Record<string, unknown>[] =>
  readRange(db, ESCALATION_RUN, 0, 500)
    .events.filter((event) => event.kind === kind)
    .map((event) => event.payload as Record<string, unknown>);

/** Crashes a daemon that had both waits open, and recovers over what it left. */
async function crashAndRecover(tmp: string): Promise<Db> {
  const readyFile = join(tmp, 'ready.json');
  const child = startCrashable({ script: HANG_SCRIPT, args: [tmp, readyFile] });
  alive.push(child);

  await waitFor(() => existsSync(readyFile), {
    describe: 'the child to open both waits',
    timeoutMs: 20_000,
  });
  // No cleanup, no flush, no handlers.
  await child.sigkill();
  alive.splice(alive.indexOf(child), 1);

  const restarted = openLedger(tmp);
  expect(restarted.prepare<{ integrity_check: string }>('PRAGMA integrity_check').get()).toEqual({
    integrity_check: 'ok',
  });

  await recover({
    db: restarted,
    clock: new TestClock(T0 + 60_000),
    epoch: EPOCH + 1,
    daemonStartedAt: T0 + 60_000,
    random: seededRandom(13),
  });

  return restarted;
}

suite('EPIC-13-S28 — a queue item must never outlive the thing that can answer it', () => {
  it('fails the node with the lost session named, and takes the item out of the queue', async ({
    tmp,
  }) => {
    const db = await crashAndRecover(tmp);
    try {
      const state = replayAll(db).runs.get(ESCALATION_RUN) ?? initialRunState();

      // "The permission queue item is removed rather than left unanswerable."
      expect(openHumanGate(state, AGENT)).toBeNull();
      const queue = approvalsProjection([{ runId: ESCALATION_RUN, state }]).items;
      expect(queue.filter((item) => item.kind === 'permission')).toEqual([]);
      // The `human_gate` row went with the answer, in one transaction. The row
      // this node still holds is the retry backoff, which is the *next
      // attempt* — a different wait, for a different reason.
      const wakes = readWakes(db, ESCALATION_RUN);
      expect(wakes.filter((row) => row.reason === 'human_gate').map((row) => row.nodeId)).toEqual([
        GATE,
      ]);
      expect(wakes.filter((row) => row.nodeId === AGENT).map((row) => row.reason)).toEqual([
        'backoff',
      ]);

      // "The node fails with a typed reason naming the lost session."
      const failure = state.nodes[AGENT]?.failure;
      expect(failure?.reason).toBe('internal');
      expect(failure?.class).toBe('transient');
      expect(failure?.detail).toMatchObject({ cause: 'lost-session', sessionId: SESSION_ID });
      expect(failure?.message).toContain(SESSION_ID);

      // "A new attempt is scheduled with a new idempotency key" — the retry
      // ladder's own row, which is what mints the next attempt.
      expect(payloads(db, 'node.retry.scheduled')).toHaveLength(1);
      expect(payloads(db, 'node.retry.scheduled')[0]).toMatchObject({
        node: AGENT,
        nextAttempt: 1,
      });

      // The closure is recorded, not silent: a reader can see why.
      const responded = payloads(db, 'human.responded');
      expect(responded).toHaveLength(1);
      expect(responded[0]).toMatchObject({
        node: AGENT,
        optionId: 'reject_once',
        by: 'policy',
        text: `lost-session:${SESSION_ID}`,
      });
    } finally {
      db.close();
    }
  });

  it('leaves the human gate in the same run untouched', async ({ tmp }) => {
    const db = await crashAndRecover(tmp);
    try {
      const state = replayAll(db).runs.get(ESCALATION_RUN) ?? initialRunState();

      // The distinction: a human gate needs no live process, so it is still
      // waiting for the same person about the same question.
      expect(openHumanGate(state, GATE)).toMatchObject({ prompt: GATE_PROMPT, response: null });
      expect(state.nodes[GATE]?.status).toBe('suspended');
      expect(readWakes(db, ESCALATION_RUN).map((row) => row.nodeId)).toContain(GATE);

      const queue = approvalsProjection([{ runId: ESCALATION_RUN, state }]).items;
      expect(queue.map((item) => item.kind)).toEqual(['human-node']);
    } finally {
      db.close();
    }
  });

  it('re-asks nobody: the escalation is closed once, not re-opened', async ({ tmp }) => {
    const db = await crashAndRecover(tmp);
    try {
      // Two requests were on disk before the crash — the gate's and the
      // escalation's — and recovery adds none.
      expect(payloads(db, 'human.requested')).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
