/**
 * KAR-23.5 — the `process` table, behind the port an adapter writes through.
 *
 * `@DeFlow/adapters` depends on `@DeFlow/core` alone (docs/16-repo-layout.md
 * R2), so the row an agent's spawn produces reaches SQLite through
 * `ProcessRegistry`; this is the daemon's side of that port, and — like
 * `./ledger-sink.ts` — there is deliberately one of it.
 *
 * **It existed only in a test until now, and that is the whole of the
 * 2026-08-24 incident's third symptom.** `packages/daemon/test/integration/
 * support/ledger.ts` has had this implementation since KAR-05.9 and
 * `liveAgentPerformer` passed no `processes` port at all — so a live execution
 * node wrote no row, `cancelNode` and `killRun` read `process` and found
 * nothing, and the operator's kill switch answered `nothing-running` while
 * three vendor children were alive. A port whose only implementation is in a
 * test is a mechanism that has never run in production.
 *
 * `appendEventsWithProcess` and not an append followed by an upsert: the row
 * and the `node.started` that explains it land in **one** transaction (KAR-05.9
 * AC6). Split, a crash between them leaves either a pid nothing will ever
 * reclaim or a started node with no group to reach — and both are silent.
 */
import type {
  AgentProcessKey,
  AgentProcessRecord,
  EventRecord,
  ProcessRegistry,
} from '@DeFlow/adapters';
import type { Db, EventSeq, RunId } from '@DeFlow/core';
import { appendEventsWithProcess, clearProcess } from '@DeFlow/ledger';

export interface ProcessRegistryOptions {
  readonly db: Db;
  readonly runId: RunId;
  /** This daemon life's epoch, stamped on the event appended here. */
  readonly epoch: number;
  /** Where an oversized payload spills. Omitted means the ledger refuses one. */
  readonly dataDir?: string;
}

export function sqliteProcessRegistry(options: ProcessRegistryOptions): ProcessRegistry {
  const { db, runId, epoch } = options;
  const appendOptions = options.dataDir === undefined ? {} : { spillTo: options.dataDir };

  return {
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
        appendOptions,
      );
      return Promise.resolve(seq as EventSeq);
    },
    clear(key: AgentProcessKey): Promise<void> {
      clearProcess(db, key);
      return Promise.resolve();
    },
  };
}
