/**
 * KAR-16.3 — `planHistory.ts`, the version rail behind the F10.2 scrubber.
 *
 * Verifies: EPIC-16-S17 · AC4
 */
import { expect, it, describe as suite } from 'vitest';
import { fold, ledger, unknownKind } from '../../../test/run-fixtures.ts';
import {
  applyPlanHistory,
  emptyPlanHistory,
  type PlanHistoryProjection,
  versionsOf,
} from './planHistory.ts';

const THREE = 'three-patches';

const history = (): PlanHistoryProjection => fold(THREE, emptyPlanHistory, applyPlanHistory);

suite('EPIC-16-S17 — reducing the three-patches fixture (AC4)', () => {
  it('produces four versions: v1 from plan.proposed and v2..v4 from plan.patched', () => {
    const versions = versionsOf(history());

    expect(versions.map((entry) => entry.version)).toEqual([1, 2, 3, 4]);
    expect(versions.map((entry) => entry.seq)).toEqual([100, 104, 108, 112]);
  });

  it('carries a planHash, a decision and a human-readable reason on every entry', () => {
    const versions = versionsOf(history());

    for (const entry of versions) {
      expect(entry.planHash).toMatch(/^sha256-[0-9a-f]{64}$/);
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }

    // v1 is the initial compile and no patch decided it — which is exactly what
    // the daemon's own `…/plans` response says (`decision: null`). Inventing an
    // `auto` for it would report a rule that never fired.
    expect(versions.map((entry) => entry.decision)).toEqual([null, 'auto', 'approved', 'auto']);
    expect(versions.map((entry) => entry.by)).toEqual([null, 'policy', 'human', 'policy']);
  });

  it('renders each patch’s own reason verbatim, never summarised', () => {
    expect(versionsOf(history()).map((entry) => entry.reason)).toEqual([
      'the initial plan',
      'a security review is required before checkout ships',
      'the checkout rewrite is two independent changes',
      'claude-code is out of quota for the next four hours',
    ]);
  });
});

suite('EPIC-16-S17 — a rejected proposal is still history', () => {
  it('puts the rejection on the rail, with the rule that refused it and by whom', () => {
    const rejected = history().rail.filter((entry) => entry.kind === 'rejected');

    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.patchId).toBe('p-widen-scope');
    expect(rejected[0]?.rule).toBe('escalates-permission');
    expect(rejected[0]?.by).toBe('policy');
    expect(rejected[0]?.reason).toBe('the payment step needs to edit the shared money helper');
  });

  it('does not advance the plan version', () => {
    const state = history();

    expect(versionsOf(state)).toHaveLength(4);
    expect(state.version).toBe(4);
  });

  it('can answer “what was proposed and refused” as well as “what was applied”', () => {
    const state = history();
    const applied = versionsOf(state).map((entry) => entry.patchId);
    const refused = state.rail
      .filter((entry) => entry.kind === 'rejected')
      .map((entry) => entry.patchId);

    expect(applied).toEqual([null, 'p-insert-review', 'p-split-impl', 'p-reroute-payment']);
    expect(refused).toEqual(['p-widen-scope']);
  });
});

suite('EPIC-16-S17 — content hashes per node', () => {
  it('gives every node in every version a stable change-detection hash', () => {
    for (const version of versionsOf(history())) {
      expect(version.nodes.size).toBeGreaterThan(0);
      for (const hash of version.nodes.values()) expect(hash).toMatch(/^h-[0-9a-f]{8,}$/);
    }
  });

  it('leaves an untouched node’s hash identical across versions, and moves a changed one', () => {
    const versions = versionsOf(history());
    const [, , v3, v4] = versions;

    // v3 → v4 replaces the provider on `impl-checkout-payment` and nothing else.
    expect(v4?.nodes.get('impl-checkout-cart')).toBe(v3?.nodes.get('impl-checkout-cart'));
    expect(v4?.nodes.get('impl-checkout-payment')).not.toBe(v3?.nodes.get('impl-checkout-payment'));
  });

  it('records the split: the node that was split leaves, and its two halves arrive', () => {
    const [, v2, v3] = versionsOf(history());

    expect([...(v2?.nodes.keys() ?? [])].toSorted()).toEqual([
      'impl-checkout',
      'recon',
      'review-checkout',
    ]);
    expect([...(v3?.nodes.keys() ?? [])].toSorted()).toEqual([
      'impl-checkout-cart',
      'impl-checkout-payment',
      'recon',
      'review-checkout',
    ]);
  });
});

suite('EPIC-16-S17 — the seq index the scrubber needs', () => {
  it('exposes planVersionSeq[N] for every version, because "show me N" is replayTo(it)', () => {
    const state = history();

    expect([...state.planVersionSeq.entries()].toSorted(([left], [right]) => left - right)).toEqual(
      [
        [1, 100],
        [2, 104],
        [3, 108],
        [4, 112],
      ],
    );
  });
});

suite('AC11 — an unknown kind is ignored, without throwing and without mutating', () => {
  it('leaves the projection byte-identical', () => {
    const state = history();
    const before = structuredClone(state);

    expect(() => {
      applyPlanHistory(state, unknownKind(9_100, ledger(THREE)[0]?.runId ?? ''));
    }).not.toThrow();

    expect({ ...state, appliedSeq: before.appliedSeq }).toEqual(before);
  });
});
