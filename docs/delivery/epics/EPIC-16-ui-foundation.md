# EPIC-16: Web UI foundation and projection store

> Part of the [Karvan delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-16-ui-foundation-flows.md)

| | |
|---|---|
| **Epic ID** | EPIC-16 |
| **Status** | Not started |
| **Priority** | P0 |
| **Milestone** | M1 |
| **Workstream** | W10 (see [roadmap §2.2](../../17-roadmap.md)) |
| **Size** | ~20 days across 6 stories — **over the 15-day guideline, see Risks** |
| **Depends on** | EPIC-15 (the SSE contract, the snapshot endpoint and the typed client), EPIC-02 (the `Event` union, imported type-only), EPIC-00 S3 and S4 (elkjs in a Vite 8 worker; SSE and HMR on one port) |
| **Blocks** | EPIC-17 (all nine views) |
| **PRD requirements** | F4.1, F10.10, NF3, NF10, and the shell of F10.1 |
| **Architecture** | [12-frontend-architecture.md](../../12-frontend-architecture.md) §1–§5, §6.1, §9, §10, §11 · [11-api-and-realtime.md](../../11-api-and-realtime.md) §2–§5, §7.3, §8 · [14-testing-strategy.md](../../14-testing-strategy.md) §12, §13 · [03-local-development.md](../../03-local-development.md) §6.2 |

## Goal

At the end of this epic there is a Vue 3 application that is **a second reducer over the same
ledger the daemon reduces** — not a REST client that renders view models someone else computed. One
SSE connection per tab feeds a dispatcher; the dispatcher feeds seven pure projection modules with
zero Vue imports; a thin Pinia shell owns reactivity and nothing else; and the whole thing survives
a multi-hour run without the tab dying, because raw events are applied and dropped rather than
retained. Alongside it there is `karvan replay`, which serves the *normal* API and SSE contract from
a recorded ledger, so every view in EPIC-17 is developable offline with no credentials, no child
processes, no quota and no three-hour wait. And there is a number — a real measurement of the graph
renderer against a 400-node stress fixture — where the architecture currently has an estimate.

No view ships in this epic. What ships is the substrate all nine views stand on, plus the
development loop that makes building them cheap.

## Why this matters

The PRD treats visualisation as a primary product surface with equal weight to execution (§7.10),
and names *median time-to-diagnose a failed run under five minutes* as the metric that decides
whether it worked (§12). Neither is reachable from a UI built the ordinary way, for a reason that is
structural rather than aesthetic:

**NF10 says any state in the UI is traceable to specific ledger events.** If the UI is a fetch cache
over server-computed view models, that claim is unprovable — the thing on screen came out of a merged
cache entry, and there is no event to point at. If the UI applies the same event vocabulary the
backend applies, it becomes *impossible to render something that did not come from an event, because
there is no other input* ([12 §1](../../12-frontend-architecture.md)). NF10 stops being aspirational
and becomes structural.

Two of the P0 views fall out of that property for free and would each otherwise be a bespoke
subsystem: the plan-evolution scrubber (F10.2) is `replayTo(planVersionSeq[N])`, and run replay
(F10.10) is feeding the same reducers at a chosen rate. Getting the store wrong is therefore not one
bad file — [12 §3](../../12-frontend-architecture.md) calls it *"the load-bearing frontend
decision. Get it wrong and every subsequent view fights it."*

Three things break concretely if this epic is skipped or done casually:

- **The tab dies at hour four.** Not at hour one, and with no visible symptom before then. Unbounded
  event retention, uncapped per-node arrays and undisposed `Terminal` objects each kill a long run,
  and all three are cheap on day one and miserable to retrofit ([12 §5](../../12-frontend-architecture.md)).
- **Every view is built twice.** The roadmap is explicit: *"a view built against a hand-rolled
  fixture will be rebuilt against the real stream"* ([roadmap §2.1](../../17-roadmap.md)). The replay
  harness is what makes the fixture *be* the production format, so there is no fixture-maintenance
  tax and no drift.
- **The renderer's ceiling is discovered in week four of EPIC-17 instead of week one of this epic.**
  The 300–500-node smooth band is an **estimate extrapolated from React Flow guidance**, not a
  measured or published Vue Flow number — A3-2, rated **High** in the open-risks register. That
  measurement gates whether KAR-17.9 ships at all.

## Scope

**In scope:**

- The `@karvan/web` package: Vue 3.5.40 SPA, `vue-router@5`, Pinia 4, Vite 8 with Rolldown, Tailwind
  4 CSS-first, `shadcn-vue` vendored components on `reka-ui`, served by `karvand` on
  `http://127.0.0.1:7777` — one origin, no proxy, no CORS.
- The bootstrap token handoff: read `#token=` from the fragment once, store in `sessionStorage`,
  strip with `history.replaceState`, send as an `Authorization: Bearer` header thereafter.
- The seven node-state CSS custom properties, both themes, and the colour + glyph + text-label rule.
- The single SSE connection per tab on `eventsource-client`, the `hello` / `subscribed` /
  `caught_up` control frames, `?since=` hydration, cursor persistence, filter mutation without
  reconnect, and the reconnect/backfill/duplicate story.
- `ledger/apply.ts` — the dispatcher — and the seven pure projection modules in
  `ledger/projections/`: `plan`, `planHistory`, `blackboard`, `context`, `gates`, `cost`, `timeline`.
- `useRunStore` (projection containers, reactivity, view-model derivation) and `useUiStore` (panel
  layout, selection, theme — explicitly **not** derived from the ledger).
- Browser memory discipline: apply-and-drop, a bounded ~2,000-event debug ring, capped per-node
  collections, snapshot-based scrubbing, and the dev-only 60-second projection-count assertion.
- `karvan replay <fixture> --speed <n>x --port <p>` and the six-fixture corpus, recorded from
  mock-agent runs.
- `GraphCanvas.vue` — the facade over `@vue-flow/core` — the ELK worker, the dagre fast path, and a
  recorded, re-runnable performance measurement against `stress-400`.
- `@pinia/colada` for the flat REST endpoints (`/api/runs`, `/api/providers`, `/api/config`,
  `/api/artifacts/:sha`) and nowhere near run state.

**Out of scope:**

- **All nine views.** [EPIC-17](./EPIC-17-p0-views.md). This epic ends with a shell, a store, a
  facade and a harness; the first thing EPIC-17 does is render into them.
- **The HTTP server, the SSE serving loop, bearer-token minting, `Origin` validation and the
  snapshot endpoint** — [EPIC-15](./EPIC-15-daemon-api.md). This epic is the client of that
  contract and asserts against it; it does not implement it.
- **The `Event` union itself and its upcasters** — [EPIC-02](./EPIC-02-domain-model.md) KAR-02.7.
  `@karvan/web` imports it **type-only** from `@karvan/core`; that boundary is enforced in
  [16 §4](../../16-repo-layout.md).
- **Vite middleware mode inside `karvand`** — [EPIC-01](./EPIC-01-dev-environment.md) KAR-01.3 and
  M0 spike S4. This epic assumes one process on one port and would be miserable without it.
- **Recording the fixtures' underlying runs.** The mock agent is [EPIC-04](./EPIC-04-mock-agent.md);
  a run that reaches a gate failure with a repair loop is EPIC-06/EPIC-12. KAR-16.5 owns the replay
  *server* and the corpus definition, not the orchestration that produces the events.
- **The interactive PTY WebSocket** at `/api/pty/:runId/:nodeId` — EPIC-15 for the transport,
  KAR-17.5 for the panel.
- **Run replay as a product feature (F10.10)** — P1, M2. The *mechanism* is built here (it is the
  same mechanism as the scrubber and the harness); the operator-facing playback controls are M2.
- **OTel export, the cross-run dashboard, `echarts`, and any second theme.** P1/P2.
- **Storybook or Histoire.** Deliberately not built — see the note under KAR-16.5.

## Definition of Ready (epic level)

- [ ] **EPIC-15 Done through KAR-15.4 and KAR-15.7.** The stream serves `id: <seq>` frames, honours
      `?since=`, emits `hello` with `{ streamId, apiVersion, build, daemonEpoch, headSeq }`, and
      `GET /api/runs/:id/snapshot?seq=N` returns a reduced state. Building the client against a
      hand-mocked stream is the exact mistake [roadmap §2.1](../../17-roadmap.md) warns about.
- [ ] **M0-S4 green.** One `node` process on port 7777 streaming SSE for ten minutes with events
      arriving individually (measured by client-side timestamps, not by eyeball) *and* hot-reloading
      a `.vue` edit over the same port without dropping the connection.
- [ ] **M0-S3 green, or its fallback chosen.** elkjs builds in a Vite 8 worker with the ~1.6 MB
      absent from the initial chunk — or `@dagrejs/dagre@3.0.0` is confirmed as the live-graph
      layout engine with ELK on the main thread for cached scrubber layouts.
- [ ] **At least one full run completes headlessly** through `karvan run`
      ([EPIC-18](./EPIC-18-cli-packaging.md) KAR-18.3), so KAR-16.5's fixtures can be *recorded*
      rather than hand-written.
- [ ] The `Event` union, `PlanGraph`, `ContextPacket`, `Verdict` and `NodeFailure` types are landed
      in `@karvan/core` and exported type-only.
- [ ] The pinned dependency set from [12 §2](../../12-frontend-architecture.md) is in the pnpm
      catalog, including `@vue/devtools-api@^8.2.1` — Pinia 4 no longer bundles it and devtools
      break silently without it.

## Definition of Done (epic level)

- [ ] All six stories Done.
- [ ] Every scenario in [the flow file](../flows/EPIC-16-ui-foundation-flows.md) exists as an
      automated test at the level its `Automated at:` line names, and passes on `ubuntu-26.04`.
- [ ] `pnpm vitest run --project unit` covers all seven projection modules against recorded fixture
      ledgers in Node's environment with **no DOM and no mount**, and the projection suite is the
      largest single block of frontend tests — roughly 80% of the frontend test count
      ([12 §3.3](../../12-frontend-architecture.md)).
- [ ] A lint rule fails the build if any file under `src/ledger/projections/` imports from `vue`.
- [ ] A lint rule fails the build if any file outside `src/components/graph/` imports `VueFlow` or
      `@vue-flow/core`.
- [ ] A six-hour `karvan replay --speed max` soak against `stress-400` ends with heap and projection
      object counts within the bounds asserted in KAR-16.4, and the debug ring at exactly its cap.
- [ ] **The 400-node measurement exists as a committed artifact** — `docs/measurements/vue-flow-400.md`
      with the numbers, the machine, the browser build and the command to re-run it. A3-2 is no
      longer `Unverified` for this project.
- [ ] `karvan replay fixtures/three-patches.jsonl --speed 20x` serves the identical `/api/*` and
      `/api/stream` contract a live daemon serves, and the UI code contains **no** branch on whether
      it is talking to a replay.
- [ ] The production build's initial chunk is ≤ 200 KB gzip, asserted in CI, with elkjs, the bundled
      `shiki` entry, `@xterm/*` and `@git-diff-view/*` all absent from it.
- [ ] No `Unverified` claim from [12-frontend-architecture.md](../../12-frontend-architecture.md)
      in this epic's area remains unverified: A3-1 (facade built), A3-2 (measured), A3-4 (worker
      built or fallback taken), A3-5 (union layout proven, interactive constraints demoted).

## User stories

### KAR-16.1 — Vue application shell, routing and theming

| | |
|---|---|
| **Status** | Ready |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | EPIC-01 KAR-01.1, EPIC-01 KAR-01.3 |
| **PRD** | NF3, F10.1, and the a11y floor under all of F10.1–F10.9 |
| **Verified by** | EPIC-16-S1, EPIC-16-S2, EPIC-16-S3, EPIC-16-S4, EPIC-16-S5 |

**As** the Operator, **I want** the app to open on localhost already authenticated, in my system
theme, with a keyboard map I can drive without the mouse, **so that** the surface I will stare at
for hours does not fight me and the token that authorises spawning processes on my machine never
lands in a log.

This is the frame everything else mounts into: `App.vue`, a plain-object `vue-router@5` route table
(file-based routing buys nothing for roughly ten routes), Pinia 4 with `@vue/devtools-api@^8.2.1`
installed alongside, Tailwind 4's CSS-first `@theme` block, and about sixteen vendored `shadcn-vue`
components on `reka-ui@^2.10.1` — `button, dialog, dropdown-menu, tabs, tooltip, popover, select,
badge, separator, scroll-area, resizable, command, sheet, toast, collapsible, table`. Two of those
carry a disproportionate amount of the operator experience: `resizable` for the graph-over-inspector
split, and `command` for the Cmd-K run/node jumper ([12 §8](../../12-frontend-architecture.md)).

The load-bearing decision here is small and easy to skip: **the entire node-state palette is CSS
custom properties, not Tailwind classes** ([12 §9.1](../../12-frontend-architecture.md)).
`--state-pending`, `--state-running`, `--state-blocked`, `--state-passed`, `--state-failed`,
`--state-abandoned`, `--state-awaiting-human`, redefined under `.dark`. Vue Flow node borders, Gantt
bars, context-budget segments, gate chips, criteria rows and the version rail all read the same
variable, so seven views stay consistent by construction and both themes work because you only
redefine seven values. Retrofitting hardcoded colours across nine views is the expensive path.

The token handoff is the security-relevant part. `karvan up` prints
`http://127.0.0.1:7777/#token=<token>`. Fragments are never sent to the server, so the token cannot
land in an access log; the UI reads it once, puts it in `sessionStorage`, strips it from the address
bar with `history.replaceState`, and sends it as a header thereafter
([11 §8](../../11-api-and-realtime.md)). It is never a query parameter — that is the whole reason
`eventsource-client` is a dependency rather than native `EventSource`.

**Acceptance criteria**

1. `pnpm dev` serves the app and the daemon from one Node process on port 7777; a `.vue` edit
   hot-reloads without dropping an open SSE connection, and there is no proxy and no CORS header
   anywhere in the request path.
2. Opening `http://127.0.0.1:7777/#token=<t>` results in: `sessionStorage` holding the token, the
   address bar showing no fragment, at least one subsequent authenticated request carrying
   `Authorization: Bearer <t>`, and the token appearing in **no** URL the browser ever sends.
3. Opening the app with no token and no stored token renders an explicit "paste the URL from
   `karvan up`" state — not a spinner, not a blank page, and not a 401 loop.
4. All seven state tokens are defined for both themes; a test enumerates the seven and asserts every
   one resolves to a non-empty computed value under `:root` and under `.dark`.
5. No state anywhere in the app is encoded by colour alone: every state chip renders a colour, a
   glyph and a text label (WCAG 1.4.1). The test asserts on the accessible name, not the fill.
6. `useDark()` from `@vueuse/core` flips `.dark` on `<html>`, respects the OS preference on first
   load, and persists an explicit override.
7. The keyboard map works with no pointer: `j`/`k` move between nodes, `Enter` opens the inspector,
   `←`/`→` step the version scrubber, `/` focuses search, `Cmd-K` opens the jumper, `Esc` closes the
   topmost overlay. A skip-link reaches main content, and `:focus-visible` rings are visible
   everywhere — `focus:outline-none` appears nowhere in the codebase.
8. `prefers-reduced-motion: reduce` disables the graph and scrubber transitions; the app remains
   fully usable and nothing depends on an animation completing.
9. The production build's initial chunk is ≤ **200 KB gzip**, and CI fails the build if it grows.
   `@vue-flow/core` (345 KB raw) is in it because the plan graph is the landing view; elkjs, the
   bundled `shiki` entry, `@xterm/*` and `@git-diff-view/*` are not.
10. `build.rolldownOptions` is written in `vite.config.ts` (not `build.rollupOptions` via the compat
    layer), and Rolldown's circular-import warnings are zero — fixed, not silenced.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | `readBootstrapToken(location)` returns the token, and the returned `cleanUrl` has no fragment | The token survives in the address bar |
| 2 | unit | The auth header factory throws rather than sending a request with no token | A missing token silently 401s in a loop |
| 3 | unit | Enumerate the seven `--state-*` names against a fixture stylesheet for both themes | A state was added to the domain and not to the palette |
| 4 | web (browser) | Mount the state chip for each of the seven states; assert accessible name contains the label and a glyph node exists | State is colour-only |
| 5 | web (browser) | `useDark()` toggles `.dark` and a `--state-failed` computed value differs between themes | Dark mode is a class with no token redefinition |
| 6 | web (browser) | Keyboard map: dispatch `j`, `k`, `Enter`, `/`, `Escape` and assert focus and overlay state | Handlers are bound to a component that is not always mounted |
| 7 | web (browser) | With `prefers-reduced-motion: reduce` emulated, the node transition computed style is `none` | The media query wraps the wrong rule |
| 8 | integration | `vite build`, then assert initial-chunk gzip ≤ 200 KB and that four named modules are absent from it | A lazy route was imported eagerly |
| 9 | e2e | Boot `karvan replay`, open the printed URL with the fragment, assert an authenticated `/api/runs` call succeeds and no request URL contains the token | The token was put in the query string |

**Notes / risks** — do **not** ship on `vue@3.6`. It is a reactivity-core rewrite (alien-signals) plus
Vapor Mode; Vapor buys this app nothing because every rendering-heavy dependency here is vDOM-based,
and **Vue Flow against 3.6 is Unverified** — its peer range is `^3.3.0` so npm will install it
happily, but neither project has published a compatibility statement and Vue Flow's store leans on
the reactivity internals 3.6 rewrites ([12 §2.1](../../12-frontend-architecture.md)). Also: install
`reka-ui`, never `radix-vue@1.9.17` — that is the dead name.

---

### KAR-16.2 — The SSE client and event dispatcher

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-16.1, EPIC-15 KAR-15.3, EPIC-15 KAR-15.4 |
| **PRD** | F4.1, NF10, NF3 |
| **Verified by** | EPIC-16-S1, EPIC-16-S6, EPIC-16-S7, EPIC-16-S8, EPIC-16-S9, EPIC-16-S10, EPIC-16-S11, EPIC-16-S12, EPIC-16-S13, EPIC-16-S14, EPIC-16-S24 |

**As** the Operator, **I want** the UI to stay exactly in step with the ledger across page reloads,
daemon restarts, network blips and hours of idle time, **so that** what I am looking at is never a
plausible but wrong picture of a run I am about to make a decision on.

`src/ledger/stream.ts` opens **one** connection for the whole tab, at app start, and never a second
one. This is an architecture constraint, not a tuning knob
([11 §2](../../11-api-and-realtime.md)): `karvand` is HTTP/1.1, browsers cap concurrent connections
per origin at about six, and an SSE connection never closes. One stream per run panel across two or
three tabs exhausts the budget, and the failure mode is not an error — every subsequent `fetch`
silently queues behind the streams forever, which reads as "the daemon hung".

The client is `eventsource-client@^1.2.0`, chosen because native `EventSource` cannot send custom
headers at all, which would force the bearer token into the query string. Avoid
`@microsoft/fetch-event-source` (abandoned, last published 2021-04-25) and plain `eventsource@^4.1.0`
(a spec-faithful polyfill that inherits the no-headers limitation by design).

Three behaviours carry most of the risk and each has a verified footgun behind it:

- **`Last-Event-ID` is sent only on automatic reconnect** — never after a page reload, never on the
  first connection of a session, and never if the initial connection failed to open. That third case
  is the common one in development: restart `karvand`, the tab's stream fails to open, and when the
  daemon comes back the tab reconnects with no cursor at all. **Verified 2026-08-02.** So the client
  persists its own cursor and always opens with `?since=<seq>`; the server's precedence is
  `since` > `Last-Event-ID` > head ([11 §4.1](../../11-api-and-realtime.md)).
- **`seq` gaps are normal.** A rolled-back transaction burns `AUTOINCREMENT` values, so `4, 5, 7` is
  a healthy log. **Do not write gap detection.** A client that treats a gap as data loss will report
  false loss and may "repair" by refetching from zero.
- **Named SSE events are stream control, not ledger events.** `hello`, `subscribed` and `caught_up`
  must never reach the reducer; ledger events arrive on the default unnamed type and discriminate on
  the payload's `kind`.

**Acceptance criteria**

1. Exactly one SSE connection exists per tab at all times, asserted by counting open connections
   server-side while three run panels are open. Adding a panel issues
   `POST /api/stream/:streamId/subscribe { runs: [...] }` and does **not** reconnect.
2. After subscribing to a new run, the daemon backfills that run from the client's current cursor
   before live delivery resumes, and the client observes a `caught_up { runId, seq }` frame; nothing
   between the cursor and that seq is missing or duplicated.
3. On cold start with no persisted cursor, the client hydrates through
   `GET /api/runs/:id/events?since=0` in a loop until `more` is false, showing honest progress from
   `headSeq`, and only then opens the stream at the returned `cursor`.
4. After a page reload mid-run, no event is lost: the client reopens with `?since=<persisted cursor>`
   and the applied event set is identical to a tab that never reloaded. A test that removes the
   `?since=` parameter must fail this assertion — the hydrate path is mandatory, not an optimisation.
5. Killing the connection mid-stream and letting the client's own reconnection fire produces no gap
   and no duplicate; the store's applied-seq sequence is strictly increasing across the seam.
6. A ledger with deliberate `seq` gaps (the `crash-resume` fixture) applies cleanly, the UI shows no
   error, and no code path anywhere compares `seq` to `previousSeq + 1`.
7. `hello`, `subscribed`, `caught_up` and `fatal` never reach `applyEvent`. A test that feeds a
   control frame into the dispatcher asserts the projections are byte-identical afterwards.
8. An event with an unknown `kind` from a newer daemon is ignored exactly as the backend reducer
   ignores it — no throw, no log-and-throw, and the cursor still advances past it.
9. A change in `hello.daemonEpoch` between connections is surfaced as an explicit "the daemon
   restarted" state; a change in `hello.build` prompts a reload rather than silently running an old
   tab against a new daemon.
10. `event: fatal` carrying `bad_token` or `epoch_mismatch` stops the retry loop; any other fatal
    code retries with the `retry: 2000` interval, and the configured client policy agrees with the
    server-sent `retry:` value.
11. Fifteen minutes of a stream with no ledger events produces no reconnect: the `: keepalive`
    comment every 15 seconds is ignored by the client and keeps every inactivity timer in the path
    quiet.
12. The `runs=*` topic delivers only the global lifecycle kinds (`run.created`, `run.completed`,
    `run.aborted`, `human.requested`) — an idle tab subscribed to `*` receives zero `node.progress`
    frames from any run.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | `parseFrame()` routes named events to `handleControl` and unnamed to `applyEvent` | Discrimination is on `kind` before checking the SSE `event:` name |
| 2 | unit | Cursor store: `advance(seq)` is monotonic and refuses a lower seq; persisted to and read from `sessionStorage` | The cursor lives in a component |
| 3 | unit | Applying a synthetic gap `4, 5, 7` leaves no error state and no refetch scheduled | Gap detection was written |
| 4 | unit | Unknown `kind` returns without mutating any projection, and still advances the cursor | The dispatcher throws on the default branch |
| 5 | unit | `fatal` code table — `bad_token` and `epoch_mismatch` stop retrying, others do not | The stop set is inverted or missing |
| 6 | integration | Against a real `karvan replay` daemon: cold hydrate loop until `more: false`, then stream from `cursor` | Hydrate is a single call and drops the tail |
| 7 | integration | Reload simulation — drop the client, construct a fresh one with the persisted cursor, assert identical applied set | The client relies on `Last-Event-ID` |
| 8 | integration | Server-side connection count stays at 1 while three run panels are added via `subscribe` | A panel opens its own `EventSource` |
| 9 | integration | Backfill-on-subscribe overlap: force an overlapping range and assert projections are unchanged by the duplicates | Projections are not seq-guarded |
| 10 | integration | 15-minute idle stream with the injected clock; assert zero reconnects and N keepalive comments | The client has its own idle timeout |
| 11 | e2e | Replay at speed, `kill` the connection, assert the UI reconnects and backfills with no gap and no duplicate | The reconnect path was never exercised |

**Notes / risks** — the SSE resume contract rests partly on `Last-Event-ID` semantics that the
research read from search summaries rather than the WHATWG spec (A1-6, Low). The mitigation is
already the design: the client never depends on `Last-Event-ID` for correctness, only as a
belt-and-braces alongside its own `?since=`. Separately, if events ever arrive in clumps rather than
individually, look for compression middleware in front of `/api/stream` before looking at the
scheduler — a buffered SSE stream *looks exactly like* a backend scheduling bug
([11 §3.1](../../11-api-and-realtime.md)).

---

### KAR-16.3 — Pure projection modules per view

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | L |
| **Depends on** | KAR-16.2, EPIC-02 KAR-02.7 |
| **PRD** | F4.1, NF10, NF9, and the data behind F10.1–F10.9 |
| **Verified by** | EPIC-16-S9, EPIC-16-S10, EPIC-16-S11, EPIC-16-S15, EPIC-16-S16, EPIC-16-S17, EPIC-16-S18, EPIC-16-S19, EPIC-16-S20, EPIC-16-S21, EPIC-16-S22, EPIC-16-S23, EPIC-16-S24 |

**As** the engineer building nine views, **I want** every view's data derived by a plain reducer
with no framework in it, **so that** the genuinely risky logic is tested in milliseconds against
recorded ledgers instead of through a mounted component in a browser.

Seven modules under `src/ledger/projections/`, each exporting a state interface and an
`apply<Name>(s, e): void` function that switches on `e.kind` and returns silently on the default
branch — *unknown kinds are ignored, exactly as the backend does*
([12 §3.3](../../12-frontend-architecture.md)):

| Module | Owns | Principal event kinds |
|---|---|---|
| `plan.ts` | Node and edge view-models, live state, edge `carries[]` labels | `plan.proposed`, `plan.patched`, `node.scheduled`, `node.started`, `node.progress`, `node.completed`, `node.failed`, `node.suspended`, `node.retry.scheduled` |
| `planHistory.ts` | The version rail, per-version node sets, `contentHash` per node | `plan.proposed`, `plan.patch.proposed`, `plan.patched`, `plan.patch.rejected` |
| `blackboard.ts` | Facts, provenance, consumer edges, taint | `fact.written`, `fact.read`, `fact.invalidated` |
| `context.ts` | Packet manifests, per-segment tokens, compaction marks | `context.built`, `context.compacted`, `pin.integrity_violated` |
| `gates.ts` | Verdicts, findings by file/line, criterion satisfaction | `gate.evaluated`, `human.requested`, `human.responded` |
| `cost.ts` | Per-node / per-provider / per-run token and cost accumulation | `budget.consumed`, `budget.exceeded`, `provider.rate_limited` |
| `timeline.ts` | Execution spans for the Gantt, plus the cost series | `node.started`, `node.completed`, `node.failed`, `node.suspended`, `budget.consumed` |

**These files import nothing from `vue`.** No `ref`, no `reactive`, no `computed`, no component.
That is what makes them unit-testable in Vitest's node environment with no DOM and no mount, and it
is why [12 §3.3](../../12-frontend-architecture.md) says *"this is where the genuinely risky logic
lives and it should be roughly 80% of the test count."* Plan for that ratio deliberately: a
projection bug renders a wrong picture of a real run, which is the one failure this whole product
exists to prevent, and catching it costs a 40-millisecond test rather than a browser.

Three correctness properties are not obvious and each has an event-shape reason behind it:

- **Segment token totals must sum.** `ContextPacket.totals.byKind` and the per-segment
  `tokens.estimated` come from the same builder; if the projection ever re-derives one from the
  other they can disagree. Assert the sum in the projection's own test, because the inspector's
  header and its stacked bar are the same number in two places.
- **`context.compacted` carries `fidelity: 'exact' | 'partial'`** and `after: number | null`.
  Vendor-side compaction reports only `pre_tokens` — Claude Code's `compact_boundary` frame has no
  post count, no dropped list and no handle to the original. **Verified 2026-08-02.** The projection
  must carry the null through, never coerce it to zero, so the chart can render the gap as a gap.
- **`TokenUsage.source` is `'vendor-reported' | 'estimated'` and must never be silently mixed.**
  Estimated figures carry a known 15–20% undercount on Claude prose and worse on code. `cost.ts`
  keeps the two sums separable and labels every displayed number with its source.

**Acceptance criteria**

1. No file under `src/ledger/projections/` imports from `vue`, `pinia`, or any DOM API. A lint rule
   enforces it and CI fails on violation.
2. Each of the seven modules has a fixture-driven unit test that feeds a recorded `events.jsonl` in
   Node's environment and asserts the final state with `toMatchFileSnapshot` under the normalising
   serializer. The full projection suite runs in **under two seconds**.
3. `applyPlan` over `happy-path-12` produces a node map whose states are exactly
   `pending | running | blocked | passed | failed | abandoned | awaiting-human` — the seven states
   F10.1 names — with no eighth state and no `undefined`.
4. `applyPlanHistory` over `three-patches` produces a rail of four versions carrying, per version,
   the `seq`, the `planHash`, the `decision` (`auto` | `approved` | `rejected`) and the human-readable
   `reason` string. A `plan.patch.rejected` event appears on the rail — the proposal is recorded even
   when it was refused.
5. `applyContext` over `compaction` yields, for the `vendor.session` compaction, `after === null`
   and `fidelity === 'partial'` — not `0`, not an interpolation — and for the `karvan.packet` one an
   exact before/after with a populated `droppedSegments[]` and `pinnedKept[]`.
6. For every packet, `sum(segments[].tokens.estimated) === totals.tokens` and the per-kind sums match
   `totals.byKind` for all nine `SegmentKind` values.
7. `applyGates` marks a criterion `unverifiable` as a distinct third state, never as a variant of
   `unsatisfied`, and a `needs-human` verdict is not folded into `fail`.
8. `applyCost` keeps `vendor-reported` and `estimated` usage in separate accumulators, and exposes
   which one a displayed total came from.
9. `applyTimeline` produces a span for a node that started and never completed (open-ended, still
   running) and for a node that was suspended for six hours, without inventing an end time.
10. Every projection is **idempotent under a replayed event**: applying the same envelope twice
    leaves the state identical. This is required because subscribe-backfill can legitimately overlap
    the client's cursor.
11. Every projection ignores an unknown `kind` without throwing and without partially mutating.
12. `applyBlackboard` records a fact's `provenance` (writing node, evidence handles, time,
    confidence) and its consumer set from `fact.read`, and a `fact.invalidated` event marks the fact
    and flags every downstream consumer in `taints[]`.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | `applyPlan()` returns without mutating on `{ kind: 'not.a.real.kind' }` | The reducer throws on an unknown kind |
| 2 | unit | Double-apply the same envelope to each of the seven projections; deep-equal before and after | A counter increments per call rather than per seq |
| 3 | unit | Seven node states enumerated against `applyPlan`'s output over a fixture covering all of them | A state transition was missed and renders as `pending` |
| 4 | unit | Packet segment sums equal `totals.tokens` and `totals.byKind` across every packet in `happy-path-12` | Totals are re-derived rather than carried |
| 5 | unit | `context.compacted` with `fidelity: 'partial'` keeps `after === null` | `after ?? 0` was written somewhere |
| 6 | unit | `unverifiable` and `needs-human` survive as distinct states through `applyGates` | They were collapsed into failure |
| 7 | unit | `cost.ts` — mixing a `vendor-reported` and an `estimated` `budget.consumed` yields two totals, not one | The sums were merged |
| 8 | unit | `timeline.ts` — a `node.started` with no terminal event yields an open span | The span is dropped or given `now` as its end |
| 9 | unit | `blackboard.ts` — `fact.invalidated` taints the recorded consumers of that fact | Consumers are computed only from the current graph |
| 10 | unit | File snapshots of all seven final states over all six fixtures, under the normalising serializer | The serializer was not registered first and every snapshot is churn |
| 11 | integration | `tsc` fails when a new event kind is added to `@karvan/core` and a projection's exhaustive switch is not updated | The switch has an untyped default that swallows new kinds |

**Notes / risks** — register the normalising snapshot serializer **before writing the first
snapshot**, or every snapshot is churn you learn to `-u` past, which is worse than having none
([14 §9](../../14-testing-strategy.md)). Normalise timestamps, ULIDs/UUIDs, durations, absolute
paths, ports and worktree directory names. Note also that `@karvan/web` imports the `Event` union
**type-only**: adding an event kind on the backend should surface as a compile error in the UI *in
the same commit*, and that only works if the exhaustive switch has no untyped escape hatch.

---

### KAR-16.4 — The run store with bounded memory

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-16.3, EPIC-15 KAR-15.7 |
| **PRD** | NF3, NF4, NF10 |
| **Verified by** | EPIC-16-S25, EPIC-16-S26, EPIC-16-S27, EPIC-16-S28, EPIC-16-S29, EPIC-16-S30 |

**As** the Operator running a task for six hours, **I want** the tab to be as responsive at hour six
as at minute one, **so that** the run I most need to understand is not the one whose UI died.

`useRunStore` is a Pinia setup store and a **thin reactive shell**: `shallowRef` containers holding
the projection states, an integer version counter per projection, and `computed` selectors that read
the counter to derive view-model arrays. If domain logic appears in it, it belongs in a projection
([12 §3.3](../../12-frontend-architecture.md)). `useUiStore` holds panel layout, selection and theme
and is explicitly not derived from the ledger.

Four performance rules, and the third is the one people get backwards. Deep `reactive()` over a few
thousand ledger-derived objects is the single most likely cause of missing NF3's *UI interactive
< 1s*: Vue walks thousands of objects installing proxies. `shallowRef` tracks one reference instead.
`markRaw` goes on anything handed to a non-Vue library — Vue Flow node objects, `xterm` `Terminal`
instances, ELK graph inputs, d3 scale objects — because a Vue proxy around an object a foreign
library holds identity comparisons on is very hard to see and very easy to avoid. And **mutate the
underlying `Map`, then bump a counter**: reassigning a 2,000-entry array on every `node.progress`
event is *worse* than the deep reactivity you were avoiding.

Then the four memory rules from [12 §5](../../12-frontend-architecture.md), all cheap on day one and
miserable to retrofit:

- **Never retain the raw event array.** Apply each event to the projections and drop it. Keep a
  bounded ring of the last ~2,000 raw events for the debug pane and nothing more. *Unbounded
  retention has no visible symptom until the tab dies at hour four of a real run.*
- **Cap unbounded per-node collections.** `node.progress` and stdout go to the terminal's xterm
  buffer (already capped at 5,000 lines) and **nowhere else**. Do not also push them into a store
  array "just for the inspector".
- **Scrubbing must not replay from `seq` 0 in the browser.** `GET /api/runs/:id/snapshot?seq=N`
  exists for browser memory, not server convenience: SQLite reduced 10,000 control-plane events to
  state in **29 ms** — **verified 2026-08-02** — and the client replays forward from the nearest
  snapshot only.
- **Ship a dev-only assertion.** Every 60 seconds in dev, log `{ nodes, facts, events, terminals }`
  counts. *You will find the leak in week one instead of in hour four of a run you cared about.*

**Acceptance criteria**

1. `applyEvent(e)` applies the envelope to every projection, advances `seq`, bumps the affected
   version counters, pushes the envelope onto the debug ring, and **retains no other reference to
   it**. A retention test holds a `WeakRef` to an applied envelope and asserts it is collectable
   after the ring has rolled past it.
2. The debug ring's length never exceeds its cap (default 2,000) regardless of how many events were
   applied, and its oldest entry advances monotonically.
3. No store array accumulates `node.progress` payloads or `io_chunk` data. A soak asserts the store's
   per-node object count is a function of node count, not of event count.
4. Every projection container is a `shallowRef`; a test asserts `isReactive(plan.value)` is `false`
   and that mutating a node in place plus bumping the counter re-renders a dependent `computed`.
5. Every object handed to Vue Flow, ELK or xterm passes `isProxy() === false`. The test walks the
   props `GraphCanvas` receives and fails on any reactive proxy.
6. Components receive `PlanNodeVM` / `PlanEdgeVM` / `TimelineSpanVM` and never a raw `Event` and
   never a projection internal — enforced by the exported types and asserted by a type-level test.
7. Scrubbing to plan version N issues `GET /api/runs/:id/snapshot?seq=<planVersionSeq[N]>` and
   replays forward from the returned state only. A test asserts **zero** events with
   `seq < snapshot.seq` are applied during a scrub, on a fixture with 10,000 events.
8. A **six-hour** `karvan replay --speed max` soak over `stress-400` ends with: JS heap growth under
   the agreed ceiling across the last four measured hours, projection object counts bounded by node
   and fact count, the debug ring at exactly its cap, and zero undisposed `Terminal` instances.
9. The dev-only 60-second counter assertion is present under `import.meta.env.DEV` and is
   **absent from the production bundle** — asserted by grepping the built output for its log tag.
10. `@pinia/colada` is used for `/api/runs`, `/api/providers`, `/api/config` and `/api/artifacts/:sha`
    and for nothing whose answer changes because an event was appended. A lint rule enforces the
    boundary: *if the answer changes because an event was appended, it is a projection; if it changes
    because a file on disk changed, it is a query.*

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Ring buffer: push 10,000, assert length === 2,000 and the head/tail identities | The ring is an array with `.shift()` and drifts |
| 2 | unit | `WeakRef` retention test over an applied envelope after the ring rolls | Something kept the raw array |
| 3 | unit | `isReactive(plan.value) === false` and a counter bump drives a dependent `computed` | `reactive()` was used for convenience |
| 4 | unit | `markRaw` audit over everything the store hands out to foreign libraries | A proxy leaked into Vue Flow |
| 5 | unit | Scrub path calls the snapshot endpoint and applies zero events below `snapshot.seq` | Scrubbing replays from zero |
| 6 | web (browser) | Render 400 `PlanNodeVM`s, mutate one node's state, assert only that node's subtree re-rendered | The view array is reassigned wholesale |
| 7 | integration | 6-hour `--speed max` soak with periodic `performance.measureUserAgentSpecificMemory()` samples | Any of the four memory rules was skipped |
| 8 | integration | Build the production bundle and grep for the dev leak-assertion tag | The assertion is not behind `import.meta.env.DEV` |
| 9 | web (browser) | Query-layer boundary: a Colada key over run state fails the lint fixture | Run state was put in a fetch cache |

**Notes / risks** — the `shallowRef` / `markRaw` performance characteristics this story depends on
*may shift either way under Vue 3.6's alien-signals reactivity*
([12 §2.1](../../12-frontend-architecture.md)). That is one more reason the epic pins 3.5.40, and it
is why the soak in AC-8 must be re-run — not assumed — whenever the Vue pin moves.

---

### KAR-16.5 — The replay harness serving recorded runs

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-16.2, EPIC-15 KAR-15.3, EPIC-18 KAR-18.3, EPIC-04 KAR-04.1 |
| **PRD** | F10.10 (mechanism), F4.9, NF8, and the development loop under F10.1–F10.9 |
| **Verified by** | EPIC-16-S31, EPIC-16-S32, EPIC-16-S33, EPIC-16-S34 |

**As** the engineer building nine views alongside a job and a degree, **I want** any UI state I need
to be one command away from being on screen, **so that** I never wait three hours or spend a pound
of provider quota to style a compaction marker.

**This is the single biggest DX lever in the project and it is a first-class deliverable, not
tooling.** `karvan replay fixtures/three-patches.jsonl --speed 20x --port 7777` is a daemon mode that
serves the **normal** `/api/*` and `/api/stream` endpoints from a recorded ledger instead of a live
run. The UI cannot tell the difference, because there is no difference — the browser is a projection
of an event stream either way ([03 §6.2](../../03-local-development.md)).

What that buys, concretely:

- **All nine P0 views developable offline** with no provider, no credentials, no child processes, no
  cost and no waiting.
- **Every state reachable on demand.** A gate failure with a repair loop, a run with a crash gap in
  the `seq`, a 400-node graph — each one command away.
- **The fixture format is the production format.** No mock API layer to keep in sync, no drift
  between what dev shows and what production emits, and no fixture-maintenance tax.
- **It is also the E2E driver** — the roughly five Playwright smokes run against it on an ephemeral
  port ([14 §13](../../14-testing-strategy.md)) — **and the demo tool.** The PRD's strongest internal
  demo (§15.4) is a real Voyado task shown through the plan-evolution scrubber; that is
  `karvan replay` pointed at a recorded real run.

This is also precisely why there is no Storybook. Karvan's UI is not a component library — it is
several stateful views over one event stream, and every interesting state is *"a particular ledger at
a particular offset"*, which `karvan replay` already expresses better, with real data, through the
real store and the real components. Storybook would mean a second build pipeline plus a second set of
fake props that drift from the real event shapes, to get worse fidelity
([14 §13](../../14-testing-strategy.md)).

The corpus, all six **recorded from mock-agent runs, never hand-written** — hand-written fixtures
encode your assumptions about the event stream rather than its actual shape, and they rot silently:

| Fixture | Must contain | Proves |
|---|---|---|
| `happy-path-12.jsonl` | A small run, all nodes pass, one gate, one worktree merged | Plan graph, timeline, node inspector |
| `three-patches.jsonl` | Insert, split and provider-replace patches, each with a `reason` and a `decision` | The plan-evolution scrubber (F10.2) |
| `gate-fail-repair.jsonl` | A failing gate, a surgical fix node, a second attempt, a pass | Criteria board, repair loop, inline verdicts |
| `compaction.jsonl` | Both fidelities: a `karvan.packet` compaction with exact before/after **and** a `vendor.session` one with `after: null` | Context budget (F10.5) and the honest rendering of the missing post-count |
| `crash-resume.jsonl` | A ledger whose `seq` values jump, as a real `SIGKILL` produces | `Last-Event-ID` resume, the `?since=` hydrate path, "did the UI notice?" |
| `stress-400.jsonl` | A wide `map` fan-out to 400 nodes | Vue Flow render budget, ELK layout time, scrubber responsiveness |

**Acceptance criteria**

1. `karvan replay <fixture> --speed <n>x --port <p>` boots and serves `GET /api/stream`,
   `GET /api/runs/:id/events`, `GET /api/runs/:id/snapshot`, `GET /api/runs/:id/plans*`,
   `GET /api/runs/:id/nodes/*`, `GET /api/runs/:id/gates`, `GET /api/runs/:id/criteria` and
   `GET /api/runs/:id/diff` with byte-identical response shapes to a live daemon.
2. **The web codebase contains no branch on whether it is talking to a replay.** Asserted by grepping
   `packages/web/src` for any replay-related identifier and finding none.
3. Frames carry `id: <seq>`, the `hello` control frame carries `{ streamId, apiVersion, build,
   daemonEpoch, headSeq }`, `retry: 2000` is written once, and `: keepalive` arrives every 15 s —
   the same contract EPIC-15 serves.
4. `--speed` accepts `1x`, `20x`, `50x` and `max`. At `1x` the recorded inter-event delays are
   reproduced within a stated tolerance; at `max` the whole fixture is delivered as fast as the
   socket drains. Playback is pausable and seekable to a `seq`.
5. Bearer auth and `Origin` validation are enforced exactly as in a live daemon — the replay harness
   is not an auth bypass. `GET /api/health` remains the only unauthenticated route.
6. All six fixtures exist under `test/fixtures/runs/`, each committed as a single file per run, and
   each has a recorded provenance note naming the mock-agent script and `--seed` that produced it.
7. A CI check regenerates one fixture from its recorded script and fails if the shape drifts from
   the committed copy — so a change to the `Event` union cannot silently invalidate the corpus.
8. `pnpm dev:replay` runs the happy path with `node --watch` and reloads on a source edit without
   restarting the browser session.
9. `crash-resume.jsonl` genuinely contains `seq` gaps, and serving it produces no error in either the
   harness or the client — the gaps are correct, not a defect to be normalised away.
10. `stress-400.jsonl` contains at least 400 plan nodes and is the fixture KAR-16.6's measurement
    runs against.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Fixture reader parses NDJSON envelopes and rejects one with a missing `seq` or `kind` | The reader is lenient and a bad fixture fails later, obscurely |
| 2 | unit | Speed scheduler: `20x` maps recorded offsets to emission times within tolerance; `max` yields zero delay | `--speed` is ignored or applied per-frame incorrectly |
| 3 | integration | Boot the harness on an ephemeral port; assert the SSE headers, `retry:`, `id:` and the `hello` payload shape | The harness serves a simplified stream |
| 4 | integration | Response-shape equality: run the same endpoint against a live daemon fixture and the harness, diff the JSON | The harness drifted from the contract |
| 5 | integration | Unauthenticated request to `/api/runs` returns 401; bad `Origin` returns 403 | The harness skipped auth "because it is only dev" |
| 6 | integration | Serve `crash-resume`, assert the client applies every event and reports no gap error | Gap handling was tested only synthetically |
| 7 | integration | Regenerate `happy-path-12` from its script and diff against the committed fixture modulo the normalising serializer | The corpus is drifting from the emitters |
| 8 | e2e | The five Playwright smokes from [14 §13](../../14-testing-strategy.md) all drive the harness | The smokes need a real orchestrator and are therefore never run |

**Notes / risks** — this story **depends on something outside the frontend**: the fixtures must be
recorded from real runs, and [roadmap §2.1](../../17-roadmap.md) is explicit that *"do not start W11
until at least one full run completes headlessly through W12's CLI."* That makes `karvan run`
(KAR-18.3) a genuine predecessor, and it is stated in `Depends on` even though it makes the plan look
slower. If EPIC-18 slips, the honest interim is to record fixtures from the mock agent driven by the
orchestrator's own test harness rather than to hand-write them — never the latter.

---

### KAR-16.6 — Graph canvas facade and a measured performance baseline

| | |
|---|---|
| **Status** | Not started |
| **Priority** | P0 |
| **Size** | M |
| **Depends on** | KAR-16.4, KAR-16.5, EPIC-00 KAR-00.4 |
| **PRD** | F10.1, NF3 |
| **Verified by** | EPIC-16-S35, EPIC-16-S36, EPIC-16-S37, EPIC-16-S38, EPIC-16-S39, EPIC-16-S40 |

**As** the author, **I want** one file between my views and Vue Flow and a real number for how many
nodes it can render, **so that** the largest third-party risk in the frontend is a one-file swap and
the decision about the memory graph is made on measurement rather than on an extrapolation from a
different library.

Two deliverables, deliberately in one story because neither is worth doing without the other.

**The facade.** `src/components/graph/GraphCanvas.vue` exposes Karvan's own props —
`{ nodes: PlanNodeVM[]; edges: PlanEdgeVM[]; selected?: NodeId }` — and Karvan's own events. Every
view imports `GraphCanvas`; **no view imports `VueFlow`**. Vue Flow is the single largest third-party
risk in the frontend (A3-1, **High**): last npm release 2026-01-28, effectively one maintainer, an
unreleased `next-release` branch, no announced v2, and no Vue 3.6 compatibility statement. It is
alive but slow. The facade costs about a day and it also lets the memory graph swap to
`sigma@^3.0.3` + `graphology@^0.26.0` — comfortable into the tens of thousands of nodes — without
touching the plan graph.

**The measurement.** [Roadmap §2.3](../../17-roadmap.md) is unambiguous: *"Measure Vue Flow in week
one of W10, not week four of W11."* The published guidance in
[12 §6.1](../../12-frontend-architecture.md) — ~300–500 nodes smooth at 60 fps with custom node
components, 500–1,500 usable with `onlyRenderVisibleElements: true`, stalls past roughly 2,000 nodes
or 4,000 edges — is explicitly **UNVERIFIED**: no official Vue Flow benchmark exists and the numbers
are extrapolated from React Flow's guidance and the identical one-DOM-subtree-per-node architecture.
A3-2 rates it **High** because it gates F10.4. So this story produces a committed measurement file
with the machine, the browser build, the fixture, the method and the command to re-run it.

Layout is `elkjs@^0.12.0` in a Web Worker via Vite's native `?worker` import plus ELK's
`workerFactory`, with `@dagrejs/dagre@^3.0.0` as the sub-16 ms fast path while a run is streaming
node additions and for the minimap pre-pass. **Never install unscoped `dagre`** — not because of any
docs example (the Vue Flow docs already import `@dagrejs/dagre`, so that commonly-repeated claim is
false) but because `dagre@0.8.5` last shipped 2019-12-03. Note too that the docs' repl pins
`@dagrejs/dagre@1.1.2`, two majors behind 3.0.0, so copied example code targets an older API.

The cheapest stability lever, and the one to do first: set
`org.eclipse.elk.layered.considerModelOrder.strategy = 'NODES_AND_EDGES'` and always feed ELK the
node array **in ledger-insertion order**, which `plan.ts` already has for free. ELK then keeps
relative ordering stable across plan versions with no per-node constraints at all.

**Acceptance criteria**

1. `GraphCanvas.vue` is the only file in `packages/web/src` that imports `@vue-flow/core`; a lint
   rule fails the build otherwise. Its public props and events are Karvan types, and no Vue Flow type
   appears in its exported surface.
2. `GraphCanvas` renders a node via a slot taking a `PlanNodeVM`, so per-node live status, streaming
   badge, gate verdict and cost are Vue components — the reason Vue Flow was chosen over the
   canvas-first alternatives.
3. **A committed measurement** at `docs/measurements/vue-flow-400.md` records, against
   `stress-400.jsonl` in headless Chromium: initial layout time (ELK, off-main-thread), time to first
   paint of the full graph, median and p95 frame time during a scripted pan and a scripted zoom, and
   the same four numbers with `onlyRenderVisibleElements` on and off. It names the machine, the
   Chromium build, the date, and the exact command to reproduce it.
4. The measurement is **re-runnable as a script** (`pnpm measure:graph`) and its p95-frame-time
   number is asserted against a recorded budget in CI at a tolerance wide enough not to be flaky —
   a regression is caught, jitter is not.
5. ELK runs in a Web Worker in the **built** `dist/` served by the daemon, not only in the dev
   server; the worker chunk is emitted and hashed, and the ~1.6 MB of elkjs is absent from the
   initial chunk. If M0-S3's fallback was taken instead, `@dagrejs/dagre` drives the live graph and
   ELK runs on the main thread for cached scrubber layouts only — and that choice is recorded in the
   measurement file.
6. Layout stability: adding a node to a 60-node graph and relaying out with
   `considerModelOrder.strategy = 'NODES_AND_EDGES'` and ledger-insertion order leaves the existing
   nodes' relative ordering unchanged — asserted on the ordering, not on exact pixel coordinates.
7. Node motion is a CSS `transition: transform 200ms ease-out` on `.vue-flow__node` and **nothing
   else**; no code writes a `transform` on a node. The transition is disabled during node drag and
   during viewport pan/zoom, and under `prefers-reduced-motion`.
8. Accessibility survives the facade: `disableKeyboardA11y` is **not** set, keyboard node traversal
   works, and every node carries a meaningful `ariaLabel` of the form
   `` `${node.type} ${node.title}, ${node.state}, ${node.provider}` ``.
9. `onlyRenderVisibleElements`, `elevateNodesOnSelect` and `nodeExtent` are configurable through the
   facade's props, defaulting from the measurement rather than from taste.
10. Swapping the renderer is provably a one-file change: a spike branch replaces `GraphCanvas`'s
    internals with a stub renderer and every consuming view still compiles and renders.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| # | Level | Test | Red when |
|---|---|---|---|
| 1 | unit | Lint fixture: a view importing `@vue-flow/core` fails the rule | The rule matches only the default export |
| 2 | unit | The ELK adapter maps `PlanNodeVM[]` in ledger-insertion order and sets `considerModelOrder.strategy` | Ordering is `Map` iteration order by accident, not by contract |
| 3 | unit | Layout stability: insert a node mid-graph, assert the relative order of the pre-existing nodes is unchanged | The option was set on the wrong ELK layout algorithm |
| 4 | web (browser) | Mount `GraphCanvas` with 12 nodes; assert per-node slot content and the `ariaLabel` string shape | Node bodies are Vue Flow defaults, not Karvan components |
| 5 | web (browser) | Keyboard traversal moves selection; `disableKeyboardA11y` is absent from the rendered options | A11y was disabled to stop key handlers conflicting |
| 6 | web (browser) | Computed style of `.vue-flow__node` has the 200 ms transition; drag sets the disabling class; reduced-motion removes it | A bespoke `translate3d` animation was authored and Vue Flow overwrites it |
| 7 | integration | `vite build`, then assert the worker chunk exists, is hashed, and elkjs is absent from the initial chunk | Worker wiring works in dev only |
| 8 | e2e | `pnpm measure:graph` against `stress-400` through `karvan replay`, emitting the measurement file | The measurement was done by hand once and never again |
| 9 | e2e | Replace the facade internals with a stub renderer; every view still compiles and renders | Something reached past the facade |

**Notes / risks** — do **not** test this surface in jsdom or happy-dom. They have no SVG measurement
(`getBBox`, `getComputedTextLength`, `getScreenCTM`), no canvas and no WebGL, and *the failure mode is
not a clean error*: `getBBox()` returns `0`, `getContext('2d')` is `null` or a no-op, element sizes
report as zero. A test asserting "the node label fits inside the node" passes against a `0×0` box.
**They will lie to you**, which is strictly worse than not testing
([14 §13](../../14-testing-strategy.md)). Everything geometric here runs in real Chromium under
Vitest 4 browser mode.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **This epic totals ~20 days, over the ~15-day guideline** for a solo build alongside a job and a degree. | High | The honest slice is KAR-16.1 → 16.2 → 16.3 → 16.4 as a hard prerequisite block (~14 days) and KAR-16.5 + 16.6 as a second block (~6 days) that can overlap the first EPIC-17 story. Do **not** reorder 16.5 after EPIC-17 starts: building views before the harness exists is what makes EPIC-17 expensive. |
| **A3-1 — Vue Flow bus factor.** Last release 2026-01-28, effectively one maintainer, no v2 announced, no Vue 3.6 statement. | High | KAR-16.6's facade, built on day one of the epic rather than as a refactor. Re-check release activity before M2; a stalled dependency becomes a one-file swap to `sigma`/`graphology` rather than a rewrite. |
| **A3-2 — the performance ceiling is an extrapolation from React Flow**, and it gates whether KAR-17.9 ships. | High | KAR-16.6 AC-3/AC-4. Measure in week one, commit the number, assert it in CI. If the number comes back below ~300 nodes, KAR-17.9 slips to M2 by the roadmap §3 recommendation and the plan graph gains `onlyRenderVisibleElements` by default. |
| **A3-4 — elkjs in a Vite 8 worker is unverified**; elkjs is GWT-transpiled and its README acknowledges bundler friction. | High | M0-S3 answers it before this epic starts, and the epic's DoR names it. Fallback is `@dagrejs/dagre@3.0.0` live with ELK on the main thread for cached scrubber layouts, which is acceptable because the scrubber's layout is computed once and cached. |
| **EPIC-15 slipping leaves this epic with nothing to project.** | Medium | The projection modules (KAR-16.3) depend only on the `Event` union and can be built and unit-tested against recorded fixture files with no server at all. That is roughly a third of the epic, and it is deliberately the third with the most risk in it. |
| **The memory rules look like premature optimisation and get skipped.** | Medium | KAR-16.4 AC-8 makes the consequence measurable rather than a matter of belief: a six-hour soak, run in CI on a schedule rather than on every push. All four rules are cheap on day one; retrofitting them means touching every view EPIC-17 built in the meantime. |
| **The replay harness drifts from the live contract** and dev stops predicting production. | Medium | KAR-16.5 AC-2 (no replay branch in the web code) plus AC-4's response-shape equality test and AC-7's fixture regeneration check. If the harness ever needs a special case in the UI, that is the bug. |
| **Vitest 5.0 goes stable during M1**, bringing another `projects` / browser-mode migration. | Low | Do not chase the beta (A2-5). Budget an afternoon if it lands. |

---

**Related:** [Flows](../flows/EPIC-16-ui-foundation-flows.md) · [Board](../board.md) ·
[Frontend architecture](../../12-frontend-architecture.md) ·
[API and realtime](../../11-api-and-realtime.md) ·
[Testing strategy](../../14-testing-strategy.md) ·
[Local development](../../03-local-development.md) ·
[P0 views epic](./EPIC-17-p0-views.md)

[← Back to the delivery plan](../README.md)
