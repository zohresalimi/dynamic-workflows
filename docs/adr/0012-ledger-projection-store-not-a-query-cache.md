# ADR 0012: A ledger-projection store, not a query cache

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

This is the load-bearing call for the whole frontend, and the reflex answer is wrong.

The reflex answer in 2026 is TanStack Query (`@tanstack/vue-query@5.101.4`) or Pinia Colada
(`@pinia/colada@1.4.2`). Both are excellent, both are actively maintained, and both are **key-scoped
fetch caches** with `staleTime`, invalidation and refetch semantics. They exist to solve a specific
problem: _server state is a set of resources you request, which may have gone stale since you last
asked._

**DeFlow's server state is not that.** It is a monotonically-growing append-only log with a total
order (`seq`), where every UI view is a projection of the same stream (F4.1, NF10 — "any state in
the UI is traceable to specific ledger events"). Applying a fetch cache to it means:

- You **invalidate and refetch a projection you could have advanced by one event.** An SSE frame
  arrives; the correct response is `applyEvent(e)`, not "mark the `run-42` key stale and re-request".
- You **fight cache keys for state that has exactly one authoritative ordering.** There is no
  staleness question to answer — `seq` answers it.

Two P0 features make the mismatch concrete. The plan-evolution scrubber (F10.2) and run replay
(F10.10) both mean "show me the state as of `seq` N". Under a projection store that is
`replayTo(seq)` — the reducers you already have, run to a different offset. Under a fetch cache it
is a bespoke endpoint, a bespoke cache key per version, and a second code path that can disagree
with the live one.

## Decision

**Hand-roll a ledger-projection store on Pinia 4. Do not use TanStack Query or Pinia Colada for run
state.**

The structure mirrors the daemon's own model (PRD §9.3) deliberately:

- **`src/ledger/types.ts`** — the _same_ discriminated-union `Event` type as the daemon, published
  from a shared workspace package, so the projection code typechecks against the producer.
- **`src/ledger/stream.ts`** — one SSE connection per tab, feeding a single `applyEvent(e: Event)`
  dispatcher.
- **`src/ledger/projections/*.ts`** — pure `(state, event) => void` functions, one file per P0 view:
  `plan.ts`, `blackboard.ts`, `context.ts`, `gates.ts`, `cost.ts`, `timeline.ts`, `criteria.ts`.
  **Zero Vue imports**, so each is unit-testable in a Node environment with no DOM and no mount.
- **`src/stores/useRunStore.ts`** — a Pinia setup store owning `seq` plus `shallowRef`/
  `shallowReactive` containers, calling the projections and exposing computed selectors.

Two Vue-specific rules that are not optional: use **`shallowRef`** for the node, edge and fact
collections, and **`markRaw`** on anything handed to Vue Flow or xterm. Deep `reactive()` over a few
thousand ledger-derived objects is the single most likely cause of missing the NF3 sub-second
interactive budget.

**A small query layer is correct in exactly one place**: the flat REST endpoints that are not part
of the stream — `GET /api/runs`, `/api/artifacts/:sha`, `/api/providers/doctor`, `/api/config`. Use
`@pinia/colada@^1.4.2` there (about a quarter the size of vue-query, built on Vue reactivity, and
its peers `pinia ^4.0.2` + `vue ^3.5.17` match our pins exactly). **It must not touch run state.**

Store shape, the nine views and the browser-memory rules are in
[12-frontend-architecture.md](../12-frontend-architecture.md).

## Consequences

### Positive

- **NF10 becomes structural rather than aspirational.** Every pixel in the UI is derived from named
  events by a pure function you can point at.
- **The scrubber and replay come free.** Both are "run the reducers to `seq` N".
- **The highest-risk logic is testable as pure functions** — feed a recorded `events.jsonl` fixture,
  assert the final state. Milliseconds per test, no DOM. This should be around 80% of the frontend
  test count ([14-testing-strategy.md](../14-testing-strategy.md)).
- The fixture format _is_ the production format, which is what makes `deflow replay <fixture.jsonl>`
  a real development and demo tool rather than a mock.
- No cache-invalidation reasoning anywhere in run state.

### Negative

- We write and maintain the store. No devtools timeline, no automatic retry/refetch, no request
  deduplication — none of which apply to a single SSE stream, but they are real amenities given up.
- **Browser memory over a multi-hour run is our problem and no library solves it.** Three rules,
  designed in from day one: never retain the raw event array (apply and drop, keeping only a bounded
  ring of ~2,000 raw events for the debug pane); cap unbounded per-node collections (node output
  goes to the xterm buffer, capped at 5,000 lines, and nowhere else); and scrubbing to an earlier
  version must not replay from `seq` 0 in the browser — `GET /api/runs/:id/snapshot?seq=N` rebuilds
  from SQLite far faster than JS can, and the client replays forward from the nearest snapshot.
- Two data-access patterns coexist (projections for run state, Colada for flat REST). The boundary
  must be enforced by review, since nothing mechanical prevents someone caching a run.

### Neutral

- The projections are plain TypeScript reducers, so if the frontend framework ever changes, they
  port unchanged.

## Alternatives considered

- **`@tanstack/vue-query@5.101.4`.** Rejected for run state: key-scoped fetch cache semantics
  against a totally-ordered append-only log. Would be the right call if the same data layer were
  ever needed in a React surface — it is not.
- **`@pinia/colada@1.4.2` for everything.** Rejected for run state on the same grounds. Adopted for
  the flat REST endpoints, where it is exactly right.
- **`@rstore/vue@0.8.4`** (a newer normalised Vue data store). Rejected: too young and too small to
  bet a solo project on, and it does not change the conclusion for an event log.
- **Plain `reactive()` objects with no structure.** Rejected: it is the projection store without the
  discipline, and it loses the pure-function testability that makes the store worth having.
- **Server-rendered views recomputed per request.** Rejected: contradicts
  [ADR 0002](./0002-headless-daemon-with-localhost-web-ui.md)'s many-clients-one-stream shape, and
  the UI must stay live at frame rate during a run.

## Revisit when

**The REST surface outside the stream grows past roughly a dozen endpoints with real interdependent
invalidation** — for example when the M3 hub adds shared templates, gate registries and team
dashboards that mutate each other. At that point Colada's role expands and deserves a deliberate
review; the run-state half of this decision is unaffected.

Independent trigger: **profiling shows projection cost, not render cost, is what breaks the NF3
budget on a 400-node stress fixture.** That would mean the reducers need incremental indexes rather
than that the architecture is wrong — but it is the point at which this record should be re-read
rather than assumed.

---

[← ADR index](./README.md) · [Architecture docs](../README.md)
