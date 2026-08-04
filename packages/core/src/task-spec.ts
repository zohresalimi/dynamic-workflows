/**
 * KAR-02.2 — `TaskSpec`: the validated document the run is judged against.
 *
 * Implements docs/04-domain-model.md §2. Produced by the framing interview,
 * edited and explicitly approved by a human before anything executes.
 *
 * Two load-bearing details:
 *
 *   1. `acceptanceCriteria` must be non-empty. F7.4 requires every criterion
 *      to reach a gate, and zero criteria means the run cannot be judged
 *      (AC1) — so the schema refuses an empty array rather than leaving it to
 *      a reviewer to notice a spec with nothing to check.
 *   2. `specHash` (./hash.ts, KAR-02.9) is computed *excluding* `approvedBy`,
 *      so re-approving an unchanged spec does not change its identity while
 *      editing one word does (EPIC-02-S6). This module only carries the
 *      schema; `specHash` itself lives in ./hash.ts because it is built on
 *      the canonical JSON encoder that also derives `planHash`.
 *
 * `pinnedSegmentsOf` is the other half of this story: F1.5's anti-drift
 * contract — `goal`, `nonGoals`, `constraints`, `acceptanceCriteria` and the
 * active node's `pathScopes` and `permission` are re-injected verbatim into
 * every context packet — is a property of the spec type, not of the packet
 * builder that consumes it (KAR-02.6, out of scope here). The active node's
 * shape is not yet the full `PlanNode` (KAR-02.3): `PinnedNodeContext` is the
 * minimal slice this selector needs until that story lands.
 *
 * Verifies: EPIC-02-S6, EPIC-02-S7 · AC1-AC6
 */
import { z } from 'zod';
import type { SchemaId } from './ids.ts';
import { CriterionIdSchema, GateIdSchema, HandleSchema, NodeIdSchema } from './ids.ts';

/** `TaskSpec.schemaId` is a fixed literal, not an open `SchemaId`: this
 * module only ever produces or accepts one document shape at v1. The version
 * suffix is part of the id (§1) — schemas are append-only, so an unsuffixed
 * id (`'DeFlow.taskspec'`) has no upgrade path and is rejected. */
export const TASKSPEC_SCHEMA_ID = 'DeFlow.taskspec.v1' as const;

const TaskSpecSchemaIdSchema: z.ZodType<SchemaId, string> = z
  .literal(TASKSPEC_SCHEMA_ID)
  .transform((value): SchemaId => value as SchemaId);

/** §2: the three ways a criterion can actually be checked. The union is
 * closed — `expect` and `kind` are string-literal sets, not open strings —
 * so a typo like `expect: 'passes'` or `kind: 'script'` is rejected at the
 * schema boundary rather than silently ignored at gate time. */
export const AcceptanceCriterionCheckSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('command'),
    run: z.string().min(1),
    cwd: z.string().optional(),
    expect: z.enum(['exit-zero', 'exit-nonzero']),
  }),
  z.strictObject({
    kind: z.literal('gate'),
    gate: GateIdSchema,
  }),
  z.strictObject({
    kind: z.literal('manual'),
    rubric: z.string().min(1),
  }),
]);

export type AcceptanceCriterionCheck = z.infer<typeof AcceptanceCriterionCheckSchema>;

/**
 * `coveredByGates` is set by the planner during plan validation (KAR-11.2),
 * never authored by hand — so the schema defaults it to `[]` and accepts a
 * hand-written criterion that omits it entirely (AC5).
 */
export const AcceptanceCriterionSchema = z.strictObject({
  id: CriterionIdSchema,
  /** A single testable statement. EARS phrasing encouraged, not enforced. */
  statement: z.string().min(1),
  check: AcceptanceCriterionCheckSchema.optional(),
  coveredByGates: z.array(NodeIdSchema).default([]),
});

export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterionSchema>;

/** A failure mode with no detection story is the "shallow spec" the SDD
 * literature names as the primary failure mode, so `detection` is required
 * rather than optional (EPIC-02-S7 notes). */
export const FailureModeSchema = z.strictObject({
  id: z.string().min(1),
  /** 'the migration codemod silently drops v-model modifiers' */
  description: z.string().min(1),
  /** How we would notice. */
  detection: z.string().min(1),
  mitigation: z.string().optional(),
});

export type FailureMode = z.infer<typeof FailureModeSchema>;

export const PriorDecisionSchema = z.strictObject({
  decision: z.string().min(1),
  rationale: z.string().optional(),
  source: HandleSchema.optional(),
});

export type PriorDecision = z.infer<typeof PriorDecisionSchema>;

export const TaskSpecApprovalSchema = z.strictObject({
  at: z.iso.datetime(),
  via: z.enum(['ui', 'cli']),
});

export type TaskSpecApproval = z.infer<typeof TaskSpecApprovalSchema>;

const SPEC_HASH_PATTERN = /^sha256-[0-9a-f]{64}$/;

export const TaskSpecSchema = z.strictObject({
  schemaId: TaskSpecSchemaIdSchema,
  goal: z.string().min(1),
  scope: z.strictObject({
    included: z.array(z.string()),
    paths: z.array(z.string()).optional(),
  }),
  nonGoals: z.array(z.string()),
  constraints: z.array(z.string()),
  priorDecisions: z.array(PriorDecisionSchema),
  // AC1: F7.4 requires every criterion to reach a gate; zero criteria means
  // the run cannot be judged, so the array must be non-empty.
  acceptanceCriteria: z.array(AcceptanceCriterionSchema).min(1),
  knownFailureModes: z.array(FailureModeSchema),
  approvedBy: TaskSpecApprovalSchema.nullable(),
  // Computed by specHash() in ./hash.ts, over everything except this field
  // and approvedBy — never derived here, just validated for shape.
  specHash: z.string().regex(SPEC_HASH_PATTERN, `specHash must match ${SPEC_HASH_PATTERN}`),
});

export type TaskSpec = z.infer<typeof TaskSpecSchema>;

/**
 * The slice of an active `PlanNode` that F1.5 re-injects verbatim alongside
 * the spec-level pinned fields. KAR-02.3 folds this into the full `PlanNode`
 * contract (`NodeBase.pathScopes`, `NodeBase.permission`); until then this is
 * the minimal shape `pinnedSegmentsOf` needs.
 */
export interface PinnedNodeContext {
  readonly pathScopes: readonly string[];
  readonly permission: string;
}

/** The six field groups F1.5 names, in the stable order `pinnedSegmentsOf`
 * always returns them (AC6). */
export const PINNED_SPEC_FIELDS = [
  'goal',
  'nonGoals',
  'constraints',
  'acceptanceCriteria',
  'pathScopes',
  'permission',
] as const;

export type PinnedField = (typeof PINNED_SPEC_FIELDS)[number];

export interface PinnedSegmentInput {
  readonly field: PinnedField;
  readonly value: unknown;
}

/**
 * Selects the fields F1.5's anti-drift contract pins verbatim into every
 * context packet: `goal`, `nonGoals`, `constraints`, `acceptanceCriteria`
 * from the spec, plus the active node's `pathScopes` and `permission`.
 *
 * Returns the raw field/value pairs, not `Segment` values — assembling a
 * `pinned: true` `Segment` (with its `contentHash` and rendering) is the
 * context-packet builder's job (KAR-02.6, out of scope here).
 */
export function pinnedSegmentsOf(
  spec: TaskSpec,
  node: PinnedNodeContext,
): readonly PinnedSegmentInput[] {
  return [
    { field: 'goal', value: spec.goal },
    { field: 'nonGoals', value: spec.nonGoals },
    { field: 'constraints', value: spec.constraints },
    { field: 'acceptanceCriteria', value: spec.acceptanceCriteria },
    { field: 'pathScopes', value: node.pathScopes },
    { field: 'permission', value: node.permission },
  ];
}
