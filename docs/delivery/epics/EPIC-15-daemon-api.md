# EPIC-15: Daemon API and event stream

> Part of the [Karvan delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-15-daemon-api-flows.md)

| | |
|---|---|
| **Epic ID** | EPIC-15 |
| **Status** | Not started |
| **Priority** | P0 |
| **Milestone** | M1 |
| **Workstream** | W9 (see [roadmap §2.2](../../17-roadmap.md)) |
| **Size** | ~19 days across 8 stories — **over the ~15-day guidance; see Risks** |
| **Depends on** | EPIC-02 (the `Event` union the stream serialises and the typed client re-exports), EPIC-03 (the ledger's `AUTOINCREMENT` seq, the read-only connections, `daemon_epoch`), EPIC-11 (plan versions and diffs are half the read surface), EPIC-06/EPIC-12/EPIC-13 (the service functions the control and human endpoints mount) |
| **Blocks** | EPIC-16 (the whole UI is a client of this contract), EPIC-17 (KAR-15.6's read endpoints and KAR-15.7's snapshot), EPIC-18 (the CLI imports the same client module) |
| **PRD requirements** | F4.1, F4.4, F5.7, F8.1, F8.2, F8.3, F2.5, F2.6, F3.4, F3.5, F6.3, F6.5, F7.3, F7.4, F7.7, F10.2, F10.3, F10.5, F10.6, F10.7, F10.10, NF3, NF8, NF10, NF2 |
| **Architecture** | [11-api-and-realtime.md](../../11-api-and-realtime.md) (whole document), [15-security-model.md §3, §4](../../15-security-model.md), [05-durable-execution.md §6, §12](../../05-durable-execution.md), [03-local-development.md §4](../../03-local-development.md) |

## Goal

At the end of this epic there is exactly one API and exactly one event stream, and both the browser
UI and the `karvan` CLI are clients of them through the same typed module. A tab opens **one**
multiplexed SSE connection for its whole lifetime, subscribes and unsubscribes runs on it without
reconnecting, and can rejoin the log at an exact sequence after a reconnect, a page reload or a
daemon restart without losing or duplicating a single event. Every request except `GET /api/health`
carries a bearer token and passes origin validation, and the token never appears in a URL. A client
that is behind — by four events or by four hours — has one query that catches it up and one
server-side snapshot endpoint that spares the browser from replaying a multi-hour run in JavaScript.

## Why this matters

W9 sits between everything that produces state and everything that renders it, and the roadmap's
critical path is explicit that **W9 comes before any UI work**, *"because a view built against a
hand-rolled fixture will be rebuilt against the real stream."* Three properties in this epic are
architectural rather than incremental, and each of them is much cheaper to design in than to
retrofit:

- **One SSE connection per tab is a constraint, not a tuning knob.** `karvand` runs on Node's `http`
  server, which is HTTP/1.1; browsers refuse h2c so HTTP/2 on localhost would require shipping a
  certificate for `127.0.0.1`; and browsers cap concurrent connections per origin at about **six**.
  An SSE connection never closes. One stream per run panel across two or three tabs exhausts the
  budget, and *the failure mode is not an error* — every subsequent `fetch` silently queues behind
  the streams, forever. It reads as "the daemon hung" and costs an afternoon the first time.
- **`Last-Event-ID` alone is not a resume mechanism.** The browser sends it only when its own
  reconnection logic fires on a connection that had previously opened successfully — never after a
  page reload, never on a first connection, and never when the initial connect failed because the
  daemon was not up yet. That last case is the common one in development. If the server treats "no
  `Last-Event-ID`" as "start from head", the UI silently loses every event that occurred while it was
  down and shows a plausible but wrong picture: a direct **NF10** violation. The explicit `?since=`
  cursor path is therefore **mandatory, not an optimisation**.
- **Localhost is not authentication.** Every process running as the user reaches `127.0.0.1:7777` —
  including *the agents Karvan itself spawned*, which is the one that matters: an agent with a
  prompt-injected instruction and a shell is inside the trust boundary of an unauthenticated daemon
  that can start runs, read every artifact and approve human gates. And any page the user has open
  can reach the daemon by DNS rebinding. Bearer token and `Origin` validation from commit one, and
  the token in a URL **fragment** rather than a query string, because a query string lands in shell
  history, terminal scrollback, browser history, `Referer` headers and any access log anyone ever
  adds.

## Scope

**In scope:**

- The Hono app on `@hono/node-server`, mounted at `/api`, sharing one `node:http` server with Vite's
  middleware mode in dev and the static `dist/ui` in production — one process, one port, no proxy, no
  CORS, byte-identical routing between dev and prod.
- `export type ApiType = typeof api` and `hc<ApiType>` as the entire client contract: no codegen, no
  OpenAPI document, no schema drift, and a daemon route change that breaks the UI build in the same
  commit.
- The closed error envelope `{ error: { code, message, detail, retryable, seq? } }` and its full
  status→code table, with domain failures as values rather than exceptions.
- Bearer token generation, storage in `.karvan/daemon.json` mode `0600`, constant-time comparison,
  the `Origin` allowlist, `Vary: Origin` on every response, `Host` validation, and the fragment-based
  first-run handoff.
- The multiplexed SSE endpoint: the `hello` / `subscribed` / `caught_up` control frames, `id: <seq>`
  on every ledger frame, `retry: 2000`, a `: keepalive` comment every 15 s, the response header set,
  the two-phase drain loop, the post-commit emitter, bounded `LIMIT 500` reads on read-only
  connections, per-run merge-sort by `seq`, and `POST /stream/:streamId/subscribe` with
  backfill-before-live.
- Resume on both paths — `?since=` and `Last-Event-ID` — with the precedence rule, the `?since=0`
  hydrate endpoint with `cursor` / `headSeq` / `more`, and the gap-tolerance contract.
- Control endpoints (pause, resume, cancel), human-in-the-loop endpoints and patch decisions mounted
  onto EPIC-06/13's service functions, with `ifLastSeq` optimistic concurrency, `Idempotency-Key` on
  creation, and natural idempotency for repeated writes.
- The read surface: plans and plan diffs, node inspector bundles, packets, `io_chunk` tails as
  NDJSON, facts and consumers, gates, criteria, findings, diffs as `text/x-patch`, content-addressed
  artifacts with `Range` and immutable caching, providers, config and health.
- `GET /runs/:id/snapshot?seq=N` — reduced state computed server-side, because SQLite rebuilds state
  far faster than the browser can (**verified 2026-08-02**: 10,000 control-plane events reduced in
  **29 ms**).
- The PTY WebSocket upgrade (added story, P1) with bearer auth enforced before the socket is
  accepted.

**Out of scope:**

- The Vue application, the SSE client's reconnection policy, the projection store and the client-side
  cursor persistence — [EPIC-16](./EPIC-16-ui-foundation.md) KAR-16.2 and KAR-16.4. This epic owns
  the server contract and the shared `packages/web/src/api/` modules that both clients import; EPIC-16
  owns what the browser does with them.
- The business logic behind every handler. Pause/resume/cancel semantics are
  [EPIC-06](./EPIC-06-orchestrator.md) KAR-06.7; approvals, interjection and patch decisions are
  [EPIC-13](./EPIC-13-human-in-the-loop.md); gates, verdicts and criteria are
  [EPIC-12](./EPIC-12-verification-gates.md); plan versions and diffs are
  [EPIC-11](./EPIC-11-dynamic-planning.md). This epic mounts them, types them and defines their wire
  shapes.
- The ledger schema, the `event_run_seq` covering index, the read-only connection pool and
  `daemon_epoch` — [EPIC-03](./EPIC-03-event-ledger.md). This epic consumes them and asserts the
  properties it depends on.
- `karvan up` / `init` / `doctor` themselves — [EPIC-18](./EPIC-18-cli-packaging.md). This epic
  defines the token file the bootstrap writes and the `/health` endpoint the bootstrap polls.
- The `SharedWorker` + `BroadcastChannel` hardening that would reduce N tabs to one connection
  total — explicitly deferred in [11 §2](../../11-api-and-realtime.md); roughly half a day, and not
  worth building until three-plus tabs is a habit rather than a hypothetical.
- `/api/v2/...`. Reserved and unused. The API is versioned on event payload `v`, on
  `X-Karvan-Api` + `hello.build` for skew, and only a shape break would need a URL — which nothing in
  M1 does.
- Non-loopback binding ("phone on the same Wi-Fi", PRD I4). It needs an explicit flag, TLS or a
  tunnel, and a persistent UI indicator, and [15 §3.3](../../15-security-model.md) marks the
  transport question **Unverified / decide before M2**. Shipping the bind before answering it would
  be the wrong order.

## Definition of Ready (epic level)

- [ ] **EPIC-03 Done.** `event` with `INTEGER PRIMARY KEY AUTOINCREMENT`, the `event_run_seq`
      covering index, separate read-only connections with `busy_timeout`, the `io_chunk` table, and
      `daemon_epoch` stamped on every write.
- [ ] **Spike S4 green** (roadmap §1): one `node` process on port 7777 streaming SSE for ten minutes
      with events arriving individually — measured by client-side timestamps, not by eyeball — while
      hot-reloading a `.vue` edit over the same port without dropping the connection.
- [ ] **EPIC-11 Done through KAR-11.5**, so `GET /runs/:id/plans` and `plans/diff` have real versions
      to serve rather than a fixture.
- [ ] The service functions for pause/resume/cancel, approvals and patch decisions exist and are
      callable in-process (EPIC-06, EPIC-13). Mounting a route over a function that does not exist is
      not a smaller task, it is a different one.
- [ ] A replay fixture corpus exists at `test/fixtures/runs/` including **`crash-resume-seq-gap`** —
      a ledger whose sequence numbers jump, as a real SIGKILL produces. Half the resume scenarios in
      this epic are unwritable without it.

## Definition of Done (epic level)

- [ ] All eight stories `Done` (KAR-15.8 may be `Not started` at M1 — it is the one P1 story; see its
      entry).
- [ ] Every scenario in [the flow file](../flows/EPIC-15-daemon-api-flows.md) exists as an automated
      test at the level its `Automated at:` line names, and passes.
- [ ] `karvan replay <fixture>` serves a recorded ledger over **the same HTTP + SSE contract as a
      live run**, at configurable speed — proven by running the same client test suite against both.
- [ ] The Playwright smoke *"live SSE: replay at speed, kill the connection, assert the UI reconnects
      and backfills without a gap or a duplicate"* passes.
- [ ] A DNS-rebinding simulation (valid `Host`, hostile `Origin`) is rejected, and an unauthenticated
      request from a mock agent's own `terminal/create` is rejected.
- [ ] No `Unverified` claim in [11-api-and-realtime.md](../../11-api-and-realtime.md) remains
      unverified in this area, and the `?t=` query-parameter handoff described in
      [03 §9 step 8](../../03-local-development.md) is corrected to the fragment form in that document
      — see KAR-15.2's notes.

## User stories

### KAR-15.1 — HTTP server, routing and the typed client

| | |
|---|---|
| **Status** | Ready |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | EPIC-01 KAR-01.3 (the one-port dev loop), EPIC-03 KAR-03.1 (the `Db` port) |
| **PRD** | NF3, NF6, NF8 |
| **Verified by** | EPIC-15-S1, EPIC-15-S2, EPIC-15-S3, EPIC-15-S4, EPIC-15-S5, EPIC-15-S6 |

**As** the UI and the CLI, **I want** one typed HTTP surface that both of us import rather than two
hand-written clients, **so that** renaming a field in the daemon breaks the build in the same commit
instead of breaking a view at runtime three weeks later.

[11 §9](../../11-api-and-realtime.md) makes this a two-line contract: the Hono app's chained route
definitions produce `export type ApiType = typeof api`, and `hc<ApiType>(baseUrl, …)` gives the Vue
UI and `packages/cli` end-to-end types with no codegen step, no OpenAPI document and no schema
drift. Because `@karvan/daemon`'s `exports` field points at `./src/index.ts` inside the workspace, the
UI typechecks against **live daemon source**. For a solo developer that is the single largest
cross-boundary ergonomic available, and it costs nothing.

The serving shape is fixed by [03 §4](../../03-local-development.md): `serve({ fetch: app.fetch, …})`
hands back the real `node:http` server, the API mounts first so it always wins over the SPA fallback,
and in dev Vite runs in middleware mode attached to that same server so HMR's WebSocket rides
karvand's own port. One origin, no CORS, no proxy — which exists specifically because Vite's dev
proxy is documented-bad at SSE and the entire UI is an SSE projection.

Errors are the other half of the contract. Domain failures are **values, not exceptions**, and the
wire shape is a closed envelope with a stable `code` clients may branch on, a human `message` that
may change freely, a typed `detail`, and — where the failure also produced a ledger event — its
`seq`, so the UI can link "this failed" to "here is the event that says so". That is NF10 applied to
the error path, which is exactly where auditability usually stops.

**Acceptance criteria**

1. Routes are defined as one chained expression so `hc<ApiType>` infers them; a test in
   `packages/web` calls `rpc.runs[':id'].$get(...)` and the response type is the daemon's own return
   type, not `any`.
2. Renaming a field on a daemon response type fails `pnpm typecheck` in `packages/web` and
   `packages/cli` — asserted by a typecheck-level fixture, not by a comment.
3. Every response carries `X-Karvan-Api: 1`. `GET /api/health` returns
   `{ apiVersion, build, daemonEpoch, headSeq, uptimeMs }` and is the **only** unauthenticated route;
   a test enumerates every registered route and asserts exactly one is exempt.
4. Every error response matches the closed envelope and its `code` is a member of the documented
   union. A table-driven test covers each documented status → code mapping (400 `invalid_request` /
   `schema_violation` / `unknown_provider`; 401 `missing_token` / `bad_token`; 403 `bad_origin` /
   `permission_refused` / `path_scope_violation`; 404 `run_not_found` / `node_not_found` /
   `artifact_not_found` / `plan_version_not_found`; 409 `stale_cursor` / `run_not_pausable` /
   `patch_already_decided` / `epoch_mismatch`; 413 `payload_too_large`; 422 `spec_not_approved` /
   `capability_unsupported`; 429 `provider_rate_limited`; 500 `internal`; 503 `daemon_starting` /
   `provider_unavailable`).
5. No thrown `Error` reaches a client. A handler that throws produces `500 internal` with no stack
   trace in the body, and the stack is written to an artifact behind a handle.
6. `hono/compress` is mounted on JSON routes only. A test asserts `/api/stream` responses carry no
   `Content-Encoding`, and a lint or route-table assertion prevents a future global `app.use`.
7. The API mounts before the SPA fallback: `GET /api/nope` returns a 404 envelope, not `index.html`.
8. In dev (`KARVAN_DEV=1`) the same process serves `/api/*`, the Vite middleware and the HMR
   WebSocket on port 7777; in production it serves `/api/*` and `dist/ui` from the same port. The
   route table is identical apart from which middleware serves the UI.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | `app.request('/api/health')` returns the documented body and `X-Karvan-Api: 1` | No app exists |
| 2 | contract | Typecheck fixture: `rpc.runs[':id'].$get` result is assignable to the daemon's return type; a renamed field breaks it | Routes are not chained, so `hc` infers `any` |
| 3 | unit | Route enumeration: exactly one route is exempt from auth | A second unauthenticated route creeps in |
| 4 | unit | Table-driven error mapping over every documented status → code pair | Errors are ad-hoc objects |
| 5 | unit | A handler that throws → `500 internal`, no stack in the body | Exceptions leak to the wire |
| 6 | integration | Real `@hono/node-server` on an ephemeral port: `/api/stream` has no `Content-Encoding`; a JSON route does | Compression is global |
| 7 | integration | `GET /api/nope` → 404 envelope; `GET /nope` → SPA fallback | Mount order is wrong |
| 8 | e2e | Boot the daemon with `KARVAN_DEV=1`: `/api/health`, a `.vue` HMR update and an SSE connection all live on port 7777 simultaneously | Vite is a second process behind a proxy |

**Notes / risks** — `middlewareMode?: boolean | { server: HttpServer }` was **verified 2026-08-02** in
`vite@8.2.0`'s bundled type declarations, where `server` is documented as *"Parent server instance to
attach to. This is needed to proxy WebSocket connections to the parent server."* If that option ever
regresses, the fallback is two processes and a proxy — at which point `timeout: 0` and
`proxyTimeout: 0` are mandatory and the stream must be re-verified as unbuffered before anything
observed through it is trusted.

---

### KAR-15.2 — Bearer-token auth and origin validation

| | |
|---|---|
| **Status** | Ready |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-15.1 |
| **PRD** | NF2, and the threat model in PRD §4.5 / §13 |
| **Verified by** | EPIC-15-S7, EPIC-15-S8, EPIC-15-S9, EPIC-15-S10, EPIC-15-S11, EPIC-15-S12, EPIC-15-S13, EPIC-15-S14 |

**As** the user of a machine that also runs npm `postinstall` scripts, browser extensions and agents
Karvan itself spawned, **I want** the daemon to authenticate every request and reject every foreign
origin, **so that** finding port 7777 is not the same thing as being able to drive it.

[15 §3](../../15-security-model.md) states the position plainly: binding to loopback is **not**
authentication. Two attacks make it insufficient. Any local process running as the user can reach
`127.0.0.1:7777` — and the one that matters most is an agent Karvan spawned, because *"an agent with
a prompt-injected instruction and a shell is inside the trust boundary of an unauthenticated daemon
that can start runs, read every artifact and approve human gates."* And DNS rebinding lets any page
the user already has open issue requests from the browser's own network position; same-origin policy
does not help, because the browser believes the origin is `attacker.example`.

Six controls, all required: default bind `127.0.0.1` only; a 32-byte `crypto.randomBytes` base64url
token in the gitignored `.karvan/daemon.json` at mode `0600`, compared in constant time; an `Origin`
allowlist of `http://127.0.0.1:7777` and `http://localhost:7777`; `Vary: Origin` on **every**
response, without which a cache can serve a response computed for one origin to a request from
another and defeat the check; `Host` validation as the second half of the rebinding defence; and **no
credentials in URLs, ever**.

That last one is why `eventsource-client@^1.2.0` is a dependency rather than native `EventSource`:
native `EventSource` cannot send custom headers, and a design built on it forces the token into the
query string, where it lands in shell history, terminal scrollback, browser history, the `Referer`
header of any outbound link, and any access log anyone ever adds. For a long-lived token that
authorises spawning processes on the user's machine, that is unacceptable. The first-run handoff is
therefore a **fragment**: `karvan up` prints `http://127.0.0.1:7777/#token=<token>`, fragments are
never sent to the server, and the UI reads it once, stores it in `sessionStorage`, strips it from the
address bar with `history.replaceState`, and sends it as an `Authorization` header thereafter.

**Acceptance criteria**

1. A request to any route except `GET /api/health` without an `Authorization` header is rejected with
   `401 missing_token`; with a wrong token, `401 bad_token`. Neither response body reveals the
   expected token's length or any part of it.
2. Token comparison uses a constant-time primitive and handles unequal lengths without an early
   return; a unit test asserts the comparison function is `timingSafeEqual`-based rather than `===`.
3. A request carrying `Origin: http://attacker.example` is rejected with `403 bad_origin` **even when
   the bearer token is correct**, and even when `Host` is a loopback name — the DNS-rebinding case.
4. `Vary: Origin` is present on **every** response, including 401s, 403s, the SSE stream and
   `/api/health`. A test enumerates responses and asserts the header, because a cache miss on this is
   silent.
5. A request whose `Host` header is neither a loopback name nor the configured bind address is
   rejected.
6. A request with no `Origin` header at all (the CLI, `curl`) is **accepted** when the token is valid
   — origin validation rejects a *present and wrong* origin, not an absent one.
7. **First-run handoff.** `karvan up` generates 32 bytes from `crypto.randomBytes`, base64url-encodes
   them, writes `.karvan/daemon.json` as `{ pid, port, token, startedAt }` at mode `0600` in a
   gitignored directory, and prints `http://127.0.0.1:7777/#token=<token>`. The token appears in the
   fragment only; a test asserts the daemon's own request log for that navigation contains no token
   substring.
8. The UI reads the fragment once, stores the token in `sessionStorage`, calls `history.replaceState`
   so the address bar no longer contains it, and sends `Authorization: Bearer <token>` thereafter —
   including on the SSE connection, which is why the client is `eventsource-client` and not
   `EventSource`.
9. **The token never travels in a query string.** A CI check asserts no source file constructs a URL
   containing the token, and a runtime test asserts the SSE request line contains `runs=` and
   `since=` and no token parameter.
10. A run's own spawned agent, using `terminal/create` to issue an HTTP request to the daemon, is
    rejected with `401 missing_token` — the threat-model row, exercised end to end rather than
    asserted in prose.
11. Auth is enforced on the WebSocket upgrade request before the socket is accepted (the check lives
    here; the socket itself is KAR-15.8).
12. Binding to anything other than a loopback address requires an explicit flag; there is no
    configuration path that silently falls back to `0.0.0.0`.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | No header → `401 missing_token`; wrong token → `401 bad_token` | No middleware exists |
| 2 | unit | Comparison is constant-time; unequal-length inputs do not short-circuit | `===` is used |
| 3 | unit | `Origin: http://attacker.example` + valid token + loopback `Host` → `403 bad_origin` | Origin is only checked when the token is missing |
| 4 | unit | Allowlisted origins (`http://127.0.0.1:7777`, `http://localhost:7777`) pass; absent `Origin` passes | The allowlist is over-strict and breaks the CLI |
| 5 | unit | `Vary: Origin` present on 200, 401, 403 and the stream response | The header is set on success only |
| 6 | unit | `Host: attacker.example` → rejected | Host validation is missing |
| 7 | integration | `karvan up` in a tmpdir: `.karvan/daemon.json` mode is `0600`, token is 32 bytes base64url, and the printed URL matches `#token=` | The token is a query parameter |
| 8 | integration | Request-log assertion: navigating the printed URL sends no token to the server | Fragments are misunderstood |
| 9 | browser | The UI stores the token in `sessionStorage`, `location.hash` is empty after load, and the next request carries the `Authorization` header | The token stays in the address bar |
| 10 | integration | Mock agent scripted to `terminal/create` a request to `127.0.0.1:<port>/api/runs` → `401` | The daemon trusts local callers |
| 11 | integration | WebSocket upgrade without a token is refused before `connection` fires | Auth runs after the upgrade |
| 12 | unit | CI grep: no source file interpolates the token into a URL | The query-string shortcut returns |

**Notes / risks** — **the architecture documents disagree with each other here and this story is where
it is resolved.** [03 §9 step 8](../../03-local-development.md) says *"Print the URL with a one-time
`?t=` token"*, while [11 §8](../../11-api-and-realtime.md) and
[15 §3.2](../../15-security-model.md) both specify the **fragment** form and both list "put the
daemon token in a query string" under *what not to do*. The fragment form wins — it is the one
supported by an argument (fragments are never sent to the server, so the token cannot land in an
access log) and it is stated twice. Part of this story's Done is correcting `03-local-development.md`
so a future reader does not implement the query-string version from the document that describes
bootstrap.

Two honest limits, both worth writing into the security notes rather than discovering later: a
process running *as the user* can read `.karvan/daemon.json`, so this control raises the bar from
"trivial" to "requires filesystem access as the user" and does not eliminate the class — only OS-level
isolation would. And the daemon token is a **local** secret: it must never be reused as a team-hub
credential, and it is on the deny-list of the child-environment scrubber like any other `*_TOKEN`.

---

### KAR-15.3 — The multiplexed SSE stream

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | L |
| **Depends on** | KAR-15.1, KAR-15.2, EPIC-03 KAR-03.3 (monotonic `seq`), EPIC-03 KAR-03.4 (the control-plane / data-plane split) |
| **PRD** | F4.1, NF3, NF10 |
| **Verified by** | EPIC-15-S15, EPIC-15-S16, EPIC-15-S17, EPIC-15-S18, EPIC-15-S19, EPIC-15-S20, EPIC-15-S21, EPIC-15-S22, EPIC-15-S23, EPIC-15-S24, EPIC-15-S25 |

**As** a browser tab watching three runs at once, **I want** all of them to arrive on one connection
whose subscription set I can change without reconnecting, **so that** opening a fourth panel does not
silently wedge every other request the tab will ever make.

[11 §2](../../11-api-and-realtime.md) opens with *"this is an architecture constraint, not a tuning
knob. It must be designed in from day one."* The mechanism is one `EventSource`-shaped connection per
tab opened at app start, `GET /api/stream?runs=<runId>,<runId>&since=<seq>` with `runs` as a
**server-side topic filter**, `runs=*` for the low-volume global lifecycle topic (`run.created`,
`run.completed`, `run.aborted`, `human.requested`) that the run list and the cross-run approval queue
need, and client-side fan-out through one `applyEvent(e)` dispatcher routing by `e.runId`. Adding a
run panel mutates the filter through `POST /api/stream/:streamId/subscribe`; the daemon backfills the
newly subscribed run from the client's current cursor *before* resuming live delivery.

The serving loop is a **two-phase drain**, and the second phase is subscribe-then-drain-again, never
subscribe-only: park on a post-commit signal, wake, drain to empty with bounded `LIMIT 500` queries,
park again. Getting the order wrong loses every event that commits between the last drain and the
subscription. The emitter fires **after** the transaction returns, never inside it, because a stream
that reads a row a later rollback removes advances a client's cursor past an event that does not
exist. And three read-side rules, all from measured failure: never hold an open `iterate()` cursor or
read transaction across a stream (**verified 2026-08-02**: one held open while writing 20k rows
produced an **82.6 MB** `-wal` file that `wal_checkpoint(TRUNCATE)` could not truncate — it returned
`{busy:0, log:0, checkpointed:0}` and space was reclaimed only when the cursor closed); never serve
the stream from the write connection, because `better-sqlite3@13.0.2` is fully synchronous and blocks
the event loop; and never let `io_chunk` into the query, because agent stdout is the data plane and
mixing it in is what makes people believe event sourcing needs snapshots.

**Acceptance criteria**

1. A tab holds exactly **one** stream connection regardless of how many run panels are open. A
   browser-level test asserts the connection count is 1 with three panels open.
2. **The failure this prevents is demonstrated:** with one connection per panel, six open streams
   exhaust the per-origin budget and a subsequent `fetch` never resolves within a generous timeout;
   with the multiplexed design, the same `fetch` resolves promptly.
3. The first frame on every connection is `event: hello` carrying
   `{ streamId, apiVersion, build, daemonEpoch, headSeq }`, followed immediately by `retry: 2000`
   written once.
4. Every ledger frame carries `id: <seq>` — no exceptions — uses the **default (unnamed)** event
   type, and its `data` is the full `EventEnvelope` serialised as **one line** of JSON, never split
   across multiple `data:` lines.
5. Named SSE events are reserved for stream control (`hello`, `subscribed`, `caught_up`, `fatal`) and
   a test asserts none of them can reach the reducer.
6. The client's dispatcher discriminates on the payload's `kind`, not on the SSE `event:` name, and
   an unknown `kind` is ignored exactly as the backend reducer ignores it — so an older UI build runs
   against a newer daemon without corruption.
7. Response headers are exactly `Content-Type: text/event-stream`, `Cache-Control: no-cache,
   no-transform`, `X-Accel-Buffering: no`, `Connection: keep-alive`, plus `X-Karvan-Api` and
   `Vary: Origin`. No compression middleware touches the route.
8. A `: keepalive` comment is written every 15 seconds of inactivity and is ignored by the client. A
   stream idle for a minute stays open and receives four of them.
9. `POST /api/stream/:streamId/subscribe { "runs": [...] }` mutates the filter **without a
   reconnect**: the same connection emits `subscribed`, backfills the new run from the client's
   cursor, emits `caught_up { runId, seq }`, and only then delivers live frames for it. No event is
   delivered twice and none is skipped.
10. `runs=*` delivers only the four global lifecycle kinds; a busy run's `node.progress` frames do not
    reach a tab subscribed only to `*`.
11. The drain is bounded: each wake-up issues one `LIMIT 500` query per subscribed run, merge-sorts
    the batches by `seq`, closes each query, and holds no cursor between wake-ups. An integration test
    writes 20k rows during an open stream and asserts the `-wal` file stays under a stated bound.
12. The stream is served from a read-only connection with `busy_timeout`; a long write on the write
    connection does not stall an in-flight stream beyond the documented bound.
13. `io_chunk` rows never appear on this stream under any subscription.
14. The post-commit emitter is called after `db.transaction(...)()` returns. A test that forces a
    rollback asserts no client cursor advanced.
15. A fatal condition closes the connection with a final `event: fatal` frame carrying the standard
    error envelope; the client stops retrying only for `bad_token` and `epoch_mismatch`.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | `parseRuns('*')` and `parseRuns('a,b')` produce the right filters; `*` maps to the four lifecycle kinds | The filter is client-side |
| 2 | unit | Frame serialiser: `id: <seq>` + one-line `data` + unnamed type for ledger events; named type for control frames | Frames are hand-concatenated |
| 3 | unit | The dispatcher ignores an unknown `kind` and never throws | The client switch is exhaustive and throws |
| 4 | integration | Header assertion on a real response, including the absence of `Content-Encoding` | Compression is mounted globally |
| 5 | integration | Two-phase drain: commit an event *between* the final drain and the park, assert it is delivered | The loop is subscribe-only |
| 6 | integration | Force a rollback around an append; assert no frame was written and no cursor advanced | The emitter fires inside the transaction |
| 7 | integration | Idle stream for 60 s on a `TestClock`-driven keepalive: four `: keepalive` comments, connection still open | Keepalive is missing and a proxy or the OS closes it |
| 8 | integration | Subscribe mid-stream: `subscribed` → backfill from cursor → `caught_up` → live, with no duplicate and no gap | Backfill runs after live delivery starts |
| 9 | integration | `runs=*` while a busy run emits 500 `node.progress` frames: none are delivered | The global topic is unfiltered |
| 10 | integration | Write 20k rows while a stream is open; assert bounded `-wal` size and that no `iterate()` cursor is held | The drain uses a lazy cursor |
| 11 | integration | `io_chunk` inserts during an open stream produce no frames | The drain query is not restricted to the control plane |
| 12 | browser | Three run panels in one tab → one connection; then six single-run connections → a subsequent `fetch` times out | The cap is treated as a tuning detail |
| 13 | e2e | `karvan replay <fixture>` at 20× drives a 400-node run over the same contract without buffering | Replay uses a different code path |

**Notes / risks** — this is the largest story in the epic and the one most likely to be "finished"
before it is correct, because every defect in it is invisible on a fast local machine with one tab
open. The connection-cap demonstration in criterion 2 is worth its cost precisely because it is the
failure nobody believes until they see a `fetch` that never resolves.

---

### KAR-15.4 — Stream resume by `Last-Event-ID` and explicit cursor

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-15.3, EPIC-03 KAR-03.3 (`INTEGER PRIMARY KEY AUTOINCREMENT`) |
| **PRD** | F4.1, NF10, NF4 |
| **Verified by** | EPIC-15-S26, EPIC-15-S27, EPIC-15-S28, EPIC-15-S29, EPIC-15-S30, EPIC-15-S31, EPIC-15-S32 |

**As** a tab that was reloaded, or that was open while the daemon restarted, **I want** to rejoin the
log at the exact event I last applied, **so that** the picture on screen is the truth rather than a
plausible reconstruction.

There are **two** resume paths and both are mandatory, because they cover disjoint cases.
[11 §4.1](../../11-api-and-realtime.md): the browser sends `Last-Event-ID` when *its own* reconnection
logic fires on a connection that had previously opened successfully. It does **not** send it on a
fresh `EventSource` after a page reload, on the first connection attempt of a session, or when the
initial connection never opened successfully — *"that third case is the common one during
development: you restart `karvand`, the tab's stream fails to open, and when the daemon comes back
the tab reconnects with no cursor at all."* If the server treats a missing `Last-Event-ID` as "start
from head", the UI silently loses everything that happened while it was down and renders a plausible
but wrong picture — an NF10 violation.

So the client persists its own cursor and always opens the stream with `?since=<seq>`, and the
server's precedence is fixed: **`since` query param > `Last-Event-ID` header > head of log**. The
query parameter wins because the client's persisted cursor is more trustworthy than the browser's,
and because the CLI has no `Last-Event-ID` mechanism at all. On a cold start with no cursor, the
client hydrates first through `GET /api/runs/:id/events?since=0` and only then opens the stream at
the returned cursor.

The second half of the story is what a client must **not** do. `seq` has gaps: a rolled-back
transaction burns `AUTOINCREMENT` values, so `4, 5, 7` is a normal, healthy log — `6` was allocated
by a transaction that did not commit. *"The cursor contract is 'resume from strictly greater than
`seq`'. It is never 'expect `seq + 1`'."* A client that treats a gap as a dropped event reports false
data loss and, worse, may try to "repair" by refetching from zero. **Do not write gap detection.**
And `AUTOINCREMENT` is mandatory for the mirror-image reason: a bare `INTEGER PRIMARY KEY` reuses
rowids after a delete, so the moment run retention ships, every persisted SSE cursor would silently
point at a different event than the one it was written for.

**Acceptance criteria**

1. A reconnect carrying `Last-Event-ID: <seq>` and no `since` resumes at `seq > <seq>`, delivering
   every intervening event exactly once in `seq` order.
2. A fresh connection carrying `?since=<seq>` and **no** `Last-Event-ID` resumes identically — the
   page-reload path.
3. Precedence is exactly `since` > `Last-Event-ID` > head. A request carrying both, disagreeing, uses
   `since`; a request carrying neither starts at head and the response's `hello.headSeq` tells the
   client what it skipped.
4. `GET /api/runs/:id/events?since=&limit=` returns `{ events, cursor, headSeq, more }` with `limit`
   defaulting to 1000 and capped at 5000; a client loop hydrating until `more` is false and then
   opening the stream at `cursor` produces no gap and no duplicate.
5. **Gaps are tolerated.** Given a ledger whose sequence jumps (the `crash-resume-seq-gap` fixture),
   the client applies events in order, reports no data loss, does not refetch from zero, and no code
   path anywhere compares an incoming `seq` to `previous + 1`. A CI grep for gap-detection arithmetic
   returns zero hits.
6. `seq` is declared `INTEGER PRIMARY KEY AUTOINCREMENT`. A test deletes the highest-`seq` row,
   appends a new event, and asserts the new `seq` is greater than the deleted one — the property that
   makes a persisted cursor safe once retention ships.
7. A daemon restart under an open tab is detectable: the next `hello` carries a different
   `daemonEpoch`, and a write attempted against the old epoch returns `409 epoch_mismatch`. A
   `hello.build` mismatch causes the UI to prompt for a reload rather than continuing silently.
8. Resume is correct across a real `kill -9`: the client's persisted cursor plus `?since=` recovers
   every event committed before the crash, and the crash-produced gap is not reported as loss.
9. The `karvan` CLI resumes through the identical code path with no `Last-Event-ID` mechanism at all,
   using `?since=` exclusively.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Precedence resolver: `{since, lastEventId}` matrix → the chosen cursor | Precedence is implicit in the handler |
| 2 | unit | The tail query is `seq > ?`, never `seq >= ?` and never `seq = ? + 1` | Off-by-one in the cursor contract |
| 3 | unit | A grep-style source assertion: no arithmetic comparing consecutive `seq` values | Someone adds gap detection "for safety" |
| 4 | integration | Reconnect with `Last-Event-ID` after killing the socket mid-stream → exact resume | Header resume unimplemented |
| 5 | integration | Fresh connection with `?since=` and no header → identical result | Only the header path was built |
| 6 | integration | Serve the `crash-resume-seq-gap` fixture: client applies 4, 5, 7 with no error and no refetch | The client treats the gap as loss |
| 7 | integration | Hydrate loop over 12,000 events with `limit=5000`: three pages, `more` transitions, then stream at `cursor` with no duplicate | `more`/`cursor` semantics are wrong |
| 8 | integration | Delete the top row, append, assert the new `seq` exceeds it | The column is a bare `INTEGER PRIMARY KEY` |
| 9 | integration | Restart the daemon under an open stream: new `daemonEpoch` on `hello`; a stale-epoch write → `409 epoch_mismatch` | Epoch is not exposed on the stream |
| 10 | e2e | The Playwright smoke: replay at speed, kill the connection, assert the UI reconnects and backfills with no gap and no duplicate | Resume works only in unit tests |

**Notes / risks** — the tempting simplification is "the browser handles resume for us". It does not,
and the case it fails is the one that happens most: restarting the daemon while a tab is open. The
second temptation is gap detection, which feels like diligence and is a bug — it converts a healthy
log into a false alarm and can trigger a full refetch of a multi-hour run.

---

### KAR-15.5 — Run control endpoints

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | S |
| **Depends on** | KAR-15.1, KAR-15.2, EPIC-06 KAR-06.7, EPIC-13 (approvals, interjection, patch decisions) |
| **PRD** | F4.4, F5.7, F1.1, F1.3, F8.1, F8.2, F8.3, F2.5 |
| **Verified by** | EPIC-15-S33, EPIC-15-S34, EPIC-15-S35, EPIC-15-S36, EPIC-15-S37, EPIC-15-S38 |

**As** the Operator, **I want** every write to be a plain `POST` that returns a status code and a
body, and to be safe to repeat, **so that** a double-click, a retried request or a stale panel cannot
produce a second run or a double-applied decision.

The write surface is deliberately boring: pause, resume, cancel, spec approval, run creation, human
response, interjection and patch decisions, all plain `POST`s, because they are low-frequency, need a
response body and a status code, and do not benefit from a socket. What is *not* boring is
idempotency, and [11 §11](../../11-api-and-realtime.md) specifies three layers applied in order.
Most writes are naturally idempotent because they are event appends over a state machine — pausing a
paused run is a no-op returning the existing `seq` and `200`, not an error; approving an
already-decided patch returns `409 patch_already_decided` **with the original decision**, so the UI
can show what actually happened rather than double-applying. Optimistic concurrency comes from
`ifLastSeq`: a write means "I am acting on the state I had at this cursor", and if the head has moved
in a way that changes the decision surface the daemon returns `409 stale_cursor` with the current
head. That is what stops an operator approving a patch on a panel that went stale while they read it
— a real hazard given that patches are auto-applied on a policy timer. And `POST /api/runs` accepts
an `Idempotency-Key`, stored in the **effect journal** alongside engine-level keys rather than in a
separate table.

One invariant is easy to violate by convenience: the engine's own `(runId, nodeId, attempt)`
idempotency keys are **not** exposed on the API. Conflating them would let a client reach into the
effect journal, which is precisely the invariant that makes crash recovery sound.

**Acceptance criteria**

1. `POST /runs/:id/pause`, `/resume` and `/cancel` append the corresponding events and return the
   appended `seq`. `cancel` takes `{ mode: 'cooperative' | 'forceful' }`, and `forceful` is the F5.7
   kill switch.
2. Pausing an already-paused run returns `200` with the existing `seq`, not an error. Resuming a
   running run behaves the same way. A run in a state that genuinely cannot pause returns
   `409 run_not_pausable`.
3. Any write may carry `ifLastSeq`. When the run's head has advanced *in a way that changes the
   decision surface*, the response is `409 stale_cursor` carrying the current head; when it has
   advanced harmlessly, the write succeeds.
4. `POST /runs/:id/patches/:patchId/decide` on an already-decided patch returns
   `409 patch_already_decided` including the original decision and who made it.
5. `POST /api/runs` with an `Idempotency-Key` returns the original `201` body on a repeat rather than
   creating a second run, and the key is stored in the effect journal.
6. `POST /api/runs` **does not start execution**: it appends `run.created`, returns
   `{ runId, seq, status: 'awaiting-spec-approval' }`, and execution begins only at
   `POST /runs/:id/spec/approve`. Acting on an unapproved run returns `422 spec_not_approved`.
7. `POST /runs/:id/interject` returns `202` with `{ seq, delivery: 'queued' | 'delivered' |
   'unsupported' }`. `unsupported` is a `202`, never an error, so the UI renders honestly rather than
   showing a delivered guidance bubble that never arrived.
8. Engine idempotency keys are absent from every response body and every request schema; a contract
   test over the emitted JSON Schemas asserts it.
9. Every control endpoint returns the closed error envelope on failure, with `seq` populated when the
   failure itself produced a ledger event.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Pause a paused run → `200` + existing `seq` | Repeat writes 409 or double-append |
| 2 | unit | `ifLastSeq` matrix: unchanged head, harmless advance, decision-changing advance → 200/200/409 | Staleness is all-or-nothing |
| 3 | unit | Decide an already-decided patch → `409 patch_already_decided` with the original decision | The second decision overwrites the first |
| 4 | integration | `POST /runs` twice with the same `Idempotency-Key` → one run, identical `201` body, one effect-journal entry | The key is stored in its own table or ignored |
| 5 | integration | `POST /runs` then act before approval → `422 spec_not_approved`; approve, then it proceeds | Creation starts execution |
| 6 | integration | `interject` against an adapter without mid-turn steering → `202` with `delivery: 'unsupported'` | Unsupported is returned as an error |
| 7 | integration | `cancel { mode: 'forceful' }` terminates the process group; the kill assertion excludes `Z`-state processes | Zombies read as a failed kill |
| 8 | contract | Emitted request/response schemas contain no engine idempotency key | The effect journal leaks onto the API |

---

### KAR-15.6 — Read endpoints for inspection surfaces

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | L |
| **Depends on** | KAR-15.1, KAR-15.2, EPIC-11 KAR-11.5, EPIC-12 KAR-12.3/12.4, EPIC-09 KAR-09.8 |
| **PRD** | F2.6, F10.2, F10.3, F10.4, F10.5, F10.6, F10.7, F6.3, F6.5, F7.3, F7.4, F7.7, F3.5, F3.6, NF8 |
| **Verified by** | EPIC-15-S39, EPIC-15-S40, EPIC-15-S41, EPIC-15-S42, EPIC-15-S43, EPIC-15-S44 |

**As** each of the nine P0 views, **I want** exactly the query I need served at the right granularity
and the right media type, **so that** no view has to reconstruct server-side state in the browser or
download a 200 MB log to render a terminal.

This is the read half of [11 §6 and §7](../../11-api-and-realtime.md), and each endpoint exists
because a specific view would otherwise be impossible or ruinous. `GET /runs/:id/plans` is the
scrubber's version rail; `plans/diff?from=&to=` returns node/edge set diffs plus a **per-node RFC
6902 patch** (`rfc6902@5.3.0` — *not* `fast-json-patch`, which last shipped in 2022) and an opaque
`unionLayoutKey` the client's ELK worker caches a union layout under. `nodes/:nodeId` is the
inspector bundle and `nodes/:nodeId/packet` its per-segment token breakdown. `nodes/:nodeId/io`
returns `application/x-ndjson`, one `io_chunk` per line, so a terminal reattach streams rather than
buffers — and the browser asks for the **last N KB**, never the whole log: `fromSeq` omitted plus
`limit` set means "tail", with the complete archive on disk at
`runs/<runId>/nodes/<nodeId>/stdout.log`. `facts` and `facts/:factId/consumers` are the memory graph's
two queries over `fact_edges`. `diff` returns `text/x-patch`. `/artifacts/:sha` is content-addressed,
supports `Range` and is immutably cacheable, with `HEAD` for size and media type.

Two of these are explicitly **not** part of the versioned contract and must be documented as such:
the `io_chunk` NDJSON framing (a tail format that may change) and `unionLayoutKey` (an opaque cache
key).

**Acceptance criteria**

1. `GET /runs/:id/plans` returns `{ version, seq, planHash, decision, reason }[]` ordered by version,
   and `GET /runs/:id/plans/:version` returns the immutable plan document addressed by hash. A
   missing version returns `404 plan_version_not_found`.
2. `GET /runs/:id/plans/diff?from=&to=` returns the documented shape: `nodes.{added, removed,
   changed, unchanged}` with `changed[].patch` as RFC 6902 operations, `edges.{added, removed}`,
   `unionLayoutKey`, `reason` and `decision`. The patch is produced by `rfc6902@5.3.0`.
3. `GET /runs/:id/nodes/:nodeId?attempt=` returns the full inspector bundle and
   `…/packet?attempt=` returns the assembled `ContextPacket` with per-segment token counts whose sum
   equals the header total.
4. `GET /runs/:id/nodes/:nodeId/io` returns `application/x-ndjson`, one `io_chunk` per line with
   `{seq, stream, ts, data}`. With `fromSeq` omitted and `limit` set it returns the **tail**; with
   `fromSeq` set it pages forward. A 200 MB log is never loaded into memory to serve a tail.
5. `GET /runs/:id/facts` and `…/facts/:factId/consumers` are each a single indexed query over
   `fact_edges` and return provenance with every fact.
6. `GET /runs/:id/diff?node=|worktree=|cumulative=1` returns `text/x-patch`; `GET /runs/:id/gates`,
   `…/criteria` and `…/findings?file=` return the typed verdict, criteria and finding shapes, with
   findings grouped by file and ordered by line.
7. `GET /artifacts/:sha` serves the content-addressed blob with `Range` support and immutable cache
   headers; `HEAD /artifacts/:sha` returns size and media type without a body; an unknown sha returns
   `404 artifact_not_found`.
8. `GET /providers` returns installed adapters with versions and capability manifests;
   `POST /providers/doctor` re-probes and runs the conformance battery; `GET /config` and
   `PATCH /config` expose `.karvan/config.yaml` as JSON.
9. Every list endpoint is bounded — `limit` with a documented default and cap, and a cursor where
   ordering permits. No endpoint can be made to return an unbounded result set.
10. Every read runs on a read-only connection with `busy_timeout`; a long read never blocks the write
    connection or an in-flight stream.
11. The two unversioned surfaces (`io_chunk` NDJSON framing, `unionLayoutKey`) are marked as such in
    the emitted schemas and in the client module's types.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | `diff(planA, planB)` produces the documented node/edge sets and RFC 6902 patches | The differ emits a bespoke format |
| 2 | unit | Packet response: per-segment token counts sum to the header total | The breakdown is re-derived from the rendered prompt |
| 3 | integration | Serve a fixture run: `plans`, `plans/:version`, `plans/diff` against golden files with the normalising serializer registered | Snapshots churn on ids and paths |
| 4 | integration | `io` tail on a 200 MB `io_chunk` set: response is NDJSON, memory stays bounded, `fromSeq` paging is exact | The handler buffers the log |
| 5 | integration | `facts/:factId/consumers` returns every reader and no writer, from one indexed query | The consumer set is computed in JS |
| 6 | integration | `Range: bytes=0-1023` on an artifact returns 206 with the right slice; `HEAD` returns size and type | Range is unimplemented |
| 7 | integration | `diff?cumulative=1` returns `text/x-patch` that `git apply --check` accepts | The diff is assembled by string concatenation |
| 8 | integration | Each 404 code (`run_not_found`, `node_not_found`, `artifact_not_found`, `plan_version_not_found`) is returned for its own resource | 404s are generic |
| 9 | integration | A long read does not stall an in-flight SSE stream | Reads share the write connection |

**Notes / risks** — this story is large because it is nine endpoints' worth of shapes, not because
any one of them is hard. It is the most splittable work in the epic: if the epic runs long, ship
`plans`, `plans/diff`, `nodes/:nodeId` and `packet` first (they unblock the scrubber and the
inspector, which are the two marquee views) and defer `findings`, `criteria` and `config` behind the
views that consume them.

---

### KAR-15.7 — Server-side state snapshot at a sequence

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | S |
| **Depends on** | KAR-15.1, EPIC-03 KAR-03.5 (the pure reducer), EPIC-03 KAR-03.6 (the checkpoint cache) |
| **PRD** | F10.2, F10.10, NF3 |
| **Verified by** | EPIC-15-S45, EPIC-15-S46, EPIC-15-S47 |

**As** the plan-evolution scrubber, **I want** the reduced state at an arbitrary `seq` computed on
the server, **so that** dragging the timeline of a multi-hour run does not freeze the tab.

*"The reason this exists is browser memory, not server convenience."* Scrubbing the plan-evolution
timeline (F10.2, the marquee feature) or replaying a run (F10.10) must not mean replaying from `seq`
0 in JavaScript — on a multi-hour run that freezes the tab. SQLite rebuilds state far faster than the
browser can: **verified 2026-08-02**, 10,000 control-plane events reduced to state in **29 ms**. The
endpoint returns `{ seq, state, planVersion, planHash }`, accepts `seq=head` as an alias for the
current head, and the client replays forward **from the nearest snapshot only**.

This is a small story with one subtlety worth writing down: because `seq` has gaps, a requested `seq`
may name a value that was never committed. The answer is the state at the greatest committed `seq`
less than or equal to the request, and the response says which `seq` that was — which is why `seq` is
echoed in the body rather than assumed by the caller.

**Acceptance criteria**

1. `GET /runs/:id/snapshot?seq=N` returns `{ seq, state, planVersion, planHash }` where `state` is the
   reduced `RunState` at exactly the returned `seq`.
2. `seq=head` is accepted as an alias for the current head and the returned `seq` is the actual head
   value.
3. A requested `seq` that falls in a gap returns the state at the greatest committed `seq` ≤ N, and
   the returned `seq` reflects that — the caller never has to guess.
4. The returned state is byte-identical to reducing the same events client-side, proven by feeding
   the same fixture through both paths.
5. Reducing 10,000 control-plane events server-side completes within a stated budget consistent with
   the measured 29 ms, asserted with enough headroom to be non-flaky in CI.
6. The reduction uses the same pure reducer as the engine — one implementation, not a second
   server-side projection that can drift.
7. The endpoint runs on a read-only connection and never reads `io_chunk`.
8. A `seq` beyond head returns the head state rather than an error, and a `seq` for a nonexistent run
   returns `404 run_not_found`.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Reduce a fixture event list to `seq` N; compare against the same reducer run client-side | A second reducer exists |
| 2 | unit | `seq=head` resolves to the head value and echoes it | The alias is unhandled |
| 3 | unit | A `seq` inside a gap resolves down to the nearest committed `seq` | The handler returns 404 or an off-by-one state |
| 4 | integration | 10,000-event fixture reduced within the stated budget on a file-backed database | The reduction is O(n²) or re-parses payloads per event |
| 5 | integration | Snapshot at three scrub positions on the `three-patches` fixture matches golden files | Snapshots are not deterministic |
| 6 | e2e | The Playwright scrubber smoke: drag to v1 and forward through each patch; the diff renders without a client-side replay from 0 | The client replays the whole run |

---

### KAR-15.8 — Interactive PTY WebSocket *(added)*

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P1 |
| **Size** | S |
| **Depends on** | KAR-15.2 (upgrade-time auth), EPIC-05 KAR-05.9 (process lifecycle), EPIC-08 KAR-08.6 (the kill switch) |
| **PRD** | F8.5, F10.6 |
| **Verified by** | EPIC-15-S48 |

**As** the Operator watching an agent's terminal, **I want** to type into it at keystroke latency,
**so that** an interactive prompt does not require killing the node.

Added because [11 §1 and §7.7](../../11-api-and-realtime.md) specify a WebSocket that no skeleton
story owned, and [EPIC-13](./EPIC-13-human-in-the-loop.md) explicitly defers it here. It is the one
story in this epic that is **not P0**: F8.2's P0 obligation ("interject at any time") is met by
`POST /api/runs/:id/interject` in EPIC-13, and F10.6's live streams are served by the NDJSON
`io_chunk` tail in KAR-15.6. This story is the interactive upgrade, which maps to F8.5 (P1,
adapter-dependent). If M1 runs long, cut it without touching the critical path.

The rule that makes it safe is that the socket is a **live interactive channel only** — durable
output continues to land in `io_chunk` regardless, so closing the panel never loses anything.

**Acceptance criteria**

1. `GET /api/pty/:runId/:nodeId` upgrades through a `server.on('upgrade', …)` listener attached to
   the same `node:http` server Hono serves from, keeping it independent of any Hono WebSocket
   helper's version.
2. Bearer auth is enforced **on the upgrade request, before the socket is accepted**; an
   unauthenticated or wrong-origin upgrade is refused without a socket ever being created.
3. Frames follow the documented table: binary client→server writes raw bytes to the pty; a text frame
   `{"t":"resize","cols":120,"rows":40}` resizes it; binary server→client carries raw pty output; a
   text frame `{"t":"exit","code":0}` reports exit.
4. One socket per visible terminal panel, closed on unmount; closing it neither kills the node nor
   loses output, because `io_chunk` continues to be written.
5. A node that ends while a socket is attached delivers `{"t":"exit","code":N}` and then closes.

**Test plan (TDD)**

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | integration | Upgrade without a token → refused before `connection` fires | Auth runs post-upgrade |
| 2 | integration | Write bytes to the socket; the fake agent's pty echoes them back as a binary frame | The socket is not wired to the pty |
| 3 | integration | Resize frame changes the pty dimensions observed by the child | Resize is ignored |
| 4 | integration | Close the socket mid-run; `io_chunk` rows continue to be appended and the node completes | Closing the panel kills the node |

---

## Risks

- **Size: ~19 days across 8 stories, over the ~15-day guidance.** This is stated rather than hidden.
  Three honest levers, in the order to pull them: cut **KAR-15.8** (P1, ~1 day, no P0 requirement
  depends on it); split **KAR-15.6** and ship only the four endpoints the scrubber and inspector need
  (~2 days deferred); and defer the `config` and `providers/doctor` routes behind
  [EPIC-18](./EPIC-18-cli-packaging.md), which needs them anyway. What must **not** be trimmed is
  KAR-15.3 or KAR-15.4 — the multiplexing constraint and the dual resume path are the two things that
  are far more expensive to retrofit than to build, and both are invisible until they fail.
- **W9 gates W10, W11 and W12 simultaneously.** Everything downstream is blocked on this epic, so a
  slip here is a slip everywhere. Mitigation: KAR-15.1 and KAR-15.2 are marked `Ready` and can start
  the moment EPIC-03 lands, ahead of EPIC-11 finishing; only KAR-15.6 genuinely needs plan versions
  to exist.
- **Every SSE defect is invisible on a fast laptop with one tab open.** The connection-cap
  demonstration, the WAL-growth assertion, the two-phase drain ordering test and the rollback test all
  exist because the corresponding bug produces no error message — just a hang, a fat WAL file, a
  missing event or a cursor pointing at nothing.
- **The `?t=` versus `#token=` contradiction between architecture documents.** Resolved in favour of
  the fragment (KAR-15.2 notes), but until `03-local-development.md` is corrected, a reader who starts
  from the bootstrap document will implement the wrong one. That correction is part of KAR-15.2's
  Done.
- **`eventsource-client@^1.2.0` is a single-maintainer dependency on the critical path.** The two
  obvious alternatives are both worse: `@microsoft/fetch-event-source` is abandoned (last published
  2.0.1, 2021-04-25) and `eventsource@^4.1.0` is a spec-faithful polyfill that therefore inherits
  `EventSource`'s no-custom-headers limitation, which forces the token into the query string. Keeping
  the stream client behind `packages/web/src/api/stream.ts` means a replacement is one file.

---

**Related:** [Flows](../flows/EPIC-15-daemon-api-flows.md) · [Board](../board.md) ·
[11-api-and-realtime.md](../../11-api-and-realtime.md) ·
[15-security-model.md](../../15-security-model.md) ·
[05-durable-execution.md](../../05-durable-execution.md)

[← Back to the delivery plan](../README.md)
