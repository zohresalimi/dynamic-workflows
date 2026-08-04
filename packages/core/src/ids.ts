/**
 * KAR-02.1 — identifier types and the stable-NodeId invariant.
 *
 * Implements docs/04-domain-model.md §1. Identifiers are branded strings, not
 * opaque objects: they must survive a JSON round trip, live in a SQLite
 * `TEXT` column, be greppable in a log, and — for `RunId` and `NodeId` — be
 * legal path segments, because §9.4 of the PRD puts them in directory names.
 *
 * `NodeId` in particular is load-bearing (§1.1): the effect journal's
 * idempotency key is `(runId, nodeId, attempt, ordinal)`, and the
 * plan-evolution scrubber's cross-version node identity is `NodeId` and
 * nothing else. Either consumer breaks silently, and undetectably after the
 * fact, if an id moves — which is why the rule is enforced here at the
 * schema boundary rather than left to convention:
 *
 *   A PlanPatch may change anything about a node except its id. Structural
 *   operations that genuinely destroy a node (split, abandon) *retire* the id
 *   instead — see `NodeIdRegistry` in ./node-id-registry.ts — rather than
 *   deleting or reusing it.
 *
 * Verifies: EPIC-02-S1, EPIC-02-S5 · AC1, AC2, AC3, AC6 (lifecycle vocabulary)
 */
import { z } from 'zod';

/** A nominal-typed string or number: `T` at runtime, `T` tagged with `B` at
 * the type level so `RunId` and `NodeId` cannot be silently interchanged
 * even though both are plain strings on the wire. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

export type RunId = Brand<string, 'RunId'>;
export type NodeId = Brand<string, 'NodeId'>;
export type PlanHash = Brand<string, 'PlanHash'>;
export type FactId = Brand<string, 'FactId'>;
export type Handle = Brand<string, 'Handle'>;
export type EventSeq = Brand<number, 'EventSeq'>;
/**
 * `IdempotencyKey` deliberately has no exported schema for parsing a free
 * string into one (AC4) — the type is here for other modules to reference,
 * but the only legal constructor is `ikey()` in ./ikey.ts.
 */
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>;
export type SchemaId = Brand<string, 'SchemaId'>;
/** 'claude-code' | 'codex' | … — discovered at runtime, not a closed set. */
export type ProviderId = Brand<string, 'ProviderId'>;
export type GateId = Brand<string, 'GateId'>;
export type CriterionId = Brand<string, 'CriterionId'>;
export type SegmentId = Brand<string, 'SegmentId'>;

/**
 * A node whose lifecycle is `'superseded'` or `'abandoned'` stays present in
 * the graph — it is never deleted — and its id is never reallocated. See
 * `NodeIdRegistry` for the enforcement.
 */
export type NodeLifecycle = 'active' | 'superseded' | 'abandoned';

export const NodeLifecycleSchema: z.ZodType<NodeLifecycle> = z.enum([
  'active',
  'superseded',
  'abandoned',
]);

/**
 * §1: `/^[a-z0-9][a-z0-9-]{0,62}$/` — lowercase kebab, 1–63 characters,
 * starting alphanumeric. Uppercase is rejected outright (not fussiness):
 * `.DeFlow/wt/<runId>__<nodeId>` is a real worktree path, and a
 * case-insensitive filesystem could collide two ids differing only in case.
 */
const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

export const NodeIdSchema: z.ZodType<NodeId, string> = z
  .string()
  .regex(NODE_ID_PATTERN, `NodeId must match ${NODE_ID_PATTERN}`)
  .transform((value): NodeId => value as NodeId);

/**
 * `run_20260802T141133Z_9f2a1c` — timestamp before the random suffix, on
 * purpose, so plain string comparison sorts `RunId`s in creation order and
 * `ls .DeFlow/runs/` reads chronologically. See ./run-id.ts for the minter.
 */
const RUN_ID_PATTERN = /^run_\d{8}T\d{6}Z_[0-9a-f]{6}$/;

export const RunIdSchema: z.ZodType<RunId, string> = z
  .string()
  .regex(RUN_ID_PATTERN, `RunId must match ${RUN_ID_PATTERN}`)
  .transform((value): RunId => value as RunId);

const PLAN_HASH_PATTERN = /^sha256-[0-9a-f]{64}$/;

export const PlanHashSchema: z.ZodType<PlanHash, string> = z
  .string()
  .regex(PLAN_HASH_PATTERN, `PlanHash must match ${PLAN_HASH_PATTERN}`)
  .transform((value): PlanHash => value as PlanHash);

const FACT_ID_PATTERN = /^fact_[a-z0-9]{26}$/;

export const FactIdSchema: z.ZodType<FactId, string> = z
  .string()
  .regex(FACT_ID_PATTERN, `FactId must match ${FACT_ID_PATTERN}`)
  .transform((value): FactId => value as FactId);

/**
 * §1: `artifact://<64 hex sha256>` (content-addressed, immutable by
 * construction) or `file://<repo-relative path>#L12-L40`. The `file://` arm
 * must never carry an absolute path — `(?!/)` right after the scheme is what
 * enforces that.
 */
const ARTIFACT_HANDLE_PATTERN = /^artifact:\/\/[0-9a-f]{64}$/;
const FILE_HANDLE_PATTERN = /^file:\/\/(?!\/)[^\s#]+#L\d+-L\d+$/;

export const HandleSchema: z.ZodType<Handle, string> = z
  .string()
  .refine(
    (value) => ARTIFACT_HANDLE_PATTERN.test(value) || FILE_HANDLE_PATTERN.test(value),
    `Handle must match ${ARTIFACT_HANDLE_PATTERN} or ${FILE_HANDLE_PATTERN}`,
  )
  .transform((value): Handle => value as Handle);

export const EventSeqSchema: z.ZodType<EventSeq, number> = z
  .number()
  .int()
  .positive()
  .transform((value): EventSeq => value as EventSeq);

const SCHEMA_ID_PATTERN = /^[A-Za-z][\w.-]*\.v\d+$/;

export const SchemaIdSchema: z.ZodType<SchemaId, string> = z
  .string()
  .regex(SCHEMA_ID_PATTERN, `SchemaId must match ${SCHEMA_ID_PATTERN}`)
  .transform((value): SchemaId => value as SchemaId);

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export const ProviderIdSchema: z.ZodType<ProviderId, string> = z
  .string()
  .regex(PROVIDER_ID_PATTERN, `ProviderId must match ${PROVIDER_ID_PATTERN}`)
  .transform((value): ProviderId => value as ProviderId);

/**
 * Gate, criterion and segment ids reuse the `NodeId` slug format: a gate is a
 * node (§3), and the architecture names no other constraint for criterion or
 * segment ids beyond "an id".
 */
export const GateIdSchema: z.ZodType<GateId, string> = z
  .string()
  .regex(NODE_ID_PATTERN, `GateId must match ${NODE_ID_PATTERN}`)
  .transform((value): GateId => value as GateId);

export const CriterionIdSchema: z.ZodType<CriterionId, string> = z
  .string()
  .regex(NODE_ID_PATTERN, `CriterionId must match ${NODE_ID_PATTERN}`)
  .transform((value): CriterionId => value as CriterionId);

export const SegmentIdSchema: z.ZodType<SegmentId, string> = z
  .string()
  .regex(NODE_ID_PATTERN, `SegmentId must match ${NODE_ID_PATTERN}`)
  .transform((value): SegmentId => value as SegmentId);
