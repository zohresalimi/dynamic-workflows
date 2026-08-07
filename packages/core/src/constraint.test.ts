/**
 * KAR-09.3 — the slice of the `Constraint` union this story needs, and no
 * more.
 *
 * KAR-09.4 owns the full transformation: the four documented rows applied at
 * build time, the `forbid`/`allow-only` ratio in `DeFlow doctor`, and interval
 * re-injection. What lands here is what AC9 requires — three of the
 * ConstraintRot scenarios exercise the `forbid` → `allow-only` restatement, so
 * the restatement has to exist to be exercised.
 *
 * Verifies: EPIC-09-S20 (the restatement half of the background) · AC9
 */
import { expect, it, describe as suite } from 'vitest';
import {
  type Constraint,
  orderPinnedConstraints,
  restateAsRequirement,
  restateForbidAsAllowOnly,
} from './constraint.ts';

suite('restateAsRequirement', () => {
  it('renders the documented positive forms', () => {
    expect(
      restateAsRequirement({
        form: 'allow-only',
        subject: 'write-path',
        allowed: ['src/checkout/**'],
      }),
    ).toBe('only write files under src/checkout/**');

    expect(
      restateAsRequirement({ form: 'allow-only', subject: 'command', allowed: ['pnpm test'] }),
    ).toBe('run only the commands listed in the allowed-commands set');

    expect(
      restateAsRequirement({
        form: 'allow-only',
        subject: 'branch',
        allowed: ['DeFlow/<runId>__<nodeId>'],
      }),
    ).toBe('commit only to DeFlow/<runId>__<nodeId>');

    expect(
      restateAsRequirement({
        form: 'require',
        statement: 'stop after at most 3 fix attempts and escalate to a human',
      }),
    ).toBe('stop after at most 3 fix attempts and escalate to a human');
  });

  it('keeps a forbid negative, because that is what a last resort is', () => {
    expect(
      restateAsRequirement({
        form: 'forbid',
        subject: 'exfiltrate credentials',
        forbidden: ['.env'],
      }),
    ).toBe('do not exfiltrate credentials: .env');
  });
});

suite('restateForbidAsAllowOnly', () => {
  it('turns "do not write outside src/checkout/**" into the positive form', () => {
    const forbid: Constraint = {
      form: 'forbid',
      subject: 'write-path',
      forbidden: ['src/shared/**', 'packages/**'],
    };

    const restated = restateForbidAsAllowOnly(forbid, ['src/checkout/**']);

    expect(restated).toEqual({
      form: 'allow-only',
      subject: 'write-path',
      allowed: ['src/checkout/**'],
    });
    expect(restateAsRequirement(restated as Constraint)).toBe(
      'only write files under src/checkout/**',
    );
  });

  it('returns null when the prohibition has no closed positive form', () => {
    const forbid: Constraint = {
      form: 'forbid',
      subject: 'exfiltrate credentials',
      forbidden: ['.env'],
    };

    expect(restateForbidAsAllowOnly(forbid, [])).toBeNull();
  });

  it('returns null when nothing positive was declared to allow', () => {
    const forbid: Constraint = { form: 'forbid', subject: 'branch', forbidden: ['main'] };

    expect(restateForbidAsAllowOnly(forbid, [])).toBeNull();
  });
});

suite('orderPinnedConstraints', () => {
  it('renders every forbid after every allow-only and require', () => {
    const constraints: readonly Constraint[] = [
      { form: 'forbid', subject: 'exfiltrate credentials', forbidden: ['.env'] },
      { form: 'allow-only', subject: 'write-path', allowed: ['src/checkout/**'] },
      { form: 'require', statement: 'stop after at most 3 fix attempts and escalate to a human' },
      { form: 'forbid', subject: 'touch the default branch', forbidden: ['main'] },
    ];

    expect(orderPinnedConstraints(constraints).map((constraint) => constraint.form)).toEqual([
      'allow-only',
      'require',
      'forbid',
      'forbid',
    ]);
  });

  it('is stable within a form, so a rebuild re-injects the same bytes', () => {
    const constraints: readonly Constraint[] = [
      { form: 'require', statement: 'a' },
      { form: 'require', statement: 'b' },
      { form: 'require', statement: 'c' },
    ];

    expect(orderPinnedConstraints(constraints)).toEqual(constraints);
  });
});
