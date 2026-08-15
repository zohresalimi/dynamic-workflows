/**
 * KAR-15.2 test plan #1, #3, #4, #5, #6 — the auth middleware, through the real
 * `/api` chain.
 *
 * Verifies: EPIC-15-S7 (both scenarios), EPIC-15-S8 (the wrong token),
 * EPIC-15-S9 (the rebinding case and the allowlist outline), EPIC-15-S10
 * (`Vary: Origin` everywhere), EPIC-15-S11 · AC1, AC3, AC4, AC5, AC6
 *
 * Unit: `api.request()` runs the real middleware chain over the real routing
 * table without a socket, which is the level at which "is this route
 * protected?" is a question about the table rather than about the transport.
 * The two things that need a real socket — the SSE stream's headers, and a
 * `Host` header a `fetch` client refuses to forge — are in
 * `integration/auth.test.ts`.
 */
import { expect, it, describe as suite } from 'vitest';
import { api, isPublicRoute } from '../src/http/api.ts';
import { clearDaemonAuth, setDaemonAuth } from '../src/http/auth.ts';

const TOKEN = 'a-test-token-that-is-not-a-real-one';
const PORT = 7777;
const ORIGIN = `http://127.0.0.1:${PORT}`;

/** The daemon's own origin, as the running daemon would have registered it. */
function configured(): void {
  setDaemonAuth({ token: TOKEN, port: PORT, hostname: '127.0.0.1' });
}

interface Envelope {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly detail: Record<string, unknown>;
    readonly retryable: boolean;
  };
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

/**
 * Every route that answers, as `app.request` addresses it.
 *
 * Read off the live routing table rather than listed here, so a route somebody
 * adds tomorrow is enumerated by this file the day it is added — which is the
 * whole point of AC4's *"a test enumerates responses"*. `:param` segments are
 * filled with something syntactically plausible; what the handler would answer
 * does not matter, because none of them is reached.
 */
function answeringRoutes(): { method: string; path: string }[] {
  return api.routes
    .filter((route) => route.handler.length < 2 && route.path !== '*')
    .map((route) => ({
      method: route.method === 'ALL' ? 'GET' : route.method,
      path: route.path.replaceAll(/:([A-Za-z]+)/g, 'x'),
    }));
}

suite('an unauthenticated request (AC1, test plan #1)', () => {
  it('is refused with 401 missing_token', async () => {
    configured();
    const response = await api.request(`${ORIGIN}/runs`);

    expect(response.status).toBe(401);
    const body = (await response.json()) as Envelope;
    expect(body.error.code).toBe('missing_token');
  });

  it('is refused on every route except GET /health (AC1, EPIC-15-S7 scenario 2)', async () => {
    configured();
    const routes = answeringRoutes();
    expect(routes.length).toBeGreaterThan(5);

    for (const route of routes) {
      const response = await api.request(`${ORIGIN}${route.path}`, { method: route.method });
      const expected = isPublicRoute(route.method, route.path) ? 200 : 401;
      expect(response.status, `${route.method} ${route.path}`).toBe(expected);
    }
  });

  it('reveals nothing about the expected token (AC1)', async () => {
    configured();
    const response = await api.request(`${ORIGIN}/runs`);
    const text = await response.text();

    expect(text).not.toContain(TOKEN);
    // Not the token, not a prefix of it, and not its length: a 401 that said
    // "expected 35 characters" would hand an attacker the search space.
    expect(text).not.toContain(String(TOKEN.length));
    expect(text).not.toContain(TOKEN.slice(0, 4));
  });

  it('is refused before routing, so an unknown path answers 401 rather than 404', async () => {
    configured();
    const response = await api.request(`${ORIGIN}/nope`);
    expect(response.status).toBe(401);

    // With a token, the same path is the 404 envelope KAR-15.1 AC7 documents.
    const authorized = await api.request(`${ORIGIN}/nope`, { headers: bearer(TOKEN) });
    expect(authorized.status).toBe(404);
  });

  it('is refused on a WebSocket-shaped request too, since the check is not path-specific', async () => {
    configured();
    const response = await api.request(`${ORIGIN}/runs`, {
      headers: { Upgrade: 'websocket', Connection: 'Upgrade' },
    });
    expect(response.status).toBe(401);
  });
});

suite('a wrong token (AC1, EPIC-15-S8)', () => {
  it('is refused with 401 bad_token', async () => {
    configured();
    const response = await api.request(`${ORIGIN}/runs`, { headers: bearer('wrong') });

    expect(response.status).toBe(401);
    expect(((await response.json()) as Envelope).error.code).toBe('bad_token');
  });

  it('is refused when it is the right token with one character changed', async () => {
    configured();
    const almost = `${TOKEN.slice(0, -1)}X`;
    const response = await api.request(`${ORIGIN}/runs`, { headers: bearer(almost) });

    expect(response.status).toBe(401);
    expect(((await response.json()) as Envelope).error.code).toBe('bad_token');
  });

  it('distinguishes "no credential" from "the wrong credential"', async () => {
    configured();
    const basic = await api.request(`${ORIGIN}/runs`, {
      headers: { Authorization: 'Basic dXNlcjpwdw==' },
    });

    // A `Basic` header carries no bearer token at all, so the honest answer is
    // the same as no header: nothing was presented.
    expect(((await basic.json()) as Envelope).error.code).toBe('missing_token');
  });
});

suite('the correct token (AC1)', () => {
  it('reaches the route', async () => {
    configured();
    const response = await api.request(`${ORIGIN}/runs`, { headers: bearer(TOKEN) });

    // 503 because no ledger is registered in a unit test — which is the route
    // answering, and that is what this asserts.
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });
});

suite('GET /health (AC1)', () => {
  it('answers without a token, and is the only route that does', async () => {
    configured();
    const response = await api.request(`${ORIGIN}/health`);
    expect(response.status).toBe(200);
  });

  it('is exempt from the token but not from origin validation', async () => {
    configured();
    const response = await api.request(`${ORIGIN}/health`, {
      headers: { Origin: 'http://attacker.example' },
    });

    // The token exemption exists so `deflow up` can poll for readiness before
    // it has read the token file. A rebound page is not `deflow up`.
    expect(response.status).toBe(403);
    expect(((await response.json()) as Envelope).error.code).toBe('bad_origin');
  });
});

suite('a cross-origin request (AC3, test plan #3, EPIC-15-S9)', () => {
  it('is 403 bad_origin even with the correct token and a loopback Host', async () => {
    configured();
    const response = await api.request(`${ORIGIN}/runs`, {
      headers: { ...bearer(TOKEN), Origin: 'http://attacker.example' },
    });

    // The DNS-rebinding case: the Host is the daemon's own, the token is
    // right, and it is still refused — because the natural implementation
    // checks the origin only on the unauthenticated path, which leaves the
    // attack open the moment a token leaks.
    expect(response.status).toBe(403);
    const body = (await response.json()) as Envelope;
    expect(body.error.code).toBe('bad_origin');
    expect(body.error.retryable).toBe(false);
  });

  it('leaks no run data in the refusal body', async () => {
    configured();
    const response = await api.request(`${ORIGIN}/runs`, {
      headers: { ...bearer(TOKEN), Origin: 'http://attacker.example' },
    });
    const text = await response.text();

    expect(text).not.toContain('runId');
    expect(text).not.toContain(TOKEN);
  });

  it.each([
    ['http://127.0.0.1:7777', 200],
    ['http://localhost:7777', 200],
    ['http://attacker.example', 403],
    ['https://127.0.0.1:7777', 403],
    ['null', 403],
  ] as const)('Origin %s → %i (the allowlist outline)', async (origin, status) => {
    configured();
    const response = await api.request(`${ORIGIN}/health`, { headers: { Origin: origin } });
    expect(response.status).toBe(status);
  });

  it('accepts a request with no Origin at all when the token is valid (AC6)', async () => {
    configured();
    const response = await api.request(`${ORIGIN}/health`);
    expect(response.status).toBe(200);
  });
});

suite('Host validation (AC5, test plan #6)', () => {
  it('refuses a request whose Host is neither loopback nor the bind address', async () => {
    configured();
    const response = await api.request('http://attacker.example/runs', {
      headers: bearer(TOKEN),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as Envelope;
    expect(body.error.code).toBe('bad_origin');
    expect(body.error.detail.reason).toBe('host_not_allowed');
  });

  it('accepts the loopback names', async () => {
    configured();
    for (const host of ['http://127.0.0.1:7777', 'http://localhost:7777']) {
      const response = await api.request(`${host}/health`);
      expect(response.status, host).toBe(200);
    }
  });
});

suite('Vary: Origin (AC4, test plan #5, EPIC-15-S10)', () => {
  it('is on the 200, the 401, the 403 and the 404', async () => {
    configured();
    const responses = [
      await api.request(`${ORIGIN}/health`),
      await api.request(`${ORIGIN}/runs`),
      await api.request(`${ORIGIN}/runs`, {
        headers: { ...bearer(TOKEN), Origin: 'http://attacker.example' },
      }),
      await api.request(`${ORIGIN}/nope`, { headers: bearer(TOKEN) }),
    ];

    expect(responses.map((response) => response.status)).toEqual([200, 401, 403, 404]);
    for (const response of responses) {
      // Without it, any intermediate or browser cache can serve a response
      // computed for one origin to a request from another, which quietly
      // undoes the check above. The failure is invisible in development,
      // because there is no cache in the path.
      expect(response.headers.get('vary')).toContain('Origin');
    }
  });

  it('is on every registered route, authorized or not', async () => {
    configured();
    for (const route of answeringRoutes()) {
      const anonymous = await api.request(`${ORIGIN}${route.path}`, { method: route.method });
      expect(anonymous.headers.get('vary'), `${route.method} ${route.path}`).toContain('Origin');
    }
  });
});

suite('before boot has registered a token', () => {
  it('refuses every protected route rather than failing open', async () => {
    clearDaemonAuth();
    const response = await api.request(`${ORIGIN}/runs`, { headers: bearer(TOKEN) });

    // A daemon with no token configured is not "a daemon without auth", it is
    // a daemon that is not ready. Answering 200 here is the one bug in this
    // file that would be invisible in every other test.
    expect(response.status).toBe(503);
    const body = (await response.json()) as Envelope;
    expect(body.error.code).toBe('daemon_starting');
    expect(body.error.detail.reason).toBe('auth_unconfigured');
  });

  it('still answers GET /health, because that route is exempt by definition', async () => {
    clearDaemonAuth();
    const response = await api.request(`${ORIGIN}/health`);

    // Not a fallback and not a hole: it is the same one route the exemption
    // list names, and it is what `deflow up` polls to find out whether the
    // daemon it just started is up. Refusing the readiness probe until
    // readiness has completed is a deadlock, not a control.
    expect(response.status).toBe(200);
  });
});
