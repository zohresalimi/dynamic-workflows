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
import type { EventSeq, Handle } from './ids.ts';
import { EventSeqSchema, HandleSchema } from './ids.ts';
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
