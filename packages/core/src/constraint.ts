/**
 * KAR-09.3 — the `Constraint` union, and the smallest honest slice of the
 * §4.2 restatement that AC9 needs.
 *
 * Constraints are authored as structured objects rather than prose so that
 * "restate every prohibition as a positive requirement" is a *render choice*
 * rather than NLP (docs/08-context-and-memory.md §4.2). The reason it matters
 * is arXiv 2604.20911: omission compliance — following a *don't* — falls from
 * 73% at turn 5 to 33% at turn 16, while commission compliance holds at 100%.
 * Pinning fixes the compaction half of the decay problem and does nothing at
 * all about that one.
 *
 * **KAR-09.4 owns this mechanism.** What lives here is what KAR-09.3's AC9
 * requires in order to be testable at all: at least three ConstraintRot
 * scenarios exercise the `forbid` → `allow-only` restatement, so the union and
 * the restatement have to exist before the suite can exercise them. KAR-09.4
 * adds the rest — the transformation applied to *every* constraint at build
 * time, the `forbid`/`allow-only` ratio in `DeFlow doctor`, the planning
 * warning, and interval re-injection. The four positive templates below are
 * already spelled the way KAR-09.4 AC2 spells them, so that story extends this
 * file rather than replacing it.
 *
 * Verifies: EPIC-09-S20 (restatement half of the background) · AC9
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
