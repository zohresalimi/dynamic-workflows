/**
 * KAR-12.1 test plan #1, #2 — the ladder derivation.
 *
 * Verifies: EPIC-12-S3 · AC1, AC2
 */

import { expect, it, describe as suite } from 'vitest';
import {
  admitGates,
  GATE_CLASSES,
  type GateClass,
  type LadderGate,
  orderGates,
} from './gate-ladder.ts';
import type { GateId, NodeId } from './ids.ts';

const gate = (kind: GateClass): LadderGate => ({
  node: `gate-${kind}` as NodeId,
  gate: `${kind}-check` as GateId,
  kind,
});

const ONE_OF_EACH: readonly LadderGate[] = GATE_CLASSES.map(gate);

/** The set inserted in an order that is not the ladder's (S3, second scenario). */
const SHUFFLED: readonly LadderGate[] = [
  gate('adversarial'),
  gate('deterministic'),
  gate('structural'),
];

const outcomes = (
  entries: readonly (readonly [GateClass, 'pass' | 'fail' | 'needs-human'])[],
): Map<NodeId, 'pass' | 'fail' | 'needs-human'> =>
  new Map(entries.map(([kind, outcome]) => [gate(kind).node, outcome]));

suite('the ladder is derived, not incidental (S3, second scenario)', () => {
  it('orders a shuffled gate set deterministic → structural → adversarial → human', () => {
    expect(orderGates(SHUFFLED).map((entry) => entry.kind)).toEqual([
      'deterministic',
      'structural',
      'adversarial',
    ]);
  });

  it('admits the deterministic gate first, whatever the insertion order', () => {
    expect(admitGates(SHUFFLED, new Map()).map((entry) => entry.kind)).toEqual(['deterministic']);
  });

  it('keeps the ladder in the documented order', () => {
    expect([...GATE_CLASSES]).toEqual(['deterministic', 'structural', 'adversarial', 'human']);
  });
});

suite('the first failing tier stops the rest (S3, first scenario)', () => {
  /** Runs the ladder to a standstill, recording which tiers were ever admitted. */
  const tiersThatRan = (failing: GateClass | 'none'): GateClass[] => {
    const recorded = new Map<NodeId, 'pass' | 'fail' | 'needs-human'>();
    const ran: GateClass[] = [];

    for (;;) {
      const admissible = admitGates(ONE_OF_EACH, recorded);
      if (admissible.length === 0) return ran;
      for (const entry of admissible) {
        ran.push(entry.kind);
        recorded.set(entry.node, entry.kind === failing ? 'fail' : 'pass');
      }
    }
  };

  it.each([
    ['deterministic', ['deterministic']],
    ['structural', ['deterministic', 'structural']],
    ['adversarial', ['deterministic', 'structural', 'adversarial']],
    ['none', ['deterministic', 'structural', 'adversarial', 'human']],
  ] as const)('failing tier %s runs %j', (failing, ran) => {
    expect(tiersThatRan(failing)).toEqual([...ran]);
  });
});

suite('a tier opens only on a pass below it (AC1)', () => {
  it('withholds the structural gate until the deterministic one has passed', () => {
    expect(admitGates(ONE_OF_EACH, outcomes([])).map((entry) => entry.kind)).toEqual([
      'deterministic',
    ]);
    expect(
      admitGates(ONE_OF_EACH, outcomes([['deterministic', 'pass']])).map((entry) => entry.kind),
    ).toEqual(['structural']);
  });

  it('admits nothing further once a tier returned fail (AC2)', () => {
    expect(admitGates(ONE_OF_EACH, outcomes([['deterministic', 'fail']]))).toEqual([]);
  });

  it('treats needs-human as a stop, not as a pass', () => {
    expect(admitGates(ONE_OF_EACH, outcomes([['deterministic', 'needs-human']]))).toEqual([]);
  });

  it('admits every unevaluated gate in the open tier at once', () => {
    const two: readonly LadderGate[] = [
      { node: 'gate-typecheck' as NodeId, gate: 'typecheck' as GateId, kind: 'deterministic' },
      { node: 'gate-lint' as NodeId, gate: 'lint' as GateId, kind: 'deterministic' },
    ];
    expect(admitGates(two, new Map()).map((entry) => entry.gate)).toEqual(['typecheck', 'lint']);
  });

  it('returns nothing when every gate has already been evaluated', () => {
    const all = outcomes(GATE_CLASSES.map((kind) => [kind, 'pass'] as const));
    expect(admitGates(ONE_OF_EACH, all)).toEqual([]);
  });
});
