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
import {
  ContextPacketRecordSchema,
  SegmentKindSchema,
  TokenCountMethodSchema,
} from './context-packet.ts';
import { FactSchema } from './fact.ts';
import { TaskSpecDraftSchema } from './framing.ts';
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
import { JsonPatchOperationSchema } from './json-patch.ts';
import { FailureClassSchema, NodeFailureSchema } from './node-failure.ts';
import {
  CancelledNodeResultSchema,
  CompletedNodeResultSchema,
  NodeSuspensionSchema,
} from './node-result.ts';
import { HumanNodeSchema, PermissionLevelSchema, PlanGraphSchema } from './plan-graph.ts';
import {
  PATCH_CAUSES,
  PatchDecisionSchema,
  PlanPatchSchema,
  ProposedBySchema,
} from './plan-patch.ts';
import { TaskSubmittedSchema } from './task-intake.ts';
import { TaskSpecSchema } from './task-spec.ts';
import { singleLine } from './text.ts';
import { TokenUsageSchema } from './token-usage.ts';
import { VerdictV2Schema } from './verdict.ts';

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

/**
 * The circuit breaker's trip reasons (§9).
 *
 * `spec-revalidation` is KAR-10.3 AC8's, and it is a fourth reason rather than
 * a `detail` on one of the other three because the operator's next action is
 * different in kind: churn and budget are answered by raising a ceiling or
 * changing the approach, and this one is answered by covering a criterion the
 * plan no longer satisfies. It arrives at `run.needs_human` **v2** — widening a
 * closed vocabulary is a shape change, so an older daemon reading a newer
 * ledger says so instead of guessing (./upcasters.ts).
 */
export const RUN_NEEDS_HUMAN_REASONS = [
  'churn',
  'budget',
  'reconcile-unknown',
  'spec-revalidation',
] as const;

/** The four effect types of docs/05-durable-execution.md §8.3 — each has its
 * own reconciliation story, which is why this is a closed set. */
export const EFFECT_KINDS = ['agent', 'shell', 'git', 'file'] as const;

export const LOCK_KINDS = ['repo', 'worktree'] as const;

/**
 * Who is sitting on a branch DeFlow wanted
 * (docs/09-workspace-and-safety.md §3.2, KAR-07.2).
 *
 * Two values because the operator's own checkout is a genuinely different
 * situation from another node's worktree: it is the common real-world hit, it
 * lands on the very first run, and the message it deserves is about *their*
 * branch and the base-ref choice — not about a collision they had no part in.
 */
export const WORKTREE_OCCUPANT_KINDS = ['worktree', 'main-checkout'] as const;

export const COMPACTION_SCOPES = ['DeFlow.packet', 'vendor.session'] as const;

export const COMPACTION_FIDELITIES = ['exact', 'partial'] as const;

export const COMPACTION_TRIGGERS = ['threshold', 'manual', 'vendor.auto'] as const;

export const BUDGET_SCOPES = ['node', 'run'] as const;

export const BUDGET_DIMENSIONS = ['cost', 'wallclock'] as const;

/**
 * Whose ceiling fired (KAR-14.2 AC9).
 *
 * `vendor` is Claude Code's `--max-budget-usd` and its `error_max_budget_usd`
 * result subtype — defence in depth *below* DeFlow's own ceiling. Both pause
 * the run identically; which one fired is the difference between raising
 * DeFlow's ceiling and raising the vendor's, and the numbers alone cannot say.
 */
export const BUDGET_CEILING_OWNERS = ['deflow', 'vendor'] as const;

export const EXPORT_TARGETS = ['report', 'hub'] as const;

export const EXPORT_BLOCK_REASONS = ['redaction-failed', 'findings'] as const;

export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export type EffectKind = (typeof EFFECT_KINDS)[number];
export type CompactionFidelity = (typeof COMPACTION_FIDELITIES)[number];
export type WorktreeOccupantKind = (typeof WORKTREE_OCCUPANT_KINDS)[number];

// ── task intake ──────────────────────────────────────────────────────────────
//
// KAR-10.1: `task.submitted` is the one event intake ever writes. It is its
// own kind, ahead of `run.created` in this file's table order, because it is
// the run's actual first event on the wire — POST /api/runs mints the RunId
// and appends this and only this. `TaskSubmittedSchema` and `normaliseInput`
// live in ./task-intake.ts rather than here, alongside their own AC2/AC3
// rationale; this file only registers the schema in the table below.

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

/**
 * KAR-10.3 AC5 — an operator edit of the `TaskSpec`, as a patch rather than a
 * replacement (docs/01-architecture-overview.md §, docs/06 §1.3).
 *
 * Four fields, and each one answers a question the others cannot:
 *
 * - `from` / `to` are the `specHash` either side of the edit. They are what
 *   makes a version *addressable*: a verdict cites the hash it was judged
 *   against, and "which document was that?" has to be answerable from the log
 *   alone.
 * - `patch` is the RFC 6902 diff between the two **sealed** specs, excluding
 *   `specHash` and `approvedBy` for the same reason the hash does — an edit that
 *   changed nothing but the approval record is not an edit, and a patch whose
 *   first operation replaced the digest of the document it is a patch for would
 *   be unreadable in a UI.
 * - `document` is the amended framed document — `DeFlow.taskspecdraft.v1`, the
 *   thing the operator actually edits, because `verifiedBy` and `unverifiable`
 *   are its vocabulary and not v1's. The sealed spec is `sealTaskSpec(document)`
 *   and is therefore not carried twice: ./framing.ts is explicit that there is
 *   one door a `TaskSpec` comes through, and two copies of a document in one
 *   append-only row is two things that can disagree.
 *
 * Nothing is overwritten by this event, which is the whole of AC5: the pre-edit
 * spec is still `run.created.spec`, still at its own hash, still readable.
 */
export const SpecAmendedSchema = z.strictObject({
  from: Sha256Schema,
  to: Sha256Schema,
  patch: z.array(JsonPatchOperationSchema).min(1),
  document: TaskSpecDraftSchema,
  by: z.enum(['ui', 'cli']),
});

/**
 * KAR-10.3 AC4 / KAR-10.4 AC1 — the pinned set, minted in the same transaction
 * as the approval it derives from (docs/06 §1.3, docs/08 §4.1).
 *
 * The digests rather than the text: the bytes are rebuilt by
 * `buildPinnedSegments` from a spec the ledger already carries, and this row is
 * the evidence that what a packet renders is what was approved. A `spec.pinned`
 * whose `specHash` is not the run's current one is a stale pin, which is exactly
 * what `assertPinIntegrity` (KAR-09.3) is given something to check against.
 */
export const SpecPinnedSchema = z.strictObject({
  specHash: Sha256Schema,
  segments: z
    .array(
      z.strictObject({
        id: SegmentIdSchema,
        kind: SegmentKindSchema,
        sha256: Sha256Schema,
      }),
    )
    .min(1),
});

export const RunStartedSchema = z.strictObject({ planHash: PlanHashSchema });

/** F4.4: pause is an event, never an in-memory flag — a flag does not survive
 * the restart it exists to protect against. */
export const RunPauseToggledSchema = z.strictObject({
  by: z.enum(['user', 'policy']),
  reason: singleLine().optional(),
});

/**
 * F5.7's two ladders. `cooperative` asks the agent to stop over the protocol
 * and lets it flush its transcript; `forceful` goes straight to the process
 * group. Which one is a *scheduling* decision, so it travels in the event and
 * reaches `decide()` through the projection rather than through a call.
 */
export const CANCEL_MODES = ['cooperative', 'forceful'] as const;

export type CancelMode = (typeof CANCEL_MODES)[number];

export const RunCancelRequestedSchema = z.strictObject({
  mode: z.enum(CANCEL_MODES),
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
/**
 * KAR-14.4 AC7 — v2 adds `cause`: why the scheduler proposed this patch.
 *
 * On the proposal rather than on the `PlanPatch` itself, and that is a
 * deliberate boundary rather than a convenience. `DeFlow.planpatch.v1` is a
 * shipped, content-hashed document schema (schemas/CHANGELOG.md), so a field
 * there means publishing `.v2` — EPIC-11's change, not a rate-limit story's.
 * And the cause belongs to the proposal in any case: the same
 * `replace-provider` op is a routine planner decision or a vendor refusing to
 * serve, and which of the two it is decides whether
 * `quota-reroute-equivalent` may auto-apply it.
 *
 * Optional, because a planner-proposed patch genuinely has no cause to state
 * and `'unknown'` would be a value nobody could act on.
 */
export const PlanPatchProposedSchema = z.strictObject({
  patch: PlanPatchSchema,
  cause: z.enum(PATCH_CAUSES).optional(),
});

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
  /**
   * The worktree this node was assigned, when it was assigned one. Absent
   * means the node runs against the main checkout — a read-only analysis node
   * usually does.
   *
   * It is recorded here, beside the provider and the permission level, because
   * it is the same kind of fact: a resolution the scheduler made and the run
   * has to be able to rebuild after a restart. F5.2's per-worktree exclusive
   * lock is keyed on it, so a worktree assignment that lived only in memory
   * would let two agents into one checkout on the first tick after a crash.
   */
  worktree: z.string().min(1).optional(),
  /**
   * KAR-09.6 AC7, AC8 — the compaction lever this node was scheduled with.
   *
   * Recorded here rather than inferred from the config later, for the reason
   * AC8 gives: a node that dies of context exhaustion mid-turn is only
   * *attributable* if the run can say afterwards whether auto-compaction was
   * disabled for it and at what percentage it was set to fire. The config file
   * is mutable and the run is not.
   *
   * Absent means "the vendor's own defaults, untouched", which is what every
   * provider with no such lever gets.
   */
  compaction: z
    .strictObject({
      /** `null` leaves the vendor's threshold alone. */
      autocompactPct: z.union([z.number().int().min(1).max(100), z.null()]),
      autoCompactDisabled: z.boolean(),
    })
    .optional(),
});

/** F5.2 — locks live in the ledger so they survive a restart. */
export const NodeLockSchema = z.strictObject({
  node: NodeIdSchema,
  lock: z.enum(LOCK_KINDS),
  key: z.string().min(1),
});

/**
 * Why a held lock was given back.
 *
 * `reclaimed` is the scheduler taking a lock away from a node that is no
 * longer running — the crash case above all, where the holder died with the
 * lock in hand and nothing it could have run would ever release it. An
 * ordinary release, appended by whatever is finishing an attempt, carries no
 * reason at all: it needs no explanation, and inventing one for it would make
 * the interesting case indistinguishable in the timeline.
 */
export const LOCK_RELEASE_REASONS = ['reclaimed'] as const;

export type LockReleaseReason = (typeof LOCK_RELEASE_REASONS)[number];

export const NodeLockReleasedSchema = z.strictObject({
  node: NodeIdSchema,
  lock: z.enum(LOCK_KINDS),
  key: z.string().min(1),
  reason: z.enum(LOCK_RELEASE_REASONS).optional(),
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

/**
 * KAR-07.6 — the scheduling half of Decision D14
 * (docs/09-workspace-and-safety.md §6.2, §7.3).
 *
 * `git merge-tree --write-tree` said these two in-flight branches have started
 * to conflict, and the later-*starting* node is demoted so the earlier one can
 * finish. Later-starting rather than lower-priority or smaller: the node that
 * has been running longest has the most work to lose, and start time is the
 * one ordering both a scheduler and a human reading the timeline agree on.
 *
 * The payload has to answer "why is this node not running?" without a second
 * query. `conflictsWith` is the counterpart it collided with — its node id,
 * not its branch, because the board shows nodes — and `paths` is what
 * `merge-tree --name-only` actually reported, which is the difference between
 * "these branches conflict" and a diagnosis. Both branches are named too, so
 * the matching `conflict_probe` row is findable from the event alone.
 */
export const NodeBlockedSchema = z.strictObject({
  node: NodeIdSchema,
  /** The in-flight node this one conflicts with; it keeps running. */
  conflictsWith: NodeIdSchema,
  branch: z.string().min(1),
  otherBranch: z.string().min(1),
  /** Non-empty by construction: a clean probe never blocks anything. */
  paths: z.array(z.string().min(1)).min(1),
});

/**
 * KAR-08.1 AC4 / EPIC-08-S3 — F5.4's refusal, narrowed to one capability bit.
 *
 * An adapter that does not route `fs/*` and `terminal/*` through DeFlow leaves
 * DeFlow enforcing nothing, so a node above `read` is refused rather than run
 * at a level nobody is checking. There is deliberately no third answer: a
 * silent downgrade would be ODW's binary permission model, which F5.4 exists
 * to avoid, and a silent escalation is the Kiro incident.
 *
 * Its own kind rather than only the `node.failed` that follows it. A failure
 * is where a node *ended*; this is why it never began, and the two answer
 * different questions on a run report. `reason` is a code — the operator's
 * question is "which provider, and which bit" — so a UI can group by it and a
 * future capability can join the same shape.
 */
export const NodeUnschedulableSchema = z.strictObject({
  node: NodeIdSchema,
  provider: ProviderIdSchema,
  /** The probed binary's version, so "upgrade and retry" is answerable. */
  version: z.string().min(1),
  /** The level that could not be enforced, not the one it might be run at. */
  permission: PermissionLevelSchema,
  /** `<capability>:<value>`, e.g. `mediatedExecution:false`. */
  reason: singleLine(),
});

/**
 * The longest requested path this record keeps verbatim.
 *
 * 4096 rather than `SINGLE_LINE_MAX`, and not `singleLine()` at all, because
 * the value is the **agent's own string**: `PATH_MAX` is 4096 on Linux, and a
 * POSIX filename may legally contain a newline. A schema that refused one
 * would mean an attacker could make a denial unrecordable by choosing a funny
 * filename, which is a worse failure than a long value in a payload nobody
 * renders as a log line.
 */
export const REQUESTED_PATH_MAX = 4096;

/**
 * KAR-08.2 AC7 — a mediated request that was refused, as the node inspector
 * needs to render it.
 *
 * Structured, not a sentence. The inspector renders `path-escape:symlink`
 * differently from `level-read`, KAR-08.3's gate budget counts by code, and
 * `requested` has to stay the agent's own string so that "what did it ask
 * for" and "what did that resolve to" remain two different questions. A prose
 * `message` field would make all three impossible, and it is the shape every
 * implementation reaches for first.
 *
 * `permission` is the level the request was decided at, so a denial can be
 * read without joining back to `node.scheduled`.
 *
 * `declared` (KAR-08.7 AC2) is populated only for a `scope-violation`: the
 * node's declared write globs, as a separate structured field rather than
 * folded into `reason.detail` — the node inspector renders `requested` next
 * to `declared`, and neither is a sentence.
 */
export const PermissionDeniedSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  /** The level the request was decided at. */
  permission: PermissionLevelSchema,
  /** The ACP method DeFlow mediated, in `PermissionRequest`'s own vocabulary. */
  method: z.enum(['fs/read_text_file', 'fs/write_text_file', 'terminal/create', 'network']),
  /** Verbatim, before any resolution — see `REQUESTED_PATH_MAX`. */
  requested: z.string().max(REQUESTED_PATH_MAX),
  /** `PermissionReason`: a code plus an optional route, binary or host. */
  reason: z.strictObject({
    code: z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be a reason code, not prose'),
    detail: singleLine().optional(),
  }),
  declared: z.array(z.string()).optional(),
});

/**
 * KAR-08.7 AC3, AC5 — the completion-time backstop for an adapter that never
 * populated `ToolCallLocation`, so no `permission.denied` could fire at
 * request time (EPIC-08-S11's third scenario, EPIC-08-S30).
 *
 * A **warning**, not a gate — D14 and §6.3 are explicit that a declared scope
 * is a prediction, not ground truth, so `paths` lands on the node without
 * touching its status. `declared` and `paths` travel separately, the same
 * reasoning as `PermissionDeniedSchema.declared`: two facts, not one
 * formatted sentence.
 */
export const NodeScopeWarningSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  /** The node's declared write globs, verbatim. */
  declared: z.array(z.string()),
  /** The changed paths, worktree-relative, that matched none of them.
   * Non-empty by construction: a clean diff never warns. */
  paths: z.array(z.string().min(1)).min(1),
});

/**
 * KAR-08.4 AC6 — a node declared a variable `buildChildEnv()` would otherwise
 * have scrubbed, and it reached the child. `name` only: this schema has no
 * `value` field to put one in, which is what makes "the value never enters
 * the ledger" a property of the shape rather than of a habit (15-security-
 * model.md §4.1).
 */
export const EnvDeclaredSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name'),
});

/**
 * KAR-08.8 — the two ways a node's provider auth can resolve
 * (docs/15-security-model.md §2.3). `subscription` is the default `buildChildEnv()`'s
 * allowlist already produces by dropping an `*_API_KEY`-shaped variable; `api_key`
 * is what a node gets only by explicitly opting in.
 */
export const PROVIDER_AUTH_MODES = ['subscription', 'api_key'] as const;

export type ProviderAuthMode = (typeof PROVIDER_AUTH_MODES)[number];

/**
 * KAR-08.8 AC1, AC2 — the effective auth mode of one provider on one node,
 * recorded so it is a fact the run report and cost report can read rather
 * than something the user has to infer from a bill (docs/15-security-
 * model.md §2.3). Written once per node attempt that routes to a provider
 * carrying an auth-shadowing variable (`packages/daemon/src/proc/auth-
 * shadow.ts`'s `AUTH_SHADOW_VARS`) — `subscription` when the shadowing
 * variable was stripped, `api_key` when the node explicitly selected it.
 */
export const ProviderAuthModeSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  provider: ProviderIdSchema,
  mode: z.enum(PROVIDER_AUTH_MODES),
});

/**
 * KAR-08.8 AC1 — `ANTHROPIC_API_KEY` (or another provider's equivalent) was
 * present in DeFlowd's own environment while the node was configured for
 * subscription auth, so `buildChildEnv()`'s allowlist dropped it and this is
 * the loud record of that: "the user thinks they are on their subscription;
 * they are being billed per token" (docs/15-security-model.md §2.3) is the
 * failure this event exists to make impossible.
 *
 * `variable` only, the same discipline as `EnvDeclaredSchema.name` above:
 * there is no `value` field to put one in, so "the value never enters the
 * ledger" is a property of the shape, not of a habit.
 */
export const ProviderAuthShadowStrippedSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  provider: ProviderIdSchema,
  variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name'),
});

/**
 * KAR-08.5 AC6 — a sandbox setting the installed vendor CLI is too old to
 * understand, omitted rather than emitted.
 *
 * An **event** rather than a log line, and the distinction is the whole point
 * (A5-1, rated High). Claude Code's sandbox settings are version-gated at fine
 * granularity and an unknown key is *ignored* rather than rejected, so a
 * policy the operator believes is in force can silently not be. Recording the
 * key, the version that was detected and the version it needs makes the gap
 * something the node inspector renders beside the permission level and the run
 * report can be read for — instead of something nobody finds out about.
 *
 * `key` is a settings path (`sandbox.network.strictAllowlist`), never prose:
 * it is what a reader searches the vendor's release notes for.
 */
export const SandboxDegradedSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  provider: ProviderIdSchema,
  /** The settings path that was left out, dotted. */
  key: z.string().regex(/^[a-z][A-Za-z0-9]*(\.[a-zA-Z][A-Za-z0-9]*)+$/, 'must be a settings path'),
  /** The vendor CLI version DeFlow detected — never assumed. */
  detected: singleLine(),
  /** The version the key was introduced in. */
  required: singleLine(),
});

/**
 * KAR-06.7 — the terminal record of an attempt the kill switch stopped.
 *
 * Its own kind rather than a `node.completed` carrying a cancelled result:
 * `node.completed`'s payload is `Extract<NodeResult, {status:'completed'}>`,
 * so recording a cancellation there would be a lie the ledger keeps for ever.
 * And its own kind rather than a `node.failed`, because a node the operator
 * stopped did not fail — the run's own history has to be able to tell "I
 * pressed the button" apart from "the agent crashed", which is the difference
 * between reading a timeline and guessing at one.
 */
export const NodeCancelledSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  result: CancelledNodeResultSchema,
});

/** The rungs of §11.1's escalation ladder, in the order they are climbed. */
export const CANCEL_STAGES = ['protocol', 'sigterm', 'sigkill', 'verified'] as const;

export type CancelStage = (typeof CANCEL_STAGES)[number];

/**
 * KAR-06.7 AC6 — one event per rung of the ladder, each naming the pid and the
 * **pgid**.
 *
 * Both, and not just the pid, because they are different claims: the pid is the
 * agent DeFlow spawned, and the pgid is the group every process it went on to
 * spawn shares. A timeline that recorded only the pid would say nothing about
 * what the signal actually reached, and the negative-pid form — the whole point
 * of `detached: true` — would be invisible to an operator reading afterwards.
 */
export const NodeCancelStageSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  stage: z.enum(CANCEL_STAGES),
  mode: z.enum(CANCEL_MODES),
  /** The agent's own pid, as recorded at spawn. */
  pid: z.number().int().positive(),
  /** The group that was signalled — `kill(-pgid, …)`, never `kill(pid, …)`. */
  pgid: z.number().int().positive(),
  /**
   * KAR-08.6 AC2 — milliseconds from the first rung to this one, on the
   * injected `Clock`.
   *
   * The ladder is a sequence of *deadlines* (5 s to SIGKILL, a further 2 s to
   * report), and the question an operator asks afterwards is never "which rungs
   * were climbed" but "where did the seven seconds go". A timeline that
   * recorded only the rung leaves them subtracting wall-clock timestamps that
   * belong to whichever clock happened to be injected; this is the elapsed time
   * the ladder itself measured.
   */
  elapsedMs: nonNegativeInt,
});

/**
 * KAR-06.7 AC8 — a kill that did not take is an event, not a silent condition.
 *
 * `survivors` is the evidence and the reason this is typed rather than a log
 * line: an operator whose kill switch failed needs the pids to go and look at,
 * and a future reader needs to know the run stopped admitting work because
 * something out there is still running, not because it finished.
 */
export const NodeCancelFailedSchema = z.strictObject({
  node: NodeIdSchema,
  attempt,
  pid: z.number().int().positive(),
  pgid: z.number().int().positive(),
  /** Non-`Z` members of the group still present after the last rung. Zombies
   * are excluded: they are already dead and counting them reports a working
   * kill as a failure (§11.2). */
  survivors: z.array(z.number().int().positive()).min(1),
});

/**
 * KAR-08.6 AC6 — the operator's kill switch, when it did not take.
 *
 * The run-scoped counterpart of `node.cancel.failed`: the kill switch stops
 * *every* attempt in a run, so the thing an operator needs is one record naming
 * everything that outlived it, across nodes, rather than a record per node they
 * have to assemble themselves. It is the event the UI surfaces, and its
 * presence is what stops a run reading as cleanly stopped while children of it
 * are still running (EPIC-08-S29).
 *
 * `stat` travels with each pid because "pid 4244 survived" invites a bug report
 * and "pid 4244 survived in state `D`" says why SIGKILL did not land —
 * uninterruptible in a syscall is not a DeFlow bug and is not fixable by
 * signalling harder. `Z` never appears here: a zombie is already dead, and
 * counting one reports a working kill as a failure (§11.2).
 */
export const RunKillFailedSchema = z.strictObject({
  survivors: z
    .array(
      z.strictObject({
        /** The node whose attempt was being stopped. */
        node: NodeIdSchema,
        attempt,
        /** The process still running — the thing an operator goes and looks at. */
        pid: z.number().int().positive(),
        /** The group that was signalled, and did not empty. */
        pgid: z.number().int().positive(),
        /** Its `ps` `STAT` column, never `Z`. */
        stat: singleLine(),
      }),
    )
    .min(1),
});

// ── workspace isolation ──────────────────────────────────────────────────────

/**
 * A worktree existing is a **domain fact**, not a log line
 * (docs/09-workspace-and-safety.md §4.1, KAR-07.2).
 *
 * `detached` and `branch` move together and are both stated: a read node gets
 * `--detach` and no branch at all, which is what sidesteps branch uniqueness
 * for it, and a reader who saw only `branch: null` could not tell that from a
 * write node whose branch record was lost. `lockReason` is git's own — the same
 * string `worktree list --porcelain` reports back — so the event and the
 * repository can be compared without a translation step.
 */
export const WorkspaceWorktreeCreatedSchema = z.strictObject({
  node: NodeIdSchema,
  path: z.string().min(1),
  /** `null` exactly when `detached` is true. */
  branch: z.string().min(1).nullable(),
  /** What the worktree started from. Never checked out as a branch. */
  baseRef: z.string().min(1),
  detached: z.boolean(),
  lockReason: z.string().min(1),
});

/**
 * The refusal that happens **before** `git worktree add` runs (§3.1).
 *
 * There is no `stderr` field, on purpose. The real message is
 * `fatal: '<branch>' is already used by worktree at '<path>'` — not the
 * widely-quoted `already checked out at` — and recording git's wording here
 * would invite the next reader to start matching on it. `occupiedBy` is the
 * path the porcelain list gave, which is the same answer without the
 * dependency on a message that is one git release from changing.
 */
export const WorkspaceBranchOccupiedSchema = z.strictObject({
  node: NodeIdSchema,
  branch: z.string().min(1),
  occupiedBy: z.string().min(1),
  occupantKind: z.enum(WORKTREE_OCCUPANT_KINDS),
});

/**
 * One `.worktreeinclude` file copied into a fresh worktree
 * (§5.1 Layer 1, KAR-07.5 AC2).
 *
 * **The path, and never the contents.** The whole point of this layer is that
 * `.env`-shaped files reach the agent's worktree, so by construction every
 * event here names a file that probably holds a credential. A `strictObject`
 * is what makes "no contents field" enforceable rather than a convention: a
 * payload that grew a `contents` key would be refused at the append boundary.
 *
 * `mode` is the *source's* mode in octal (`'0600'`), recorded because AC2's
 * guarantee is that the copy did not widen it — the assertion needs the number
 * it was compared against to be in the ledger too.
 */
export const WorkspaceIncludedFileSchema = z.strictObject({
  node: NodeIdSchema,
  /** Repo-relative, as `git ls-files` reported it. */
  path: z.string().min(1),
  /** Four-digit octal, e.g. `'0600'`. */
  mode: z.string().regex(/^[0-7]{4}$/),
});

/**
 * `workspace.setup` was skipped because its inputs are unchanged
 * (§5.1 Layer 3, KAR-07.5 AC5).
 *
 * `key` is the marker: the sha256 of the `setupCacheKey` files' contents, so a
 * lockfile that changes and changes back is correctly a hit, where a timestamp
 * or a boolean would have been a miss or a lie respectively. `files` is what
 * went into it, in the order the config declared, because "why was this a hit"
 * is unanswerable from a hash alone.
 */
export const WorkspaceSetupCacheHitSchema = z.strictObject({
  node: NodeIdSchema,
  key: Sha256Schema,
  files: z.array(z.string().min(1)),
});

/** One entry of `git status --porcelain=v2 -z`, as the salvage path parsed it.
 * `origPath` is set only for a rename or a copy, and `xy` is `null` for an
 * untracked or ignored entry, because git prints those without a code. */
export const WorkspaceStatusEntrySchema = z.strictObject({
  kind: z.enum(['changed', 'renamed', 'unmerged', 'untracked', 'ignored']),
  xy: z.string().min(1).nullable(),
  path: z.string().min(1),
  origPath: z.string().min(1).nullable(),
});

/**
 * What the agent left behind, captured **before** anything was committed or
 * removed (§4.4, KAR-07.4 AC1).
 *
 * This is the evidence, and its position in the ledger is half of what it says:
 * it is appended off the `status --porcelain=v2 -z` read alone, while the
 * worktree is still dirty and still on disk, so a reader can tell that DeFlow
 * looked before it acted. A summary written after the salvage commit would be
 * indistinguishable from one written after a blind `--force`.
 */
export const WorkspaceDirtyOnRemoveSchema = z.strictObject({
  node: NodeIdSchema,
  path: z.string().min(1),
  /** Non-empty by construction: a clean worktree never produces this event —
   * which is also why a worktree holding only gitignored files does not (AC5). */
  entries: z.array(WorkspaceStatusEntrySchema).min(1),
});

/**
 * The work is now recoverable by ref (§4.4 step 2, KAR-07.4 AC2).
 *
 * `oid` is the whole point: `--force` becomes acceptable only once this event
 * is durable, so this row is the precondition of the removal that follows it,
 * not a note about one. `branch` is where the commit actually landed — the
 * node's own branch normally, and a throwaway `DeFlow/salvage/<runId>__<nodeId>`
 * when `detached` is true, because a detached read-node checkout has no branch
 * for a commit to advance.
 */
export const WorkspaceWipSalvagedSchema = z.strictObject({
  node: NodeIdSchema,
  path: z.string().min(1),
  branch: z.string().min(1),
  detached: z.boolean(),
  oid: z.string().regex(/^[0-9a-f]{40,64}$/),
  /** How many status entries the commit swept up. */
  files: z.number().int().nonnegative(),
});

/**
 * Removing the worktree must never remove the work (§4.4, F5.5).
 *
 * `tipOid` is the point: the branch is the deliverable and it outlives its
 * worktree, so the tip recorded here is what the integration loop merges later
 * — and what makes a removal auditable without re-reading the repository.
 */
export const WorkspaceWorktreeRemovedSchema = z.strictObject({
  node: NodeIdSchema,
  path: z.string().min(1),
  /** `null` for a read node's detached checkout, which produced no branch. */
  branch: z.string().min(1).nullable(),
  /** `null` when the branch had no commits, or for a detached checkout. */
  tipOid: z
    .string()
    .regex(/^[0-9a-f]{40,64}$/)
    .nullable(),
});

/**
 * The `worktrees` projection caught up with git (§4.3).
 *
 * "Git is the authority; SQLite is an index over it." The moment an operator
 * runs `git worktree remove` in their own terminal — and they will — a
 * SQLite-authoritative design is wrong and does not know it. This event is what
 * a reconcile looks like when it is a normal, expected, non-error outcome:
 * three lists, no failure, no run touched.
 */
export const WorkspaceReconciledSchema = z.strictObject({
  /** Paths git reports that the projection had not seen. */
  added: z.array(z.string().min(1)),
  /** Paths the projection held that git no longer reports. */
  removed: z.array(z.string().min(1)),
  /** Paths git still lists but marks `prunable` — scheduled for the next reap,
   * never treated as live. */
  prunable: z.array(z.string().min(1)),
});

/**
 * A recorded pid is alive, and it is **not ours** (§11.3 step 1, KAR-07.8 AC2).
 *
 * The one event whose whole content is a refusal. The pid in the row exists, so
 * a reaper that checked bare liveness would have signalled it; the start time
 * the OS reports for it is not the one recorded at spawn, so the number has
 * been recycled and the process behind it belongs to somebody else — a browser,
 * a build, an editor. Both times travel in the payload because "we did not kill
 * this" is only a defensible decision if the evidence for it is readable
 * afterwards.
 *
 * The values are opaque strings, straight from `ps -o lstart=` or
 * `/proc/<pid>/stat` field 22, and are only ever compared for equality.
 * Normalising them into timestamps would invent precision the source does not
 * have, and a comparison that is nearly right is exactly what kills a
 * stranger's process.
 *
 * The worktree the row named is still unlocked and still cleaned up: the run
 * that owned it is over either way, and a lock nobody releases is a worktree
 * `prune` will refuse to touch for ever.
 */
export const WorkspacePidRecycledSchema = z.strictObject({
  node: NodeIdSchema,
  pid: z.number().int().positive(),
  /** The start time recorded at spawn. `null` when it could never be read,
   * which is treated the same way — unverifiable is not killable. */
  recorded: z.string().min(1).nullable(),
  /** What the OS says now about that pid. */
  observed: z.string().min(1).nullable(),
});

/**
 * A worktree whose owning process did not survive the restart is gone
 * (§4.5, §11.3 steps 3–4, KAR-07.8 AC5).
 *
 * Emitted after `unlock` and `remove -f -f`, in that order and only once the
 * owner is *provably* gone — pid **and** recorded process start time, never
 * bare liveness. The branch is untouched, because the branch is the deliverable
 * (F5.5) and this event is about reclaiming a checkout, not discarding work.
 *
 * `pid` is `null` when no `process` row was ever written for the node — a
 * worktree provisioned by a daemon that died before it spawned the agent, which
 * is a real crash window and not an error.
 */
export const WorkspaceOrphanReapedSchema = z.strictObject({
  node: NodeIdSchema,
  path: z.string().min(1),
  pid: z.number().int().positive().nullable(),
});

/**
 * The integration loop re-sorted its merge queue (§7.1, KAR-07.7 AC3).
 *
 * Re-sorting is not an optimisation: a merge changes every remaining branch's
 * conflict count against the integration branch, so an order computed once is
 * stale the instant the first branch lands. `before` and `after` are both
 * recorded because a reordering nobody can see is indistinguishable from an
 * order that never changed — this is what puts the decision in the run
 * timeline instead of inside the scheduler's head.
 *
 * Emitted after **every** merge, including one that empties the queue, which
 * is what makes "what is left to merge" answerable from the newest such event
 * alone rather than by replaying merges against a starting order.
 */
export const WorkspaceMergeQueueReorderedSchema = z.strictObject({
  /** `DeFlow/int/<runId>` — the branch the queue is ordered against. */
  branch: z.string().min(1),
  /** The node whose merge invalidated the previous order. */
  mergedNode: NodeIdSchema,
  /** The queue as it stood, minus the branch that has just merged. */
  before: z.array(NodeIdSchema),
  /** The queue after re-probing every remaining branch against the new tip. */
  after: z.array(NodeIdSchema),
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

/**
 * KAR-06.7 AC9 — an effect closed because the attempt that journalled it was
 * cancelled.
 *
 * Its own kind rather than an `effect.failed`, for the reason `node.cancelled`
 * is its own kind: `effect.failed` carries a `NodeFailure`, whose `reason` is a
 * closed set describing ways work *goes wrong*, and an operator pressing stop
 * is not one of them. Forcing it into that union would either invent a reason
 * for every terminal state or file the kill switch under "something broke".
 *
 * The row still moves to `failed` — the journal has three states and this is
 * not a success — but what it stores is the `NodeResult` the node itself got.
 * The point of closing it at all is that a `pending` row is how the next daemon
 * life recognises "we died mid-effect" and asks a human to reconcile it; there
 * is nothing to reconcile about an effect somebody deliberately stopped.
 */
export const EffectCancelledSchema = z.strictObject({
  ikey: IkeySchema,
  result: CancelledNodeResultSchema,
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
 * `after` must be `null` and `droppedSegments` must be `[]`. Supplying either
 * of them under `partial` is the fabrication this discriminator exists to
 * prevent (AC6, EPIC-02-S23).
 *
 * The type-level half of the same rule — that no code path can *construct* a
 * `vendor.session` event with `fidelity: 'exact'` — is `Compaction` in
 * ./compaction.ts, which is what a producer builds these payloads through.
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
      // `originalHandle` is deliberately *not* constrained here. KAR-02.7 AC6
      // constrains the two fields a chart would fabricate — `after` and
      // `droppedSegments` — and this one is not vendor-reported at all:
      // KAR-09.6 AC6's transcript snapshot is a file DeFlow copies into the
      // run's artifact store itself on receiving the boundary frame, so a
      // handle here is a fact about DeFlow's own filesystem rather than a
      // claim about what the vendor dropped. It stays nullable because that
      // path is Unverified — a missing file is `null`, never an error.
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

/**
 * KAR-10.4 AC5 — v2: the verdict now names the contract it judged.
 *
 * The change is entirely inside `verdict`, which became `DeFlow.verdict.v2` —
 * one optional field, `specHash`. See `schemas/CHANGELOG.md` for why the hop
 * from v1 leaves it absent rather than inventing one, and `VerdictV2Schema` for
 * why an absent hash is treated as void rather than as trusted.
 */
export const GateEvaluatedSchema = z.strictObject({
  gate: GateIdSchema,
  node: NodeIdSchema,
  verdict: VerdictV2Schema,
});

export const HumanRequestedSchema = z.strictObject({
  node: NodeIdSchema,
  prompt: z.string().min(1),
  /** The same option vocabulary a `human` node declares (§3). */
  options: HumanNodeSchema.shape.options,
  deadline: HumanNodeSchema.shape.deadline,
  /**
   * KAR-08.3 AC8 — why the safety layer escalated, as a `PermissionReason`.
   *
   * Absent for the escalations that are not a permission decision at all: a
   * `human` node's own prompt, a verification gate that ran out of attempts, a
   * clarifying question. Present, it is what the approval queue groups by and
   * what the §10.5 gate budget counts — the prompt above is for the operator
   * to read, and reading is not something a budget assertion can do.
   */
  reason: PermissionDeniedSchema.shape.reason.optional(),
});

export const HumanRespondedSchema = z.strictObject({
  node: NodeIdSchema,
  optionId: z.string().min(1),
  text: z.string().optional(),
  /** Display only — ordering is by `seq`, never by this timestamp. */
  at: z.iso.datetime(),
});

// ── money and providers ──────────────────────────────────────────────────────

/**
 * KAR-14.3 AC8 — the pre-flight figure an attempt was admitted on, as it
 * travels on the accounting record.
 *
 * Every field is one the reconciliation needs and none of them is derivable
 * afterwards: `inputTokens` is what the actual is measured against, and the
 * factor, the sample count and the method are what say whether a wrong estimate
 * was a wrong *guess* (a family seed, `samples < 5`) or a wrong *measurement*.
 * `costUsd` is nullable for the same reason the record's own is: a turn nobody
 * could price was estimated at nothing knowable, not at zero.
 */
export const PreflightEstimateSchema = z.strictObject({
  costUsd: z.number().nonnegative().nullable(),
  inputTokens: nonNegativeInt,
  method: TokenCountMethodSchema,
  tokenEstimateFactor: z.number().positive(),
  samples: nonNegativeInt,
  seedBased: z.boolean(),
});

/**
 * F9.1 — the single accounting record (KAR-14.1). **v3.**
 *
 * Self-contained on purpose: everything the per-node, per-provider and
 * per-run rollup needs is in this one payload, so the projection is a fold
 * over one kind rather than a join across three that can arrive out of order.
 *
 * Two fields carry the whole of the story's honesty.
 *
 * `costUsd` is **nullable**, and that is the difference between a report and a
 * lie. A provider whose capability manifest says `tokenAccounting: 'none'`
 * cannot be priced, and `0` would be a claim that nothing was spent
 * (docs/08-context-and-memory.md §7: *a blank cost cell, not a zero*). A `null`
 * here is what puts the provider into the rollup's `unaccounted` list.
 *
 * `authMode` is here rather than inferred from the separate
 * `provider.auth_mode` event because §12 of docs/07-provider-adapter-layer.md
 * makes subscription-quota spend and real-currency spend two different
 * substances that *"must not be summed into one number"* — and a rollup that
 * had to correlate two event kinds to know which was which would report the
 * wrong one for any event pair the ledger happened to interleave.
 */
export const BudgetConsumedSchema = z.strictObject({
  /** Absent for run-level consumption that no single node owns. */
  node: NodeIdSchema.optional(),
  /** Which attempt spent it, 0-based. Absent exactly when `node` is. */
  attempt: attempt.optional(),
  provider: ProviderIdSchema,
  usage: TokenUsageSchema,
  /** `null` when the provider reports nothing machine-readable — never `0`. */
  costUsd: z.number().nonnegative().nullable(),
  /** KAR-08.8's effective auth mode for this spend. */
  authMode: z.enum(PROVIDER_AUTH_MODES),
  /**
   * KAR-14.3 AC8 — what this attempt was estimated to cost, before it ran.
   *
   * Optional, because an attempt admitted before the estimator existed — or by
   * a caller that has no tokenizer — genuinely has no such figure, and a
   * fabricated one would corrupt the accuracy it exists to measure. Present, it
   * is what makes the estimate and the actual reconcilable without a join.
   */
  estimate: PreflightEstimateSchema.optional(),
});

/**
 * KAR-14.2 AC7 — KAR-14.1's rollup breakdown, travelling with a ceiling trip.
 *
 * It exists so an operator looking at a paused run can see *what stopped it*.
 * A pause driven wholly by DeFlow's own Tier-2 estimate — which carries a known
 * 15–20% undercount on prose and worse on code — is a different conversation
 * from one driven by a figure the vendor billed, and the two are
 * indistinguishable from the `actual` alone.
 *
 * `authMode` names which substance crossed, because there is no total: §12 of
 * docs/07-provider-adapter-layer.md keeps subscription quota and real currency
 * apart, so a ceiling is evaluated against each and the trip says which one it
 * was.
 */
export const BudgetBasisSchema = z.strictObject({
  authMode: z.enum(PROVIDER_AUTH_MODES),
  vendorReported: z.number().nonnegative().nullable(),
  estimated: z.number().nonnegative().nullable(),
  /** No vendor-reported figure contributed to the trip at all. */
  estimateDriven: z.boolean(),
  /** Providers that spent something nobody could price (KAR-14.1). */
  unaccounted: z.array(ProviderIdSchema),
});

export type BudgetBasis = z.infer<typeof BudgetBasisSchema>;

/**
 * F4.6 — the ceiling that pauses the run rather than failing it. **v2.**
 *
 * `failureClass` is a field rather than an assumption because AC2 is a claim
 * about the ledger: *"the failure class recorded is `gate`"*. The schema
 * refuses `permanent` and `transient` outright, which is the same discipline
 * `NodeFailureSchema` applies to the three gate-only reasons — a ceiling that
 * could be recorded as `transient` is a ceiling something downstream would
 * retry into, spending the remaining allowance discovering the same wall.
 *
 * `firedBy` distinguishes DeFlow's own admission check from the vendor's ceiling
 * below it (`--max-budget-usd`, AC9). Both pause the run identically; which one
 * fired is the difference between raising DeFlow's ceiling and raising the
 * vendor's, and an operator cannot guess it from the numbers.
 *
 * `basis` is KAR-14.1's rollup breakdown travelling with the trip (AC7), so a
 * pause caused wholly by DeFlow's own Tier-2 estimate says so wherever it is
 * displayed. Absent for a wall-clock trip: there is no money to attribute.
 */
export const BudgetExceededSchema = z
  .strictObject({
    scope: z.enum(BUDGET_SCOPES),
    /** Present exactly when `scope` is `node`. */
    node: NodeIdSchema.optional(),
    dimension: z.enum(BUDGET_DIMENSIONS),
    limit: z.number().nonnegative(),
    actual: z.number().nonnegative(),
    failureClass: FailureClassSchema,
    firedBy: z.enum(BUDGET_CEILING_OWNERS),
    basis: BudgetBasisSchema.optional(),
  })
  .superRefine((payload, ctx) => {
    if (payload.failureClass !== 'gate') {
      ctx.addIssue({
        code: 'custom',
        path: ['failureClass'],
        message:
          'a budget breach pauses for a human decision: failureClass must be "gate", not ' +
          `"${payload.failureClass}"`,
      });
    }
    if ((payload.scope === 'node') !== (payload.node !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['node'],
        message: 'a node-scoped breach names its node, and a run-scoped one names none',
      });
    }
  });

/**
 * KAR-14.2 AC1 — the effective ceiling, pinned in the log.
 *
 * Appended beside `run.created` from `POST /api/runs`'s `budget` block over
 * `.DeFlow/config.yaml`'s defaults, and again with `source: 'operator'` when a
 * paused run's ceiling is raised. Both are the same event because both are the
 * same fact: *this is the ceiling in force from this seq onwards*.
 *
 * It is an event rather than config read per tick for the reason F4.4 makes
 * pause an event — a ceiling that lived in a file could be edited mid-run and
 * would silently change what a running run is measured against, and a raised
 * ceiling that lived in memory would not survive the restart that follows the
 * pause it was raised to answer.
 *
 * `hash` is the sha256 of the effective ceiling document at the moment it was
 * set, so a later reader can tell a run whose config file has since been edited
 * from one whose has not.
 */
export const BudgetCeilingSetSchema = z
  .strictObject({
    scope: z.enum(BUDGET_SCOPES),
    /** A node-scoped ceiling for one node; absent sets the default every node
     * inherits, which is how `.DeFlow/config.yaml` expresses a per-node cap. */
    node: NodeIdSchema.optional(),
    /** `null` is "no ceiling in this dimension", never `0`. */
    costUsd: z.number().nonnegative().nullable(),
    wallclockMs: z.number().int().nonnegative().nullable(),
    source: z.enum(['request', 'config', 'operator']),
    hash: Sha256Schema,
  })
  .superRefine((payload, ctx) => {
    if (payload.scope === 'run' && payload.node !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['node'],
        message: 'a run-scoped ceiling names no node',
      });
    }
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
  'task.submitted': { v: 1, payload: TaskSubmittedSchema },
  'run.created': { v: 1, payload: RunCreatedSchema },
  'run.spec.approved': { v: 1, payload: RunSpecApprovedSchema },
  'spec.amended': { v: 1, payload: SpecAmendedSchema },
  'spec.pinned': { v: 1, payload: SpecPinnedSchema },
  'run.started': { v: 1, payload: RunStartedSchema },
  'run.paused': { v: 1, payload: RunPauseToggledSchema },
  'run.resumed': { v: 1, payload: RunPauseToggledSchema },
  'run.cancel.requested': { v: 1, payload: RunCancelRequestedSchema },
  'run.completed': { v: 1, payload: RunEndedSchema },
  'run.aborted': { v: 1, payload: RunEndedSchema },
  'run.stalled': { v: 1, payload: RunStalledSchema },
  'run.kill_failed': { v: 1, payload: RunKillFailedSchema },
  'run.needs_human': { v: 2, payload: RunNeedsHumanSchema },
  'plan.proposed': { v: 1, payload: PlanProposedSchema },
  'plan.patch.proposed': { v: 2, payload: PlanPatchProposedSchema },
  'plan.patched': { v: 1, payload: PlanPatchedSchema },
  'plan.patch.rejected': { v: 1, payload: PlanPatchRejectedSchema },
  'node.scheduled': { v: 1, payload: NodeScheduledSchema },
  'node.lock.acquired': { v: 1, payload: NodeLockSchema },
  'node.lock.released': { v: 1, payload: NodeLockReleasedSchema },
  'node.started': { v: 1, payload: NodeStartedSchema },
  'node.progress': { v: 1, payload: NodeProgressSchema },
  'node.completed': { v: 1, payload: NodeCompletedSchema },
  'node.failed': { v: 1, payload: NodeFailedSchema },
  'node.retry.scheduled': { v: 1, payload: NodeRetryScheduledSchema },
  'node.suspended': { v: 1, payload: NodeSuspendedSchema },
  'node.blocked': { v: 1, payload: NodeBlockedSchema },
  'node.unschedulable': { v: 1, payload: NodeUnschedulableSchema },
  'permission.denied': { v: 1, payload: PermissionDeniedSchema },
  'node.scope_warning': { v: 1, payload: NodeScopeWarningSchema },
  'env.declared': { v: 1, payload: EnvDeclaredSchema },
  'provider.auth_mode': { v: 1, payload: ProviderAuthModeSchema },
  'provider.auth_shadow_stripped': { v: 1, payload: ProviderAuthShadowStrippedSchema },
  'sandbox.degraded': { v: 1, payload: SandboxDegradedSchema },
  'node.cancelled': { v: 1, payload: NodeCancelledSchema },
  'node.cancel.stage': { v: 1, payload: NodeCancelStageSchema },
  'node.cancel.failed': { v: 1, payload: NodeCancelFailedSchema },
  'workspace.worktree_created': { v: 1, payload: WorkspaceWorktreeCreatedSchema },
  'workspace.branch_occupied': { v: 1, payload: WorkspaceBranchOccupiedSchema },
  'workspace.included_file': { v: 1, payload: WorkspaceIncludedFileSchema },
  'workspace.setup_cache_hit': { v: 1, payload: WorkspaceSetupCacheHitSchema },
  'workspace.dirty_on_remove': { v: 1, payload: WorkspaceDirtyOnRemoveSchema },
  'workspace.wip_salvaged': { v: 1, payload: WorkspaceWipSalvagedSchema },
  'workspace.worktree_removed': { v: 1, payload: WorkspaceWorktreeRemovedSchema },
  'workspace.reconciled': { v: 1, payload: WorkspaceReconciledSchema },
  'workspace.pid_recycled': { v: 1, payload: WorkspacePidRecycledSchema },
  'workspace.orphan_reaped': { v: 1, payload: WorkspaceOrphanReapedSchema },
  'workspace.merge_queue_reordered': { v: 1, payload: WorkspaceMergeQueueReorderedSchema },
  'effect.started': { v: 1, payload: EffectStartedSchema },
  'effect.completed': { v: 1, payload: EffectCompletedSchema },
  'effect.failed': { v: 1, payload: EffectFailedSchema },
  'effect.cancelled': { v: 1, payload: EffectCancelledSchema },
  'context.built': { v: 1, payload: ContextBuiltSchema },
  'context.compacted': { v: 1, payload: ContextCompactedSchema },
  'pin.integrity_violated': { v: 1, payload: PinIntegrityViolatedSchema },
  'fact.written': { v: 1, payload: FactWrittenSchema },
  'fact.read': { v: 1, payload: FactReadSchema },
  'fact.invalidated': { v: 1, payload: FactInvalidatedSchema },
  'handoff.oversize': { v: 1, payload: HandoffOversizeSchema },
  'gate.evaluated': { v: 2, payload: GateEvaluatedSchema },
  'human.requested': { v: 1, payload: HumanRequestedSchema },
  'human.responded': { v: 1, payload: HumanRespondedSchema },
  'budget.consumed': { v: 3, payload: BudgetConsumedSchema },
  'budget.exceeded': { v: 2, payload: BudgetExceededSchema },
  'budget.ceiling.set': { v: 1, payload: BudgetCeilingSetSchema },
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
