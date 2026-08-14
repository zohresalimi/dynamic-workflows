/**
 * KAR-09.3, KAR-09.4 — the `Constraint` union and the §4.2 restatement.
 *
 * Constraints are authored as structured objects rather than prose so that
 * "restate every prohibition as a positive requirement" is a *render choice*
 * rather than NLP (docs/08-context-and-memory.md §4.2). The reason it matters
 * is arXiv 2604.20911: omission compliance — following a *don't* — falls from
 * 73% at turn 5 to 33% at turn 16, while commission compliance holds at 100%.
 * Pinning fixes the compaction half of the decay problem and does nothing at
 * all about that one.
 *
 * The transformation runs at *build time* and applies to every constraint,
 * carelessly authored ones included — `buildPinnedSegments` composes each line
 * through the fixed templates below and there is no free-prose path into a
 * `pinned.constraints` segment (KAR-09.4 AC1). It also runs **before** hashing,
 * which is what makes verbatim re-injection possible at all: restating after
 * the digest was taken would make every re-injection a pin-integrity violation.
 *
 * `forbid` survives as the last resort and is *counted*: `countConstraintForms`
 * and `forbidRatio` are what `deflow doctor` reports, because a rising forbid
 * ratio is a leading indicator of exactly the decay this module exists to
 * prevent.
 *
 * Verifies: EPIC-09-S20, EPIC-09-S21, EPIC-09-S22 · KAR-09.3 AC9 ·
 * KAR-09.4 AC1, AC2, AC3, AC4
 */
import { z } from 'zod';

/** The three subjects that have a closed positive form. A prohibition about
 * anything else is a `forbid`, and stays one. */
export const ALLOW_ONLY_SUBJECTS = ['write-path', 'command', 'branch'] as const;

export type AllowOnlySubject = (typeof ALLOW_ONLY_SUBJECTS)[number];

export const AllowOnlyConstraintSchema = z.strictObject({
  form: z.literal('allow-only'),
  subject: z.enum(ALLOW_ONLY_SUBJECTS),
  allowed: z.array(z.string().min(1)).min(1),
});

export const RequireConstraintSchema = z.strictObject({
  form: z.literal('require'),
  statement: z.string().min(1),
});

/** The last resort: some constraints genuinely have no closed positive form
 * ("do not exfiltrate credentials"). These render *last* among the pinned
 * constraints and are counted, because a rising `forbid` ratio is a leading
 * indicator of the decay §4.2 describes. */
export const ForbidConstraintSchema = z.strictObject({
  form: z.literal('forbid'),
  subject: z.string().min(1),
  forbidden: z.array(z.string().min(1)).min(1),
});

export const ConstraintSchema = z.discriminatedUnion('form', [
  AllowOnlyConstraintSchema,
  RequireConstraintSchema,
  ForbidConstraintSchema,
]);

export type Constraint = z.infer<typeof ConstraintSchema>;
export type AllowOnlyConstraint = z.infer<typeof AllowOnlyConstraintSchema>;
export type ForbidConstraint = z.infer<typeof ForbidConstraintSchema>;

/** The positive template per subject (KAR-09.4 AC2's four documented rows).
 * A fixed template per form is the point: there is no free-prose path into a
 * `pinned.constraints` segment. */
const ALLOW_ONLY_TEMPLATES: Readonly<
  Record<AllowOnlySubject, (allowed: readonly string[]) => string>
> = {
  'write-path': (allowed) => `only write files under ${allowed.join(', ')}`,
  // The set, not its members: the allowed-commands set is itself pinned
  // (F5.6), and restating it inline would be a second copy that can drift.
  command: () => 'run only the commands listed in the allowed-commands set',
  branch: (allowed) => `commit only to ${allowed.join(', ')}`,
};

/** One constraint as the line that goes into a `pinned.constraints` segment. */
export function restateAsRequirement(constraint: Constraint): string {
  if (constraint.form === 'allow-only') {
    return ALLOW_ONLY_TEMPLATES[constraint.subject](constraint.allowed);
  }
  if (constraint.form === 'require') return constraint.statement;
  return `do not ${constraint.subject}: ${constraint.forbidden.join(', ')}`;
}

/**
 * The `forbid` → `allow-only` restatement, where one exists.
 *
 * The transformation is mechanical rather than clever: "do not write outside
 * `src/shared/**`" carries no information about what *is* allowed, so the
 * positive form comes from what the node declared — its path scopes, its
 * allowed commands, its branch. Where the subject has no closed positive form,
 * or nothing positive was declared, this returns `null` and the prohibition
 * stays a prohibition; that is why `forbid` exists at all.
 */
export function restateForbidAsAllowOnly(
  constraint: ForbidConstraint,
  allowed: readonly string[],
): AllowOnlyConstraint | null {
  const subjects: readonly string[] = ALLOW_ONLY_SUBJECTS;
  if (!subjects.includes(constraint.subject)) return null;
  if (allowed.length === 0) return null;
  return {
    form: 'allow-only',
    subject: constraint.subject as AllowOnlySubject,
    allowed: [...allowed],
  };
}

const FORM_ORDER: Readonly<Record<Constraint['form'], number>> = {
  'allow-only': 0,
  require: 1,
  forbid: 2,
};

/**
 * Positive constraints first, prohibitions last, stable within each form
 * (KAR-09.4 AC3).
 *
 * Stability is not tidiness: the pinned bytes have to be reproducible or the
 * integrity check fails on a rebuild that changed nothing.
 */
export function orderPinnedConstraints(constraints: readonly Constraint[]): readonly Constraint[] {
  return constraints
    .map((constraint, index) => ({ constraint, index }))
    .toSorted(
      (a, b) => FORM_ORDER[a.constraint.form] - FORM_ORDER[b.constraint.form] || a.index - b.index,
    )
    .map((entry) => entry.constraint);
}

/** One count per form. Every form is present with a zero rather than omitted:
 * a missing key and a zero read the same in a report and mean different
 * things. */
export interface ConstraintCounts {
  readonly allowOnly: number;
  readonly require: number;
  readonly forbid: number;
}

/** AC4 — what the build records about what it pinned. */
export function countConstraintForms(constraints: readonly Constraint[]): ConstraintCounts {
  return {
    allowOnly: constraints.filter((constraint) => constraint.form === 'allow-only').length,
    require: constraints.filter((constraint) => constraint.form === 'require').length,
    forbid: constraints.filter((constraint) => constraint.form === 'forbid').length,
  };
}

/**
 * `forbid` over `allow-only`, or `null` when nothing positive was declared.
 *
 * `null` rather than `Infinity`: a spec with prohibitions and no positive
 * constraints has no ratio, and printing `Infinity` invites a reader to treat
 * it as a very large number on the same scale as 3.
 */
export function forbidRatio(counts: ConstraintCounts): number | null {
  return counts.allowOnly === 0 ? null : counts.forbid / counts.allowOnly;
}

/**
 * The prohibitions that *do* have a closed positive form — a review smell, not
 * an error (EPIC-09-S22 fourth scenario).
 *
 * The build succeeds either way. What this buys is `deflow doctor` being able
 * to name the constraint rather than only report a number, because "your forbid
 * ratio is 3" is not actionable and "`forbid write-path` has an `allow-only`
 * form" is.
 */
export function convertibleForbids(
  constraints: readonly Constraint[],
): readonly ForbidConstraint[] {
  const subjects: readonly string[] = ALLOW_ONLY_SUBJECTS;
  return constraints.filter(
    (constraint): constraint is ForbidConstraint =>
      constraint.form === 'forbid' && subjects.includes(constraint.subject),
  );
}
