/**
 * KAR-15.1 test plan #1, #3, #5 and the route-table half of #6 — the
 * properties of the `/api` surface that are true of the route table itself
 * rather than of any one handler.
 *
 * Verifies: EPIC-15-S3 (the enumeration scenario), EPIC-15-S4 (the unexpected
 * throw), EPIC-15-S5 (the route-table guard) · AC3, AC5, AC6
 *
 * Unit, and deliberately so: `app.request()` runs the real Hono app through
 * the real middleware chain without a socket, and the enumeration reads the
 * real routing table. The two things that need a real server — that a JSON
 * route is actually compressed on the wire, and that the stream is not — are
 * integration, in `integration/api-contract.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { expect, it, describe as suite } from 'vitest';
import {
  API_HEADER,
  api,
  apiErrorHandler,
  isPublicRoute,
  JSON_COMPRESSION,
  PUBLIC_ROUTES,
} from '../src/http/api.ts';
import { setDaemonAuth } from '../src/http/auth.ts';
import { API_VERSION } from '../src/meta.ts';

/** A token for the two cases below that have to get past KAR-15.2's guard. */
const TOKEN = 'a-test-token-that-is-not-a-real-one';

/**
 * A registered entry that answers, as opposed to one that decorates.
 *
 * Hono keeps middleware and handlers in the same `routes` array and marks
 * neither, so the arity is the discriminator — the same one Hono's own
 * `compose` uses: a handler is `(c)`, a middleware is `(c, next)`. Reading it
 * here rather than keeping a second list of routes is what makes the
 * enumeration below unable to miss a route somebody adds.
 */
function handlerRoutes(): { method: string; path: string }[] {
  return api.routes
    .filter((route) => route.handler.length < 2)
    .map((route) => ({ method: route.method, path: route.path }));
}

suite('the route table', () => {
  it('exempts exactly one route from authentication, and it is GET /health (AC3)', () => {
    const exempt = handlerRoutes().filter((route) => isPublicRoute(route.method, route.path));

    expect(exempt).toEqual([{ method: 'GET', path: '/health' }]);
    expect(PUBLIC_ROUTES).toEqual(['GET /health']);
  });

  it('answers the same question for a path carrying the /api mount prefix', () => {
    // KAR-15.2's middleware sees the request path, not the registered one.
    expect(isPublicRoute('GET', '/api/health')).toBe(true);
    expect(isPublicRoute('POST', '/api/health')).toBe(false);
    expect(isPublicRoute('GET', '/api/runs/r_01JXQ')).toBe(false);
    expect(isPublicRoute('GET', '/api/stream')).toBe(false);
  });

  it('registers every route as one chained expression, so hc<ApiType> infers them (AC1)', () => {
    // A route added as its own `api.get(...)` statement is invisible to
    // `hc<ApiType>`'s inference, and nothing about the running server would
    // say so — the client silently degrades to `any`. The chain is therefore
    // load-bearing, and this is the assertion that says it out loud.
    const source = readApiSource();
    const unchained = source.match(/^api\.(get|post|put|delete|patch|all|use|on)\(/gm) ?? [];
    expect(unchained).toEqual([]);
    expect(source).toContain('export type ApiType = typeof api');
  });

  it('mounts compression on JSON routes only, and never globally (AC6)', () => {
    const compressed = api.routes
      .filter((route) => route.handler === JSON_COMPRESSION)
      .map((route) => route.path);

    expect(compressed.length).toBeGreaterThan(0);
    for (const path of compressed) {
      // A wildcard mount is the failure this guards: it would put a
      // CompressionStream in front of /api/stream, and buffered SSE arrives in
      // bursts and reads as a scheduler bug for an afternoon.
      expect(path).not.toBe('*');
      expect(path).not.toBe('/*');
      expect(path.startsWith('/stream')).toBe(false);
    }
  });
});

suite('GET /health', () => {
  it('returns the documented body, unauthenticated (AC3, test plan #1)', async () => {
    const response = await api.request('/health');

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(
      expect.arrayContaining(['apiVersion', 'build', 'daemonEpoch', 'headSeq', 'uptimeMs']),
    );
    expect(body.apiVersion).toBe(API_VERSION);
    expect(typeof body.build).toBe('string');
    expect(typeof body.uptimeMs).toBe('number');
  });

  it('carries X-DeFlow-Api on the response (AC3)', async () => {
    const response = await api.request('/health');
    expect(response.headers.get(API_HEADER)).toBe(String(API_VERSION));
  });
});

suite('every response', () => {
  /**
   * KAR-15.2 arrived after this file and moved where an unknown path is
   * answered: the auth middleware runs *before* routing, so an anonymous
   * request to `/api/nope` is a 401 rather than a confirmation that the route
   * does not exist. The mount-order property AC7 is about — an unknown API
   * path is a typed 404, never `index.html` — is unchanged, and is what these
   * two assert with a token attached. The anonymous case is
   * `../auth-middleware.test.ts`.
   */
  const authorized = (): { headers: Record<string, string> } => {
    setDaemonAuth({ token: TOKEN, port: 7777, hostname: '127.0.0.1' });
    return { headers: { Authorization: `Bearer ${TOKEN}` } };
  };

  it('carries X-DeFlow-Api, including the ones nobody wrote a handler for (AC3)', async () => {
    const missing = await api.request('/nope', authorized());
    expect(missing.status).toBe(404);
    expect(missing.headers.get(API_HEADER)).toBe(String(API_VERSION));
  });

  it('answers an unknown /api path with the envelope rather than the SPA (AC7)', async () => {
    const response = await api.request('/nope', authorized());
    const body = (await response.json()) as { error: { code: string; retryable: boolean } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.retryable).toBe(false);
  });
});

suite('an unexpected throw', () => {
  /** The real handler, mounted on a route whose only job is to throw. */
  const boom = new Hono().onError(apiErrorHandler).get('/boom', () => {
    throw new TypeError('a field nobody guarded was undefined');
  });

  it('answers 500 internal with no stack in the body (AC5, test plan #5)', async () => {
    const response = await boom.request('/boom');

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('at ');
    expect(text).not.toContain('.ts:');
    expect(text).not.toContain('TypeError');

    const body = JSON.parse(text) as { error: { code: string; detail: Record<string, unknown> } };
    expect(body.error.code).toBe('internal');
    // No data directory is registered in a unit test, so there is nowhere to
    // put the stack — and the response says so honestly rather than inventing
    // a handle. The integration spec covers the case where there is one.
    expect(body.error.detail.stack).toBeUndefined();
  });
});

function readApiSource(): string {
  // Read rather than imported: the assertion is about how the module is
  // written, which is exactly what the module's exports cannot tell you.
  const url = new URL('../src/http/api.ts', import.meta.url);
  return readFileSync(fileURLToPath(url), 'utf8');
}
