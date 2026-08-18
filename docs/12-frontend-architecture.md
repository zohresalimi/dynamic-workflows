# Frontend architecture

> Part of the [DeFlow architecture documentation](./README.md). See also: [PRD](./prd.md) ·
> [Architecture overview](./01-architecture-overview.md) · [Research findings](./research-findings.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

Visualisation is a primary product surface, not a debug afterthought (PRD §7.10). The metric that
decides whether this frontend succeeded is **median time-to-diagnose a failed run under five
minutes** — not how it looks. Everything below is chosen to serve that.

The frontend is `@DeFlow/web`: a Vue 3 SPA served by `DeFlowd` on `http://127.0.0.1:7777`, in dev
through Vite middleware mode inside the daemon (D10), in production as static files out of the npm
tarball. One origin, no proxy, no CORS.

---

## 1. The frontend is a projection, not a client

This is the sentence the whole document hangs on:

> The UI applies the **same event vocabulary** the backend reducer applies, to build **its own**
> projections of the **same ledger**.

It is not a REST client that fetches view models the server computed. It is a second reducer over
the same log. That is what makes NF10 ("any state in the UI is traceable to specific ledger events")
structural rather than aspirational — you cannot render something that did not come from an event,
because there is no other input.

Two P0/P1 features fall out of this for free, and would otherwise each be a bespoke subsystem:

- **Plan-evolution scrubber (F10.2)** — "show me version N" is `replayTo(planVersionSeq[N])`.
- **Run replay (F10.10)** — "watch it unfold" is feeding the same reducers at a chosen rate.

The same property is also the test harness: `deflow replay fixtures/three-patches.jsonl --speed 20x`
serves the normal `/api/stream` endpoint from a recorded run, so all nine views are developable with
no credentials, no child processes, no cost and no three-hour wait. See
[local development](./03-local-development.md) and [testing strategy](./14-testing-strategy.md).

---

## 2. Base stack, pinned

**Verified on registry.npmjs.org 2026-08-02.**

| Package                      | Pin       | Note                                                                        |
| ---------------------------- | --------- | --------------------------------------------------------------------------- |
| `vue`                        | `~3.5.40` | Latest **stable**. Published 2026-07-16                                     |
| `vue-router`                 | `^5.2.0`  | 2026-07-15                                                                  |
| `pinia`                      | `^4.0.2`  | 2026-07-15                                                                  |
| `@vue/devtools-api`          | `^8.2.1`  | Pinia 4 no longer bundles it — install alongside or devtools silently break |
| `vite`                       | `^8.2.0`  | 2026-07-30, Rolldown by default                                             |
| `@vitejs/plugin-vue`         | `^6.0.8`  |                                                                             |
| `vue-tsc`                    | `^3.3.9`  | 2026-07-31                                                                  |
| `typescript`                 | `6.0.3`   | Exact, workspace-wide via the pnpm catalog (D3)                             |
| `vitest` / `@vitest/browser` | `^4.1.10` |                                                                             |
| `vitest-browser-vue`         | `^2.1.0`  |                                                                             |
| `@playwright/test`           | `^1.62.1` |                                                                             |
| `vite-plugin-vue-devtools`   | `^8.2.1`  |                                                                             |

### 2.1 Vue 3.5.40, explicitly not 3.6

`vue@3.6.0-rc.2` exists (2026-07-22). Do not ship on it.

3.6 is a **reactivity-core rewrite** (alien-signals) plus Vapor Mode. Vapor buys this app nothing:
it requires per-component opt-in compilation, and every rendering-heavy dependency here —
`@vue-flow/core`, `@git-diff-view/vue`, `reka-ui` — is vDOM-based, so the views that actually cost
frames would not use it. Shipping M1 on an RC of a reactivity rewrite is uncompensated risk.

Two consequences to hold:

- **Vue Flow against Vue 3.6 is UNVERIFIED.** Its peer range is `^3.3.0`, so npm will happily install
  it against 3.6, but neither project has published a compatibility statement and Vue Flow's store
  leans hard on the reactivity internals 3.6 rewrites. **Unverified.** Do not upgrade until Vue Flow
  ships a release that names 3.6.
- The `shallowRef` / `markRaw` performance characteristics this document depends on may shift either
  way under alien-signals. Re-benchmark the 400-node stress fixture when you upgrade.

Vue 3.5 already gives `useTemplateRef()`, `onWatcherCleanup()`, improved `defineModel`, and — the
one that matters here — materially cheaper reactivity over large arrays.

All components use `<script setup lang="ts">`.

### 2.2 Vite 8 breaking changes that will bite

| Change                                                              | What to do                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `build.rollupOptions` → `build.rolldownOptions`                     | A compat layer auto-converts, but write the new name so you are not debugging a shim later |
| `build.cssMinify` now defaults to **Oxc**                           | Diff the built CSS once on the first upgrade                                               |
| Rolldown emits **circular-import warnings** Rollup was silent about | These are usually pre-existing and real. Fix them; do not silence the rule                 |
| **ESM-only** package                                                | Already true of this workspace (D4)                                                        |
| **Yarn PnP unsupported**                                            | Irrelevant — pnpm 11 (D5)                                                                  |
| Node floor 20.19+/22.12+                                            | Irrelevant — Node ≥24 (D2)                                                                 |

`vue-router@5` is a **non-breaking transition release**: it merged `unplugin-vue-router` (file-based
routing) into core. Coming from v4 without that plugin it is a version bump only. Use plain object
routes — file-based routing buys nothing for roughly ten routes. Pinia 4's breaking changes are
cosmetic: ESM-only, plus the devtools-api split noted above.

Nuxt was considered and rejected: this is a static SPA bundle served by `DeFlowd` on localhost. SSR
and Nitro are pure overhead, and a second server process contradicts the daemon-owns-execution rule
(PRD §6.1 I2).

---

## 3. State: a hand-rolled ledger-projection store on Pinia (D11)

**This is the load-bearing frontend decision.** Get it wrong and every subsequent view fights it.

### 3.1 Why not TanStack Query, and why not Pinia Colada, for run state

`@tanstack/vue-query@5.101.4` and `@pinia/colada@1.4.2` are both excellent, both actively
maintained, and both are **key-scoped fetch caches** built on `staleTime` and invalidation.

DeFlow's server state is not request/response. It is a monotonically-growing append-only log with a
total order (`seq`). Applying a query cache to it means:

- you **invalidate and refetch** a projection you could have advanced by exactly one event;
- you fight cache keys for state that has precisely one authoritative ordering;
- replay (F10.10) and the plan scrubber (F10.2) — which are _the same operation as normal
  rendering_, just stopped at a different `seq` — become bespoke special cases outside the cache;
- NF10 becomes unprovable, because the thing on screen came from a merged cache entry rather than
  from an identifiable event.

The mismatch is not a matter of taste. A cache answers "what is the current value of X?". This UI
answers "what happened, in what order, and why?".

### 3.2 File layout

```
packages/web/src/
  ledger/
    types.ts            re-export of the Event union, type-only, from @DeFlow/core
    stream.ts           ONE SSE connection → applyEvent(e)
    apply.ts            the dispatcher: switch on e.kind, call projections
    cursor.ts           persisted seq cursor (sessionStorage), hydrate-then-stream
    projections/
      plan.ts           F10.1 node/edge state, live status
      planHistory.ts    F10.2 version rail, per-version node sets, content hashes
      blackboard.ts     F10.4 facts, provenance, consumer edges
      context.ts        F10.3/F10.5 packet manifests, segment tokens, compaction marks
      gates.ts          F7.3/F10.8 verdicts, findings, criteria satisfaction
      cost.ts           F9.1 per-node/provider/run token + cost accumulation
      timeline.ts       F10.9 node execution spans for the Gantt
  stores/
    useRunStore.ts      Pinia setup store: shallowRef containers + computed selectors
    useUiStore.ts       panel layout, selection, theme — NOT derived from the ledger
  api/
    client.ts           hc<ApiType> typed RPC  (see ./11-api-and-realtime.md)
    queries.ts          @pinia/colada, flat REST only
```

### 3.3 The three rules

**Rule 1 — the `Event` union is shared, type-only, from `@DeFlow/core`.**
The same discriminated union the daemon's reducer switches on. The projection code therefore
typechecks against the producer, and adding an event kind on the backend surfaces as a compile error
in the UI in the same commit. `@DeFlow/web` imports `@DeFlow/core` for **types only** — that
boundary is enforced in [repo layout](./16-repo-layout.md).

**Rule 2 — projections are pure TypeScript with zero Vue imports.**

```ts
// packages/web/src/ledger/projections/plan.ts
export interface PlanProjection {
  nodes: Map<NodeId, PlanNodeVM>;
  edges: Map<EdgeId, PlanEdgeVM>;
  version: number;
}

export function applyPlan(s: PlanProjection, e: Event): void {
  switch (e.kind) {
    case "plan.proposed":
      /* … */ return;
    case "node.started": {
      const n = s.nodes.get(e.nodeId!);
      if (n) n.state = "running";
      return;
    }
    case "node.completed":
      /* … */ return;
    default:
      return; // unknown kinds are ignored, exactly as the backend does
  }
}
```

No `ref`, no `reactive`, no `computed`, no component. They are plain reducers, so they unit-test in
**Vitest's node environment in milliseconds** — no DOM, no mount, no browser. Feed a fixture
`events.jsonl`, assert final state. This is where the genuinely risky logic lives and it should be
roughly 80% of the test count.

**Rule 3 — the Pinia store owns reactivity, and nothing else.**

```ts
// packages/web/src/stores/useRunStore.ts
export const useRunStore = defineStore("run", () => {
  const seq = ref(0);
  const plan = shallowRef(emptyPlan()); // container swapped, not deep-tracked
  const bumpPlan = ref(0); // version counter for in-place mutation

  function applyEvent(e: Event) {
    applyPlan(plan.value, e);
    applyBlackboard(bb.value, e);
    applyContext(ctx.value, e);
    // …
    seq.value = e.seq;
    bumpPlan.value++;
  }

  const graphNodes = computed(
    () => (bumpPlan.value, [...plan.value.nodes.values()]),
  );
  return { seq, graphNodes, applyEvent /* … */ };
});
```

The store is a thin reactive shell. If you find domain logic in it, it belongs in a projection.

### 3.4 Where a query layer _is_ correct

For the flat REST endpoints that are not part of the stream — `GET /api/runs` (list),
`GET /api/artifacts/:sha`, `GET /api/providers`, `GET /api/config` — use **`@pinia/colada@^1.4.2`**.
It is roughly a quarter the size of `vue-query`, built on Vue reactivity rather than React-shaped
render optimisations, and its peers (`pinia ^4.0.2`, `vue ^3.5.17`) match these pins exactly.

> **Do not let it touch run state.** The boundary is: if the answer changes because an event was
> appended, it is a projection. If the answer changes because a file on disk changed, it is a query.

---

## 4. Vue-specific performance rules

Deep `reactive()` over a few thousand ledger-derived objects is the single most likely cause of
missing the NF3 "UI interactive < 1s" budget. Four rules:

1. **`shallowRef` for every collection.** Nodes, edges, facts, context segments, timeline spans.
   Vue then tracks one reference instead of walking thousands of objects installing proxies.
2. **`markRaw` on anything handed to a non-Vue library.** Vue Flow node objects, `xterm` `Terminal`
   instances, ELK graph inputs, d3 scale objects. A Vue proxy around an object a foreign library
   holds identity comparisons on is a class of bug that is very hard to see and very easy to avoid.
3. **Mutate the underlying `Map`, then bump a version counter.** Reassigning a 2,000-entry array on
   every `node.progress` event is worse than the deep reactivity you were avoiding. Mutate in place
   inside the projection, increment an integer `ref`, and read that counter inside the `computed`
   that derives the view array.
4. **Derive view-models once, at the store boundary.** Components receive `PlanNodeVM`, never a raw
   `Event` and never a projection internal. That keeps `v-memo`/render work proportional to what
   actually changed and keeps components trivially testable.

---

## 5. Browser memory over a multi-hour run

This is what will actually kill the tab, and no library solves it. All four items are cheap if done
on day one and miserable to retrofit.

**5.1 Never retain the raw event array.** Apply each event to the projections and drop it. Retain a
bounded ring of the last ~2,000 raw events for the debug/inspector pane and nothing more. Unbounded
retention has no visible symptom until the tab dies at hour four of a real run.

**5.2 Cap unbounded per-node collections.** `node.progress` and stdout go to the terminal's xterm
buffer (already capped, §6.6) and **nowhere else**. Do not also push them into a store array
"just for the inspector". Findings, facts and verdicts are naturally bounded; agent output is not.

**5.3 Scrubbing must not replay from `seq` 0 in the browser.** `DeFlowd` serves
`GET /api/runs/:id/snapshot?seq=N`, and SQLite rebuilds state far faster than JavaScript can
(**verified 2026-08-02:** 10,000 control-plane events reduced to state in **29 ms**). The client
replays forward from the nearest snapshot only. Contract in
[API and realtime §7.3](./11-api-and-realtime.md).

**5.4 Ship a dev-only assertion.** Every 60 seconds in dev, log projection object counts:

```ts
if (import.meta.env.DEV)
  setInterval(() => {
    console.debug("[proj]", {
      nodes: plan.value.nodes.size,
      facts: bb.value.facts.size,
      events: ring.length,
      terminals: termRegistry.size,
    });
  }, 60_000);
```

You will find the leak in week one instead of in hour four of a run you cared about.

---

## 6. The nine P0 views

### 6.1 Live plan graph (F10.1)

**`@vue-flow/core@^1.48.2`** (2026-01-28), plus `@vue-flow/background@^1.3.2`,
`@vue-flow/controls@^1.1.3`, `@vue-flow/minimap@^1.5.4`. Import
`@vue-flow/core/dist/style.css` and the default theme.

**Verified 2026-08-02** by tarball inspection: proper ESM (`dist/vue-flow-core.mjs`, 345 KB raw)
with a correct `exports` map, so Vite 8 / Rolldown consumes it cleanly; peer `vue: ^3.3.0`;
`onlyRenderVisibleElements`, `elevateNodesOnSelect`, `nodeExtent`, `disableKeyboardA11y` and
`ariaLabel` present in the shipped `.d.ts`; `aria-live` / `aria-label` / `aria-describedby` /
`aria-roledescription` and `useKeyPress` keyboard navigation present in the bundle.

It is the only real option: a faithful React Flow port where a custom node **is a Vue component**,
which is exactly what F10.1 needs (per-node live status, streaming badge, gate verdict, cost).
`v-network-graph` is far less capable; `@antv/g6` and `cytoscape` are canvas-first and make rich
per-node Vue content painful; xyflow has repeatedly declined to ship an official Vue port.

**Bus factor, and the mitigation.** Last npm release 2026-01-28 — six months. Recent repo activity
is docs (2026-06-23) and a fix (2026-05-14); issues _are_ still being triaged (#2168 closed
2026-07-23); ~5.2k stars; effectively one maintainer; an unreleased `next-release` branch with no
announced v2. Verdict: alive but slow, and the single largest third-party risk in the frontend.

> **Never import `VueFlow` directly in a view.** Create `src/components/graph/GraphCanvas.vue`
> exposing your own props (`{ nodes: PlanNodeVM[]; edges: PlanEdgeVM[]; selected?: NodeId }`) and
> your own events. Every view imports `GraphCanvas`. If Vue Flow stalls out you replace one file.

That facade costs about a day and also lets you swap the memory graph to a different renderer without
touching the plan graph.

**Performance ceiling — UNVERIFIED.** No official Vue Flow benchmark exists. Extrapolated from React
Flow's guidance and the identical one-DOM-subtree-per-node architecture: ~300–500 nodes smooth at
60fps with custom node components; 500–1,500 usable with `onlyRenderVisibleElements: true` and cheap
node bodies; stalls during pan/zoom beyond roughly 2,000 nodes or 4,000 edges. Plan graphs of 40–200
nodes sit comfortably inside the smooth band. **Measure with the 400-node stress fixture in week one**
before committing the memory graph (§6.4) to Vue Flow.

**Animation — corrected.** Do **not** author your own `translate3d` transitions on nodes. Vue Flow
writes an inline `transform` on `.vue-flow__node` and will overwrite yours. Add only:

```css
.vue-flow__node {
  transition: transform 200ms ease-out;
}
```

and disable that transition during node drag and during viewport pan/zoom, or dragging feels like
it is fighting you.

**Layout: `elkjs@^0.12.0` in a Web Worker**, with `@dagrejs/dagre@^3.0.0` as the fast path for
sub-16ms relayout while a run is streaming node additions, and for the minimap pre-pass.

> **Never install `dagre`.** Not because of any docs example — the Vue Flow docs already import
> `@dagrejs/dagre`, so that commonly-repeated claim is false. The reason is simply that unscoped
> `dagre@0.8.5` last shipped **2019-12-03**. Note also that the docs' repl pins
> `@dagrejs/dagre@1.1.2`, two majors behind 3.0.0, so copied example code targets an older API.

The cheapest stability lever, and the one to do first: set
`org.eclipse.elk.layered.considerModelOrder.strategy = 'NODES_AND_EDGES'` and always feed ELK the
node array **in ledger-insertion order**, which the projection already has for free. ELK then keeps
relative ordering stable across plan versions with no per-node constraints at all.

Worker wiring for Vite 8 — elkjs is GWT-transpiled and its documented `workerUrl` option assumes a
publicly-served path that does not survive Vite's asset hashing. Use Vite's native worker import:

```ts
// src/graph/elk.worker.ts
import "elkjs/lib/elk-worker.min.js";

// src/graph/layout.ts
import ElkWorker from "./elk.worker?worker";
import ELK from "elkjs/lib/elk-api";
const elk = new ELK({ workerFactory: () => new ElkWorker() });
```

**Unverified.** elkjs's own README acknowledges bundler friction and this could not be built during
research. Spike it in M0 alongside the ACP spike. Fallback if it resists: `@dagrejs/dagre` for the
live graph, and run ELK on the main thread only for the cached scrubber layouts, where a slower call
is acceptable.

### 6.2 Plan-evolution scrubber (F10.2)

The marquee feature. Its entire value is that a human can see _what changed_, so any layout that
reflows between versions destroys it.

**Two honesty markers first**, because both claims circulate:

- "No npm package does visual DAG diffing" is an **unverifiable negative**. A search found none as of
  mid-2026; that is not proof one does not exist. It does not change the decision — nothing suitable
  was found, so this gets built — but do not repeat it as fact.
- "About 200 lines" is an **estimate, and an optimistic one** given the five pieces enumerated below.
  Budget accordingly.

**The algorithm.**

1. **Identity is `nodeId`, assigned by the planner and stable across `PlanPatch`es.** Never derive
   identity from position or label. This is an **explicit contract in the `PlanGraph` schema**, and
   the daemon asserts it: if the planner ever reuses or renumbers ids, both this view and the memory
   graph's provenance produce silently wrong output. Edge identity is `${source}->${target}`.

2. **Content hash per node** over the fields whose change matters: `type`, `provider`, `permission`,
   `brief`, `reads[]`, `writes[]`, retry policy. Use **`ohash@^2.0.11`** for stable key ordering,
   which `JSON.stringify` does not give you. Caveat, verified: ohash's README promises only
   _"best efforts"_ at stable serialisation — that is fine for a change-detection hash and **not**
   fine for anything needing cryptographic stability across versions. Store as `node.contentHash`.

3. **Set diff.** `added = ids(Vb) \ ids(Va)`, `removed = ids(Va) \ ids(Vb)`,
   `changed = intersection where contentHash differs`, `unchanged = the rest`. Same for edges.
   For the field-level "why did this change" panel use **`rfc6902@^5.3.0`** (2026-07-23) to produce a
   JSON Patch between the two node objects — **not** `fast-json-patch`, which last shipped in 2022.
   Render the patch beside the human-readable `reason` string from the `plan.patched` event.

4. **Union layout, computed once and cached — this is the whole trick.** Lay out the _union_ graph
   (every node and edge appearing in **either** version) once with ELK, and cache those positions
   under the `unionLayoutKey` the diff endpoint returns. Both versions render at those coordinates.
   **Nothing moves as you scrub.** Removed nodes render in place at reduced opacity with a dashed
   stroke; added nodes get a solid accent border and a `+` badge; changed nodes get a modified marker
   and a click-through to the field patch.

5. **Interactive ELK constraints are an experiment, not the design.** The obvious extension —
   maintain one running layout for the whole run by passing each surviving node's previous layer
   index as `layering.layerChoiceConstraint` and its in-layer index as
   `crossingMinimization.positionChoiceConstraint` — **will not work as commonly written.** Those
   options are only consumed when `org.eclipse.elk.interactiveLayout = true`; `semiInteractive`
   reads `org.eclipse.elk.position` rather than `positionChoiceConstraint`; and constraint
   enforcement is a known elkjs weak spot. Treat it as a spike. The union-graph-laid-out-once
   approach is the load-bearing mechanism and is sufficient on its own.

**UI shape.** A horizontal version rail (v1…vN) with tick marks coloured by patch decision
(`auto` / `approved` / `rejected`, straight off `plan.patched`), left/right arrow keys to step, and
the patch reason pinned in a side panel. Because the store is a projection, "show me version N" is
`replayTo(planVersionSeq[N])` — hydrated from the snapshot endpoint (§5.3), never replayed from zero.

**Fallback for comparing non-adjacent versions:** full reflow with a FLIP animation. Cheaper to build
but on a real 40-node replan the reflow is too large for the eye to track. Acceptable as a secondary
mode; never as the primary one.

### 6.3 Node inspector (F10.3)

No library. A `resizable` split panel over the graph, fed by
`GET /api/runs/:id/nodes/:nodeId?attempt=`: assembled context packet with per-segment token
breakdown, exact prompt, raw output, normalised/validated output, provider + model + CLI version +
binary sha256, permission level, duration, cost, retry history, worktree path.

Two details that carry it: an **attempt selector** (retries are the interesting case, and comparing
attempt 1 to attempt 3 side by side is how you diagnose a repair loop), and **every value linked to
the `seq` that produced it** — clicking a token count jumps the debug ring to the `context.built`
event. That link is NF10 made visible, and it is what turns the inspector from a dashboard into a
diagnostic tool.

Code blocks use the shared Shiki highlighter (§7). Sparklines are raw `<path>` from `d3-shape`'s
`line()`.

### 6.4 Memory and data-flow graph (F10.4)

A second graph over the blackboard: facts as nodes, reads and writes as edges. Click a fact for
provenance and every consumer.

This is the view most likely to exceed Vue Flow's ceiling, because facts × reads/writes can reach
thousands of edges on a long run.

> **Solve it in product before you solve it in rendering.** Aggregate facts by producing node and
> expand on demand. The default view is one bubble per node with a fact count; clicking expands that
> node's facts inline.

That is cheaper to build, dramatically more readable, and it is what an operator actually wants —
"which node produced the wrong assumption?" not "here are 3,000 dots". Only if the expanded view
genuinely exceeds ~1,500 nodes should you reach for a WebGL renderer, and then the escape hatch is
`sigma@^3.0.3` + `graphology@^0.26.0` (comfortable into the tens of thousands) or
`@cosmograph/cosmos@^3.4.1` for GPU force layout at 100k+. Because everything goes through the
`GraphCanvas` facade (§6.1), that swap touches one file and does not disturb the plan graph.

### 6.5 Context-budget stacked bars (F10.5)

`d3-shape`'s `stack()` over the `ContextPacket` segments (pinned constraints / spec / retrieved facts
/ tool output / history), one bar per node invocation, rendered as Vue-templated `<svg>`/`<rect>`.
Compaction events are `<line>` annotations at the `seq` of each `context.compacted` event; hover
shows before → after token counts and dropped handles, with a link to the full original artifact.

One correctness requirement inherited from the domain model: `context.compacted` carries a
`fidelity: 'exact' | 'partial'` discriminator, because vendor-side compaction reports only a
pre-token count. **When `fidelity` is `'partial'`, render the gap as a gap.** A bar with a fabricated
"after" number is worse than an honest hole. See [context and memory](./08-context-and-memory.md).

### 6.6 Live agent streams (F10.6)

**`@xterm/xterm@^6.0.0`** and addons, all published 2025-12-22: `@xterm/addon-fit@^0.11.0`,
`@xterm/addon-webgl@^0.19.0`, `@xterm/addon-serialize@^0.14.0`, `@xterm/addon-search@^0.16.0`,
`@xterm/addon-unicode11@^0.9.0`, `@xterm/addon-web-links@^0.12.0`. Optional and worth it:
`@xterm/addon-progress@^0.2.0` (new in v6, renders OSC 9;4 progress — useful for long agent steps).

The scope migration is complete: unscoped `xterm` is frozen at 5.3.0 (2023-09-07). The PRD's package
name is stale.

**v6 breaking changes:**

| Change                                                               | Consequence                                                                                           |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `@xterm/addon-canvas` **removed** (last published 0.7.0, 2024-04-05) | Renderer is DOM (default) or WebGL. Load `addon-webgl`, fall back to DOM on its `onContextLoss` event |
| `windowsMode` removed                                                | —                                                                                                     |
| `fastScrollModifier` removed                                         | —                                                                                                     |
| `ITerminalOptions.overviewRulerWidth` moved under `overviewRuler`    | —                                                                                                     |
| Viewport/scrollbar replaced with VS Code's                           | —                                                                                                     |
| alt → ctrl+arrow hack removed                                        | Add your own keybinding if you want it                                                                |
| Real ESM (`module: lib/xterm.mjs`)                                   | Vite handles it with no interop hacks                                                                 |

**Scrollback arithmetic, read out of the v6 source rather than a blog. Verified 2026-08-02:**
`BufferLine` allocates `new Uint32Array(3 * cols)` = **12 bytes per cell**. Default option is
`scrollback: 1000`. `MAX_BUFFER_SIZE` is 4294967295.

| Columns | Per line                                  | 5,000 lines | 10,000 lines | 100,000 lines |
| ------- | ----------------------------------------- | ----------- | ------------ | ------------- |
| 200     | ~2.4 KB raw, ~2.6 KB with object overhead | **≈ 13 MB** | ≈ 26 MB      | ≈ 260 MB      |

That is **per terminal**. Several node terminals open at 100k scrollback is a dead tab.

> **Set `scrollback: 5000` and never raise it.**

The daemon already writes `runs/<runId>/nodes/<nodeId>/stdout.log` (NF8) — the browser terminal is a
**live tail, not the archive**. Provide an explicit "Open full log" that streams the artifact into a
virtualised read-only viewer (`@tanstack/vue-virtual@^3.13.35`, line-indexed, byte-range fetches),
never into xterm. Same rule when reattaching to a running node: ask for the last N KB via
`GET /api/runs/:id/nodes/:nodeId/io` (see [the API contract](./11-api-and-realtime.md)), not the
whole file.

**Dispose and serialise.** One `Terminal` per _visible_ terminal, never per _opened_ terminal.
`Terminal` objects hold large typed arrays and, with the WebGL addon, a GL context — and browsers cap
WebGL contexts at roughly 8–16, so enough undisposed terminals silently kills rendering in the oldest
ones. On unmount or tab-hide: take an `@xterm/addon-serialize` snapshot string, `term.dispose()`,
keep only the string. On re-show: construct a fresh `Terminal` and `write()` the snapshot back. Total
memory becomes proportional to _visible_ terminals rather than to every terminal ever opened. Keep
the raw `Terminal` in `markRaw` so Vue's proxy never touches it.

**For structured output, skip xterm entirely.** ACP streaming updates (F3.1) are typed JSON, not a
TTY byte stream. Render them as a **virtualised list of typed message components** — faster,
searchable, selectable, diffable, themeable, and accessible. Use xterm only for the CLI-shim adapters
where the output genuinely is ANSI with cursor movement and spinners.

### 6.7 Diff and review surface (F10.7, F7.7)

**`@git-diff-view/vue@0.1.7`** + `@git-diff-view/core@0.1.7` + `@git-diff-view/shiki@0.1.7`
(all 2026-07-13, peer `vue ^3`). **Pin exactly, with no caret** — it is pre-1.0 — and read the
changelog before bumping.

The reason it wins is narrow and decisive: **first-class inline widget/extend slots per line.** F7.7
requires gate verdicts attached inline at file and line. `diff2html@3.4.56` is alive and fine at what
it does, but it is a string → HTML generator: you get an HTML blob, not components, so attaching Vue
verdict widgets at specific lines means DOM surgery. Wrong shape for the requirement.

**Have `DeFlowd` shell out to `git diff` and ship the unified patch** over
`GET /api/runs/:id/diff` as `text/x-patch`. `@git-diff-view/core` parses a unified patch directly,
and this is orders of magnitude faster and more correct than diffing in JavaScript. Reserve
**`diff@^9.0.0`** (the `jsdiff` package — note the separate npm package literally named `jsdiff` is
abandoned, last publish 2014) for the cases where you only have before/after text in the browser:
plan JSON, `TaskSpec` edits.

CodeMirror 6's merge addon is the future path if the diff ever needs to be **editable** (operator
hand-fixes a hunk before approving). Much larger surface; defer past M1. Monaco is out — 3+ MB, and
it duplicates the editor the user already has open.

### 6.8 Acceptance-criteria board (F10.8)

The literal answer to "has the requested outcome been achieved". A table of the `TaskSpec` criteria
with live `satisfied` / `unsatisfied` / `unverifiable` status and the gate evidence behind each, from
the `gates.ts` projection joined to criterion ids.

Built from `shadcn-vue`'s `table` and `collapsible`. The one thing to get right: **`unverifiable` is
a first-class state, not a variant of failure** — a criterion with no gate mapped to it is a spec
defect (F7.4 requires every criterion map to at least one gate), and the board is where you find out.
Colour it distinctly from both pass and fail, with its own glyph and label.

### 6.9 Run timeline / Gantt (F10.9)

`d3-scale`'s `scaleTime` for x, `scaleBand` for lanes, one `<rect>` per node execution, a second
y-axis carrying an area or line for cumulative cost. The data prep is the `timeline.ts` projection
you have anyway — `node.started` / `node.completed` for spans, `budget.consumed` for cost.

Roughly 150 lines. No Gantt library is needed, and none of the Vue chart libraries ships one.

**Install d3 submodules, never the metapackage.** `d3@7.9.0` drags in ~30 modules. Install exactly:
`d3-scale@^4.0.2`, `d3-array@^3.2.4`, `d3-shape@^3.2.0`, `d3-axis@^3.0.0`,
`d3-time-format@^4.1.0`, `d3-interpolate@^3.0.1`, `d3-color@^3.1.0`. These have not needed releases
since 2021–2023 because they are finished; that is not abandonment.

> **Use d3 only as a maths library** — scales, stacks, ticks, time formatting — and render with Vue
> templates emitting `<svg>` / `<rect>` / `<path>`. **Never call `d3-selection` to mutate the DOM
> inside a Vue component.** Two owners of the same nodes produces bugs you cannot fix.

The payoffs are concrete: the SVG is fully themeable by the CSS custom properties in §9, and the DOM
is yours to put ARIA on.

For the **P1** cross-run dashboard (F10.11) — genuinely generic charts with legends, brushing and
zoom — `echarts@^6.1.0` + `vue-echarts@^8.0.1` is worth it, imported from `echarts/core` with
explicit chart and component registration so you pull ~150 KB rather than ~1 MB. That is the only
place a chart library earns its keep, because it is the only place the charts are not bespoke.

---

## 7. Shiki

**`shiki@^4.4.1`** (2026-07-31). The whole family is version-locked at 4.4.1: `@shikijs/core`,
`@shikijs/langs`, `@shikijs/themes`, `@shikijs/transformers`, `@shikijs/engine-javascript`,
`@shikijs/engine-oniguruma`.

Two packages map directly onto PRD requirements the PRD did not know existed:

| Package                      | What it does                                                                                                                                                 | Requirement it serves                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `@shikijs/stream@^4.4.1`     | "Streaming colorization … useful for highlighting text streams like LLM outputs" — incremental highlighting without re-tokenising the whole buffer per chunk | **F10.6 / F10.3** for structured (non-TTY) agent output                                                        |
| `@shikijs/magic-move@^4.4.1` | Token-level animated transitions between two code states                                                                                                     | **F7.5** surgical-repair loop — animate before/after so the operator sees precisely what the fix agent touched |

`@shikijs/magic-move` on the repair loop is the single highest-ratio visual win in the app: it makes
"one issue, one fix, capped at three attempts" legible at a glance instead of requiring a diff read.

**Bundle discipline.**

> **Never import the bundled `shiki` entry.** It pulls every grammar — multiple megabytes.

Use `createHighlighterCore` from `@shikijs/core` with the JavaScript regex engine
(`@shikijs/engine-javascript`, so there is no WASM download), and lazily import only the languages
this tool actually needs: `ts, tsx, js, jsx, vue, json, yaml, python, go, rust, sql, bash, diff,
markdown`. **Instantiate exactly one highlighter for the whole app** and share it — the node
inspector, the diff view, the plan JSON view and the streaming output view all use the same
instance.

---

## 8. Styling

> **Superseded in part by [the design system](./design-system.md) (EPIC-24, 2026-08-18).**
> The conclusion of §8.1 — vendored component source, in this repository, ours to edit — is what
> shipped, and `packages/web/src/components/ui/` is it. The route named below is not: `shadcn-vue`'s
> CLI was **not** used, because it generates a generic light/dark look that would then have to be
> overridden into the supplied prototype's, which is precisely the specificity war §8.1 warns
> about. `reka-ui` stays and does exactly what §9.3 credits it with. Read §8.1 for the reasoning
> and `design-system.md` for what exists.

**`tailwindcss@^4.3.3`** and **`@tailwindcss/vite@^4.3.3`** (both 2026-07-16). v4 is CSS-first: no
`tailwind.config.js`, no PostCSS step. You write `@import 'tailwindcss'` and a `@theme { --color-… }`
block in a CSS file, and add the plugin to `vite.config.ts`.

**`shadcn-vue@^2.8.1`** (2026-07-29) — CLI-driven, copies component **source** into
`src/components/ui/`. It sits on **`reka-ui@^2.10.1`** (2026-06-26), which **is** the renamed and
current `radix-vue`. `radix-vue@1.9.17` (2025-02-28) is the dead name — never install it.
shadcn-vue 2.x initialises Tailwind v4 projects natively with `@theme` / `@theme inline` support.

Supporting deps it expects: `tailwind-merge@^3.6.0`, `clsx@^2.1.1`,
`class-variance-authority@^0.7.1`, `lucide-vue-next@^1.0.0` (2026-03-23, now 1.0 stable).

Install only what nine views need, and skip the rest: `button, dialog, dropdown-menu, tabs, tooltip,
popover, select, badge, separator, scroll-area, resizable, command, sheet, toast, collapsible,
table`.

### 8.1 Why vendored components are _lower_ maintenance, not higher

This reads backwards and is worth stating plainly, because the instinct is that owning source means
owning maintenance.

For a **dense operator UI**, a general-purpose component library's recurring tax is the theme-override
CSS specificity war: you spend the project's lifetime fighting someone else's opinion about padding,
row height and colour, and every minor bump can restyle your app overnight. Vendored components
invert that:

- The components are **your source files in your repo**. A Reka UI minor bump cannot change how your
  app looks.
- There is no override layer at all, so no specificity war.
- You can add a token-count column or a run-state chip by _editing the component_, which is exactly
  what a data-dense status UI keeps needing.

The maintenance you take on is real but **bounded**: you own about sixteen small files. That is the
concrete expression of PRD §13's "visualisation scoped to nine P0 views, not a design system".

Two layout primitives to take and not build: `resizable` (split pane for graph-over-inspector) and
`command` (Cmd-K run/node jumper). Those two carry an operator UI further than any amount of visual
polish.

---

## 9. Accessibility and dark mode, day one

Retrofitting hardcoded colours across nine views is the expensive path. Doing tokens on day one costs
hours.

### 9.1 One state palette, seven views

Define the **entire** node-state palette as CSS custom properties, not Tailwind classes:

```css
:root {
  --state-pending: …;
  --state-running: …;
  --state-blocked: …;
  --state-passed: …;
  --state-failed: …;
  --state-abandoned: …;
  --state-awaiting-human: …;
}
.dark {
  /* redefine the same seven */
}
```

Every surface reads the same variable: Vue Flow node borders, Gantt bars, context-budget segments,
gate chips, criteria rows, the version rail, the memory graph. **One definition, seven views stay
consistent, and both themes work by construction** because you only redefine the variables. Dark mode
is `useDark()` from `@vueuse/core@^14.4.0` (2026-07-29) flipping a `.dark` class on `<html>`.

### 9.2 Never encode state by colour alone

F10.1 names seven states. **Colour + glyph + text label, every time.** This is a WCAG 1.4.1
requirement and it is also simply better for a status board — roughly 8% of male engineers will
otherwise misread the graph. Pick hues with a perceptual gap and check contrast on both themes.

### 9.3 What you get free, and must not undo

| Source                     | What it gives                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reka UI (under shadcn-vue) | Focus trap, roving tabindex, `aria-expanded`/`aria-controls`, escape and outside-click for every overlay — the parts of a11y that are genuinely hard                                                                                                                                                                                                                     |
| Vue Flow 1.48.2            | `aria-live`, `aria-label`, `aria-describedby`, `aria-roledescription`, keyboard node traversal. **Verified in the bundle.** Do **not** set `disableKeyboardA11y`. **Do** set a meaningful per-node `ariaLabel` from the view-model: `` `${node.type} ${node.title}, ${node.state}, ${node.provider}` `` — that one line is most of what a screen reader needs from a DAG |
| xterm.js                   | `screenReaderMode`. Leave it **off** by default (it is expensive) and expose it as a setting                                                                                                                                                                                                                                                                             |

### 9.4 Cheap wins with outsized payoff

- **`prefers-reduced-motion`** honoured on the scrubber and graph transitions — wrap the `transform`
  transitions in the media query.
- **Visible `:focus-visible` rings everywhere.** Never `focus:outline-none`.
- **A skip-link** to main content.
- **Every chart non-visually reachable:** `<title>` and `aria-label` on each `<svg>`, plus a
  toggleable data-table view for the Gantt and the stacked bars. That is a ~20-line component and it
  doubles as the copy-paste-into-a-PR-description surface for F10.13.

### 9.5 Keyboard map

For hours-long work this is the accessibility feature you will personally use most.

| Key       | Action                                        |
| --------- | --------------------------------------------- |
| `j` / `k` | Move between nodes in the graph               |
| `Enter`   | Open the node inspector for the selected node |
| `←` / `→` | Step the plan-version scrubber                |
| `/`       | Search                                        |
| `Cmd-K`   | Run / node jumper (`command`)                 |
| `Esc`     | Close the topmost overlay                     |

---

## 10. Bundle budget for NF3

NF3 is "UI interactive < 1s on localhost". **Plausible but contingent** — it depends entirely on
what lands in the initial chunk.

**Budget: ~220 KB gzip for the initial shell.** Everything else is route-split or worker-loaded.

> **Raised from 200 KB on 2026-08-18 (KAR-24.9), by the owner's decision.** EPIC-24 gave the
> application a frame — a rail, a project switcher, a breadcrumb topbar, a run status pill and
> fifteen vendored components on a token layer — and that cost ~23 KB gzip: **189.6 KB before the
> epic, 212.6 KB after**, measured with the same build on the same machine. The 200 KB line was
> drawn when this was a viewer you reached by typing a run id into the address bar, and a ceiling
> the shipped shell cannot fit under is not a budget — it is a permanently red test somebody
> eventually deletes. 220 leaves ~7 KB of headroom, which is about what 200 left before the frame:
> deliberately tight, so the next feature that wants 20 KB of the first chunk has to come and argue
> for it.
>
> **The alternative was rejected rather than missed.** `@vue-flow/core` is 69 KB of that chunk and
> the row below says it is there because "the plan graph *is* the landing view" — which
> [KAR-19.1](./delivery/epics/EPIC-19-live-run-pipeline.md) falsified when it made the run list the
> root route. Making the run-plan route lazy takes the initial chunk to roughly **143 KB**, at the
> cost of one load on the way into a run. That is the first thing to reach for if this number needs
> to come down again; it was not done here because it is an architecture change and this was a
> budget decision.

| Cost               | Size                               | Where it goes                                                                             |
| ------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| elkjs              | ~1.6 MB raw                        | **Web Worker**, via `?worker` import. Never in the initial chunk (§6.1)                   |
| Shiki grammars     | multi-MB if bundled                | `createHighlighterCore` + ~12 lazily imported langs. Never the bundled `shiki` entry (§7) |
| `@xterm/*`         | —                                  | Route-split: the terminal view is a lazy route                                            |
| `@git-diff-view/*` | —                                  | Route-split: the diff/review view is a lazy route                                         |
| `@vue-flow/core`   | 345 KB raw                         | Initial chunk — the **run route** is eager. Not the landing view since KAR-19.1; see the note above |
| `echarts`          | ~150 KB with explicit registration | P1 only, lazy, cross-run dashboard route                                                  |

Serving is local, so transfer time is near zero and the budget is really about **parse and execute**
time. Measure with the 400-node stress fixture through `deflow replay`, not with an empty run.

Nothing in this stack is Chrome-only, which keeps the M3 Tauri shell open: Tauri's WebView is
WKWebView on macOS and WebKitGTK on Linux, and SSE, WebGL, Web Workers and WebStreams are all
available on both.

---

## 11. What not to do

- **Do not use a query cache for run state.** TanStack Query and Pinia Colada are key-scoped fetch
  caches; the run state is an ordered log. Colada is correct for the flat REST endpoints and nowhere
  else (D11).
- **Do not use deep `reactive()` over ledger-derived collections.** `shallowRef` + `markRaw` +
  version counter. This is the most likely cause of missing NF3.
- **Do not retain the raw event array.** Apply and drop; bounded ring of ~2,000 for the debug pane.
- **Do not replay from `seq` 0 in the browser** to scrub. Use `GET /api/runs/:id/snapshot?seq=N`.
- **Do not raise xterm's scrollback above 5,000.** 12 bytes per cell is linear and unforgiving.
- **Do not leave `Terminal` instances undisposed.** WebGL contexts are capped at roughly 8–16 and the
  failure is silent, in the oldest terminals.
- **Do not use `@xterm/addon-canvas`** — removed in v6. DOM or WebGL only.
- **Do not install the dead names:** `dagre` (2019), `radix-vue` (superseded by `reka-ui`), unscoped
  `xterm` (2023), `jsdiff` (2014), `fast-json-patch` (2022), `diff2html` for F7.7 (wrong shape, not
  dead).
- **Do not import `VueFlow` directly in a view.** Everything goes through `GraphCanvas.vue`.
- **Do not author your own node `transform` animation.** Vue Flow writes an inline `transform` and
  overwrites yours; add a CSS `transition` only, and disable it during drag and pan/zoom.
- **Do not relayout from scratch on every `PlanPatch`.** Union-graph layout, computed once, cached.
- **Do not derive node identity from position or label.** `nodeId` from the planner, stable across
  patches, asserted in the daemon.
- **Do not call `d3-selection` inside a Vue component.** d3 is a maths library here.
- **Do not import the bundled `shiki` entry.**
- **Do not encode the seven node states by colour alone.**
- **Do not set up Storybook or Histoire.** Histoire is stalled at `1.0.0-beta.1` (2026-01-07), and
  Storybook is a second build pipeline plus a second set of fixtures. The `deflow replay` harness is
  strictly better: it exercises real data through the real store through the real components, and it
  doubles as the internal demo tool.
- **Do not upgrade to Vue 3.6** until Vue Flow publishes a release naming it.

---

**Related:** [API and realtime](./11-api-and-realtime.md) · [Domain model](./04-domain-model.md) · [Tech stack](./02-tech-stack.md) · [Local development](./03-local-development.md) · [Testing strategy](./14-testing-strategy.md)

[← Back to index](./README.md)
