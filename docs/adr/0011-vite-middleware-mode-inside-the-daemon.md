# ADR 0011: Run Vite in middleware mode inside karvand

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

The default Vue + Node development setup is two processes: a Vite dev server on 5173, an API server
on some other port, and either `server.proxy` forwarding `/api` or CORS between them. It is
familiar, it is what every tutorial shows, and for Karvan it is the wrong shape.

**The entire UI is an SSE projection of the ledger.** Every one of the nine P0 views (F10.1–F10.9)
renders from the same event stream; there is no meaningful "fetch a resource" path for run state
([ADR 0012](./0012-ledger-projection-store-not-a-query-cache.md)). And **Vite's dev proxy is
documented-bad at SSE.** The failure modes are specific and all three are fatal here:

1. **Events buffered and delivered in one burst at stream end.** A live plan graph that updates once,
   at the end of a three-hour run.
2. **Proxy and socket timeouts killing long streams.** Karvan's streams are measured in hours.
3. **Close events not propagating to the backend** (vitejs/vite#12157, still open in spirit), so the
   daemon does not learn that a client went away.

The symptom of (1) in particular is "events arrive in bursts", which costs an afternoon to diagnose
and looks like a bug in your own streaming code. You would be debugging your transport instead of
your product.

There is also a milder but persistent cost to two processes: dev routing and production routing
differ, so "works in dev, broken in the built package" stays permanently possible. Since the
production shape is fixed — one daemon serving both the API and the built SPA assets on
`127.0.0.1:7777` ([ADR 0002](./0002-headless-daemon-with-localhost-web-ui.md)) — every divergence in
dev is a class of bug that only appears after `pnpm pack`.

**Verified 2026-08-02**: `vite@8.2.0`'s type declarations expose
`middlewareMode?: boolean | { server: HttpServer }`, where `server` is documented as "Parent server
instance to attach to. This is needed to proxy WebSocket connections to the parent server" — i.e.
HMR's WebSocket rides the daemon's own HTTP server.

## Decision

**`pnpm dev` starts exactly one process on exactly one URL: `http://127.0.0.1:7777`. Vite runs in
middleware mode inside karvand.**

```ts
const app = new Hono()
app.route('/api', api)
const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })

if (process.env.KARVAN_DEV === '1') {
  const { createServer } = await import('vite')
  const vite = await createServer({
    root: fileURLToPath(new URL('../../../web', import.meta.url)),
    appType: 'spa',
    server: { middlewareMode: { server } },   // HMR websocket through the daemon
  })
  app.use('*', honoAdapter(vite.middlewares))
} else {
  app.use('/assets/*', serveStatic({ root: uiDir }))
  app.get('*', (c) => c.html(indexHtml))       // SPA fallback
}
```

The Vite import is dynamic and gated on `KARVAN_DEV`, so Vite is a devDependency that is never
loaded — or shipped — in the published package.

HTTP framework is `hono` with `@hono/node-server`, chosen for first-class `streamSSE` and for
`hono/client` (`hc<AppType>`), which gives the Vue app end-to-end types straight off the route
definitions with no codegen and no OpenAPI step.

The SSE contract, `Last-Event-ID` resume from ledger offsets, and the daemon auth scheme are in
[11-api-and-realtime.md](../11-api-and-realtime.md).

## Consequences

### Positive
- **The SSE-through-proxy class of bug is removed entirely**, rather than mitigated with headers and
  timeout settings that must be right forever.
- **No proxy and no CORS.** The token-authenticated, `Origin`-checked, `127.0.0.1`-bound surface has
  exactly one origin in every environment.
- **Dev and production routing are byte-identical.** "Works in dev, broken in the built package"
  becomes almost impossible for anything routing-related.
- One process to start, one URL to open, one log stream to read. For a solo developer this is the
  lowest-ceremony loop that exists.
- HMR still works, riding the daemon's HTTP server.

### Negative
- **Every save restarts the whole daemon**, because `node --watch` is watching `packages/`. That is
  slower than a Vite-only reload for a pure CSS tweak. It is also, deliberately, a feature: every
  restart exercises F4.2 crash-resume, so if resume breaks you find out in seconds rather than in
  hour three of a real run.
- Vite's dev middleware lives inside the daemon's request pipeline, so a Vite error surfaces as a
  daemon error. Acceptable; it is gated behind one env check.
- The daemon has a devDependency on Vite. Bounded by the dynamic import.

### Neutral
- If the two-process shape is ever wanted for faster frontend iteration, the documented fallback is
  **not** a proxy: point `EventSource` directly at `import.meta.env.VITE_KARVAND_URL` and enable
  CORS for `http://localhost:5173` only when `KARVAN_DEV=1`. Skipping the proxy for the one thing
  proxies handle worst is the pragmatic move. If a proxy is used anyway, it needs
  `timeout: 0`, `proxyTimeout: 0`, `Cache-Control: no-cache, no-transform`,
  `X-Accel-Buffering: no`, and no compression middleware on that route.

## Alternatives considered

- **Separate Vite dev server + `server.proxy`.** The default, and rejected: the three documented SSE
  proxy failure modes above land directly on the transport the entire UI depends on.
- **Separate Vite dev server + CORS, no proxy.** Better than the proxy, and retained as the
  documented fallback. Rejected as the default because it reintroduces a dev/production routing
  divergence and a CORS configuration that exists only in one environment.
- **Serve a pre-built SPA in dev too.** Rejected: no HMR, and a build step in the inner loop.
- **Nuxt.** Rejected: Karvan serves a static SPA bundle from karvand on localhost; SSR and Nitro are
  pure overhead and add a second server process, which conflicts with the daemon-owns-execution rule
  (I2).

## Revisit when

**Vite ships documented, tested SSE support in its dev proxy** — specifically, when
vitejs/vite#12157 and its siblings are closed with proxy behaviour that streams without buffering,
honours indefinite timeouts, and propagates client close to the backend. Check the Vite changelog at
each major.

Even then, the routing-parity argument for middleware mode stands on its own, so a fixed proxy
would only make the two-process fallback safe — it would not by itself justify switching.

Secondary trigger: **daemon restart time exceeds about two seconds** and it becomes the dominant
cost in the inner loop. Cold start is budgeted at under three seconds (NF3), so if that budget is
being consumed by restart-on-save, the two-process fallback becomes worth the divergence.

---
[← ADR index](./README.md) · [Architecture docs](../README.md)
