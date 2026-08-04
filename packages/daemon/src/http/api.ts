/**
 * The `/api` surface, mounted before anything that can serve the SPA.
 *
 * At this point in the backlog there is no ledger and no orchestrator, so what
 * lives here is the two routes the dev loop itself needs: readiness, and a
 * stream to prove that SSE and HMR share one port (D10, ADR 0011). The real
 * route table is docs/11-api-and-realtime.md §6 and lands with EPIC-03.
 */
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { log } from '../logging.ts';
import { API_VERSION, BOOT_ID, BUILD, uptimeMs } from '../meta.ts';

const http = log.child({ mod: 'http' });

const DEFAULT_HEARTBEAT_MS = 15_000;

function heartbeatMs(): number {
  const configured = Number(process.env.DeFlow_SSE_HEARTBEAT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_HEARTBEAT_MS;
}

export const api = new Hono();

/**
 * The unauthenticated discovery endpoint (docs/11-api-and-realtime.md §12).
 * `pid` and `bootId` are what let `pnpm dev`, and the e2e specs, tell one
 * daemon life from the next across a restart-on-save.
 */
api.get('/health', (c) =>
  c.json({
    apiVersion: API_VERSION,
    build: BUILD,
    daemonEpoch: null,
    headSeq: null,
    uptimeMs: uptimeMs(),
    pid: process.pid,
    bootId: BOOT_ID,
  }),
);

/**
 * The control-plane stream.
 *
 * The body is a placeholder — a hello frame and a heartbeat — until the ledger
 * tail lands (EPIC-03). The *transport* is not a placeholder: no compression,
 * `no-transform` so no intermediary may re-chunk it, and `X-Accel-Buffering: no`
 * for anyone who later puts a reverse proxy in front of DeFlowd. Those three
 * are the settings that make an SSE stream survive hours instead of arriving in
 * one burst at the end (docs/11-api-and-realtime.md §13).
 */
api.get('/stream', (c) => {
  const interval = heartbeatMs();
  const response = streamSSE(c, async (stream) => {
    let seq = 0;
    await stream.writeSSE({
      event: 'hello',
      id: String(seq),
      data: JSON.stringify({ apiVersion: API_VERSION, build: BUILD, bootId: BOOT_ID }),
    });
    while (!stream.aborted && !stream.closed) {
      await stream.sleep(interval);
      if (stream.aborted || stream.closed) break;
      seq += 1;
      await stream.writeSSE({
        event: 'heartbeat',
        id: String(seq),
        data: JSON.stringify({ uptimeMs: uptimeMs() }),
      });
    }
    http.debug('sse stream closed');
  });

  // streamSSE sets "no-cache"; SSE also needs "no-transform", so widen it.
  response.headers.set('Cache-Control', 'no-cache, no-transform');
  response.headers.set('X-Accel-Buffering', 'no');
  return response;
});

/**
 * Everything under /api terminates here, so an unknown API path is a typed 404
 * and never falls through to the SPA. A 200 with `index.html` on an API path is
 * the failure that costs an afternoon: the client sits there parsing HTML.
 */
api.all('*', (c) => c.json({ error: 'not_found', path: c.req.path }, 404));
