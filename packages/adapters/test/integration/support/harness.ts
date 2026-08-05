/**
 * What DeFlowd brings to an ACP turn, assembled for a spec: a real data
 * directory, a real file-backed ledger, and the ports `runAcpNode` is given in
 * production.
 *
 * File-backed, never `:memory:` — AC4 is a durability claim, and the only way
 * to observe "the append completed" is to read the `seq` a real SQLite
 * transaction assigned (docs/14-testing-strategy.md §7).
 *
 * The agent is the real `DeFlow-mock-agent` binary, spawned from its absolute
 * path: DeFlowd's `PATH` is not the user's login-shell `PATH`, so production
 * resolves and stores a path rather than looking a bare name up again at spawn
 * time (docs/07-provider-adapter-layer.md §4.3).
 */

import {
  type Db,
  type EventSeq,
  type Handle,
  HandleSchema,
  type NodeId,
  NodeIdSchema,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import {
  appendEvents,
  appendIoChunk,
  type BlobRef,
  blobHandle,
  openLedger,
  readEpoch,
  readIoChunks,
  readProviderCapabilities,
  readRange,
  recordProviderCapabilities,
  spillBytes,
} from '@DeFlow/ledger';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentBinary,
  CapabilityRow,
  CapabilityStore,
  EventRecord,
  IoRecord,
  LedgerSink,
} from '../../../src/index.ts';

/** The binary under test, absolute. Never a bare name looked up on PATH. */
export const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

export const SCENARIO_DIR = fileURLToPath(
  new URL('../../../../mock-agent/scenarios/', import.meta.url),
);

export const scenario = (name: string): string => join(SCENARIO_DIR, name);

export const RUN_ID: RunId = RunIdSchema.parse('run_20260805T101500Z_ac0501');
export const NODE_ID: NodeId = NodeIdSchema.parse('n1');
export const PROVIDER: ProviderId = ProviderIdSchema.parse('mock');

/** The binary descriptor `node.started` records: resolved path, version, digest. */
export function mockAgentBinary(): AgentBinary {
  return {
    path: MOCK_AGENT_BIN,
    version: '0.0.0',
    sha256: createHash('sha256').update(readFileSync(MOCK_AGENT_BIN)).digest('hex'),
  };
}

export interface TestLedger {
  readonly db: Db;
  readonly sink: LedgerSink;
  /** The `provider_capabilities` table, behind the port the probe writes
   * through — the real SQLite one, because a manifest that only lived in a Map
   * could not answer "what did the last daemon see". */
  readonly capabilities: CapabilityStore;
  readonly captureEvidence: (text: string) => Handle;
  /** Every control-plane event for the run, in `seq` order. */
  events(): { seq: EventSeq; kind: string; payload: Record<string, unknown> }[];
  /** Every data-plane chunk for the node attempt, in `seq` order. */
  chunks(attempt?: number): { seq: EventSeq; text: string }[];
  /** How many times `append` was called, and how long each one took to resolve. */
  readonly appends: { at: number; kind: string }[];
  /** A run-level event, the way the API that received an operator's request
   * would write it — no node, no attempt. */
  appendRunEvent(kind: string, payload: unknown): EventSeq;
  close(): void;
}

export interface TestLedgerOptions {
  /** Milliseconds of real delay inside each append, to make "the loop waited
   * for the durable write" observable rather than assumed. */
  readonly appendDelayMs?: number;
  /** Called before each append resolves, so a spec can sample the world while
   * the pull loop is blocked on the write. */
  readonly onAppend?: (kind: string) => void;
}

export function openTestLedger(dataDir: string, options: TestLedgerOptions = {}): TestLedger {
  const db = openLedger(dataDir);
  const epoch = readEpoch(db);
  const appends: { at: number; kind: string }[] = [];

  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const sink: LedgerSink = {
    async append(event: EventRecord): Promise<EventSeq> {
      options.onAppend?.(event.kind);
      if (options.appendDelayMs !== undefined) await delay(options.appendDelayMs);
      const [seq] = appendEvents(db, [
        {
          runId: RUN_ID,
          ts: event.ts,
          kind: event.kind,
          v: event.v,
          epoch,
          // Spread rather than assigned: a probe is not part of a node, so
          // `provider.probed` carries neither, and a bound `undefined` is not
          // the same thing as an absent column.
          ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
          ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
          ...(event.ikey === undefined ? {} : { ikey: event.ikey }),
          payload: event.payload,
        },
      ]);
      appends.push({ at: performance.now(), kind: event.kind });
      return seq as EventSeq;
    },
    async appendIo(chunk: IoRecord): Promise<EventSeq> {
      if (options.appendDelayMs !== undefined) await delay(options.appendDelayMs);
      return appendIoChunk(db, {
        runId: RUN_ID,
        nodeId: chunk.nodeId,
        // The data plane counts attempts from 1; the event envelope counts
        // from 0. The sink is where the two conventions meet.
        attempt: chunk.attempt + 1,
        stream: chunk.stream,
        ts: chunk.ts,
        data: chunk.data,
      });
    },
  };

  const capabilities: CapabilityStore = {
    record: (row: CapabilityRow) => recordProviderCapabilities(db, row),
    read: (provider: ProviderId): readonly CapabilityRow[] =>
      readProviderCapabilities(db, provider).map((stored) => ({
        ...stored,
        provider: ProviderIdSchema.parse(stored.provider),
      })),
  };

  return {
    db,
    sink,
    capabilities,
    appends,
    appendRunEvent(kind: string, payload: unknown): EventSeq {
      const [seq] = appendEvents(db, [{ runId: RUN_ID, ts: 0, kind, v: 1, epoch, payload }]);
      return seq as EventSeq;
    },
    captureEvidence: (text: string): Handle => {
      const ref: BlobRef = spillBytes(dataDir, Buffer.from(text, 'utf8'), 'text/plain');
      return HandleSchema.parse(blobHandle(ref.sha256));
    },
    events() {
      const collected: { seq: EventSeq; kind: string; payload: Record<string, unknown> }[] = [];
      let cursor = 0;
      for (;;) {
        const page = readRange(db, RUN_ID, cursor, 500);
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
    },
    chunks(attempt = 0) {
      const collected: { seq: EventSeq; text: string }[] = [];
      let cursor = 0;
      for (;;) {
        const page = readIoChunks(
          db,
          { runId: RUN_ID, nodeId: NODE_ID, attempt: attempt + 1 },
          cursor,
          500,
        );
        for (const chunk of page.chunks) {
          collected.push({ seq: chunk.seq, text: Buffer.from(chunk.data).toString('utf8') });
          cursor = chunk.seq;
        }
        if (!page.hasMore) return collected;
      }
    },
    close: () => {
      db.close();
    },
  };
}

/** The payload of the one event of `kind`, or undefined if there is none. */
export function eventOf(
  events: readonly { kind: string; payload: Record<string, unknown> }[],
  kind: string,
): Record<string, unknown> | undefined {
  return events.find((event) => event.kind === kind)?.payload;
}
