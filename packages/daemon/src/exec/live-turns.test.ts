/**
 * KAR-27.9 AC1 — the registry that makes `protocolCancel` a production port
 * rather than a test fixture.
 *
 * The connection is the adapter's, and it dies with the process that holds it;
 * the ledger row that names the attempt outlives both. This is the join between
 * them, and every assertion here is about a case that actually happens: a
 * cancel for an attempt this daemon never started, a second ask for one it did,
 * and a turn that has already ended.
 *
 * Verifies: EPIC-27-S41 · KAR-27.9 AC1
 */
import type { ProcessKey } from '@DeFlow/ledger';
import { expect, it, describe as suite } from 'vitest';
import { createLiveTurns } from './live-turns.ts';

const KEY: ProcessKey = { runId: 'run_20260826T090000Z_1a2b3c', nodeId: 'impl-auth', attempt: 0 };
const OTHER: ProcessKey = { ...KEY, nodeId: 'impl-router' };

/** A turn that answers the ask, once somebody makes it. */
function turn(answer = true) {
  let asks = 0;
  let settle: (value: boolean) => void = () => {};
  const cancelled = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  return {
    asks: () => asks,
    /** Ends the turn as the agent would, once it has flushed. */
    finish: () => settle(answer),
    turn: {
      cancel: () => {
        asks += 1;
      },
      cancelled,
    },
  };
}

suite('AC1 — the ask reaches the turn this daemon is holding', () => {
  it('asks the registered turn and answers what it answered', async () => {
    const turns = createLiveTurns();
    const one = turn();
    turns.register(KEY, one.turn);

    const asked = turns.protocolCancel(KEY);
    // The ask is delivered synchronously; the *answer* waits for the flush.
    expect(one.asks()).toBe(1);
    one.finish();
    expect(await asked).toBe(true);
  });

  it('reports an agent that never answered as unanswered, and never as stopped', async () => {
    const turns = createLiveTurns();
    const one = turn(false);
    turns.register(KEY, one.turn);
    const asked = turns.protocolCancel(KEY);
    one.finish();
    expect(await asked).toBe(false);
  });

  it('asks each attempt its own turn, never the first one twice', () => {
    const turns = createLiveTurns();
    const first = turn();
    const second = turn();
    turns.register(KEY, first.turn);
    turns.register(OTHER, second.turn);

    void turns.protocolCancel(OTHER);
    expect(first.asks()).toBe(0);
    expect(second.asks()).toBe(1);
  });

  it('asks once however many times it is told to, so a tick a second is one cancel', () => {
    const turns = createLiveTurns();
    const one = turn();
    turns.register(KEY, one.turn);

    void turns.protocolCancel(KEY);
    void turns.protocolCancel(KEY);
    void turns.protocolCancel(KEY);
    expect(one.asks()).toBe(1);
  });
});

suite('AC1 — an attempt this daemon does not hold', () => {
  it('answers false rather than throwing, because nothing was asked and nothing signalled', async () => {
    const turns = createLiveTurns();
    expect(turns.holds(KEY)).toBe(false);
    expect(await turns.protocolCancel(KEY)).toBe(false);
  });

  it('stops holding a turn once it is disposed, so a restarted attempt is not asked twice', async () => {
    const turns = createLiveTurns();
    const one = turn();
    const dispose = turns.register(KEY, one.turn);
    expect(turns.holds(KEY)).toBe(true);
    expect(turns.size).toBe(1);

    dispose();
    expect(turns.holds(KEY)).toBe(false);
    expect(turns.size).toBe(0);
    expect(await turns.protocolCancel(KEY)).toBe(false);
    expect(one.asks()).toBe(0);
  });

  it('a stale dispose never evicts the attempt that replaced it', () => {
    const turns = createLiveTurns();
    const first = turn();
    const second = turn();
    const staleDispose = turns.register(KEY, first.turn);
    turns.register(KEY, second.turn);

    staleDispose();
    expect(turns.holds(KEY)).toBe(true);
  });
});
