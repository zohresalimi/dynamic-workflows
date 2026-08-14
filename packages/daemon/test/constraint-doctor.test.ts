/**
 * KAR-09.4 AC4 — the forbid-to-allow-only line in `deflow doctor`.
 *
 * The command itself is EPIC-18 (KAR-18.4); this module holds the policy ahead
 * of it existing, the same split `../src/tokens/doctor.ts` already uses for the
 * calibration section.
 *
 * The line is not decoration. §4.2: *"a rising `forbid` ratio in a run's spec is
 * a leading indicator of the decay this section exists to prevent"* — and the
 * decay in question is invisible to ordinary monitoring, so a number nobody
 * prints is a number nobody sees move.
 *
 * Verifies: EPIC-09-S22 (third and fourth scenarios) · AC4
 */
import type { Constraint } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { renderConstraintReport } from '../src/constraints/doctor.ts';

const allowOnly = (subject: 'write-path' | 'command' | 'branch'): Constraint => ({
  form: 'allow-only',
  subject,
  allowed: ['src/checkout/**'],
});

const forbid = (subject: string): Constraint => ({
  form: 'forbid',
  subject,
  forbidden: ['something'],
});

suite('the ratio, and what it means (EPIC-09-S22 third scenario)', () => {
  const sixAndTwo: readonly Constraint[] = [
    allowOnly('write-path'),
    allowOnly('branch'),
    forbid('exfiltrate credentials'),
    forbid('reach the network'),
    forbid('print secrets to the log'),
    forbid('rewrite pushed history'),
    forbid('delete tests'),
    forbid('patch node_modules'),
  ];

  it('reports the forbid-to-allow-only ratio for the loaded spec', () => {
    const report = renderConstraintReport(sixAndTwo);

    expect(report).toContain('6 forbid');
    expect(report).toContain('2 allow-only');
    expect(report).toContain('3');
  });

  it('flags it as a leading indicator of constraint decay', () => {
    expect(renderConstraintReport(sixAndTwo).toLowerCase()).toContain('decay');
  });

  it('says so plainly when nothing positive was declared, rather than dividing by zero', () => {
    const report = renderConstraintReport([forbid('exfiltrate credentials')]);

    expect(report).not.toContain('Infinity');
    expect(report).not.toContain('NaN');
    expect(report).toContain('no allow-only');
  });

  it('reports an empty spec without inventing a ratio', () => {
    expect(renderConstraintReport([])).toContain('no constraints');
  });
});

suite('a convertible forbid is named, not failed (EPIC-09-S22 fourth scenario)', () => {
  it('names the constraint that has a closed positive form', () => {
    const report = renderConstraintReport([allowOnly('command'), forbid('write-path')]);

    expect(report).toContain('write-path');
    expect(report).toContain('convertible');
  });

  it('leaves a genuine last resort unmentioned as convertible', () => {
    const report = renderConstraintReport([allowOnly('command'), forbid('exfiltrate credentials')]);

    expect(report).not.toContain('convertible');
  });
});
