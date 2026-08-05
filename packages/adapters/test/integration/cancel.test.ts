/**
 * EPIC-05-S4 — cancel mid-turn: the tail is flushed before the process dies.
 *
 * Stage 1 of the three-stage cancellation is the only stage that produces a
 * clean transcript, and it only works if the reader keeps running. Per §2.5 a
 * client should keep accepting `session/update` after sending `session/cancel`
 * — the agent flushes its final updates and then answers the prompt with
 * `stopReason: 'cancelled'`. A client that tears its reader down on cancel
 * loses the tail and can deadlock waiting for a prompt response that is stuck
 * behind the updates it stopped reading.
 *
 * Asserting the **seq ordering** rather than merely the presence of the
 * trailing events is what makes "the tail arrived before we killed it"
 * observable.
 *
 * Verifies: EPIC-05-S4 · AC5 · test plan #6
 */

import { makeTempDir, removeTempDir, TestClock, waitFor } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import type { EventRecord, LedgerSink } from '../../src/index.ts';
import { runAcpNode } from '../../src/index.ts';
import {
  mockAgentBinary,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  scenario,
  type TestLedger,
} from './support/harness.ts';

let dir = '';
let worktree = '';
let ledger: TestLedger;

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  await mkdir(worktree, { recursive: true });
  ledger = openTestLedger(dir);
});

afterEach(async () => {
  ledger.close();
  await removeTempDir(dir);
});

/** A sink that calls back once an event matching `when` has been made durable,
 * so a spec can act on what the ledger *has*, not on a sleep. */
function afterAppend(sink: LedgerSink, when: (event: EventRecord) => boolean, then: () => void) {
  return {
    ...sink,
    async append(event: EventRecord) {
      const seq = await sink.append(event);
      if (when(event)) then();
      return seq;
    },
  } satisfies LedgerSink;
}

const phaseOf = (event: EventRecord): string =>
  (event.payload as { phase?: string }).phase ?? event.kind;

suite('trailing updates after the cancel are appended, not discarded', () => {
  it('flushes the tail, resolves with stopReason cancelled, and never signals the child', async () => {
    const controller = new AbortController();
    let chunks = 0;

    // The operator's request is a run-level fact, recorded by whoever received
    // it (the API, EPIC-15). Cooperative: the protocol cancel first.
    ledger.appendRunEvent('run.cancel.requested', { mode: 'cooperative' });

    const sink = afterAppend(
      ledger.sink,
      (event) => phaseOf(event) === 'agent_message_chunk',
      () => {
        chunks += 1;
        // Two chunks in, the mock is wedged in `hangForever`.
        if (chunks === 2) controller.abort();
      },
    );

    const outcome = await runAcpNode(
      {
        runId: RUN_ID,
        nodeId: NODE_ID,
        attempt: 0,
        provider: PROVIDER,
        permission: 'worktree',
        worktree,
        binary: mockAgentBinary(),
        argv: ['--seed', '42', '--scenario', scenario('hang-forever.jsonc')],
        mcpServers: [],
        prompt: 'do something long',
      },
      {
        clock: new TestClock(),
        ledger: sink,
        captureEvidence: ledger.captureEvidence,
        signal: controller.signal,
      },
    );

    expect(outcome.status).toBe('cancelled');
    if (outcome.status !== 'cancelled') return;
    expect(outcome.stopReason).toBe('cancelled');
    expect(outcome.by).toBe('user');

    const events = ledger.events();
    const messages = events
      .filter((event) => event.payload.phase === 'agent_message_chunk')
      .map((event) => event.payload.message);

    // The two the mock declares it flushes on cancel — the tail a client that
    // tore its reader down would have lost.
    expect(messages).toContain('flushing tail 1');
    expect(messages).toContain('flushing tail 2');

    const tailSeqs = events
      .filter((event) => `${event.payload.message}`.startsWith('flushing tail'))
      .map((event) => event.seq);
    const completion = events.find((event) => event.payload.phase === 'cancelled');
    expect(completion).toBeDefined();
    for (const seq of tailSeqs) expect(seq).toBeLessThan(completion?.seq ?? 0);

    // Stage 1 succeeded, so no signal was ever sent: the child ended on its
    // own when stdin closed.
    expect(outcome.exit).toEqual({ code: 0, signal: null });
  });
});

suite('an agent that ignores the protocol cancel', () => {
  it('is signalled after the grace window on the injected clock, and fails as a timeout', async () => {
    const clock = new TestClock();
    const controller = new AbortController();

    const sink = afterAppend(
      ledger.sink,
      (event) => phaseOf(event) === 'session.opened',
      () => controller.abort(),
    );

    const running = runAcpNode(
      {
        runId: RUN_ID,
        nodeId: NODE_ID,
        attempt: 0,
        provider: PROVIDER,
        permission: 'worktree',
        worktree,
        binary: mockAgentBinary(),
        argv: ['--seed', '42', '--scenario', scenario('hang-forever-ignoring-cancel.jsonc')],
        mcpServers: [],
        prompt: 'do something that never ends',
      },
      {
        clock,
        ledger: sink,
        captureEvidence: ledger.captureEvidence,
        signal: controller.signal,
      },
    );

    // The escalation is armed by the cancel, and nothing moves until the clock
    // does — six hours or five seconds cost the same here. Real timers are
    // never faked: the child is alive, and `vi.useFakeTimers()` would freeze
    // the event loop its I/O arrives on.
    await waitFor(() => clock.pending > 0, {
      describe: 'the cancellation grace timer to be armed',
    });
    await clock.advance(5_000);

    const outcome = await running;
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;

    expect(outcome.failure.reason).toBe('timeout');
    expect(outcome.failure.class).toBe('transient');
    // The transcript is marked incomplete rather than presented as clean.
    expect(outcome.failure.detail).toMatchObject({ transcript: 'incomplete' });
    expect(outcome.exit?.signal).toBe('SIGTERM');

    const failed = ledger.events().find((event) => event.kind === 'node.failed');
    expect(failed?.payload).toMatchObject({ failure: { reason: 'timeout' } });
  });
});
