/**
 * KAR-01.3 — one origin, one port, and the API mounted before the SPA fallback.
 *
 * Integration rather than unit because the thing under test is a real
 * node:http server with a real Vite dev server attached to it: the mount order
 * only matters once something is actually serving the catch-all.
 *
 * Verifies: KAR-01.3 test plan #6, EPIC-01-S12 (scenarios 2 and 3)
 */
import { authorizedFetch, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { startHttp } from '../../src/http/server.ts';

/**
 * Every request this spec makes carries the daemon's bearer token (KAR-15.2).
 *
 * Assigned to a local `fetch` so the call sites below read the way they did
 * before the daemon authenticated anything — the token is a property of this
 * whole file, not a decision at each request.
 */
const fetch = authorizedFetch();

type Started = Awaited<ReturnType<typeof startHttp>>;

const isCatchAll = (path: string): boolean => path === '*' || path === '/*';

/**
 * The mount order, as the property rather than as two indices.
 *
 * *"The API mounts before the SPA fallback"* — the natural mistake is a
 * catch-all registered first, which turns every API typo into a silently-served
 * HTML page and a JSON parse error in the client.
 *
 * Stated as **"the fallback is registered last"** rather than as "the first
 * `/api` route precedes the first catch-all", because KAR-15.2 put two
 * cross-cutting `app.use('*', …)` middlewares — `varyOrigin` and `requireAuth`
 * — at the head of the table. Those are `/*` routes that legitimately come
 * first: they call `next()` and terminate nothing. The fallback is the one that
 * answers, and nothing may be registered after it. That form still fails on the
 * mistake being guarded — a fallback registered first leaves an `/api` route
 * last — and it holds for both modes, where the fallback is `app.get('*')` in
 * production and Vite's own connect middleware in dev.
 */
function expectApiMountsBeforeTheFallback(paths: readonly string[]): void {
  expect(isCatchAll(paths.at(-1) ?? '')).toBe(true);

  const lastApi = paths.findLastIndex((path) => path.startsWith('/api'));
  expect(lastApi).toBeGreaterThanOrEqual(0);
  expect(lastApi).toBeLessThan(paths.length - 1);
}

// `started` is only ever undefined if beforeAll itself threw, in which case
// afterAll's `started?.close()` must not throw a second, less informative
// error on top of the real one — so the type stays honestly optional, and
// every other read goes through this narrowing helper instead of an `!`.
function requireStarted(started: Started | undefined): Started {
  if (started === undefined) throw new Error('startHttp() has not resolved yet');
  return started;
}

suite('the dev-mode server', () => {
  let started: Started | undefined;
  let origin: string;

  beforeAll(async () => {
    started = await startHttp({
      port: 0,
      hostname: '127.0.0.1',
      dev: true,
      token: TEST_DAEMON_TOKEN,
    });
    const address = started.server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  }, 60_000);

  afterAll(async () => {
    await started?.close();
  });

  it('registers every /api route before the catch-all (test plan #6)', () => {
    const paths = requireStarted(started).app.routes.map((route) => route.path);
    expectApiMountsBeforeTheFallback(paths);
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
  let started: Started | undefined;
  let origin: string;

  beforeAll(async () => {
    started = await startHttp({
      port: 0,
      hostname: '127.0.0.1',
      dev: false,
      token: TEST_DAEMON_TOKEN,
    });
    const address = started.server.address() as AddressInfo;
    origin = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    await started?.close();
  });

  it('mounts /api first there too, so dev and production routing are identical', async () => {
    expectApiMountsBeforeTheFallback(requireStarted(started).app.routes.map((route) => route.path));

    const response = await fetch(`${origin}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('never loads Vite outside the dev branch (AC8)', () => {
    expect(requireStarted(started).viteLoaded).toBe(false);
  });
});
