---
closes: []
---

# S4 — one port carries SSE and HMR

> Spike for [KAR-00.3](../delivery/epics/EPIC-00-foundation-spikes.md#kar-003--spike-vite-middleware-mode-carrying-sse-and-hmr-on-one-port).
> Scenarios: [EPIC-00-S11, EPIC-00-S12, EPIC-00-S13](../delivery/flows/EPIC-00-foundation-spikes-flows.md).
> Artefact: [`spikes/s4-one-port/`](../../spikes/s4-one-port/), executed by
> [`test/integration/spike-s4-one-port.test.ts`](../../test/integration/spike-s4-one-port.test.ts),
> [`e2e/spike-s4-one-port.test.ts`](../../e2e/spike-s4-one-port.test.ts) and
> [`test/spike-s4-resume.test.ts`](../../test/spike-s4-resume.test.ts).

**Date:** 2026-08-04. **Machine:** macOS (darwin/arm64), Node v24.18.0, vite 8.2.0, hono 4.12.33,
`@hono/node-server` 2.0.12, Chromium 151 via playwright 1.62.1.

## The question

Does `vite@8.2.0`'s middleware mode actually attach HMR to the daemon's own `node:http` server, and
does an SSE route on that same server survive ten minutes without buffering or dying? D10 and
[ADR 0011](../adr/0011-vite-middleware-mode-inside-the-daemon.md) rest on that being true; before
this spike it rested on a **type declaration** — `middlewareMode?: boolean | { server: HttpServer }`,
documented as _"Parent server instance to attach to"_ — which is a signature, not a runtime
observation.

The second half settles the resume contract: `EventSource` sends `Last-Event-ID` only on an
automatic reconnect, never on a fresh `new EventSource()` after a page reload, and it cannot set
custom headers at all. So the endpoint must also accept `?since=<seq>`, and a page reload must lose
nothing and duplicate nothing.

## Method

`spikes/s4-one-port/` is a throwaway pnpm workspace holding one Node process:

- `server.ts` — Hono on `@hono/node-server`, an `/api/stream` SSE route driven by one shared
  emitter, and `vite` in `middlewareMode: { server }` **plus `ws: { server }`** serving a two-file
  Vue app from the same port. Three modes: the shape under test, and two deliberate
  misconfigurations (`fallback-first`, `compressed`) that EPIC-00-S12 asks to be reproduced once,
  on purpose.
- `client.mjs` — connects, records a client-side receipt timestamp per event, writes a CSV.
- `proxy.ts` — a real Vite dev server with `server.proxy`, i.e. the two-port shape D10 rejects. The
  only place in this repository where that key may appear; KAR-01.3's AC7 guard forbids it under
  `packages/`.
- `run-long.mjs` — the ten-minute run: a direct client and a proxied client for the same ten
  minutes, a `.vue` edit at t=300 s, and Vite's HMR websocket watched throughout. Its output is
  committed under `measurements/`.

## Measurement

| #   | Check                                                                                | Result                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Listening sockets of the harness pid (`lsof -nP -a -p … -iTCP -sTCP:LISTEN`)          | **exactly one**: `127.0.0.1:7777`. Vite's HMR websocket rides it                                                                                  |
| 2   | Ten minutes, one event per second, direct client (`measurements/ten-minutes-direct.csv`) | **600 events** over 599.8 s. Gaps: min 995.7 ms, median 1001.5 ms, p99 1002.9 ms, **max 1006.9 ms**. None over 1.5 s, let alone the 3 s AC2 allows |
| 3   | `.vue` edit at t=300 s                                                               | HMR `update` for `/src/Live.vue` on the same port's websocket, 1109 ms after the write (259 ms in an earlier run)                                  |
| 4   | The stream across that edit                                                          | body never ended, no reconnect, no gap and no duplicate around the edit                                                                           |
| 5   | `/api/stream` response headers                                                       | `content-type: text/event-stream`, `cache-control: no-cache, no-transform`, `x-accel-buffering: no`, **no** `Content-Encoding`                     |
| 6   | `GET /api/stream` with `Accept: text/html`, API mounted first                          | `text/event-stream` — the API wins, and the request never reaches Vite                                                                            |
| 7   | The same, with the SPA fallback mounted first                                        | **200 `text/html`, the SPA's `index.html`** — mount order is load-bearing, not a style preference                                                 |
| 8   | Compression middleware in front of the stream route                                  | reproduced: twelve events, emitted 100 ms apart, all received at t=1205 ms — one burst at stream end, `content-encoding: gzip`                    |
| 9   | The same, with `Cache-Control: no-cache, no-transform` left in place                  | **refused**: no `Content-Encoding`, events still one at a time                                                                                     |
| 10  | Page reload mid-stream, real Chromium                                                | **no `Last-Event-ID` header**; the page hydrates with `?since=<seq>` and the first event delivered is exactly `seq + 1`                            |
| 11  | Connection severed mid-stream, real Chromium                                         | the automatic reconnect **does** carry `Last-Event-ID` — and also re-sends the stale `?since` from the page's URL                                  |
| 12  | Ten minutes through a Vite dev proxy (`measurements/ten-minutes-proxied.csv`)         | survived: 600 events, max gap 1008.3 ms, no death, no burst — indistinguishable from the direct client                                             |
| 13  | Client disconnect through that proxy                                                 | the backend learned within ~1 s (6 ms in the recorded run) — the documented "close events do not propagate" symptom **did not reproduce**          |

Rows 1, 5–9, 11 and 13 are asserted by `test/integration/spike-s4-one-port.test.ts`; rows 10 and 11
by `e2e/spike-s4-one-port.test.ts` against a real Chromium; rows 2–4 and 12 by the same integration
file, reading the committed recording.

### Row 8 needed three deliberate mistakes, not one

`hono@4.12.33`'s `compress` middleware will not touch an SSE response, and it declines for three
independent reasons in the same guard clause: `text/event-stream` is excluded from
`COMPRESSIBLE_CONTENT_TYPE_REGEX`, a `Cache-Control` containing `no-transform` short-circuits it,
and a response that already carries `Transfer-Encoding` (which `streamSSE` always sets) is skipped.
Reproducing the documented buffering symptom meant overriding the content-type filter, dropping
`no-transform`, and deleting `Transfer-Encoding` — all three, in `S4_MODE=compressed`.

That is worth stating the other way round, because it is the useful direction: **`no-transform` is
not documentation.** It is read at runtime by the very middleware that would otherwise destroy the
stream. AC4 asks for a header; what it is really asking for is this behaviour, and row 9 is the
spec that keeps it.

### Rows 12 and 13: two of the three documented proxy failure modes did not reproduce

[03-local-development.md §4.3](../03-local-development.md) lists three failure modes for Vite's dev
proxy in front of an SSE endpoint, citing vitejs/vite#12157 and discussion #10851: events buffer
into one burst, long streams die after some minutes, and close events never reach the backend. On
`vite@8.2.0`, measured here:

- **buffering** — did not reproduce. The proxied client's inter-arrival gaps match the direct
  client's, second by second.
- **long streams dying** — did not reproduce. The proxied client held the same ten minutes as the
  direct one and received all 600 events, with a maximum inter-arrival gap of 1008.3 ms.
- **close not propagating** — did not reproduce. When the client navigated away, the backend saw
  the disconnect in 6 ms; the proxy tore the upstream connection down with it.

Those reports are against older Vite majors and a different proxy implementation; nothing here says
they were wrong then. What this spike can say is that **on the version this project pins, they are
not the reason to avoid a proxy.** The reason is the one D10 gives: one origin removes CORS,
removes the second port, and makes dev and production routing identical, so "works in dev, broken in
the built package" stops being possible for anything routing-related. That argument does not depend
on any bug, which makes it the more durable one to hold — and it means `test/dev-loop.test.ts`'s
guard is enforcing an architectural decision rather than a workaround.

### Row 11 changed the resume contract

The reload case behaved exactly as documented — a fresh `EventSource` sends no `Last-Event-ID`,
which is why `?since=` is mandatory rather than an optimisation. The *reconnect* case produced
something this spike did not anticipate: the browser reconnects **to the same URL**, so a page that
hydrated at `/api/stream?since=137` and lost its connection at seq 150 sends the stale `?since=137`
and a current `Last-Event-ID: 150` **together**.

A server that prefers `?since` there replays thirteen events the page already had — the duplication
AC5 forbids. The contract is therefore: **resume from the greater of the two cursors**, and a tie
counts as a reconnect. `spikes/s4-one-port/src/resume.ts` implements it and
`test/spike-s4-resume.test.ts` pins it. Both halves stay: `?since` for the reload, `Last-Event-ID`
for the reconnect, and "strictly greater than", never "seq + 1", because a rolled-back transaction
burns an AUTOINCREMENT value in the real ledger.

## Decision

**Adopt middleware mode: one process, one port, no proxy — as ADR 0011 and D10 describe.** Every
claim the decision rested on holds when executed:

- one listening socket, with HMR on it (row 1);
- ten minutes of one-per-second SSE arriving individually, not in a burst (row 2);
- a `.vue` hot reload mid-stream that the stream does not notice (rows 3, 4);
- the API route reaching the API rather than the SPA, because it is mounted first (rows 6, 7).

The fallback described in KAR-00.3 ("two ports with a documented proxy configuration") is **not
needed** and must not be adopted: it would make the dev loop structurally different from production
routing, which is the class of bug D10 exists to delete.

### The guards this hands on

- **KAR-01.3** already asserts "no server.proxy anywhere in the repo" (AC7,
  `test/dev-loop.test.ts` via `checkNoViteProxy`). It is the story that must keep asserting it — and
  after rows 12 and 13 the comment attached to that guard should say it is enforcing D10, not
  routing around a Vite bug.
- **KAR-15.3** (the multiplexed SSE stream, EPIC-15) is the story that must assert the response
  headers on the real endpoint: `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`,
  and **no compression middleware** in front of the stream route. Row 9 shows the first of those is
  what actually stops the damage, so it is the one to assert on the response, not merely to set.
- **KAR-15.3** also owns the resume contract: accept both `?since=<seq>` and `Last-Event-ID`,
  resume from the greater of the two, and deliver strictly greater than that cursor.

### What is left alone

`docs/03-local-development.md` §4.3 keeps its rule ("do not add a Vite proxy — ever") because the
rule is right for reasons that outlive the bugs it cites. Its table of three failure modes is now
qualified by rows 12 and 13 above, and it points here for what was measured.
