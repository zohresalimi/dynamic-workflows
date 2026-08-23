/**
 * KAR-27.3 AC3 — the tab's own answer to *"is a framing turn in flight?"*.
 *
 * The red this exists for: `provider.session_opened` was claimed by no
 * projection, so the one event that says a pre-execution turn started reached
 * the browser and was dropped. The workflow view then had nothing to render but
 * a strip that said nothing, for as long as the turn ran.
 *
 * What is asserted here is the *shell*: the cursor, the container, and that a
 * concluding event clears the turn so the strip goes away without a refresh.
 * The vocabulary itself — which events conclude a turn — is `@DeFlow/core`'s
 * `foldPreExecutionTurns` and is specified in
 * `packages/core/src/pre-execution-turn.test.ts`, deliberately once.
 *
 * Verifies: EPIC-27-S18 · AC3
 */
import type { Event } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { applyLiveTurn, emptyLiveTurn, liveTurnOf } from './liveTurn.ts';

const RUN = 'run_20260823T104141Z_e9eac2';
const TS = 1_787_000_000_000;

const envelope = (seq: number, kind: string, payload: Record<string, unknown>, ts = TS): Event =>
  ({ seq, runId: RUN, ts, kind, v: 1, epoch: 1, payload }) as unknown as Event;

const opened = (seq: number, node: string, attempt: number, ts = TS): Event =>
  envelope(
    seq,
    'provider.session_opened',
    {
      node,
      attempt,
      provider: 'claude',
      session: { id: `9d1f0f2a-0000-4000-8000-00000000000${attempt}`, origin: 'minted' },
    },
    ts,
  );

const failed = (seq: number, node: string, attempt: number): Event =>
  envelope(seq, 'node.failed', {
    node,
    attempt,
    maxAttempts: 3,
    failure: { reason: 'agent.nonzero-exit', class: 'transient', message: 'exited 1' },
  });

suite('applyLiveTurn — a turn starting', () => {
  it('marks the framing turn in flight, with its attempt and since-instant', () => {
    const state = emptyLiveTurn();

    applyLiveTurn(state, opened(4, 'framing', 0));

    const live = liveTurnOf(state);
    expect(live?.node).toBe('framing');
    expect(live?.turn.sessions).toBe(1);
    expect(live?.turn.failures).toBe(0);
    expect(live?.turn.sinceTs).toBe(TS);
  });

  it('answers null before any session has been opened', () => {
    expect(liveTurnOf(emptyLiveTurn())).toBeNull();
  });
});

suite('applyLiveTurn — the strip goes away when the turn concludes (EPIC-27-S18)', () => {
  it.each([
    ['run.created', { spec: {}, cwd: '/repo', repo: { head: 'abcdef1', branch: 'main' } }],
    ['node.failed', { node: 'framing', attempt: 0, failure: {} }],
    ['human.requested', { node: 'framing', prompt: 'Which repository?' }],
  ])('clears the in-flight turn on %s', (kind, payload) => {
    const state = emptyLiveTurn();
    applyLiveTurn(state, opened(4, 'framing', 0));

    applyLiveTurn(state, envelope(5, kind, payload));

    expect(liveTurnOf(state)).toBeNull();
  });

  it('hands the strip over from recon to the planner without a gap', () => {
    const state = emptyLiveTurn();
    applyLiveTurn(state, opened(4, 'recon', 0));

    applyLiveTurn(state, opened(9, 'planner', 0, TS + 1_000));

    expect(liveTurnOf(state)?.node).toBe('planner');
  });
});

suite('applyLiveTurn — the cursor', () => {
  it('moves for every event, including kinds it does not fold', () => {
    const state = emptyLiveTurn();

    applyLiveTurn(state, envelope(11, 'node.progress', { node: 'n1', attempt: 0 }));

    expect(state.appliedSeq).toBe(11);
    expect(liveTurnOf(state)).toBeNull();
  });

  it('ignores a re-delivered frame rather than folding it twice', () => {
    const state = emptyLiveTurn();
    applyLiveTurn(state, opened(4, 'framing', 0));
    applyLiveTurn(state, failed(5, 'framing', 0));

    // The same frame again, as a reconnect delivers it.
    applyLiveTurn(state, failed(5, 'framing', 0));

    expect(state.turns.framing?.failures).toBe(1);
  });

  it('keeps the same record object when an event moved nothing', () => {
    const state = emptyLiveTurn();
    applyLiveTurn(state, opened(4, 'framing', 0));
    const held = state.turns;

    applyLiveTurn(state, envelope(6, 'fact.written', { fact: { provenance: { byNode: 'n1' } } }));

    expect(state.turns).toBe(held);
  });
});
