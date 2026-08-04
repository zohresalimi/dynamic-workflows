/**
 * KAR-01.3 — one origin, one port, and the API mounted before the SPA fallback.
 *
 * Integration rather than unit because the thing under test is a real
 * node:http server with a real Vite dev server attached to it: the mount order
 * only matters once something is actually serving the catch-all.
 *
 * Verifies: KAR-01.3 test plan #6, EPIC-01-S12 (scenarios 2 and 3)
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe as suite, expect, it } from 'vitest';
import { startHttp } from '../../src/http/server.ts';

type Started = Awaited<ReturnType<typeof startHttp>>;

suite('the dev-mode server', () => {
  let started: Started;
  let origin: string;

  beforeAll(async () => {
    started = await startHttp({ port: 0, hostname: '127.0.0.1', dev: true });
    const address = started.server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await started?.close();
  });

  it('registers every /api route before the catch-all (test plan #6)', () => {
    const paths = started.app.routes.map((route) => route.path);
    const firstApi = paths.findIndex((path) => path.startsWith('/api'));
    const catchAll = paths.findIndex((path) => path === '*' || path === '/*');
    expect(firstApi).toBeGreaterThanOrEqual(0);
    expect(catchAll).toBeGreaterThanOrEqual(0);
    expect(firstApi).toBeLessThan(catchAll);
  });

  it('serves /api/health from Hono, unauthenticated, as JSON', async () => {
    const response = await fetch(`${origin}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ apiVersion: 1 });
    expect(typeof body.uptimeMs).toBe('number');
    expect(typeof body.pid).toBe('number');
    expect(typeof body.bootId).toBe('string');
  });

  it('serves the Vue app from / on the same port', async () => {
    const response = await fetch(`${origin}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    const html = await response.text();
    expect(html).toContain('id="app"');
    // Vite's middleware injected its client, which is how HMR reaches the browser.
    expect(html).toContain('/@vite/client');
  });

  it('does not need a CORS header, because there is one origin (EPIC-01-S12 scenario 2)', async () => {
    const response = await fetch(`${origin}/api/health`, {
      headers: { origin },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('gives /api/stream the SSE content type, not the SPA index (EPIC-01-S12 scenario 3)', async () => {
    const controller = new AbortController();
    try {
      const response = await fetch(`${origin}/api/stream`, { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(response.headers.get('x-accel-buffering')).toBe('no');
    } finally {
      controller.abort();
    }
  });

  it('404s an unknown /api route rather than falling through to the SPA', async () => {
    const response = await fetch(`${origin}/api/does-not-exist`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type') ?? '').not.toContain('text/html');
  });
});

suite('the production-mode server', () => {
  let started: Started;
  let origin: string;

  beforeAll(async () => {
    started = await startHttp({ port: 0, hostname: '127.0.0.1', dev: false });
    const address = started.server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await started?.close();
  });

  it('mounts /api first there too, so dev and production routing are identical', async () => {
    const paths = started.app.routes.map((route) => route.path);
    const firstApi = paths.findIndex((path) => path.startsWith('/api'));
    const catchAll = paths.findIndex((path) => path === '*' || path === '/*');
    expect(firstApi).toBeLessThan(catchAll);

    const response = await fetch(`${origin}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('never loads Vite outside the dev branch (AC8)', () => {
    expect(started.viteLoaded).toBe(false);
  });
});
