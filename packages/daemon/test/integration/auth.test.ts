/**
 * KAR-15.2 test plan #3, #5, #6, #11 — the half of the auth contract that is
 * only true on a real socket.
 *
 * Verifies: EPIC-15-S7, EPIC-15-S9 (the rebinding request as a client actually
 * sends it), EPIC-15-S10 (the stream's own response), EPIC-15-S11 (a forged
 * `Host`, which `fetch` will not send) · AC1, AC3, AC4, AC5, AC6, AC11, AC12
 *
 * Integration because three of these cannot be reached through
 * `app.request()`: `fetch` computes `Host` from the URL and refuses to forge
 * it, the SSE stream's headers are written by the adaptor, and a WebSocket
 * upgrade is not an HTTP round trip at all — it is a socket the guard has to
 * refuse *before* anybody accepts it.
 */
import { it } from '@DeFlow/testkit';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, describe as suite } from 'vitest';
import { NonLoopbackBindRefused } from '../../src/http/auth.ts';
import { clearUpgradeHandler, setUpgradeHandler, startHttp } from '../../src/http/server.ts';

const TOKEN = 'an-integration-token-that-is-not-a-real-one';

type Started = Awaited<ReturnType<typeof startHttp>>;

let started: Started | undefined;
let port = 0;
let origin = '';

beforeAll(async () => {
  started = await startHttp({ port: 0, hostname: '127.0.0.1', dev: false, token: TOKEN });
  port = (started.server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
  clearUpgradeHandler();
  await started?.close();
});

const bearer = { Authorization: `Bearer ${TOKEN}` };

interface Envelope {
  readonly error: { readonly code: string; readonly detail: Record<string, unknown> };
}

suite('a client that sends no Origin at all (AC6, EPIC-15-S11)', () => {
  it('is accepted when the token is valid — this is the CLI and curl', async () => {
    const response = await fetch(`${origin}/api/runs`, { headers: bearer });

    // `undici` sends no `Origin` for a plain `fetch` from Node, which is
    // exactly what `DeFlow run` and `curl` look like on the wire.
    expect(response.status).not.toBe(401);
    expect(response.status).not.toBe(403);
  });

  it('is refused with 401 missing_token when it sends no token either', async () => {
    const response = await fetch(`${origin}/api/runs`);

    expect(response.status).toBe(401);
    expect(((await response.json()) as Envelope).error.code).toBe('missing_token');
  });
});

suite('the DNS-rebinding request (AC3, EPIC-15-S9)', () => {
  it('is 403 bad_origin with a loopback Host and the correct token', async () => {
    // The exact shape a rebound page produces: the browser resolved
    // attacker.example to 127.0.0.1, so `Host` is the daemon's own — and the
    // one thing the page cannot forge is `Origin`.
    const response = await fetch(`${origin}/api/runs`, {
      headers: { ...bearer, Origin: 'http://attacker.example' },
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as Envelope;
    expect(body.error.code).toBe('bad_origin');
    expect(response.headers.get('vary')).toContain('Origin');
    expect(JSON.stringify(body)).not.toContain('runId');
  });

  it('accepts the daemon’s own origin on the port it actually bound', async () => {
    const response = await fetch(`${origin}/api/health`, {
      headers: { Origin: `http://127.0.0.1:${port}` },
    });
    expect(response.status).toBe(200);
  });

  it('accepts localhost as well as 127.0.0.1, on that same port', async () => {
    const response = await fetch(`${origin}/api/health`, {
      headers: { Origin: `http://localhost:${port}` },
    });
    expect(response.status).toBe(200);
  });
});

suite('Host validation (AC5, test plan #6)', () => {
  it('refuses a forged Host header', async () => {
    // `fetch` derives `Host` from the URL and will not let a caller override
    // it, so this is a raw `node:http` request — which is also what a rebound
    // page's *proxy* would look like, and what a `curl -H Host:` looks like.
    const { status, body } = await rawRequest('/api/runs', {
      Host: 'attacker.example',
      ...bearer,
    });

    expect(status).toBe(403);
    const envelope = JSON.parse(body) as Envelope;
    expect(envelope.error.code).toBe('bad_origin');
    expect(envelope.error.detail.reason).toBe('host_not_allowed');
  });

  it('accepts a loopback Host', async () => {
    const { status } = await rawRequest('/api/health', { Host: `localhost:${port}` });
    expect(status).toBe(200);
  });
});

suite('Vary: Origin on every response (AC4, EPIC-15-S10)', () => {
  it('is on /api/health, on a refusal, and on a 404', async () => {
    const health = await fetch(`${origin}/api/health`);
    const refusal = await fetch(`${origin}/api/runs`);
    const missing = await fetch(`${origin}/api/nope`, { headers: bearer });

    expect([health.status, refusal.status, missing.status]).toEqual([200, 401, 404]);
    for (const response of [health, refusal, missing]) {
      expect(response.headers.get('vary')).toContain('Origin');
    }
  });

  it('is on the SSE stream response, which is built by a different code path', async () => {
    const controller = new AbortController();
    try {
      const response = await fetch(`${origin}/api/stream`, {
        headers: bearer,
        signal: controller.signal,
      });

      expect(response.status).toBe(200);
      // `streamSSE` builds its own Response rather than going through
      // `c.json`, which is exactly where a header set on the success path only
      // would go missing.
      expect(response.headers.get('vary')).toContain('Origin');
    } finally {
      controller.abort();
    }
  });

  it('is on the SPA fallback too, not only under /api', async () => {
    const response = await fetch(`${origin}/`);
    expect(response.headers.get('vary')).toContain('Origin');
  });
});

suite('the WebSocket upgrade (AC11, test plan #11)', () => {
  it('is refused with 401 before the socket is accepted', async () => {
    const accepted: string[] = [];
    setUpgradeHandler((request) => {
      accepted.push(request.url ?? '');
    });

    const { status, body } = await rawRequest('/api/runs/r_1/terminal', {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'x3JJHMbDL1EzLkh9GBhXDw==',
    });

    expect(status).toBe(401);
    expect((JSON.parse(body) as Envelope).error.code).toBe('missing_token');
    // The assertion that says "before the socket is accepted": KAR-15.8's
    // handler — the thing that would fire `connection` — never ran at all.
    expect(accepted).toEqual([]);
  });

  it('reaches the registered handler once the token is right', async () => {
    const accepted: string[] = [];
    setUpgradeHandler((request, socket) => {
      accepted.push(request.url ?? '');
      socket.destroy();
    });

    await rawRequest('/api/runs/r_1/terminal', {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'x3JJHMbDL1EzLkh9GBhXDw==',
      ...bearer,
    }).catch(() => undefined);

    expect(accepted).toEqual(['/api/runs/r_1/terminal']);
  });

  it('refuses a hostile Origin on the upgrade as well', async () => {
    const accepted: string[] = [];
    setUpgradeHandler((request) => {
      accepted.push(request.url ?? '');
    });

    const { status, body } = await rawRequest('/api/runs/r_1/terminal', {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': 'x3JJHMbDL1EzLkh9GBhXDw==',
      Origin: 'http://attacker.example',
      ...bearer,
    });

    expect(status).toBe(403);
    expect((JSON.parse(body) as Envelope).error.code).toBe('bad_origin');
    expect(accepted).toEqual([]);
  });
});

suite('the bind (AC12)', () => {
  it('refuses a non-loopback bind with no explicit flag, and binds nothing', async () => {
    await expect(
      startHttp({ port: 0, hostname: '0.0.0.0', dev: false, token: TOKEN }),
    ).rejects.toThrow(NonLoopbackBindRefused);
  });

  it('names the flag that would allow it, rather than silently using loopback', async () => {
    // The refusal is on the *bind*, not on the literal 0.0.0.0 — so a LAN
    // address, which is how the "phone on the same Wi-Fi" case would arrive,
    // is refused by the same rule and told the same thing.
    await expect(
      startHttp({ port: 0, hostname: '192.168.1.10', dev: false, token: TOKEN }),
    ).rejects.toThrow(/DeFlow_ALLOW_NON_LOOPBACK/);
  });
});

/**
 * A request with headers `fetch` refuses to send — `Host` above all.
 *
 * Resolves on the first response, whether that is a normal one or the refusal
 * written onto a socket that asked to be upgraded.
 */
function rawRequest(
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const client = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    client.on('upgrade', () => reject(new Error('the socket was upgraded')));
    client.on('error', reject);
    client.end();
  });
}
