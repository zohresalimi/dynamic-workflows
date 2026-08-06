/**
 * A real, file-backed ledger behind the `LedgerSink` port the MCP host writes
 * through.
 *
 * File-backed and never `:memory:`: the claim under test is that a tool call
 * an agent made is *durable* and visible to a later reader, and only a real
 * SQLite transaction assigning a real `seq` observes that
 * (docs/14-testing-strategy.md §7).
 */
import type {
  AgentProcessKey,
  AgentProcessRecord,
  EventRecord,
  IoRecord,
  LedgerSink,
  ProcessRegistry,
} from '@DeFlow/adapters';
import type { Db, EventSeq, RunId } from '@DeFlow/core';
import {
  appendEvents,
  appendEventsWithProcess,
  appendIoChunk,
  clearProcess,
  openLedger,
  readEpoch,
  readRange,
} from '@DeFlow/ledger';

export interface TestLedger {
  readonly db: Db;
  readonly sink: LedgerSink;
  /**
   * The real `process` table, behind the port `runAcpNode` writes through.
   *
   * A spec that cancels a live agent needs the row the kill switch reads: pid,
   * pgid and the OS's own start time, written in the same transaction as
   * `node.started` (KAR-05.9 AC6).
   */
  readonly processes: ProcessRegistry;
  events(): { seq: EventSeq; kind: string; payload: Record<string, unknown> }[];
  eventsOf(kind: string): Record<string, unknown>[];
  close(): void;
}

export function openTestLedger(dataDir: string, runId: RunId): TestLedger {
  const db = openLedger(dataDir);
  const epoch = readEpoch(db);

  const sink: LedgerSink = {
    append(event: EventRecord): Promise<EventSeq> {
      const [seq] = appendEvents(
        db,
        [
          {
            runId,
            ts: event.ts,
            kind: event.kind,
            v: event.v,
            epoch,
            ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
            ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
            ...(event.ikey === undefined ? {} : { ikey: event.ikey }),
            payload: event.payload,
          },
        ],
        { spillTo: dataDir },
      );
      return Promise.resolve(seq as EventSeq);
    },
    appendIo(chunk: IoRecord): Promise<EventSeq> {
      // The MCP host writes none of these; a real ACP turn writes many, and
      // this sink serves both. The data plane counts attempts from 1 and the
      // event envelope from 0, and the sink is where the two conventions meet.
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

  const events = (): { seq: EventSeq; kind: string; payload: Record<string, unknown> }[] => {
    const collected: { seq: EventSeq; kind: string; payload: Record<string, unknown> }[] = [];
    let cursor = 0;
    for (;;) {
      const page = readRange(db, runId, cursor, 500);
      for (const event of page.events) {
        collected.push({
          seq: event.seq,
          kind: event.kind,
          payload: event.payload as Record<string, unknown>,
        });
        cursor = event.seq;
      }
      if (!page.hasMore) return collected;
    }
  };

  const processes: ProcessRegistry = {
    appendWithProcess(event: EventRecord, row: AgentProcessRecord): Promise<EventSeq> {
      const [seq] = appendEventsWithProcess(
        db,
        [
          {
            runId,
            ts: event.ts,
            kind: event.kind,
            v: event.v,
            epoch,
            ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
            ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
            ...(event.ikey === undefined ? {} : { ikey: event.ikey }),
            payload: event.payload,
          },
        ],
        row,
        { spillTo: dataDir },
      );
      return Promise.resolve(seq as EventSeq);
    },
    clear(key: AgentProcessKey): Promise<void> {
      clearProcess(db, key);
      return Promise.resolve();
    },
  };

  return {
    db,
    sink,
    processes,
    events,
    eventsOf: (kind: string) =>
      events()
        .filter((e) => e.kind === kind)
        .map((e) => e.payload),
    close: () => {
      db.close();
    },
  };
}
