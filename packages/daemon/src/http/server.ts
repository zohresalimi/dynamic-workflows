/**
 * One process, one port, one origin (D10, ADR 0011).
 *
 * `/api` mounts first so it always wins over the SPA fallback — the day
 * `/api/stream` returns `index.html` with a 200 is the day an SSE client sits
 * there silently consuming HTML.
 *
 * In development Vite runs in **middleware mode against this server**, so its
 * HMR websocket rides the daemon's own `node:http` server instead of opening a
 * second one. There is therefore no proxy and no CORS: dev and production
 * routing are byte-identical apart from which middleware serves the UI, which
 * is what makes "works in dev, broken in the built package" almost impossible
 * for anything routing-related.
 *
 * The `vite` import is dynamic and gated on `DeFlow_DEV`, which is what keeps a
 * devDependency out of the one published tarball.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createAdaptorServer, type HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { log } from '../logging.ts';
import { api } from './api.ts';
import {
  assertLoopbackBind,
  authorize,
  clearDaemonAuth,
  type DaemonAuth,
  setDaemonAuth,
  varyOrigin,
} from './auth.ts';
import { fromConnect } from './connect.ts';
import { refuseUpgrade } from './socket-refusal.ts';

const http = log.child({ mod: 'http' });

export const DEFAULT_PORT = 7777;
export const DEFAULT_HOSTNAME = '127.0.0.1';

export interface StartHttpOptions {
  readonly port: number;
  readonly hostname?: string | undefined;
  /** Defaults to `process.env.DeFlow_DEV === '1'`. */
  readonly dev?: boolean | undefined;
  /**
   * This daemon life's bearer token (KAR-15.2).
   *
   * Required, and deliberately not optional: an optional token is an
   * unauthenticated mode, and an unauthenticated mode is the one a test
   * harness ends up shipping. `boot()` mints one when its caller does not.
   */
  readonly token: string;
  /**
   * AC12 — the explicit flag, and the only path to a non-loopback bind. There
   * is no configuration that falls back to `0.0.0.0` on its own.
   */
  readonly allowNonLoopback?: boolean | undefined;
}

export interface StartedHttp {
  readonly app: Hono<{ Bindings: HttpBindings }>;
  /** The real node:http server — the object Vite attaches its HMR websocket to. */
  readonly server: HttpServer;
  /** True only when the dev branch dynamically imported Vite. */
  readonly viteLoaded: boolean;
  /** The port actually bound — not always the one requested (`port: 0`). */
  readonly port: number;
  readonly close: () => Promise<void>;
}

/**
 * What KAR-15.8 registers to take an authenticated WebSocket upgrade.
 *
 * The *guard* lives here (AC11) and the socket lives there, which is the only
 * order that works: a check that ran after the upgrade would have accepted the
 * socket before deciding whether it was allowed to.
 */
export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

let upgradeHandler: UpgradeHandler | null = null;

export function setUpgradeHandler(handler: UpgradeHandler): void {
  upgradeHandler = handler;
}

export function clearUpgradeHandler(): void {
  upgradeHandler = null;
}

/** In the published package the built SPA sits next to the bundled daemon. */
const uiDir = fileURLToPath(new URL('./ui/', import.meta.url));

/** In the workspace, Vite's root is the web package's live source. */
const webRoot = fileURLToPath(new URL('../../../web/', import.meta.url));

export async function startHttp(options: StartHttpOptions): Promise<StartedHttp> {
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const dev = options.dev ?? process.env.DeFlow_DEV === '1';

  // Before anything binds: AC12's refusal is only worth having if it happens
  // while there is still nothing listening.
  assertLoopbackBind(hostname, options.allowNonLoopback ?? false);

  const app = new Hono<{ Bindings: HttpBindings }>();

  // AC4 — on the SPA and the static assets too, not only under /api. A cache
  // that varies the API but not the page it is embedded in is a cache that can
  // still hand one origin's response to another.
  app.use('*', varyOrigin);

  // The access log the fragment handoff is asserted against (AC7, AC9): method,
  // path and query string, and *nothing else off the request*. It is what makes
  // "the token never travels in a query string" an observable property rather
  // than an intention — if a credential ever reached a URL, this is the line it
  // would be sitting in.
  app.use('*', async (c, next) => {
    http.debug({ method: c.req.method, path: c.req.path, query: queryOf(c.req.url) }, 'request');
    await next();
  });

  // The API mounts first so it always wins over the SPA fallback.
  app.route('/api', api);

  // @hono/node-server hands back the real node:http server — the object Vite
  // needs in order to attach its HMR websocket to it. It is built here but
  // *not* listened on yet: binding before the UI middleware is mounted would
  // make /api/health answer 200 while `/` still 404s, and every readiness probe
  // in the project keys on /api/health. `createAdaptorServer` is typed as the
  // union of every server it can build; with no `createServer` override it
  // always builds a node:http one, which is the only shape Vite accepts.
  const server = createAdaptorServer({ fetch: app.fetch }) as HttpServer;

  let viteLoaded = false;
  let closeUi = (): Promise<void> => Promise.resolve();

  if (dev) {
    // Dynamic import: vite is a devDependency and must not enter the bundle.
    const { createServer } = await import('vite');
    const vite = await createServer({
      root: webRoot,
      appType: 'spa',
      server: {
        middlewareMode: { server },
        // `ws.server` is what actually makes HMR ride the daemon's own socket.
        //
        // **Verified 2026-08-04 against vite@8.2.0's shipped code.** ADR 0011
        // and docs/03-local-development.md §4.2 read `middlewareMode: { server }`
        // as the attach point, on the strength of its doc comment ("needed to
        // proxy WebSocket connections to the parent server"). In Vite 8 that
        // field is consumed in exactly one place — building the middleware that
        // forwards to a configured upstream — and never by the HMR websocket.
        // Without `ws.server`, Vite resolves the client's HMR port to the
        // default 24678 and opens a **second** listening socket, which is
        // precisely the two-port shape D10 exists to remove.
        ws: { server },
      },
    });
    viteLoaded = true;
    closeUi = () => vite.close();
    app.use('*', fromConnect(vite.middlewares));
  } else {
    app.use('/assets/*', serveStatic({ root: uiDir }));
    app.get('*', (c) => {
      const index = join(uiDir, 'index.html');
      if (!existsSync(index)) {
        // Honest failure rather than a blank page: in production this file is
        // shipped in the tarball, so its absence means an unbuilt workspace.
        return c.json(
          {
            error: 'ui_not_built',
            message: `no built UI at ${uiDir}; run "pnpm build", or start with DeFlow_DEV=1`,
          },
          503,
        );
      }
      return c.html(readFileSync(index, 'utf8'));
    });
  }

  // Everything is mounted; only now does the port start accepting.
  server.listen(options.port, hostname);
  await listening(server);

  // The **bound** port, which is not always the requested one: `port: 0` is how
  // every spec in this repository gets an ephemeral one, and the origin
  // allowlist is built from what was bound. A daemon that authenticated against
  // the port it asked for would refuse its own UI.
  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? options.port;
  const auth: DaemonAuth = { token: options.token, port, hostname };
  setDaemonAuth(auth);

  // AC11 — the upgrade guard, on the same decision function the HTTP
  // middleware uses. Scoped to `/api/*` because in dev this is also Vite's HMR
  // socket, which rides this very server (D10) and is not ours to refuse.
  const guardUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    if (!path.startsWith('/api/')) return;

    const decision = authorize(
      {
        method: request.method ?? 'GET',
        path,
        host: header(request, 'host'),
        origin: header(request, 'origin'),
        authorization: header(request, 'authorization'),
      },
      auth,
    );

    if (!decision.ok) {
      refuseUpgrade(socket, decision.code, decision.message, decision.reason);
      return;
    }
    if (upgradeHandler === null) {
      refuseUpgrade(
        socket,
        'not_found',
        `nothing accepts a WebSocket at ${path}`,
        'no_upgrade_handler',
      );
      return;
    }
    upgradeHandler(request, socket, head);
  };
  server.on('upgrade', guardUpgrade);

  const close = async (): Promise<void> => {
    server.off('upgrade', guardUpgrade);
    clearDaemonAuth();
    await closeUi();
    // SSE connections are open indefinitely by design, so a plain close() would
    // wait forever for them.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  http.info({ hostname, port, dev }, 'listening');

  return { app, server, viteLoaded, port, close };
}

function queryOf(url: string): string {
  const mark = url.indexOf('?');
  return mark === -1 ? '' : url.slice(mark + 1);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function listening(server: HttpServer): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
}
