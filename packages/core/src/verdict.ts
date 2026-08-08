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

/**
 * The two document ids this module ships (KAR-02.8). A `finding` fact carries
 * `schemaId: 'DeFlow.finding.v1'` and a `Finding` as its value; a `verdict`
 * fact carries `DeFlow.verdict.v1` and a whole `Verdict`.
 */
export const FINDING_SCHEMA_ID = 'DeFlow.finding.v1' as const;

export const VERDICT_SCHEMA_ID = 'DeFlow.verdict.v1' as const;

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

/** `pass | fail | needs-human`. Named because the gate ladder branches on it
 * (./gate-ladder.ts) and a `string` there would let a typo open a tier. */
export type VerdictOutcome = z.infer<typeof VerdictOutcomeSchema>;

export const CRITERION_STATUSES = ['satisfied', 'unsatisfied', 'unverifiable'] as const;

export const CriterionStatusSchema = z.enum(CRITERION_STATUSES);

export type CriterionStatus = z.infer<typeof CriterionStatusSchema>;

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

/**
 * KAR-10.4 AC5 — `DeFlow.verdict.v2`: the same document, plus the identity of
 * the contract it was judged against.
 *
 * A `.v2` rather than a field on `.v1`, because `schemaId` versioning is
 * append-only and `.v1` is shipped (`schemas/CHANGELOG.md`) — a run directory
 * outlives the daemon that wrote it, and a `.v1` edited in place would silently
 * reinterpret every verdict already on disk.
 *
 * **`specHash` is optional in the schema and mandatory in practice**, and the
 * two are not in tension. `verdictAgainst` is how a gate seals one and it always
 * stamps the hash; what optionality buys is a legal upcast from `.v1`, whose
 * payloads predate the field entirely. There is no honest value to fill those
 * with — a fabricated hash would make a historical verdict read as judged
 * against a document nobody showed it — so the hop leaves it absent and
 * `isVerdictVoid` treats absence exactly as it treats a mismatch: **void**. That
 * is the safe direction. A verdict that cannot name its contract is not evidence
 * about this one, and the cost of being wrong is a gate that re-runs rather than
 * a criterion that is green on somebody else's say-so.
 */
export const VERDICT_V2_SCHEMA_ID = 'DeFlow.verdict.v2' as const;

const SPEC_HASH_PATTERN = /^sha256-[0-9a-f]{64}$/;

export const VerdictV2Schema = VerdictSchema.extend({
  /** The sha256 of the pinned `TaskSpec` this verdict was judged against
   * (docs/10-verification-gates.md §4). */
  specHash: z
    .string()
    .regex(SPEC_HASH_PATTERN, `specHash must match ${SPEC_HASH_PATTERN}`)
    .optional(),
});

export type VerdictV2 = z.infer<typeof VerdictV2Schema>;
