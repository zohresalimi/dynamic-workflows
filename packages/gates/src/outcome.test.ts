/**
 * KAR-12.1 test plan #4 and #6 — what makes a gate red.
 *
 * Two rules, and the order between them is the design: findings at or above
 * the floor decide first, because a tool that produced structured output has
 * already said what is wrong and the floor is the gate's decision about which
 * of those matter. The exit code decides only when the parser found nothing to
 * say — which is the whole of the evidence for `parser: none`.
 *
 * Verifies: EPIC-12-S7 (second scenario), EPIC-12-S8 · AC6, AC9
 */
import type { GateId } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { findingId, type GateFinding, type GateSeverity } from './finding.ts';
import { gateOutcome, meetsFloor } from './outcome.ts';

const finding = (severity: GateSeverity): GateFinding => ({
  id: findingId('gate', 'a.ts', severity, 'message'),
  severity,
  file: 'a.ts',
  rule: 'rule/example',
  message: 'message',
  range: { startLine: 1 },
});

const outcomeOf = (options: {
  readonly exitCode?: number;
  readonly expectExitCode?: number;
  readonly severities?: readonly GateSeverity[];
  readonly severityFloor?: GateSeverity;
}) =>
  gateOutcome({
    gate: 'gate-under-test' as GateId,
    exitCode: options.exitCode ?? 0,
    expectExitCode: options.expectExitCode ?? 0,
    findings: (options.severities ?? []).map(finding),
    severityFloor: options.severityFloor ?? 'error',
  });

suite('expect.exitCode is compared as a value (AC6, test plan #4)', () => {
  it.each([
    [0, 0, 'pass'],
    [1, 0, 'fail'],
    [3, 0, 'fail'],
    [0, 1, 'fail'],
    [1, 1, 'pass'],
    [3, 1, 'fail'],
  ] as const)('exit %i against expect %i is %s', (exitCode, expectExitCode, expected) => {
    expect(outcomeOf({ exitCode, expectExitCode })).toBe(expected);
  });

  it('a gate exiting 3 against expect 0 is a fail, not a truthiness accident', () => {
    expect(outcomeOf({ exitCode: 3, expectExitCode: 0 })).toBe('fail');
  });

  it('a gate declaring expect.exitCode 1 treats exit 1 as pass', () => {
    expect(outcomeOf({ exitCode: 1, expectExitCode: 1 })).toBe('pass');
  });
});

suite('the severityFloor matrix (AC9, S8)', () => {
  it.each([
    ['error', ['error', 'warning', 'info'], 'fail', 3],
    ['error', ['warning', 'info'], 'pass', 2],
    ['warning', ['warning', 'info'], 'fail', 2],
    ['warning', ['info'], 'pass', 1],
    ['error', [], 'pass', 0],
  ] as const)(
    'floor %s over %j is %s with %i recorded',
    (floor, severities, expected, recorded) => {
      const findings = severities.map(finding);
      expect(
        gateOutcome({
          gate: 'gate-under-test' as GateId,
          exitCode: 0,
          expectExitCode: 0,
          findings,
          severityFloor: floor,
        }),
      ).toBe(expected);
      // Recorded, whatever the floor said: sub-floor findings are never dropped.
      expect(findings).toHaveLength(recorded);
    },
  );

  it('a finding at or above the floor fails the gate even on the expected exit code', () => {
    expect(outcomeOf({ exitCode: 0, expectExitCode: 0, severities: ['error'] })).toBe('fail');
  });

  it('a sub-floor finding does not fail a gate whose tool exited non-zero about it', () => {
    // oxlint exits non-zero once it has anything to report; `severityFloor:
    // error` is the gate saying warnings are recorded and do not stop the run.
    expect(
      outcomeOf({
        exitCode: 1,
        expectExitCode: 0,
        severities: ['warning'],
        severityFloor: 'error',
      }),
    ).toBe('pass');
  });
});

suite('meetsFloor', () => {
  it.each([
    ['error', 'error', true],
    ['warning', 'error', false],
    ['info', 'error', false],
    ['error', 'warning', true],
    ['warning', 'warning', true],
    ['info', 'warning', false],
    ['info', 'info', true],
  ] as const)('%s against floor %s is %s', (severity, floor, expected) => {
    expect(meetsFloor(severity, floor)).toBe(expected);
  });
});
