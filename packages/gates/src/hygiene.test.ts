/**
 * KAR-12.6 test plan #8, AC6, AC7 — the gate-hygiene projection: a gate
 * nothing schedules is decoration, and the first-pass rate is informative at
 * both tails.
 *
 * This story specifies the projection and its threshold; EPIC-18 mounts the
 * `DeFlow doctor` command that prints it.
 *
 * Verifies: EPIC-12-S38 · AC6, AC7
 */
import type { GateId } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { gateHygiene } from './hygiene.ts';

const gate = (id: string) => id as GateId;

const sample = (gateId: string, outcome: 'pass' | 'fail' | 'needs-human') => ({
  gate: gate(gateId),
  outcome,
});

suite('first-pass rate is informative at both tails (S38, outline)', () => {
  const evaluations = [
    ...Array.from({ length: 3 }, () => sample('typecheck', 'pass' as const)),
    ...Array.from({ length: 4 }, () => sample('typecheck', 'fail' as const)),
    ...Array.from({ length: 1 }, () => sample('unit', 'pass' as const)),
    ...Array.from({ length: 9 }, () => sample('unit', 'fail' as const)),
    ...Array.from({ length: 10 }, () => sample('a11y', 'pass' as const)),
  ];

  const reports = gateHygiene({
    definedGates: [gate('typecheck'), gate('unit'), gate('a11y')],
    sampledRuns: 10,
    evaluations,
  });

  const byGate = (id: string) => reports.find((report) => report.gate === id);

  it('typecheck: 3/7 is 0.43, healthy', () => {
    expect(byGate('typecheck')?.firstPassRate).toBe(0.43);
    expect(byGate('typecheck')?.advice).toBe('healthy');
  });

  it('unit: 1/10 is 0.10, below the 40% floor', () => {
    expect(byGate('unit')?.firstPassRate).toBe(0.1);
    expect(byGate('unit')?.advice).toBe('below 40%: the plan or the spec is wrong');
  });

  it('a11y: 10/10 is 1.00, and the top is as informative as the bottom', () => {
    expect(byGate('a11y')?.firstPassRate).toBe(1);
    expect(byGate('a11y')?.advice).toBe('at 100%: testing nothing, or being written to');
  });

  it('the rate is per gate id, not computed jointly over all three', () => {
    // Pooled: (3+1+10) passes / (7+10+10) evaluations = 14/27 ≈ 0.52 for every
    // gate. Per-gate, the three rates are all different — which is the
    // assertion that a joint computation would fail.
    const rates = reports.map((report) => report.firstPassRate);
    expect(new Set(rates).size).toBe(3);
  });
});

suite('a gate nothing schedules is decoration (AC6)', () => {
  it('reports a defined gate with zero evaluations as never-evaluated, with the run count', () => {
    const [report] = gateHygiene({
      definedGates: [gate('a11y')],
      sampledRuns: 10,
      evaluations: [],
    });

    expect(report?.neverEvaluated).toBe(true);
    expect(report?.sampledRuns).toBe(10);
    expect(report?.firstPassRate).toBeNull();
    expect(report?.advice).toContain('10');
  });

  it('a gate evaluated at least once is not never-evaluated, even if only by needs-human', () => {
    const [report] = gateHygiene({
      definedGates: [gate('review')],
      sampledRuns: 5,
      evaluations: [sample('review', 'needs-human')],
    });

    expect(report?.neverEvaluated).toBe(false);
    // needs-human is neither a pass nor a fail, so it does not move the rate.
    expect(report?.firstPassRate).toBeNull();
  });
});
