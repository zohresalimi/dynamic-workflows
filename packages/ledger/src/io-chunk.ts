/**
 * KAR-03.4 — the data plane (docs/05-durable-execution.md §5.1).
 *
 * Agent stdout, stderr and raw ACP frames go here and nowhere else. `io_chunk`
 * is a physically separate table from `event`, and that physical separation —
 * rather than a `kind` predicate or a partial index — is what makes the
 * isolation impossible to get wrong: there is no index to misdeclare and no
 * predicate to keep in sync, and `reduce()` cannot read this table because
 * @DeFlow/core cannot see a `Db` at all.
 *
 * Three consequences worth stating, because each is a design decision and not
 * an accident:
 *
 * 1. **Replay stays in milliseconds.** A 40-node multi-hour run is on the order
 *    of 2,000 control-plane events; the megabytes it produced while getting
 *    there live here and are never folded. That is why DeFlow ships no
 *    snapshot table.
 * 2. **The F4.7 progress watermark is meaningful for free.** An agent
 *    producing megabytes while accomplishing nothing writes only here, so it
 *    does not advance the watermark; an agent thinking silently for eight
 *    minutes does not falsely trip the stall detector either.
 * 3. **A `node.progress` event may point at this stream, never carry it.**
 *    `NodeProgressSchema` has an optional `ioChunkSeq` and is a `strictObject`,
 *    so a payload smuggling the bytes fails at the append boundary.
 */
import {
  type Db,
  type EventSeq,
  type NodeId,
  NodeIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';

/**
 * The three streams a node produces. `agent_json` is the raw ACP/JSON-RPC
 * frame as it came off the wire, kept verbatim because a framing bug is only
 * ever diagnosable from the bytes that actually arrived.
 */
export const IO_STREAMS = ['stdout', 'stderr', 'agent_json'] as const;

export type IoStream = (typeof IO_STREAMS)[number];

/**
 * One chunk on its way in. `ts` is supplied by the caller from the injected
 * Clock port — the ledger never reads a clock of its own (R1).
 */
export interface IoChunkDraft {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** 1-based, so chunks from a retry never mix with the attempt they replaced. */
  readonly attempt: number;
  readonly stream: IoStream;
  /** ms epoch. */
  readonly ts: number;
  readonly data: Uint8Array;
}

/** One `io_chunk` row, with the `seq` the ledger assigned it. */
export interface StoredIoChunk extends IoChunkDraft {
  readonly seq: EventSeq;
}

/** One `readIoChunks` window, and whether more remain after it. */
export interface IoChunkPage {
  readonly chunks: readonly StoredIoChunk[];
  /** Answered by asking for `limit + 1` rows, so it costs no second query. */
  readonly hasMore: boolean;
}

/** Which node attempt's output to read. */
export interface IoChunkSelector {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
}

/**
 * A chunk the append boundary refused. `index` is its position in the batch —
 * the batch is atomic, so nothing at all was written.
 */
export class InvalidIoChunk extends Error {
  readonly index: number;
  readonly issues: string[];

  constructor(index: number, issues: string[]) {
    super(
      `io_chunk ${index} of this batch is not appendable, so none of the batch was written: ` +
        `${issues.join('; ')}. Chunks are addressed by (run_id, node_id, attempt, seq) and read ` +
        'back by an SSE tail that cannot repair a malformed row, which is why this is refused at ' +
        'the append boundary.',
    );
    this.name = 'InvalidIoChunk';
    this.index = index;
    this.issues = issues;
  }
}

const INSERT_CHUNK = `INSERT INTO io_chunk (run_id, node_id, attempt, stream, ts, data)
  VALUES (?, ?, ?, ?, ?, ?)
  RETURNING seq`;

/**
 * The one read shape over `io_chunk`, exported because the statement is the
 * contract: this run's node attempt, **strictly greater than** `afterSeq`, in
 * `seq` order, at most `limit` of them. Bounded, and served by `io_run_seq`.
 */
export const IO_CHUNK_TAIL_SQL = `SELECT seq, run_id, node_id, attempt, stream, ts, data
  FROM io_chunk
  WHERE run_id = ? AND node_id = ? AND attempt = ? AND seq > ?
  ORDER BY seq
  LIMIT ?`;

interface IoChunkRow {
  seq: number;
  run_id: string;
  node_id: string;
  attempt: number;
  stream: string;
  ts: number;
  data: Uint8Array;
}

function issuesFor(draft: IoChunkDraft): string[] {
  const issues: string[] = [];
  if (!RunIdSchema.safeParse(draft.runId).success) issues.push(`runId: ${String(draft.runId)}`);
  if (!NodeIdSchema.safeParse(draft.nodeId).success) issues.push(`nodeId: ${String(draft.nodeId)}`);
  if (!Number.isInteger(draft.attempt) || draft.attempt < 1) {
    issues.push(`attempt: must be an integer >= 1, got ${String(draft.attempt)}`);
  }
  if (!(IO_STREAMS as readonly string[]).includes(draft.stream)) {
    issues.push(`stream: must be one of ${IO_STREAMS.join(' | ')}, got ${String(draft.stream)}`);
  }
  if (!Number.isInteger(draft.ts) || draft.ts < 0) {
    issues.push(`ts: must be a non-negative integer ms epoch, got ${String(draft.ts)}`);
  }
  if (!(draft.data instanceof Uint8Array)) {
    issues.push('data: must be a Uint8Array — the data plane stores bytes, not strings');
  }
  return issues;
}

/**
 * Appends `drafts` in **one** transaction and returns the `seq` assigned to
 * each, in the same order.
 *
 * All or nothing, and validated before a single row is written, for the same
 * reason `appendEvents` is: a returned `seq` becomes a cursor an SSE client
 * persists, so a half-written batch is a cursor that points at nothing.
 */
export function appendIoChunks(db: Db, drafts: readonly IoChunkDraft[]): EventSeq[] {
  drafts.forEach((draft, index) => {
    const issues = issuesFor(draft);
    if (issues.length > 0) throw new InvalidIoChunk(index, issues);
  });
  if (drafts.length === 0) return [];

  const insert = db.prepare<{ seq: number }>(INSERT_CHUNK);
  return db.transaction(() =>
    drafts.map((draft) => {
      const assigned = insert.get(
        draft.runId,
        draft.nodeId,
        draft.attempt,
        draft.stream,
        draft.ts,
        draft.data,
      );
      if (assigned === undefined) {
        throw new Error('INSERT INTO io_chunk … RETURNING seq returned no row');
      }
      return assigned.seq as EventSeq;
    }),
  );
}

/** One chunk. The batched form above is the hot path; this is the readable one. */
export function appendIoChunk(db: Db, draft: IoChunkDraft): EventSeq {
  const [seq] = appendIoChunks(db, [draft]);
  if (seq === undefined) throw new Error('appendIoChunk appended nothing');
  return seq;
}

function toStoredChunk(row: IoChunkRow): StoredIoChunk {
  return {
    seq: row.seq as EventSeq,
    runId: row.run_id as RunId,
    nodeId: row.node_id as NodeId,
    attempt: row.attempt,
    stream: row.stream as IoStream,
    ts: row.ts,
    // A view over the driver's buffer rather than a copy: this is the path a
    // megabyte per node walks, and the caller is handed the bytes to write to a
    // socket, not to keep.
    data: new Uint8Array(row.data.buffer, row.data.byteOffset, row.data.byteLength),
  };
}

function requireIndex(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new RangeError(`readIoChunks: ${name} must be an integer >= ${minimum}, got ${value}`);
  }
}

/**
 * Reads one bounded window of a node attempt's output.
 *
 * `seq > ?` and never `seq >= ?`: `io_chunk.seq` is `AUTOINCREMENT` like
 * `event.seq`, so pruning leaves permanent gaps and a caller resuming from
 * `cursor + 1` silently skips a frame.
 *
 * Bounded, and never a lazy `iterate()` cursor. See
 * `test/integration/wal-held-cursor.test.ts` for what holding one open across a
 * stream does to the `-wal` file.
 */
export function readIoChunks(
  db: Db,
  selector: IoChunkSelector,
  afterSeq: number,
  limit: number,
): IoChunkPage {
  requireIndex('afterSeq', afterSeq, 0);
  requireIndex('limit', limit, 1);
  requireIndex('attempt', selector.attempt, 1);

  const rows = db
    .prepare<IoChunkRow>(IO_CHUNK_TAIL_SQL)
    .all(selector.runId, selector.nodeId, selector.attempt, afterSeq, limit + 1);
  return {
    chunks: rows.slice(0, limit).map(toStoredChunk),
    hasMore: rows.length > limit,
  };
}
