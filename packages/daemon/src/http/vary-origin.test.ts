/**
 * KAR-25.9 — the response `varyOrigin` must not touch.
 *
 * Verifies: EPIC-25-S56 (the sentinel survives `varyOrigin` untouched, by
 * identity), EPIC-25-S60 (the ordinary and refusal paths still carry
 * `Vary: Origin`, unchanged)
 *
 * Wires a real `Hono` app the way `server.ts` does — `app.use('*',
 * varyOrigin)` mounted first, ahead of whatever the route does — rather than
 * calling `varyOrigin` as a bare function, because the defect was never in
 * `varyOrigin`'s logic read in isolation. It was in what `c.header()` does to
 * `c.res` *inside a real Hono context*, which only a real app reproduces.
 *
 * `RESPONSE_ALREADY_SENT` is a module-level singleton (see `auth.ts`'s header
 * comment): the property that matters is that the exact same object comes out
 * the other end of `app.fetch`, not a copy that happens to carry the same
 * `x-hono-already-sent` header. `c.header()` rebuilds `c.res` as a new
 * `Response`, so the moment `varyOrigin` calls it unconditionally, identity
 * is exactly what breaks — which is also, verbatim, the previous bug: the
 * rebuilt sentinel no longer satisfies `@hono/node-server`'s
 * already-sent check, so it falls into the ordinary write path and
 * `writeHead` hits a socket that has already been ended.
 */
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono } from 'hono';
import { expect, it, describe as suite } from 'vitest';
import { varyOrigin } from './auth.ts';

function buildApp(): Hono<{ Bindings: HttpBindings }> {
  const app = new Hono<{ Bindings: HttpBindings }>();
  app.use('*', varyOrigin);
  return app;
}

suite('EPIC-25-S56 — the already-sent sentinel is returned untouched', () => {
  it('comes out of the app as the exact RESPONSE_ALREADY_SENT singleton', async () => {
    const app = buildApp();
    app.get('/already-sent', () => RESPONSE_ALREADY_SENT);

    // `app.request` drives the real `app.fetch` Hono builds from the
    // middleware chain — the same handoff `createAdaptorServer` calls in
    // production and the point where `@hono/node-server` decides, from the
    // `Response` it gets back, whether to skip the socket write. Whatever
    // comes out of `fetch` here is exactly what that decision is made from.
    const response = await app.request('/already-sent');

    // Identity, not a header sniff (see auth.ts): a `varyOrigin` that
    // rebuilds the response — the old, unconditional `c.header()` call —
    // fails this assertion even though the rebuilt response still carries
    // `x-hono-already-sent`.
    expect(response).toBe(RESPONSE_ALREADY_SENT);
  });
});

suite('EPIC-25-S60 — the ordinary and refusal paths are unchanged', () => {
  it('a normal 2xx response still carries Vary: Origin', async () => {
    const app = buildApp();
    app.get('/ok', (c) => c.json({ ok: true }));

    const response = await app.request('/ok');

    expect(response.status).toBe(200);
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('a refusal (non-2xx) response still carries Vary: Origin (AC4)', async () => {
    const app = buildApp();
    app.get('/refused', (c) => c.json({ error: { code: 'bad_token' } }, 401));

    const response = await app.request('/refused');

    expect(response.status).toBe(401);
    expect(response.headers.get('vary')).toBe('Origin');
  });
});
