/**
 * KAR-19.10 AC4 — the tab folds the choice a run was admitted onto.
 *
 * The red: the UI had no way at all to say which agent a run was on, so an
 * operator comparing `deflow doctor`'s report with what a run actually did had
 * only the terminal to go on — and on 2026-08-13 the terminal did not say
 * either. Three surfaces have to answer it now, and this is the fold behind the
 * third.
 *
 * The row worth reading twice is the refusal one: a refused run writes the same
 * event kind, one per registered provider, and none of them carries a `chosen`
 * block, because a refusal chose nothing. Folding one of those as a choice
 * would put a provider's name in the run header of a run that never started.
 *
 * Verifies: EPIC-19-S67 · AC4
 */
import type { Event } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { applyProvider, emptyProvider } from './provider.ts';

/** A `provider.probed` envelope, as the stream delivers it. */
const probed = (seq: number, payload: Record<string, unknown>): Event =>
  ({
    seq,
    runId: 'run_20260813T120000Z_aaaaaa',
    ts: 1_755_000_000_000,
    kind: 'provider.probed',
    v: 1,
    epoch: 1,
    payload,
  }) as unknown as Event;

const ADMITTED = {
  provider: 'mock',
  admission: 'installed',
  vendorBin: 'deflow-mock-agent',
  vendorPath: '/tmp/deflow-bin/deflow-mock-agent',
  adapterBin: 'deflow-mock-agent',
  adapterPath: '/tmp/deflow-bin/deflow-mock-agent',
  package: 'deflow',
  chosen: {
    route: 'shim',
    binaryPath: '/tmp/deflow-bin/deflow-mock-agent',
    routes: { acp: 'available', shim: 'available' },
    unserved: [],
  },
};

suite('applyProvider — the choice, folded once (AC4)', () => {
  it('holds the three facts the announcement is composed from', () => {
    const state = emptyProvider();
    applyProvider(state, probed(1, ADMITTED));

    expect(state.chosen).toEqual({
      provider: 'mock',
      binaryPath: '/tmp/deflow-bin/deflow-mock-agent',
      route: 'shim',
      routes: { acp: 'available', shim: 'available' },
      limitation: null,
    });
  });

  it('carries AC7 s limitation when the machine cannot serve every turn', () => {
    const state = emptyProvider();
    applyProvider(
      state,
      probed(1, {
        ...ADMITTED,
        chosen: {
          route: 'shim',
          binaryPath: '/opt/bin/claude',
          routes: { acp: 'missing', shim: 'available' },
          unserved: ['node execution'],
          limitation: 'node execution needs the ACP bridge',
        },
      }),
    );

    expect(state.chosen?.routes).toEqual({ acp: 'missing', shim: 'available' });
    expect(state.chosen?.limitation).toBe('node execution needs the ACP bridge');
  });

  it('folds no choice from a refusal row, which carries none', () => {
    const state = emptyProvider();
    applyProvider(
      state,
      probed(1, {
        provider: 'claude',
        admission: 'not-installed',
        vendorBin: 'claude',
        vendorPath: null,
        adapterBin: 'claude-agent-acp',
        adapterPath: null,
        package: '@agentclientprotocol/claude-agent-acp',
      }),
    );

    expect(state.chosen).toBeNull();
    // The cursor still moved: the frame was seen.
    expect(state.appliedSeq).toBe(1);
  });

  it('re-announces when the route changes between phases (AC5)', () => {
    const state = emptyProvider();
    applyProvider(state, probed(1, ADMITTED));
    applyProvider(
      state,
      probed(2, {
        ...ADMITTED,
        chosen: { ...ADMITTED.chosen, route: 'acp', binaryPath: '/tmp/deflow-bin/other-agent' },
      }),
    );

    // The later row wins rather than being ignored: a run whose route changes
    // says so again, and the header has to follow it rather than keep showing
    // the route the run has stopped taking.
    expect(state.chosen?.route).toBe('acp');
    expect(state.chosen?.binaryPath).toBe('/tmp/deflow-bin/other-agent');
  });

  it('ignores a malformed choice rather than holding half of one', () => {
    const state = emptyProvider();
    applyProvider(state, probed(1, { ...ADMITTED, chosen: { route: 'telepathy' } }));

    expect(state.chosen).toBeNull();
  });
});
