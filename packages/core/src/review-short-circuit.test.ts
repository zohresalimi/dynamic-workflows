/**
 * KAR-12.2 AC11 — the ladder's short-circuit, asserted from the review side.
 *
 * KAR-12.1 asserts it from the runner's: a red typecheck opens no adversarial
 * tier. This file asks the same question the other way round, because the two
 * can drift apart in exactly one direction that matters — a review admitted on
 * a milestone whose deterministic gate has not answered is a review whose
 * findings are all about the breakage, and it is bought with money.
 *
 * `needs-human` is the row worth having: a gate whose own tooling failed has
 * not said the work is good, it has said it could not tell, and opening the
 * next tier on it buys a review on the strength of a check that never ran.
 *
 * Verifies: EPIC-12-S11 (background) · AC11
 */
import { expect, it, describe as suite } from 'vitest';
import { admitGates, type LadderGate } from './gate-ladder.ts';
import type { GateId, NodeId } from './ids.ts';
import type { VerdictOutcome } from './verdict.ts';

const gate = (node: string, kind: LadderGate['kind']): LadderGate => ({
  node: node as NodeId,
  gate: `${node}-def` as GateId,
  kind,
});

const TYPECHECK = gate('typecheck', 'deterministic');
const CONFLICT = gate('merge-conflict', 'structural');
const REVIEW = gate('design-review', 'adversarial');

const LADDER = [REVIEW, CONFLICT, TYPECHECK] as const;

const outcomes = (entries: Record<string, VerdictOutcome>): ReadonlyMap<NodeId, VerdictOutcome> =>
  new Map(Object.entries(entries).map(([node, outcome]) => [node as NodeId, outcome]));

const admitted = (recorded: Record<string, VerdictOutcome>): string[] =>
  admitGates([...LADDER], outcomes(recorded)).map((entry) => String(entry.node));

suite('the adversarial gate is not admitted below a lacking pass (AC11)', () => {
  it('is withheld while a deterministic gate has not answered', () => {
    expect(admitted({})).toEqual(['typecheck']);
  });

  it('is withheld when a deterministic gate failed', () => {
    expect(admitted({ typecheck: 'fail' })).toEqual([]);
  });

  it('is withheld when a deterministic gate could not tell', () => {
    expect(admitted({ typecheck: 'needs-human' })).toEqual([]);
  });

  it('is withheld while a structural gate has not answered', () => {
    expect(admitted({ typecheck: 'pass' })).toEqual(['merge-conflict']);
  });

  it('is withheld when a structural gate failed', () => {
    expect(admitted({ typecheck: 'pass', 'merge-conflict': 'fail' })).toEqual([]);
  });

  it('is admitted only once every gate below it has a pass', () => {
    expect(admitted({ typecheck: 'pass', 'merge-conflict': 'pass' })).toEqual(['design-review']);
  });

  it('is admitted no earlier when the plan lists it first', () => {
    // The set above is authored adversarial-first on purpose: a ladder that
    // read array order would admit the review immediately and look correct on
    // every plan that happened to be authored the other way round.
    expect(LADDER[0]).toBe(REVIEW);
    expect(admitted({})).toEqual(['typecheck']);
  });
});
