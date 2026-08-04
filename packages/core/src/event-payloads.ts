/**
 * KAR-02.7 — the payload schema for every event kind in the §9 table.
 *
 * Implements docs/04-domain-model.md §9. One entry per row of that table, in
 * the table's own order, so the two can be read side by side — and
 * `packages/core/test/event-kinds-table.test.ts` reads the table off disk and
 * fails if they ever disagree.
 *
 * Two rows carry a design decision rather than a shape:
 *
 * - `context.compacted` (§9.1) has a `fidelity` discriminator, because half
 *   the data F6.6 asks for is genuinely unavailable for in-CLI compaction:
 *   Claude Code's `compact_boundary` frame emits `pre_tokens` and nothing
 *   else (Verified 2026-08-02). A fabricated "after" number is worse than an
 *   honest gap, so the schema refuses to accept one.
 * - `run.stalled` exists to be *surfaced*, never to auto-kill: a long build
 *   and a wedged agent look identical from here.
 *
 * The versioning rule lives with the registry at the bottom of this file: a
 * payload change that an upcaster can express is a new `v`; one it cannot is
 * a new `kind`. See schemas/CHANGELOG.md.
 *
 * Verifies: EPIC-02-S23 · AC6, AC8 (the rule's target set)
 */
import { z } from 'zod';
import { ContextPacketRecordSchema } from './context-packet.ts';
import { FactSchema } from './fact.ts';
import type { IdempotencyKey } from './ids.ts';
import {
  CriterionIdSchema,
  EventSeqSchema,
  FactIdSchema,
  GateIdSchema,
  HandleSchema,
  NodeIdSchema,
  PlanHashSchema,
  ProviderIdSchema,
  SegmentIdSchema,
} from './ids.ts';
import { parseIkey } from './ikey.ts';
import { NodeFailureSchema } from './node-failure.ts';
import { CompletedNodeResultSchema, NodeSuspensionSchema } from './node-result.ts';
import { HumanNodeSchema, PermissionLevelSchema, PlanGraphSchema } from './plan-graph.ts';
import { PatchDecisionSchema, PlanPatchSchema, ProposedBySchema } from './plan-patch.ts';
import { TaskSpecSchema } from './task-spec.ts';
import { singleLine } from './text.ts';
import { TokenUsageSchema } from './token-usage.ts';
import { VerdictSchema } from './verdict.ts';

// ── shared leaf schemas ──────────────────────────────────────────────────────

const nonNegativeInt = z.number().int().nonnegative();
const attempt = nonNegativeInt;

/** `sha256-<64 hex>`, the form `contentHash()` in ./hash.ts produces. */
const Sha256Schema = z.string().regex(/^sha256-[0-9a-f]{64}$/, 'must be sha256-<64 hex>');

/** A bare 64-hex digest — what a binary's `sha256` is reported as. */
const BareSha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a 64-character hex sha256');

/**
 * An `IdempotencyKey` arriving from the ledger, which stores it as TEXT.
 *
 * Deliberately not exported: KAR-02.1 AC4 makes `ikey()` the only constructor
 * of an `IdempotencyKey`, and exporting a string→key schema would let any
 * caller fabricate one. Reading a persisted event back is the one legitimate
 * place a key arrives as a free string, and even here it is validated by
 * round-tripping through `parseIkey`, so a malformed key is rejected rather
 * than branded.
 */
const IkeySchema: z.ZodType<IdempotencyKey, string> = z
  .string()
  .superRefine((value, ctx) => {
    try {
      parseIkey(value as IdempotencyKey);
    } catch (thrown) {
      ctx.addIssue({
        code: 'custom',
        message: thrown instanceof Error ? thrown.message : 'malformed IdempotencyKey',
      });
    }
  })
  .transform((value): IdempotencyKey => value as IdempotencyKey);

// ── closed vocabularies ──────────────────────────────────────────────────────

/** How a run ended. `partial` is a real outcome, not a euphemism: a run that
 * satisfied some acceptance criteria and not others must not be reported as
 * either success or failure (F7.4). */
export const RUN_OUTCOMES = ['succeeded', 'partial', 'failed'] as const;

/** The circuit breaker's three trip reasons (§9). */
export const RUN_NEEDS_HUMAN_REASONS = ['churn', 'budget', 'reconcile-unknown'] as const;

/** The four effect types of docs/05-durable-execution.md §8.3 — each has its
 * own reconciliation story, which is why this is a closed set. */
export const EFFECT_KINDS = ['agent', 'shell', 'git', 'file'] as const;

export const LOCK_KINDS = ['repo', 'worktree'] as const;

export const COMPACTION_SCOPES = ['DeFlow.packet', 'vendor.session'] as const;

export const COMPACTION_FIDELITIES = ['exact', 'partial'] as const;

export const COMPACTION_TRIGGERS = ['threshold', 'manual', 'vendor.auto'] as const;

export const BUDGET_SCOPES = ['node', 'run'] as const;

export const BUDGET_DIMENSIONS = ['cost', 'wallclock'] as const;

export const EXPORT_TARGETS = ['report', 'hub'] as const;

export const EXPORT_BLOCK_REASONS = ['redaction-failed', 'findings'] as const;

export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export type EffectKind = (typeof EFFECT_KINDS)[number];
export type CompactionFidelity = (typeof COMPACTION_FIDELITIES)[number];

// ── run lifecycle ────────────────────────────────────────────────────────────

export const RunCreatedSchema = z.strictObject({
  spec: TaskSpecSchema,
  cwd: z.string().min(1),
  repo: z.strictObject({
    /** The commit the run was created against — 7 to 64 hex, so both sha1 and
     * sha256 repositories and an abbreviated head are legal. */
    head: z.string().regex(/^[0-9a-f]{7,64}$/, 'repo.head must be a hex commit id'),
    branch: z.string().min(1),
  }),
});

export const RunSpecApprovedSchema = z.strictObject({
  specHash: Sha256Schema,
  by: z.enum(['ui', 'cli']),
});

export const RunStartedSchema = z.strictObject({ planHash: PlanHashSchema });

/** F4.4: pause is an event, never an in-memory flag — a flag does not survive
 * the restart it exists to protect against. */
export const RunPauseToggledSchema = z.strictObject({
  by: z.enum(['user', 'policy']),
  reason: singleLine().optional(),
});

export const RunCancelRequestedSchema = z.strictObject({
  mode: z.enum(['cooperative', 'forceful']),
});

export const RunEndedSchema = z.strictObject({
  outcome: z.enum(RUN_OUTCOMES),
  criteriaSatisfied: z.array(CriterionIdSchema),
});

/** F4.7. Surfaced, never auto-killed. */
export const RunStalledSchema = z.strictObject({
  watermarkSeq: EventSeqSchema,
  idleMs: nonNegativeInt,
  runningNodes: z.array(NodeIdSchema),
});

export const RunNeedsHumanSchema = z.strictObject({
  reason: z.enum(RUN_NEEDS_HUMAN_REASONS),
  detail: singleLine(),
});

// ── planning ─────────────────────────────────────────────────────────────────

export const PlanProposedSchema = z.strictObject({
  version: z.number().int().positive(),
  planHash: PlanHashSchema,
  graph: PlanGraphSchema,
  by: ProposedBySchema,
});

/** F2.4 — the proposal is recorded even when it is rejected, which is the
 * whole point of a separate event from `plan.patched`. */
export const PlanPatchProposedSchema = z.strictObject({ patch: PlanPatchSchema });

export const PlanPatchedSchema = z.strictObject({
  version: z.number().int().positive(),
  fromHash: PlanHashSchema,
  toHash: PlanHashSchema,
  patchId: z.string().min(1),
  decision: PatchDecisionSchema,
});

export const PlanPatchRejectedSchema = z.strictObject({
  patchId: z.string().min(1),
  rule: z.string().min(1),
  by: z.enum(['policy', 'human']),
});

// ── node lifecycle ───────────────────────────────────────────────────────────

export const NodeScheduledSchema = z.strictObject({
  node: NodeIdSchema,
  provider: ProviderIdSchema,
  model: z.string().min(1).optional(),
  permission: PermissionLevelSchema,
});

/** F5.2 — locks live in the ledger so they survive a restart. */
export const NodeLockSchema = z.strictObject({
  node: NodeIdSchema,
  lock: z.enum(LOCK_KINDS),
  key: z.string().min(1),
});

/** Written *before* the side effect. This record is what makes at-least-once
 * recovery possible at all. */
export const NodeStartedSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  ikey: IkeySchema,
  binary: z.strictObject({
    path: z.string().min(1),
    version: z.string().min(1),
    sha256: BareSha256Schema,
  }),
});

/** F10.1/F10.6. Cheap, frequent, and it does not advance the progress
 * watermark — which is why `run.stalled` reads `watermarkSeq` and not this. */
export const NodeProgressSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  phase: z.string().min(1),
  message: singleLine().optional(),
  ioChunkSeq: EventSeqSchema.optional(),
});

export const NodeCompletedSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  result: CompletedNodeResultSchema,
});

export const NodeFailedSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  failure: NodeFailureSchema,
});

/** Written in the same transaction as `node.failed`. */
export const NodeRetryScheduledSchema = z.strictObject({
  node: NodeIdSchema,
  nextAttempt: z.number().int().positive(),
  /** ms epoch — an instant, so it survives a restart that outlives the
   * timer. */
  wakeAt: nonNegativeInt,
});

export const NodeSuspendedSchema = z.strictObject({
  node: NodeIdSchema,
  until: NodeSuspensionSchema,
});

// ── the effect journal ───────────────────────────────────────────────────────

export const EffectStartedSchema = z.strictObject({
  ikey: IkeySchema,
  kind: z.enum(EFFECT_KINDS),
  /** Guards against a plan edit landing under a live effect. */
  requestHash: Sha256Schema,
});

export const EffectCompletedSchema = z.strictObject({
  ikey: IkeySchema,
  result: z.unknown(),
  reconciled: z.boolean(),
});

export const EffectFailedSchema = z.strictObject({
  ikey: IkeySchema,
  failure: NodeFailureSchema,
});

// ── context ──────────────────────────────────────────────────────────────────

export const ContextBuiltSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  /** Minus each segment's `text` (§9) — see `ContextPacketRecordSchema`. */
  packet: ContextPacketRecordSchema,
});

/**
 * §9.1. `fidelity: 'partial'` means the numbers are vendor-reported and
 * incomplete, and the schema enforces that the missing ones stay missing:
 * `after` must be `null`, `droppedSegments` must be `[]`, and there is no
 * handle to the original. Supplying any of them under `partial` is the
 * fabrication this discriminator exists to prevent (AC6, EPIC-02-S23).
 */
export const ContextCompactedSchema = z
  .strictObject({
    node: NodeIdSchema,
    scope: z.enum(COMPACTION_SCOPES),
    fidelity: z.enum(COMPACTION_FIDELITIES),
    trigger: z.enum(COMPACTION_TRIGGERS),
    before: nonNegativeInt,
    /** `null` when vendor-reported. */
    after: z.union([nonNegativeInt, z.null()]),
    /** `[]` when vendor-reported. */
    droppedSegments: z.array(SegmentIdSchema),
    demotedToHandles: z.array(HandleSchema),
    /** One sha256 per pinned segment — proves the F6.6 integrity check
     * passed across the compaction. */
    pinnedKept: z.array(Sha256Schema),
    originalHandle: z.union([HandleSchema, z.null()]),
  })
  .superRefine((payload, ctx) => {
    if (payload.fidelity === 'partial') {
      if (payload.after !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['after'],
          message:
            'a partial (vendor-reported) compaction has no post-compaction token count: ' +
            'after must be null, never a fabricated number',
        });
      }
      if (payload.droppedSegments.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['droppedSegments'],
          message:
            'a partial (vendor-reported) compaction does not report what it dropped: ' +
            'droppedSegments must be []',
        });
      }
      if (payload.originalHandle !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['originalHandle'],
          message:
            'a partial (vendor-reported) compaction leaves no handle to the original ' +
            'context: originalHandle must be null',
        });
      }
      return;
    }
    if (payload.after === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['after'],
        message:
          'an exact compaction knows its post-compaction token count: after must be a number',
      });
    }
  });

/** F6.6 — a pinned segment whose digest no longer matches fails the node. */
export const PinIntegrityViolatedSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  missingDigests: z.array(Sha256Schema),
  segmentIds: z.array(SegmentIdSchema),
});

// ── the blackboard ───────────────────────────────────────────────────────────

export const FactWrittenSchema = z.strictObject({ fact: FactSchema });

/** Makes the consumer set one query rather than a graph walk. */
export const FactReadSchema = z.strictObject({
  factId: FactIdSchema,
  key: z.string().min(1),
  by: NodeIdSchema,
});

export const FactInvalidatedSchema = z.strictObject({
  factId: FactIdSchema,
  by: NodeIdSchema,
  reason: singleLine(),
  taints: z.array(NodeIdSchema),
});

/** F6.4 — the handoff budget, enforced rather than advised. */
export const HandoffOversizeSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  budget: nonNegativeInt,
  actual: nonNegativeInt,
  repairAttempted: z.boolean(),
});

// ── gates and humans ─────────────────────────────────────────────────────────

export const GateEvaluatedSchema = z.strictObject({
  gate: GateIdSchema,
  node: NodeIdSchema,
  verdict: VerdictSchema,
});

export const HumanRequestedSchema = z.strictObject({
  node: NodeIdSchema,
  prompt: z.string().min(1),
  /** The same option vocabulary a `human` node declares (§3). */
  options: HumanNodeSchema.shape.options,
  deadline: HumanNodeSchema.shape.deadline,
});

export const HumanRespondedSchema = z.strictObject({
  node: NodeIdSchema,
  optionId: z.string().min(1),
  text: z.string().optional(),
  /** Display only — ordering is by `seq`, never by this timestamp. */
  at: z.iso.datetime(),
});

// ── money and providers ──────────────────────────────────────────────────────

export const BudgetConsumedSchema = z.strictObject({
  /** Absent for run-level consumption that no single node owns. */
  node: NodeIdSchema.optional(),
  provider: ProviderIdSchema,
  usage: TokenUsageSchema,
  costUsd: z.number().nonnegative(),
});

/** F4.6 — pauses the run, does not fail it. */
export const BudgetExceededSchema = z.strictObject({
  scope: z.enum(BUDGET_SCOPES),
  dimension: z.enum(BUDGET_DIMENSIONS),
  limit: z.number().nonnegative(),
  actual: z.number().nonnegative(),
});

/** F3.4/F3.5 — capabilities are derived from a probe, never hardcoded. */
export const ProviderProbedSchema = z.strictObject({
  provider: ProviderIdSchema,
  version: z.string().min(1),
  capsJson: z.unknown(),
  binarySha256: BareSha256Schema,
});

/** Parsed from Claude Code's `rate_limit_event` frame; `raw` keeps the frame
 * verbatim because the vendor's shape is not ours to normalise. */
export const ProviderRateLimitedSchema = z.strictObject({
  provider: ProviderIdSchema,
  /** ms epoch. */
  resetsAt: nonNegativeInt.optional(),
  raw: z.unknown(),
});

/** F5.9 — redaction fails closed. */
export const ExportBlockedSchema = z.strictObject({
  target: z.enum(EXPORT_TARGETS),
  reason: z.enum(EXPORT_BLOCK_REASONS),
  count: nonNegativeInt,
});

// ── the registry ─────────────────────────────────────────────────────────────

/**
 * Every event kind, its current payload version, and the schema of that
 * version. In §9's table order.
 *
 * `v` is the *current* version. A payload written at a lower version is
 * lifted by the upcaster chain at read time (./upcasters.ts); a payload
 * arriving at a higher version is reported and skipped, never guessed at.
 * Events are never rewritten on disk.
 */
export const EVENT_SCHEMAS = {
  'run.created': { v: 1, payload: RunCreatedSchema },
  'run.spec.approved': { v: 1, payload: RunSpecApprovedSchema },
  'run.started': { v: 1, payload: RunStartedSchema },
  'run.paused': { v: 1, payload: RunPauseToggledSchema },
  'run.resumed': { v: 1, payload: RunPauseToggledSchema },
  'run.cancel.requested': { v: 1, payload: RunCancelRequestedSchema },
  'run.completed': { v: 1, payload: RunEndedSchema },
  'run.aborted': { v: 1, payload: RunEndedSchema },
  'run.stalled': { v: 1, payload: RunStalledSchema },
  'run.needs_human': { v: 1, payload: RunNeedsHumanSchema },
  'plan.proposed': { v: 1, payload: PlanProposedSchema },
  'plan.patch.proposed': { v: 1, payload: PlanPatchProposedSchema },
  'plan.patched': { v: 1, payload: PlanPatchedSchema },
  'plan.patch.rejected': { v: 1, payload: PlanPatchRejectedSchema },
  'node.scheduled': { v: 1, payload: NodeScheduledSchema },
  'node.lock.acquired': { v: 1, payload: NodeLockSchema },
  'node.lock.released': { v: 1, payload: NodeLockSchema },
  'node.started': { v: 1, payload: NodeStartedSchema },
  'node.progress': { v: 1, payload: NodeProgressSchema },
  'node.completed': { v: 1, payload: NodeCompletedSchema },
  'node.failed': { v: 1, payload: NodeFailedSchema },
  'node.retry.scheduled': { v: 1, payload: NodeRetryScheduledSchema },
  'node.suspended': { v: 1, payload: NodeSuspendedSchema },
  'effect.started': { v: 1, payload: EffectStartedSchema },
  'effect.completed': { v: 1, payload: EffectCompletedSchema },
  'effect.failed': { v: 1, payload: EffectFailedSchema },
  'context.built': { v: 1, payload: ContextBuiltSchema },
  'context.compacted': { v: 1, payload: ContextCompactedSchema },
  'pin.integrity_violated': { v: 1, payload: PinIntegrityViolatedSchema },
  'fact.written': { v: 1, payload: FactWrittenSchema },
  'fact.read': { v: 1, payload: FactReadSchema },
  'fact.invalidated': { v: 1, payload: FactInvalidatedSchema },
  'handoff.oversize': { v: 1, payload: HandoffOversizeSchema },
  'gate.evaluated': { v: 1, payload: GateEvaluatedSchema },
  'human.requested': { v: 1, payload: HumanRequestedSchema },
  'human.responded': { v: 1, payload: HumanRespondedSchema },
  'budget.consumed': { v: 1, payload: BudgetConsumedSchema },
  'budget.exceeded': { v: 1, payload: BudgetExceededSchema },
  'provider.probed': { v: 1, payload: ProviderProbedSchema },
  'provider.rate_limited': { v: 1, payload: ProviderRateLimitedSchema },
  'export.blocked': { v: 1, payload: ExportBlockedSchema },
} as const;

export type EventKind = keyof typeof EVENT_SCHEMAS;

/** Every kind, in §9's order. The reducer branches on this and on `v` only. */
export const EVENT_KINDS = Object.keys(EVENT_SCHEMAS) as readonly EventKind[];

const KIND_SET: ReadonlySet<string> = new Set<string>(EVENT_KINDS);

/** Whether `kind` is one this build understands. A `false` here is not an
 * error: it is the forward-compatibility path (§9.2 rule 2). */
export function isEventKind(kind: string): kind is EventKind {
  return KIND_SET.has(kind);
}

/** `kind → current payload version`, the input to the upcaster registry. */
export const EVENT_CURRENT_VERSIONS: Readonly<Record<EventKind, number>> = Object.freeze(
  Object.fromEntries(EVENT_KINDS.map((kind) => [kind, EVENT_SCHEMAS[kind].v])) as Record<
    EventKind,
    number
  >,
);

export type EventPayloadOf<K extends EventKind> = z.infer<(typeof EVENT_SCHEMAS)[K]['payload']>;
