/**
 * KAR-10.2 — the document the framing interview returns, and the contract it
 * is held to (docs/06-planning-and-replanning.md §1.2).
 *
 * The framing agent is *"the one place where a model is allowed to be
 * expansive, because everything downstream is judged against what it
 * produces"*, and what it produces is a **structured document enforced at the
 * adapter boundary** — never prose DeFlow regexes. That document is
 * `DeFlow.taskspecdraft.v1`, registered in ./json-schema.ts and emitted to
 * `schemas/` like every other, because the file is what rides on a vendor's
 * `--json-schema` / `--output-schema` flag.
 *
 * **Why the framed document is its own schema and not `DeFlow.taskspec.v1`.**
 * Three of KAR-10.2's acceptance criteria name things a v1 `TaskSpec` has no
 * field for, and `schemaId` versioning is append-only, so v1 cannot grow them:
 *
 *   * AC4's criteria contract — `verifiedBy` / `unverifiable` / `reason` — is
 *     a *different* vocabulary from v1's optional `check`, which says how one
 *     criterion is checked rather than whether anything checks it at all.
 *   * AC6 requires `nonGoals` to be non-empty. v1 requires the field and
 *     accepts `[]`.
 *   * AC8 wants `priorDecisions[].source: 'operator'` — a provenance *kind*.
 *     v1's `source` is a `Handle`, which is evidence, not provenance.
 *
 * There is also a plainer reason: a v1 `TaskSpec` requires `specHash`, and an
 * agent cannot honestly compute the digest of the document it is still
 * writing. DeFlow mints it, which is exactly what `sealTaskSpec` does.
 *
 * `sealTaskSpec` is therefore a **projection**, and a deliberately explicit
 * one: it states, per field, what v1 can hold and what it cannot. The framed
 * document is the truth and stays in the ledger as the framing node's return;
 * `run.created.spec` is the v1 view of it (AC11). Where the two vocabularies
 * do not line up the projection says so in the open rather than inventing a
 * value — a criterion naming *two* gates seals with no `check` at all, because
 * "all of typecheck and build" is a claim v1 cannot make and picking the first
 * gate would be a claim the framed document did not make either.
 *
 * **Criterion ids are `ac-1 … ac-n`.** The epic writes them `AC-1 … AC-n`; the
 * shipped `CriterionId` (KAR-02.2) is a lowercase slug, so the sequence is
 * spelled in the case the domain type actually accepts. Recorded in the epic
 * file alongside AC4.
 *
 * Verifies: EPIC-10-S6, EPIC-10-S9 · AC4, AC5, AC6, AC8, AC10, AC11
 */
import { z } from 'zod';
import { specHash } from './hash.ts';
import { CriterionIdSchema, GateIdSchema, type SchemaId, SchemaIdSchema } from './ids.ts';
import type { NodeReturns, PermissionLevel } from './plan-graph.ts';
import {
  type AcceptanceCriterionCheck,
  type PriorDecision,
  type TaskSpec,
  TaskSpecSchema,
} from './task-spec.ts';

/** The framed document's `schemaId`. Suffixed at v1 like every other shipped
 * document id — append-only, so a shape change publishes `.v2`. */
export const TASKSPEC_DRAFT_SCHEMA_ID = 'DeFlow.taskspecdraft.v1' as const;

const DraftSchemaIdSchema: z.ZodType<SchemaId, string> = z
  .literal(TASKSPEC_DRAFT_SCHEMA_ID)
  .transform((value): SchemaId => value as SchemaId);

/**
 * AC10 — the framing node's return budget, stated rather than defaulted.
 *
 * 4000 and not `DEFAULT_RETURNS_MAX_TOKENS`: a spec with eight populated
 * fields, a criteria list and a failure-mode list does not fit in the budget a
 * single finding gets, and the answer to a document that does not fit is
 * EPIC-09's bounded repair — never truncation, which produces invalid JSON and
 * propagates exactly the garbage F6.9 exists to prevent.
 */
export const FRAMING_RETURN_MAX_TOKENS = 4000;

/** AC1 — the framing agent reads the repository and writes nothing. */
export const FRAMING_PERMISSION: PermissionLevel = 'read';

/** The framing node's `returns` contract (AC10). */
export function framingReturns(): NodeReturns {
  return {
    schemaId: SchemaIdSchema.parse(TASKSPEC_DRAFT_SCHEMA_ID),
    maxTokens: FRAMING_RETURN_MAX_TOKENS,
  };
}

// ── the framed document ──────────────────────────────────────────────────────

/**
 * AC8 — where a decision the spec records came from.
 *
 * A closed set, and `'operator'` is the one this story writes: a clarifying
 * question and its answer land here so that six weeks later the spec explains
 * itself. `'repository'` is what the framing agent read for itself and
 * `'task'` is what the submitted task already said — both are provenance the
 * agent can honestly claim, and neither is an operator decision.
 */
export const PRIOR_DECISION_SOURCES = ['operator', 'repository', 'task'] as const;

export type PriorDecisionSource = (typeof PRIOR_DECISION_SOURCES)[number];

export const DraftPriorDecisionSchema = z.strictObject({
  decision: z.string().min(1),
  rationale: z.string().optional(),
  source: z.enum(PRIOR_DECISION_SOURCES),
});

export type DraftPriorDecision = z.infer<typeof DraftPriorDecisionSchema>;

const criterionCore = {
  id: CriterionIdSchema,
  /** A single testable statement. EARS phrasing encouraged, not enforced. */
  statement: z.string().min(1),
} as const;

/**
 * AC4, arm one: the criterion names at least one gate.
 *
 * `z.union` rather than a refinement, because this shape is emitted as JSON
 * Schema and handed to a vendor CLI — a union becomes `anyOf`, which the
 * adapter enforces itself, while a Zod refinement has no JSON Schema
 * representation at all and would leave the contract enforced only after the
 * turn was paid for.
 */
const VerifiedCriterionSchema = z.strictObject({
  ...criterionCore,
  verifiedBy: z.array(GateIdSchema).min(1),
});

/** AC4, arm two: nothing checks it, said out loud and with a reason. */
const UnverifiableCriterionSchema = z.strictObject({
  ...criterionCore,
  unverifiable: z.literal(true),
  reason: z.string().min(1),
  /** A human-review gate is still a gate; `unverifiable` is about the absence
   * of an automated harness, not about the absence of anyone looking. */
  verifiedBy: z.array(GateIdSchema).optional(),
});

export const DraftAcceptanceCriterionSchema = z.union([
  VerifiedCriterionSchema,
  UnverifiableCriterionSchema,
]);

export type DraftAcceptanceCriterion = z.infer<typeof DraftAcceptanceCriterionSchema>;

/** AC5 — "what going wrong looks like" *and* "how we would notice". An entry
 * with a description and no detection is the shallow spec the SDD literature
 * names as the primary documented failure mode, so `detection` is required. */
export const DraftFailureModeSchema = z.strictObject({
  id: z.string().min(1),
  description: z.string().min(1),
  detection: z.string().min(1),
  mitigation: z.string().optional(),
});

export type DraftFailureMode = z.infer<typeof DraftFailureModeSchema>;

export const TaskSpecDraftSchema = z.strictObject({
  schemaId: DraftSchemaIdSchema,
  goal: z.string().min(1),
  scope: z.strictObject({
    included: z.array(z.string()).min(1),
    paths: z.array(z.string()).optional(),
  }),
  /**
   * AC6 — required *and* non-empty. §1.2 singles this out as "the field people
   * skip and regret": an empty array is an invitation to scope creep the
   * planner will accept, and it is indistinguishable from a framing agent that
   * never thought about the question.
   */
  nonGoals: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string().min(1)),
  priorDecisions: z.array(DraftPriorDecisionSchema),
  acceptanceCriteria: z.array(DraftAcceptanceCriterionSchema).min(1),
  knownFailureModes: z.array(DraftFailureModeSchema),
});

export type TaskSpecDraft = z.infer<typeof TaskSpecDraftSchema>;

// ── validation ───────────────────────────────────────────────────────────────

/** One violation, in the same shape Ajv's issues arrive in (./accept-fact.ts),
 * so a caller can concatenate the two lists without translating either. */
export interface DraftIssue {
  /** A JSON Pointer into the document — `/acceptanceCriteria/1`. */
  readonly pointer: string;
  readonly message: string;
}

/**
 * The lenient shape the structural pass parses against.
 *
 * Deliberately *not* the union above: a `z.union` failure reports
 * "invalid_union" with every arm's errors underneath, which for a criterion
 * that names no gate is four messages about four different things instead of
 * the one sentence the operator needs. So structure is checked here and the
 * AC4 contract is checked by `criteriaContractIssues`, which can name the
 * criterion and say what to do about it.
 */
const LenientCriterionSchema = z.strictObject({
  ...criterionCore,
  verifiedBy: z.array(GateIdSchema).optional(),
  unverifiable: z.literal(true).optional(),
  reason: z.string().optional(),
});

const LenientDraftSchema = TaskSpecDraftSchema.extend({
  acceptanceCriteria: z.array(LenientCriterionSchema).min(1),
});

/** `ac-10` sorts after `ac-9`, which a string comparison gets backwards. */
export function criterionOrdinal(id: string): number {
  const digits = /(\d+)\s*$/.exec(id);
  return digits === null ? Number.MAX_SAFE_INTEGER : Number(digits[1]);
}

function pointerOf(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '' : `/${path.map((part) => String(part)).join('/')}`;
}

const NON_GOALS_MESSAGE =
  'nonGoals must name at least one thing this run will not do. §1.2 calls it "the field people ' +
  'skip and regret": an empty list is an invitation to scope creep the planner will accept.';

/**
 * AC4 — the one contract enforced structurally rather than by exhortation.
 *
 * One issue per offending criterion, ordered by criterion id, so a document
 * with four violations produces four messages in one turn rather than four
 * turns of one message each (F6.9, and `AJV_2020_OPTIONS.allErrors` for the
 * same reason).
 */
export function criteriaContractIssues(document: unknown): readonly DraftIssue[] {
  const criteria = (document as { acceptanceCriteria?: unknown } | null | undefined)
    ?.acceptanceCriteria;
  if (!Array.isArray(criteria)) return [];

  const issues: (DraftIssue & { ordinal: number })[] = [];
  for (const [index, raw] of criteria.entries()) {
    const criterion = raw as
      | {
          id?: unknown;
          verifiedBy?: unknown;
          unverifiable?: unknown;
          reason?: unknown;
        }
      | null
      | undefined;
    const id = typeof criterion?.id === 'string' ? criterion.id : `#${index}`;
    const gates = Array.isArray(criterion?.verifiedBy) ? criterion.verifiedBy : [];
    const unverifiable = criterion?.unverifiable === true;
    const reason = typeof criterion?.reason === 'string' ? criterion.reason.trim() : '';

    if (unverifiable && reason === '') {
      issues.push({
        ordinal: criterionOrdinal(id),
        pointer: `/acceptanceCriteria/${index}`,
        message:
          `acceptance criterion ${id} is marked unverifiable with no reason. "unverifiable" is ` +
          'a first-class answer, not an escape hatch: say why nothing can check it and what ' +
          'would have to exist before something could.',
      });
      continue;
    }
    if (unverifiable || gates.length > 0) continue;

    issues.push({
      ordinal: criterionOrdinal(id),
      pointer: `/acceptanceCriteria/${index}`,
      message:
        `acceptance criterion ${id} must name at least one gate in verifiedBy, or be marked ` +
        'unverifiable: true with a reason. A criterion nothing checks is a lie on the ' +
        'acceptance board (F7.4).',
    });
  }

  return issues
    .toSorted((a, b) => a.ordinal - b.ordinal)
    .map(({ pointer, message }) => ({ pointer, message }));
}

/**
 * Every violation of the framed-document contract, structural and AC4 alike.
 *
 * Empty means the document is one DeFlow will seal. This is DeFlow's own
 * check; the Ajv pass over the emitted `DeFlow.taskspecdraft.v1.json` (AC2)
 * runs alongside it in `@DeFlow/daemon`, and the two agree by construction
 * because both are generated from the schema above.
 */
export function validateTaskSpecDraft(document: unknown): readonly DraftIssue[] {
  const parsed = LenientDraftSchema.safeParse(document);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => ({
      pointer: pointerOf(issue.path),
      message:
        issue.path.length === 1 && issue.path[0] === 'nonGoals' && issue.code === 'too_small'
          ? NON_GOALS_MESSAGE
          : issue.message,
    }));
  }
  return criteriaContractIssues(parsed.data);
}

/** Thrown by `sealTaskSpec` for a document that never should have reached it. */
export class TaskSpecDraftInvalid extends Error {
  readonly issues: readonly DraftIssue[];

  constructor(issues: readonly DraftIssue[]) {
    super(
      `the framed document does not satisfy ${TASKSPEC_DRAFT_SCHEMA_ID}: ${issues
        .map((issue) => `${issue.pointer || '/'} ${issue.message}`)
        .join('; ')}`,
    );
    this.name = 'TaskSpecDraftInvalid';
    this.issues = issues;
  }
}

// ── clarifying answers ───────────────────────────────────────────────────────

/** One clarifying exchange, as the ledger recorded it. */
export interface ClarifyingExchange {
  readonly question: string;
  readonly answer: string;
}

/**
 * AC8 — the operator's answers, as `priorDecisions` the spec carries.
 *
 * The question travels with the answer. An answer on its own ("Only
 * packages/ui and packages/forms") is unreadable six weeks later without the
 * question it answered, and the `human.requested` event that holds the
 * question is a separate row a spec reader has no reason to go looking for.
 */
export function answersAsPriorDecisions(
  exchanges: readonly ClarifyingExchange[],
): readonly DraftPriorDecision[] {
  return exchanges.map((exchange) => ({
    decision: exchange.answer,
    rationale: `Answered by the operator when asked: “${exchange.question}”`,
    source: 'operator' as const,
  }));
}

/** Adds `exchanges` to the framed document's `priorDecisions`, keeping the
 * document's own entries first and never replacing one. */
export function withClarifyingAnswers(
  document: TaskSpecDraft,
  exchanges: readonly ClarifyingExchange[],
): TaskSpecDraft {
  if (exchanges.length === 0) return document;
  return {
    ...document,
    priorDecisions: [...document.priorDecisions, ...answersAsPriorDecisions(exchanges)],
  };
}

// ── the projection onto DeFlow.taskspec.v1 ───────────────────────────────────

/**
 * The one place the two vocabularies meet (see the module note).
 *
 * `undefined` where v1 cannot say what the framed document said, and never a
 * guess: a criterion naming two gates has no v1 `check`, and the framed
 * document in the ledger is where "typecheck and build" is still readable.
 */
function checkFor(criterion: DraftAcceptanceCriterion): AcceptanceCriterionCheck | undefined {
  if ('unverifiable' in criterion) {
    return { kind: 'manual', rubric: criterion.reason };
  }
  const gates = criterion.verifiedBy;
  const only = gates.length === 1 ? gates[0] : undefined;
  return only === undefined ? undefined : { kind: 'gate', gate: only };
}

/** v1's `source` is a `Handle` — evidence, not provenance — so the framed
 * document's `source` is folded into the sentence rather than dropped. */
function priorDecisionFor(decision: DraftPriorDecision): PriorDecision {
  const attributed =
    decision.source === 'operator'
      ? decision.rationale
      : `${decision.rationale ?? 'Decided during framing.'} (source: ${decision.source})`;
  return {
    decision: decision.decision,
    ...(attributed === undefined ? {} : { rationale: attributed }),
  };
}

/**
 * AC11 — the `TaskSpec` `run.created` carries, minted from a framed document
 * that has already been validated.
 *
 * `approvedBy` is `null`: framing produces the spec, KAR-10.3's approval gate
 * is what approves it, and a spec that arrived pre-approved would make the one
 * gate this epic exists to build a formality. `specHash` is computed here and
 * excludes `approvedBy`, so approving this document later does not change its
 * identity (EPIC-02-S6).
 *
 * Throws `TaskSpecDraftInvalid` rather than sealing something partial — AC2's
 * "never a partial spec written to the ledger" is enforced at the one door
 * every spec goes through, not only at the caller that remembered to check.
 */
export async function sealTaskSpec(document: unknown): Promise<TaskSpec> {
  const issues = validateTaskSpecDraft(document);
  if (issues.length > 0) throw new TaskSpecDraftInvalid(issues);

  const draft = TaskSpecDraftSchema.parse(document);
  const unhashed = {
    schemaId: 'DeFlow.taskspec.v1',
    goal: draft.goal,
    scope: draft.scope,
    nonGoals: draft.nonGoals,
    constraints: draft.constraints,
    priorDecisions: draft.priorDecisions.map(priorDecisionFor),
    acceptanceCriteria: draft.acceptanceCriteria.map((criterion) => {
      const check = checkFor(criterion);
      return {
        id: criterion.id,
        statement: criterion.statement,
        ...(check === undefined ? {} : { check }),
        // Set by the planner during plan validation (KAR-11.2), never by
        // framing: which gate *nodes* cover a criterion is not knowable until
        // a plan exists.
        coveredByGates: [],
      };
    }),
    knownFailureModes: draft.knownFailureModes.map((mode) => ({
      id: mode.id,
      description: mode.description,
      detection: mode.detection,
      ...(mode.mitigation === undefined ? {} : { mitigation: mode.mitigation }),
    })),
    approvedBy: null,
  };

  return TaskSpecSchema.parse({
    ...unhashed,
    specHash: await specHash(unhashed),
  });
}
