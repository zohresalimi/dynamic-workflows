# EPIC-17: P0 visualisation views

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-17-p0-views-flows.md)

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Epic ID**          | EPIC-17                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Status**           | Not started                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Priority**         | P0                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Milestone**        | M1                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Workstream**       | W11 (see [roadmap §2.2](../../17-roadmap.md))                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Size**             | ~28 days across 9 stories — **far over the guideline; see Risks and the roadmap §3 recommendation**                                                                                                                                                                                                                                                                                                                                              |
| **Depends on**       | EPIC-16 (all six stories), EPIC-15 KAR-15.6 (read endpoints), EPIC-13 (the approval surfaces KAR-17.3 and KAR-17.7 render), EPIC-12 (verdicts and findings), EPIC-11 (plan versions and patch decisions), EPIC-10 (the acceptance criteria KAR-17.7 boards), EPIC-09 (packets and compaction events) · EPIC-18 KAR-18.3 **soft** — scheduling only, not a build dependency ([roadmap §2.3](../../17-roadmap.md): no W11 before one headless run) |
| **Blocks**           | — (this is the last workstream on the M1 critical path)                                                                                                                                                                                                                                                                                                                                                                                          |
| **PRD requirements** | F10.1, F10.2, F10.3, F10.4, F10.5, F10.6, F10.7, F10.8, F10.9, F7.7, and the visible half of F7.3, F7.4, F6.3, F6.6, F9.1                                                                                                                                                                                                                                                                                                                        |
| **Architecture**     | [12-frontend-architecture.md §6](../../12-frontend-architecture.md) (all nine subsections), §7, §9 · [11-api-and-realtime.md §6, §7.4, §7.6](../../11-api-and-realtime.md) · [17-roadmap.md §3](../../17-roadmap.md)                                                                                                                                                                                                                             |

## Goal

At the end of this epic the answer to _"why did this run do that?"_ is a screen rather than a
transcript. The Operator can watch a plan execute live, drag a rail back to the original plan and
step forward through every patch reading why it was proposed, open any node and see the exact bytes
it received with a per-segment token breakdown, watch a gate fail and land on the offending line of
the diff with the verdict attached, and check off the acceptance criteria against real gate evidence.

The measurable target is the PRD's own: **median time-to-diagnose a failed run under five minutes**
(§12). That number, not the visual polish, is what decides whether this epic succeeded — and this
epic's flow file ends with an end-to-end scenario that measures it.

## Why this matters

PRD §2.1's third broken thing is the reason DeFlow exists at all: _"Nobody knows why it went wrong.
When a 40-step run produces a bad diff, the question is which step poisoned it and what context that
step actually received. Tools log stdout. They don't show the assembled context packet, the memory
that was shared, or what compaction deleted."_

Every other epic in this plan produces the data that answers that question. This one is where the
answer becomes visible, and the competitive table in PRD §4.8 says plainly that the graph-and-context
visualisation column is empty for every competitor — session managers have a board and no graph,
workflow runners have no UI, trace viewers render a tree of spans after the fact and _"cannot show a
plan graph, cannot show plan evolution, cannot show what a context packet contained versus what was
compacted away, and you cannot intervene in a run from them"_ (§4.6).

Two views carry a disproportionate share of that:

- **The plan-evolution scrubber (F10.2) is the marquee feature.** It is the direct visual expression
  of "dynamic workflow", it is the answer to _"why is there a step here that I didn't ask for?"_ in
  one click, and it is the demo — PRD §15.4 and [roadmap §7](../../17-roadmap.md) both say the
  strongest internal presentation is a real Voyado task shown through the scrubber.
- **The node inspector (F10.3)** answers "which step poisoned it and what did it actually receive" in
  one screen, and with the provenance table folded in (per [roadmap §3](../../17-roadmap.md)) it also
  answers the 80% of the memory-graph question at roughly forty lines of markup.

And one risk sits over the whole epic and must be stated up front rather than discovered: PRD §13
names _"the visualisation is pretty but not diagnostic"_ as a Medium risk with the mitigation
_"metric: median time-to-diagnose. If it doesn't drop, the views are wrong."_ That is why S35 in the
flow file is a timed, scripted diagnosis run rather than a demo script.

## Scope

**In scope:**

- Nine views, each a component tree over the projections EPIC-16 already computes: live plan graph,
  plan-evolution scrubber, node inspector, context-budget stacked bars, live agent output, diff and
  review with inline verdicts, acceptance-criteria board, run timeline with cost overlay, and the
  memory / data-flow graph.
- The scrubber's diff algorithm: stable `nodeId` identity, `ohash` content hashes, set diff over
  nodes and edges, `rfc6902` field-level patches, and the **union-graph layout computed once and
  cached** under the `unionLayoutKey` the diff endpoint returns.
- The inspector's attempt selector and the `seq` link-through on every displayed value.
- The shared Shiki highlighter — exactly one `createHighlighterCore` instance for the whole app —
  plus `@shikijs/stream` for streaming output and `@shikijs/magic-move` on the repair loop.
- The diff surface on `@git-diff-view/vue@0.1.7` (pinned exact) consuming a unified patch produced by
  `git diff` server-side, with per-line widget slots carrying gate findings.
- A data-table twin for every chart, which doubles as the copy-into-a-PR-description surface.
- The reduced-fidelity M1 decisions the roadmap recommends, taken explicitly rather than by omission.

**Out of scope:**

- **Everything EPIC-16 owns:** the shell, the stream client, the projections, the store, the replay
  harness and the `GraphCanvas` facade. This epic renders; it does not compute.
- **Every read endpoint these views call** — [EPIC-15](./EPIC-15-daemon-api.md) KAR-15.6 and
  KAR-15.7. The shapes are the contract; this epic asserts against them.
- **Producing the data.** Verdicts and findings are [EPIC-12](./EPIC-12-verification-gates.md);
  packets and compaction events are [EPIC-09](./EPIC-09-context-memory.md); plan versions and patch
  decisions are [EPIC-11](./EPIC-11-dynamic-planning.md); cost events are
  [EPIC-14](./EPIC-14-cost-governance.md).
- **The approval queue UI, interjection UI and permission-escalation dialogs.**
  [EPIC-13](./EPIC-13-human-in-the-loop.md) defines those projections; their surfaces are P0 but they
  belong to that epic's stories, not to the nine views.
- **Run replay as an operator feature (F10.10)**, the cross-run dashboard (F10.11), OTel export
  (F10.12) and the shareable HTML report (F10.13). All P1/P2.
- **Hand-editing a running plan.** PRD §15.3 and [roadmap §7](../../17-roadmap.md) both defer it past
  M1: read and approve is required, direct editing is a large UI surface and this epic is already too
  large.
- **A design system.** PRD §13's mitigation is _"visualisation scoped to nine P0 views, not a design
  system"_, and [12 §8.1](../../12-frontend-architecture.md) bounds the component ownership at about
  sixteen vendored files.
- **Editable diff hunks.** CodeMirror 6's merge addon is the future path if the operator ever needs
  to hand-fix a hunk before approving; much larger surface, deferred past M1.

## Definition of Ready (epic level)

- [ ] **EPIC-16 Done.** All six stories, including the committed 400-node measurement — that number
      decides KAR-17.9 and it changes KAR-17.1's defaults.
- [ ] **EPIC-15 KAR-15.6 and KAR-15.7 Done.** `/runs/:id/plans`, `/plans/:version`, `/plans/diff`,
      `/nodes/:nodeId`, `/nodes/:nodeId/packet`, `/nodes/:nodeId/io`, `/facts`, `/gates`,
      `/criteria`, `/findings`, `/diff` and `/snapshot` all serve their documented shapes.
- [ ] **The six replay fixtures exist and are recorded**, not hand-written. Every story below is
      developed and tested against one of them.
- [ ] **The author has taken the roadmap §3 decision** on whether M1 ships nine views or the
      recommended seven-with-two-reduced. This epic is written to make either choice explicit rather
      than accidental — see KAR-17.5 and KAR-17.9.
- [ ] `Verdict`, `Finding`, `ContextPacket`, `Segment`, `PlanGraph` and `AcceptanceCriterion` are
      landed in `@DeFlow/core` and exported type-only.

## Definition of Done (epic level)

- [ ] All stories except KAR-17.9 Done; KAR-17.9 either Done or explicitly deferred to M2 with the
      decision and its reason recorded in `docs/measurements/vue-flow-400.md`.
- [ ] Every scenario in [the flow file](../flows/EPIC-17-p0-views-flows.md) exists as an automated
      test at the level its `Automated at:` line names.
- [ ] **EPIC-17-S35 passes: a scripted diagnosis of `gate-fail-repair` from "the run is red" to
      "here is the node, here is the context it received, here is the line" completes in under five
      minutes**, timed, on at least three different seeded failure fixtures. This is the PRD §12
      metric and it is a gate on the epic, not a report on it.
- [ ] The five Playwright E2E smokes from [14 §13](../../14-testing-strategy.md) all pass against
      `deflow replay` — and there are still only five.
- [ ] Nothing in `packages/web/src` outside `components/graph/` imports `@vue-flow/core`, and nothing
      outside `ledger/projections/` contains reduction logic.
- [ ] Every view renders correctly in both themes and under `prefers-reduced-motion`, and no state is
      encoded by colour alone.
- [ ] Every chart has a `<title>`, an `aria-label` and a toggleable data-table view.
- [ ] The production bundle still meets the ≤ 200 KB gzip initial-chunk budget with all nine views
      built: `@xterm/*`, `@git-diff-view/*` and the memory graph are lazy routes.

## User stories

Build order is [roadmap §3](../../17-roadmap.md)'s argument, not the numeric order:
**17.1 → 17.3 → 17.2 → 17.4** carry the diagnosis metric and are the shell everything else hangs
off; then **17.6 → 17.7 → 17.8**; then **17.5** at whichever fidelity was chosen; **17.9** last, and
possibly not at all in M1.

### KAR-17.1 — Live plan graph

|                 |                                                             |
| --------------- | ----------------------------------------------------------- |
| **Status**      | Not started                                                 |
| **Priority**    | P0                                                          |
| **Size**        | M                                                           |
| **Depends on**  | EPIC-16 KAR-16.6, EPIC-16 KAR-16.3                          |
| **PRD**         | F10.1, NF3                                                  |
| **Verified by** | EPIC-17-S1, EPIC-17-S2, EPIC-17-S3, EPIC-17-S4, EPIC-17-S35 |

**As** the Operator, **I want** the run's graph on screen with every node's live state, **so that**
one glance tells me what is running, what is blocked, what failed and what is waiting on me.

The landing view and the shell the other eight hang off. It renders `PlanNodeVM[]` and `PlanEdgeVM[]`
from `plan.ts` through `GraphCanvas`, with a custom node component — which is the entire reason Vue
Flow was chosen over the canvas-first alternatives: _a custom node **is** a Vue component_, which is
exactly what per-node live status, a streaming badge, a gate verdict chip and a cost figure need
([12 §6.1](../../12-frontend-architecture.md)).

Seven states by colour **and** glyph **and** text label, each reading its `--state-*` custom
property. Edges labelled with what flows across them — a `data` edge's `carries[]` is a field on the
`PlanEdge`, not an inference, which is what makes F10.1's _"edges labelled with what flows"_ real
rather than decorative.

Layout is dagre for the sub-16 ms relayout while a run is streaming node additions, ELK in the worker
for the settled layout, both fed nodes in ledger-insertion order with
`considerModelOrder.strategy = 'NODES_AND_EDGES'` so nothing reshuffles when a node arrives.
`onlyRenderVisibleElements` defaults from KAR-16.6's measurement rather than from taste.

**Inherited from EPIC-16 (recorded 2026-08-11).** This story also closes the two rendering clauses of
[EPIC-16-S1](../flows/EPIC-16-ui-foundation-flows.md) — _"the plan graph renders every node from the
hydrated state before the first live frame"_ and _"the node `n_impl_3` renders in the `running` state
within one frame"_. EPIC-16 finished with every piece built and **no wire between them**:
`PlanGraphView` renders from `useUiStore`, nothing in the shipped SPA calls `openLedgerStream`, and
`useUiStore.setNodes` has no production caller, so the app opened against a replay draws an empty
graph however deep the ledger is. Supplying that wire — `openLedgerStream` → `plan.ts` →
`useRunStore` → `GraphCanvas` — is the first thing this story does, and AC1 below is where the two
clauses land, at the e2e level EPIC-16-S1 names.

**Acceptance criteria**

1. Loading a completed run renders every node with its correct state colour, glyph and label, and
   every edge with its direction — Playwright smoke #1 from [14 §13](../../14-testing-strategy.md).
2. All seven states render distinctly: `pending`, `running`, `blocked`, `passed`, `failed`,
   `abandoned`, `awaiting-human`. `abandoned` is visually distinct from `failed` — a branch the
   planner gave up on is not a branch that broke.
3. A live `node.started` moves a node to `running` within one frame; `node.progress` updates the
   node's phase text without changing its state or triggering a relayout.
4. A node body shows: type glyph, title, state, provider and model, permission level, a streaming
   badge while running, a gate verdict chip where one applies, elapsed time and cost so far.
5. Data edges display their `carries[]` fact keys on hover and in the data-table twin; control edges
   do not pretend to carry anything.
6. Adding nodes mid-run (a `map` fan-out arriving over ten seconds) does not reshuffle existing
   nodes' relative order and does not drop below the measured frame budget.
7. Selecting a node highlights it and its immediate neighbourhood; `Enter` opens the inspector for
   it; `j`/`k` traverse; and the selection is reflected in the URL so a graph position is linkable.
8. On `stress-400`, the view meets the budget recorded in `docs/measurements/vue-flow-400.md`, with
   `onlyRenderVisibleElements` set per that measurement.
9. A minimap and zoom controls are present; `nodeExtent` prevents the graph being panned into empty
   space and lost.
10. The whole view has a data-table twin listing node, type, state, provider, permission, duration
    and cost — reachable by keyboard, and useful for pasting into a PR description.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level         | Test                                                                                                          | Red when                                                |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | unit          | `toNodeVM(projectionNode)` maps every state and never yields `undefined`                                      | A state added to the domain silently renders as pending |
| 2   | web (browser) | Mount with the `happy-path-12` projection; assert node count, edge count, and one node's full accessible name | Node bodies are Vue Flow defaults                       |
| 3   | web (browser) | Seven-state render matrix asserting colour token, glyph presence and text label                               | State is colour-only                                    |
| 4   | web (browser) | Apply `node.started` then three `node.progress` events; assert one state change and zero relayouts            | Progress is treated as a state transition               |
| 5   | web (browser) | `carries[]` rendered for a data edge, absent for a control edge                                               | Edge labels are faked from node titles                  |
| 6   | web (browser) | Insert 20 nodes over simulated time; assert pre-existing relative order unchanged                             | ELK ordering was not fed insertion order                |
| 7   | web (browser) | Keyboard: `j`, `k`, `Enter`; assert selection and inspector open                                              | Handlers live in a component that unmounts              |
| 8   | e2e           | `stress-400` through `deflow replay`; assert the frame budget from the measurement file                       | The measurement was never wired to a test               |
| 9   | e2e           | Playwright smoke #1: completed run, every node with the right state colour                                    | The graph renders from a fixture rather than the stream |

**Notes / risks** — do not test any of this in jsdom or happy-dom: no SVG measurement, no canvas, no
WebGL, and the failure is silent rather than loud ([14 §13](../../14-testing-strategy.md)).

---

### KAR-17.2 — Plan evolution scrubber

|                 |                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                       |
| **Priority**    | P0                                                                                                |
| **Size**        | L                                                                                                 |
| **Depends on**  | KAR-17.1, EPIC-16 KAR-16.3, EPIC-16 KAR-16.4, EPIC-15 KAR-15.6, EPIC-11 KAR-11.5                  |
| **PRD**         | F10.2, F2.6, F2.4, F2.5                                                                           |
| **Verified by** | EPIC-17-S5, EPIC-17-S6, EPIC-17-S7, EPIC-17-S8, EPIC-17-S9, EPIC-17-S10, EPIC-17-S11, EPIC-17-S35 |

**As** the Operator, **I want** to drag back to the plan I approved and step forward through every
patch with its reason, **so that** _"why is there a step here that I didn't ask for?"_ is answered in
one click instead of by reading a log.

**This is the marquee feature and the demo.** Its entire value is that a human can see _what
changed_ — so **any layout that reflows between versions destroys it**. On a real 40-node replan the
reflow is too large for the eye to track, and the operator ends up doing a visual diff by hand, which
is the thing the view exists to remove.

The mechanism is the union-graph layout, and it is the load-bearing part
([12 §6.2](../../12-frontend-architecture.md)):

1. **Identity is `nodeId`, assigned by the planner and stable across `PlanPatch`es** — never derived
   from position or label. This is an explicit contract in the `PlanGraph` schema and the daemon
   asserts it; if ids are ever reused or renumbered, this view and the memory graph produce silently
   wrong output. Edge identity is `` `${source}->${target}` ``.
2. **Content hash per node** over `type`, `provider`, `permission`, `brief`, `reads[]`, `writes[]`
   and retry policy, using `ohash@^2.0.11` for stable key ordering (`JSON.stringify` does not give
   you that). Change detection only — ohash promises _"best efforts"_ at stable serialisation, which
   is fine here and not fine for an identity.
3. **Set diff:** `added`, `removed`, `changed` (same id, different hash), `unchanged` — for nodes and
   for edges. For the field-level "why did this change" panel, `rfc6902@^5.3.0` produces a JSON Patch
   between the two node objects. **Not `fast-json-patch`**, which last shipped in 2022.
4. **Lay out the union graph once** — every node and edge appearing in _either_ version — and cache
   those positions under the `unionLayoutKey` the diff endpoint returns. Both versions render at
   those coordinates. **Nothing moves as you scrub.**
5. **The interactive-ELK constraint recipe is an experiment, not the design.** Passing each surviving
   node's previous layer index as `layering.layerChoiceConstraint` and its in-layer index as
   `crossingMinimization.positionChoiceConstraint` **will not work as commonly written**: those
   options are consumed only when `org.eclipse.elk.interactiveLayout = true`, `semiInteractive` reads
   `org.eclipse.elk.position` instead, and constraint enforcement is a known elkjs weak spot (A3-5).
   The union-graph approach is sufficient on its own and this story ships on it.

The UI is a horizontal version rail with tick marks coloured by patch `decision`
(`auto` / `approved` / `rejected`, straight off `plan.patched`), arrow keys to step, and the patch
`reason` pinned in a side panel. "Show me version N" is `replayTo(planVersionSeq[N])`, hydrated from
`GET /api/runs/:id/snapshot?seq=N` — never replayed from zero in the browser.

**Acceptance criteria**

1. The rail renders one tick per plan version with its `seq`, `planHash` and `decision`, coloured by
   decision, and a rejected proposal appears on the rail as a distinct mark — the proposal is
   recorded even when it was refused.
2. Dragging to v1 shows the plan exactly as approved; `←`/`→` step one version at a time; the reason
   panel always shows the `reason` string from the `plan.patched` event for the transition being
   viewed.
3. **Nothing moves.** Stepping between any two adjacent versions leaves every node that exists in
   both at **identical coordinates**, asserted numerically on positions, not by eye.
4. Encoding is unambiguous and not colour-only: removed nodes render in place at reduced opacity with
   a dashed stroke; added nodes get a solid accent border and a `+` badge; changed nodes get a
   modified marker and a click-through; unchanged nodes render normally.
5. Clicking a changed node opens the field-level panel showing the RFC 6902 patch between the two
   node objects beside the human-readable reason — e.g.
   `{ "op": "replace", "path": "/provider", "value": "codex" }` next to
   _"Anthropic rate limit hit; re-routing implementation node to Codex"_.
6. The union layout is computed **once per version pair** and cached under `unionLayoutKey`;
   re-scrubbing over the same pair performs zero ELK calls, asserted by counting worker messages.
7. Scrubbing on a 10,000-event run applies zero events below the snapshot `seq` in the browser and
   stays within the NF3 interaction budget.
8. Comparing **non-adjacent** versions is supported as a secondary mode with a full reflow and a FLIP
   animation, and is never the primary mode — the primary path always uses the union layout.
9. On `three-patches`, all three patch kinds render correctly: an insert, a split (one node becoming
   two, with `derivedFrom` visible) and a provider replace.
10. Playwright smoke #2 passes: drag the scrubber back to v1 and forward through each patch, and the
    diff renders each time.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level         | Test                                                                                                  | Red when                                                   |
| --- | ------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | unit          | `contentHash(node)` is stable across key reordering and changes when `provider` changes               | `JSON.stringify` was used and key order leaks in           |
| 2   | unit          | Set diff over two versions yields correct `added`/`removed`/`changed`/`unchanged` for nodes and edges | Edge identity is not `source->target`                      |
| 3   | unit          | Identity is `nodeId`: a version where two nodes swapped positions yields zero changes                 | Identity was derived from position or index                |
| 4   | unit          | `rfc6902` patch between two node objects for a provider change and for a `reads[]` change             | The panel diffs rendered strings instead of objects        |
| 5   | unit          | Union node set is the union of both versions' ids; layout input is deterministic                      | The union is computed from the newer version only          |
| 6   | web (browser) | Step v3 → v4 and assert every surviving node's `transform` is byte-identical                          | The layout was recomputed per version                      |
| 7   | web (browser) | Four-way encoding matrix: added / removed / changed / unchanged, each with a non-colour signal        | Encoding is colour-only                                    |
| 8   | web (browser) | Worker-message counter across a back-and-forth scrub over the same pair is 1                          | The cache key is wrong or unused                           |
| 9   | integration   | Scrub on a 10,000-event fixture: assert the snapshot call and zero sub-snapshot applies               | The scrub replays from zero                                |
| 10  | e2e           | Playwright smoke #2 over `three-patches`                                                              | The rail renders but stepping does not re-render the graph |

**Notes / risks** — two honesty markers from [12 §6.2](../../12-frontend-architecture.md) that must
not be repeated as fact. _"No npm package does visual DAG diffing"_ is an **unverifiable negative** —
a search found none as of mid-2026, which is an absence of evidence, not evidence of absence. It does
not change the decision. And _"about 200 lines"_ is **an estimate, and an optimistic one** given the
five pieces above; [roadmap §3](../../17-roadmap.md) says to **budget a week, not an afternoon**, and
this story is sized `L` for that reason. Worth twenty minutes before starting: arXiv 2406.05560
(pairwise DAG comparison layout) could not be fetched during the research (A3-7) and may contain a
better shape-change encoding.

---

### KAR-17.3 — Node inspector

|                 |                                                                              |
| --------------- | ---------------------------------------------------------------------------- |
| **Status**      | Not started                                                                  |
| **Priority**    | P0                                                                           |
| **Size**        | L                                                                            |
| **Depends on**  | KAR-17.1, EPIC-15 KAR-15.6, EPIC-09 KAR-09.2                                 |
| **PRD**         | F10.3, F6.1, F6.2, F6.3, NF10                                                |
| **Verified by** | EPIC-17-S12, EPIC-17-S13, EPIC-17-S14, EPIC-17-S15, EPIC-17-S16, EPIC-17-S35 |

**As** the Operator staring at a bad diff, **I want** to open the node that produced it and see the
exact context it received, **so that** I can tell whether the agent was wrong or whether it was given
the wrong information — which are completely different bugs with completely different fixes.

No library: a `resizable` split panel over the graph, fed by
`GET /api/runs/:id/nodes/:nodeId?attempt=`. It shows the assembled context packet with a per-segment
token breakdown, the exact prompt, the raw output, the normalised and validated output, provider +
model + CLI version + binary sha256, permission level, duration, cost, retry history and the worktree
path ([12 §6.3](../../12-frontend-architecture.md)).

**Two details carry the whole view**, and without them it is a dashboard rather than a diagnostic
tool:

- **An attempt selector.** Retries are the interesting case. Comparing attempt 1 with attempt 3 side
  by side is how you diagnose a repair loop, and it is the only way to see what the fix node actually
  changed about the context.
- **Every value linked to the `seq` that produced it.** Clicking a token count jumps the debug ring to
  the `context.built` event; clicking a fact jumps to its `fact.written`. That link is **NF10 made
  visible** — the difference between a UI that claims traceability and one that demonstrates it.

Per [roadmap §3](../../17-roadmap.md), this story also absorbs the 80% of F10.4 that matters: a
**provenance table** answering _"what did this node read, and who wrote each fact"_ — perhaps forty
lines of markup against a graph surface that is a week of layout, culling and interaction work.

**Acceptance criteria**

1. Opening a node shows: identity and type, provider, model, CLI version and binary sha256,
   permission level, path scopes, worktree path, duration, cost, and the full attempt history.
2. The **context packet** section lists every `Segment` with its `kind`, token count, `pinned` flag
   and `sourceEvent`, grouped by the nine `SegmentKind` values, with pinned segments rendered first
   as they are in the prompt.
3. **The per-segment token counts sum to the header total**, asserted in the test — Playwright smoke
   #3 from [14 §13](../../14-testing-strategy.md).
4. The exact rendered prompt is shown from its artifact handle, syntax-highlighted through the single
   shared Shiki highlighter, with an explicit indication that it is _derived_ from the manifest and
   the manifest is authoritative.
5. Raw output and normalised/validated output are shown separately, and a `contract.schema-invalid`
   failure shows the Ajv error beside the offending output rather than a generic message.
6. The **attempt selector** switches attempts and offers a side-by-side comparison of attempt N and
   attempt M, diffing the packets segment by segment so a repair loop's context change is visible.
7. **Every displayed value links to its `seq`.** Clicking a token count, a fact, a cost figure or a
   state transition selects the producing event in the debug ring and shows its envelope.
8. The **provenance table** lists every fact this node read: key, value summary, writing node,
   evidence handles, timestamp, confidence, and whether the fact has since been invalidated.
9. A node that failed **before** a packet was built (`adapter.spawn-failed`,
   `safety.permission-unschedulable`) renders an honest empty packet section with the typed
   `NodeFailure` reason, `class`, `message` and evidence handles — never a blank panel and never a
   fabricated packet.
10. A node whose adapter reports `tokenAccounting: 'none'` shows the absence explicitly rather than
    a zero.
11. Sparklines are raw `<path>` from `d3-shape`'s `line()`; no `d3-selection` call exists in any
    component.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level         | Test                                                                                                        | Red when                                                           |
| --- | ------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 1   | unit          | Segment grouping and ordering: pinned first, `history.summary` in chronological position                    | Segments are rendered in array order                               |
| 2   | unit          | Sum assertion: per-segment tokens equal `totals.tokens` and per-kind equal `totals.byKind`                  | Header total is recomputed differently from the bar                |
| 3   | unit          | `seq` link resolution for a token count, a fact, a cost figure and a state transition                       | Links are wired for some values and not others                     |
| 4   | unit          | Packet segment-level diff between attempt 1 and attempt 3                                                   | The comparison diffs rendered text, not segments                   |
| 5   | web (browser) | Mount for a failed-before-packet node; assert the typed failure renders and no packet section is fabricated | The panel renders blank                                            |
| 6   | web (browser) | Attempt selector switches and the side-by-side comparison renders both packets                              | Only the latest attempt is fetched                                 |
| 7   | web (browser) | Provenance table over `happy-path-12`: reads, writers, evidence, invalidation flag                          | Provenance is inferred from the graph rather than from `fact.read` |
| 8   | web (browser) | Exactly one Shiki highlighter instance exists across inspector, diff, plan JSON and output views            | Each view created its own                                          |
| 9   | e2e           | Playwright smoke #3: open the inspector, assert the segment breakdown sums to the header total              | The endpoint and the projection disagree                           |

**Notes / risks** — the shared highlighter matters for the bundle as much as for correctness: **never
import the bundled `shiki` entry**, which pulls every grammar and costs multiple megabytes. Use
`createHighlighterCore` from `@shikijs/core` with `@shikijs/engine-javascript` (so there is no WASM
download) and lazily import only `ts, tsx, js, jsx, vue, json, yaml, python, go, rust, sql, bash,
diff, markdown` ([12 §7](../../12-frontend-architecture.md)).

---

### KAR-17.4 — Context budget visualisation

|                 |                                                                 |
| --------------- | --------------------------------------------------------------- |
| **Status**      | Not started                                                     |
| **Priority**    | P0                                                              |
| **Size**        | M                                                               |
| **Depends on**  | KAR-17.3, EPIC-16 KAR-16.3, EPIC-09 KAR-09.6                    |
| **PRD**         | F10.5, F6.6, F9.1                                               |
| **Verified by** | EPIC-17-S17, EPIC-17-S18, EPIC-17-S19, EPIC-17-S32, EPIC-17-S35 |

**As** the Operator whose run went subtly wrong after hour two, **I want** to see what compaction
deleted, **so that** I can tell whether the agent lost a constraint I thought it still had.

[Roadmap §3](../../17-roadmap.md) names this one of the three views that carry the diagnosis metric,
for a specific reason: compaction _actively deletes governance constraints from context, causing
unsafe tool calls_ — a mechanism distinct from ordinary long-context attention dilution, and the
reason F6.6's pinned set exists at all. This view is where that becomes visible.

`d3-shape`'s `stack()` over the `ContextPacket` segments — pinned constraints / spec / retrieved
facts / tool output / history — one bar per node invocation, rendered as Vue-templated `<svg>` and
`<rect>`. Compaction events are `<line>` annotations at the `seq` of each `context.compacted`; hover
shows before → after and dropped handles, with a link to the full original artifact.

**One correctness requirement dominates the story.** `context.compacted` carries
`fidelity: 'exact' | 'partial'` and `after: number | null`, because vendor-side compaction reports
only a pre-token count — Claude Code's `compact_boundary` frame carries `{ trigger, pre_tokens }` and
nothing else. **Verified 2026-08-02.** **When `fidelity` is `'partial'`, render the gap as a gap.** A
bar with a fabricated "after" number is worse than an honest hole, and this is the single thing that
separates an auditable system from one that quietly lies.

**Acceptance criteria**

1. One stacked bar per node invocation, segmented by `SegmentKind`, with pinned segments always the
   base of the stack — matching the order they render in the prompt.
2. Each bar shows the budget line (`budget.limitTokens`, default fraction 0.5, never above 0.6) so
   headroom is visible, not implied.
3. A `context.compacted` with `fidelity: 'exact'` renders a before → after annotation with the delta,
   the `droppedSegments[]` list and a link to `originalHandle`.
4. A `context.compacted` with `fidelity: 'partial'` renders **an explicit gap** with a labelled
   "vendor-reported; post-count unavailable" state. No interpolation, no zero, no dashed guess at the
   after value. The test asserts the absence of a numeric after value in the DOM.
5. `pinnedKept[]` is surfaced as a positive assertion — "these pinned digests survived" — because
   that list is the integrity check's own evidence.
6. A `pin.integrity_violated` event renders a blocking marker on the affected invocation naming the
   missing digests and segment ids, and the node's failure reason
   `safety.pin-integrity-violated`.
7. Hovering a segment shows kind, token count, `sourceEvent` and a click-through to the inspector's
   segment detail.
8. Token counts state their `method` (`gpt-tokenizer/o200k_base`, `heuristic`, `vendor-reported`);
   estimated and vendor-reported figures are never summed into one displayed number.
9. The chart carries a `<title>`, an `aria-label` and a toggleable data-table view listing
   invocation, kind, tokens and method.
10. On `compaction.jsonl`, both fidelities render correctly in the same view without a special case
    in the component — the discriminator does the work.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level         | Test                                                                                      | Red when                                                   |
| --- | ------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | unit          | `stack()` input builder: pinned kinds first, totals matching the packet                   | Stack order is `Object.keys` order                         |
| 2   | unit          | `fidelity: 'partial'` produces a gap descriptor with `after: null` preserved              | `after ?? 0` crept in somewhere                            |
| 3   | unit          | Budget line position from `budget.limitTokens`, not from the tallest bar                  | The scale is derived from the data and headroom disappears |
| 4   | web (browser) | Render `compaction.jsonl`; assert the partial mark has no numeric after value in the DOM  | A placeholder number was rendered                          |
| 5   | web (browser) | Exact compaction: before, after, delta, dropped list and original-handle link all present | The link was dropped as "not important"                    |
| 6   | web (browser) | `pin.integrity_violated` renders the blocking marker with digests                         | The event is ignored as a duplicate of the failure         |
| 7   | web (browser) | Data-table twin lists every bar's segments with method labels                             | The table was built from a different source than the chart |
| 8   | web (browser) | Both themes: segment colours read `--state-*` / theme tokens and contrast passes          | Colours are hardcoded per segment kind                     |

**Notes / risks** — d3 is **a maths library here**: scales, stacks, ticks, time formatting. **Never
call `d3-selection` to mutate the DOM inside a Vue component** — two owners of the same nodes
produces bugs you cannot fix ([12 §6.9](../../12-frontend-architecture.md)). Install the submodules,
never the `d3` metapackage, which drags in ~30 modules.

---

### KAR-17.5 — Live agent output streams

|                 |                                                    |
| --------------- | -------------------------------------------------- |
| **Status**      | Not started                                        |
| **Priority**    | P0                                                 |
| **Size**        | M                                                  |
| **Depends on**  | KAR-17.1, EPIC-15 KAR-15.6, EPIC-16 KAR-16.4       |
| **PRD**         | F10.6, NF8                                         |
| **Verified by** | EPIC-17-S20, EPIC-17-S21, EPIC-17-S22, EPIC-17-S23 |

**As** the Operator, **I want** to tail what an agent is doing right now and reattach after closing
the panel, **so that** a node that has been "running" for eleven minutes is something I can look
inside rather than guess about.

The story has a fidelity decision baked into it, taken from [roadmap §3](../../17-roadmap.md) rather
than deferred: **for ACP adapters, skip xterm entirely.** ACP streaming updates are typed JSON, not a
TTY byte stream. Render them as a **virtualised list of typed message components** — faster,
searchable, selectable, diffable, themeable and accessible — highlighted incrementally with
`@shikijs/stream@^4.4.1`, which exists precisely for _"highlighting text streams like LLM outputs"_.
Use `@xterm/xterm@^6.0.0` only for the CLI-shim adapters where the output genuinely is ANSI with
cursor movement and spinners.

That split is also the roadmap's soft scope-cut: a plain streaming log pane covers the M1 diagnostic
need at a fraction of the cost, and full terminal emulation is what lands in M2 if it is needed. The
xterm path is still specified here because the shim adapters exist in M1 and their output is
genuinely ANSI.

Where xterm is used, four disciplines are non-negotiable
([12 §6.6](../../12-frontend-architecture.md)):

- **`scrollback: 5000` and never raise it.** `BufferLine` allocates `new Uint32Array(3 * cols)` —
  **12 bytes per cell**, read out of the v6 source. **Verified 2026-08-02.** At 200 columns that is
  ≈ 13 MB for 5,000 lines, ≈ 26 MB for 10,000 and ≈ 260 MB for 100,000 — **per terminal**.
- **One `Terminal` per _visible_ terminal, never per _opened_ terminal.** On unmount or tab-hide,
  take an `@xterm/addon-serialize` snapshot string, `dispose()`, and keep only the string; on
  re-show, construct a fresh `Terminal` and `write()` it back. Browsers cap WebGL contexts at roughly
  8–16 and the failure is **silent, in the oldest terminals**.
- **Renderer is DOM or WebGL only.** `@xterm/addon-canvas` was removed in v6; load
  `@xterm/addon-webgl` and fall back to DOM on its `onContextLoss` event.
- **`markRaw` the `Terminal`** so Vue's proxy never touches it.

The browser terminal is a **live tail, not the archive**. The daemon already writes
`runs/<runId>/nodes/<nodeId>/stdout.log` (NF8); "Open full log" streams that artifact into a
virtualised read-only viewer (`@tanstack/vue-virtual@^3.13.35`, line-indexed, byte-range fetches),
never into xterm. Reattaching to a running node asks for the last N KB via
`GET /api/runs/:id/nodes/:nodeId/io?limit=`, not the whole file.

**Acceptance criteria**

1. Opening a running ACP node streams its typed updates into a virtualised message list within the
   NF3 interaction budget, with each message typed (`agent_message_chunk`, `tool_call`,
   `tool_call_update`, plan updates) and individually selectable and linkable to its `seq`.
2. Streaming highlight uses `@shikijs/stream` incrementally — the whole buffer is not re-tokenised
   per chunk, asserted by timing a 2,000-chunk stream.
3. Opening a CLI-shim node's output uses xterm with `scrollback: 5000`, the WebGL addon loaded, and
   a DOM fallback wired to `onContextLoss`.
4. Closing a terminal panel serialises and disposes: after opening and closing twenty terminals, the
   count of live `Terminal` instances is the number currently visible, and WebGL contexts in use are
   under the browser cap.
5. Re-showing a previously-serialised terminal restores its content from the snapshot string, with no
   refetch of the whole log.
6. Reattaching to a running node requests the **last N KB** through `/io` with `fromSeq` omitted and
   `limit` set, and never the whole file.
7. "Open full log" opens the virtualised viewer over the on-disk artifact with byte-range fetches;
   xterm is not involved, asserted by the absence of a `Terminal` construction on that path.
8. `io_chunk` data never enters the run store or the control-plane stream — it arrives on its own
   endpoint (KAR-16.4's cap is what this relies on).
9. `screenReaderMode` is **off** by default and exposed as a setting, because it is expensive.
10. The panel states honestly when a node produced no output at all, and when the adapter's output
    ended without a result envelope.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level         | Test                                                                                                     | Red when                                           |
| --- | ------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | unit          | Scrollback arithmetic assertion: `12 * cols * lines` against the configured cap, documenting the ceiling | Someone raises scrollback "just for debugging"     |
| 2   | unit          | The `/io` tail request builder omits `fromSeq` and sets `limit`                                          | The client asks for the whole log                  |
| 3   | web (browser) | Open and close 20 terminals; assert live `Terminal` count equals visible count                           | `dispose()` is not called on unmount               |
| 4   | web (browser) | Serialise → dispose → re-show restores buffer content from the snapshot                                  | The snapshot is taken after disposal               |
| 5   | web (browser) | WebGL context loss triggers the DOM fallback without losing buffer content                               | The fallback was assumed and never wired           |
| 6   | web (browser) | 2,000-chunk stream through `@shikijs/stream`; assert per-chunk time does not grow linearly               | The whole buffer is re-highlighted per chunk       |
| 7   | web (browser) | ACP node renders typed message components, not a terminal                                                | Everything was routed through xterm for uniformity |
| 8   | web (browser) | "Open full log" mounts the virtualised viewer and constructs no `Terminal`                               | The archive path fell back to xterm                |
| 9   | integration   | Reattach after a panel close: assert only the tail was fetched                                           | Reattach re-reads the archive                      |

**Notes / risks** — A3-8 records that the xterm v6 breaking-change list was read via a summarizer that
got the release date wrong; **re-read the real changelog before writing terminal code**. Also note the
scope-cut position honestly: [roadmap §3](../../17-roadmap.md) lists full xterm terminals as the
second, softer candidate to slip to M2, with the plain streaming log pane covering M1. This story
delivers the pane unconditionally and the terminal only for shim adapters — which is the recommended
reduced fidelity, taken deliberately.

---

### KAR-17.6 — Diff and review surface with inline verdicts

|                 |                                                                 |
| --------------- | --------------------------------------------------------------- |
| **Status**      | Not started                                                     |
| **Priority**    | P0                                                              |
| **Size**        | M                                                               |
| **Depends on**  | KAR-17.1, EPIC-12 KAR-12.3, EPIC-15 KAR-15.6                    |
| **PRD**         | F10.7, F7.7, F7.3, F7.5                                         |
| **Verified by** | EPIC-17-S24, EPIC-17-S25, EPIC-17-S26, EPIC-17-S27, EPIC-17-S35 |

**As** the Operator reviewing what the run produced, **I want** the gate's findings attached to the
exact lines they refer to, **so that** review is one surface instead of a diff in one window and a
verdict in another.

`@git-diff-view/vue@0.1.7` + `@git-diff-view/core@0.1.7` + `@git-diff-view/shiki@0.1.7`, **pinned
exactly with no caret** — it is pre-1.0 — and read the changelog before bumping. The reason it wins is
narrow and decisive: **first-class inline widget/extend slots per line.** F7.7 requires gate verdicts
attached inline at file and line, and `diff2html` is a string → HTML generator, so attaching Vue
verdict widgets at specific lines would mean DOM surgery. Wrong shape for the requirement.

**`DeFlowd` shells out to `git diff` and ships the unified patch** over `GET /api/runs/:id/diff` as
`text/x-patch`; `@git-diff-view/core` parses a unified patch directly, and that is orders of
magnitude faster and more correct than diffing in JavaScript. `diff@^9.0.0` (the `jsdiff` package —
note the separate npm package literally named `jsdiff` is abandoned, last publish 2014) is reserved
for the cases where the browser only has before/after text: plan JSON and `TaskSpec` edits.

Three scopes: per-node, per-worktree and cumulative-run. Findings come from
`GET /api/runs/:id/findings?file=` grouped by file and ordered by line, and each carries severity,
an optional criterion id, a message, evidence handles and an optional suggested fix.

`@shikijs/magic-move@^4.4.1` animates the repair loop's before/after at token level. That is _"the
single highest-ratio visual win in the app: it makes 'one issue, one fix, capped at three attempts'
legible at a glance instead of requiring a diff read"_ ([12 §7](../../12-frontend-architecture.md)).

**Acceptance criteria**

1. `GET /api/runs/:id/diff?node=` / `?worktree=` / `?cumulative=1` each render, and switching scope
   preserves the file selection where the file exists in both.
2. Findings render **inline at their `location.line`** as Vue components in the per-line widget slot,
   showing severity, message, the criterion they map to, and links to their evidence handles.
3. A finding with no `location` renders at file level rather than being dropped or guessed onto
   line 1.
4. Severity is encoded by glyph and label as well as colour: `blocker`, `major`, `minor`, `info`.
5. A `needs-human` verdict renders distinctly from `fail` and does not colour the file red — it is a
   judgement call or a broken tool, not broken work.
6. The repair loop renders as a magic-move transition between the failing and the fixed state for the
   node the fix targeted, with the failing finding pinned beside it.
7. Large diffs are virtualised and a file over a stated size renders collapsed with an explicit
   "expand" rather than freezing the tab.
8. The diff view is a **lazy route**: `@git-diff-view/*` is absent from the initial chunk.
9. Syntax highlighting comes from the single shared Shiki instance via `@git-diff-view/shiki`, not a
   second highlighter.
10. Every finding links back to the `gate.evaluated` event's `seq` that produced it.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level         | Test                                                                                           | Red when                                          |
| --- | ------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| 1   | unit          | Findings-to-line index: group by file, order by line, bucket the location-less ones separately | Location-less findings land on line 1             |
| 2   | unit          | Unified-patch parse of a real `git diff` output including renames and binary files             | The parser was tested only on a synthetic patch   |
| 3   | web (browser) | Mount `gate-fail-repair`'s diff; assert a finding widget renders at the exact line             | Widgets are appended after the hunk               |
| 4   | web (browser) | Severity matrix with glyph + label + colour for all four values                                | Severity is colour-only                           |
| 5   | web (browser) | `needs-human` renders distinctly from `fail`                                                   | The two were merged into "not passing"            |
| 6   | web (browser) | Magic-move between attempt 1 and attempt 2 of the repaired file                                | The animation re-mounts and loses scroll position |
| 7   | web (browser) | A 5,000-line file renders collapsed and expands on demand within budget                        | The whole diff renders eagerly                    |
| 8   | integration   | Built output: `@git-diff-view/*` absent from the initial chunk                                 | The route was imported eagerly for a type         |
| 9   | e2e           | Follow a failing verdict from the criteria board to the diff line and back                     | The link carries a file but not a line            |

**Notes / risks** — `@git-diff-view` is pre-1.0 and pinned exactly for that reason; a caret here is
how a minor bump silently changes the review surface. `diff2html@3.4.56` is alive and fine at what it
does — it is simply the wrong shape for F7.7, and that distinction should be recorded so nobody
"corrects" the dependency later.

---

### KAR-17.7 — Acceptance criteria board

|                 |                                                      |
| --------------- | ---------------------------------------------------- |
| **Status**      | Not started                                          |
| **Priority**    | P0                                                   |
| **Size**        | S                                                    |
| **Depends on**  | EPIC-16 KAR-16.3, EPIC-12 KAR-12.4, EPIC-15 KAR-15.6 |
| **PRD**         | F10.8, F7.4, F7.3                                    |
| **Verified by** | EPIC-17-S28, EPIC-17-S29, EPIC-17-S35                |

**As** the Operator deciding whether to merge, **I want** the checklist from the `TaskSpec` with what
is satisfied and the evidence behind each, **so that** _"has the requested outcome been achieved"_ is
a screen and not a judgement.

The literal answer to the question the whole product is for. A table of the `TaskSpec` criteria with
live `satisfied` / `unsatisfied` / `unverifiable` status and the gate evidence behind each, from the
`gates.ts` projection joined to criterion ids, built on `shadcn-vue`'s `table` and `collapsible`.

**The one thing to get right: `unverifiable` is a first-class state, not a variant of failure.** A
criterion with no gate mapped to it is a **spec defect** — F7.4 requires every criterion to map to at
least one gate — and this board is where you find out. Colour it distinctly from both pass and fail,
with its own glyph and label ([12 §6.8](../../12-frontend-architecture.md)).

**Acceptance criteria**

1. Every criterion in the approved `TaskSpec` appears, in spec order, with its id and text.
2. Status is one of `satisfied` / `unsatisfied` / `unverifiable`, each with a distinct colour, glyph
   and label, and `unverifiable` is visually distinct from both others.
3. Expanding a criterion shows every gate that speaks to it, each gate's verdict outcome, its
   `summary` line, and its findings with links into the diff at the right line.
4. A criterion with **no gate mapped to it** renders as `unverifiable` with an explicit "no gate maps
   to this criterion — spec defect (F7.4)" message, not as a blank row.
5. A criterion satisfied by one gate and contradicted by another surfaces the conflict rather than
   picking one — the most recent verdict wins for the headline status and the conflict is shown.
6. The board updates live: a `gate.evaluated` event flips a criterion's status without a refetch.
7. The header shows counts by status and the run's overall answer, and that headline never claims
   "done" while any criterion is `unverifiable`.
8. The board has a copy-as-markdown action producing a checklist suitable for a PR description.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level         | Test                                                                                 | Red when                                               |
| --- | ------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| 1   | unit          | Criterion → gate join produces `unverifiable` for an unmapped criterion              | Unmapped criteria are dropped from the table           |
| 2   | unit          | Conflicting verdicts on one criterion produce a headline plus a conflict flag        | The last write silently wins and the conflict vanishes |
| 3   | web (browser) | Three-state render matrix with glyph, label and colour                               | `unverifiable` is styled as a muted failure            |
| 4   | web (browser) | Live update: apply a `gate.evaluated` event and assert the row flips with no refetch | The board is a query, not a projection                 |
| 5   | web (browser) | Expand a criterion; assert gate summary, findings and the diff deep link             | Evidence is a handle with no link                      |
| 6   | unit          | Copy-as-markdown output snapshot                                                     | The export drifts from the table                       |

**Notes / risks** — this is the smallest story in the epic and one of the most valuable, because it is
the surface a colleague reads. Resist adding a progress percentage: a run at "80% of criteria
satisfied" with the remaining 20% `unverifiable` is not 80% done, and a number invites exactly that
misreading.

---

### KAR-17.8 — Run timeline with cost overlay

|                 |                                                    |
| --------------- | -------------------------------------------------- |
| **Status**      | Not started                                        |
| **Priority**    | P0                                                 |
| **Size**        | M                                                  |
| **Depends on**  | EPIC-16 KAR-16.3, EPIC-14 KAR-14.1                 |
| **PRD**         | F10.9, F9.1                                        |
| **Verified by** | EPIC-17-S30, EPIC-17-S31, EPIC-17-S32, EPIC-17-S35 |

**As** the Operator, **I want** a Gantt of every node against wall clock with cost overlaid,
**so that** parallelism, stalls and cost concentration are obvious at a glance instead of being
inferred from a log.

[Roadmap §3](../../17-roadmap.md) explicitly keeps this at P0 and explains why: _"it looks like the
expensive one and is not"_ — roughly 150 lines of `d3-scale` plus Vue-rendered SVG over
`node.started` / `node.completed` / `budget.consumed`, all of which are projections that already
exist. No Gantt library is needed and none of the Vue chart libraries ships one.

`scaleTime` for x, `scaleBand` for lanes, one `<rect>` per node execution, a second y-axis carrying a
line or area for cumulative cost. The payoffs are concrete: the SVG is fully themeable by the CSS
custom properties, and the DOM is yours to put ARIA on.

**Acceptance criteria**

1. One lane per node with one bar per `(nodeId, attempt)` span; parallel execution is visible as
   vertical overlap.
2. Bars are coloured by node state from the `--state-*` tokens, with a glyph or pattern so state is
   not colour-only.
3. A node still running renders as an open-ended bar to "now" with a distinct end cap — no invented
   end time.
4. A suspended node (`node.suspended`, e.g. a six-hour human gate) renders its wait as a visually
   distinct segment from execution time, because six idle hours and six busy hours cost very
   different things.
5. Cumulative cost is overlaid on a second axis from `budget.consumed`, and `budget.exceeded` marks
   the point where the run **paused** — not failed.
6. `provider.rate_limited` events render as markers, so a stall with an external cause is
   distinguishable from a stall with an internal one.
7. `run.stalled` renders as a marker with its `idleMs` and the nodes that were running — surfaced,
   never presented as a kill, because a long build looks identical to a stall.
8. Zoom and brush over the time axis work with the keyboard as well as the pointer.
9. The chart has a `<title>`, an `aria-label` and a toggleable data-table view listing node, attempt,
   start, end, duration, state and cost.
10. Only `d3-scale`, `d3-array`, `d3-shape`, `d3-axis` and `d3-time-format` are imported — never the
    `d3` metapackage — and no `d3-selection` call exists anywhere in the component.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level         | Test                                                                                          | Red when                                             |
| --- | ------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | unit          | Span builder from `node.started`/`node.completed`/`node.suspended` including an open span     | The open span is dropped or given `now`              |
| 2   | unit          | Lane assignment is stable across re-renders and does not reshuffle on a new node              | Lanes are assigned by sort order of a changing array |
| 3   | unit          | Cumulative cost series is monotonic and matches the sum of `budget.consumed`                  | The series resets on a retry                         |
| 4   | web (browser) | Render `happy-path-12`; assert bar count, lane count and one bar's geometry against the scale | Geometry was asserted in jsdom against a `0×0` box   |
| 5   | web (browser) | Suspension segment renders distinctly from execution                                          | The gate looks like six hours of work                |
| 6   | web (browser) | `budget.exceeded` marker states "paused", not "failed"                                        | The two were rendered identically                    |
| 7   | web (browser) | Data-table twin matches the chart's spans exactly                                             | The table is built from a second derivation          |
| 8   | unit          | Import audit: no `d3` metapackage, no `d3-selection`                                          | Someone imported `d3` for convenience                |

**Notes / risks** — the x-axis is wall clock and therefore uses `ts`, but every **ordering** decision
comes from `seq`; `ts` is informational only and can move backwards across a laptop sleep or an NTP
correction ([04 §9](../../04-domain-model.md)). A bar that appears to start before its predecessor
finished is a `ts` artefact, not a scheduler bug — say so in the tooltip rather than clamping the
data.

---

### KAR-17.9 — Memory and data-flow graph _(scope-cut candidate)_

|                 |                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Status**      | Blocked                                                                                                           |
| **Priority**    | P1                                                                                                                |
| **Size**        | L                                                                                                                 |
| **Depends on**  | KAR-17.3, EPIC-16 KAR-16.6 **and its committed 400-node measurement**, EPIC-09 KAR-09.8                           |
| **PRD**         | F10.4 (PRD priority **P0** — this story sits at P1 as a deliberate, recorded deviation; see the note below), F6.3 |
| **Verified by** | EPIC-17-S33, EPIC-17-S34                                                                                          |

**As** the Operator, **I want** a graph of the blackboard with facts as nodes and reads and writes as
edges, **so that** _"which node produced the wrong assumption?"_ is a click rather than an
investigation.

**Status is `Blocked` and priority is honestly `P1`, and both are decisions with reasons.**
[Roadmap §3](../../17-roadmap.md) recommends slipping this view to M2 and gives four arguments:

1. It is **a second Vue Flow surface on a graph whose node count is unbounded** in a way the plan
   graph's is not — facts accumulate over a multi-hour run while plan nodes stay in the dozens. If
   KAR-16.6's 400-node measurement comes back unfavourable, this is the view that breaks.
2. **Nothing is lost by deferring it.** `fact.written` and `fact.read` are ledger events regardless —
   PRD §9.3 is explicit that they exist to make memory sharing renderable. The data accrues from day
   one; only the rendering slips, and adding the view in M2 needs no migration and no re-run.
3. **KAR-17.3's provenance table already answers the 80% question** — _"what did this node read, and
   who wrote each fact"_ — at roughly forty lines of markup against a graph surface that is a week of
   layout, culling and interaction work.
4. **It is the view a colleague would want, not the view the author needs daily**, which makes it a
   strong M2 feature precisely because M2's definition of done is about someone else understanding a
   run.

The blocking condition is concrete: this story stays `Blocked` until
`docs/measurements/vue-flow-400.md` exists and its numbers support a second graph surface. The
unblocking decision is the author's, and it is recorded in that file.

If it is built, the design decision is made in product before it is made in rendering
([12 §6.4](../../12-frontend-architecture.md)): **aggregate facts by producing node and expand on
demand.** The default view is one bubble per node with a fact count; clicking expands that node's
facts inline. That is cheaper to build, dramatically more readable, and it is what an operator
actually wants — _"which node produced the wrong assumption?"_ not _"here are 3,000 dots"_. Only if
the expanded view genuinely exceeds ~1,500 nodes does the escape hatch open:
`sigma@^3.0.3` + `graphology@^0.26.0`, or `@cosmograph/cosmos@^3.4.1` for GPU force layout at 100k+.
Because everything goes through `GraphCanvas`, that swap touches one file and does not disturb the
plan graph.

**Acceptance criteria**

1. The default view is **aggregated**: one node per producing plan node, labelled with its fact
   count, with edges to consuming nodes. Raw facts are not rendered by default at any run size.
2. Expanding a producing node renders its facts inline; collapsing restores the aggregate. The
   expanded set is capped and paginated rather than rendering unboundedly.
3. Clicking a fact shows provenance — writing node, evidence handles, timestamp, confidence — and the
   complete consumer set from `fact.read`, via `GET /api/runs/:id/facts/:factId/consumers`.
4. An invalidated fact renders distinctly, and every node in its `taints[]` is highlighted as having
   consumed something that later proved wrong.
5. The view is a **lazy route** and is absent from the initial chunk.
6. It renders through `GraphCanvas` with no direct `@vue-flow/core` import, so the renderer swap
   remains a one-file change.
7. On a fixture with 3,000 facts, the aggregated default view renders within the NF3 interaction
   budget; the expanded view for the largest producing node either renders within budget or is
   explicitly paginated.
8. If the measurement in KAR-16.6 does not support a second Vue Flow surface, this story is closed as
   deferred with that reason recorded, and KAR-17.3's provenance table is confirmed as F10.4's M1
   coverage.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level         | Test                                                                                | Red when                                                          |
| --- | ------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | unit          | Aggregation: facts grouped by producing node with counts and consumer edges         | The graph is built from raw facts and aggregated in the component |
| 2   | unit          | Expansion is bounded and paginated                                                  | Expansion renders every fact for a node with 900 of them          |
| 3   | unit          | `fact.invalidated` taint propagation to the recorded consumer set                   | Taint is recomputed from the current graph rather than the event  |
| 4   | web (browser) | Aggregated render of a 3,000-fact fixture within budget                             | The default view renders raw facts                                |
| 5   | web (browser) | Fact detail: provenance fields and the full consumer list                           | Consumers are inferred from edges rather than fetched             |
| 6   | integration   | Built output: the memory-graph route is absent from the initial chunk               | The route was eagerly imported                                    |
| 7   | e2e           | Render through `GraphCanvas` with a stub renderer substituted; the view still works | Something reached past the facade                                 |

**Notes / risks** — **F10.4 is a PRD P0 and this story is `P1`.** That deviation is recorded rather
than silent, and F10.4's requirement is not dropped: its diagnostic core is delivered by KAR-17.3's
provenance table (AC-8 of that story) and by the `blackboard.ts` projection, which is built and
tested in EPIC-16 regardless of whether this view ships. The board should treat F10.4 as **covered by
KAR-17.3 for M1 and completed by KAR-17.9 in M1-if-the-measurement-allows, otherwise M2** — and the
author's decision belongs in `docs/measurements/vue-flow-400.md` alongside the number that drove it.

---

## Risks

| Risk                                                                                                                                       | Severity | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **~28 days across nine views for one person alongside a job and a degree.** PRD §13 names scope explosion as **High** and A3-6 repeats it. | **High** | [Roadmap §3](../../17-roadmap.md)'s recommendation, taken explicitly: keep F10.1, F10.2, F10.3 (+provenance table), F10.5, F10.7, F10.8, F10.9 at full fidelity; reduce F10.6 to a streaming log pane (KAR-17.5's ACP path) and defer F10.4's graph (KAR-17.9). That is seven views with two reduced and takes roughly two weeks off. Build order is the metric order, so the diagnosis capability exists before the epic is finished. |
| **"The visualisation is pretty but not diagnostic."** PRD §13, Medium, with the mitigation stated as a metric.                             | Medium   | EPIC-17-S35 is a timed, scripted diagnosis over at least three seeded failure fixtures, and it is a Definition-of-Done gate on the epic rather than a report. If the time does not come in under five minutes, the views are wrong and the epic is not done.                                                                                                                                                                           |
| **The scrubber is budgeted as "about 200 lines" and is not.**                                                                              | Medium   | Sized `L` with the five components enumerated in the story. [Roadmap §3](../../17-roadmap.md): _"budget for it as a week, not an afternoon."_ If it overruns, the fallback is the non-adjacent-comparison mode (full reflow with FLIP) as a **secondary** mode only — never as the primary one, because reflow destroys the view's purpose.                                                                                            |
| **A3-2's measurement comes back below ~300 nodes**, invalidating both graph surfaces.                                                      | High     | KAR-16.6 measures before this epic starts. KAR-17.1 then defaults `onlyRenderVisibleElements` on, and KAR-17.9 closes as deferred. The `GraphCanvas` facade makes a renderer swap a one-file change if even that is insufficient.                                                                                                                                                                                                      |
| **A3-1 — Vue Flow stalls out during M1.**                                                                                                  | High     | The facade. Two views depend on it and both go through one file. Re-check release activity before M2.                                                                                                                                                                                                                                                                                                                                  |
| **The read endpoints these views need (KAR-15.6) drift or arrive late.**                                                                   | Medium   | Every view is developed against `deflow replay`, which serves the same contract; a drift shows up as a failing response-shape equality test in EPIC-16 KAR-16.5 rather than as a broken view.                                                                                                                                                                                                                                          |
| **`@git-diff-view` is pre-1.0** and is pinned exactly, so a needed fix may require a manual bump and a changelog read.                     | Low      | Pinned with no caret and the reason recorded. The alternative (`diff2html`) is documented as the wrong shape for F7.7, so the decision does not get re-litigated by someone reading a stale search result.                                                                                                                                                                                                                             |
| **Nine views' worth of components erode into a design system.**                                                                            | Medium   | [12 §8.1](../../12-frontend-architecture.md)'s bound: about sixteen vendored `shadcn-vue` files, and no override layer. Any new shared component needs a reason beyond "it might be reused".                                                                                                                                                                                                                                           |

---

**Related:** [Flows](../flows/EPIC-17-p0-views-flows.md) · [Board](../board.md) ·
[Frontend architecture](../../12-frontend-architecture.md) ·
[Roadmap §3](../../17-roadmap.md) ·
[API and realtime](../../11-api-and-realtime.md) ·
[UI foundation epic](./EPIC-16-ui-foundation.md) ·
[Verification gates epic](./EPIC-12-verification-gates.md)

[← Back to the delivery plan](../README.md)
