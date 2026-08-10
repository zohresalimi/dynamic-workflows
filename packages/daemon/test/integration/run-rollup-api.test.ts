/**
 * KAR-14.1 AC8 — the rollup an operator can actually reach.
 *
 * EPIC-14-S1's last three Then clauses are about a **response body**, not about
 * a projection:
 *
 * > And the run rollup at "GET /api/runs/r1" reports costUsd.subscription 0.42
 * > And the run rollup reports unaccounted []
 * > And the per-provider rollup has exactly one key "claude"
 *
 * Folding the ledger through `reduce()` in the spec and asserting on the result
 * proves the reducer; it does not prove that an operator, or the run timeline
 * in EPIC-17, can see the figure. So this file drives the whole path: the fake
 * exec-shim agent emits the scenario's `result` envelope, `runShimNode` writes
 * `budget.consumed` and `node.completed` into a real file-backed ledger, a real
 * DeFlowd HTTP server is bound over that same directory, and the assertion is
 * made against JSON that came back over a socket.
 *
 * The other half of AC8 is the sentence after it — *"updates live over the SSE
 * stream because `budget.consumed` is an ordinary ledger event — no separate
 * polling endpoint exists"*. Two claims, both asserted here: an event appended
 * after a client has connected arrives on `/api/stream` as an ordinary,
 * unnamed ledger frame carrying `id: <seq>` (docs/11-api-and-realtime.md §3),
 * and the route table contains no cost-shaped endpoint for a client to poll.
 *
 * Run "r1" in the flow file is shorthand; a `RunId` is `run_<ts>_<hex6>` by
 * schema (packages/core/src/ids.ts), so that is what the URL carries.
 *
 * Verifies: EPIC-14-S1 · KAR-14.1 AC8
 */

import {
  type EventRecord,
  type LedgerSink,
  runShimNode,
  shimCapabilityRow,
} from '@DeFlow/adapters';
import {
  type EventSeq,
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
  blobHandle,
  openLedger,
  readEpoch,
  spillBytes,
} from '@DeFlow/ledger';
import { authorizedFetch, it, linkFakeAgent, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';

/**
 * Every request this spec makes carries the daemon's bearer token (KAR-15.2).
 *
 * Assigned to a local `fetch` so the call sites below read the way they did
 * before the daemon authenticated anything — the token is a property of this
 * whole file, not a decision at each request.
 */
const fetch = authorizedFetch();

const RUN: RunId = RunIdSchema.parse('run_20260805T101500Z_ac0501');
// The flow file writes "n_impl_1"; a NodeId is a slug by schema, so the same
// node is spelled the way `NodeIdSchema` accepts.
const NODE: NodeId = NodeIdSchema.parse('n-impl-1');
const CLAUDE: ProviderId = ProviderIdSchema.parse('claude');
const SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const NOW = 1_800_000_000_000;

/** EPIC-14-S1's scripted turn: the figures the scenario names, verbatim. */
const S1_TURN = JSON.stringify({
  name: 'kar-14-1-turn',
  description: 'One headless turn whose result envelope carries the S1 figures.',
  steps: [{ type: 'message', text: 'ok' }],
  result: { subtype: 'success', text: 'ok', totalCostUsd: 0.42, inputTokens: 18_420 },
});

/** The production sink, minus the harness: `appendAll` is one transaction. */
function ledgerSink(db: ReturnType<typeof openLedger>, dataDir: string): LedgerSink {
  const epoch = readEpoch(db);
  const draft = (event: EventRecord) => ({
    runId: RUN,
    ts: event.ts,
    kind: event.kind,
    v: event.v,
    epoch,
    ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
    ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
    ...(event.ikey === undefined ? {} : { ikey: event.ikey }),
    payload: event.payload,
  });
  return {
    async append(event) {
      const [seq] = appendEvents(db, [draft(event)], { spillTo: dataDir });
      return seq as EventSeq;
    },
    async appendAll(events) {
      return appendEvents(db, events.map(draft), { spillTo: dataDir }) as EventSeq[];
    },
    async appendIo(chunk) {
      return appendIoChunk(db, {
        runId: RUN,
        nodeId: chunk.nodeId,
        attempt: chunk.attempt + 1,
        stream: chunk.stream,
        ts: chunk.ts,
        data: chunk.data,
      });
    },
  };
}

interface Served {
  readonly origin: string;
  readonly dataDir: string;
  readonly db: ReturnType<typeof openLedger>;
  close(): Promise<void>;
}

/** A real ledger with the S1 turn already in it, served by a real HTTP server. */
async function serveCompletedRun(tmp: string): Promise<Served> {
  const agent = await linkFakeAgent(tmp, 'claude');
  const dataDir = join(tmp, 'data');
  const worktree = join(tmp, 'wt');
  await mkdir(dataDir, { recursive: true });
  await mkdir(worktree, { recursive: true });

  const db = openLedger(dataDir);
  const sha256 = createHash('sha256').update(readFileSync(agent.binary)).digest('hex');

  const outcome = await runShimNode(
    {
      runId: RUN,
      nodeId: NODE,
      attempt: 0,
      provider: CLAUDE,
      permission: 'read',
      worktree,
      prompt: 'say ok',
      sessionId: SESSION,
      binary: { path: agent.binary, version: '2.1.220', sha256 },
      sandbox: {
        version: '2.1.220',
        platform: 'darwin',
        roots: [agent.binDir],
        configDir: join(tmp, 'sandbox'),
      },
      env: {
        ...process.env,
        DeFlow_FAKE_DIALECT: 'claude-stream-json',
        DeFlow_FAKE_SCENARIO: S1_TURN,
        DeFlow_FAKE_SEED: '42',
        DeFlow_FAKE_NOW: String(NOW),
        DeFlow_SIDE_EFFECT_LOG: join(tmp, 'side-effects.ndjson'),
      },
    },
    {
      clock: { now: () => NOW, setTimer: () => ({ cancel: () => {} }) },
      ledger: ledgerSink(db, dataDir),
      captureEvidence: (evidence) =>
        HandleSchema.parse(
          blobHandle(
            spillBytes(
              dataDir,
              typeof evidence === 'string' ? Buffer.from(evidence, 'utf8') : Buffer.from(evidence),
              'text/plain',
            ).sha256,
          ),
        ),
      capabilityRow: shimCapabilityRow({
        provider: CLAUDE,
        version: '2.1.220',
        binaryPath: agent.binary,
        binarySha256: sha256,
        probedAt: NOW,
      }),
    },
  );
  expect(outcome.status).toBe('completed');

  const view = openLedgerView(dataDir);
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
    dataDir,
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

suite('EPIC-14-S1 — the run rollup at GET /api/runs/:id (AC8)', () => {
  it('reports costUsd.subscription 0.42, unaccounted [] and one provider key', async ({ tmp }) => {
    served = await serveCompletedRun(tmp);

    const response = await fetch(`${served.origin}/api/runs/${RUN}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const body = (await response.json()) as {
      runId: string;
      budget: {
        run: { costUsd: { subscription: number | null }; unaccounted: string[] };
        providers: Record<string, unknown>;
        nodes: Record<string, unknown>;
      };
    };

    expect(body.runId).toBe(RUN);
    expect(body.budget.run.costUsd.subscription).toBeCloseTo(0.42, 6);
    expect(body.budget.run.unaccounted).toEqual([]);
    expect(Object.keys(body.budget.providers)).toEqual([CLAUDE]);
    expect(Object.keys(body.budget.nodes)).toEqual([NODE]);
  });

  it('404s a run the directory does not hold, rather than an empty rollup', async ({ tmp }) => {
    served = await serveCompletedRun(tmp);

    const missing = await fetch(`${served.origin}/api/runs/run_20260805T101500Z_ffffff`);
    expect(missing.status).toBe(404);
    expect((await missing.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'run_not_found' },
    });

    // A malformed id is the same answer, not a 500 out of the id schema.
    const malformed = await fetch(`${served.origin}/api/runs/r1`);
    expect(malformed.status).toBe(404);
  });

  it('serves the rollup from no endpoint of its own — the summary and the stream (AC8)', async ({
    tmp,
  }) => {
    served = await serveCompletedRun(tmp);

    // Nothing cost-shaped in the API's route table: a client that wants a
    // fresher figure reconnects the stream, it does not poll a second URL.
    const budgetish = await fetch(`${served.origin}/api/runs/${RUN}/budget`);
    expect(budgetish.status).toBe(404);
    const costish = await fetch(`${served.origin}/api/runs/${RUN}/cost`);
    expect(costish.status).toBe(404);
  });
});

suite('EPIC-14-S1 — budget.consumed reaches a client as an ordinary ledger frame (AC8)', () => {
  it('arrives on /api/stream after the client connected, carrying id: <seq>', async ({ tmp }) => {
    served = await serveCompletedRun(tmp);
    const { db, dataDir } = served;

    const controller = new AbortController();
    try {
      const response = await fetch(`${served.origin}/api/stream?runs=${RUN}&since=0`, {
        signal: controller.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const frames = readFrames(response, controller.signal);

      // Everything already in the ledger, replayed from the cursor: the
      // completed turn's own accounting event is in the backfill.
      const backfilled = await frames.until(
        (frame) => frame.event === undefined && frame.data.includes('"budget.consumed"'),
      );
      expect(Number(backfilled.id)).toBeGreaterThan(0);
      const backfilledPayload = JSON.parse(backfilled.data) as {
        seq: number;
        kind: string;
        payload: { costUsd: number };
      };
      expect(backfilledPayload.kind).toBe('budget.consumed');
      expect(backfilledPayload.seq).toBe(Number(backfilled.id));
      expect(backfilledPayload.payload.costUsd).toBeCloseTo(0.42, 6);

      // …and a *new* one, appended while the socket is open, arrives without
      // the client asking for it again.
      const epoch = readEpoch(db);
      const [seq] = appendEvents(
        db,
        [
          {
            runId: RUN,
            ts: NOW + 1,
            kind: 'budget.consumed',
            v: 2,
            epoch,
            nodeId: NODE,
            attempt: 1,
            payload: {
              node: NODE,
              attempt: 1,
              provider: CLAUDE,
              usage: { inputTokens: 10, outputTokens: 2, source: 'vendor-reported' },
              costUsd: 0.08,
              authMode: 'subscription',
            },
          },
        ],
        { spillTo: dataDir },
      );

      const live = await frames.until((frame) => frame.id === String(seq));
      expect(JSON.parse(live.data)).toMatchObject({
        kind: 'budget.consumed',
        payload: { costUsd: 0.08 },
      });
    } finally {
      controller.abort();
    }
  });
});

// ── a minimal SSE reader ─────────────────────────────────────────────────────

interface Frame {
  readonly id: string | undefined;
  readonly event: string | undefined;
  readonly data: string;
}

/**
 * Frames off a live `text/event-stream`, awaited one predicate at a time.
 *
 * Deliberately hand-rolled rather than `EventSource`: the assertions are about
 * the `id:` line and about an *unnamed* event type, and `EventSource` hides
 * both behind `onmessage`.
 */
function readFrames(
  response: Response,
  signal: AbortSignal,
): { until(match: (frame: Frame) => boolean): Promise<Frame> } {
  const body = response.body;
  if (body === null) throw new Error('the stream response carried no body');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  const seen: Frame[] = [];

  const pump = async (): Promise<Frame[]> => {
    const { value, done } = await reader.read();
    if (done) throw new Error('the stream closed before the expected frame arrived');
    buffered += decoder.decode(value, { stream: true });
    let boundary = buffered.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 2);
      const frame = parseFrame(block);
      if (frame !== null) seen.push(frame);
      boundary = buffered.indexOf('\n\n');
    }
    return seen;
  };

  return {
    async until(match): Promise<Frame> {
      for (;;) {
        const found = seen.find(match);
        if (found !== undefined) return found;
        if (signal.aborted) throw new Error('aborted before the expected frame arrived');
        await pump();
      }
    },
  };
}

function parseFrame(block: string): Frame | null {
  let id: string | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':') || line === '') continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'id') id = value;
    else if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  return { id, event, data: data.join('\n') };
}
