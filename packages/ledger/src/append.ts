/**
 * KAR-03.3 — the append-only `event` log and its one read shape
 * (docs/05-durable-execution.md §3 primitive 1, §5, §6).
 *
 * Two functions, and there will never be a third that writes: `appendEvents`
 * and `readRange`. There is no `updateEvent`, no `deleteEvent`, no `amend`.
 * That is not tidiness — `seq` is the identity of an event *outside* the
 * database (an SSE frame id, a checkpoint's `last_seq`, a browser tab's cursor),
 * so a row that can change is a cursor that can lie. `test/append-only.test.ts`
 * is what keeps the absence honest.
 *
 * Three properties this file exists to hold:
 *
 * 1. **One transaction per batch.** A batch of 100 is one `BEGIN IMMEDIATE`,
 *    not 100 — measured at 137,549 ev/s per-event versus 1,083,923 ev/s
 *    batched on the author's laptop (spike S5).
 * 2. **`INSERT … RETURNING seq`.** The assigned number comes back from the
 *    insert itself. The alternative — `SELECT last_insert_rowid()` — is a
 *    second statement in the hot path for the same answer.
 * 3. **Validated at the boundary.** An append-only table cannot be repaired,
 *    so a malformed envelope is refused at the door rather than discovered by
 *    a reducer months later.
 */
import {
  canonicalJson,
  type Db,
  type EventEnvelope,
  EventEnvelopeSchema,
  type EventSeq,
  type IdempotencyKey,
  type NodeId,
  type RunId,
} from '@DeFlow/core';

/**
 * An event on its way in: the envelope of docs/04-domain-model.md §9 minus
 * `seq`, because the ledger assigns that and nothing upstream may guess it.
 *
 * Derived from `EventEnvelopeSchema` rather than restated, so a field added to
 * the envelope is a field this boundary validates on the same commit.
 */
export const EventDraftSchema = EventEnvelopeSchema.omit({ seq: true });

/** @see EventDraftSchema */
export type EventDraft = Omit<EventEnvelope<string, unknown>, 'seq'>;

/** One row of the `event` table, as the envelope it was appended as. */
export type StoredEvent = EventEnvelope<string, unknown>;

/** One `readRange` window, and whether the run has more after it. */
export interface EventPage {
  readonly events: readonly StoredEvent[];
  /**
   * True when at least one more event for this run exists beyond the last one
   * returned. Answered by asking for `limit + 1` rows, so it costs no second
   * query and cannot disagree with `events`.
   */
  readonly hasMore: boolean;
}

/**
 * An event the append boundary refused. `index` is its position in the batch —
 * the batch is atomic, so nothing at all was written.
 */
export class InvalidEventEnvelope extends Error {
  readonly index: number;
  readonly issues: string[];

  constructor(index: number, issues: string[]) {
    super(
      `event ${index} of this batch is not a valid envelope, so none of the batch was appended: ` +
        `${issues.join('; ')}. The event table is append-only — a row written malformed can never ` +
        'be corrected, which is why this is refused at the append boundary rather than at read time.',
    );
    this.name = 'InvalidEventEnvelope';
    this.index = index;
    this.issues = issues;
  }
}

const INSERT_EVENT = `INSERT INTO event (run_id, ts, kind, v, epoch, node_id, attempt, ikey, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  RETURNING seq`;

/** Column order matches INSERT_EVENT; `?? null` is how an absent optional reaches a nullable column. */
const bindings = (draft: EventDraft): (string | number | null)[] => [
  draft.runId,
  draft.ts,
  draft.kind,
  draft.v,
  draft.epoch,
  draft.nodeId ?? null,
  draft.attempt ?? null,
  draft.ikey ?? null,
  // canonicalJson, not JSON.stringify: the payload of an event is hashed by
  // the checkpoint and compared across daemon versions, and it refuses a Date
  // or a NaN rather than coercing one into a row nobody can fix afterwards.
  canonicalJson(draft.payload),
];

function validate(drafts: readonly EventDraft[]): EventDraft[] {
  return drafts.map((draft, index) => {
    const parsed = EventDraftSchema.safeParse(draft);
    if (!parsed.success) {
      throw new InvalidEventEnvelope(
        index,
        parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
      );
    }
    return parsed.data as EventDraft;
  });
}

/**
 * Appends `drafts` in **one** transaction and returns the `seq` assigned to
 * each, in the same order.
 *
 * All or nothing: every envelope is validated before a single row is written,
 * and the insert loop runs inside one immediate transaction, so a batch either
 * lands whole or leaves the ledger exactly as it was.
 *
 * A returned `seq` is only meaningful once the transaction that produced it
 * commits. Called inside a caller's own transaction that later rolls back,
 * these numbers describe rows that never existed — and SQLite will hand the
 * same ones out again (see the README's "Sequence numbers have gaps").
 */
export function appendEvents(db: Db, drafts: readonly EventDraft[]): EventSeq[] {
  const validated = validate(drafts);
  if (validated.length === 0) return [];

  const insert = db.prepare<{ seq: number }>(INSERT_EVENT);
  return db.transaction(() =>
    validated.map((draft) => {
      const assigned = insert.get(...bindings(draft));
      if (assigned === undefined) {
        throw new Error('INSERT INTO event … RETURNING seq returned no row');
      }
      return assigned.seq as EventSeq;
    }),
  );
}

const SELECT_RANGE = `SELECT seq, run_id, ts, kind, v, epoch, node_id, attempt, ikey, payload
  FROM event
  WHERE run_id = ? AND seq > ?
  ORDER BY seq
  LIMIT ?`;

interface EventRow {
  seq: number;
  run_id: string;
  ts: number;
  kind: string;
  v: number;
  epoch: number;
  node_id: string | null;
  attempt: number | null;
  ikey: string | null;
  payload: string;
}

function toEnvelope(row: EventRow): StoredEvent {
  const envelope: StoredEvent = {
    seq: row.seq as EventSeq,
    runId: row.run_id as RunId,
    ts: row.ts,
    kind: row.kind,
    v: row.v,
    epoch: row.epoch,
    payload: JSON.parse(row.payload),
  };
  // Assigned only when the column held a value, so an optional the envelope
  // never carried comes back absent rather than explicitly `undefined` —
  // `{ nodeId: undefined }` and `{}` are not the same object to a structural
  // comparison, a snapshot or `JSON.stringify`, and `exactOptionalPropertyTypes`
  // is the compiler agreeing.
  if (row.node_id !== null) envelope.nodeId = row.node_id as NodeId;
  if (row.attempt !== null) envelope.attempt = row.attempt;
  if (row.ikey !== null) envelope.ikey = row.ikey as IdempotencyKey;
  return envelope;
}

function requireIndex(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`readRange: ${name} must be an integer >= ${minimum}, got ${value}`);
  }
}

/**
 * The one read shape over `event`: this run's events, **strictly greater than**
 * `afterSeq`, in `seq` order, at most `limit` of them.
 *
 * `seq > ?` and never `seq >= ?`, and callers resume from the last `seq` they
 * saw and never from `cursor + 1`: the sequence is global across runs and
 * `AUTOINCREMENT` never reissues a pruned number, so gaps are ordinary. It is
 * served by the `event_run_seq` index on `(run_id, seq)`, and it is bounded —
 * an unbounded scan or a held-open cursor is what produced the 82.6 MB `-wal`
 * file recorded in docs/05-durable-execution.md §13.
 */
export function readRange(db: Db, runId: RunId, afterSeq: number, limit: number): EventPage {
  requireIndex('afterSeq', afterSeq, 0);
  requireIndex('limit', limit, 1);

  // One row more than asked for: whether it came back is the answer to
  // "is there more", and it is discarded rather than returned.
  const rows = db.prepare<EventRow>(SELECT_RANGE).all(runId, afterSeq, limit + 1);
  return {
    events: rows.slice(0, limit).map(toEnvelope),
    hasMore: rows.length > limit,
  };
}
