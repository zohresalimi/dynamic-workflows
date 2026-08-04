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
import type { Server as HttpServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdaptorServer, type HttpBindings } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { log } from '../logging.ts';
import { api } from './api.ts';
import { fromConnect } from './connect.ts';

const http = log.child({ mod: 'http' });

export const DEFAULT_PORT = 7777;
export const DEFAULT_HOSTNAME = '127.0.0.1';

export interface StartHttpOptions {
  readonly port: number;
  readonly hostname?: string | undefined;
  /** Defaults to `process.env.DeFlow_DEV === '1'`. */
  readonly dev?: boolean | undefined;
}

export interface StartedHttp {
  readonly app: Hono<{ Bindings: HttpBindings }>;
  /** The real node:http server — the object Vite attaches its HMR websocket to. */
  readonly server: HttpServer;
  /** True only when the dev branch dynamically imported Vite. */
  readonly viteLoaded: boolean;
  readonly close: () => Promise<void>;
}

/** In the published package the built SPA sits next to the bundled daemon. */
const uiDir = fileURLToPath(new URL('./ui/', import.meta.url));

/** In the workspace, Vite's root is the web package's live source. */
const webRoot = fileURLToPath(new URL('../../../web/', import.meta.url));

export async function startHttp(options: StartHttpOptions): Promise<StartedHttp> {
  const hostname = options.hostname ?? DEFAULT_HOSTNAME;
  const dev = options.dev ?? process.env.DeFlow_DEV === '1';
  const app = new Hono<{ Bindings: HttpBindings }>();

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

  const close = async (): Promise<void> => {
    await closeUi();
    // SSE connections are open indefinitely by design, so a plain close() would
    // wait forever for them.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  http.info({ hostname, port: options.port, dev }, 'listening');

  return { app, server, viteLoaded, close };
}

function listening(server: HttpServer): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
}
