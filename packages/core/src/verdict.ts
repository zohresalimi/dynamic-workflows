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
  type CriterionId,
  CriterionIdSchema,
  GateIdSchema,
  HandleSchema,
  NodeIdSchema,
  ProviderIdSchema,
  SchemaIdSchema,
} from './ids.ts';
import { singleLine } from './text.ts';
import type { TokenAccounting } from './token-accounting.ts';
import { type TokenUsage, TokenUsageSchema } from './token-usage.ts';

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

/**
 * KAR-12.3 AC6 — `DeFlow.finding.v2`: the same finding, with its line anchored
 * to the blob the line was read from.
 *
 * A `location` without a `blobSha` is the failure docs/10-verification-gates.md
 * §8 describes: attempt 3 inserts ten lines at the top of the file, and every
 * finding attempt 2 produced is silently redrawn against whatever now occupies
 * line 42. Nothing about the finding says it moved, so the reviewer discovers
 * it by not trusting the margin any more. The fix is to make the anchor part of
 * the anchor — the blob and the line travel together or neither is written.
 *
 * A finding with **no** `location` stays legal and needs no blob. A verdict
 * about the change as a whole ("no test covers the new branch") has no range to
 * be stale against, and demanding a sha for it would only invite a fabricated
 * one.
 */
export const BLOB_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** A git object name: sha1 today, sha256 in a repository initialised that way.
 * Both spellings, because the second is not exotic and a hard-coded 40 would
 * reject a real repository's real blobs. */
export const BlobShaSchema = z
  .string()
  .regex(BLOB_SHA_PATTERN, `blobSha must be a git object name matching ${BLOB_SHA_PATTERN}`);

export const FINDING_V2_SCHEMA_ID = 'DeFlow.finding.v2' as const;

export const FindingV2Schema = FindingSchema.extend({
  location: z
    .strictObject({
      file: z.string().min(1),
      line: z.number().int().positive(),
      endLine: z.number().int().positive().optional(),
      /** The revision `line` was read from. Required: see the note above. */
      blobSha: BlobShaSchema,
    })
    .optional(),
});

export type FindingV2 = z.infer<typeof FindingV2Schema>;

/**
 * KAR-12.3 AC8 — what one verdict cost, with the parts that cannot be known
 * left out rather than filled with zero.
 *
 * `durationMs` is the only field always present, because it is the only one
 * DeFlow measures itself: it is two readings of the injected clock around a
 * process DeFlow started. `tokens` and `usd` come from the adapter, and an
 * adapter whose `tokenAccounting` is `'none'` reports neither — so neither
 * appears. docs/08-context-and-memory.md §7 states the rule in one line: *a
 * blank cost cell, not a zero*. A zero is a claim, and on a node that really
 * spent quota it is a false one that a budget ceiling (F4.6) then acts on.
 */
export const VerdictCostSchema = z.strictObject({
  durationMs: z.number().int().nonnegative(),
  /** Absent unless the adapter accounts for tokens. `source` says which tier
   * produced it, and the two are never summed (./token-usage.ts). */
  tokens: TokenUsageSchema.optional(),
  usd: z.number().nonnegative().optional(),
});

export type VerdictCost = z.infer<typeof VerdictCostSchema>;

/**
 * KAR-12.3 — `DeFlow.verdict.v3`: blob-anchored findings and a cost.
 *
 * A `.v3` rather than fields on `.v2` for the reason `schemas/CHANGELOG.md`
 * gives: a run directory outlives the daemon that wrote it, so a shipped
 * document is never edited in place.
 *
 * **`cost` is optional in the schema and stamped in practice**, exactly as
 * `specHash` is on `.v2`, and for the same reason: the `gate.evaluated` v2 → v3
 * upcast has no honest cost to lift out of a payload written before the field
 * existed, and inventing one would put a fabricated number on a cost chart. The
 * sealer always writes it; absence means *nobody measured this*, which is a
 * fact rather than a zero.
 */
export const VERDICT_V3_SCHEMA_ID = 'DeFlow.verdict.v3' as const;

export const VerdictV3Schema = VerdictV2Schema.extend({
  findings: z.array(FindingV2Schema),
  cost: VerdictCostSchema.optional(),
});

export type VerdictV3 = z.infer<typeof VerdictV3Schema>;

/**
 * KAR-12.2 AC7 — the two ways a review can be weaker than the mechanism
 * promises, said out loud on the verdict itself.
 *
 * `same-provider` is NF7's degradation: exactly one probed provider was capable
 * and it was the producer's, so the reviewer ran on it in a **fresh session**
 * (docs/10-verification-gates.md §3.1). The session dimension is never weakened
 * — only the provider one — and a reader has to be able to tell which.
 *
 * `single-attempt` is §4's other case: a verdict formed on one pass where the
 * gate's contract expected more. It is declared here with `same-provider`
 * because both answer the same operator question, *how much is this green worth*.
 */
export const VERDICT_WEAKENINGS = ['same-provider', 'single-attempt'] as const;

export type VerdictWeakening = (typeof VERDICT_WEAKENINGS)[number];

export const VerdictWeakeningSchema = z.enum(VERDICT_WEAKENINGS);

/**
 * KAR-12.2 — `DeFlow.verdict.v4`: the same document, plus what was given up to
 * produce it.
 *
 * A `.v4` rather than a field on `.v3` for the reason `schemas/CHANGELOG.md`
 * gives and `.v2` and `.v3` already followed: a run directory outlives the
 * daemon that wrote it, so a shipped document is never edited in place.
 *
 * **Absent means "not weakened", and that is honest for every historical
 * payload.** Unlike `specHash` and `cost`, whose absence had to be read as
 * *unknown*, this field's absence is a real answer: a verdict written before
 * the fallback existed was produced by a reviewer routed the ordinary way. The
 * v3 → v4 hop is therefore the identity with nothing left blank in a
 * misleading direction — the only direction of error would be marking a
 * historical review weak when it was not, which would be an invention.
 */
export const VERDICT_V4_SCHEMA_ID = 'DeFlow.verdict.v4' as const;

export const VerdictV4Schema = VerdictV3Schema.extend({
  /** Absent unless something was given up. See `VERDICT_WEAKENINGS`. */
  weakened: VerdictWeakeningSchema.optional(),
});

export type VerdictV4 = z.infer<typeof VerdictV4Schema>;

export type VerdictCriterion = z.infer<typeof VerdictV3Schema>['criteria'][number];

/**
 * KAR-12.3 AC7 — the gate's declared criteria, completed with what the
 * reviewer actually said about each.
 *
 * The whole content is the default. A reviewer that answers about four of five
 * criteria has not passed the fifth, and a board that renders the omission as
 * green is the false confidence F10.8 exists to remove. So an omission
 * materialises as `unverifiable`: visibly not answered, distinct from
 * `unsatisfied`, and not something a repair loop is asked to fix.
 *
 * Two smaller rules follow the same instinct:
 *
 *   * **A contradiction is an omission.** A reviewer that said both
 *     `satisfied` and `unsatisfied` about one criterion has not told us which,
 *     and picking either would be picking for it.
 *   * **A criterion the gate never declared is kept, not dropped.** It is
 *     something the reviewer observed; discarding it to make the list tidy
 *     throws away the only record that it was observed at all.
 */
export function materialiseCriteria(
  declared: readonly (CriterionId | string)[],
  reported: readonly VerdictCriterion[],
): readonly VerdictCriterion[] {
  const statusOf = (id: string): CriterionStatus | undefined => {
    const said = reported.filter((criterion) => criterion.id === id).map((one) => one.status);
    if (said.length === 0) return undefined;
    return said.every((status) => status === said[0]) ? said[0] : 'unverifiable';
  };

  const criteria: VerdictCriterion[] = declared.map((id) => ({
    id: id as CriterionId,
    status: statusOf(String(id)) ?? 'unverifiable',
  }));

  const declaredSet = new Set(declared.map(String));
  for (const criterion of reported) {
    if (declaredSet.has(String(criterion.id))) continue;
    if (criteria.some((already) => already.id === criterion.id)) continue;
    criteria.push({ id: criterion.id, status: statusOf(String(criterion.id)) ?? criterion.status });
  }

  return criteria;
}

export interface VerdictCostInput {
  /** The adapter's probed capability row, which is what decides whether there
   * is a number at all (KAR-09.7). */
  readonly accounting: TokenAccounting;
  /** Measured by DeFlow, from the injected clock. Always known. */
  readonly durationMs: number;
  /** What the vendor's own result envelope carried, when it carried anything. */
  readonly reported?: { readonly usage: TokenUsage; readonly usd?: number } | null;
  /** DeFlow's own Tier-2 counts of the packet it sent and the return it got. */
  readonly estimated?: { readonly inputTokens: number; readonly outputTokens: number } | null;
}

/**
 * AC8 — the cost of one verdict, from what this adapter can honestly count.
 *
 * The manifest wins over whatever happened to arrive, the same way
 * `projectNodeCost` decides it: a provider whose probed row says it reports
 * nothing, but whose envelope carried a usage-shaped object, is a provider
 * whose numbers nobody has verified.
 *
 * The two tiers are never mixed. On `'exact'` the vendor's figures are used or
 * none are — falling back to the Tier-2 estimate would put a 15–20% undercount
 * behind a label that says billing truth.
 */
export function verdictCost(input: VerdictCostInput): VerdictCost {
  const durationMs = input.durationMs;
  if (input.accounting === 'none') return { durationMs };

  if (input.accounting === 'exact') {
    const reported = input.reported ?? null;
    if (reported === null) return { durationMs };
    return {
      durationMs,
      tokens: { ...reported.usage, source: 'vendor-reported' },
      ...(reported.usd === undefined ? {} : { usd: reported.usd }),
    };
  }

  const estimated = input.estimated ?? null;
  const usd = input.reported?.usd;
  return {
    durationMs,
    ...(estimated === null
      ? {}
      : {
          tokens: {
            inputTokens: estimated.inputTokens,
            outputTokens: estimated.outputTokens,
            source: 'estimated' as const,
          },
        }),
    ...(usd === undefined ? {} : { usd }),
  };
}
