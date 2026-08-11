/**
 * KAR-17.5 test plan row 9 — reattach after a panel close, against a real
 * daemon and a real file-backed ledger.
 *
 * Verifies: EPIC-17-S20 (scenarios 1, 2 and 3) · AC6
 *
 * The row's red is *"reattach re-reads the archive"*, and no browser spec can
 * see that: the panel would render the same lines either way, and the
 * difference is entirely in **how much of a SQLite table the daemon touched**.
 * So this is integration — a real `io_chunk` table with a real 40 MB of agent
 * output in it, a real HTTP server, and the web package's own client module
 * doing the asking.
 *
 * The claim is about bytes over the wire. A build that fetched the whole log
 * and sliced it in the tab passes every assertion about what rendered and fails
 * the one below by two orders of magnitude, which is the whole point of putting
 * this at this level.
 */
import type { RunId } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { clearLedgerView, openLedgerView, setLedgerView, startHttp } from '@DeFlow/daemon';
import {
  appendEvents,
  appendIoChunks,
  type EventDraft,
  type IoChunkDraft,
  openLedger,
} from '@DeFlow/ledger';
import { it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, describe as suite } from 'vitest';
import { createClient } from '../../src/api/client.ts';
import { readIoSince, readIoTail } from '../../src/api/io-tail.ts';
import { IO_TAIL_CHUNKS } from '../../src/lib/node-output.ts';

const RUN: RunId = RunIdSchema.parse('run_20260810T101500Z_ac1540');
const NODE = NodeIdSchema.parse('n-impl');
const T0 = 1_754_812_800_000;

/** 20 KiB per chunk × 2,000 chunks ≈ 40 MB of output on disk. */
const CHUNK_BYTES = 20 * 1024;
const CHUNKS = 2_000;
const LOG_BYTES = CHUNK_BYTES * CHUNKS;

const line = (ordinal: number): Uint8Array =>
  new TextEncoder().encode(
    `${String(ordinal).padStart(6, '0')} `.padEnd(CHUNK_BYTES - 1, 'x') + '\n',
  );

interface Served {
  readonly origin: string;
  readonly db: ReturnType<typeof openLedger>;
  /** Every request the client made, with the query it carried. */
  readonly asked: { path: string; limit: string | null; fromSeq: string | null }[];
  /** Bytes of response body the client has read. */
  bytesRead: number;
  close(): Promise<void>;
}

async function serveBigLog(tmp: string): Promise<Served> {
  const db = openLedger(tmp);

  const draft = (kind: string, payload: unknown, over: Partial<EventDraft> = {}): EventDraft =>
    ({ runId: RUN, ts: T0, kind, v: 1, epoch: 1, payload, ...over }) as EventDraft;

  appendEvents(db, [
    draft('run.created', {
      spec: {
        schemaId: 'DeFlow.taskspec.v1',
        goal: 'produce a great deal of output',
        scope: { included: [] },
        nonGoals: [],
        constraints: [],
        priorDecisions: [],
        acceptanceCriteria: [{ id: 'ac-1', statement: 'the terminal reattaches' }],
        knownFailureModes: [],
        approvedBy: null,
        specHash: `sha256-${'2'.repeat(64)}`,
      },
      cwd: '/workspace/repo',
      repo: { head: 'abcdef1', branch: 'main' },
    }),
    draft('node.scheduled', { node: NODE, provider: 'claude', permission: 'worktree' }),
    draft(
      'node.started',
      {
        node: NODE,
        attempt: 0,
        ikey: `${RUN}/${NODE}/0/0`,
        binary: { path: '/opt/claude/bin/claude', version: '0.64.1', sha256: 'd'.repeat(64) },
      },
      { nodeId: NODE, attempt: 0, ts: T0 + 1_000 },
    ),
  ]);

  const chunks: IoChunkDraft[] = Array.from({ length: CHUNKS }, (_unused, index) => ({
    runId: RUN,
    nodeId: NODE,
    // 1-based: the data plane counts attempts from 1 and the envelope from 0.
    attempt: 1,
    stream: 'stdout' as const,
    ts: T0 + 2_000 + index,
    data: line(index),
  }));
  for (let offset = 0; offset < chunks.length; offset += 200) {
    appendIoChunks(db, chunks.slice(offset, offset + 200));
  }

  const view = openLedgerView(tmp);
  setLedgerView(view);
  const started = await startHttp({
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
    token: TEST_DAEMON_TOKEN,
  });
  const address = started.server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    db,
    asked: [],
    bytesRead: 0,
    async close() {
      await started.close();
      clearLedgerView();
      view.close();
      db.close();
    },
  };
}

/**
 * The web package's own typed client, pointed at the real daemon, with a
 * `fetch` that records what went out and weighs what came back.
 *
 * Recording rather than stubbing: the request is the real one, the response is
 * the real one, and the tape is the only thing added.
 */
function watchedClient(served: Served) {
  return createClient({
    baseUrl: `${served.origin}/api`,
    token: () => TEST_DAEMON_TOKEN,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input.toString());
      served.asked.push({
        path: url.pathname,
        limit: url.searchParams.get('limit'),
        fromSeq: url.searchParams.get('fromSeq'),
      });
      const response = await fetch(input as never, init);
      const body = await response.text();
      served.bytesRead += new TextEncoder().encode(body).byteLength;
      return new Response(body, {
        status: response.status,
        headers: response.headers,
      });
    }) as typeof fetch,
  });
}

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

suite('EPIC-17-S20 — open, follow, close, reattach', () => {
  it('asks for the tail on the first open, and never for the whole log', async ({ tmp }) => {
    served = await serveBigLog(tmp);
    const client = watchedClient(served);

    const page = await readIoTail(client, RUN, NODE);

    expect(page.chunks).toHaveLength(IO_TAIL_CHUNKS);
    // The last N, in the order they were produced — a head read would start at
    // 000000 and would still render perfectly plausibly.
    expect(page.chunks[0]?.data.startsWith('001500')).toBe(true);
    expect(page.chunks.at(-1)?.data.startsWith('001999')).toBe(true);

    expect(served.asked).toHaveLength(1);
    expect(served.asked[0]?.fromSeq).toBeNull();
    expect(served.asked[0]?.limit).toBe(String(IO_TAIL_CHUNKS));

    // **Bounded by the window, not by the table.** These chunks are 20 KiB
    // each, which is large for agent output, so 500 of them is a real 10 MB —
    // and that is the honest number: the response is the size of what was
    // asked for, plus NDJSON's own escaping, whatever the log behind it
    // weighs. The 10% allowance is that escaping and nothing else.
    expect(served.bytesRead).toBeLessThan(IO_TAIL_CHUNKS * CHUNK_BYTES * 1.1);
    expect(served.bytesRead).toBeLessThan(LOG_BYTES);
  });

  it('scales the response with the limit rather than with the table', async ({ tmp }) => {
    served = await serveBigLog(tmp);
    const client = watchedClient(served);

    await readIoTail(client, RUN, NODE, 50);
    const small = served.bytesRead;

    await readIoTail(client, RUN, NODE, 200);
    const larger = served.bytesRead - small;

    // Four times the window, about four times the bytes — which is what
    // distinguishes a bounded read from a whole-table read that happens to be
    // trimmed before it is returned.
    expect(larger / small).toBeGreaterThan(3.5);
    expect(larger / small).toBeLessThan(4.5);
  });

  it('reattaches with a tail request, not by re-reading the archive', async ({ tmp }) => {
    served = await serveBigLog(tmp);
    const client = watchedClient(served);

    // Open.
    const first = await readIoTail(client, RUN, NODE);
    const cursor = first.chunks.at(-1)?.seq ?? 0;

    // Follow, the way a live panel does while it is open.
    await readIoSince(client, RUN, NODE, cursor, 100);

    // Close — the panel drops its bytes and keeps only the serialised snapshot
    // string — and reattach.
    const again = await readIoTail(client, RUN, NODE);

    const io = served.asked.filter((one) => one.path.endsWith('/io'));
    expect(io).toHaveLength(3);
    // The reattach: a tail, exactly like the first open. A build that resumed
    // from `fromSeq: 0` — "page forward from the beginning to catch up" —
    // sends the same three requests and reads the whole table to answer the
    // third.
    expect(io[2]?.fromSeq).toBeNull();
    expect(io[2]?.limit).toBe(String(IO_TAIL_CHUNKS));
    expect(again.chunks.at(-1)?.seq).toBe(first.chunks.at(-1)?.seq);

    // Three requests: two windows of 500 and one of 100, and nothing else. A
    // reattach that paged from zero would read the 40 MB table to answer the
    // third and this number would be the log.
    expect(served.bytesRead).toBeLessThan((IO_TAIL_CHUNKS * 2 + 100) * CHUNK_BYTES * 1.1);
    expect(served.bytesRead).toBeLessThan(LOG_BYTES);
  });

  it('reports more behind the window rather than silently truncating', async ({ tmp }) => {
    served = await serveBigLog(tmp);
    const client = watchedClient(served);

    const page = await readIoTail(client, RUN, NODE, 100);

    // `X-DeFlow-Io-More` is how the panel knows the archive is bigger than the
    // tail it is showing — which is what makes "Open full log" an honest offer
    // rather than a button that duplicates the pane beside it.
    expect(page.hasMore).toBe(true);
    expect(page.chunks).toHaveLength(100);
  });
});
