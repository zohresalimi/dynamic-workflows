/**
 * KAR-02.7 — the event envelope and `parseEvent`
 * (docs/04-domain-model.md §9, §9.2).
 *
 * Every event carries the same envelope, and `kind` plus `v` are the only
 * fields anything is allowed to branch on before upcasting. `ts` is
 * informational: **order is `seq`**, always, because the wall clock is not
 * monotonic and a laptop that sleeps through a daylight-saving transition
 * would otherwise reorder a run's history.
 *
 * `parseEvent` is total. It returns a value for every input, including
 * garbage, including a kind from a build that does not exist yet. That is
 * §9.2 rule 2 — the single forward-compatibility mechanism in the system:
 *
 *   A user who installs a newer DeFlowd, starts a run, then downgrades must
 *   get a daemon that skips the events it does not understand rather than one
 *   that refuses to open the ledger.
 *
 * `unknown-kind` is the value KAR-03.5's reducer turns into `return state`.
 * Note what is deliberately absent: there is no error-level log on that path.
 * An error log per skipped event during a downgraded replay of a nine-hour
 * run is its own denial of service.
 *
 * Verifies: EPIC-02-S19 · AC1, AC3, AC7
 */
import { z } from 'zod';
import type { EventKind, EventPayloadOf } from './event-payloads.ts';
import { EVENT_SCHEMAS, isEventKind } from './event-payloads.ts';
import {
  type EventSeq,
  EventSeqSchema,
  type IdempotencyKey,
  type NodeId,
  NodeIdSchema,
  type RunId,
  RunIdSchema,
} from './ids.ts';
import { parseIkey } from './ikey.ts';
import { eventUpcasters, type UpcasterRegistry } from './upcasters.ts';

/**
 * §9's envelope, exactly. `seq` orders; `ts` is for humans; `epoch` is the
 * daemon epoch, and it is required on every event (AC7) because a stale-epoch
 * write has to be rejectable without consulting anything but the row itself.
 */
export type EventEnvelope<K extends string, P> = {
  seq: EventSeq;
  runId: RunId;
  /** ms epoch, informational only — ORDER IS seq. */
  ts: number;
  kind: K;
  /** Payload schema version, for upcasting. */
  v: number;
  /** Daemon epoch; stale-epoch writes are rejected. */
  epoch: number;
  nodeId?: NodeId;
  attempt?: number;
  ikey?: IdempotencyKey;
  payload: P;
};

/** See ./event-payloads.ts for why this is not exported from there either. */
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

/**
 * The envelope, with the payload left as `unknown`: which schema applies is a
 * function of `kind` and `v`, and both live in this object.
 */
export const EventEnvelopeSchema = z.strictObject({
  seq: EventSeqSchema,
  runId: RunIdSchema,
  ts: z.number().int().nonnegative(),
  /** Not an enum: an unknown kind is data to be skipped, not a parse error. */
  kind: z.string().min(1),
  v: z.number().int().positive(),
  epoch: z.number().int().nonnegative(),
  nodeId: NodeIdSchema.optional(),
  attempt: z.number().int().nonnegative().optional(),
  ikey: IkeySchema.optional(),
  payload: z.unknown(),
});

/** One event of a known kind, with its payload parsed at the current version. */
export type Event = {
  [K in EventKind]: EventEnvelope<K, EventPayloadOf<K>>;
}[EventKind];

/** The envelope fields a payload is allowed to restate. Both are optional on
 * the envelope for every kind that declares no echo, and neither may be absent
 * for a kind that declares one. */
type EnvelopeScope = 'nodeId' | 'attempt';

/**
 * KAR-02.11 — the payload keys that restate an envelope field, per kind.
 *
 * Most payloads say nothing the envelope already says. A few must: a kind whose
 * rows are *counted* is counted with `WHERE node_id = ?` over the ledger's
 * indexed column, so its `nodeId` cannot be optional, while the payload still
 * has to name the node it is about to stay readable on its own. Those are two
 * writes of one fact, and until this table existed nothing checked they agreed.
 *
 * The defect that produced it: `provider.session_opened`'s rows are the attempt
 * a pre-execution turn derives its vendor session from (KAR-19.13). An event
 * written without an envelope `nodeId` counts zero for ever, so the next turn
 * re-derives the id the vendor has already created and is refused with
 * `Session ID … is already in use` — which is how a run wedged at plan
 * compilation on 2026-08-16. A row whose envelope says `planner` and whose
 * payload says `framing` is worse still: the count sees one turn and the offline
 * recomputation of the id sees another.
 *
 * A table rather than an `if` for one kind, so the next counted kind declares
 * itself and inherits the rule. A kind absent from it is parsed exactly as it
 * was before this existed.
 */
export const EVENT_ENVELOPE_ECHOES = {
  'provider.session_opened': { node: 'nodeId', attempt: 'attempt' },
} as const satisfies Partial<Readonly<Record<EventKind, Readonly<Record<string, EnvelopeScope>>>>>;

const ENVELOPE_ECHOES: Partial<Readonly<Record<string, Readonly<Record<string, EnvelopeScope>>>>> =
  EVENT_ENVELOPE_ECHOES;

/**
 * The disagreements between one payload and its envelope, as issue strings in
 * `issuesOf`'s shape. Empty means they agree.
 *
 * Both values are printed. "does not match" without them sends the reader back
 * to the ledger to find out what did not match what.
 */
function echoIssues(
  echoes: Readonly<Record<string, EnvelopeScope>>,
  envelope: { nodeId?: NodeId | undefined; attempt?: number | undefined },
  payload: unknown,
): string[] {
  const fields = (payload ?? {}) as Record<string, unknown>;
  const issues: string[] = [];

  for (const [payloadKey, envelopeField] of Object.entries(echoes)) {
    const onEnvelope: unknown = envelope[envelopeField];
    const inPayload = fields[payloadKey];

    if (onEnvelope === undefined) {
      issues.push(
        `${payloadKey}: the envelope has no ${envelopeField}, so this event cannot be counted under one (the payload says ${JSON.stringify(inPayload)})`,
      );
      continue;
    }
    if (onEnvelope !== inPayload) {
      issues.push(
        `${payloadKey}: does not match the envelope's ${envelopeField} (payload ${JSON.stringify(inPayload)}, envelope ${JSON.stringify(onEnvelope)})`,
      );
    }
  }

  return issues;
}

export type ParseEventResult =
  | { status: 'ok'; event: Event }
  /** §9.2 rule 2. The reducer returns `state` unchanged for this. */
  | { status: 'unknown-kind'; kind: string; seq: number }
  /** Not upcast, not downcast, not parsed. */
  | { status: 'future-version'; kind: EventKind; v: number; current: number; seq: number }
  | { status: 'invalid-envelope'; issues: string[] }
  | { status: 'invalid-payload'; kind: EventKind; v: number; seq: number; issues: string[] }
  | { status: 'upcast-failed'; kind: EventKind; v: number; seq: number; message: string };

function issuesOf(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`);
}

/**
 * Reads one event off the wire or out of the ledger.
 *
 * Never throws and never logs. The order of the checks is the contract: an
 * unknown `kind` is decided before anything looks at the payload, and a
 * future `v` is decided before the upcaster chain or the payload schema is
 * consulted, so a downgraded daemon reports "newer than me" rather than
 * "corrupt".
 */
export function parseEvent(
  input: unknown,
  registry: UpcasterRegistry = eventUpcasters,
): ParseEventResult {
  const envelope = EventEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    return { status: 'invalid-envelope', issues: issuesOf(envelope.error) };
  }

  const { kind, v, payload, ...rest } = envelope.data;

  if (!isEventKind(kind)) {
    return { status: 'unknown-kind', kind, seq: rest.seq };
  }

  // The registry is what says which version this build writes, so a caller
  // that hands in a different table — a test exercising a v1→v3 chain none of
  // the shipped kinds has yet — exercises this exact code path rather than a
  // reimplementation of it. It is built from EVENT_CURRENT_VERSIONS, so the
  // fallback is only reached by a registry that has never heard of the kind.
  const current = registry.currentVersion(kind) ?? EVENT_SCHEMAS[kind].v;
  if (v > current) {
    return { status: 'future-version', kind, v, current, seq: rest.seq };
  }

  let atCurrent: unknown = payload;
  if (v < current) {
    try {
      atCurrent = registry.upcast(kind, v, payload);
    } catch (thrown) {
      return {
        status: 'upcast-failed',
        kind,
        v,
        seq: rest.seq,
        message: thrown instanceof Error ? thrown.message : String(thrown),
      };
    }
  }

  const parsed = EVENT_SCHEMAS[kind].payload.safeParse(atCurrent);
  if (!parsed.success) {
    return { status: 'invalid-payload', kind, v, seq: rest.seq, issues: issuesOf(parsed.error) };
  }

  // KAR-02.11 — last, and only for the kinds that declare an echo. Both
  // forward-compatibility branches above are decided before this runs, so a
  // downgraded daemon still reports "newer than me" rather than a mismatch it
  // is in no position to judge.
  const echoes = ENVELOPE_ECHOES[kind];
  if (echoes !== undefined) {
    const mismatched = echoIssues(echoes, rest, parsed.data);
    if (mismatched.length > 0) {
      return { status: 'invalid-payload', kind, v, seq: rest.seq, issues: mismatched };
    }
  }

  // The cast is the one place the kind→payload correspondence is asserted
  // rather than inferred: `kind` is a runtime value here, so TypeScript
  // cannot narrow `EVENT_SCHEMAS[kind].payload`'s output to the arm of the
  // union that `kind` selects. The table in ./event-payloads.ts is what makes
  // it true, and the per-kind fixture suite is what keeps it true.
  return {
    status: 'ok',
    event: { ...rest, kind, v, payload: parsed.data } as Event,
  };
}
