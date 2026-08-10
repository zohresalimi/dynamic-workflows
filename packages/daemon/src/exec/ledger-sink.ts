/**
 * The `LedgerSink` an adapter writes a node's turn through, over DeFlowd's own
 * file-backed ledger.
 *
 * @DeFlow/adapters depends on @DeFlow/core alone (docs/16-repo-layout.md R2), so
 * every write it makes goes through a port; this is the daemon's side of that
 * port and there is deliberately one of it. `appendAll` is not decoration:
 * KAR-14.1 AC1 requires `budget.consumed` and the event that ends an attempt to
 * reach the file in **one** transaction, and a sink that satisfied the port by
 * looping over `append` would pass every assertion in this repository while
 * losing exactly the guarantee the port exists for.
 *
 * The attempt-numbering translation lives here too, for the same reason: the
 * data plane counts attempts from 1 (`io_chunk.attempt`) and the event envelope
 * from 0, and an adapter that had to remember which convention applied to which
 * port would get it wrong on the first retry — filing a retry's output under the
 * attempt it replaced, invisibly, until somebody read a transcript.
 */
import type { EventRecord, IoRecord, LedgerSink } from '@DeFlow/adapters';
import type { Db, EventSeq, RunId } from '@DeFlow/core';
import { appendEvents, appendIoChunk } from '@DeFlow/ledger';

export interface LedgerSinkOptions {
  readonly db: Db;
  readonly runId: RunId;
  /** This daemon life's epoch, stamped on every event appended here. */
  readonly epoch: number;
  /** Where an oversized payload spills. Omitted means the ledger refuses one. */
  readonly dataDir?: string;
}

/** One `EventRecord` as the ledger's own draft, with the absent fields absent. */
const draftOf = (event: EventRecord, runId: RunId, epoch: number) => ({
  runId,
  ts: event.ts,
  kind: event.kind,
  v: event.v,
  epoch,
  ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
  ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
  ...(event.ikey === undefined ? {} : { ikey: event.ikey }),
  payload: event.payload,
});

export function sqliteLedgerSink(options: LedgerSinkOptions): LedgerSink {
  const { db, runId, epoch } = options;
  const appendOptions = options.dataDir === undefined ? {} : { spillTo: options.dataDir };

  return {
    append(event: EventRecord): Promise<EventSeq> {
      const [seq] = appendEvents(db, [draftOf(event, runId, epoch)], appendOptions);
      return Promise.resolve(seq as EventSeq);
    },
    appendAll(events: readonly EventRecord[]): Promise<readonly EventSeq[]> {
      // One `appendEvents` call is one `BEGIN IMMEDIATE`: the batch lands whole
      // or leaves the ledger exactly as it was.
      const seqs = appendEvents(
        db,
        events.map((event) => draftOf(event, runId, epoch)),
        appendOptions,
      );
      return Promise.resolve(seqs as EventSeq[]);
    },
    appendIo(chunk: IoRecord): Promise<EventSeq> {
      return Promise.resolve(
        appendIoChunk(db, {
          runId,
          nodeId: chunk.nodeId,
          attempt: chunk.attempt + 1,
          stream: chunk.stream,
          ts: chunk.ts,
          data: chunk.data,
        }),
      );
    },
  };
}
