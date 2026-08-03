# EPIC-16 flows — Web UI foundation and projection store

> Behavioural specification for [EPIC-16](../epics/EPIC-16-ui-foundation.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor | Description |
|---|---|
| **Operator** | The engineer driving Karvan. In this epic they mostly *open a tab and leave it open for six hours* — the scenarios are about what happens underneath while they do |
| **Browser tab** | One `@karvan/web` SPA instance. **One SSE connection, opened once at app start, never a second** |
| **karvand** | The local daemon on `127.0.0.1:7777`, serving the API, the SSE stream and — via Vite middleware mode (D10) — the UI itself. One process, one port, no proxy, no CORS |
| **Replay harness** | `karvan replay <fixture> --speed <n>x`. A daemon mode that serves the *normal* `/api/*` and `/api/stream` from a recorded ledger. The UI cannot tell the difference |
| **Stream client** | `src/ledger/stream.ts` on `eventsource-client@^1.2.0` — sends the bearer token as a header, which native `EventSource` cannot do |
| **Dispatcher** | `src/ledger/apply.ts`. Switches on `e.kind`, calls the seven projections, routes by `e.runId` |
| **Projections** | The seven pure modules in `src/ledger/projections/`. **Zero Vue imports.** Where the risky logic lives |
| **Run store** | `useRunStore` — `shallowRef` containers, version counters, view-model selectors. Reactivity and nothing else |
| **Graph canvas** | `src/components/graph/GraphCanvas.vue`, the facade over `@vue-flow/core`. The only file allowed to import it |

## Preconditions common to all flows

```gherkin
Background:
  Given karvand is bound to 127.0.0.1:7777 and Vite runs in middleware mode inside it,
        so dev and production routing are byte-identical and there is no proxy in front of SSE
  And every request except "GET /api/health" carries "Authorization: Bearer <token>"
        and is rejected if its Origin header is present and is not the daemon's own origin
  And the SSE response carries
        "Content-Type: text/event-stream", "Cache-Control: no-cache, no-transform",
        "X-Accel-Buffering: no" and "X-Karvan-Api: 1"
  And no compression middleware touches "/api/stream"
  And every ledger frame carries "id: <seq>" and the default (unnamed) SSE event type
  And "hello", "subscribed", "caught_up" and "fatal" are NAMED events and are stream control,
        never ledger events
  And "seq" is INTEGER PRIMARY KEY AUTOINCREMENT, so gaps are normal and cursors are never reused
  And the UI imports the Event union type-only from @karvan/core
  And browser-mode tests run in real Chromium — never jsdom, never happy-dom
```

> Two of those lines are load-bearing rather than decorative. **No compression on `/api/stream`**:
> gzip buffers, and a buffered SSE stream delivers events in clumps that look exactly like a backend
> scheduling bug and are not one ([11 §3.1](../../11-api-and-realtime.md)). And **real Chromium**:
> jsdom and happy-dom have no SVG measurement, no canvas and no WebGL, and *they fail silently* —
> `getBBox()` returns `0`, so a test asserting a label fits inside a node passes against a `0×0` box
> ([14 §13](../../14-testing-strategy.md)).

## Flow index

| Scenario | Title | Verifies | Type |
|---|---|---|---|
| EPIC-16-S1 | Happy path: a cold tab boots, hydrates, streams and renders | KAR-16.1, KAR-16.2 | Happy path |
| EPIC-16-S2 | The bootstrap token arrives in a fragment and never in a log | KAR-16.1 | Happy path |
| EPIC-16-S3 | Seven states, two themes, and never colour alone | KAR-16.1 | Edge case |
| EPIC-16-S4 | Driving the whole surface from the keyboard, with motion off | KAR-16.1 | Edge case |
| EPIC-16-S5 | The initial chunk stays under budget | KAR-16.1 | Edge case |
| EPIC-16-S6 | Three run panels, one connection | KAR-16.2 | Happy path |
| EPIC-16-S7 | The page reloads and `Last-Event-ID` is not sent | KAR-16.2 | Failure |
| EPIC-16-S8 | The connection drops mid-run and comes back with no seam | KAR-16.2 | Recovery |
| EPIC-16-S9 | A gap in `seq` is a healthy log, not data loss | KAR-16.2, KAR-16.3 | Edge case |
| EPIC-16-S10 | Control frames never reach the reducer | KAR-16.2, KAR-16.3 | Failure |
| EPIC-16-S11 | An old tab meets a newer daemon | KAR-16.2, KAR-16.3 | Edge case |
| EPIC-16-S12 | The daemon restarted underneath the tab | KAR-16.2 | Recovery |
| EPIC-16-S13 | Fatal stream conditions, and which ones stop the retry loop | KAR-16.2 | Failure |
| EPIC-16-S14 | Fifteen idle minutes, and the events that arrive in a clump | KAR-16.2 | Edge case |
| EPIC-16-S15 | Projections are pure, and the suite proves it | KAR-16.3 | Happy path |
| EPIC-16-S16 | `plan.ts` over the happy path: seven states, labelled edges | KAR-16.3 | Happy path |
| EPIC-16-S17 | `planHistory.ts`: the rail carries rejected patches too | KAR-16.3 | Happy path |
| EPIC-16-S18 | `context.ts`: the compaction whose "after" does not exist | KAR-16.3 | Edge case |
| EPIC-16-S19 | `gates.ts`: `unverifiable` and `needs-human` are not failures | KAR-16.3 | Edge case |
| EPIC-16-S20 | `cost.ts`: vendor-reported and estimated are never mixed | KAR-16.3 | Edge case |
| EPIC-16-S21 | `timeline.ts`: the node that never finished | KAR-16.3 | Edge case |
| EPIC-16-S22 | `blackboard.ts`: provenance, consumers and taint | KAR-16.3 | Edge case |
| EPIC-16-S23 | The same event applied twice changes nothing | KAR-16.3 | Failure |
| EPIC-16-S24 | Subscribe-backfill overlaps the cursor | KAR-16.2, KAR-16.3 | Concurrency |
| EPIC-16-S25 | Apply and drop: the raw event array is not retained | KAR-16.4 | Happy path |
| EPIC-16-S26 | Agent output goes to the terminal buffer and nowhere else | KAR-16.4 | Edge case |
| EPIC-16-S27 | Six hours at `--speed max` and the tab is still alive | KAR-16.4 | Edge case |
| EPIC-16-S28 | No Vue proxy reaches Vue Flow, ELK or xterm | KAR-16.4 | Failure |
| EPIC-16-S29 | Scrubbing hydrates from a snapshot, never from `seq` 0 | KAR-16.4 | Edge case |
| EPIC-16-S30 | The leak assertion that fires in dev and is absent in production | KAR-16.4 | Edge case |
| EPIC-16-S31 | The UI cannot tell a replay from a live run | KAR-16.5 | Happy path |
| EPIC-16-S32 | The six fixtures and what each one proves | KAR-16.5 | Happy path |
| EPIC-16-S33 | Speed control, pause and seek | KAR-16.5 | Edge case |
| EPIC-16-S34 | Fixtures are recorded, never hand-written | KAR-16.5 | Failure |
| EPIC-16-S35 | Nothing reaches past the graph facade | KAR-16.6 | Failure |
| EPIC-16-S36 | 400 nodes, measured in week one | KAR-16.6 | Edge case |
| EPIC-16-S37 | ELK in a worker, in the built output | KAR-16.6 | Edge case |
| EPIC-16-S38 | Adding a node does not reshuffle the graph | KAR-16.6 | Edge case |
| EPIC-16-S39 | The node animation you must not write | KAR-16.6 | Failure |
| EPIC-16-S40 | The graph is reachable from the keyboard and by a screen reader | KAR-16.6 | Edge case |

---

## EPIC-16-S1 — Happy path: a cold tab boots, hydrates, streams and renders

**Verifies:** KAR-16.1, KAR-16.2 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: The UI is a projection of the ledger, not a REST client (F4.1, NF10)

  Scenario: First open against a run already 4,000 events deep
    Given karvand is serving a run "r_01JXQ" whose headSeq is 4127
    And the browser tab has no persisted cursor
    When the Operator opens http://127.0.0.1:7777/#token=<t>
    Then the tab reads the token from the fragment and strips it from the address bar
    And the tab calls GET /api/runs/r_01JXQ/events?since=0
    And it repeats the call with since=<cursor> until the response has "more": false
    And it renders an honest progress indicator derived from "headSeq", not a spinner
    And only then opens GET /api/stream?runs=r_01JXQ&since=4127
    And the first frame received is the named event "hello"
          carrying { streamId, apiVersion, build, daemonEpoch, headSeq }
    And the plan graph renders every node from the hydrated state before the first live frame

  Scenario: Live frames advance the same projections
    When karvand appends "node.started" for "n_impl_3" at seq 4128
    Then the tab receives a frame with "id: 4128" on the default SSE event type
    And applyEvent routes it to every projection
    And the node "n_impl_3" renders in the "running" state within one frame
    And useRunStore.seq is 4128

  Scenario: Everything on screen came from an event
    Then every rendered value is derived from a projection, and every projection input was an
         EventEnvelope — there is no other data path into the store
    And no view calls a REST endpoint to obtain run state
```

**Notes:** the hydrate-then-stream order is not an optimisation, it is the correctness requirement of
[11 §4.1](../../11-api-and-realtime.md). Note also the `headSeq` detail: it exists so the UI can show
*"applying 3,400 of 4,127 events"* rather than an unbounded spinner during a long hydrate, which is
the difference between a slow start and a start that looks broken.

---

## EPIC-16-S2 — The bootstrap token arrives in a fragment and never in a log

**Verifies:** KAR-16.1 · **Type:** Happy path · **Automated at:** unit + e2e

```gherkin
Feature: Bootstrap handoff (11 §8)

  Scenario: The URL karvan up prints
    Given "karvan up" printed http://127.0.0.1:7777/#token=<t>
    When the Operator opens it
    Then sessionStorage holds the token
    And history.replaceState has removed the fragment from the address bar
    And every subsequent API request carries "Authorization: Bearer <t>"
    And no request URL the browser sends contains the token in its path or query string

  Scenario: The stream is why eventsource-client is a dependency
    Then GET /api/stream is opened with an Authorization header, not "?token="
    And the client library is "eventsource-client", not native EventSource,
        because native EventSource has no mechanism for custom headers at all

  Scenario: A second tab opened without the fragment
    Given sessionStorage is per-tab and the new tab has none
    When the Operator opens http://127.0.0.1:7777/ directly
    Then the app renders an explicit "paste the URL printed by karvan up" state
    And it does not render a spinner, a blank page, or a 401 retry loop

  Scenario: The token is not sent to third parties
    Then no outbound request leaves 127.0.0.1
    And no Referer header carrying the token can exist, because the token was never in a URL
```

**Notes:** the whole reason for the fragment is that fragments are never sent to the server, so the
token cannot land in an access log. A token in a query string ends up in shell history, terminal
scrollback, browser history, `Referer` headers and any access log anyone ever adds — for a
long-lived token that authorises **spawning processes on the user's machine**
([11 §8.1](../../11-api-and-realtime.md)). Do not use `@microsoft/fetch-event-source` (abandoned
2021-04-25) or plain `eventsource@^4.1.0` (inherits the no-headers limitation by design).

---

## EPIC-16-S3 — Seven states, two themes, and never colour alone

**Verifies:** KAR-16.1 · **Type:** Edge case · **Automated at:** unit + browser

```gherkin
Feature: One state palette, seven views (12 §9.1, 9.2)

  Scenario Outline: Every state resolves in both themes and carries three signals
    Given the state chip component
    When it renders state "<state>"
    Then the computed value of "--state-<state>" is non-empty under ":root"
    And the computed value of "--state-<state>" is non-empty under ".dark"
    And the rendered chip contains a colour, a glyph element, and the text "<label>"
    And the chip's accessible name contains "<label>"

    Examples:
      | state          | label          |
      | pending        | Pending        |
      | running        | Running        |
      | blocked        | Blocked        |
      | passed         | Passed         |
      | failed         | Failed         |
      | abandoned      | Abandoned      |
      | awaiting-human | Awaiting human |

  Scenario: The palette is the single definition
    Then Vue Flow node borders, Gantt bars, context-budget segments, gate chips, criteria rows
         and the version rail all read the same "--state-*" custom property
    And no component hardcodes a state colour as a Tailwind class or a hex value

  Scenario: An eighth state cannot be introduced silently
    Given a new node state is added to the domain model
    When the palette test enumerates the states from @karvan/core
    Then the test fails until "--state-<new>" is defined for both themes
```

**Notes:** *"roughly 8% of male engineers will otherwise misread the graph"* — colour + glyph + text
label, every time, is WCAG 1.4.1 and it is also simply better for a status board
([12 §9.2](../../12-frontend-architecture.md)). The reason the palette is CSS custom properties and
not Tailwind classes is that seven views then stay consistent by construction and dark mode works
because you redefine seven values, not because you audited nine views.

---

## EPIC-16-S4 — Driving the whole surface from the keyboard, with motion off

**Verifies:** KAR-16.1 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: Keyboard map and reduced motion (12 §9.4, 9.5)

  Scenario Outline: The map an operator uses for hours
    When the Operator presses "<key>"
    Then "<action>" happens

    Examples:
      | key     | action                                              |
      | j       | selection moves to the next node in the graph        |
      | k       | selection moves to the previous node                 |
      | Enter   | the node inspector opens for the selected node       |
      | ←       | the plan-version scrubber steps back one version     |
      | →       | the plan-version scrubber steps forward one version  |
      | /       | search receives focus                                |
      | Cmd-K   | the run/node jumper (shadcn "command") opens          |
      | Esc     | the topmost overlay closes, and only the topmost      |

  Scenario: The floor under all of it
    Then a skip-link reaches main content as the first focusable element
    And every interactive element shows a visible :focus-visible ring
    And the string "focus:outline-none" appears nowhere in the codebase

  Scenario: Reduced motion
    Given the browser reports "prefers-reduced-motion: reduce"
    Then the computed transition on ".vue-flow__node" is "none"
    And the scrubber steps without animating
    And every view remains fully usable — nothing waits on an animation to complete
```

**Notes:** for hours-long work this is the accessibility feature the author will personally use most
([12 §9.5](../../12-frontend-architecture.md)). `resizable` and `command` from shadcn-vue *"carry an
operator UI further than any amount of visual polish"* — they are taken, not built.

---

## EPIC-16-S5 — The initial chunk stays under budget

**Verifies:** KAR-16.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Bundle budget for NF3 (12 §10)

  Scenario: What is allowed in the first chunk
    When "vite build" completes
    Then the initial chunk is at most 200 KB gzip
    And "@vue-flow/core" IS in it, because the plan graph is the landing view
    And "elkjs" is NOT in it — it is a worker chunk, ~1.6 MB raw
    And the bundled "shiki" entry is NOT in it — only createHighlighterCore plus ~12 lazy languages
    And "@xterm/*" is NOT in it — the terminal view is a lazy route
    And "@git-diff-view/*" is NOT in it — the diff view is a lazy route
    And "echarts" is NOT in it — P1 only, lazy, cross-run dashboard route

  Scenario: The build config is written for Rolldown, not through the compat layer
    Then vite.config.ts uses "build.rolldownOptions", not "build.rollupOptions"
    And the build emits zero circular-import warnings

  Scenario: The budget is enforced, not documented
    Given a developer eagerly imports the diff view from the app shell
    When CI runs the bundle assertion
    Then the build fails, naming the module that grew the initial chunk
```

**Notes:** serving is local, so transfer time is near zero — **the budget is really about parse and
execute time** ([12 §10](../../12-frontend-architecture.md)). Measure with the 400-node stress fixture
through `karvan replay`, not with an empty run, or the number flatters you. Vite 8's `cssMinify`
defaults to Oxc; diff the built CSS once on the first upgrade.

---

## EPIC-16-S6 — Three run panels, one connection

**Verifies:** KAR-16.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Exactly one SSE connection per tab (11 §2)

  Scenario: Opening more panels does not open more connections
    Given the tab has one open stream subscribed to runs "r_a"
    When the Operator opens a panel for "r_b" and then one for "r_c"
    Then the client issues POST /api/stream/<streamId>/subscribe { "runs": ["r_a","r_b","r_c"] }
    And the daemon replies with the named event "subscribed" carrying the new run list
    And the number of open connections from this tab, counted server-side, is still 1
    And no reconnect occurred — the streamId is unchanged

  Scenario: The newly subscribed run is backfilled before live delivery
    Then the daemon sends every event for "r_b" with seq greater than the client's cursor
    And then sends the named event "caught_up" with { runId: "r_b", seq: <n> }
    And the client applies the backfill and the live frames in strictly increasing seq order

  Scenario: The idle global topic does not become a firehose
    Given a fourth panel subscribed with runs=*
    Then it receives only "run.created", "run.completed", "run.aborted" and "human.requested"
    And it receives zero "node.progress" frames from any run

  Scenario: The failure this prevents
    Given a hypothetical build that opened one EventSource per panel
    When four panels are open across two tabs
    Then the browser's ~6-connection-per-origin cap is exhausted
    And every subsequent fetch queues behind the streams indefinitely
    And the symptom reads as "the daemon hung" — which is why the design forbids it
```

**Notes:** HTTP/2 is not available here — browsers refuse h2c and shipping a certificate for
`127.0.0.1` is a worse problem than the one it solves, so `karvand` is HTTP/1.1 and the ~6-connection
cap is real ([11 §2](../../11-api-and-realtime.md)). The `SharedWorker` + `BroadcastChannel`
hardening that would reduce N tabs to one connection total is deliberately deferred until three-plus
tabs is a habit rather than a hypothetical.

---

## EPIC-16-S7 — The page reloads and `Last-Event-ID` is not sent

**Verifies:** KAR-16.2 · **Type:** Failure · **Automated at:** integration + e2e

```gherkin
Feature: The explicit hydrate path is mandatory (11 §4.1)

  Scenario: Reload mid-run
    Given the tab has applied up to seq 8200 and persisted that cursor
    When the Operator reloads the page
    Then the browser does NOT send a "Last-Event-ID" header, because it is sent only on the
         browser's own automatic reconnect of a previously-opened connection
    And the client opens GET /api/stream?runs=r_a&since=8200 from its own persisted cursor
    And the applied event set after the reload is identical to a tab that never reloaded

  Scenario: The developer case that bites hardest
    Given karvand is restarted while the tab is open
    And the tab's stream failed to open at all during the restart window
    When karvand comes back
    Then the reconnect carries no Last-Event-ID, because the connection never opened successfully
    And the client still supplies "?since=8200"
    And no event appended during the outage is missing from the UI

  Scenario: Server precedence
    Then the daemon resolves the cursor as: "?since=" first, "Last-Event-ID" second, head last
    And the query parameter wins because the client's own persisted cursor is more trustworthy
        than the browser's, and because the CLI has no Last-Event-ID mechanism at all

  Scenario: The regression this scenario exists to prevent
    Given a build that omits "?since=" and relies on Last-Event-ID
    When the page is reloaded mid-run
    Then the UI silently loses every event that occurred while it was down
    And it shows a plausible but wrong picture — a direct NF10 violation
    And this test must fail for that build
```

**Notes:** **Verified 2026-08-02.** The third bullet — a connection that never opened successfully —
is the common one in development, and it is the one that makes "it worked when I tested it" a
misleading signal. Note the client's cursor lives in `sessionStorage` (`cursor.ts`), so it is per-tab
and cannot be poisoned by another tab's position.

---

## EPIC-16-S8 — The connection drops mid-run and comes back with no seam

**Verifies:** KAR-16.2 · **Type:** Recovery · **Automated at:** integration + e2e

```gherkin
Feature: Resume by cursor, not by hope

  Scenario: A killed connection during a burst of events
    Given the replay harness is streaming "stress-400" at --speed 50x
    And the client has applied up to seq 5010
    When the connection is severed mid-burst
    Then the client reconnects using its own reconnection policy
    And the reconnect request carries "?since=5010" and, if the browser supplies it,
        "Last-Event-ID: 5010" in agreement
    And the applied seq sequence across the seam is strictly increasing
    And no event is applied twice and none is missing

  Scenario: The retry interval agrees on both sides
    Then the server wrote "retry: 2000" once, immediately after the headers
    And the client's configured reconnection policy agrees with it,
        so a native-EventSource fallback and the real client behave the same

  Scenario: The projections are unharmed by an overlapping replay
    Given the daemon resends two events the client had already applied
    Then the projections are byte-identical afterwards, because they are seq-guarded
```

**Notes:** this is Playwright smoke #4 from [14 §13](../../14-testing-strategy.md) — *"replay at
speed, kill the connection, assert the UI reconnects and backfills without a gap or a duplicate."*
It is one of only five E2E specs the project allows itself, and it earns its place because no
browser-mode component test can exercise a severed socket.

---

## EPIC-16-S9 — A gap in `seq` is a healthy log, not data loss

**Verifies:** KAR-16.2, KAR-16.3 · **Type:** Edge case · **Automated at:** unit + integration

```gherkin
Feature: The cursor contract is "strictly greater than", never "seq + 1" (11 §4.2)

  Scenario: Serving the crash-resume fixture
    Given "crash-resume.jsonl" contains seq values 4, 5, 7, 8, 12
    When the client applies all of them
    Then every event is applied in order
    And the UI shows no error, no warning banner and no "reconnecting" state
    And useRunStore.seq is 12

  Scenario: No gap detection exists
    Then no code path in packages/web compares an incoming seq to previousSeq + 1
    And no code path schedules a refetch because of a gap

  Scenario: Why the gaps are there
    Then seq 6 was allocated by a transaction that rolled back and burned the AUTOINCREMENT value
    And this is normal and healthy

  Scenario: The integrity check that IS allowed
    Then the client may compare its applied count against hello.headSeq for ORDERING
    And it must never compare for DENSITY
```

**Notes:** a client that treats a gap as a dropped event will report false data loss on a perfectly
correct stream and, worse, may try to "repair" by refetching from zero
([11 §4.2](../../11-api-and-realtime.md)). `AUTOINCREMENT` itself is mandatory for the opposite
reason: a bare `INTEGER PRIMARY KEY` reuses rowids after a delete, so the moment run retention ships,
every persisted cursor would point at a different event than the one it was written for — silently.
**Verified 2026-08-02.**

---

## EPIC-16-S10 — Control frames never reach the reducer

**Verifies:** KAR-16.2, KAR-16.3 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Named SSE events are stream control, not ledger events (11 §3.2)

  Scenario Outline: Control frames are routed away from applyEvent
    When a frame arrives with SSE event name "<event>"
    Then it is handled by handleControl
    And applyEvent is not called
    And every projection is deep-equal to its state before the frame

    Examples:
      | event      |
      | hello      |
      | subscribed |
      | caught_up  |
      | fatal      |

  Scenario: Ledger events use the default type and discriminate on payload kind
    When a frame arrives with no SSE event name and data {"seq":9001,"kind":"node.started",...}
    Then applyEvent is called exactly once
    And the discrimination was on the payload's "kind" field, not on the SSE event name

  Scenario: The regression this prevents
    Given a dispatcher that switches on the SSE event name before checking for a control frame
    When a "hello" frame arrives
    Then a projection would attempt to reduce a non-EventEnvelope
    And this test must fail for that build
```

**Notes:** the reason to keep exactly one `onmessage` handler feeding `applyEvent` is that it makes
the *"there is no other input"* claim in [12 §1](../../12-frontend-architecture.md) checkable by
reading one function. `hello.daemonEpoch` and `hello.build` are consumed by the connection layer and
never by a projection.

---

## EPIC-16-S11 — An old tab meets a newer daemon

**Verifies:** KAR-16.2, KAR-16.3 · **Type:** Edge case · **Automated at:** unit + integration

```gherkin
Feature: Unknown kinds are ignored, exactly as the backend reducer ignores them

  Scenario: A kind the UI build has never heard of
    Given the daemon appends an event with kind "node.telemetry.sampled" at seq 9100
    And this UI build's Event union has no such member
    When the frame arrives
    Then no projection throws
    And no projection is partially mutated
    And the cursor advances to 9100
    And the debug ring records the raw envelope, so it is visible in the inspector

  Scenario: Build skew is surfaced rather than guessed at
    Given hello.build differs from the build the tab was served from
    Then the UI shows an explicit "this tab is running an older build — reload" prompt
    And it does not silently continue rendering a partial picture

  Scenario: The compile-time half of the same guarantee
    Given a new event kind is added to the Event union in @karvan/core
    When "vue-tsc --noEmit" runs
    Then the projection whose exhaustive switch does not handle it fails to typecheck
    And this happens in the same commit that added the kind, because the import is type-only
```

**Notes:** ignoring unknown kinds is *"what lets a user run an older UI build against a newer daemon
without corruption"* ([11 §3.2](../../11-api-and-realtime.md)). The type-only import is what turns
the *other* direction — a kind the UI should have handled — into a compile error rather than a silent
omission. Both halves are needed; neither substitutes for the other.

---

## EPIC-16-S12 — The daemon restarted underneath the tab

**Verifies:** KAR-16.2 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: daemon_epoch fencing, observed from the client

  Scenario: A restart mid-run
    Given the tab's last hello carried daemonEpoch 7
    And karvand is killed with SIGKILL and restarted over the same .karvan/ directory
    When the client reconnects and receives a hello with daemonEpoch 8
    Then the UI surfaces an explicit "the daemon restarted" state
    And the client resumes from its own persisted cursor, not from head
    And the events the daemon appended during recovery replay are applied in order

  Scenario: The run is still the run
    Then no projection is reset
    And the node the run was executing before the crash shows its post-recovery state,
        which may be a resumed attempt or a typed failure — never a blank

  Scenario: An epoch mismatch on a write
    When the Operator submits a control action carrying a stale epoch
    Then the API returns 409 with code "epoch_mismatch"
    And the UI refreshes its cursor and re-renders rather than retrying blindly
```

**Notes:** `hello.daemonEpoch` is *how a client detects that the daemon restarted under it*
([11 §3.2](../../11-api-and-realtime.md)). The distinction that matters for the operator is that a
restart is not a new run: the ledger is the truth, the tab's cursor is still valid, and the only
thing that changed is which process is appending.

---

## EPIC-16-S13 — Fatal stream conditions, and which ones stop the retry loop

**Verifies:** KAR-16.2 · **Type:** Failure · **Automated at:** unit + integration

```gherkin
Feature: A stream never returns an error body mid-flight (11 §10)

  Scenario Outline: The fatal frame and the retry decision
    Given the stream is open
    When the daemon closes it with a final "event: fatal" frame carrying code "<code>"
    Then the client's behaviour is "<behaviour>"
    And the UI renders "<surface>"

    Examples:
      | code             | behaviour        | surface                                        |
      | bad_token        | stop retrying    | an explicit re-authenticate prompt              |
      | epoch_mismatch   | stop retrying    | a reload prompt naming the daemon restart       |
      | daemon_starting  | keep retrying    | a transient "waiting for karvand" state          |
      | internal         | keep retrying    | a transient reconnecting state                   |

  Scenario: The error envelope is closed and carries its ledger event
    Then the fatal frame's data matches { error: { code, message, detail, retryable, seq? } }
    And when the condition produced a ledger event, "seq" links the UI to the event that says so

  Scenario: Errors on the stream never look like ledger events
    Then the fatal frame is a NAMED event and is never passed to applyEvent
```

**Notes:** `code` is a stable identifier clients may branch on; `message` is for humans and may change
freely ([11 §10](../../11-api-and-realtime.md)). Carrying `seq` on the error is *NF10 applied to the
error path, which is exactly where auditability usually stops* — the UI can link "this failed" to
"here is the event that says so".

---

## EPIC-16-S14 — Fifteen idle minutes, and the events that arrive in a clump

**Verifies:** KAR-16.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Keepalive, and the buffering footgun

  Scenario: A long-running node that emits nothing for fifteen minutes
    Given a node is running a build that produces no control-plane events
    When fifteen minutes pass on the injected clock
    Then the client received a ": keepalive" comment approximately every 15 seconds
    And the client did not reconnect
    And no socket-inactivity timer anywhere in the path saw a silent connection

  Scenario: The diagnostic when events arrive in bursts
    Given a build where compression middleware was mounted globally
    When 20 events are appended one second apart
    Then the client's measured inter-arrival times cluster at the end of the stream
    And this test fails, naming compression on /api/stream as the cause
    And the tester is told NOT to look at the scheduler first

  Scenario: The dev-proxy variant of the same failure
    Then there is no Vite dev proxy in front of SSE at all, because Vite runs in middleware
         mode inside karvand (D10) — one process, one port
```

**Notes:** an SSE comment line is ignored by every client and costs 12 bytes; its job is to keep every
inactivity timer in the path quiet, and *"long-running Karvan nodes are routinely idle for minutes"*
([11 §3.2](../../11-api-and-realtime.md)). The burst symptom *"looks like a backend scheduling bug and
is not one"* — encoding that as a named scenario is how the afternoon it would otherwise cost gets
saved.

---

## EPIC-16-S15 — Projections are pure, and the suite proves it

**Verifies:** KAR-16.3 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: Projections are pure TypeScript with zero Vue imports (12 §3.3)

  Scenario: The purity rule is enforced, not documented
    When the lint rule over src/ledger/projections/** runs
    Then any import from "vue", "pinia" or a DOM global fails the build
    And the rule names the file and the offending import

  Scenario: The suite that this buys
    Given the seven projection modules and the six recorded fixtures
    When "pnpm vitest run --project unit" runs the projection suite
    Then it runs in Vitest's node environment with no DOM and no component mount
    And the whole projection suite completes in under two seconds
    And it is the largest single block of frontend tests — roughly 80% of the frontend test count

  Scenario: The shape of every projection
    Then each module exports a state interface and an "apply<Name>(s, e): void"
    And each switch returns silently on its default branch
    And no module reads a clock, performs I/O, or generates a random value
```

**Notes:** *"this is where the genuinely risky logic lives and it should be roughly 80% of the test
count"* ([12 §3.3](../../12-frontend-architecture.md)). The ratio is a design target, not an
observation — if the browser-mode suite grows past the projection suite, logic has leaked out of the
projections and into components, and the cost of every subsequent test goes up by two orders of
magnitude.

---

## EPIC-16-S16 — `plan.ts` over the happy path: seven states, labelled edges

**Verifies:** KAR-16.3 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: The plan projection (F10.1)

  Scenario: Reducing the happy-path fixture
    Given the recorded ledger "happy-path-12.jsonl"
    When applyPlan is folded over every envelope
    Then the node map contains exactly the nodes of the final PlanGraph version
    And every node's state is one of
        pending | running | blocked | passed | failed | abandoned | awaiting-human
    And no node's state is undefined
    And the final state matches the committed file snapshot under the normalising serializer

  Scenario: State transitions come from named events
    Then "node.scheduled" leaves the node pending and records provider, model and permission
    And "node.started" moves it to running and records binary path, version and sha256
    And "node.progress" updates the live phase WITHOUT changing the state
    And "node.completed" moves it to passed
    And "node.failed" moves it to failed and carries the typed NodeFailure reason
    And "node.suspended" with until.kind "human" moves it to awaiting-human

  Scenario: Edges carry what flows across them
    Given a data edge with carries ["finding/auth-uses-jwt"]
    Then the edge view-model exposes that label, so F10.1's "edges labelled with what flows"
         is a field rather than a guess

  Scenario: A node abandoned by a PlanPatch
    Given a "plan.patched" event whose patch marks "n_impl_2" abandoned
    Then the node's lifecycle is "abandoned" and it renders distinctly from "failed"
```

**Notes:** the seven states are PRD F10.1's own list and they are the same seven the CSS palette
defines — that alignment is deliberate and is what makes S3's enumeration test possible. Note that
`node.progress` is *cheap, frequent, and does not advance the progress watermark*
([04 §9](../../04-domain-model.md)); treating it as a state change makes the graph flicker.

---

## EPIC-16-S17 — `planHistory.ts`: the rail carries rejected patches too

**Verifies:** KAR-16.3 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: The version rail behind the scrubber (F10.2, F2.6)

  Scenario: Reducing the three-patches fixture
    Given the recorded ledger "three-patches.jsonl" containing an insert, a split and a
          provider-replace patch
    When applyPlanHistory is folded over it
    Then the rail contains four versions: v1 from "plan.proposed" and v2..v4 from "plan.patched"
    And each rail entry carries { version, seq, planHash, decision, reason }
    And each decision is one of auto | approved | rejected

  Scenario: A rejected proposal is still history
    Given a "plan.patch.proposed" followed by "plan.patch.rejected" with rule and by
    Then the rail records the proposal and its rejection
    And the plan version does NOT advance
    And the UI can answer "what was proposed and refused" as well as "what was applied"

  Scenario: Content hashes per node
    Then each node in each version carries a contentHash over type, provider, permission, brief,
         reads[], writes[] and retry policy
    And the hash uses ohash for stable key ordering — which JSON.stringify does not give you
    And the hash is used ONLY for change detection, never as an identity or a primary key

  Scenario: The seq index the scrubber needs
    Then the projection exposes planVersionSeq[N] for every version,
         because "show me version N" is replayTo(planVersionSeq[N])
```

**Notes:** ohash's README promises only *"best efforts"* at stable serialisation — **fine for a
change-detection hash and not fine for anything needing stability across versions**
([12 §6.2](../../12-frontend-architecture.md)). `planHash` itself is computed by the daemon with its
own canonical encoder ([04 §3](../../04-domain-model.md)); the UI never recomputes it.

---

## EPIC-16-S18 — `context.ts`: the compaction whose "after" does not exist

**Verifies:** KAR-16.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Compaction fidelity (F6.6, F10.5)

  Scenario Outline: Two fidelities, two honest renderings
    Given a "context.compacted" event with scope "<scope>" and fidelity "<fidelity>"
    When applyContext reduces it
    Then the projection's "after" value is <after>
    And droppedSegments has <dropped>
    And the chart contract for this mark is "<render>"

    Examples:
      | scope          | fidelity | after      | dropped      | render                          |
      | karvan.packet  | exact    | a number   | a populated list | before → after with the delta |
      | vendor.session | partial  | null       | an empty list    | the gap rendered AS a gap     |

  Scenario: The coercion that must not happen
    Then no code path writes "after ?? 0" or interpolates a missing post-count
    And a bar with a fabricated "after" number is treated as worse than an honest hole

  Scenario: Segment totals reconcile
    Given every "context.built" event in "happy-path-12.jsonl"
    Then for each packet, the sum of segments[].tokens.estimated equals totals.tokens
    And the per-kind sums equal totals.byKind for all nine SegmentKind values
    And the nine kinds are
        pinned.constraints, pinned.spec, pinned.pathscope, task.brief, fact,
        artifact.handle, retrieved, history.summary, tool.output

  Scenario: A pin that did not survive
    Given a "pin.integrity_violated" event carrying missingDigests and segmentIds
    Then the projection marks the node's packet as violated
    And the node's failure reason is "safety.pin-integrity-violated"
```

**Notes:** the reason `fidelity` exists at all is that Claude Code's `stream-json` emits
`{ type:'system', subtype:'compact_boundary', compact_metadata: { trigger, pre_tokens } }` —
`pre_tokens` only, no post count, no dropped list, no handle to the original. **Verified 2026-08-02.**
*"Encoding that uncertainty in the type is the difference between an auditable system and one that
quietly lies"* ([04 §9.1](../../04-domain-model.md)).

---

## EPIC-16-S19 — `gates.ts`: `unverifiable` and `needs-human` are not failures

**Verifies:** KAR-16.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Typed verdicts and criteria satisfaction (F7.3, F7.4, F10.8)

  Scenario: Reducing the gate-fail-repair fixture
    Given the recorded ledger "gate-fail-repair.jsonl"
    When applyGates is folded over it
    Then each "gate.evaluated" contributes a Verdict with outcome pass | fail | needs-human
    And each verdict's findings carry severity blocker | major | minor | info,
        an optional criterion id, an optional { file, line, endLine } location, and evidence handles
    And findings are indexable by file and ordered by line, so the diff surface can attach them

  Scenario: Three criterion states, not two
    Then a criterion's status is satisfied | unsatisfied | unverifiable
    And "unverifiable" is a distinct third state, never folded into unsatisfied
    And a criterion with no gate mapped to it surfaces as unverifiable — a spec defect,
        because F7.4 requires every criterion to map to at least one gate

  Scenario: needs-human is an outcome, not a failure mode
    Given a deterministic gate whose own tooling failed — a missing binary
    Then its verdict outcome is "needs-human", not "fail"
    And the projection does not route it into the repair loop's failure count

  Scenario: The repair loop is legible from the projection alone
    Then the fixture yields: attempt 1 failing, a surgical fix node, attempt 2 passing
    And the projection exposes the attempt sequence per evaluated node
```

**Notes:** conflating `needs-human` with `fail` *"sends work into the repair loop that no amount of
repair will fix"* ([04 §7](../../04-domain-model.md)). The `unverifiable` state is where a shallow
spec becomes visible — the SDD literature's primary failure mode, surfaced as data rather than as a
feeling.

---

## EPIC-16-S20 — `cost.ts`: vendor-reported and estimated are never mixed

**Verifies:** KAR-16.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Live cost accounting (F9.1)

  Scenario: Two sources, two accumulators
    Given "budget.consumed" events carrying TokenUsage with source "vendor-reported"
    And other events carrying source "estimated"
    When applyCost is folded over them
    Then the per-node, per-provider and per-run totals keep the two sources separable
    And every exposed total states which source it came from

  Scenario: Why they must not be summed silently
    Then estimated figures come from gpt-tokenizer's o200k_base encoding
    And they carry a known 15–20% undercount on Claude prose and worse on code
    And a budget ceiling computed from a silently-mixed number fires at the wrong time

  Scenario: An adapter that reports nothing at all
    Given a provider whose capability manifest declares tokenAccounting "none"
    Then the projection exposes the absence explicitly
    And the UI degrades honestly rather than displaying a fabricated zero

  Scenario: Ceilings and rate limits are events too
    Given "budget.exceeded" with { scope: "run", dimension: "cost", limit: 25, actual: 25.4 }
    Then the projection records that the run PAUSED — it did not fail
    And "provider.rate_limited" with a resetsAt is exposed for the timeline overlay
```

**Notes:** `source` is mandatory on `TokenUsage` and *"must never be silently mixed"*
([04 §8](../../04-domain-model.md)). A3 open risk A4-3 records that token accounting is unverified for
Copilot, Gemini/Antigravity, Cursor and OpenCode — only Claude Code and Codex were checked — so the
`'none'` branch is not hypothetical.

---

## EPIC-16-S21 — `timeline.ts`: the node that never finished

**Verifies:** KAR-16.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Execution spans for the Gantt (F10.9)

  Scenario: Spans from start/terminal pairs
    Given "node.started" and "node.completed" events for four parallel nodes
    When applyTimeline is folded over them
    Then each node yields one span with a start, an end and a lane
    And parallel nodes occupy distinct lanes so overlap is visible

  Scenario: A node still running
    Given a "node.started" with no terminal event yet
    Then the span is open-ended
    And no end time is invented — not "now", not the last event's ts

  Scenario: A node suspended for six hours on a human gate
    Given "node.suspended" with until { kind: "human" } followed six hours later by resumption
    Then the span records the suspension as a distinct segment
    And the Gantt can render it differently from execution time,
        because six idle hours and six busy hours cost very different things

  Scenario: Retries
    Given a node with attempt 1 failed and attempt 2 passed
    Then the projection yields two spans keyed by (nodeId, attempt), not one merged span

  Scenario: The cost series
    Then "budget.consumed" events accumulate into a cumulative series the second axis renders
```

**Notes:** ordering is by `seq`, never by `ts` — `ts` is informational only
([04 §9](../../04-domain-model.md)), and a laptop sleep or an NTP correction can move it backwards.
The Gantt's x-axis is wall clock and therefore uses `ts`, but any *ordering* decision in the
projection uses `seq`.

---

## EPIC-16-S22 — `blackboard.ts`: provenance, consumers and taint

**Verifies:** KAR-16.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Memory sharing as data (F6.3, F10.4)

  Scenario: Facts with provenance
    Given "fact.written" events carrying a Fact with provenance
    When applyBlackboard is folded over them
    Then each fact records which node wrote it, from which evidence handles, at which time,
         and at what confidence

  Scenario: The consumer set is one query, not an inference
    Given "fact.read" events naming factId and the reading node
    Then each fact exposes its complete consumer set
    And this is why fact.read exists as an event at all — it makes memory sharing renderable

  Scenario: Invalidation taints downstream
    Given "fact.invalidated" with { factId, by, reason, taints: ["n_impl_3","n_review_1"] }
    Then the fact is marked invalid with its reason
    And every node in taints[] is flagged as consuming a fact that later proved wrong

  Scenario: Aggregation is a projection concern, not a rendering one
    Then the projection exposes facts grouped by producing node with a per-node count
    And that grouping — not raw facts — is what the memory graph renders by default
```

**Notes:** this projection is built even though KAR-17.9 may slip to M2. The roadmap is explicit that
*"nothing is lost by deferring it — `fact.written` and `fact.read` are ledger events regardless. The
data accrues from day one; only the rendering slips"* ([roadmap §3](../../17-roadmap.md)). The
provenance table inside the node inspector (KAR-17.3) consumes this projection directly.

---

## EPIC-16-S23 — The same event applied twice changes nothing

**Verifies:** KAR-16.3 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Projection idempotency

  Scenario Outline: Double-apply is a no-op
    Given projection "<module>" reduced over a fixture
    When the last envelope is applied a second time
    Then the projection state is deep-equal to its state before the second apply

    Examples:
      | module        |
      | plan          |
      | planHistory   |
      | blackboard    |
      | context       |
      | gates         |
      | cost          |
      | timeline      |

  Scenario: The one that fails naively
    Given cost.ts implemented as "total += e.payload.costUsd"
    When the same budget.consumed envelope is applied twice
    Then the total is wrong by exactly one event's cost
    And this test must fail for that implementation

  Scenario: Why it matters in production and not only in tests
    Then subscribe-backfill can legitimately resend events at or below the client's cursor
    And a reconnect race can redeliver a frame
    And neither may corrupt a number the Operator is about to make a decision on
```

**Notes:** the fix is a per-projection seq guard, not a global dedupe set — a global set is unbounded
memory, which is exactly what KAR-16.4 exists to prevent. Guard on the highest applied `seq` per
projection and drop anything at or below it.

---

## EPIC-16-S24 — Subscribe-backfill overlaps the cursor

**Verifies:** KAR-16.2, KAR-16.3 · **Type:** Concurrency · **Automated at:** integration

```gherkin
Feature: Adding a run panel while events are arriving

  Scenario: A subscribe issued mid-burst
    Given the tab is subscribed to "r_a" and applying events at 200/s
    When the Operator opens a panel for "r_b" and the client posts subscribe
    Then the daemon backfills "r_b" from the client's current cursor
    And frames for "r_a" continue to arrive interleaved with the backfill
    And the client applies both by seq order per run, routed by e.runId
    And the projections for "r_a" are unaffected by "r_b" traffic

  Scenario: The overlap window
    Given the daemon's backfill range includes two events the client already applied
    Then the projections are byte-identical after the duplicates
    And no error is surfaced

  Scenario: caught_up marks the boundary
    Then the client receives caught_up { runId: "r_b", seq } and only then treats "r_b" as live
    And a UI that shows "hydrating" per run flips that run's indicator on this frame
```

**Notes:** the fan-out is by `e.runId` in one dispatcher, not by one connection per run
([11 §2](../../11-api-and-realtime.md)). This scenario is where S23's idempotency requirement stops
being theoretical: the overlap is a designed-in property of the subscribe path, not an error case.

---

## EPIC-16-S25 — Apply and drop: the raw event array is not retained

**Verifies:** KAR-16.4 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: Browser memory over a multi-hour run (12 §5.1)

  Scenario: The store applies and drops
    Given the run store has applied 10,000 envelopes
    Then the debug ring holds exactly 2,000
    And no other structure holds a reference to any envelope
    And a WeakRef to an envelope the ring has rolled past is collectable after a forced GC

  Scenario: The ring is bounded and ordered
    Then the ring's length never exceeds its cap regardless of how many events were applied
    And its oldest entry's seq advances monotonically
    And it is a fixed-size circular buffer, not an array with .shift()

  Scenario: The ring's purpose
    Then the debug/inspector pane reads from the ring
    And clicking a token count in the node inspector jumps the ring to the context.built event
        that produced it — which is NF10 made visible

  Scenario: The failure this prevents
    Given a build that retains every envelope "for the inspector"
    Then there is no visible symptom for the first three hours
    And the tab dies at hour four of a real run
    And this test must fail for that build
```

**Notes:** *"unbounded retention has no visible symptom until the tab dies at hour four of a real
run"* ([12 §5.1](../../12-frontend-architecture.md)) — which is why the assertion is a `WeakRef` test
rather than a code review item. Note the ring cap is a constant the dev assertion in S30 reports, so
raising it is visible rather than quiet.

---

## EPIC-16-S26 — Agent output goes to the terminal buffer and nowhere else

**Verifies:** KAR-16.4 · **Type:** Edge case · **Automated at:** unit + integration

```gherkin
Feature: Cap unbounded per-node collections (12 §5.2)

  Scenario: Where node.progress and stdout are allowed to live
    Given 50,000 node.progress events and a live io_chunk stream for one node
    Then the terminal's xterm buffer holds them, capped at scrollback 5000
    And NO store array accumulates them
    And the store's per-node object count is a function of node count, not of event count

  Scenario: The tempting mistake
    Given a build that also pushes progress payloads into a store array "just for the inspector"
    When the soak runs
    Then store memory grows linearly with run duration
    And this test must fail for that build

  Scenario: What is naturally bounded and therefore fine to keep
    Then findings, facts, verdicts, packets and plan versions are bounded by the plan and are kept
    And agent output is not bounded and is not kept

  Scenario: The archive is on disk, not in the tab
    Then the full log lives at runs/<runId>/nodes/<nodeId>/stdout.log (NF8)
    And the browser asks for the last N KB via GET /api/runs/:id/nodes/:nodeId/io — never the file
```

**Notes:** the arithmetic behind the 5,000-line cap is in KAR-17.5, but the store-side rule belongs
here because it is what makes the terminal's cap sufficient: if the store *also* holds the output,
capping xterm achieves nothing. `io_chunk` is the data plane and never rides the control-plane stream
([11 §5.1](../../11-api-and-realtime.md)).

---

## EPIC-16-S27 — Six hours at `--speed max` and the tab is still alive

**Verifies:** KAR-16.4 · **Type:** Edge case · **Automated at:** integration (scheduled, not per-push)

```gherkin
Feature: The soak that proves the memory rules

  Scenario: A six-hour replay of the stress fixture
    Given "karvan replay fixtures/stress-400.jsonl --speed max" looping for six hours
    And the tab open with the plan graph, timeline and inspector mounted
    When the soak completes
    Then JS heap growth across the final four measured hours is within the recorded ceiling
    And projection object counts are bounded by node count and fact count, not by event count
    And the debug ring length is exactly its cap
    And the count of undisposed xterm Terminal instances is zero
    And the UI remains interactive: a node click still opens the inspector within the NF3 budget

  Scenario: What a failure looks like and how it is diagnosed
    Given the soak fails on heap growth
    Then the dev-only 60-second counter log identifies which collection grew
    And the four candidates are, in order of likelihood:
        the raw event array, a per-node progress array, undisposed terminals, and ELK inputs
        held by a Vue proxy

  Scenario: Cadence
    Then this runs on a schedule, not on every push, because it costs six hours
    And a per-push proxy for it is a ten-minute run at --speed max with the same assertions
```

**Notes:** *"this is what will actually kill the tab, and no library solves it"*
([12 §5](../../12-frontend-architecture.md)). All four rules are cheap on day one and miserable to
retrofit, which is why the soak exists in this epic rather than after EPIC-17 has built nine views on
top of an unbounded store.

---

## EPIC-16-S28 — No Vue proxy reaches Vue Flow, ELK or xterm

**Verifies:** KAR-16.4 · **Type:** Failure · **Automated at:** unit + browser

```gherkin
Feature: shallowRef and markRaw (12 §4)

  Scenario: The containers are shallow
    Then every projection container in useRunStore is a shallowRef
    And isReactive(plan.value) is false
    And Vue tracks one reference rather than walking thousands of objects installing proxies

  Scenario: Mutate in place, then bump
    Given a node.progress event for one node in a 400-node graph
    Then the projection mutates the underlying Map entry in place
    And an integer version ref is incremented
    And the computed that derives the view array reads that counter
    And no 400-entry array is reassigned

  Scenario Outline: Nothing handed to a foreign library is a proxy
    When the store hands "<payload>" to "<library>"
    Then isProxy(payload) is false

    Examples:
      | payload            | library      |
      | node objects       | Vue Flow     |
      | the graph input    | ELK worker   |
      | the Terminal       | xterm.js     |
      | scale objects      | d3           |

  Scenario: The bug class this avoids
    Then a Vue proxy around an object a foreign library holds identity comparisons on
         is very hard to see and very easy to avoid
```

**Notes:** rule 3 is the one people get backwards — *"reassigning a 2,000-entry array on every
`node.progress` event is worse than the deep reactivity you were avoiding"*
([12 §4](../../12-frontend-architecture.md)). Also note the forward risk: these characteristics may
shift under Vue 3.6's alien-signals rewrite, so S27's soak is re-run, not assumed, whenever the Vue
pin moves.

---

## EPIC-16-S29 — Scrubbing hydrates from a snapshot, never from `seq` 0

**Verifies:** KAR-16.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Server-side snapshots (12 §5.3, 11 §7.3)

  Scenario: Scrubbing to an early plan version on a long run
    Given a run with 10,000 control-plane events and plan versions v1..v6
    And planVersionSeq[2] is 1840
    When the Operator scrubs to v2
    Then the client calls GET /api/runs/:id/snapshot?seq=1840
    And it replays forward from the returned state only
    And ZERO events with seq below 1840 are applied in the browser

  Scenario: Why the server does it
    Then SQLite reduced 10,000 control-plane events to state in 29 ms — verified 2026-08-02
    And JavaScript replaying the same events would freeze the tab on a multi-hour run

  Scenario: seq=head as an alias
    When the Operator scrubs back to live
    Then the client may call snapshot?seq=head and resume streaming from the returned seq

  Scenario: The regression this prevents
    Given a build that replays from zero in the browser to scrub
    When the scrub happens on a 10,000-event run
    Then the tab blocks for seconds
    And this test must fail for that build
```

**Notes:** *"the reason this exists is browser memory, not server convenience"*
([11 §7.3](../../11-api-and-realtime.md)). This is also the mechanism the marquee scrubber
(KAR-17.2) is built on, which is why it is proven here — before a view depends on it — rather than
discovered during EPIC-17.

---

## EPIC-16-S30 — The leak assertion that fires in dev and is absent in production

**Verifies:** KAR-16.4 · **Type:** Edge case · **Automated at:** unit + integration

```gherkin
Feature: The dev-only projection counter (12 §5.4)

  Scenario: It fires every sixty seconds in dev
    Given the app running with import.meta.env.DEV true
    When sixty seconds pass on the injected clock
    Then console.debug is called with tag "[proj]" and
         { nodes, facts, events, terminals } counts

  Scenario: It is not in the production bundle
    When "vite build" completes
    Then the built output contains no occurrence of the "[proj]" tag
    And no 60-second interval is registered in production

  Scenario: What it is for
    Then the Operator finds the leak in week one instead of in hour four of a run they cared about
    And the four counters correspond exactly to the four collections S27 names as suspects
```

**Notes:** this is a two-line feature with an outsized payoff, and it is in the acceptance criteria
precisely because it is the kind of thing that gets cut as unnecessary and then reinvented under
pressure at hour four.

---

## EPIC-16-S31 — The UI cannot tell a replay from a live run

**Verifies:** KAR-16.5 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: karvan replay serves the normal contract (03 §6.2)

  Scenario: Booting the harness
    When the Operator runs "karvan replay fixtures/three-patches.jsonl --speed 20x --port 7777"
    Then GET /api/stream, /api/runs/:id/events, /api/runs/:id/snapshot, /api/runs/:id/plans,
         /api/runs/:id/plans/diff, /api/runs/:id/nodes/:nodeId, /api/runs/:id/gates,
         /api/runs/:id/criteria and /api/runs/:id/diff all respond
    And their response shapes are byte-identical to a live daemon's, modulo the normalising
        serializer

  Scenario: The UI contains no replay branch
    Then a grep of packages/web/src for any replay-related identifier returns nothing
    And there is no "if (isReplay)" anywhere in the frontend

  Scenario: The stream contract is the same contract
    Then frames carry "id: <seq>"
    And the first frame is hello { streamId, apiVersion, build, daemonEpoch, headSeq }
    And "retry: 2000" is written once
    And ": keepalive" arrives every 15 seconds

  Scenario: Auth is not bypassed because it is "only dev"
    Then an unauthenticated GET /api/runs returns 401 missing_token
    And a request with a foreign Origin returns 403 bad_origin
    And GET /api/health remains the only unauthenticated route
```

**Notes:** *"the UI cannot tell the difference, because there is no difference: the browser is a
projection of an event stream either way"* ([03 §6.2](../../03-local-development.md)). The auth
scenario is not pedantry — a harness that skips auth is a harness that lets an auth regression ship,
because the harness is what most development runs against.

---

## EPIC-16-S32 — The six fixtures and what each one proves

**Verifies:** KAR-16.5 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The replay corpus (14 §12)

  Scenario Outline: Each fixture serves its views
    Given the fixture "<fixture>"
    When it is served by the replay harness
    Then it contains "<contents>"
    And it is the fixture used to develop and test "<views>"

    Examples:
      | fixture              | contents                                                            | views                                        |
      | happy-path-12        | a small run, all nodes pass, one gate, one worktree merged           | plan graph, timeline, node inspector          |
      | three-patches        | insert, split and provider-replace, each with a reason and decision  | plan-evolution scrubber (F10.2)               |
      | gate-fail-repair     | a failing gate, a surgical fix node, a second attempt, a pass        | criteria board, repair loop, inline verdicts  |
      | compaction           | both fidelities: exact karvan.packet and vendor.session with after null | context budget (F10.5)                     |
      | crash-resume         | a ledger whose seq values jump, as a real SIGKILL produces           | resume, hydrate, "did the UI notice?"          |
      | stress-400           | a wide map fan-out to 400 nodes                                     | render budget, ELK layout time, scrubber       |

  Scenario: Each fixture is one file per run
    Then the production ledger is one global database
    But a fixture is exported per run, so a whole run commits as a single file

  Scenario: The corpus does not rot silently
    Given the Event union changes
    When CI regenerates one fixture from its recorded mock-agent script
    Then the check fails if the shape drifts from the committed copy
```

**Notes:** the corpus is the reason this epic can hand EPIC-17 nine views' worth of data on day one.
Note `compaction` must contain **both** fidelities: without the `vendor.session` case the honest-gap
rendering in KAR-17.4 has nothing to be tested against, and it is exactly the case that will occur in
real runs against Claude Code.

---

## EPIC-16-S33 — Speed control, pause and seek

**Verifies:** KAR-16.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Playback control

  Scenario Outline: Speed
    Given the harness serving a fixture whose recorded events span 40 minutes
    When it is served at "<speed>"
    Then the emission schedule is "<schedule>"

    Examples:
      | speed | schedule                                                        |
      | 1x    | recorded inter-event delays reproduced within the stated tolerance |
      | 20x   | delays divided by 20                                             |
      | 50x   | delays divided by 50                                             |
      | max   | as fast as the socket drains, with no artificial delay            |

  Scenario: Pause and seek
    When playback is paused
    Then no further frames are emitted and the connection stays open with keepalives
    When playback seeks to seq 4000
    Then the client is expected to re-hydrate from the snapshot endpoint at that seq
    And the harness resumes emission from seq 4001

  Scenario: The dev loop
    Then "pnpm dev:replay" runs the happy path under node --watch
    And a source edit reloads without restarting the browser session
    And "karvan replay fixtures/gate-fail-repair.jsonl --speed 50x" jumps straight to a failed gate
```

**Notes:** *"do not wait for a run to reach the state you want to style"*
([03 §6.2](../../03-local-development.md)). `--speed max` is what makes the six-hour soak in S27 and
the graph measurement in S36 practical at all.

---

## EPIC-16-S34 — Fixtures are recorded, never hand-written

**Verifies:** KAR-16.5 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Fixture provenance

  Scenario: Every fixture names what produced it
    Then each fixture has a provenance note recording the mock-agent script and the --seed used
    And regenerating it with the same seed produces the same events modulo the normalising
        serializer

  Scenario: Why hand-writing is forbidden
    Then a hand-written fixture encodes the author's assumptions about the event stream
         rather than its actual shape
    And it rots silently as the emitters change
    And no test catches the drift, because the fixture IS the expectation

  Scenario: The dependency this creates, stated honestly
    Given fixtures must come from real runs
    Then at least one full run must complete headlessly through "karvan run" first
    And this epic's KAR-16.5 depends on EPIC-18 KAR-18.3 for that reason
    And the acceptable interim is recording from the orchestrator's own test harness
         driving the mock agent — never hand-writing
```

**Notes:** [roadmap §2.1](../../17-roadmap.md) makes this a sequencing rule, not a preference: *"do
not start W11 until at least one full run completes headlessly through W12's CLI. A run you can drive
from the terminal is a run you can build a fixture from, and the replay-fixture harness is the main
structural defence against the view work sprawling."*

---

## EPIC-16-S35 — Nothing reaches past the graph facade

**Verifies:** KAR-16.6 · **Type:** Failure · **Automated at:** unit + e2e

```gherkin
Feature: GraphCanvas is the only Vue Flow importer (12 §6.1)

  Scenario: The rule
    Then "src/components/graph/GraphCanvas.vue" is the only file importing "@vue-flow/core"
    And a lint rule fails the build on any other importer, naming the file
    And GraphCanvas's exported props are Karvan types:
        { nodes: PlanNodeVM[]; edges: PlanEdgeVM[]; selected?: NodeId }
    And no Vue Flow type appears in its public surface

  Scenario: The swap is provably one file
    Given a spike branch replacing GraphCanvas's internals with a stub renderer
    When the app is built
    Then every consuming view still compiles
    And every consuming view still renders its nodes through the node slot

  Scenario: Why the facade exists
    Then Vue Flow is the single largest third-party risk in the frontend:
         last npm release 2026-01-28, effectively one maintainer, an unreleased next-release
         branch, no announced v2, and no Vue 3.6 compatibility statement
    And the facade costs about a day
    And it also lets the memory graph swap to sigma + graphology without touching the plan graph
```

**Notes:** A3-1, rated **High**. [Roadmap §2.3](../../17-roadmap.md): *"wrap Vue Flow behind a
`GraphCanvas` facade on day one of W10. One day of work against the largest single third-party risk
in the frontend."* The escape hatches if the ceiling is hit are `sigma@^3.0.3` + `graphology@^0.26.0`
(comfortable into the tens of thousands) or `@cosmograph/cosmos@^3.4.1` for GPU force layout.

---

## EPIC-16-S36 — 400 nodes, measured in week one

**Verifies:** KAR-16.6 · **Type:** Edge case · **Automated at:** e2e

```gherkin
Feature: Replacing an extrapolation with a measurement (A3-2)

  Scenario: The measurement run
    Given "karvan replay fixtures/stress-400.jsonl --speed max"
    And headless Chromium
    When "pnpm measure:graph" runs
    Then it records: ELK layout time off the main thread, time to first paint of the full graph,
         median frame time during a scripted pan, and p95 frame time during a scripted zoom
    And it records all four both with and without onlyRenderVisibleElements
    And it writes docs/measurements/vue-flow-400.md naming the machine, the Chromium build,
        the date and the exact command to reproduce it

  Scenario: The claim being replaced
    Then the architecture's ~300–500 smooth / 500–1,500 with culling / stalls past ~2,000 figures
         are an ESTIMATE extrapolated from React Flow guidance and the identical
         one-DOM-subtree-per-node architecture
    And no official Vue Flow benchmark exists
    And after this scenario, this project has its own number

  Scenario: The number is enforced, not filed
    Then CI asserts p95 frame time against the recorded budget at a tolerance wide enough
         not to be flaky
    And a regression fails the build; jitter does not

  Scenario: What the number decides
    Given the measured smooth ceiling is below roughly 300 nodes
    Then onlyRenderVisibleElements becomes the default for the plan graph
    And KAR-17.9's memory graph slips to M2 per roadmap §3
    And that decision is recorded in the measurement file rather than in someone's memory
```

**Notes:** [roadmap §2.3](../../17-roadmap.md) — *"measure Vue Flow in week one of W10, not week four
of W11 … that number decides §3."* Re-run the measurement when the Vue pin moves: 3.6's reactivity
rewrite could shift it either way, and Vue Flow's store leans hard on the internals 3.6 rewrites.

---

## EPIC-16-S37 — ELK in a worker, in the built output

**Verifies:** KAR-16.6 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: elkjs off the main thread under Vite 8 (A3-4)

  Scenario: The built artefact, not just the dev server
    When "vite build" completes and the daemon serves dist/
    Then the ELK worker chunk is emitted and hashed correctly
    And elkjs (~1.6 MB raw) is absent from the initial chunk
    And laying out a 60-node graph happens off the main thread from the BUILT output

  Scenario: The wiring
    Then src/graph/elk.worker.ts imports 'elkjs/lib/elk-worker.min.js'
    And layout.ts uses Vite's "?worker" import with ELK's workerFactory
    And elkjs's own documented "workerUrl" option is NOT used,
        because it assumes a publicly-served path that does not survive Vite's asset hashing

  Scenario: The fallback, if it resists
    Given M0-S3 concluded the worker path is not viable
    Then "@dagrejs/dagre@^3.0.0" drives the live graph
    And ELK runs on the main thread for cached scrubber layouts only, where a slower call is fine
    And that choice is recorded in docs/measurements/vue-flow-400.md

  Scenario: The dead package
    Then unscoped "dagre" is never installed — it last shipped 2019-12-03
    And the claim that the Vue Flow docs forbid it is false: the docs import @dagrejs/dagre
    And note the docs' repl pins @dagrejs/dagre@1.1.2, two majors behind 3.0.0
```

**Notes:** elkjs is GWT-transpiled Java and its own README acknowledges bundler friction; the wiring
in [12 §6.1](../../12-frontend-architecture.md) is marked **Unverified** and is M0-S3's job to settle
before this epic starts. A `vite build` — not just `vite dev` — is the success criterion, because the
failure mode is specifically an asset-path one.

---

## EPIC-16-S38 — Adding a node does not reshuffle the graph

**Verifies:** KAR-16.6 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Layout stability, the cheap way (12 §6.1)

  Scenario: The cheapest stability lever
    Given the ELK options set org.eclipse.elk.layered.considerModelOrder.strategy
          to "NODES_AND_EDGES"
    And the node array is fed to ELK in ledger-insertion order, which plan.ts already has
    When a node is inserted into a 60-node graph and the layout is recomputed
    Then the relative ordering of the pre-existing nodes is unchanged
    And the assertion is on ORDERING, not on exact pixel coordinates

  Scenario: No per-node constraints are needed for this
    Then ELK keeps relative ordering across plan versions with no per-node constraint at all

  Scenario: What is explicitly NOT relied on
    Then layerChoiceConstraint and positionChoiceConstraint are NOT used as the mechanism
    And the reason is recorded: those options are consumed only when
        org.eclipse.elk.interactiveLayout is true, "semiInteractive" reads org.eclipse.elk.position
        rather than positionChoiceConstraint, and constraint enforcement is a known elkjs weak spot
    And they remain an experiment, not the design
```

**Notes:** A3-5. This scenario is the *cheap* stability mechanism for the live graph; the *marquee*
stability mechanism for the scrubber is the union-graph layout computed once and cached, which is
KAR-17.2's business. Both exist because reflow between versions destroys the one thing the scrubber
is for.

---

## EPIC-16-S39 — The node animation you must not write

**Verifies:** KAR-16.6 · **Type:** Failure · **Automated at:** browser

```gherkin
Feature: Node motion (12 §6.1, corrected)

  Scenario: The only animation allowed
    Then the stylesheet contains ".vue-flow__node { transition: transform 200ms ease-out; }"
    And no code writes a transform on a node element

  Scenario: The bug this prevents
    Given a build that authors its own translate3d transitions on nodes
    Then Vue Flow writes an inline "transform" on ".vue-flow__node" and overwrites them
    And the animation appears to work sometimes and not others
    And this test must fail for that build

  Scenario: Disabling it where it hurts
    When a node is being dragged
    Then the transition is disabled, or dragging feels like it is fighting you
    When the viewport is panning or zooming
    Then the transition is disabled
    When prefers-reduced-motion is reduce
    Then the transition is none
```

**Notes:** this is one of the corrected claims in [12 §6.1](../../12-frontend-architecture.md) — the
obvious approach is wrong in a way that produces intermittent rather than total failure, which is the
worst kind to diagnose.

---

## EPIC-16-S40 — The graph is reachable from the keyboard and by a screen reader

**Verifies:** KAR-16.6 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: What Vue Flow gives free, and must not be undone (12 §9.3)

  Scenario: The accessibility already in the bundle
    Then aria-live, aria-label, aria-describedby, aria-roledescription and useKeyPress keyboard
         navigation are present in @vue-flow/core@1.48.2 — verified in the bundle
    And "disableKeyboardA11y" is NOT set anywhere

  Scenario: The one line that carries most of it
    Then every node's ariaLabel is set from the view-model as
         "${node.type} ${node.title}, ${node.state}, ${node.provider}"
    And that is most of what a screen reader needs from a DAG

  Scenario: Keyboard traversal through the facade
    When the Operator presses Tab into the canvas and then j / k
    Then selection moves between nodes and the selected node is announced
    And Enter opens the inspector for it

  Scenario: The escape route for a non-visual reader
    Then the graph's SVG carries a <title> and an aria-label
    And a toggleable data-table view lists nodes with their state, provider and cost
    And that table doubles as the copy-into-a-PR-description surface
```

**Notes:** *"do not set `disableKeyboardA11y`"* is a direct instruction from
[12 §9.3](../../12-frontend-architecture.md), and the temptation to set it is real — it is the
quickest way to stop key handlers conflicting with a custom keymap. Resolve the conflict in the
keymap instead.

---

**Related:** [EPIC-16](../epics/EPIC-16-ui-foundation.md) ·
[Frontend architecture](../../12-frontend-architecture.md) ·
[API and realtime](../../11-api-and-realtime.md) ·
[Testing strategy](../../14-testing-strategy.md) ·
[Local development](../../03-local-development.md) ·
[P0 views flows](./EPIC-17-p0-views-flows.md) · [Board](../board.md)

[← Back to the delivery plan](../README.md)
