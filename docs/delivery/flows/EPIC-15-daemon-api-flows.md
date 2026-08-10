# EPIC-15 flows — Daemon API and event stream

> Behavioural specification for [EPIC-15](../epics/EPIC-15-daemon-api.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor              | Description                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Operator**       | The engineer driving DeFlow through a browser tab or the `DeFlow` CLI                                                                      |
| **DeFlowd**        | The local daemon: one `node:http` server on 127.0.0.1:7777 carrying `/api/*`, the SSE stream and (in dev) Vite's middleware and HMR socket |
| **Browser tab**    | A client holding exactly one multiplexed SSE connection for its lifetime, plus ordinary `fetch` calls                                      |
| **CLI client**     | `packages/cli`, importing the identical `hc<ApiType>` client and the identical stream module. Has no `Last-Event-ID` mechanism at all      |
| **Ledger**         | The single global SQLite database; `event.seq` is `INTEGER PRIMARY KEY AUTOINCREMENT` and is the total order of the system                 |
| **Provider agent** | A `DeFlow-mock-agent` subprocess on a temp `PATH`. Relevant here as a _threat actor_: it can reach 127.0.0.1:7777                          |
| **Hostile page**   | A page on `attacker.example` whose DNS resolves to 127.0.0.1 — the rebinding case                                                          |
| **Replay harness** | `DeFlow replay <fixture>` serving a recorded ledger over the same HTTP + SSE contract as a live run                                        |

## Preconditions common to all flows

```gherkin
Background:
  Given a DeFlow workspace initialised in a real git repository on branch "main"
  And the ledger is a file-backed SQLite database whose event table declares
      "seq INTEGER PRIMARY KEY AUTOINCREMENT" and carries the covering index "event_run_seq"
  And the daemon serves reads on read-only connections with busy_timeout set,
      never on the write connection
  And DeFlowd is bound to 127.0.0.1 on an ephemeral port in tests, 7777 in the documented flows
  And ".DeFlow/daemon.json" holds { pid, port, token, startedAt } at mode 0600 and is gitignored
  And every request except "GET /api/health" carries "Authorization: Bearer <token>"
  And time enters the engine through an injected Clock port, never Date.now()
  And no test in this file calls vi.useFakeTimers() while a child process or an open socket is alive
  And the normalising snapshot serializer is registered before the first snapshot is written
  And the fixture corpus at "test/fixtures/runs/" includes "happy-path", "three-patches",
      "crash-resume-seq-gap" and "stress-400"
```

> Three of these carry weight. **`AUTOINCREMENT` is not decoration** — a bare `INTEGER PRIMARY KEY`
> reuses rowids after a delete, so every persisted SSE cursor would silently point at a different
> event once retention ships (EPIC-15-S30). **Read-only connections** matter because
> `better-sqlite3@13.0.2` is fully synchronous and blocks the event loop, so serving a stream from
> the write connection stalls every other request. And the **`crash-resume-seq-gap` fixture** is what
> makes the gap-tolerance scenarios writable at all; a ledger with contiguous sequence numbers cannot
> prove the contract.

## Flow index

| Scenario    | Title                                                                               | Verifies | Type        |
| ----------- | ----------------------------------------------------------------------------------- | -------- | ----------- |
| EPIC-15-S1  | Happy path: a typed round trip from the daemon's own route types                    | KAR-15.1 | Happy path  |
| EPIC-15-S2  | Renaming a daemon field breaks the UI build in the same commit                      | KAR-15.1 | Edge case   |
| EPIC-15-S3  | `/api/health` is the only unauthenticated route, and `DeFlow up` polls it           | KAR-15.1 | Happy path  |
| EPIC-15-S4  | Domain failures are envelopes, not exceptions                                       | KAR-15.1 | Failure     |
| EPIC-15-S5  | Compression never touches `/api/stream`                                             | KAR-15.1 | Failure     |
| EPIC-15-S6  | One process, one port: API, HMR and SSE coexist                                     | KAR-15.1 | Happy path  |
| EPIC-15-S7  | **An unauthenticated request is rejected**                                          | KAR-15.2 | Failure     |
| EPIC-15-S8  | A wrong token is rejected, in constant time                                         | KAR-15.2 | Failure     |
| EPIC-15-S9  | **A cross-origin request is rejected, token or no token**                           | KAR-15.2 | Failure     |
| EPIC-15-S10 | `Vary: Origin` on every response, including the errors                              | KAR-15.2 | Edge case   |
| EPIC-15-S11 | `Host` validation, and an absent `Origin` is fine                                   | KAR-15.2 | Edge case   |
| EPIC-15-S12 | **First-run token handoff through the URL fragment**                                | KAR-15.2 | Happy path  |
| EPIC-15-S13 | **The token never appears in a query string**                                       | KAR-15.2 | Failure     |
| EPIC-15-S14 | An agent DeFlow spawned finds port 7777 and cannot drive it                         | KAR-15.2 | Failure     |
| EPIC-15-S15 | Happy path: one connection, three runs, one dispatcher                              | KAR-15.3 | Happy path  |
| EPIC-15-S16 | **What breaks without multiplexing: six streams and a `fetch` that never resolves** | KAR-15.3 | Failure     |
| EPIC-15-S17 | Subscribe mid-stream: backfill before live, no gap and no duplicate                 | KAR-15.3 | Edge case   |
| EPIC-15-S18 | `runs=*` carries lifecycle only, not every `node.progress` frame                    | KAR-15.3 | Edge case   |
| EPIC-15-S19 | The frame contract: `hello`, `retry`, `id:`, one-line data, keepalive               | KAR-15.3 | Happy path  |
| EPIC-15-S20 | Control frames never reach the reducer; unknown `kind` is ignored                   | KAR-15.3 | Edge case   |
| EPIC-15-S21 | The two-phase drain: an event committed between drain and park is not lost          | KAR-15.3 | Concurrency |
| EPIC-15-S22 | The emitter fires post-commit; a rollback advances no cursor                        | KAR-15.3 | Failure     |
| EPIC-15-S23 | **The 82.6 MB WAL: never hold a cursor open across a stream**                       | KAR-15.3 | Failure     |
| EPIC-15-S24 | `io_chunk` never appears on the control-plane stream                                | KAR-15.3 | Edge case   |
| EPIC-15-S25 | A fatal condition closes with `event: fatal`, and only two codes stop retrying      | KAR-15.3 | Failure     |
| EPIC-15-S26 | Resume path 1: automatic reconnect with `Last-Event-ID`                             | KAR-15.4 | Happy path  |
| EPIC-15-S27 | **Resume path 2: a page reload sends no `Last-Event-ID` at all**                    | KAR-15.4 | Failure     |
| EPIC-15-S28 | Precedence: `since` > `Last-Event-ID` > head                                        | KAR-15.4 | Edge case   |
| EPIC-15-S29 | **Gaps are healthy: 4, 5, 7 is not data loss**                                      | KAR-15.4 | Edge case   |
| EPIC-15-S30 | Rowid reuse: why `AUTOINCREMENT` is mandatory                                       | KAR-15.4 | Failure     |
| EPIC-15-S31 | Cold-start hydrate loop, then open the stream at the cursor                         | KAR-15.4 | Happy path  |
| EPIC-15-S32 | The daemon restarted under the tab: `daemonEpoch` and `build` skew                  | KAR-15.4 | Recovery    |
| EPIC-15-S33 | Happy path: pause, resume, cancel — and pausing a paused run                        | KAR-15.5 | Happy path  |
| EPIC-15-S34 | `ifLastSeq` and the stale approval panel                                            | KAR-15.5 | Edge case   |
| EPIC-15-S35 | `Idempotency-Key` on run creation                                                   | KAR-15.5 | Edge case   |
| EPIC-15-S36 | Forceful cancel is the kill switch, and zombies are excluded                        | KAR-15.5 | Failure     |
| EPIC-15-S37 | Creating a run does not start it                                                    | KAR-15.5 | Edge case   |
| EPIC-15-S38 | Engine idempotency keys are not on the API                                          | KAR-15.5 | Edge case   |
| EPIC-15-S39 | Plan version rail and RFC 6902 diffs                                                | KAR-15.6 | Happy path  |
| EPIC-15-S40 | The `io_chunk` tail: last N KB, never the whole log                                 | KAR-15.6 | Edge case   |
| EPIC-15-S41 | Artifacts: `Range`, `HEAD` and immutable caching                                    | KAR-15.6 | Happy path  |
| EPIC-15-S42 | The inspector bundle and a packet whose segments sum to its header                  | KAR-15.6 | Happy path  |
| EPIC-15-S43 | Facts and consumers, one indexed query each                                         | KAR-15.6 | Happy path  |
| EPIC-15-S44 | Every 404 names its own resource; every list is bounded                             | KAR-15.6 | Failure     |
| EPIC-15-S45 | Happy path: reduced state at a sequence, server-side                                | KAR-15.7 | Happy path  |
| EPIC-15-S46 | A `seq` inside a gap resolves down, and says so                                     | KAR-15.7 | Edge case   |
| EPIC-15-S47 | Scrubbing a multi-hour run does not replay from zero in the browser                 | KAR-15.7 | Edge case   |
| EPIC-15-S48 | PTY upgrade is authenticated before the socket exists                               | KAR-15.8 | Failure     |

---

## EPIC-15-S1 — Happy path: a typed round trip from the daemon's own route types

**Verifies:** KAR-15.1 · **Type:** Happy path · **Automated at:** contract

```gherkin
Feature: One API, one client module, two consumers

  Scenario: the UI and the CLI call the same route through hc<ApiType>
    Given the daemon defines its routes as one chained Hono expression
    And "export type ApiType = typeof api" is the whole contract
    When packages/web calls rpc.runs[':id'].$get({ param: { id: "r_01JXQ" } })
    Then the awaited res.json() is typed as the daemon's own return type and not as any
    And the same call from packages/cli compiles against the same types
    And no codegen step, OpenAPI document or generated client exists in the repository
    And every response carries "X-DeFlow-Api: 1"
```

**Notes:** the chaining is load-bearing rather than stylistic — `hc<AppType>` infers from the chained
expression's type, and a route registered separately with `api.get(...)` on its own statement is
invisible to the inference. This is the single largest cross-boundary ergonomic available to a solo
developer and it costs nothing, so it is worth a contract test that would fail if someone unchains
the routes for readability.

---

## EPIC-15-S2 — Renaming a daemon field breaks the UI build in the same commit

**Verifies:** KAR-15.1 · **Type:** Edge case · **Automated at:** contract

```gherkin
Feature: The type system is the schema-drift defence

  Scenario: a field is renamed in the daemon's response type
    Given "@DeFlow/daemon"'s exports field points at "./src/index.ts" inside the workspace
    And packages/web typechecks against live daemon source rather than a built .d.ts
    When a field on the run summary type is renamed in the daemon
    Then "pnpm typecheck" fails in packages/web
    And it fails in packages/cli
    And the failure names the renamed field and the call site
```

---

## EPIC-15-S3 — `/api/health` is the only unauthenticated route, and `DeFlow up` polls it

**Verifies:** KAR-15.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: One unauthenticated discovery endpoint, deliberately

  Scenario: readiness polling before the token file has been read
    Given DeFlowd is starting and has not yet finished migrations
    When "GET /api/health" is requested with no Authorization header
    Then the response is 200 with { apiVersion, build, daemonEpoch, headSeq, uptimeMs }
    And it exposes nothing a local process could not already learn from ".DeFlow/daemon.json"

  Scenario: exactly one route is exempt
    When every registered route is enumerated and requested without an Authorization header
    Then exactly one of them returns a non-401 status
    And that route is "GET /api/health"
```

**Notes:** health is unauthenticated _deliberately_ so `DeFlow up` can poll for readiness before it
has read the token file. The enumeration in the second scenario is the guard: the natural way a
second unauthenticated route appears is somebody adding a `/api/version` for convenience.

---

## EPIC-15-S4 — Domain failures are envelopes, not exceptions

**Verifies:** KAR-15.1 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: The closed error envelope

  Scenario Outline: <code> is returned as <status> with the documented shape
    When the daemon encounters "<condition>"
    Then the response status is <status>
    And the body is { error: { code: "<code>", message, detail, retryable, seq? } }
    And "code" is a member of the closed union
    And "seq" is populated when the failure also produced a ledger event

    Examples:
      | condition                              | status | code                     |
      | a request body failing schema validation | 400  | schema_violation         |
      | no Authorization header                  | 401  | missing_token            |
      | a hostile Origin                         | 403  | bad_origin               |
      | an unknown run id                        | 404  | run_not_found            |
      | an ifLastSeq behind the head             | 409  | stale_cursor             |
      | a patch already decided                  | 409  | patch_already_decided    |
      | a write carrying a stale daemon epoch    | 409  | epoch_mismatch           |
      | an unapproved spec                       | 422  | spec_not_approved        |
      | a rate-limited provider                  | 429  | provider_rate_limited    |
      | the daemon still migrating               | 503  | daemon_starting          |

  Scenario: an unexpected throw does not leak
    Given a handler that throws a TypeError
    When the route is called
    Then the response is 500 with code "internal"
    And the body contains no stack trace
    And the stack is written to an artifact behind a handle
```

**Notes:** `code` is a stable identifier clients may branch on; `message` is for humans and may change
freely. Carrying `seq` is NF10 applied to the error path — the UI can link "this failed" to "here is
the event that says so", which is exactly where auditability usually stops.

---

## EPIC-15-S5 — Compression never touches `/api/stream`

**Verifies:** KAR-15.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: A buffered SSE stream looks like a scheduler bug and is not one

  Scenario: compression is mounted on JSON routes only
    Given "hono/compress" is mounted on the JSON routes
    When a client requests "GET /api/runs" with "Accept-Encoding: gzip"
    Then the response carries a Content-Encoding header
    When the same client opens "GET /api/stream?runs=*&since=0" with "Accept-Encoding: gzip"
    Then the response carries no Content-Encoding header
    And the response carries "Cache-Control: no-cache, no-transform"
    And "X-Accel-Buffering: no"
    And ten events emitted one second apart arrive at ten distinct client-side timestamps,
        not in one burst at stream end
```

**Notes:** the symptom of getting this wrong — _"events arrive in clumps, then all at once"_ — reads
as a backend scheduling problem and sends you looking in the wrong place for an afternoon. The
timestamp assertion is measured client-side rather than eyeballed, per the M0 S4 spike criterion.

---

## EPIC-15-S6 — One process, one port: API, HMR and SSE coexist

**Verifies:** KAR-15.1 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: Vite in middleware mode inside DeFlowd

  Scenario: dev and production route identically
    Given DeFlowd is started with DeFlow_DEV=1
    Then exactly one node process is listening on port 7777
    And "GET /api/health" is served by Hono
    And an SSE stream on the same port emits events individually for ten minutes
    And editing a .vue file hot-reloads the browser over the same port
    And the SSE connection is not dropped by the hot reload
    When DeFlowd is started without DeFlow_DEV
    Then the same route table serves "/api/*" and static assets from dist/ui
    And "GET /api/nope" returns a 404 envelope rather than index.html
```

**Notes:** the API mounts before the SPA fallback, which is why the last assertion is worth writing:
the natural mistake is a catch-all `app.get('*')` registered first, which turns every API typo into a
silently-served HTML page and a JSON parse error in the client.

---

## EPIC-15-S7 — An unauthenticated request is rejected

**Verifies:** KAR-15.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Localhost is not authentication

  Scenario: no Authorization header
    Given DeFlowd is bound to 127.0.0.1 with a generated bearer token
    When "GET /api/runs" is requested with no Authorization header
    Then the response is 401 with code "missing_token"
    And the body does not reveal the expected token or its length
    And no run is listed, created or modified

  Scenario: every write route is protected too
    When each of POST /api/runs, /runs/:id/pause, /runs/:id/cancel,
         /runs/:id/nodes/:nodeId/respond and /runs/:id/patches/:patchId/decide
         is requested with no Authorization header
    Then each returns 401 with code "missing_token"
    And the ledger contains no new event
```

---

## EPIC-15-S8 — A wrong token is rejected, in constant time

**Verifies:** KAR-15.2 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Constant-time comparison

  Scenario: a wrong token
    When "GET /api/runs" is requested with "Authorization: Bearer wrong"
    Then the response is 401 with code "bad_token"

  Scenario: the comparison does not short-circuit
    Given the token comparison function
    When it is called with inputs of unequal length
    Then it does not return early on the length mismatch
    And it is implemented on a timingSafeEqual-style primitive, not on "==="
    And a unit test asserts the primitive is the one used
```

**Notes:** timing analysis over loopback is a marginal threat and the control is nearly free, which is
the right trade. The test asserts _which primitive is used_ rather than trying to measure timing,
because a timing assertion in CI is a flake generator.

---

## EPIC-15-S9 — A cross-origin request is rejected, token or no token

**Verifies:** KAR-15.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Origin validation is the DNS-rebinding defence

  Scenario: a rebound page with a valid loopback Host
    Given a hostile page on "attacker.example" whose DNS record resolves to 127.0.0.1
    When it issues "GET /api/runs" with Origin "http://attacker.example"
        and Host "127.0.0.1:7777"
    Then the response is 403 with code "bad_origin"
    And the response carries "Vary: Origin"
    And no run data appears in the response body

  Scenario: a valid token does not rescue a bad origin
    When the same request is repeated with the correct "Authorization: Bearer <token>"
    Then the response is still 403 with code "bad_origin"

  Scenario Outline: the allowlist
    When a request carries Origin "<origin>"
    Then it is <outcome>

    Examples:
      | origin                    | outcome                 |
      | http://127.0.0.1:7777     | accepted                |
      | http://localhost:7777     | accepted                |
      | http://attacker.example   | rejected with bad_origin|
      | https://127.0.0.1:7777    | rejected with bad_origin|
      | null                      | rejected with bad_origin|
```

**Notes:** same-origin policy does not help here — the browser believes the origin is
`attacker.example` and it is talking to `127.0.0.1:7777`. What saves you is that _a rebound page
cannot forge `Origin`_. The second scenario matters because the natural implementation checks the
origin only on the unauthenticated path, which leaves the attack open the moment a token leaks.

---

## EPIC-15-S10 — `Vary: Origin` on every response, including the errors

**Verifies:** KAR-15.2 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Without Vary, a cache defeats the Origin check

  Scenario: the header is universal
    When every registered route is exercised for a 200, a 401, a 403 and a 404
    Then every one of those responses carries "Vary: Origin"
    And the SSE stream response carries it
    And "GET /api/health" carries it
```

**Notes:** without it, _"any intermediate or browser cache can serve a response computed for one
origin to a request from another"_, which quietly undoes EPIC-15-S9. The failure is invisible in
development because there is no cache in the path — which is exactly why it needs a test rather than
a habit.

---

## EPIC-15-S11 — `Host` validation, and an absent `Origin` is fine

**Verifies:** KAR-15.2 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: The second half of the rebinding defence, without breaking the CLI

  Scenario: a non-loopback Host
    When a request carries Host "attacker.example" and a valid token
    Then it is rejected

  Scenario: the CLI sends no Origin at all
    Given the DeFlow CLI issuing "GET /api/runs" with a valid token and no Origin header
    Then the request is accepted
    And origin validation rejects a present-and-wrong Origin, never an absent one
```

**Notes:** getting this backwards is a real risk: a strict "Origin must be present and allowlisted"
rule locks out `curl`, the CLI and every script, and the pressure to relax it usually removes the
check entirely rather than fixing the condition.

---

## EPIC-15-S12 — First-run token handoff through the URL fragment

**Verifies:** KAR-15.2 · **Type:** Happy path · **Automated at:** integration + browser

```gherkin
Feature: Getting the token into the browser without leaking it

  Scenario: DeFlow up generates and prints the token
    Given a fresh workspace with no ".DeFlow/daemon.json"
    When "DeFlow up" runs
    Then 32 bytes from crypto.randomBytes are base64url-encoded as the token
    And ".DeFlow/daemon.json" is written as { pid, port, token, startedAt } at mode 0600
    And the file is inside a gitignored directory
    And the printed URL is exactly "http://127.0.0.1:7777/#token=<token>"

  Scenario: the fragment never reaches the server
    When the printed URL is navigated
    Then the daemon's request log for that navigation contains no substring of the token
    And the request line is "GET / HTTP/1.1" with no query string

  Scenario: the UI exchanges it once
    Given the UI has loaded from the printed URL
    Then the token is present in sessionStorage
    And location.hash is empty after "history.replaceState" runs
    And the next API request carries "Authorization: Bearer <token>"
    And the SSE connection carries the same header, because the client is
        "eventsource-client", not native EventSource
```

**Notes:** fragments are never sent to the server, so the token cannot land in an access log. Native
`EventSource` **cannot send custom headers** — the API has no mechanism for it — which is the entire
reason `eventsource-client@^1.2.0` is a dependency: a native-`EventSource` design forces the token
into the query string, and EPIC-15-S13 is what that would cost.

---

## EPIC-15-S13 — The token never appears in a query string

**Verifies:** KAR-15.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: A token in a URL is a token in five logs

  Scenario: no code path builds a URL containing the token
    When the CI check greps packages/ for the token being interpolated into a URL
    Then it returns zero hits

  Scenario: the stream request line carries no credential
    Given an open SSE connection
    When the daemon's access log line for it is inspected
    Then the query string contains "runs=" and "since=" and nothing else
    And the Authorization header carried the token

  Scenario: the abandoned alternatives are not used
    Then the dependency closure contains "eventsource-client"
    And it contains neither "@microsoft/fetch-event-source" nor a bare "eventsource"
```

**Notes:** a token in a query string ends up in shell history, terminal scrollback, browser history,
the `Referer` header of any outbound link, and any access log anyone ever adds — unacceptable for a
long-lived token that authorises spawning processes on the user's machine.
`@microsoft/fetch-event-source` is abandoned (last published 2.0.1 on 2021-04-25) and
`eventsource@^4.1.0` is a spec-faithful polyfill that therefore _inherits_ the no-headers limitation;
its own README points at `eventsource-client`. **Note also that
[03-local-development.md §9 step 8](../../03-local-development.md) currently describes a `?t=`
query-parameter handoff — that contradicts this scenario and is corrected as part of KAR-15.2.**

---

## EPIC-15-S14 — An agent DeFlow spawned finds port 7777 and cannot drive it

**Verifies:** KAR-15.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The agent is inside the network boundary and outside the trust boundary

  Scenario: a prompt-injected agent tries to drive the control plane
    Given a run in progress with "DeFlow-mock-agent" scripted to call
          "terminal/create" with a command that issues an HTTP request to
          "http://127.0.0.1:<port>/api/runs"
    And the node's permission level allows that command through the allowlist
    When the agent's request reaches DeFlowd
    Then the response is 401 with code "missing_token"
    And no run is created
    And the child environment the agent received contains no token variable
```

**Notes:** this is the threat-model row that most justifies the bearer token: _"an agent with a
prompt-injected instruction and a shell is inside the trust boundary of an unauthenticated daemon
that can start runs, read every artifact and approve human gates."_ The honest limit is worth
recording next to the passing test — a process running _as the user_ can read
`.DeFlow/daemon.json`; this raises the bar from trivial to requiring filesystem access as the user,
and only OS-level isolation would eliminate the class.

---

## EPIC-15-S15 — Happy path: one connection, three runs, one dispatcher

**Verifies:** KAR-15.3 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: Exactly one SSE connection per tab

  Scenario: three run panels share one stream
    Given a browser tab that opened one connection at app start
    When the operator opens run panels for "r_a", "r_b" and "r_c"
    Then the tab holds exactly one SSE connection
    And the connection's "runs" filter contains all three run ids
    And one applyEvent dispatcher routes each frame by its "runId" to the right projection set
    And frames for all three runs arrive interleaved in strictly increasing seq order
```

---

## EPIC-15-S16 — What breaks without multiplexing: six streams and a `fetch` that never resolves

**Verifies:** KAR-15.3 · **Type:** Failure · **Automated at:** browser

```gherkin
Feature: The six-connection cap is an architecture constraint, not a tuning knob

  Scenario: the failure the design prevents
    Given a page that opens one SSE connection per run panel
    When six run panels are open against the same origin
    And an ordinary "GET /api/runs" fetch is issued from the same page
    Then the fetch does not resolve within 10 seconds
    And no error is raised — the request is queued behind the streams
    And the symptom presents as "the daemon hung" with a healthy daemon

  Scenario: the multiplexed design under the same load
    Given the same six runs subscribed on one multiplexed connection
    When the same "GET /api/runs" fetch is issued
    Then it resolves promptly
    And the connection count for the origin is 1
```

**Notes:** DeFlowd runs on Node's `http` server, which is HTTP/1.1. HTTP/2 on localhost is not
available — browsers refuse h2c, so h2 would require TLS, and shipping a certificate for `127.0.0.1`
is a worse problem than the one it solves. Browsers cap concurrent connections per origin at about
six, and an SSE connection never closes. This scenario is expensive to automate and worth it exactly
once, because it is the failure nobody believes until they watch a `fetch` sit there.

---

## EPIC-15-S17 — Subscribe mid-stream: backfill before live, no gap and no duplicate

**Verifies:** KAR-15.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Adding a run panel must not open a second connection or force a reconnect

  Scenario: subscribing to a run that is already 400 events in
    Given an open stream whose hello frame carried streamId "s_1"
    And the client's cursor for run "r_b" is 0
    And run "r_b" already has 400 committed events
    When the client calls "POST /api/stream/s_1/subscribe { runs: ['r_b'] }"
    Then the same connection is used — no reconnect occurs
    And an "event: subscribed" frame lists the new filter
    And the 400 backfill frames for "r_b" are delivered in seq order before any live frame
    And an "event: caught_up" frame carries { runId: "r_b", seq: 400 }
    And live frames for "r_b" follow
    And no event is delivered twice and none is skipped
```

---

## EPIC-15-S18 — `runs=*` carries lifecycle only, not every `node.progress` frame

**Verifies:** KAR-15.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: The global topic exists so an idle tab stays idle

  Scenario: a busy run and a tab subscribed only to the global topic
    Given a tab connected with "runs=*"
    And a run emitting 500 "node.progress" frames and 3000 io_chunk rows
    When the run also emits "run.created", "human.requested" and "run.completed"
    Then the tab receives exactly those three frames
    And it receives no "node.progress" frame
    And it receives no io_chunk row
    And the run list and the cross-run approval queue update from those frames alone
```

---

## EPIC-15-S19 — The frame contract: `hello`, `retry`, `id:`, one-line data, keepalive

**Verifies:** KAR-15.3 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The SSE frame contract

  Scenario: the opening frames and the steady state
    When a client opens "GET /api/stream?runs=r_a&since=0"
    Then the response headers are
        "Content-Type: text/event-stream", "Cache-Control: no-cache, no-transform",
        "X-Accel-Buffering: no", "Connection: keep-alive", "X-DeFlow-Api: 1", "Vary: Origin"
    And the first frame is "event: hello" with
        { streamId, apiVersion, build, daemonEpoch, headSeq }
    And "retry: 2000" is written once, immediately after
    And every ledger frame carries "id: <seq>" with no exceptions
    And every ledger frame uses the default unnamed event type
    And each frame's data is the full EventEnvelope on exactly one line of JSON
    And no event is ever split across multiple data: lines

  Scenario: keepalive on an idle stream
    Given an open stream with no events for 60 seconds of Clock time
    Then four ": keepalive" comment lines were written
    And the connection is still open
    And the client ignored every one of them
```

**Notes:** the keepalive costs 12 bytes and exists so no socket-inactivity timer anywhere in the path
— Node's, the OS's, a proxy's — ever sees a silent connection. Long-running DeFlow nodes are routinely
idle for minutes, so this is a steady-state condition rather than an edge case.

---

## EPIC-15-S20 — Control frames never reach the reducer; unknown `kind` is ignored

**Verifies:** KAR-15.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Discriminate on payload kind, not on the SSE event name

  Scenario: named frames are routed to the control handler
    Given a stream emitting "hello", "subscribed", "caught_up" and ledger frames
    When the client processes them
    Then only the unnamed frames reach applyEvent
    And "hello", "subscribed" and "caught_up" reach handleControl
    And no control frame is ever passed to the reducer

  Scenario: an old UI against a newer daemon
    Given a ledger frame whose payload kind is "some.future.kind"
    When the client dispatcher receives it
    Then it is ignored without throwing
    And the client's cursor still advances past its seq
    And the backend reducer ignores the same kind identically
```

**Notes:** ignoring unknown kinds on both sides is what lets a user run an older UI build against a
newer daemon without corruption. The cursor still advancing is the subtle half — a client that skips
the event but not the cursor will re-request it forever.

---

## EPIC-15-S21 — The two-phase drain: an event committed between drain and park is not lost

**Verifies:** KAR-15.3 · **Type:** Concurrency · **Automated at:** integration

```gherkin
Feature: Subscribe-then-drain-again, never subscribe-only

  Scenario: a commit lands in the race window
    Given a stream that has just drained to empty at cursor 500
    When an event with seq 501 commits after the final drain query and before the park
    Then the handler's park resolves on the post-commit signal
    And the next drain delivers seq 501
    And no event is lost
    And the delivery is bounded by the keepalive tick even if the notification is missed

  Scenario: the drain is bounded per wake-up
    Given three subscribed runs each with 2000 pending events
    When the handler wakes
    Then it issues one "LIMIT 500" query per run
    And merge-sorts the batches by seq before writing
    And repeats until every run's query returns empty
    And holds no query open between iterations
```

**Notes:** because the notify is post-commit and the reaction is _"drain from my cursor"_ rather than
_"here is the payload"_, the emitter carries no data and needs no ordering guarantees — a missed
notification only delays delivery to the next one, and the keepalive tick bounds that. This is
deliberately the least clever part of the system.

---

## EPIC-15-S22 — The emitter fires post-commit; a rollback advances no cursor

**Verifies:** KAR-15.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: A cursor must never point past an event that does not exist

  Scenario: a transaction that rolls back
    Given an open stream at cursor 500
    When an append transaction allocates seq 501 and then rolls back
    Then no frame with id 501 is written to the stream
    And the client's cursor remains 500
    And the emitter was called only after "db.transaction(appendAll)(events)" returned

  Scenario: the next successful commit
    When a subsequent transaction commits and receives seq 502
    Then the client receives id 502
    And the missing 501 is not reported as a loss
```

**Notes:** if the emitter fires _inside_ the transaction, a stream can read a row a subsequent
rollback removes and the client's cursor advances past an event that does not exist. The second
scenario is EPIC-15-S29's precondition — this is where the gap comes from.

---

## EPIC-15-S23 — The 82.6 MB WAL: never hold a cursor open across a stream

**Verifies:** KAR-15.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Bounded queries, closed each time

  Scenario: the measured failure, as a regression guard
    Given a stream open against a file-backed ledger
    When 20,000 rows are written while the stream is live
    Then the "-wal" file stays under the stated bound
    And "PRAGMA wal_checkpoint(TRUNCATE)" reclaims space
    And no lazy iterate() cursor and no read transaction was held open across the stream

  Scenario: the stream is not served from the write connection
    Given a large read issued on a read-only connection
    When a write is issued concurrently on the write connection
    Then neither blocks the other beyond the documented busy_timeout
    And an in-flight stream continues to receive frames
```

**Notes:** **verified 2026-08-02** — holding one open cursor while writing 20k rows produced an
**82.6 MB** `-wal` file that no checkpoint could truncate: `wal_checkpoint(TRUNCATE)` returned
`{busy:0, log:0, checkpointed:0}` and space was reclaimed only after the cursor closed. The tail
query itself is cheap — served by `SEARCH event USING COVERING INDEX event_run_seq`, with 1,000 such
queries completing in **196 ms total, roughly 0.2 ms each** — so there is no performance argument for
the lazy cursor.

---

## EPIC-15-S24 — `io_chunk` never appears on the control-plane stream

**Verifies:** KAR-15.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Agent stdout is the data plane and has its own endpoint

  Scenario: a noisy node during an open stream
    Given an open stream subscribed to run "r_a"
    When the node emits 5 MB of stdout, recorded as io_chunk rows
    Then no frame on the stream corresponds to an io_chunk row
    And the drain query selects only control-plane columns from the event table
    And the terminal view obtains that output from
        "GET /api/runs/r_a/nodes/:nodeId/io" instead
```

**Notes:** mixing the data plane into this query _"is what makes people believe event sourcing needs
snapshots"_ — and it also breaks the progress watermark, since an agent producing megabytes while
accomplishing nothing would start looking like progress.

---

## EPIC-15-S25 — A fatal condition closes with `event: fatal`, and only two codes stop retrying

**Verifies:** KAR-15.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: A stream never returns an error body mid-flight

  Scenario Outline: fatal <code>
    Given an open stream
    When the daemon encounters "<condition>"
    Then a final "event: fatal" frame carries the standard error envelope with code "<code>"
    And the connection closes
    And the client's retry behaviour is "<retry>"

    Examples:
      | condition                          | code           | retry          |
      | the token was rotated              | bad_token      | stops retrying |
      | the daemon epoch advanced          | epoch_mismatch | stops retrying |
      | a transient internal read failure  | internal       | keeps retrying |
```

---

## EPIC-15-S26 — Resume path 1: automatic reconnect with `Last-Event-ID`

**Verifies:** KAR-15.4 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Resume by header, on the browser's own reconnect

  Scenario: the socket is killed mid-stream
    Given a client that has applied events up to seq 10432 on a connection
        that previously opened successfully
    And 40 further events commit while the socket is down
    When the client's reconnection logic fires and sends "Last-Event-ID: 10432"
    Then the server resumes with "SELECT * FROM event WHERE seq > 10432 ORDER BY seq LIMIT 500"
    And all 40 events are delivered exactly once, in seq order
    And none of them is delivered twice
```

---

## EPIC-15-S27 — Resume path 2: a page reload sends no `Last-Event-ID` at all

**Verifies:** KAR-15.4 · **Type:** Failure · **Automated at:** integration + browser

```gherkin
Feature: The explicit cursor path is mandatory, not an optimisation

  Scenario: the browser does not send Last-Event-ID after a reload
    Given a tab that has applied events up to seq 10432
    When the page is reloaded and a fresh stream is opened
    Then the request carries no "Last-Event-ID" header
    And it carries "?since=10432" from the client's own persisted cursor
    And every event after 10432 is delivered

  Scenario: the daemon was down when the tab first tried to connect
    Given a tab whose initial stream connection never opened successfully
        because DeFlowd was not yet bound
    When DeFlowd comes back and the tab reconnects
    Then the request still carries no "Last-Event-ID"
    And the client's persisted cursor supplies "?since="
    And no event committed while the daemon was down is missed

  Scenario: the failure if the server guessed instead
    Given a server that treats a missing "Last-Event-ID" as "start from head"
    When the reload case above occurs
    Then every event that occurred while the tab was down is silently lost
    And the UI renders a plausible but wrong picture
    And this violates NF10, which is why this scenario exists as a regression guard
```

**Notes:** the browser sends `Last-Event-ID` **only** when its own reconnection logic fires on a
connection that had previously opened successfully — never after a page reload, never on a first
attempt, never when the initial connect failed. That third case is the common one during development:
you restart `DeFlowd`, the tab's stream fails to open, and when the daemon comes back the tab
reconnects with no cursor at all. The CLI has no `Last-Event-ID` mechanism whatsoever, so `?since=`
is the only path it has.

---

## EPIC-15-S28 — Precedence: `since` > `Last-Event-ID` > head

**Verifies:** KAR-15.4 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: The client's own cursor is more trustworthy than the browser's

  Scenario Outline: resolving the cursor
    Given a request with since "<since>" and Last-Event-ID "<lastEventId>"
    When the handler resolves the starting cursor
    Then it is <cursor>

    Examples:
      | since | lastEventId | cursor          |
      | 10432 | 10400       | 10432           |
      | 10432 | (absent)    | 10432           |
      | (absent) | 10400    | 10400           |
      | (absent) | (absent) | head of the log |
      | 0     | 10400       | 0               |

  Scenario: starting at head is announced
    Given a request carrying neither cursor
    Then the hello frame's headSeq tells the client where it started
    And the client can decide to hydrate rather than accept the gap
```

**Notes:** the `since=0` row is deliberate — an explicit zero must beat a stale header rather than
being treated as falsy and discarded. That coercion bug is easy to write and produces a UI that
silently starts from head on every cold hydrate.

---

## EPIC-15-S29 — Gaps are healthy: 4, 5, 7 is not data loss

**Verifies:** KAR-15.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: The cursor contract is "strictly greater than", never "seq + 1"

  Scenario: a rolled-back transaction burned a value
    Given the "crash-resume-seq-gap" fixture whose sequence runs 4, 5, 7, 8, 11
    When a client streams it from since=0
    Then it applies all five events in order
    And it reports no data loss
    And it does not refetch from zero
    And it does not emit a warning about a missing seq
    And a CI grep finds no arithmetic anywhere comparing an incoming seq to previous + 1

  Scenario: the only integrity check that is allowed
    Given a client wanting reassurance it is not behind
    Then it may compare its applied count against hello.headSeq for ordering
    And it must never compare it for density
```

**Notes:** _"`seq` 4, 5, 7 is a normal, healthy log — `6` belongs to another run, or to a pruned
event whose number `AUTOINCREMENT` will never reissue."_ A client that treats a gap as
a dropped event reports false data loss on a perfectly correct stream and, worse, may try to "repair"
by refetching from zero — which on a multi-hour run is minutes of wasted work triggered by nothing.
**Do not write gap detection.**

---

## EPIC-15-S30 — Rowid reuse: why `AUTOINCREMENT` is mandatory

**Verifies:** KAR-15.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: A persisted cursor must keep meaning the same event forever

  Scenario: the demonstration against a bare INTEGER PRIMARY KEY
    Given a table declared "seq INTEGER PRIMARY KEY" without AUTOINCREMENT
    And rows up to seq 100
    When the row at seq 100 is deleted and a new row is inserted
    Then the new row is assigned seq 100 again
    And any client cursor persisted at 100 now points at a different event, silently

  Scenario: the real schema
    Given the event table declared "seq INTEGER PRIMARY KEY AUTOINCREMENT"
    When the same delete-and-insert is performed
    Then the new row's seq is greater than 100
    And a persisted cursor at 100 still means what it meant
    And the cost is one sqlite_sequence row update per insert
```

**Notes:** **verified 2026-08-02.** The moment run retention ships, every persisted SSE cursor would
point at a different event than the one it was written for — and nothing would report an error. Pay
the `sqlite_sequence` cost.

---

## EPIC-15-S31 — Cold-start hydrate loop, then open the stream at the cursor

**Verifies:** KAR-15.4 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: A client with no cursor hydrates before it streams

  Scenario: 12,000 events, no persisted cursor
    Given a client with no stored cursor for run "r_a" which has 12,000 events
    When it calls "GET /api/runs/r_a/events?since=0&limit=5000"
    Then the response is { events, cursor, headSeq, more } with more true
    And limit defaults to 1000 when omitted and is capped at 5000 when exceeded
    When the client repeats with since=cursor until more is false
    Then it has applied all 12,000 events exactly once
    And headSeq let it render an honest progress bar rather than a spinner
    When it then opens "GET /api/stream?runs=r_a&since=<cursor>"
    Then no event is duplicated and none is missing at the seam
```

---

## EPIC-15-S32 — The daemon restarted under the tab: `daemonEpoch` and `build` skew

**Verifies:** KAR-15.4 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Detecting that the world changed underneath a tab

  Scenario: a daemon restart
    Given a tab with an open stream whose hello carried daemonEpoch 7
    When DeFlowd is restarted and the tab reconnects
    Then the new hello carries daemonEpoch 8
    And the client detects the restart from that difference alone
    And it resumes from its own persisted cursor rather than from head

  Scenario: a write carrying a stale epoch
    When a write is attempted stamped with epoch 7 after the daemon reached epoch 8
    Then the response is 409 with code "epoch_mismatch"
    And the stream's client stops retrying on a fatal frame carrying that code

  Scenario: an old tab against a new daemon build
    Given hello.build differs from the build the tab loaded
    Then the UI prompts for a reload
    And it does not silently continue rendering against a contract it may not understand
```

**Notes:** daemon and UI ship in the same npm tarball, so skew only ever means "stale tab", never
"stale deployment" — which is why a reload prompt is a complete answer rather than a migration
problem.

---

## EPIC-15-S33 — Happy path: pause, resume, cancel — and pausing a paused run

**Verifies:** KAR-15.5 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Writes are plain POSTs over a state machine

  Scenario: the three control verbs
    Given a running run "r_a"
    When "POST /api/runs/r_a/pause" is called
    Then "run.paused" is appended and the response carries its seq
    When "POST /api/runs/r_a/resume" is called
    Then "run.resumed" is appended and the response carries its seq
    When "POST /api/runs/r_a/cancel { mode: 'cooperative' }" is called
    Then "run.cancel.requested" with mode "cooperative" is appended

  Scenario: repeating a write is a no-op, not an error
    Given a run already paused
    When "POST /api/runs/r_a/pause" is called again
    Then the response is 200 carrying the existing seq
    And no second "run.paused" event is appended

  Scenario: a run that genuinely cannot pause
    Given a run already completed
    When pause is called
    Then the response is 409 with code "run_not_pausable"
```

---

## EPIC-15-S34 — `ifLastSeq` and the stale approval panel

**Verifies:** KAR-15.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Optimistic concurrency on a decision surface that moves by itself

  Scenario: the panel went stale while the operator read it
    Given a queued PlanPatch "p_1" rendered in a panel at cursor 10891
    And the patch policy timer auto-applied a different patch, moving the head to 10920
        in a way that changes the decision surface
    When "POST /api/runs/r_a/patches/p_1/decide { decision: 'approve', ifLastSeq: 10891 }"
    Then the response is 409 with code "stale_cursor" carrying the current head 10920
    And no decision is recorded

  Scenario: a harmless advance
    Given the head advanced only by node.progress events
    When the same call is made with ifLastSeq 10891
    Then the decision succeeds

  Scenario: deciding twice
    Given "p_1" was already approved by the operator
    When decide is called again
    Then the response is 409 with code "patch_already_decided"
    And the body carries the original decision and who made it
    And no second "plan.patched" event is appended
```

**Notes:** _"this is what stops an operator approving a patch on a panel that went stale while they
read it — a real hazard given that patches are auto-applied on a policy timer."_ The distinction
between a decision-changing advance and a harmless one is the part that needs a real implementation
rather than a head comparison.

---

## EPIC-15-S35 — `Idempotency-Key` on run creation

**Verifies:** KAR-15.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: A retried creation must not start a second run

  Scenario: the same key twice
    Given "POST /api/runs" with Idempotency-Key "k1" returned
        201 { runId: "r_01JXQ", seq: 10433, status: "awaiting-spec-approval" }
    When the identical request is repeated with the same key
    Then the response is the original 201 body, byte-identical
    And exactly one run exists
    And the key is stored in the effect journal alongside engine-level idempotency keys,
        not in a separate table
```

---

## EPIC-15-S36 — Forceful cancel is the kill switch, and zombies are excluded

**Verifies:** KAR-15.5 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: One control stops every child process in a run

  Scenario: forceful cancel of a run with a process tree
    Given a run whose node spawned "bash -c 'sleep 300 & sleep 300 & sleep 300; wait'"
        detached, so the process group id equals the child's pid
    When "POST /api/runs/r_a/cancel { mode: 'forceful' }" is called
    Then the process group is signalled with a negative pid
    And the kill-verification assertion excludes processes in state "Z"
    And no non-zombie process remains in that group
    And "run.cancel.requested" with mode "forceful" is in the ledger

  Scenario: the naive assertion that would produce a false negative
    Given the same successful group kill
    When "ps" is inspected immediately afterwards
    Then the grandchildren are still listed, in state "Z", with ppid 1
    And a verification that did not exclude Z-state would wrongly conclude the kill failed
```

**Notes:** verified by measurement — after a _successful_ group SIGKILL the grandchildren remain
listed as zombies awaiting reaping by init. Reaping is prompt under launchd and systemd but can lag
badly inside containers, so this bites hardest in exactly the environment where you cannot attach a
debugger.

---

## EPIC-15-S37 — Creating a run does not start it

**Verifies:** KAR-15.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: The spec gate is real, not a formality

  Scenario: creation appends and stops
    When "POST /api/runs" is called with
        { input: { kind: "text", text: "Migrate the design system across packages/ui" },
          cwd: "/work/voyado-web",
          budget: { costUsd: 25, wallclockMs: 14400000 },
          permission: "worktree" }
    Then the response is 201 { runId, seq, status: "awaiting-spec-approval" }
    And "task.submitted" is in the ledger ("run.created" comes from the framing interview,
        EPIC-10-S6, once there is a TaskSpec to carry)
    And no "node.scheduled" event exists
    And the framing interview runs

  Scenario: acting before approval
    When any control endpoint is called on that run before approval
    Then the response is 422 with code "spec_not_approved"

  Scenario: approval starts execution
    When "POST /api/runs/:id/spec/approve" is called
    Then "run.spec.approved" is appended with the specHash
    And execution begins
```

---

## EPIC-15-S38 — Engine idempotency keys are not on the API

**Verifies:** KAR-15.5 · **Type:** Edge case · **Automated at:** contract

```gherkin
Feature: The effect journal is not client-reachable

  Scenario: the emitted schemas
    Given the JSON Schemas emitted to ".DeFlow/schemas/"
    When every request and response schema is inspected
    Then none of them contains the engine's (runId, nodeId, attempt) idempotency key
    And no endpoint accepts one as input
    And the API-level Idempotency-Key header is a distinct concept with a distinct name
```

**Notes:** _"conflating the two would let a client reach into the effect journal, which is precisely
the invariant that makes crash recovery sound."_

---

## EPIC-15-S39 — Plan version rail and RFC 6902 diffs

**Verifies:** KAR-15.6 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The scrubber's data

  Scenario: the version rail and a diff between two versions
    Given the "three-patches" fixture run
    When "GET /api/runs/:id/plans" is called
    Then it returns { version, seq, planHash, decision, reason }[] ordered by version
    When "GET /api/runs/:id/plans/diff?from=3&to=4" is called
    Then the response contains nodes.added, nodes.removed, nodes.changed and nodes.unchanged
    And each changed entry carries an RFC 6902 patch array, e.g.
        [{ "op": "replace", "path": "/provider", "value": "codex" }]
    And edges.added and edges.removed are present
    And unionLayoutKey is present and documented as an opaque cache key
    And reason is rendered verbatim, never summarised
    And decision is one of auto, approved or rejected
    And the patch was produced by "rfc6902@5.3.0", not "fast-json-patch"

  Scenario: an unknown version
    When "GET /api/runs/:id/plans/99" is called
    Then the response is 404 with code "plan_version_not_found"
```

**Notes:** `fast-json-patch` last shipped in 2022; the pin matters because the RFC 6902 output is what
the UI renders in the field-level "why did this change" panel next to the human-readable `reason`.
`unionLayoutKey` is explicitly **not** part of the versioned contract.

---

## EPIC-15-S40 — The `io_chunk` tail: last N KB, never the whole log

**Verifies:** KAR-15.6 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: A terminal reattach streams rather than buffers

  Scenario: tailing a very large log
    Given a node with 200 MB of io_chunk rows
    When "GET /api/runs/:id/nodes/:nodeId/io?limit=200" is called with fromSeq omitted
    Then the response media type is "application/x-ndjson"
    And each line is one io_chunk, e.g.
        {"seq":88120,"stream":"stdout","ts":1754140012345,"data":"...42 tests passed\r\n"}
    And the response is the tail, not the head
    And the daemon's resident memory does not grow by the size of the log
    When "…?fromSeq=88000&limit=200" is called
    Then it pages forward from that seq deterministically

  Scenario: the complete archive is on disk
    Then "runs/<runId>/nodes/<nodeId>/stdout.log" holds the full output
    And it is opened in a virtualised viewer rather than in xterm
```

**Notes:** the NDJSON framing is explicitly outside the versioned contract — it is a tail format and
may change. Say so in the client types so nobody builds a persistence layer on it.

---

## EPIC-15-S41 — Artifacts: `Range`, `HEAD` and immutable caching

**Verifies:** KAR-15.6 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Content-addressed blobs

  Scenario: partial fetch and metadata
    Given an artifact stored at "artifacts/<sha>/"
    When "HEAD /api/artifacts/<sha>" is called
    Then the response carries the size and media type with no body
    When "GET /api/artifacts/<sha>" is called with "Range: bytes=0-1023"
    Then the response is 206 with exactly those bytes
    And the response carries immutable cache headers, because content addressing makes it safe
    When an unknown sha is requested
    Then the response is 404 with code "artifact_not_found"
```

---

## EPIC-15-S42 — The inspector bundle and a packet whose segments sum to its header

**Verifies:** KAR-15.6 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The node inspector's data

  Scenario: the bundle and the packet
    When "GET /api/runs/:id/nodes/:nodeId?attempt=1" is called
    Then the bundle contains the provider, model, binary version, permission level,
        duration, cost, retries and worktree path
    When "GET /api/runs/:id/nodes/:nodeId/packet?attempt=1" is called
    Then it returns the assembled ContextPacket with per-segment token counts
    And the per-segment counts sum exactly to the header total
    And every token count carries its method
    And pinned segments appear first
    And each segment carries the sourceEvent that put it there
```

**Notes:** the sum assertion is one of the five Playwright smokes for a reason — a breakdown that does
not sum is the visible symptom of the packet being re-derived from the rendered prompt instead of
served from the stored manifest.

---

## EPIC-15-S43 — Facts and consumers, one indexed query each

**Verifies:** KAR-15.6 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The memory graph is two queries over fact_edges

  Scenario: facts with provenance and their consumers
    When "GET /api/runs/:id/facts?key=&by=" is called
    Then every fact carries provenance: which node wrote it, from what evidence,
        at what time, at what confidence
    When "GET /api/runs/:id/facts/:factId/consumers" is called
    Then it returns every node with a "fact.read" for that fact
    And it returns no writer
    And the query plan uses the "fact_edges_by_fact" index
    And the consumer set is computed in SQLite, not assembled in JavaScript
```

---

## EPIC-15-S44 — Every 404 names its own resource; every list is bounded

**Verifies:** KAR-15.6 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Bounded reads and specific errors

  Scenario Outline: <resource> not found
    When "<path>" is requested for a nonexistent resource
    Then the response is 404 with code "<code>"

    Examples:
      | resource | path                                  | code                    |
      | run      | /api/runs/nope                        | run_not_found           |
      | node     | /api/runs/r_a/nodes/nope              | node_not_found          |
      | artifact | /api/artifacts/deadbeef               | artifact_not_found      |
      | plan     | /api/runs/r_a/plans/99                | plan_version_not_found  |

  Scenario: no endpoint can return an unbounded set
    When every list endpoint is called with no limit
    Then each applies a documented default
    And each caps an oversized limit rather than honouring it
    And every read ran on a read-only connection with busy_timeout set
```

---

## EPIC-15-S45 — Happy path: reduced state at a sequence, server-side

**Verifies:** KAR-15.7 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: SQLite rebuilds state faster than the browser can

  Scenario: a snapshot mid-run
    Given a run with 10,000 control-plane events
    When "GET /api/runs/:id/snapshot?seq=8200" is called
    Then the response is { seq: 8200, state, planVersion, planHash }
    And "state" is the reduced RunState at exactly seq 8200
    And it is byte-identical to reducing the same events client-side
    And it was produced by the same pure reducer the engine uses, not a second projection
    And the reduction completed within the stated budget, consistent with the measured 29 ms
    And io_chunk was not read

  Scenario: the head alias
    When "…/snapshot?seq=head" is called
    Then the returned seq is the actual current head value, echoed in the body
```

---

## EPIC-15-S46 — A `seq` inside a gap resolves down, and says so

**Verifies:** KAR-15.7 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: A requested seq may name a value that was never committed

  Scenario: asking for a burned sequence number
    Given the "crash-resume-seq-gap" fixture whose sequence runs 4, 5, 7, 8, 11
    When "…/snapshot?seq=6" is called
    Then the state returned is the state at seq 5
    And the response's "seq" field is 5, not 6
    And no error is raised

  Scenario: asking beyond head
    When "…/snapshot?seq=999999" is called on a run whose head is 11
    Then the state returned is the head state
    And the response's "seq" field is 11

  Scenario: a nonexistent run
    Then "…/snapshot?seq=head" returns 404 with code "run_not_found"
```

---

## EPIC-15-S47 — Scrubbing a multi-hour run does not replay from zero in the browser

**Verifies:** KAR-15.7 · **Type:** Edge case · **Automated at:** browser (three lines) + deferred to
EPIC-16 (two lines)

```gherkin
Feature: The reason this endpoint exists is browser memory

  Scenario: dragging the plan-evolution scrubber
    Given the "three-patches" fixture served by "DeFlow replay"
    When the operator drags the scrubber back to plan v1 and forward through each patch
    Then each position is hydrated from "…/snapshot?seq=<N>"
    And the client replays forward only from the nearest snapshot
    And no client-side reduction from seq 0 occurs
    And the tab remains responsive throughout
    And the rendered diff for each step matches the plans/diff response for the same pair
```

**Notes:** the server half of this story is EPIC-15-S45 and EPIC-15-S46 above, and neither of them
stops the *client* from ignoring the endpoint and folding the run itself — which is the failure the
endpoint was built to prevent. That is why this scenario is about the client and not about the
route.

**This scenario is automated as far as EPIC-15 owns it, and the remainder is EPIC-16's.** The epic's
own scope line (["Out of scope"](../epics/EPIC-15-daemon-api.md)) puts the shared
`packages/web/src/api/` modules here and the Vue application there, so the three lines that are
about the *client's request pattern* are automated here, against a real Chromium and an injected
`fetch`, in `packages/web/src/api/scrub.test.ts` over `packages/web/src/api/scrub.ts`
(`createScrubber`, the only way either client materialises the state at a `seq`):

- **"each position is hydrated from `…/snapshot?seq=<N>`"** — a drag back to v1 and forward through
  each of the three patches is four requests to `…/snapshot`, carrying `seq` 2, 6, 9 and 13, and
  **zero** requests to `…/events`. A position that lands on a number this run never committed (11)
  is asked for as 11 and answered at 9, and is held under the `seq` it reflects.
- **"the client replays forward only from the nearest snapshot"** — with a target inside the
  replay window, the one `…/events` read carries `since=9`, the greatest snapshot at or below it,
  never `since=2`; a position the client folded itself is not a base, so replays never chain; and
  the state reached by replay is asserted equal to the state the endpoint returns for the same
  `seq`.
- **"no client-side reduction from seq 0 occurs"** — scrubbing a 10,000-event run folds 20 events
  in the browser and issues no request with `since=0`, and a scrubber that is *holding* the `seq` 0
  position (the initial state under another name) still refuses to fold forward from it.

**Deferred to EPIC-16 — the two remaining lines.** *"And the tab remains responsive throughout"* and
*"And the rendered diff for each step matches the plans/diff response for the same pair"* cannot be
automated in this epic and are **not** covered by the file above. Both are assertions about a view
that does not exist yet: there is no scrubber control to drag and no diff surface to render, so the
`When` they hang off — *"the operator drags the scrubber"* — has no subject. They belong with the
plan-evolution view in [EPIC-16](../epics/EPIC-16-ui-foundation.md) (KAR-16.2, KAR-16.4), which
owns what the browser does with these modules, and are to be automated there as a Playwright drag
over the same `three-patches` fixture, asserting a responsive main thread and the rendered diff
against `GET /api/runs/:id/plans/diff?from=N&to=M` for the same pair. Until that lands, this
scenario is **partially** automated and is recorded as such rather than as closed.

---

## EPIC-15-S48 — PTY upgrade is authenticated before the socket exists

**Verifies:** KAR-15.8 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The interactive terminal channel

  Scenario: an unauthenticated upgrade
    When a WebSocket upgrade is attempted at "/api/pty/r_a/n_impl_1" with no bearer token
    Then the upgrade is refused before the socket is accepted
    And no "connection" event fires
    And the upgrade is handled by a "server.on('upgrade', …)" listener attached to the same
        node:http server Hono serves from

  Scenario: an authenticated session
    Given an accepted socket for a node running under a real pty
    When binary bytes are sent to the server
    Then they are written to the pty and echoed back as binary frames
    When a text frame {"t":"resize","cols":120,"rows":40} is sent
    Then the child observes the new dimensions
    When the node exits
    Then a text frame {"t":"exit","code":0} is delivered and the socket closes

  Scenario: closing the panel loses nothing
    When the socket is closed mid-run
    Then io_chunk rows continue to be appended
    And the node continues to completion
    And the full output remains available through the io endpoint and on disk
```

**Notes:** the socket is a **live interactive channel only** — durable output lands in `io_chunk`
regardless. This is the one P1 story in the epic; F8.2's P0 obligation is met by
`POST /api/runs/:id/interject` in [EPIC-13](../epics/EPIC-13-human-in-the-loop.md), so cutting this
story costs no P0 requirement.

---

**Related:** [Epic](../epics/EPIC-15-daemon-api.md) · [Board](../board.md) ·
[11-api-and-realtime.md](../../11-api-and-realtime.md) ·
[15-security-model.md](../../15-security-model.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
