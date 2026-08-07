/**
 * KAR-10.1 AC1 — the wire shape `POST /api/runs` accepts, and the one place it
 * is validated.
 *
 * `DeFlow run "…"` builds the same shape in-process (../../../cli/src/index.ts)
 * and validates through this schema too, so the CLI and the HTTP route can
 * never drift into accepting different requests (AC7 — "the CLI is a client of
 * the HTTP API, not a second implementation").
 */
import { PERMISSION_LEVELS } from '@DeFlow/core';
import { z } from 'zod';

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
  budget: RunIntakeBudgetSchema.optional(),
  permission: z.enum(PERMISSION_LEVELS),
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
