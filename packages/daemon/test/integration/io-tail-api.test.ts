/**
 * EPIC-15-S40 — `GET /api/runs/:id/nodes/:nodeId/io`: the last N KB, never the
 * whole log.
 *
 * Integration, file-backed and over a real socket, because every claim is about
 * a real table: how much of it the query touches, how much of it reaches the
 * response, and how much of it the daemon's heap holds while it answers. A
 * fake db would let a handler that read every row pass all three.
 *
 * The log here is tens of megabytes rather than the scenario's 200, and the
 * difference is deliberate: the property is *"the response and the memory are
 * bounded by the window, not by the table"*, and a log two orders of magnitude
 * larger than the window proves it as well as one three orders larger while
 * keeping the suite runnable. The query-plan half — that the tail is an index
 * walk and not a sort — is pinned in
 * `packages/ledger/test/integration/io-tail.test.ts`.
 *
 * Verifies: EPIC-15-S40 · KAR-15.6 AC4, AC9, AC11 · test plan #4
 */
import type { RunId } from '@DeFlow/core';
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import {
  appendEvents,
  appendIoChunks,
  type Db,
  type EventDraft,
  type IoChunkDraft,
  openLedger,
} from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, describe as suite } from 'vitest';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';

const fetch = authorizedFetch();

const RUN: RunId = RunIdSchema.parse('run_20260810T101500Z_ac1540');
const NODE = NodeIdSchema.parse('n-impl');
const T0 = 1_754_812_800_000;

/** 20 KiB per chunk × 2,000 chunks ≈ 40 MB of agent output. */
const CHUNK_BYTES = 20 * 1024;
const CHUNKS = 2_000;
const LOG_BYTES = CHUNK_BYTES * CHUNKS;

const line = (ordinal: number): Uint8Array =>
  new TextEncoder().encode(
    `${String(ordinal).padStart(6, '0')} `.padEnd(CHUNK_BYTES - 1, 'x') + '\n',
  );

interface Served {
  readonly origin: string;
  readonly db: Db;
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
    // 1-based: the data plane counts attempts from 1 and the envelope from 0
    // (`src/exec/ledger-sink.ts`), so these are attempt 0's chunks.
    attempt: 1,
    stream: 'stdout' as const,
    ts: T0 + 2_000 + index,
    data: line(index),
  }));
  // In batches, because the point of the fixture is a large table rather than
  // a large transaction.
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
    async close() {
      await started.close();
      clearLedgerView();
      view.close();
      db.close();
    },
  };
}

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

const ndjson = (body: string): { seq: number; stream: string; ts: number; data: string }[] =>
  body
    .split('\n')
    .filter((entry) => entry !== '')
    .map((entry) => JSON.parse(entry) as { seq: number; stream: string; ts: number; data: string });

suite('tailing a very large log (EPIC-15-S40)', () => {
  it('answers NDJSON, one io_chunk per line, in the documented shape', async ({ tmp }) => {
    served = await serveBigLog(tmp);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/nodes/${NODE}/io?limit=200`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');

    const lines = ndjson(await response.text());
    expect(lines).toHaveLength(200);
    for (const entry of lines) {
      expect(Object.keys(entry).toSorted()).toEqual(['data', 'seq', 'stream', 'ts']);
      expect(entry.stream).toBe('stdout');
    }
  });

  it('returns the tail rather than the head', async ({ tmp }) => {
    served = await serveBigLog(tmp);

    const lines = ndjson(
      await (await fetch(`${served.origin}/api/runs/${RUN}/nodes/${NODE}/io?limit=200`)).text(),
    );

    // The last 200 of 2,000, in the order they were produced.
    expect(lines[0]?.data.startsWith('001800')).toBe(true);
    expect(lines.at(-1)?.data.startsWith('001999')).toBe(true);
    expect(lines.map((entry) => entry.seq)).toEqual(
      [...lines.map((entry) => entry.seq)].toSorted((left, right) => left - right),
    );
  });

  it('pages forward from a seq, deterministically', async ({ tmp }) => {
    served = await serveBigLog(tmp);

    const first = ndjson(
      await (await fetch(`${served.origin}/api/runs/${RUN}/nodes/${NODE}/io?limit=200`)).text(),
    );
    const cursor = first[0]?.seq ?? 0;

    const page = ndjson(
      await (
        await fetch(`${served.origin}/api/runs/${RUN}/nodes/${NODE}/io?fromSeq=${cursor}&limit=200`)
      ).text(),
    );

    // Strictly greater than the cursor, never `cursor + 1`: `io_chunk.seq` is
    // AUTOINCREMENT and pruning leaves permanent gaps, so a client resuming at
    // `cursor + 1` would skip a frame the day one is pruned.
    expect(page[0]?.seq).toBeGreaterThan(cursor);
    expect(page).toEqual(first.slice(1).concat(page.slice(199)));

    // And it is deterministic: the same request twice is the same bytes.
    const again = ndjson(
      await (
        await fetch(`${served.origin}/api/runs/${RUN}/nodes/${NODE}/io?fromSeq=${cursor}&limit=200`)
      ).text(),
    );
    expect(again).toEqual(page);
  });

  it('never loads the log into memory to serve a tail', async ({ tmp }) => {
    served = await serveBigLog(tmp);

    // A deliberately small window over a deliberately large table: twenty
    // chunks is 400 KB out of 40 MB, so the two costs are two orders of
    // magnitude apart and a handler that buffered the log could not hide
    // inside the noise.
    const windowBytes = 20 * CHUNK_BYTES;

    // The daemon is in this process, so its heap is this heap.
    const before = process.memoryUsage().heapUsed;
    const response = await fetch(`${served.origin}/api/runs/${RUN}/nodes/${NODE}/io?limit=20`);
    const body = await response.text();
    const after = process.memoryUsage().heapUsed;

    // The response is the window, not the table.
    expect(body.length).toBeLessThan(windowBytes * 2);
    // A wide margin over the window — heap measurement is noisy under a
    // parallel suite — and still far below the 40 MB that buffering the log
    // would cost, which is the failure this excludes.
    expect(after - before).toBeLessThan(LOG_BYTES / 4);
    expect(after - before).toBeLessThan(windowBytes * 12);
  });

  it('caps an oversized limit and says which bound it applied', async ({ tmp }) => {
    served = await serveBigLog(tmp);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/nodes/${NODE}/io?limit=1000000`);
    const bound = Number(response.headers.get('x-deflow-limit'));

    expect(bound).toBeLessThan(1_000_000);
    expect(ndjson(await response.text())).toHaveLength(bound);
  });

  it('marks the framing as outside the versioned contract (AC11)', async ({ tmp }) => {
    served = await serveBigLog(tmp);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/nodes/${NODE}/io?limit=1`);
    expect(response.headers.get('x-deflow-unversioned')).toMatch(
      /not part of the versioned contract/i,
    );
    // And it names the archive that *is* stable.
    expect(response.headers.get('x-deflow-unversioned')).toContain('stdout.log');
  });
});

/**
 * KAR-27.3 AC2 — the same endpoint, for the three turns that run before a plan
 * exists.
 *
 * `framing`, `recon` and `planner` never enter `RunState.nodes`: they have no
 * plan entry, no `node.scheduled` and no `node.started`, which is why this route
 * answered `404 node_not_found` for them until this story. AC2 says the io a
 * pre-execution turn now writes is served *"by the existing io-tail API"* — so
 * what changes is how the route resolves the node, and not the route.
 *
 * Verifies: EPIC-27-S17 · KAR-27.3 AC2
 */
const FRAMING = NodeIdSchema.parse('framing');

async function serveFramingTurn(tmp: string, sessions: number): Promise<Served> {
  const db = openLedger(tmp);

  // The run exists from intake; `run.created` is what framing is *on its way
  // to* appending, which is the whole state this scenario is about.
  appendEvents(db, [
    {
      runId: RUN,
      ts: T0,
      kind: 'task.submitted',
      v: 1,
      epoch: 1,
      payload: {
        sha256: 'a'.repeat(64),
        raw: 'Make the run look alive while it is framing',
        provenance: { kind: 'text', by: 'ui', submittedAt: T0 },
      },
    } as EventDraft,
  ]);

  appendEvents(
    db,
    Array.from(
      { length: sessions },
      (_unused, attempt): EventDraft =>
        ({
          runId: RUN,
          ts: T0 + attempt,
          kind: 'provider.session_opened',
          v: 1,
          epoch: 1,
          nodeId: FRAMING,
          attempt,
          payload: {
            node: FRAMING,
            attempt,
            provider: 'claude',
            session: { id: `9d1f0f2a-0000-4000-8000-00000000000${attempt}`, origin: 'minted' },
          },
        }) as EventDraft,
    ),
  );

  appendIoChunks(
    db,
    Array.from({ length: sessions }, (_unused, attempt) => ({
      runId: RUN,
      nodeId: FRAMING,
      // 1-based, the same translation the execution path applies.
      attempt: attempt + 1,
      stream: 'stdout' as const,
      ts: T0 + 100 + attempt,
      data: new TextEncoder().encode(
        `{"type":"assistant","turn":${String(attempt)},"text":"reading the repository"}\n`,
      ),
    })),
  );

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
    async close() {
      await started.close();
      clearLedgerView();
      view.close();
      db.close();
    },
  };
}

suite('a pre-execution turn is served by the same endpoint (EPIC-27-S17)', () => {
  it('answers the framing turn’s output rather than 404 node_not_found', async ({ tmp }) => {
    served = await serveFramingTurn(tmp, 1);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/nodes/framing/io?limit=50`);
    expect(response.status).toBe(200);

    const lines = ndjson(await response.text());
    expect(lines).toHaveLength(1);
    expect(lines[0]?.data).toContain('reading the repository');
  });

  it('defaults to the latest child, so a repair does not serve the turn it repaired', async ({
    tmp,
  }) => {
    served = await serveFramingTurn(tmp, 2);

    const latest = ndjson(
      await (await fetch(`${served.origin}/api/runs/${RUN}/nodes/framing/io?limit=50`)).text(),
    );
    expect(latest.map((entry) => entry.data.includes('"turn":1'))).toEqual([true]);

    // And the earlier transcript is still addressable, on the envelope's own
    // 0-based numbering.
    const first = ndjson(
      await (
        await fetch(`${served.origin}/api/runs/${RUN}/nodes/framing/io?attempt=0&limit=50`)
      ).text(),
    );
    expect(first.map((entry) => entry.data.includes('"turn":0'))).toEqual([true]);
  });

  it('still 404s a node the run has never mentioned at all', async ({ tmp }) => {
    served = await serveFramingTurn(tmp, 1);

    const response = await fetch(`${served.origin}/api/runs/${RUN}/nodes/recon/io`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'node_not_found',
    );
  });
});
