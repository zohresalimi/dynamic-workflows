/**
 * KAR-03.4 — how anything reads more rows than fit in one window.
 *
 * **Bounded `LIMIT` queries in a loop. Never a lazy `stmt.iterate()` cursor.**
 *
 * The lazy cursor is the shape a reasonable engineer reaches for when piping a
 * large result into an SSE response: it looks like the memory-efficient choice
 * and it reads beautifully. It is a trap. A read statement left open holds a
 * read transaction open, and SQLite cannot checkpoint WAL frames past the
 * oldest live reader — so every row the daemon writes while the stream is
 * connected accumulates in `ledger.db-wal` and **no checkpoint can reclaim it**.
 * `PRAGMA wal_checkpoint(TRUNCATE)` comes back `busy` having moved almost
 * nothing, and the space returns only once the cursor closes. Measured on this
 * machine at over 50 MB from 20,000 rows against under 8 MB for the drain below
 * (see `test/integration/wal-held-cursor.test.ts`, which asserts both halves on
 * purpose so nobody "simplifies" this file away).
 *
 * Each batch prepares its statement, materialises its rows and discards the
 * statement; nothing is held open across a `yield`, so a consumer that pauses
 * for ten minutes between frames costs the writer nothing.
 */
import type { Db, RunId } from '@DeFlow/core';
import { readRange, type StoredEvent } from './append.ts';
import { type IoChunkSelector, readIoChunks, type StoredIoChunk } from './io-chunk.ts';

/**
 * Rows per query. 500 is the SSE tail window the architecture measured at
 * ~0.2 ms per query, and there is no reason for the drain to use a different
 * one — it is the same statement.
 */
export const DEFAULT_DRAIN_BATCH = 500;

export interface DrainOptions {
  /** Resume strictly after this `seq`. Defaults to the beginning. */
  readonly afterSeq?: number;
  /** Rows per bounded query. Defaults to `DEFAULT_DRAIN_BATCH`. */
  readonly batchSize?: number;
}

/**
 * Every control-plane event of `runId` after `afterSeq`, in `seq` order.
 *
 * This is the shape a fold takes: `for (const event of drainEvents(db, runId))
 * state = reduce(state, event)`. It touches `event` and only `event` — the
 * reducer never sees `io_chunk`, which is what keeps replay in milliseconds
 * beside a data plane fifty times its size.
 */
export function* drainEvents(
  db: Db,
  runId: RunId,
  options: DrainOptions = {},
): Generator<StoredEvent> {
  const batchSize = options.batchSize ?? DEFAULT_DRAIN_BATCH;
  let cursor = options.afterSeq ?? 0;

  for (;;) {
    const page = readRange(db, runId, cursor, batchSize);
    for (const event of page.events) {
      cursor = event.seq;
      yield event;
    }
    if (!page.hasMore) return;
  }
}

/** The same bounded drain over one node attempt's output. */
export function* drainIoChunks(
  db: Db,
  selector: IoChunkSelector,
  options: DrainOptions = {},
): Generator<StoredIoChunk> {
  const batchSize = options.batchSize ?? DEFAULT_DRAIN_BATCH;
  let cursor = options.afterSeq ?? 0;

  for (;;) {
    const page = readIoChunks(db, selector, cursor, batchSize);
    for (const chunk of page.chunks) {
      cursor = chunk.seq;
      yield chunk;
    }
    if (!page.hasMore) return;
  }
}
