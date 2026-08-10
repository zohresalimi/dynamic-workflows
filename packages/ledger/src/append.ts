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
import { Buffer } from 'node:buffer';
import { MAX_INLINE_PAYLOAD_BYTES, PAYLOAD_MIME, spillBytes } from './blobs.ts';
import { readEpoch, StaleEpoch } from './epoch.ts';

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

/**
 * A payload too large to live inline, appended with nowhere to spill it.
 *
 * KAR-03.9's blob store is where it belongs, and `appendEvents` will put it
 * there the moment it is told which data directory to use (`spillTo`). Without
 * that it refuses, which is the honest failure: refusing is recoverable, and a
 * row written into an append-only table is not.
 */
export class PayloadTooLarge extends Error {
  readonly index: number;
  readonly bytes: number;

  constructor(index: number, kind: string, bytes: number) {
    super(
      `event ${index} of this batch ("${kind}") has a ${bytes}-byte payload, over the ` +
        `${MAX_INLINE_PAYLOAD_BYTES}-byte inline ceiling, and appendEvents was given no ` +
        '`spillTo` data directory, so none of the batch was appended. Anything this size ' +
        'belongs in the content-addressed blob store (KAR-03.9), with the event carrying ' +
        '{ sha256, bytes, mime, head, tail } instead of the bytes: `event` is append-only and ' +
        'is re-read by every replay, so an oversized payload is permanent and recurring cost. ' +
        'Agent output belongs in io_chunk (appendIoChunk), never here.',
    );
    this.name = 'PayloadTooLarge';
    this.index = index;
    this.bytes = bytes;
  }
}

/** How `appendEvents` should handle a payload over the inline ceiling. */
export interface AppendOptions {
  /**
   * The data directory whose `blobs/` receives payloads over
   * `MAX_INLINE_PAYLOAD_BYTES` (KAR-03.9). Omitted, an oversized payload is
   * refused with `PayloadTooLarge` rather than written into the append-only
   * table — a caller that has not wired the store yet gets a loud error, not a
   * permanent 4 MB row.
   */
  readonly spillTo?: string;
}

const INSERT_EVENT = `INSERT INTO event (run_id, ts, kind, v, epoch, node_id, attempt, ikey, payload)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  RETURNING seq`;

/** A validated draft and its already-encoded payload, so nothing is encoded twice. */
interface Appendable {
  readonly draft: EventDraft;
  readonly payload: string;
}

/** Column order matches INSERT_EVENT; `?? null` is how an absent optional reaches a nullable column. */
const bindings = ({ draft, payload }: Appendable): (string | number | null)[] => [
  draft.runId,
  draft.ts,
  draft.kind,
  draft.v,
  draft.epoch,
  draft.nodeId ?? null,
  draft.attempt ?? null,
  draft.ikey ?? null,
  payload,
];

function validate(drafts: readonly EventDraft[], spillTo: string | undefined): Appendable[] {
  return drafts.map((draft, index) => {
    const parsed = EventDraftSchema.safeParse(draft);
    if (!parsed.success) {
      throw new InvalidEventEnvelope(
        index,
        parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
      );
    }
    const validated = parsed.data as EventDraft;
    // canonicalJson, not JSON.stringify: the payload of an event is hashed by
    // the checkpoint and compared across daemon versions, and it refuses a Date
    // or a NaN rather than coercing one into a row nobody can fix afterwards.
    const payload = canonicalJson(validated.payload);
    // The encoded bytes, not the object graph: the ceiling is about what lands
    // in the row and is re-read by every replay.
    const encoded = Buffer.from(payload, 'utf8');
    if (encoded.byteLength <= MAX_INLINE_PAYLOAD_BYTES) return { draft: validated, payload };
    if (spillTo === undefined) {
      throw new PayloadTooLarge(index, validated.kind, encoded.byteLength);
    }
    // KAR-03.9: the bytes go to the content-addressed blob store and the row
    // keeps `{ sha256, bytes, mime, head, tail }`. Deliberately outside the
    // transaction below — a blob orphaned by a rolled-back batch is harmless
    // (its name is its content, so the next write of the same bytes adopts it),
    // whereas doing filesystem I/O while holding SQLite's write lock would
    // stall every other writer for the length of a 40 MB write.
    const ref = spillBytes(spillTo, encoded, PAYLOAD_MIME, validated.ikey);
    return { draft: { ...validated, payload: ref }, payload: canonicalJson(ref) };
  });
}

/**
 * The daemon-epoch fence (KAR-03.7 AC5).
 *
 * Refuses the whole batch if any event in it carries an epoch **below** the
 * one persisted in this ledger — the signature of a daemon that has been
 * superseded and does not know it. Above it is not refused: a higher epoch is
 * a daemon this ledger has not been told about yet, and the reducer treats it
 * as the new high-water mark rather than as an error.
 *
 * Called with the write lock already held. @see ./epoch.ts
 */
function fence(db: Db, appendables: readonly Appendable[]): void {
  const current = readEpoch(db);
  for (const [index, { draft }] of appendables.entries()) {
    if (draft.epoch < current) throw new StaleEpoch(index, draft.epoch, current);
  }
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
export function appendEvents(
  db: Db,
  drafts: readonly EventDraft[],
  options: AppendOptions = {},
): EventSeq[] {
  const validated = validate(drafts, options.spillTo);
  if (validated.length === 0) return [];

  const insert = db.prepare<{ seq: number }>(INSERT_EVENT);
  return db.transaction(() => {
    // Inside the transaction, so the write lock is already held: no other
    // connection can advance the epoch between this read and the inserts
    // below. One read per batch, not per event.
    fence(db, validated);
    return validated.map((appendable) => {
      const assigned = insert.get(...bindings(appendable));
      if (assigned === undefined) {
        throw new Error('INSERT INTO event … RETURNING seq returned no row');
      }
      return assigned.seq as EventSeq;
    });
  });
}

/**
 * The SSE tail query, exported because the statement is the contract: it is the
 * hottest read in the system and the shape `EXPLAIN QUERY PLAN` is asserted
 * against in `test/integration/control-plane-split.test.ts`.
 */
export const EVENT_TAIL_SQL = `SELECT seq, run_id, ts, kind, v, epoch, node_id, attempt, ikey, payload
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
  const rows = db.prepare<EventRow>(EVENT_TAIL_SQL).all(runId, afterSeq, limit + 1);
  return {
    events: rows.slice(0, limit).map(toEnvelope),
    hasMore: rows.length > limit,
  };
}

/**
 * KAR-13.2 AC5 — the `runs=*` topic: a few lifecycle kinds, across every run.
 *
 * `runs=*` is not "every event of every run". It is the low-volume global topic
 * an idle tab needs — the run list and the cross-run approval queue — and the
 * whole point of it is that it *does not* drag a single `node.progress` frame
 * into a tab that is showing neither (docs/11-api-and-realtime.md §2). The
 * filter is therefore applied in SQL and not in the handler: a server-side
 * topic that materialised every row and then dropped most of them would still
 * pay for the firehose, which is the cost the design exists to avoid.
 *
 * Ordered by `seq` and bounded like every other read here — one statement,
 * finished before it returns, never a held cursor.
 */
export function readGlobalRange(
  db: Db,
  afterSeq: number,
  kinds: readonly string[],
  limit: number,
): EventPage {
  requireIndex('afterSeq', afterSeq, 0);
  requireIndex('limit', limit, 1);
  if (kinds.length === 0) return { events: [], hasMore: false };

  const placeholders = kinds.map(() => '?').join(', ');
  const rows = db
    .prepare<EventRow>(
      `SELECT seq, run_id, ts, kind, v, epoch, node_id, attempt, ikey, payload
         FROM event
        WHERE seq > ? AND kind IN (${placeholders})
        ORDER BY seq
        LIMIT ?`,
    )
    .all(afterSeq, ...kinds, limit + 1);

  return {
    events: rows.slice(0, limit).map(toEnvelope),
    hasMore: rows.length > limit,
  };
}

/**
 * The envelope `ts` of one event, or `null` when no such row exists.
 *
 * A primary-key lookup, and the one join the approval queue needs: an item's
 * *age* is wall-clock arithmetic and `RunState` records no timestamps, so the
 * instant comes from the event that created the item rather than from a field
 * the projection would have to carry (and a replay would have to reproduce).
 */
export function readEventTs(db: Db, seq: number): number | null {
  const row = db.prepare<{ ts: number }>('SELECT ts FROM event WHERE seq = ?').get(seq);
  return row?.ts ?? null;
}
