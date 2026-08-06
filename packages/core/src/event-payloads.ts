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
import {
  CancelledNodeResultSchema,
  CompletedNodeResultSchema,
  NodeSuspensionSchema,
} from './node-result.ts';
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

export const EXPORT_TARGETS = ['report', 'hub'] as const;

export const EXPORT_BLOCK_REASONS = ['redaction-failed', 'findings'] as const;

export type RunOutcome = (typeof RUN_OUTCOMES)[number];
export type EffectKind = (typeof EFFECT_KINDS)[number];
export type CompactionFidelity = (typeof COMPACTION_FIDELITIES)[number];
export type WorktreeOccupantKind = (typeof WORKTREE_OCCUPANT_KINDS)[number];

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
  'node.lock.released': { v: 1, payload: NodeLockReleasedSchema },
  'node.started': { v: 1, payload: NodeStartedSchema },
  'node.progress': { v: 1, payload: NodeProgressSchema },
  'node.completed': { v: 1, payload: NodeCompletedSchema },
  'node.failed': { v: 1, payload: NodeFailedSchema },
  'node.retry.scheduled': { v: 1, payload: NodeRetryScheduledSchema },
  'node.suspended': { v: 1, payload: NodeSuspendedSchema },
  'node.blocked': { v: 1, payload: NodeBlockedSchema },
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
