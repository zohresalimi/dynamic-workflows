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
  /** `?runs=*` — the low-volume lifecycle topic, not "every run". */
  readonly global: boolean;
  /**
   * One cursor per subscribed run, exactly as the daemon's serving loop keeps
   * them, plus the cursor the *connection* opened at. A run subscribed after
   * the fact is backfilled from `openedAt`, which is what makes the overlap
   * window EPIC-16-S24 is about a designed-in property rather than a bug.
   */
  readonly cursors: Map<string, number>;
  readonly openedAt: number;
  globalCursor: number;
}

/** What a stream was asked for when it opened. Read by the specs. */
interface Opened {
  /** The `?since=` the client sent, or `null` when it sent none at all. */
  readonly since: number | null;
  readonly runs: readonly string[];
  /** The `Last-Event-ID` header the browser supplied, if any. */
  readonly lastEventId: string | null;
}

export interface SseOrigin {
  /** `http://127.0.0.1:<port>` — the origin the browser connects to. */
  readonly origin: string;
  close(): Promise<void>;
}

const T0 = 1_754_308_400_000;
const EPOCH = 5;

/**
 * KAR-15.3 AC10 / KAR-25.7 — what `runs=*` delivers, and what it does not.
 *
 * The same five kinds `packages/daemon/src/http/sse.ts` admits. Kept in step by
 * `packages/daemon/test/integration/stream-contract.test.ts`, which asserts the
 * membership against a real DeFlowd; this copy exists so a browser spec can
 * watch an idle global tab receive zero `node.progress` frames.
 */
const GLOBAL_TOPIC_KINDS: readonly string[] = [
  'run.created',
  'run.completed',
  'run.aborted',
  'human.requested',
  'human.responded',
];

/** A payload each kind's schema in @DeFlow/core actually accepts. */
function payloadFor(kind: string): Record<string, unknown> {
  if (kind === 'run.completed' || kind === 'run.aborted') {
    return { outcome: 'succeeded', criteriaSatisfied: [] };
  }
  return { node: 'n-impl-1', attempt: 1, phase: 'running' };
}

/** Every response carries these; a preflight carries them and nothing else. */
function cors(response: ServerResponse): void {
  response.setHeader('Access-Control-Allow-Origin', '*');
  // `last-event-id` is here because the browser adds it *itself* on its own
  // automatic reconnect of a connection that had received an `id:` — which is
  // precisely the one case docs/11 §4.1 says the header exists for. Leaving it
  // out makes every reconnect fail the CORS preflight with "Failed to fetch",
  // which reads as a broken client and is not one. DeFlowd serves the UI from
  // its own origin and has no CORS at all (ADR 0011, D10).
  response.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, last-event-id');
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
  const opens: Opened[] = [];
  /** The `hello` this origin will announce next. Mutated by `/__daemon`. */
  let daemon = { epoch: EPOCH, build: 'test' };
  let accepted = 0;
  let nextSeq = 0;

  /**
   * Backfills one stream from its cursors, exactly as the daemon's drain does:
   * per run, merge-sorted by `seq`, and the global topic on a cursor of its own
   * because it is not a run.
   */
  const drain = (stream: OpenStream): void => {
    for (const event of events) {
      if (stream.runs.has(event.runId)) {
        if (event.seq > (stream.cursors.get(event.runId) ?? stream.openedAt)) {
          stream.response.write(ledgerFrame(event));
          stream.cursors.set(event.runId, event.seq);
        }
        continue;
      }
      if (stream.global && GLOBAL_TOPIC_KINDS.includes(event.kind)) {
        if (event.seq > stream.globalCursor) {
          stream.response.write(ledgerFrame(event));
          stream.globalCursor = event.seq;
        }
      }
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
    // AC1 and AC2's second scenario are both about. `accepted` is the same
    // number over the connection's whole life, which is how a spec tells "it
    // reconnected once" from "it never dropped".
    if (url.pathname === '/__streams') {
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ open: streams.size, accepted, opens }));
      return;
    }

    // `GET /api/runs/:id/events?since&limit` — the hydrate endpoint, paged on
    // the cursor it returns rather than on an offset, as §7.2 specifies.
    const hydrating = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (hydrating !== null) {
      const runId = decodeURIComponent(hydrating[1] ?? '');
      const since = Number(url.searchParams.get('since') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '1000');
      const mine = events.filter((event) => event.runId === runId);
      const after = mine.filter((event) => event.seq > since);
      const page = after.slice(0, Number.isSafeInteger(limit) && limit > 0 ? limit : 1000);
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          events: page,
          cursor: page.at(-1)?.seq ?? since,
          headSeq: mine.at(-1)?.seq ?? 0,
          more: after.length > page.length,
        }),
      );
      return;
    }

    // Back to an empty ledger, an epoch of 5 and a connection count of zero.
    // One origin serves the whole `web` slice, so a spec that asserted absolute
    // `seq` values would otherwise be asserting against whatever ran before it.
    if (url.pathname === '/__reset' && request.method === 'POST') {
      for (const stream of streams.values()) stream.response.destroy();
      streams.clear();
      events.length = 0;
      opens.length = 0;
      nextSeq = 0;
      accepted = 0;
      daemon = { epoch: EPOCH, build: 'test' };
      response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
      return;
    }

    // What the next `hello` says. A restart is only observable to a client as
    // two hellos that disagree, so a spec has to be able to move the epoch.
    if (url.pathname === '/__daemon' && request.method === 'POST') {
      void readBody(request).then((body) => {
        const next = body as { epoch?: unknown; build?: unknown } | null;
        daemon = {
          epoch: typeof next?.epoch === 'number' ? next.epoch : daemon.epoch,
          build: typeof next?.build === 'string' ? next.build : daemon.build,
        };
        response.writeHead(202, { 'content-type': 'application/json' }).end('{}');
      });
      return;
    }

    // Severs every open stream at the socket, with no final frame and no clean
    // end — the network blip, not a shutdown. The client's own reconnection
    // policy is what has to come back from this.
    if (url.pathname === '/__sever' && request.method === 'POST') {
      const severed = streams.size;
      for (const stream of streams.values()) stream.response.destroy();
      streams.clear();
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ severed }));
      return;
    }

    // A final `event: fatal` and then the socket, which is the only way a
    // stream may report an error mid-flight (docs/11 §10).
    if (url.pathname === '/__fatal' && request.method === 'POST') {
      void readBody(request).then((body) => {
        const code = (body as { code?: unknown } | null)?.code;
        for (const stream of streams.values()) {
          stream.response.write(
            controlFrame('fatal', {
              error: {
                code: typeof code === 'string' ? code : 'internal',
                message: 'the stand-in origin was told to end this stream',
                retryable: code !== 'bad_token' && code !== 'epoch_mismatch',
              },
            }),
          );
          stream.response.end();
        }
        streams.clear();
        response.writeHead(202, { 'content-type': 'application/json' }).end('{}');
      });
      return;
    }

    // `: keepalive` comments, the 13 bytes whose only job is that no
    // inactivity timer anywhere in the path sees a silent connection.
    if (url.pathname === '/__keepalive' && request.method === 'POST') {
      void readBody(request).then((body) => {
        const times = (body as { times?: unknown } | null)?.times;
        const count = typeof times === 'number' && times > 0 ? times : 1;
        for (const stream of streams.values()) {
          for (let index = 0; index < count; index += 1) stream.response.write(': keepalive\n\n');
        }
        response.writeHead(202, { 'content-type': 'application/json' }).end('{}');
      });
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
    //
    // `seqs` is how a spec writes a ledger with holes in it: `4, 5, 7` is a
    // healthy log — 6 belongs to a transaction that rolled back and burned the
    // AUTOINCREMENT value — and a client has to apply it without a word.
    if (url.pathname === '/__emit' && request.method === 'POST') {
      void readBody(request).then((body) => {
        const asked = body as { runs?: unknown; kind?: unknown; seqs?: unknown } | null;
        const runs = Array.isArray(asked?.runs) ? (asked.runs as string[]) : [];
        const kind = typeof asked?.kind === 'string' ? asked.kind : 'node.progress';
        const seqs = Array.isArray(asked?.seqs) ? (asked.seqs as number[]) : null;

        for (const [index, runId] of runs.entries()) {
          const seq = seqs?.[index] ?? nextSeq + 1;
          nextSeq = Math.max(nextSeq, seq);
          events.push({
            seq,
            runId,
            kind,
            ts: T0 + seq,
            v: kind === 'node.progress' ? 1 : 1,
            epoch: daemon.epoch,
            payload: payloadFor(kind),
          });
        }
        events.sort((left, right) => left.seq - right.seq);
        for (const stream of streams.values()) drain(stream);
        response.writeHead(202).end('{}');
      });
      return;
    }

    if (url.pathname === '/api/stream') {
      const streamId = randomUUID();
      const asked = (url.searchParams.get('runs') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value !== '');
      const global = asked.includes('*');
      const runs = new Set(asked.filter((value) => value !== '*'));
      const head = events.at(-1)?.seq ?? 0;
      const sinceParam = url.searchParams.get('since');
      const requested = Number(sinceParam);
      // §4.1's precedence, and the whole point of EPIC-16-S7's fourth
      // scenario: `since` first, `Last-Event-ID` second, **head last**. A
      // client that sends neither is served from the head, and everything
      // appended while it was away is gone.
      const lastEventId = request.headers['last-event-id'];
      const fromHeader = Number(Array.isArray(lastEventId) ? lastEventId[0] : lastEventId);
      const cursor =
        sinceParam !== null && Number.isSafeInteger(requested) && requested >= 0
          ? requested
          : Number.isSafeInteger(fromHeader) && fromHeader > 0
            ? fromHeader
            : head;

      const stream: OpenStream = {
        response,
        runs,
        global,
        openedAt: cursor,
        cursors: new Map([...runs].map((runId) => [runId, cursor] as const)),
        globalCursor: cursor,
      };
      streams.set(streamId, stream);
      accepted += 1;
      opens.push({
        since: sinceParam === null ? null : requested,
        runs: asked,
        lastEventId: typeof lastEventId === 'string' ? lastEventId : null,
      });

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
          build: daemon.build,
          daemonEpoch: daemon.epoch,
          headSeq: head,
          runs: global ? ['*', ...runs] : [...runs],
        }),
      );
      response.write('retry: 2000\n\n');
      drain(stream);
      // Phase 1 ends by saying where the backfill got to, so a client can stop
      // showing "hydrating" without guessing.
      for (const runId of runs) {
        response.write(
          controlFrame('caught_up', { runId, seq: stream.cursors.get(runId) ?? cursor }),
        );
      }
      if (global)
        response.write(controlFrame('caught_up', { runId: '*', seq: stream.globalCursor }));

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
        for (const runId of added) {
          stream.runs.add(runId);
          // From the cursor the *connection* opened at, exactly as the daemon
          // does. That is what makes a subscribe's backfill overlap what the
          // tab already hydrated — a designed-in property, not an error.
          stream.cursors.set(runId, stream.openedAt);
        }

        // Subscribe, then drain again — the order the daemon uses, so the
        // client is exercised against the frame sequence it will really see.
        stream.response.write(controlFrame('subscribed', { runs: [...stream.runs] }));
        drain(stream);
        for (const runId of added) {
          stream.response.write(
            controlFrame('caught_up', { runId, seq: stream.cursors.get(runId) ?? stream.openedAt }),
          );
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
