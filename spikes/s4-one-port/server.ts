/**
 * KAR-00.3's harness: one Node process, one port, carrying an SSE stream, a
 * JSON API and a Vue app served by Vite in middleware mode.
 *
 * This is the shape `DeFlowd` claims in ADR 0011 / D10, reduced to the smallest
 * thing that can be measured. It is deliberately *not* an import of
 * `packages/daemon` — the spike has to be able to be wrong about the daemon.
 *
 *   S4_PORT          port to bind (default 7777, the port AC1 names)
 *   S4_INTERVAL_MS   emitter cadence (default 1000 — one event per second)
 *   S4_GAP_AT        burn this seq, as a rolled-back transaction would
 *   S4_MODE          one-port  — /api first, then Vite  (the shape under test)
 *                    fallback-first — the SPA fallback first, on purpose
 *                    compressed — compression middleware in front of /api/stream
 *
 * Two of those modes exist to be *wrong*: EPIC-00-S12 asks for the failure
 * modes to be reproduced once, deliberately, so the guards against them are
 * believed rather than merely written down.
 */

import type { Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createAdaptorServer, type HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import vue from '@vitejs/plugin-vue';
import { Hono, type MiddlewareHandler } from 'hono';
import { compress } from 'hono/compress';
import { streamSSE } from 'hono/streaming';
import { createServer as createViteServer } from 'vite';
import { eventsAfter, resumeFrom, type StreamEvent } from './src/resume.ts';

const PORT = Number(process.env.S4_PORT ?? 7777);
const HOSTNAME = '127.0.0.1';
const INTERVAL_MS = Number(process.env.S4_INTERVAL_MS ?? 1000);
const GAP_AT = process.env.S4_GAP_AT === undefined ? null : Number(process.env.S4_GAP_AT);
const MODE = process.env.S4_MODE ?? 'one-port';
const APP_ROOT = fileURLToPath(new URL('./app/', import.meta.url));

// --- the emitter -------------------------------------------------------------

/**
 * One shared sequence for every connection, so "?since= loses nothing and
 * duplicates nothing" is a statement about a real log rather than about a
 * per-connection counter that restarts on reload.
 */
const log: StreamEvent[] = [];
const startedAt = performance.now();
let nextSeq = 1;

const ticker = setInterval(() => {
  if (GAP_AT !== null && nextSeq === GAP_AT) {
    // A rolled-back transaction burns an AUTOINCREMENT value. The client must
    // not call the hole a missing event.
    nextSeq += 1;
  }
  const seq = nextSeq;
  nextSeq += 1;
  const event: StreamEvent = {
    seq,
    at: performance.now() - startedAt,
    data: JSON.stringify({ seq, emittedAtMs: Math.round(performance.now() - startedAt) }),
  };
  log.push(event);
  for (const listener of listeners) listener(event);
}, INTERVAL_MS);
ticker.unref();

type Listener = (event: StreamEvent) => void;
const listeners = new Set<Listener>();

// --- what the harness observes about its clients ------------------------------

interface Observation {
  at: number;
  path: string;
  since: string | null;
  lastEventId: string | null;
  resumedAfter: number | null;
  mode: string;
}

const connections: Observation[] = [];
let open = 0;
let closed = 0;
/** Raw sockets of live streams, so a stream can be severed as a network would. */
const streamSockets = new Set<Socket>();

// --- the app -----------------------------------------------------------------

const app = new Hono<{ Bindings: HttpBindings }>();
const api = new Hono<{ Bindings: HttpBindings }>();

api.get('/health', (c) =>
  c.json({
    pid: process.pid,
    port: PORT,
    mode: MODE,
    intervalMs: INTERVAL_MS,
    headSeq: nextSeq - 1,
  }),
);

api.get('/observations', (c) => c.json({ connections, open, closed }));

/** Sever every live stream at the socket, the way a flaky network would. */
api.post('/drop', (c) => {
  const dropped = streamSockets.size;
  for (const socket of streamSockets) socket.destroy();
  streamSockets.clear();
  return c.json({ dropped });
});

api.get('/stream', (c) => {
  const resume = resumeFrom({
    since: c.req.query('since') ?? null,
    lastEventId: c.req.header('last-event-id') ?? null,
  });
  const limit = Number(c.req.query('limit') ?? 0);

  connections.push({
    at: Date.now(),
    path: c.req.path,
    since: c.req.query('since') ?? null,
    lastEventId: c.req.header('last-event-id') ?? null,
    resumedAfter: resume.mode === 'live' ? null : resume.after,
    mode: resume.mode,
  });
  open += 1;

  const socket = c.env.outgoing.socket;
  if (socket !== null) streamSockets.add(socket);

  const response = streamSSE(c, async (stream) => {
    let delivered = 0;
    const queue: StreamEvent[] = [...eventsAfter(log, resume)];
    let notify: (() => void) | undefined;
    const listener: Listener = (event) => {
      queue.push(event);
      notify?.();
    };
    listeners.add(listener);

    stream.onAbort(() => {
      listeners.delete(listener);
      if (socket !== null) streamSockets.delete(socket);
      open -= 1;
      closed += 1;
      notify?.();
    });

    // A short retry so the reconnect scenario does not spend the browser's
    // default three seconds. No `data:`, so it dispatches no event.
    await stream.write(': connected\nretry: 300\n\n');

    while (!stream.aborted && !stream.closed) {
      const event = queue.shift();
      if (event === undefined) {
        await new Promise<void>((resolve) => {
          notify = resolve;
          setTimeout(resolve, 250).unref();
        });
        notify = undefined;
        continue;
      }
      await stream.writeSSE({ event: 'tick', id: String(event.seq), data: event.data });
      delivered += 1;
      if (limit > 0 && delivered >= limit) break;
    }

    listeners.delete(listener);
  });

  // streamSSE sets "no-cache"; an SSE stream also needs "no-transform" so that
  // no intermediary may re-chunk or re-encode it, and X-Accel-Buffering for
  // anyone who later puts a reverse proxy in front.
  //
  // In `compressed` mode the "no-transform" half is dropped on purpose: hono's
  // own compress middleware honours it and declines to touch the response, so
  // the documented buffering symptom cannot be reproduced while it is there.
  // That refusal is a result in its own right — see docs/spikes/S4-one-port.md.
  response.headers.set(
    'Cache-Control',
    MODE === 'compressed' ? 'no-cache' : 'no-cache, no-transform',
  );
  response.headers.set('X-Accel-Buffering', 'no');
  if (MODE === 'compressed') {
    // The third guard: hono's compress middleware also declines anything that
    // already carries Transfer-Encoding, which `streamSSE` always sets.
    response.headers.delete('Transfer-Encoding');
  }
  return response;
});

/** An unknown /api path is a typed 404, never a fall-through to the SPA. */
api.all('*', (c) => c.json({ error: 'not_found', path: c.req.path }, 404));

// --- mounting ----------------------------------------------------------------

const server = createAdaptorServer({ fetch: app.fetch }) as HttpServer;

const vite = await createViteServer({
  root: APP_ROOT,
  configFile: false,
  appType: 'spa',
  plugins: [vue()],
  logLevel: 'warn',
  server: {
    middlewareMode: { server },
    // `ws.server` is what actually makes HMR ride this server's socket. Vite 8
    // consumes `middlewareMode.server` only when building the forwarding
    // middleware; without `ws.server` it resolves the HMR port to 24678 and
    // opens a *second* listening socket — the two-port shape D10 removes.
    ws: { server },
  },
});

const ui = fromConnect(vite.middlewares);

if (MODE === 'fallback-first') {
  // Deliberately wrong. Vite's SPA fallback rewrites any extension-less GET
  // that accepts text/html to index.html — including /api/stream.
  app.use('*', ui);
  app.route('/api', api);
} else {
  if (MODE === 'compressed' || MODE === 'compressed-guarded') {
    // Deliberately wrong. Compression in front of a stream holds every event
    // until the deflate window flushes, which for one-line SSE frames means
    // "until the stream ends".
    //
    // Both overrides are needed to get there, and both are findings: hono
    // 4.12.33's compress middleware excludes `text/event-stream` from
    // COMPRESSIBLE_CONTENT_TYPE_REGEX *and* skips any response whose
    // Cache-Control carries `no-transform`. `compressed-guarded` keeps the
    // header and so keeps the guard; `compressed` drops it (above) and gets the
    // symptom.
    app.use('/api/stream', compress({ threshold: 0, contentTypeFilter: () => true }));
  }
  app.route('/api', api);
  app.use('*', ui);
}

server.listen(PORT, HOSTNAME, () => {
  process.stdout.write(
    `${JSON.stringify({ msg: 'listening', port: PORT, mode: MODE, intervalMs: INTERVAL_MS })}\n`,
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(ticker);
    server.closeAllConnections();
    void vite.close().finally(() => server.close(() => process.exit(0)));
  });
}

/**
 * Runs a connect-style middleware (Vite's) inside Hono: `@hono/node-server`
 * exposes the real node request and response on `c.env`, and
 * `RESPONSE_ALREADY_SENT` is how Hono is told the socket was written directly.
 */
function fromConnect(
  middleware: typeof vite.middlewares,
): MiddlewareHandler<{ Bindings: HttpBindings }> {
  return async (c, next) => {
    const { incoming, outgoing } = c.env;
    const handled = await new Promise<boolean>((resolve, reject) => {
      const done = () => resolve(true);
      outgoing.once('finish', done);
      outgoing.once('close', done);
      middleware(incoming, outgoing, (error?: unknown) => {
        outgoing.removeListener('finish', done);
        outgoing.removeListener('close', done);
        if (error === undefined || error === null) resolve(false);
        else reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    if (handled) return RESPONSE_ALREADY_SENT;
    await next();
    return undefined;
  };
}
