/**
 * KAR-10.1 AC1 — the wire shape `POST /api/runs` accepts, and the one place it
 * is validated.
 *
 * `deflow run "…"` builds the same shape in-process (../../../cli/src/index.ts)
 * and validates through this schema too, so the CLI and the HTTP route can
 * never drift into accepting different requests (AC7 — "the CLI is a client of
 * the HTTP API, not a second implementation").
 */
import { PROVIDER_SPECS } from '@DeFlow/adapters';
import { PERMISSION_LEVELS, ProjectIdSchema } from '@DeFlow/core';
import { z } from 'zod';

/**
 * KAR-19.10 AC1 — the registered ids, read out of `PROVIDER_SPECS`.
 *
 * Derived rather than written down, so an entry added to the registry is
 * accepted on the wire with no other edit — and so the one file allowed to name
 * a vendor stays the one file that does (AC9).
 */
export const REGISTERED_PROVIDER_IDS: readonly string[] = Object.keys(PROVIDER_SPECS).toSorted(
  (a, b) => a.localeCompare(b),
);

export const RunIntakeInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), text: z.string().min(1) }),
  z.strictObject({ kind: z.literal('file'), path: z.string().min(1) }),
  z.strictObject({ kind: z.literal('issue'), url: z.string().min(1) }),
]);

export type RunIntakeInput = z.infer<typeof RunIntakeInputSchema>;

/** `null` is a real answer here — "no ceiling in this dimension" — matching
 * `BudgetCeilingSetSchema` in @DeFlow/core's event-payloads.ts. `undefined`
 * (the field omitted) means the daemon's own config default applies. */
export const RunIntakeBudgetSchema = z.strictObject({
  costUsd: z.number().nonnegative().nullable().optional(),
  wallclockMs: z.number().int().nonnegative().nullable().optional(),
});

export type RunIntakeBudget = z.infer<typeof RunIntakeBudgetSchema>;

export const RunIntakeBodySchema = z.strictObject({
  input: RunIntakeInputSchema,
  cwd: z.string().min(1),
  /**
   * KAR-22.1 AC7 — the project this run belongs to, or omitted for a run
   * submitted from a terminal that has no project.
   *
   * Shape-checked here and **existence-checked in `submitTask`**, and the split
   * is the same one `provider` above draws: an id that is not a `ProjectId` is a
   * *request* problem, and an id that is well formed and names no project on
   * this machine is a *state* problem. Both are refused before anything is
   * appended (KAR-10.1 AC5), and both name the same field, because from a form's
   * side they are one box that is wrong.
   */
  projectId: ProjectIdSchema.optional(),
  budget: RunIntakeBudgetSchema.optional(),
  permission: z.enum(PERMISSION_LEVELS),
  /**
   * KAR-19.10 AC1 — the provider the caller named, or omitted for "choose".
   *
   * An id nothing registers is a **request** problem and is rejected here with
   * the field name (`EX_USAGE` at the CLI). An id that is registered and that
   * this machine cannot serve is an **environment** problem and is refused by
   * admission (exit 5). The two look identical on a command line and lead to
   * opposite next actions, which is why they are two answers and not one.
   */
  provider: z
    .string()
    .refine((id) => REGISTERED_PROVIDER_IDS.includes(id), {
      message: `provider must be one of ${REGISTERED_PROVIDER_IDS.join(', ')}`,
    })
    .optional(),
});

export type RunIntakeBody = z.infer<typeof RunIntakeBodySchema>;

/**
 * The first invalid field, dotted (`input.text`, `cwd`, …) — the `field` AC1's
 * typed error names, and EPIC-10-S4's assertion is written against.
 *
 * First rather than every issue: one wrong field is the common case, and a
 * caller wiring a 4xx body wants a single name to show, not a list.
 */
export function firstInvalidField(error: z.ZodError): string {
  const [issue] = error.issues;
  if (issue === undefined) return '<root>';
  return issue.path.length === 0 ? '<root>' : issue.path.join('.');
}
