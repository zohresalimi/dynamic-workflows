/**
 * KAR-27.9 AC2, AC3 — which cancel ladders a run supports, as one fact read
 * from its route.
 *
 * Verifies: EPIC-27-S42, EPIC-27-S43 · KAR-27.9 AC2, AC3
 */
import { expect, it, describe as suite } from 'vitest';
import {
  cancelLaddersFor,
  cooperativeCancelUnavailable,
  PROTOCOL_CANCEL_ROUTES,
} from './cancel-ladders.ts';
import { forcefulCancelCommand } from './cooperative-cancel.ts';
import { PROVIDER_ROUTES } from './provider-choice.ts';

const RUN = 'run_20260826T090000Z_1a2b3c';

suite('AC3 — the ladders are read from the route, once', () => {
  it('offers both ladders on the ACP route, because the session carries a cancel', () => {
    const ladders = cancelLaddersFor({ route: 'acp', inFlight: true });
    expect(ladders.cooperative).toBe(true);
    expect(ladders.modes).toEqual(['cooperative', 'forceful']);
    expect(ladders.route).toBe('acp');
  });

  it('offers only the forceful ladder on the exec shim, which has no channel at all', () => {
    const ladders = cancelLaddersFor({ route: 'shim', inFlight: true });
    expect(ladders.cooperative).toBe(false);
    expect(ladders.modes).toEqual(['forceful']);
  });

  it('offers both when no route was ever recorded, because nothing was spawned to ask', () => {
    // A run refused at admission, or one still waiting to be framed, has no
    // agent process at all: there is no unendable wait to be accepted into,
    // and refusing the default ladder there would make a run that never
    // started unstoppable without `--force` (EPIC-19-S39).
    const ladders = cancelLaddersFor({ route: null, inFlight: true });
    expect(ladders.cooperative).toBe(true);
    expect(ladders.modes).toEqual(['cooperative', 'forceful']);
    expect(ladders.route).toBeNull();
  });

  it('answers every route in the closed set, so a third route cannot be forgotten', () => {
    for (const route of PROVIDER_ROUTES) {
      const ladders = cancelLaddersFor({ route, inFlight: true });
      expect(ladders.modes).toContain('forceful');
      expect(ladders.cooperative).toBe(PROTOCOL_CANCEL_ROUTES.includes(route));
    }
  });

  it('is a function of its two inputs and of nothing else, so two readers cannot disagree', () => {
    const shim = { route: 'shim', inFlight: true } as const;
    expect(cancelLaddersFor(shim)).toEqual(cancelLaddersFor(shim));
    expect(cancelLaddersFor({ route: 'acp', inFlight: true })).not.toEqual(cancelLaddersFor(shim));
  });

  it('offers both ladders on any route when nothing is running (EPIC-19-S39)', () => {
    // A run that never started has no agent to ask, so the two ladders are the
    // same `run.aborted` on the next tick. Refusing the default one there would
    // make the run `deflow cancel` exists to dispose of need `--force`.
    for (const route of PROVIDER_ROUTES) {
      expect(cancelLaddersFor({ route, inFlight: false }).modes).toEqual([
        'cooperative',
        'forceful',
      ]);
    }
  });
});

suite('AC2 — the refusal names forceful, in the one spelling of it', () => {
  const message = cooperativeCancelUnavailable(RUN, 'shim');

  it('names the run, the route and the ladder that is available', () => {
    expect(message).toContain(RUN);
    expect(message).toContain('exec shim');
    expect(message).toContain(forcefulCancelCommand(RUN));
  });

  it('says why, rather than only that it refuses', () => {
    expect(message).toMatch(/no channel|cannot carry|nothing but a signal/);
  });

  it('warns that the ladder it names may cost the transcript', () => {
    expect(message).toContain('transcript');
  });
});
