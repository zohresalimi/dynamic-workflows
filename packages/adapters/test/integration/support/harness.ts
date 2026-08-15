/**
 * What DeFlowd brings to an ACP turn, assembled for a spec: a real data
 * directory, a real file-backed ledger, and the ports `runAcpNode` is given in
 * production.
 *
 * File-backed, never `:memory:` — AC4 is a durability claim, and the only way
 * to observe "the append completed" is to read the `seq` a real SQLite
 * transaction assigned (docs/14-testing-strategy.md §7).
 *
 * The agent is the real `deflow-mock-agent` binary, spawned from its absolute
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
  appendEventsWithProcess,
  appendIoChunk,
  type BlobRef,
  blobHandle,
  clearProcess,
  getBlob,
  openLedger,
  type ProcessRow,
  readEpoch,
  readIoChunks,
  readProcesses,
  readProviderCapabilities,
  readRange,
  recordProviderCapabilities,
  spillBytes,
} from '@DeFlow/ledger';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AgentBinary,
  AgentProcessKey,
  AgentProcessRecord,
  CapabilityRow,
  CapabilityStore,
  EventRecord,
  IoRecord,
  LedgerSink,
  ProcessRegistry,
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
  /** The real `process` table, behind the port `runAcpNode` writes through —
   * the row a *later* daemon's reaper reads (KAR-05.9 AC6). */
  readonly processes: ProcessRegistry;
  /** Every `process` row, terminal ones included. */
  processRows(): readonly ProcessRow[];
  readonly captureEvidence: (evidence: string | Uint8Array) => Handle;
  /**
   * A context segment's bytes, by its `contentHash` — the port a replay resume
   * rebuilds a prompt through (KAR-05.5).
   *
   * `Segment.contentHash` is `sha256-<hex>` and a blob handle is
   * `artifact://<hex>`: the same digest of the same bytes, spelled for two
   * different readers. The store verifies the hash on read, so a corrupted
   * blob raises rather than answering.
   */
  readonly readSegmentText: (contentHash: string) => string | null;
  /**
   * Every control-plane event for the run, in `seq` order.
   *
   * `v` comes back with the row because a spec that wants to fold the ledger
   * through the real reducer has to hand `parseEvent` the version the writer
   * used — the upcaster chain is what a v1 payload is lifted by, and guessing
   * the current version here would route around the one mechanism that makes
   * an old ledger readable.
   */
  events(): { seq: EventSeq; v: number; kind: string; payload: Record<string, unknown> }[];
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
      // `spillTo` is what makes AC5 true of *every* event and not only of the
      // ones the adapter thought to spill itself: a payload over 256 KiB is
      // written to `<dataDir>/blobs/` and the row keeps
      // `{ sha256, bytes, mime, head, tail }` (KAR-03.9). Without it the ledger
      // refuses the batch, which is the right default for a caller that has not
      // wired a blob store and the wrong one for a daemon that has.
      const [seq] = appendEvents(
        db,
        [
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
        ],
        { spillTo: dataDir },
      );
      appends.push({ at: performance.now(), kind: event.kind });
      return seq as EventSeq;
    },
    /**
     * KAR-14.1 AC1 — the whole batch in one `BEGIN IMMEDIATE`, which is the
     * only reason the port has this method: `budget.consumed` and
     * `node.completed` must not have an instant between them for a crash to
     * land in. The recorded `kind` joins the batch with `+` so a spec can
     * assert it was *one* call rather than two that happened to be adjacent.
     */
    async appendAll(events: readonly EventRecord[]): Promise<readonly EventSeq[]> {
      for (const event of events) options.onAppend?.(event.kind);
      if (options.appendDelayMs !== undefined) await delay(options.appendDelayMs);
      const seqs = appendEvents(
        db,
        events.map((event) => ({
          runId: RUN_ID,
          ts: event.ts,
          kind: event.kind,
          v: event.v,
          epoch,
          ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
          ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
          ...(event.ikey === undefined ? {} : { ikey: event.ikey }),
          payload: event.payload,
        })),
        { spillTo: dataDir },
      );
      appends.push({ at: performance.now(), kind: events.map((event) => event.kind).join('+') });
      return seqs as EventSeq[];
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

  const processes: ProcessRegistry = {
    async appendWithProcess(event: EventRecord, row: AgentProcessRecord): Promise<EventSeq> {
      options.onAppend?.(event.kind);
      if (options.appendDelayMs !== undefined) await delay(options.appendDelayMs);
      // One transaction for the pair: `appendEventsWithProcess` is the whole
      // point of the port, and a harness that wrote them separately would make
      // AC6 untestable while looking identical from outside.
      const [seq] = appendEventsWithProcess(
        db,
        [
          {
            runId: RUN_ID,
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
      appends.push({ at: performance.now(), kind: event.kind });
      return seq as EventSeq;
    },
    async clear(key: AgentProcessKey): Promise<void> {
      clearProcess(db, key);
    },
  };

  return {
    db,
    sink,
    capabilities,
    processes,
    processRows: () => readProcesses(db),
    appends,
    appendRunEvent(kind: string, payload: unknown): EventSeq {
      const [seq] = appendEvents(db, [{ runId: RUN_ID, ts: 0, kind, v: 1, epoch, payload }]);
      return seq as EventSeq;
    },
    captureEvidence: (evidence: string | Uint8Array): Handle => {
      // Bytes stay bytes: the frame-cap evidence is a byte-exact slice of what
      // arrived, and re-encoding it through a string would change its length.
      const bytes =
        typeof evidence === 'string' ? Buffer.from(evidence, 'utf8') : Buffer.from(evidence);
      const ref: BlobRef = spillBytes(
        dataDir,
        bytes,
        typeof evidence === 'string' ? 'text/plain' : 'application/octet-stream',
      );
      return HandleSchema.parse(blobHandle(ref.sha256));
    },
    readSegmentText: (contentHash: string): string | null => {
      try {
        return Buffer.from(
          getBlob(dataDir, `artifact://${contentHash.replace(/^sha256-/, '')}`),
        ).toString('utf8');
      } catch {
        // Gone, or no longer hashing to its own name. Both are "not there" to
        // a caller that must refuse rather than send different bytes.
        return null;
      }
    },
    events() {
      const collected: {
        seq: EventSeq;
        v: number;
        kind: string;
        payload: Record<string, unknown>;
      }[] = [];
      let cursor = 0;
      for (;;) {
        const page = readRange(db, RUN_ID, cursor, 500);
        for (const event of page.events) {
          collected.push({
            seq: event.seq,
            v: event.v,
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

/**
 * Live processes in the child's group, **excluding zombies**.
 *
 * After a successful group SIGKILL the OS still lists the members as `Z` until
 * their parent collects them, and an assertion that counts those concludes the
 * kill failed when it did not (docs/14-testing-strategy.md §10).
 */
export function liveInGroup(pgid: number): string[] {
  try {
    return execFileSync('ps', ['-o', 'pid=,stat=', '-g', String(pgid)], { encoding: 'utf8' })
      .split('\n')
      .map((row) => row.trim())
      .filter((row) => row !== '' && !/\sZ/.test(row) && !row.endsWith('Z'));
  } catch {
    // `ps` exits non-zero when the group is empty, which is the answer.
    return [];
  }
}

/** The bytes behind an evidence handle, verified against their own digest. */
export function readEvidence(dataDir: string, handle: Handle | string): Uint8Array {
  return getBlob(dataDir, handle);
}

/** The payload of the one event of `kind`, or undefined if there is none. */
export function eventOf(
  events: readonly { kind: string; payload: Record<string, unknown> }[],
  kind: string,
): Record<string, unknown> | undefined {
  return events.find((event) => event.kind === kind)?.payload;
}
