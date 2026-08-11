/**
 * KAR-16.3 — `blackboard.ts`, the F6.3 / F10.4 projection.
 *
 * Verifies: EPIC-16-S22 · AC12
 */
import { expect, it, describe as suite } from 'vitest';
import { fold, ledger, unknownKind } from '../../../test/run-fixtures.ts';
import { applyBlackboard, type BlackboardProjection, emptyBlackboard } from './blackboard.ts';

const HAPPY = 'happy-path-12';
const board = (): BlackboardProjection => fold(HAPPY, emptyBlackboard, applyBlackboard);

const byKey = (state: BlackboardProjection, key: string) =>
  [...state.facts.values()].find((fact) => fact.key === key);

suite('EPIC-16-S22 — facts with provenance (AC12)', () => {
  it('records which node wrote it, from what evidence, when, and at what confidence', () => {
    const fact = byKey(board(), 'finding/auth-uses-jwt');

    expect(fact?.provenance.byNode).toBe('recon-auth-surface');
    expect(fact?.provenance.byProvider).toBe('claude-code');
    expect(fact?.provenance.fromEvidence).toHaveLength(1);
    expect(fact?.provenance.confidence).toBe('verified');
    // `atEvent` is the ordering key; `at` is display-only, because the wall
    // clock is not monotonic (docs/04 §5.2).
    expect(fact?.provenance.atEvent).toBe(9);
    expect(typeof fact?.provenance.at).toBe('string');
  });

  it('keeps the fact’s kind and schema id, so the inspector can render its value', () => {
    const fact = byKey(board(), 'decision/router-guard-shape');

    expect(fact?.kind).toBe('decision');
    expect(fact?.schemaId).toBe('DeFlow.finding.v1');
  });

  it('records a correction as a new fact pointing at the one it supersedes', () => {
    const state = board();
    const superseding = byKey(state, 'risk/legacy-shim-needed');
    const superseded = byKey(state, 'decision/router-guard-shape');

    expect(superseding?.supersedes).toBe(superseded?.id);
    // The old one is never touched — corrections are additive (docs/04 §5).
    expect(superseded).toBeDefined();
  });
});

suite('EPIC-16-S22 — the consumer set is one query, not an inference', () => {
  it('exposes each fact’s complete consumer set from fact.read', () => {
    const state = board();

    expect(byKey(state, 'finding/auth-uses-jwt')?.consumers.map((one) => one.node)).toEqual([
      'plan-migration',
    ]);
    expect(byKey(state, 'decision/router-guard-shape')?.consumers.map((one) => one.node)).toEqual([
      'impl-login',
    ]);
  });

  it('records the seq each read happened at, because taint is a numeric comparison', () => {
    const consumer = byKey(board(), 'decision/router-guard-shape')?.consumers[0];

    expect(consumer?.seq).toBe(22);
  });

  it('holds a read of a fact it has not seen written, rather than dropping it', () => {
    // Subscribe-backfill and reconnect windows both start mid-run, so a read
    // can legitimately arrive before the write. Dropping it would under-report
    // the consumer set for the life of the tab.
    const state = board();

    expect(byKey(state, 'risk/legacy-shim-needed')?.consumers.map((one) => one.node)).toEqual([
      'impl-signup',
    ]);
  });
});

suite('EPIC-16-S22 — invalidation taints downstream (AC12)', () => {
  it('marks the fact invalid with its reason and the node that invalidated it', () => {
    const fact = byKey(board(), 'decision/router-guard-shape');

    expect(fact?.invalid).not.toBeNull();
    expect(fact?.invalid?.by).toBe('review-security');
    expect(fact?.invalid?.reason).toBe('the guard shape changed in the router upgrade');
    expect(fact?.invalid?.seq).toBe(78);
  });

  it('flags every node in taints[] as having consumed a fact that later proved wrong', () => {
    const state = board();

    expect([...state.taints.keys()].toSorted()).toEqual(['impl-login', 'impl-signup']);
    expect(state.taints.get('impl-login')?.[0]?.reason).toBe(
      'the guard shape changed in the router upgrade',
    );
  });

  it('leaves every other fact valid', () => {
    const valid = [...board().facts.values()].filter((fact) => fact.invalid === null);

    expect(valid.map((fact) => fact.key).toSorted()).toEqual([
      'finding/auth-uses-jwt',
      'risk/legacy-shim-needed',
    ]);
  });
});

suite('EPIC-16-S22 — aggregation is a projection concern, not a rendering one', () => {
  it('groups facts by producing node with a per-node count', () => {
    const state = board();

    expect(
      [...state.byProducer.entries()]
        .map(([node, ids]) => `${node}:${ids.length}`)
        .toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(['plan-migration:1', 'recon-auth-surface:1', 'review-security:1']);
  });
});

suite('AC11 — an unknown kind is ignored, without throwing and without mutating', () => {
  it('leaves the projection byte-identical', () => {
    const state = board();
    const before = structuredClone(state);

    expect(() => {
      applyBlackboard(state, unknownKind(9_100, ledger(HAPPY)[0]?.runId ?? ''));
    }).not.toThrow();

    expect({ ...state, appliedSeq: before.appliedSeq }).toEqual(before);
  });
});
