/**
 * KAR-02.10 — the closed failure taxonomy and the single boundary between
 * "code that throws" and "the ledger".
 *
 * Implements docs/04-domain-model.md §8. Every failure must be serialisable
 * into the ledger and renderable in the node inspector, and a thrown `Error`
 * with a V8 stack is neither: it does not survive `JSON.stringify`, it does
 * not survive a daemon restart, its `message` is unstructured, and the
 * inspector can do nothing with it but print it in a monospace box. So a
 * failure is a value in a closed union, and `toNodeFailure` — this module's
 * whole reason to exist — is the one place a throw becomes one.
 *
 * Two rules from §8 that matter more than they look:
 *
 *   1. `class` is **not** derived from `reason`. The same reason is transient
 *      or permanent depending on the situation — `provider.unavailable` is
 *      transient for a rate-limited vendor and permanent for a binary the user
 *      uninstalled mid-run — so the class is assigned where the failure is
 *      constructed, by the code that knows which situation it is in. The
 *      scheduler then reads `class` and nothing else. There is deliberately no
 *      `classify(reason)` anywhere in this package; `packages/core/test/
 *      failure-taxonomy.test.ts` keeps it that way.
 *   2. `effect.reconcile-unknown` always escalates to a human, and the schema
 *      is what enforces it. There is no correct automatic action when the
 *      reconcile probe cannot determine whether a mutating effect landed:
 *      retrying might double-apply, skipping might drop the work, and neither
 *      is detectable afterwards. Making the type refuse `transient` means
 *      nobody can helpfully add a retry later. `budget.cost-exceeded` and
 *      `budget.wallclock-exceeded` are `gate` for the same structural reason —
 *      F4.6 pauses for a human decision rather than dying with hours of work
 *      half-done.
 *
 * Verifies: EPIC-02-S27, EPIC-02-S28 · AC1–AC6
 */
import { z } from 'zod';
import type { EventSeq, Handle, NodeId } from './ids.ts';
import { EventSeqSchema, HandleSchema, NodeIdSchema } from './ids.ts';
import { singleLine, toSingleLine } from './text.ts';

/**
 * The closed set, in the order docs/04-domain-model.md §8 lists it, grouped
 * as it groups them. `packages/core/test/failure-taxonomy.test.ts` compares
 * this array against the document itself, so the two cannot drift.
 *
 * A string-literal union rather than an `enum`: `erasableSyntaxOnly: true`
 * (D4) forbids the enum, and a union is what you want anyway because it
 * round-trips through JSON as itself.
 */
export const NODE_FAILURE_REASONS = [
  // adapter / transport
  'adapter.spawn-failed',
  'adapter.handshake-failed',
  'adapter.frame-too-large',
  'adapter.protocol-error',
  'adapter.malformed-output',
  'adapter.capability-missing',
  // agent-reported
  'agent.nonzero-exit',
  'agent.refused',
  'agent.max-turns',
  'agent.schema-repair-exhausted',
  // contract
  'contract.schema-invalid',
  'contract.handoff-oversize',
  /**
   * KAR-23.11 — the node declared a write scope and finished its turn having
   * changed nothing inside its own worktree (F5.3).
   *
   * On 2026-08-24, `run_20260824T143505Z_3a7365` took four implementation nodes
   * to `node.completed` over twenty-two minutes. Every one of their branches
   * holds zero commits and an empty diff against main, and the completion
   * payloads carry `artifacts: []` beside an `output.text` saying, in the
   * agent's own words, *"I am blocked before any code could land"* and *"I
   * wrote no files"*. Nothing in the ledger, the CLI or the UI noticed. DeFlow
   * could not tell a node that implemented a feature from a node that reported
   * being unable to start.
   *
   * **Not `agent.refused`**, which §8 defines as *"stopReason indicated
   * refusal"* — these turns ended `end_turn`. Reusing it would have been zero
   * schema work and a quiet lie in the ledger.
   */
  'contract.no-work-product',
  // safety
  'safety.pin-integrity-violated',
  'safety.pathscope-violation',
  'safety.permission-unschedulable',
  'safety.execution-boundary',
  // resource
  'budget.cost-exceeded',
  'budget.wallclock-exceeded',
  'timeout',
  'provider.rate-limited',
  'provider.unavailable',
  // orchestration
  'effect.reconcile-unknown',
  'effect.request-hash-mismatch',
  'dependency.failed',
  'gate.failed',
  'internal',
] as const;

export type NodeFailureReason = (typeof NODE_FAILURE_REASONS)[number];

export const NodeFailureReasonSchema = z.enum(NODE_FAILURE_REASONS);

/** What the scheduler does about it: retry, fail the node, or suspend for a
 * human. The only field of a failure the scheduler reads. */
export const FAILURE_CLASSES = ['transient', 'permanent', 'gate'] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const FailureClassSchema = z.enum(FAILURE_CLASSES);

/** The reasons for which no automatic action is correct, so the schema —
 * not a code review — refuses any class but `gate` (AC5, AC6). */
export const GATE_ONLY_REASONS = [
  'budget.cost-exceeded',
  'budget.wallclock-exceeded',
  'effect.reconcile-unknown',
] as const satisfies readonly NodeFailureReason[];

function isGateOnly(reason: NodeFailureReason): boolean {
  return (GATE_ONLY_REASONS as readonly NodeFailureReason[]).includes(reason);
}

/**
 * Whether this reason escalates to a human no matter what anything else says
 * (KAR-06.5 AC9).
 *
 * Exported because the retry ladder needs the question answered without naming
 * a reason: `retry.onFailure` may override the class default for any *other*
 * reason, and this is what keeps an `{ when: 'budget.cost-exceeded', action:
 * 'retry' }` entry from smuggling a retry past a ceiling the schema already
 * refuses to classify as anything but `gate`.
 */
export function escalatesToHuman(reason: NodeFailureReason): boolean {
  return isGateOnly(reason);
}

export const NodeFailureSchema = z
  .strictObject({
    reason: NodeFailureReasonSchema,
    /** Assigned at construction, never derived from `reason`. */
    class: FailureClassSchema,
    /** Human-readable, one line, safe to render in a board cell. */
    message: singleLine(),
    /** Reason-specific and JSON-only: an exit code, an errno, a byte count. */
    detail: z.record(z.string(), z.unknown()).optional(),
    /** stdout tail, the offending frame's first 4 KiB, the diff — always a
     * handle, so the ledger stays small and the blob stays inspectable. */
    evidence: z.array(HandleSchema),
    occurredAtEvent: EventSeqSchema,
    attempt: z.number().int().nonnegative(),
  })
  .superRefine((failure, ctx) => {
    if (isGateOnly(failure.reason) && failure.class !== 'gate') {
      ctx.addIssue({
        code: 'custom',
        path: ['class'],
        message: `${failure.reason} always escalates to a human: class must be "gate", not "${failure.class}"`,
      });
    }
  });

export type NodeFailure = z.infer<typeof NodeFailureSchema>;

/**
 * What a thrower says about its own failure. The thrower is the only code
 * that knows the situation, so it — not a lookup table here — supplies the
 * class.
 */
export interface FailureTag {
  readonly reason: NodeFailureReason;
  readonly class: FailureClass;
  readonly detail?: Record<string, unknown>;
}

/** The property a thrown value carries a `FailureTag` on. A plain string
 * property rather than a symbol so it is greppable and survives being
 * re-thrown through code that copies own enumerable properties. */
export const FAILURE_TAG = 'deflowFailure';

/**
 * The error the engine's own code throws when it already knows what the
 * failure means. Everything else — a vendor SDK's error, a Node system error,
 * a bare string — is recognised structurally by `toNodeFailure` below.
 */
export class NodeFailureError extends Error {
  readonly deflowFailure: FailureTag;

  constructor(message: string, tag: FailureTag) {
    super(message);
    this.name = 'NodeFailureError';
    this.deflowFailure = tag;
  }
}

/** What `toNodeFailure` needs that it cannot know itself: where in the ledger
 * this happened, which attempt it was, and somewhere to put the stack.
 *
 * `captureEvidence` is a port, not a `writeFile`: @DeFlow/core performs no I/O
 * (R1). The daemon passes the artifact store; a test passes a Map. */
export interface ToNodeFailureContext {
  readonly occurredAtEvent: EventSeq;
  readonly attempt: number;
  /** Stores `text` and returns the handle it can be read back through. */
  readonly captureEvidence: (text: string) => Handle;
}

type Recogniser = (thrown: Record<string, unknown>) => FailureTag | null;

function asRecord(thrown: unknown): Record<string, unknown> | null {
  return typeof thrown === 'object' && thrown !== null ? (thrown as Record<string, unknown>) : null;
}

/** The thrower tagged it. Believe the tag — it is the only source of the
 * class that has any context to base it on. */
const tagged: Recogniser = (thrown) => {
  const tag = thrown[FAILURE_TAG];
  const record = asRecord(tag);
  if (!record) return null;
  const reason = NodeFailureReasonSchema.safeParse(record.reason);
  const failureClass = FailureClassSchema.safeParse(record.class);
  if (!reason.success || !failureClass.success) return null;
  const detail = asRecord(record.detail);
  return {
    reason: reason.data,
    class: failureClass.data,
    ...(detail ? { detail } : {}),
  };
};

/**
 * A failed `child_process.spawn`. The errno decides the class and the reason
 * does not: a missing or non-executable binary will still be missing on the
 * next attempt, while a process-table or fd exhaustion is the definition of
 * transient. Two rules, one reason — which is AC2 in one function.
 */
const PERMANENT_SPAWN_CODES = ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ENOEXEC'];
const TRANSIENT_SPAWN_CODES = ['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM'];

const spawnFailed: Recogniser = (thrown) => {
  const syscall = typeof thrown.syscall === 'string' ? thrown.syscall : '';
  if (thrown.name !== 'SpawnFailed' && !syscall.startsWith('spawn')) return null;
  const code = typeof thrown.code === 'string' ? thrown.code : '';
  return {
    reason: 'adapter.spawn-failed',
    // Unknown errnos are permanent: an unrecognised spawn failure retried nine
    // times is nine more minutes of the same failure.
    class: TRANSIENT_SPAWN_CODES.includes(code) ? 'transient' : 'permanent',
    detail: {
      ...(code ? { code } : {}),
      ...(syscall ? { syscall } : {}),
      errnoKnown: PERMANENT_SPAWN_CODES.includes(code) || TRANSIENT_SPAWN_CODES.includes(code),
    },
  };
};

/** Ajv rejected the agent's structured output (F6.9). Permanent as a
 * *failure*: the repair loop is a scheduling decision made above this
 * boundary, not a retry of the same call. */
const ajvValidation: Recogniser = (thrown) => {
  const name = typeof thrown.name === 'string' ? thrown.name : '';
  if (!/^(Ajv)?ValidationError$/.test(name) || !Array.isArray(thrown.errors)) return null;
  return {
    reason: 'contract.schema-invalid',
    class: 'permanent',
    detail: { errorCount: thrown.errors.length },
  };
};

/** A frame over the 8 MiB line cap (docs/07 §10). The session is already
 * being torn down by the time this is mapped. */
const frameTooLarge: Recogniser = (thrown) => {
  const name = typeof thrown.name === 'string' ? thrown.name : '';
  if (!/^FrameTooLarge(Error)?$/.test(name)) return null;
  const bytes = typeof thrown.bytes === 'number' ? { bytes: thrown.bytes } : {};
  return { reason: 'adapter.frame-too-large', class: 'permanent', detail: bytes };
};

/** In order: the tag wins, then the structural recognisers. */
const RECOGNISERS: readonly Recogniser[] = [tagged, spawnFailed, ajvValidation, frameTooLarge];

/**
 * How many throws this process could not map. `internal` existing at all is a
 * design concession, and an `internal` in production is a mapping that was
 * never written rather than an expected outcome — so it is counted and
 * exported for the daemon to surface, not swallowed.
 */
let internalFailures = 0;

export function readInternalFailureCount(): number {
  return internalFailures;
}

export function resetInternalFailureCount(): void {
  internalFailures = 0;
}

function messageOf(thrown: unknown): string {
  if (thrown instanceof Error && thrown.message) return toSingleLine(thrown.message);
  if (typeof thrown === 'string' && thrown.trim()) return toSingleLine(thrown);
  return toSingleLine(`a non-Error value was thrown: ${describeValue(thrown)}`);
}

function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${value}`;
  }
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `[function ${value.name}]`;
  try {
    // `JSON.stringify` is typed `string`, but genuinely returns `undefined`
    // for a value whose `toJSON` returns nothing — and the literal string
    // "undefined" in an evidence blob is a worse lie than "[object]".
    return JSON.stringify(value) || `[${typeof value}]`;
  } catch {
    return `[unserialisable ${typeof value}]`;
  }
}

/** Everything the stack has that the payload must not: the stack itself, an
 * `AggregateError`'s arms, and the raw value when what was thrown was not an
 * `Error` at all. */
function diagnosticText(thrown: unknown): string {
  if (!(thrown instanceof Error)) {
    return `A non-Error value was thrown.\ntypeof: ${typeof thrown}\nvalue: ${describeValue(thrown)}`;
  }
  const parts = [thrown.stack ?? `${thrown.name}: ${thrown.message}`];
  if (thrown instanceof AggregateError) {
    for (const [index, inner] of thrown.errors.entries()) {
      parts.push(
        `\n--- AggregateError[${index}] ---\n${
          inner instanceof Error ? (inner.stack ?? inner.message) : describeValue(inner)
        }`,
      );
    }
  }
  if (thrown.cause !== undefined) {
    parts.push(
      `\n--- cause ---\n${
        thrown.cause instanceof Error
          ? (thrown.cause.stack ?? thrown.cause.message)
          : describeValue(thrown.cause)
      }`,
    );
  }
  return parts.join('\n');
}

/**
 * The only boundary between a throw and the ledger.
 *
 * Anything unrecognised becomes `{ reason: 'internal', class: 'permanent' }`
 * with the stack captured as a handle — and that is a bug to be fixed, not a
 * design. `internal` is `permanent` because a mapping that was never written
 * does not write itself between attempts.
 */
export function toNodeFailure(thrown: unknown, ctx: ToNodeFailureContext): NodeFailure {
  const record = asRecord(thrown);
  let tag: FailureTag | null = null;
  for (const recognise of RECOGNISERS) {
    if (!record) break;
    tag = recognise(record);
    if (tag) break;
  }

  if (!tag) {
    internalFailures += 1;
    tag = { reason: 'internal', class: 'permanent' };
  }

  return {
    reason: tag.reason,
    // The schema refuses anything else for these reasons, and a failure that
    // cannot be written to the ledger is worse than one whose class was
    // overridden here.
    class: isGateOnly(tag.reason) ? 'gate' : tag.class,
    message: messageOf(thrown),
    ...(tag.detail ? { detail: tag.detail } : {}),
    evidence: [ctx.captureEvidence(diagnosticText(thrown))],
    occurredAtEvent: ctx.occurredAtEvent,
    attempt: ctx.attempt,
  };
}

// ── the constructors the scheduler uses instead of naming a reason ───────────

/**
 * KAR-06.5 AC1. Everything below exists so that no *scheduling* module ever
 * writes a `NodeFailureReason` literal.
 *
 * That is not tidiness. `class` is assigned where the failure is constructed
 * because that is the only place the context exists —
 * `provider.unavailable` is transient for a rate-limited vendor and permanent
 * for a binary the user uninstalled mid-run — so the moment a scheduler
 * re-derives anything from `reason`, the two cases become one. The rule is
 * enforced structurally by `packages/core/test/scheduler-reads-class.test.ts`,
 * which scans the scheduling modules and exempts exactly this file.
 */

/**
 * The failure a node inherits from a dependency that failed permanently
 * (KAR-06.1 AC5, KAR-06.5 AC3).
 *
 * `cause` is the `seq` of the failure that poisoned the branch — the one thing
 * that turns a wall of poisoned nodes back into the single event to look at.
 */
export function dependencyFailedFailure(cause: EventSeq, attempt: number): NodeFailure {
  return {
    reason: 'dependency.failed',
    class: 'permanent',
    message: 'a dependency failed permanently, so this node can never run',
    evidence: [],
    occurredAtEvent: cause,
    attempt,
  };
}

/** One F4.6 ceiling breach: which budget, on what, and by how much. */
export interface BudgetBreach {
  readonly scope: 'node' | 'run';
  /** The node a `node`-scoped breach is about. */
  readonly node?: NodeId | undefined;
  readonly dimension: 'cost' | 'wallclock';
  readonly limit: number;
  readonly actual: number;
  /**
   * Whose ceiling fired: DeFlow's own admission check, or the vendor's own
   * (`--max-budget-usd`, KAR-14.2 AC9). Absent reads as `deflow`, which is what
   * every breach constructed before the vendor path existed was.
   */
  readonly firedBy?: 'deflow' | 'vendor' | undefined;
  /**
   * KAR-13.2 AC1 — the `seq` of the `budget.exceeded` that recorded it, on the
   * copy the projection keeps.
   *
   * Optional, and absent everywhere else on purpose: the same shape is parsed
   * out of a `NodeFailure.detail`, where there is no seq to read and inventing
   * one would name an event that does not exist. Present, it is what the
   * approval queue orders a `budget` item on and deep-links it to.
   */
  readonly seq?: number | undefined;
}

export const BudgetBreachSchema = z.strictObject({
  scope: z.enum(['node', 'run']),
  node: NodeIdSchema.optional(),
  dimension: z.enum(['cost', 'wallclock']),
  limit: z.number().nonnegative(),
  actual: z.number().nonnegative(),
  firedBy: z.enum(['deflow', 'vendor']).optional(),
  /** See `BudgetBreach.seq`: present on the projection's copy, absent on the
   * one that lives in a failure's `detail`. */
  seq: z.number().int().positive().optional(),
});

/** Which reason a breach of each dimension is reported under. */
const BUDGET_REASONS: Readonly<Record<BudgetBreach['dimension'], NodeFailureReason>> = {
  cost: 'budget.cost-exceeded',
  wallclock: 'budget.wallclock-exceeded',
};

/**
 * A ceiling breach as a failure (F4.6, AC9).
 *
 * `class` is `gate` and the schema refuses anything else: hitting a ceiling
 * **pauses the run for a human decision** rather than dying with hours of work
 * half-done. The breach travels in `detail` so the scheduler can raise
 * `budget.exceeded` from it without knowing which reason it is looking at.
 */
export function budgetExceededFailure(
  breach: BudgetBreach,
  context: Pick<ToNodeFailureContext, 'occurredAtEvent' | 'attempt'>,
): NodeFailure {
  return {
    reason: BUDGET_REASONS[breach.dimension],
    class: 'gate',
    message: `${breach.scope} ${breach.dimension} ceiling exceeded: ${breach.actual} against a limit of ${breach.limit}`,
    detail: { ...breach },
    evidence: [],
    occurredAtEvent: context.occurredAtEvent,
    attempt: context.attempt,
  };
}

/**
 * The breach a failure describes, or `null` when it is not about a budget
 * (AC9).
 *
 * The scheduler asks this rather than comparing `reason`, which is what lets it
 * pause the run on a ceiling and ask a human on every other gate without a
 * single reason literal of its own. A budget failure whose `detail` is missing
 * or malformed reads as `null`: the run still gates, it simply cannot claim
 * numbers nobody supplied.
 */
export function budgetBreachOf(failure: NodeFailure): BudgetBreach | null {
  const reasons: readonly NodeFailureReason[] = Object.values(BUDGET_REASONS);
  if (!reasons.includes(failure.reason)) return null;
  // Two shapes, because two constructors: DeFlow's own trip puts the breach at
  // the root of `detail`, while an adapter reporting a *vendor's* ceiling has
  // its own diagnostic fields there and nests the breach under `breach`. Both
  // are read here rather than normalised at one of the call sites, so neither
  // can quietly stop being recognised as a budget event and start being retried.
  const nested = (failure.detail as { breach?: unknown } | undefined)?.breach;
  const parsed = BudgetBreachSchema.safeParse(nested ?? failure.detail);
  return parsed.success ? parsed.data : null;
}

/**
 * Which of the circuit breaker's three categories a gate belongs to
 * (docs/04-domain-model.md §9 — `run.needs_human.reason`).
 *
 * The vocabulary is closed at three and the taxonomy has twenty-five reasons,
 * so this is a *category*, not a restatement: the specific reason travels in
 * `run.needs_human.detail` and on the `node.failed` payload, both of which the
 * inspector renders. `churn` is the default because §11.3's trip means "the run
 * is not going anywhere on its own" — which is exactly what a gate with no
 * ceiling breached and no reconcile ambiguity is.
 */
export function needsHumanCategory(
  reason: NodeFailureReason,
): 'churn' | 'budget' | 'reconcile-unknown' {
  if (reason === 'effect.reconcile-unknown') return 'reconcile-unknown';
  const budget: readonly NodeFailureReason[] = Object.values(BUDGET_REASONS);
  return budget.includes(reason) ? 'budget' : 'churn';
}
