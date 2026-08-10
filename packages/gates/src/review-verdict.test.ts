/**
 * KAR-12.2 AC6, AC7 — sealing an adversarial verdict with how its reviewer was
 * routed.
 *
 * The reviewer returns a `DeFlow.verdict.v3`-shaped document, because
 * `weakened` is not something a reviewer observed — it is DeFlow's own record
 * of a routing decision. Handing a model a contract with that field in it would
 * invite the one claim in the document only the scheduler can make, so the
 * sealer takes the decision as a separate argument and **overwrites** anything
 * the reviewer put there.
 *
 * The `by.provider` half is the same argument: the provider a verdict names has
 * to be the provider it ran on, not the one the reviewer believes it is.
 *
 * Verifies: EPIC-12-S11, EPIC-12-S14 · AC6, AC7
 */
import {
  type CriterionId,
  type GateId,
  type NodeId,
  type ProviderId,
  VERDICT_V3_SCHEMA_ID,
  VERDICT_V4_SCHEMA_ID,
  type VerdictV3,
} from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { sealReviewVerdict } from './review-verdict.ts';

const OTHER = 'the-other-one' as ProviderId;
const PRODUCER_PROVIDER = 'the-one-that-wrote-it' as ProviderId;

const returned = (overrides: Partial<VerdictV3> = {}): VerdictV3 =>
  ({
    schemaId: VERDICT_V3_SCHEMA_ID,
    outcome: 'pass',
    gate: 'design-review' as GateId,
    evaluatedNode: 'implement-1' as NodeId,
    by: { node: 'design-review' as NodeId, provider: OTHER, model: 'a-model' },
    specHash: `sha256-${'b'.repeat(64)}`,
    criteria: [{ id: 'ac-3' as CriterionId, status: 'satisfied' }],
    findings: [],
    summary: 'Every criterion this gate speaks to is satisfied.',
    cost: { durationMs: 4200 },
    ...overrides,
  }) as VerdictV3;

const routed = (weakened?: 'same-provider') => ({
  provider: weakened === undefined ? OTHER : PRODUCER_PROVIDER,
  ...(weakened === undefined ? {} : { weakened }),
});

suite('a review routed to another provider (AC6)', () => {
  it('seals as a v4 with no weakening', () => {
    const sealed = sealReviewVerdict(returned(), routed());

    expect(sealed.schemaId).toBe(VERDICT_V4_SCHEMA_ID);
    expect(sealed.weakened).toBeUndefined();
    expect(sealed.by.provider).toBe(OTHER);
  });

  it('keeps everything the reviewer actually said', () => {
    const verdict = returned({ outcome: 'fail', summary: 'one blocker in the guard' });
    const sealed = sealReviewVerdict(verdict, routed());

    expect(sealed.outcome).toBe('fail');
    expect(sealed.summary).toBe('one blocker in the guard');
    expect(sealed.criteria).toEqual(verdict.criteria);
    expect(sealed.cost).toEqual(verdict.cost);
  });
});

suite('a review routed onto the producer (AC7)', () => {
  it('seals with weakened same-provider', () => {
    const sealed = sealReviewVerdict(returned(), routed('same-provider'));

    expect(sealed.weakened).toBe('same-provider');
    expect(sealed.by.provider).toBe(PRODUCER_PROVIDER);
  });

  it('overwrites a marker the reviewer put there itself', () => {
    // The `.v3` contract has no `weakened`, so anything in the field arrived
    // some other way — a prompt-only adapter, say. It is a claim about how
    // DeFlow routed, and the reviewer is not in a position to make it.
    const lying = { ...returned(), weakened: 'single-attempt' } as unknown as VerdictV3;

    expect(sealReviewVerdict(lying, routed('same-provider')).weakened).toBe('same-provider');
    expect(sealReviewVerdict(lying, routed()).weakened).toBeUndefined();
  });

  it('names the provider it ran on, not the one the reviewer believes', () => {
    const confused = returned({
      by: { node: 'design-review' as NodeId, provider: OTHER, model: 'a-model' },
    });

    expect(sealReviewVerdict(confused, routed('same-provider')).by.provider).toBe(
      PRODUCER_PROVIDER,
    );
  });
});

suite('the sealed document is valid (AC7)', () => {
  it('rejects a verdict the reviewer returned malformed, rather than sealing it', () => {
    const malformed = { ...returned(), outcome: 'looks-fine' } as unknown as VerdictV3;
    expect(() => sealReviewVerdict(malformed, routed())).toThrow();
  });
});
