/**
 * KAR-02.10 — `Verdict` and `Finding` (docs/04-domain-model.md §7).
 *
 * A gate returns a typed verdict with structured findings, never a prose
 * blob: a blob cannot be attached to a diff line (F7.7), cannot be counted
 * for gate first-pass rate, and cannot drive the surgical repair loop (F7.5).
 *
 * `needs-human` is a first-class outcome rather than a flavour of `fail`. It
 * is what an adversarial reviewer returns when the question is genuinely a
 * judgement call, and what a deterministic gate returns when its own tooling
 * failed — a flaky runner, a missing binary — rather than the work being
 * wrong. Conflating the two sends work into the repair loop that no amount of
 * repair will fix.
 *
 * Verifies: EPIC-02-S28 (shape) · AC8
 */
import { z } from 'zod';
import {
  CriterionIdSchema,
  GateIdSchema,
  HandleSchema,
  NodeIdSchema,
  ProviderIdSchema,
  SchemaIdSchema,
} from './ids.ts';
import { singleLine } from './text.ts';

export const FINDING_SEVERITIES = ['blocker', 'major', 'minor', 'info'] as const;

export const FindingSeveritySchema = z.enum(FINDING_SEVERITIES);

export const FindingSchema = z.strictObject({
  id: z.string().min(1),
  severity: FindingSeveritySchema,
  criterion: CriterionIdSchema.optional(),
  location: z
    .strictObject({
      file: z.string().min(1),
      line: z.number().int().positive(),
      endLine: z.number().int().positive().optional(),
    })
    .optional(),
  message: z.string().min(1),
  /** Test output, build log, diff — always a handle, never inline. Inline
   * evidence cannot be attached to a diff line and grows the ledger without
   * bound. */
  evidence: z.array(HandleSchema),
  suggestedFix: z.string().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

export const VERDICT_OUTCOMES = ['pass', 'fail', 'needs-human'] as const;

export const VerdictOutcomeSchema = z.enum(VERDICT_OUTCOMES);

export const CRITERION_STATUSES = ['satisfied', 'unsatisfied', 'unverifiable'] as const;

export const CriterionStatusSchema = z.enum(CRITERION_STATUSES);

export const VerdictSchema = z.strictObject({
  schemaId: SchemaIdSchema,
  outcome: VerdictOutcomeSchema,
  gate: GateIdSchema,
  /** Whose work was judged — not the gate's own node. */
  evaluatedNode: NodeIdSchema,
  by: z.strictObject({
    node: NodeIdSchema,
    provider: ProviderIdSchema,
    model: z.string().min(1),
  }),
  /** F7.4: which criteria this gate speaks to, and what it concluded about
   * each. `unverifiable` is how a gate says "I could not tell", which is
   * different from "unsatisfied" and drives `needs-human`. */
  criteria: z.array(
    z.strictObject({
      id: CriterionIdSchema,
      status: CriterionStatusSchema,
    }),
  ),
  findings: z.array(FindingSchema),
  /** One line, for the board. Not the evidence. */
  summary: singleLine(),
});

export type Verdict = z.infer<typeof VerdictSchema>;
