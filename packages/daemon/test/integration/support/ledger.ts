/**
 * A real, file-backed ledger behind the `LedgerSink` port the MCP host writes
 * through.
 *
 * File-backed and never `:memory:`: the claim under test is that a tool call
 * an agent made is *durable* and visible to a later reader, and only a real
 * SQLite transaction assigning a real `seq` observes that
 * (docs/14-testing-strategy.md §7).
 */
import type { LedgerSink, ProcessRegistry } from '@DeFlow/adapters';
import type { Db, EventSeq, RunId } from '@DeFlow/core';
import { openLedger, readEpoch, readRange } from '@DeFlow/ledger';
import { sqliteLedgerSink } from '../../../src/exec/ledger-sink.ts';
import { sqliteProcessRegistry } from '../../../src/exec/process-registry.ts';

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

/**
 * The `LedgerSink` every integration spec that drives a real agent turn writes
 * through, over a real file-backed database.
 *
 * Re-exported from `src/exec/ledger-sink.ts` rather than reimplemented: this is
 * the sink DeFlowd itself hands an adapter, and a spec that wrote through a
 * near-copy would be asserting against a port nothing in production uses —
 * `appendAll`'s single transaction above all (KAR-14.1 AC1).
 */
export { sqliteLedgerSink, sqliteProcessRegistry };

export function openTestLedger(dataDir: string, runId: RunId): TestLedger {
  const db = openLedger(dataDir);
  const epoch = readEpoch(db);

  const sink = sqliteLedgerSink({ db, runId, epoch, dataDir });

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

  // KAR-23.5 — the production registry, not a near-copy. It lived only here
  // until the day an execution node needed one and `liveAgentPerformer` passed
  // none, so the kill switch answered `nothing-running` while three vendor
  // children were alive; a spec asserting against a second implementation
  // would have been green through all of it.
  const processes: ProcessRegistry = sqliteProcessRegistry({ db, runId, epoch, dataDir });

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
