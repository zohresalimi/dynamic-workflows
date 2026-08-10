/**
 * KAR-15.3 AC1/AC2 — a real HTTP/1.1 SSE origin for the browser specs, on a
 * port of its own.
 *
 * ## Why a stand-in rather than DeFlowd itself
 *
 * Two reasons, and the second is the load-bearing one.
 *
 * `@DeFlow/web` may import `@DeFlow/daemon` **types only** (docs/16-repo-layout
 * §R2, enforced by `checkWebImportsDaemonTypesOnly`), so no daemon runtime can
 * be reached from this package — not from `src/`, and not from the config that
 * starts this server either, without making the UI a runtime consumer of the
 * daemon for the sake of a test.
 *
 * And it is not needed: what these specs measure is a **browser** property.
 * *"Six open streams exhaust the per-origin budget and a subsequent `fetch`
 * never resolves"* is a fact about Chrome's HTTP/1.1 socket pool, and *"the tab
 * holds exactly one connection with three panels open"* is a fact about
 * `../src/api/multiplex.ts`. Neither is a claim about the daemon's bytes. The
 * frame contract itself — `hello`, `retry: 2000`, `id: <seq>`, one-line `data`,
 * `: keepalive`, the headers, `runs=*`, the two-phase drain — is asserted
 * against a real DeFlowd on a real socket in
 * `packages/daemon/test/integration/stream-contract.test.ts` and
 * `stream-drain.test.ts`, which is the right level for it.
 *
 * So this server speaks the same wire shape the client needs and nothing more,
 * and it deliberately does **not** claim to be the contract.
 *
 * ## What is real here, and has to be
 *
 * - A real `node:http` server, which is HTTP/1.1. That is the whole premise:
 *   browsers refuse h2c, so localhost h2 would need TLS, and shipping a
 *   certificate for `127.0.0.1` is a worse problem than the one it solves.
 * - Real, never-closing responses. A stream that ended would hand the socket
 *   back and the cap would never be reached.
 * - A count of the streams currently open, read from the server side. *"The
 *   connection count for the origin is 1"* is not something a page can observe
 *   about itself, and inferring it from `performance` entries would be
 *   measuring resource loads rather than sockets.
 *
 * CORS is on because the page is served by Vite on a different port, and that
 * separation is deliberate: exhausting the socket pool of the origin serving
 * the test runner's own modules would wedge the run rather than demonstrate
 * anything. The cap is per origin, so a second origin isolates the blast radius
 * without weakening the demonstration. DeFlowd itself serves the UI from its
 * own origin and has no CORS at all (ADR 0011, D10).
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One event of the in-memory ledger this origin serves. */
interface StoredEvent {
  readonly seq: number;
  readonly runId: string;
  readonly kind: string;
  readonly ts: number;
  readonly v: number;
  readonly epoch: number;
  readonly payload: Record<string, unknown>;
}

interface OpenStream {
  readonly response: ServerResponse;
  readonly runs: Set<string>;
  cursor: number;
}

export interface SseOrigin {
  /** `http://127.0.0.1:<port>` — the origin the browser connects to. */
  readonly origin: string;
  close(): Promise<void>;
}

const T0 = 1_754_308_400_000;
const EPOCH = 5;

/** Every response carries these; a preflight carries them and nothing else. */
function cors(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function ledgerFrame(event: StoredEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

function controlFrame(name: string, payload: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
}

export async function startSseOrigin(): Promise<SseOrigin> {
  const streams = new Map<string, OpenStream>();
  const events: StoredEvent[] = [];

  /** Backfills one stream from its cursor, exactly as the daemon's drain does. */
  const drain = (stream: OpenStream): void => {
    for (const event of events) {
      if (event.seq <= stream.cursor) continue;
      if (!stream.runs.has(event.runId)) continue;
      stream.response.write(ledgerFrame(event));
      stream.cursor = event.seq;
    }
  };

  const server: Server = createServer((request, response) => {
    cors(response);
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }

    // The count of open streams, read off the server. This is the assertion
    // AC1 and AC2's second scenario are both about.
    if (url.pathname === '/__streams') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ open: streams.size }));
      return;
    }

    // The ordinary request that queues behind an exhausted socket pool. Its
    // body is irrelevant; that it resolves at all is the whole assertion.
    if (url.pathname === '/api/runs') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ runs: [] }));
      return;
    }

    // Appends to the ledger and fans out to whoever is subscribed. A spec's
    // way of saying "and then the run emitted these".
    if (url.pathname === '/__emit' && request.method === 'POST') {
      void readBody(request).then((body) => {
        const runs = (body as { runs?: unknown })?.runs;
        for (const runId of Array.isArray(runs) ? (runs as string[]) : []) {
          events.push({
            seq: events.length + 1,
            runId,
            kind: 'node.progress',
            ts: T0 + events.length,
            v: 1,
            epoch: EPOCH,
            payload: { node: 'n-impl-1', attempt: 1, phase: 'running' },
          });
        }
        for (const stream of streams.values()) drain(stream);
        response.writeHead(202).end('{}');
      });
      return;
    }

    if (url.pathname === '/api/stream') {
      const streamId = randomUUID();
      const runs = new Set(
        (url.searchParams.get('runs') ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter((value) => value !== ''),
      );
      const cursor = Number(url.searchParams.get('since') ?? '0');
      const stream: OpenStream = {
        response,
        runs,
        cursor: Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0,
      };
      streams.set(streamId, stream);

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
        connection: 'keep-alive',
      });
      response.write(
        controlFrame('hello', {
          streamId,
          apiVersion: 1,
          build: 'test',
          daemonEpoch: EPOCH,
          headSeq: events.length,
          runs: [...runs],
        }),
      );
      response.write('retry: 2000\n\n');
      drain(stream);
      for (const runId of runs) controlFrame('caught_up', { runId, seq: stream.cursor });

      // Never ended on purpose: a stream that closed would hand its socket back
      // to the pool, and the cap this file exists to demonstrate would never be
      // reached.
      request.on('close', () => {
        streams.delete(streamId);
      });
      return;
    }

    const subscribing = /^\/api\/stream\/([^/]+)\/subscribe$/.exec(url.pathname);
    if (subscribing !== null && request.method === 'POST') {
      const stream = streams.get(subscribing[1] ?? '');
      void readBody(request).then((body) => {
        if (stream === undefined) {
          response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
          return;
        }
        const asked = (body as { runs?: unknown })?.runs;
        const added = (Array.isArray(asked) ? (asked as string[]) : []).filter(
          (runId) => !stream.runs.has(runId),
        );
        for (const runId of added) stream.runs.add(runId);

        // Subscribe, then drain again — the order the daemon uses, so the
        // client is exercised against the frame sequence it will really see.
        stream.response.write(controlFrame('subscribed', { runs: [...stream.runs] }));
        drain(stream);
        for (const runId of added) {
          stream.response.write(controlFrame('caught_up', { runId, seq: stream.cursor }));
        }
        response.writeHead(202, { 'content-type': 'application/json' }).end('{}');
      });
      return;
    }

    response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const stream of streams.values()) stream.response.end();
      streams.clear();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      // Chrome keeps its sockets, and `server.close` only stops accepting new
      // ones — without this the run does not exit.
      server.closeAllConnections();
    },
  };
}
