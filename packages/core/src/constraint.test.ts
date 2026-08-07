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
  convertibleForbids,
  countConstraintForms,
  forbidRatio,
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

/* -------------------------------------------------------------------------- *
 * KAR-09.4
 * -------------------------------------------------------------------------- */

/** EPIC-09-S22's second scenario: two `allow-only`, one `require`, one `forbid`. */
const S22_CONSTRAINTS: readonly Constraint[] = [
  { form: 'allow-only', subject: 'write-path', allowed: ['src/checkout/**'] },
  { form: 'forbid', subject: 'exfiltrate credentials', forbidden: ['.env'] },
  { form: 'allow-only', subject: 'branch', allowed: ['DeFlow/r1__implement'] },
  { form: 'require', statement: 'stop after at most 3 fix attempts and escalate to a human' },
];

suite('countConstraintForms (AC4, EPIC-09-S22)', () => {
  it('counts every form, so the ratio has a denominator', () => {
    expect(countConstraintForms(S22_CONSTRAINTS)).toEqual({
      allowOnly: 2,
      require: 1,
      forbid: 1,
    });
  });

  it('is zero for every form on an empty spec rather than absent', () => {
    expect(countConstraintForms([])).toEqual({ allowOnly: 0, require: 0, forbid: 0 });
  });
});

suite('forbidRatio (AC4)', () => {
  it('is forbid over allow-only — the leading indicator of decay', () => {
    expect(forbidRatio({ allowOnly: 2, require: 0, forbid: 6 })).toBe(3);
  });

  it('is null when nothing positive was declared, never Infinity', () => {
    expect(forbidRatio({ allowOnly: 0, require: 1, forbid: 2 })).toBeNull();
  });
});

suite('convertibleForbids (EPIC-09-S22 fourth scenario)', () => {
  it('names a forbid that has a closed positive form', () => {
    const convertible = convertibleForbids(
      S22_CONSTRAINTS.concat({
        form: 'forbid',
        subject: 'write-path',
        forbidden: ['src/shared/**'],
      }),
    );

    expect(convertible).toEqual([
      { form: 'forbid', subject: 'write-path', forbidden: ['src/shared/**'] },
    ]);
  });

  it('leaves a genuine last resort alone — it is not an error', () => {
    expect(convertibleForbids(S22_CONSTRAINTS)).toEqual([]);
  });
});
