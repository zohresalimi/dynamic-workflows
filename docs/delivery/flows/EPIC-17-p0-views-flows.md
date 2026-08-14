# EPIC-17 flows — P0 visualisation views

> Behavioural specification for [EPIC-17](../epics/EPIC-17-p0-views.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

This is the most operator-facing flow file in the plan. The scenarios below are written as
**journeys** — what a person does, in order, and what they see — because the requirement these views
serve is not "render a graph", it is _"median time-to-diagnose a failed run under five minutes"_
(PRD §12). [EPIC-17-S35](#epic-17-s35--the-five-minute-diagnosis-end-to-end) measures that directly
and is a gate on the epic.

## Actors

| Actor              | Description                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Operator**       | The engineer driving DeFlow. The subject of every scenario in this file. They have a bad diff, a red gate or a run that has been quiet for eleven minutes, and they want to know why |
| **DeFlowd**        | The daemon serving `/api/*`, the SSE stream and the diff patches. Here, mostly a source of shapes                                                                                    |
| **Replay harness** | `deflow replay <fixture> --speed <n>x`. Every scenario below is developable and testable against a recorded fixture — no provider, no credentials, no cost                           |
| **Projections**    | The seven pure modules from [EPIC-16](../epics/EPIC-16-ui-foundation.md). Every view reads a projection; no view reduces events itself                                               |
| **GraphCanvas**    | The facade over `@vue-flow/core`. The plan graph and the memory graph both go through it                                                                                             |
| **Gate**           | A deterministic or adversarial verification node whose `Verdict` and `Finding[]` are what the review surface renders                                                                 |

## Preconditions common to all flows

```gherkin
Background:
  Given the UI is a projection of the ledger: every rendered value came from an EventEnvelope
        and there is no other data path into the store (NF10)
  And EPIC-16 is Done: one SSE connection per tab, seven pure projections, a bounded store,
        the replay harness, and a committed 400-node measurement at docs/measurements/vue-flow-400.md
  And every view reads PlanNodeVM / PlanEdgeVM / TimelineSpanVM style view-models,
        never a raw Event and never a projection internal
  And no state anywhere is encoded by colour alone: colour + glyph + text label, every time
  And the seven node-state colours come from --state-pending, --state-running, --state-blocked,
        --state-passed, --state-failed, --state-abandoned, --state-awaiting-human, in both themes
  And browser-mode tests run in real Chromium — jsdom and happy-dom have no SVG measurement,
        no canvas and no WebGL, and they fail silently rather than loudly
  And d3 is used as a maths library only; no component calls d3-selection
  And exactly one Shiki highlighter instance exists for the whole app
```

## Flow index

| Scenario    | Title                                                                                     | Verifies                                                             | Type        |
| ----------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------- |
| EPIC-17-S1  | Happy path: the Operator opens a running run and sees it move                             | KAR-17.1                                                             | Happy path  |
| EPIC-17-S2  | Seven states, and edges that say what flows across them                                   | KAR-17.1                                                             | Edge case   |
| EPIC-17-S3  | A `map` fan-out arrives while the Operator is panning                                     | KAR-17.1                                                             | Concurrency |
| EPIC-17-S4  | Four hundred nodes, against the measured budget                                           | KAR-17.1                                                             | Edge case   |
| EPIC-17-S5  | **Marquee journey:** scrub back to the approved plan and step forward through every patch | KAR-17.2                                                             | Happy path  |
| EPIC-17-S6  | Nothing moves as you scrub                                                                | KAR-17.2                                                             | Edge case   |
| EPIC-17-S7  | Added, removed, changed, unchanged — encoded four ways                                    | KAR-17.2                                                             | Edge case   |
| EPIC-17-S8  | "Why did this change" at field level                                                      | KAR-17.2                                                             | Happy path  |
| EPIC-17-S9  | A patch that was proposed and refused                                                     | KAR-17.2                                                             | Edge case   |
| EPIC-17-S10 | Comparing versions that are not adjacent                                                  | KAR-17.2                                                             | Edge case   |
| EPIC-17-S11 | The interactive-ELK experiment does not work, and nothing breaks                          | KAR-17.2                                                             | Failure     |
| EPIC-17-S12 | **Journey:** click a node, see exactly what it received, with a token breakdown           | KAR-17.3                                                             | Happy path  |
| EPIC-17-S13 | Attempt 1 beside attempt 3 of a repair loop                                               | KAR-17.3                                                             | Happy path  |
| EPIC-17-S14 | Every number links to the event that produced it                                          | KAR-17.3                                                             | Edge case   |
| EPIC-17-S15 | The provenance table, and the graph it stands in for                                      | KAR-17.3                                                             | Edge case   |
| EPIC-17-S16 | A node that failed before a packet existed                                                | KAR-17.3                                                             | Failure     |
| EPIC-17-S17 | The stacked bar, with the pinned set at the base                                          | KAR-17.4                                                             | Happy path  |
| EPIC-17-S18 | The compaction whose "after" does not exist                                               | KAR-17.4                                                             | Failure     |
| EPIC-17-S19 | A pinned constraint that did not survive into the prompt                                  | KAR-17.4                                                             | Failure     |
| EPIC-17-S20 | Tail a live agent, close the panel, come back to it                                       | KAR-17.5                                                             | Happy path  |
| EPIC-17-S21 | Structured ACP output is not a terminal                                                   | KAR-17.5                                                             | Edge case   |
| EPIC-17-S22 | Twenty terminals opened, and the WebGL contexts that were not leaked                      | KAR-17.5                                                             | Failure     |
| EPIC-17-S23 | "Open full log" never touches xterm                                                       | KAR-17.5                                                             | Edge case   |
| EPIC-17-S24 | **Journey:** a gate fails and the Operator lands on the offending line                    | KAR-17.6                                                             | Happy path  |
| EPIC-17-S25 | `needs-human` is not a red file                                                           | KAR-17.6                                                             | Edge case   |
| EPIC-17-S26 | Three scopes of diff, one selection                                                       | KAR-17.6                                                             | Edge case   |
| EPIC-17-S27 | The repair loop, made legible at a glance                                                 | KAR-17.6                                                             | Happy path  |
| EPIC-17-S28 | Has the requested outcome been achieved?                                                  | KAR-17.7                                                             | Happy path  |
| EPIC-17-S29 | `unverifiable` is a spec defect, not a failure                                            | KAR-17.7                                                             | Failure     |
| EPIC-17-S30 | Parallelism, stalls and where the money went                                              | KAR-17.8                                                             | Happy path  |
| EPIC-17-S31 | Six idle hours are not six busy hours                                                     | KAR-17.8                                                             | Edge case   |
| EPIC-17-S32 | Every chart has a data-table twin                                                         | KAR-17.8, KAR-17.4                                                   | Edge case   |
| EPIC-17-S33 | The memory graph aggregates before it renders                                             | KAR-17.9                                                             | Happy path  |
| EPIC-17-S34 | The measurement decides whether this view ships at all                                    | KAR-17.9                                                             | Failure     |
| EPIC-17-S35 | **The five-minute diagnosis, end to end**                                                 | KAR-17.1, KAR-17.2, KAR-17.3, KAR-17.4, KAR-17.6, KAR-17.7, KAR-17.8 | Happy path  |

---

## EPIC-17-S1 — Happy path: the Operator opens a running run and sees it move

**Verifies:** KAR-17.1 · **Type:** Happy path · **Automated at:** browser + e2e

```gherkin
Feature: Live plan graph (F10.1)

  Scenario: Opening a run that is mid-flight
    Given a run "r_01JXQ" with 18 nodes, of which 3 are running, 9 passed, 1 failed,
          1 awaiting-human, 2 blocked and 2 pending
    When the Operator opens the run
    Then the graph renders all 18 nodes at their correct state
    And each node body shows its type glyph, title, state label, provider and model,
        permission level, elapsed time and cost so far
    And the 3 running nodes carry a streaming badge
    And the failed node carries its gate verdict chip
    And the awaiting-human node is visually distinct from both blocked and pending

  Scenario: It moves without being refreshed
    When DeFlowd appends "node.completed" for "n_recon"
    Then that node transitions to "passed" within one frame
    And its dependents that are now unblocked transition from "blocked" to "pending"
    And no refetch of any endpoint occurred — the transition came from the stream

  Scenario: Progress is not a state change
    When 40 "node.progress" events arrive for a running node
    Then the node's phase text updates
    And its state remains "running" throughout
    And the layout is not recomputed 40 times

  Scenario: A node is one click from everything else
    When the Operator selects "n_impl_3" and presses Enter
    Then the node inspector opens for it
    And the selection is reflected in the URL so the position is linkable
```

**Notes:** the reason a custom node is a Vue component — the entire justification for choosing Vue
Flow over the canvas-first alternatives — is visible in the first scenario: per-node live status, a
streaming badge, a gate verdict and a cost figure are _components_, not glyphs painted on a canvas
([12 §6.1](../../12-frontend-architecture.md)). This is Playwright smoke #1.

---

## EPIC-17-S2 — Seven states, and edges that say what flows across them

**Verifies:** KAR-17.1 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: State encoding and labelled edges (F10.1)

  Scenario Outline: Every state, three signals
    When a node in state "<state>" renders
    Then its border reads the CSS custom property "--state-<state>"
    And it displays a distinct glyph
    And its accessible name contains "<label>"
    And it is distinguishable from every other state with colour disabled

    Examples:
      | state          | label          | meaning                                          |
      | pending        | Pending        | admitted but not started                          |
      | running        | Running        | an agent or tool is executing                     |
      | blocked        | Blocked        | dependencies unsatisfied                          |
      | passed         | Passed         | completed and, where gated, verified              |
      | failed         | Failed         | terminal typed NodeFailure                        |
      | abandoned      | Abandoned      | a PlanPatch gave up on this branch                |
      | awaiting-human | Awaiting human | suspended on a human node or an escalation        |

  Scenario: Abandoned is not failed
    Then a branch the planner abandoned renders differently from a branch that broke
    And the distinction is in the lifecycle field, not in the failure reason

  Scenario: Edges labelled with what flows across them
    Given a data edge from "n_recon" to "n_impl_3" with carries ["finding/auth-uses-jwt"]
    Then hovering the edge shows that fact key
    And the data-table twin lists it
    And a control edge shows no carried facts, because it carries none
```

**Notes:** `carries[]` is a field on `PlanEdge`, populated for `kind: 'data'`
([04 §3](../../04-domain-model.md)) — F10.1's _"edges labelled with what flows across them"_ is
therefore real data, not a label invented at render time. The colour-disabled assertion is the WCAG
1.4.1 check made mechanical.

---

## EPIC-17-S3 — A `map` fan-out arrives while the Operator is panning

**Verifies:** KAR-17.1 · **Type:** Concurrency · **Automated at:** browser

```gherkin
Feature: The graph changes underneath an interaction

  Scenario: 30 map children arrive over ten seconds
    Given the Operator is panning the viewport
    When a "map" node fans out and 30 child nodes arrive over ten seconds
    Then the pre-existing nodes keep their relative ordering
    And the pan is not interrupted, and the viewport does not jump
    And the node transition is disabled during the pan, so nothing appears to fight the drag

  Scenario: Layout during streaming versus layout at rest
    Then dagre provides the sub-16ms relayout while nodes are still arriving
    And ELK in the worker produces the settled layout once the burst ends
    And both are fed the node array in ledger-insertion order with
        considerModelOrder.strategy = "NODES_AND_EDGES"

  Scenario: The animation rule
    Then the only node animation is the CSS transition on ".vue-flow__node"
    And no code writes a transform on a node, because Vue Flow writes an inline transform
        and would overwrite it
```

**Notes:** the drag-fighting symptom is specific and named in
[12 §6.1](../../12-frontend-architecture.md) — _"disable that transition during node drag and during
viewport pan/zoom, or dragging feels like it is fighting you."_ It is the kind of defect that never
gets filed and permanently makes the tool feel cheap.

---

## EPIC-17-S4 — Four hundred nodes, against the measured budget

**Verifies:** KAR-17.1 · **Type:** Edge case · **Automated at:** e2e

```gherkin
Feature: The render budget is a number, not a hope

  Scenario: The stress fixture
    Given "deflow replay fixtures/stress-400.jsonl --speed max"
    When the graph renders all 400 nodes
    Then p95 frame time during a scripted pan is within the budget recorded in
         docs/measurements/vue-flow-400.md
    And onlyRenderVisibleElements is set according to that same measurement
    And the view remains interactive: selecting a node opens the inspector within the NF3 budget

  Scenario: What the measurement replaced
    Then the ~300–500 smooth / 500–1,500 with culling / stalls past ~2,000 figures in the
         architecture are an ESTIMATE extrapolated from React Flow guidance
    And this project now has its own measured number instead

  Scenario: A regression is caught, jitter is not
    Given CI runs the same scripted pan
    When p95 frame time exceeds the recorded budget beyond the stated tolerance
    Then the build fails, naming the measurement file
```

**Notes:** A3-2, rated **High** in the open-risks register, and the reason
[roadmap §2.3](../../17-roadmap.md) says to measure in week one of W10 rather than week four of W11.
The measurement is EPIC-16's deliverable; this scenario is where a view is held to it.

---

## EPIC-17-S5 — Marquee journey: scrub back to the approved plan and step forward through every patch

**Verifies:** KAR-17.2 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: Plan evolution scrubber (F10.2) — the marquee feature

  Scenario: "Why is there a step here that I didn't ask for?"
    Given a completed run whose plan went through four versions
    And the version rail shows v1 (planner), v2 (auto), v3 (approved), v4 (auto)
    When the Operator drags the rail back to v1
    Then the graph shows the plan exactly as it was approved, and no other nodes
    And the side panel shows "proposed by: planner"

    When the Operator presses the right arrow once
    Then the graph shows v2
    And the side panel shows the reason string from the plan.patched event —
        "Recon found 3 additional packages using the design system; splitting the
         migration node by package"
    And the tick for v2 is coloured for decision "auto"
    And the nodes added by that patch carry a "+" badge and an accent border

    When the Operator presses right again
    Then v3 renders, its tick coloured for decision "approved"
    And the panel names who approved it and when

    When the Operator presses right again
    Then v4 renders with reason
        "Anthropic rate limit hit; re-routing implementation node to Codex"
    And the changed node carries a modified marker

  Scenario: The answer took one interaction, not a log read
    Then the Operator has, in four keystrokes, seen every change to the plan and why each happened
    And every reason came from a plan.patched event's reason field, not from a summary
```

**Notes:** this is the demo. PRD §15.4 and [roadmap §7](../../17-roadmap.md) both identify a real
Voyado task shown through this view as the strongest internal presentation, and PRD §4.8's table has
this column empty for every competitor. Playwright smoke #2 automates exactly this journey.

---

## EPIC-17-S6 — Nothing moves as you scrub

**Verifies:** KAR-17.2 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: Union-graph layout, computed once and cached (12 §6.2)

  Scenario: The property the whole view depends on
    Given versions v3 and v4 which share 38 of 40 nodes
    When the Operator steps from v3 to v4
    Then every node present in both versions has BYTE-IDENTICAL coordinates
    And the assertion is numeric, on the rendered transform, not visual

  Scenario: How it is achieved
    Then the layout was computed once over the UNION graph — every node and edge appearing
         in either version
    And it was cached under the "unionLayoutKey" returned by GET /api/runs/:id/plans/diff
    And both versions render at those coordinates

  Scenario: The cache is used
    When the Operator scrubs v3 → v4 → v3 → v4
    Then exactly one ELK worker layout call was made for that version pair

  Scenario: Why a reflowing implementation would be worthless
    Given an implementation that lays out each version independently
    When a 40-node replan is stepped through
    Then the reflow is too large for the eye to track
    And the Operator ends up diffing by hand, which is the thing this view exists to remove
    And this test must fail for that implementation
```

**Notes:** _"its entire value is that a human can see what changed, so any layout that reflows between
versions destroys it"_ ([12 §6.2](../../12-frontend-architecture.md)). Note the identity contract
underneath: `nodeId` is assigned by the planner and stable across patches, asserted in the daemon —
**never derived from position or label**, or both this view and the memory graph's provenance produce
silently wrong output.

---

## EPIC-17-S7 — Added, removed, changed, unchanged — encoded four ways

**Verifies:** KAR-17.2 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: The four-way diff encoding

  Scenario Outline: Each class has a non-colour signal
    Given a node classified "<class>" between two versions
    Then it renders with "<encoding>"
    And it is distinguishable from the other three with colour disabled

    Examples:
      | class     | encoding                                                    |
      | added     | solid accent border and a "+" badge                          |
      | removed   | rendered in place at reduced opacity with a dashed stroke    |
      | changed   | a modified marker and a click-through to the field patch     |
      | unchanged | normal rendering                                             |

  Scenario: How the classes are computed
    Then added = ids(Vb) \ ids(Va)
    And removed = ids(Va) \ ids(Vb)
    And changed = the intersection where contentHash differs
    And unchanged = the rest
    And the same set diff is applied to edges, whose identity is "${source}->${target}"

  Scenario: The content hash
    Then contentHash covers type, provider, permission, brief, reads[], writes[] and retry policy
    And it is computed with ohash for stable key ordering, which JSON.stringify does not give you
    And it is used for change detection only, never as an identity or a primary key,
        because ohash promises only "best efforts" at stable serialisation

  Scenario: Removed nodes stay in place
    Then a removed node renders at its union-layout coordinates, not off-canvas
    And that is why the union graph includes nodes from both versions
```

**Notes:** rendering removed nodes _in place_ is what makes a removal legible — a node that vanishes
is indistinguishable from a node that moved off screen, and the union layout is what makes "in place"
meaningful at all.

---

## EPIC-17-S8 — "Why did this change" at field level

**Verifies:** KAR-17.2 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: RFC 6902 field-level patches beside the human reason

  Scenario: A provider re-route
    Given node "n_impl_3" is classified "changed" between v3 and v4
    When the Operator clicks it
    Then the panel shows the RFC 6902 patch between the two node objects:
         [{ "op": "replace", "path": "/provider", "value": "codex" }]
    And beside it the human-readable reason from the plan.patched event:
         "Anthropic rate limit hit; re-routing implementation node to Codex"
    And the decision "auto" and the patch id

  Scenario: A change with several fields
    Given a patch that changed permission from "worktree" to "worktree+net" and extended retry
    Then every changed field appears as its own RFC 6902 operation
    And a permission escalation is called out distinctly, because escalating permission is
        exactly what the patch policy gates on

  Scenario: The library choice, recorded
    Then the patch is produced with rfc6902@^5.3.0
    And NOT with fast-json-patch, which last shipped in 2022
```

**Notes:** the pairing of the machine diff with the human reason is what makes this panel diagnostic
rather than decorative: the reason tells you the intent, the patch tells you what actually changed,
and the two disagreeing is itself a finding.

---

## EPIC-17-S9 — A patch that was proposed and refused

**Verifies:** KAR-17.2 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: The rail records refusals as well as applications (F2.5)

  Scenario: A rejected patch
    Given a "plan.patch.proposed" event followed by "plan.patch.rejected"
          with rule "blast-radius > 12 files" and by "policy"
    Then the rail shows a distinct mark for the rejected proposal
    And the plan version did NOT advance across it
    When the Operator clicks the mark
    Then the panel shows what was proposed, the rule that refused it, and who refused it

  Scenario: A patch queued for approval and then approved by a human
    Then the tick is coloured for decision "approved"
    And the panel names the approver and the time

  Scenario: Why refusals are on the rail at all
    Then "the proposal is recorded even if rejected" is a property of the ledger
    And a run whose planner repeatedly proposed the same refused change is a diagnosable
        pattern — invisible if only applied patches were shown
```

**Notes:** the three decision values come straight off `plan.patched` and `plan.patch.rejected`
([04 §9](../../04-domain-model.md)). The last scenario is the diagnostic argument: a planner looping
on a refused proposal is a real failure mode and the rail is where it becomes visible.

---

## EPIC-17-S10 — Comparing versions that are not adjacent

**Verifies:** KAR-17.2 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: The secondary comparison mode

  Scenario: v1 against v6
    When the Operator selects v1 and v6 for comparison
    Then the view enters the secondary mode: a full reflow with a FLIP animation
    And it is explicitly labelled as a comparison, not as stepping
    And the four-way encoding still applies

  Scenario: The primary mode is never this
    Then stepping between adjacent versions always uses the union layout
    And the reflow mode is never used for adjacent stepping,
        because on a real 40-node replan the reflow is too large for the eye to track

  Scenario: Reduced motion
    Given prefers-reduced-motion is reduce
    Then the FLIP animation does not play and the comparison renders directly
```

**Notes:** the fallback is _"cheaper to build … acceptable as a secondary mode; never as the primary
one"_ ([12 §6.2](../../12-frontend-architecture.md)). Keeping it explicitly secondary matters because
it is the tempting shortcut if the union layout is late.

---

## EPIC-17-S11 — The interactive-ELK experiment does not work, and nothing breaks

**Verifies:** KAR-17.2 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: The demoted experiment (A3-5)

  Scenario: The recipe that circulates and does not work
    Given the commonly-written approach of maintaining one running layout for the whole run by
          passing each surviving node's previous layer index as layering.layerChoiceConstraint
          and its in-layer index as crossingMinimization.positionChoiceConstraint
    Then it does not work as written, for three separate reasons:
         those options are consumed only when org.eclipse.elk.interactiveLayout = true;
         "semiInteractive" reads org.eclipse.elk.position rather than positionChoiceConstraint;
         and constraint enforcement is a known elkjs weak spot

  Scenario: The scrubber does not depend on it
    Then the union-graph-laid-out-once approach is the load-bearing mechanism
    And it is sufficient on its own
    And EPIC-17-S6's byte-identical-coordinates assertion passes with the experiment disabled

  Scenario: The experiment stays an experiment
    Then any interactive-constraint code is behind a flag, off by default
    And disabling it changes no acceptance criterion of KAR-17.2
```

**Notes:** this scenario exists to stop the recipe being reintroduced from a search result. Both
[12 §6.2](../../12-frontend-architecture.md) and [roadmap §1 S3](../../17-roadmap.md) state it, and
the way to make a documented non-mechanism stay non-load-bearing is to assert that turning it off
changes nothing.

---

## EPIC-17-S12 — Journey: click a node, see exactly what it received, with a token breakdown

**Verifies:** KAR-17.3 · **Type:** Happy path · **Automated at:** browser + e2e

```gherkin
Feature: Node inspector (F10.3) — PRD §2.1's third broken thing, in one screen

  Scenario: Opening the node that produced the bad diff
    Given the Operator has a bad diff from node "n_impl_3"
    When they select the node and press Enter
    Then the inspector opens showing:
         identity and type, provider, model, CLI version and binary sha256,
         permission level, path scopes, worktree path, duration, cost, and attempt history

  Scenario: The context packet, segment by segment
    Then the packet section lists every Segment with its kind, token count, pinned flag
         and sourceEvent
    And segments are grouped by the nine SegmentKind values:
         pinned.constraints, pinned.spec, pinned.pathscope, task.brief, fact,
         artifact.handle, retrieved, history.summary, tool.output
    And pinned segments render first, as they do in the prompt
    And the per-segment token counts SUM to the header total

  Scenario: The prompt is shown, and labelled as derived
    Then the exact rendered prompt is displayed from its artifact handle,
         highlighted by the single shared Shiki instance
    And it is labelled as derived from the manifest, which is authoritative

  Scenario: Output, twice
    Then the raw output and the normalised, schema-validated output are shown separately
    And a contract.schema-invalid failure shows the Ajv error beside the offending output

  Scenario: What this tells the Operator
    Then they can distinguish "the agent was wrong" from "the agent was given the wrong
         information", which are different bugs with different fixes
```

**Notes:** the sum assertion is Playwright smoke #3 from [14 §13](../../14-testing-strategy.md) —
_"open the node inspector; the context packet's segment token breakdown sums to the header total."_
It is a smoke rather than a unit test because it proves the endpoint, the projection and the render
agree, which is where a divergence would actually hide.

---

## EPIC-17-S13 — Attempt 1 beside attempt 3 of a repair loop

**Verifies:** KAR-17.3 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: The attempt selector

  Scenario: Diagnosing why attempt 3 also failed
    Given node "n_impl_3" failed on attempt 1, was repaired, and failed again on attempt 3
    When the Operator opens the inspector and selects "compare attempt 1 with attempt 3"
    Then both packets render side by side, diffed segment by segment
    And segments present in one and not the other are marked
    And a segment whose contentHash changed is marked as changed

  Scenario: What that reveals
    Then the Operator can see whether the repair actually changed the node's context
    And a repair that produced an identical packet is a visible, diagnosable no-op

  Scenario: Retry history is a first-class list
    Then every attempt shows its outcome, its typed NodeFailure reason and class where it failed,
         its duration, its cost, and the seq of its node.started event
    And attempts are keyed by (nodeId, attempt), which is also the idempotency key shape
```

**Notes:** _"retries are the interesting case, and comparing attempt 1 to attempt 3 side by side is
how you diagnose a repair loop"_ ([12 §6.3](../../12-frontend-architecture.md)). This is the feature
most likely to be cut for time and most likely to be missed the first time a repair loop misbehaves.

---

## EPIC-17-S14 — Every number links to the event that produced it

**Verifies:** KAR-17.3 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: NF10 made visible

  Scenario Outline: Click-through to the producing event
    When the Operator clicks "<value>" in the inspector
    Then the debug ring selects the event of kind "<kind>" that produced it
    And the raw EventEnvelope is shown, including its seq

    Examples:
      | value                    | kind             |
      | a segment's token count  | context.built     |
      | a fact in the packet     | fact.written      |
      | the node's cost          | budget.consumed   |
      | the state transition     | node.completed    |
      | the gate verdict chip    | gate.evaluated    |

  Scenario: Why this is the difference between a dashboard and a tool
    Then "any state in the UI is traceable to specific ledger events" is demonstrated, not claimed
    And a value with no producing event cannot exist, because the projections have no other input

  Scenario: The link survives a scrub
    Given the Operator scrubbed to an earlier plan version
    Then the ring is hydrated from the snapshot at that seq
    And click-through resolves within the events available from that snapshot forward
```

**Notes:** _"that link is NF10 made visible, and it is what turns the inspector from a dashboard into
a diagnostic tool"_ ([12 §6.3](../../12-frontend-architecture.md)). It is also the fastest way to
falsify a suspected projection bug: if the event says one thing and the view says another, the
projection is wrong; if they agree, the daemon is.

---

## EPIC-17-S15 — The provenance table, and the graph it stands in for

**Verifies:** KAR-17.3 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: F10.4's 80%, at forty lines of markup (roadmap §3)

  Scenario: What did this node read, and who wrote each fact
    When the Operator opens the inspector's provenance table
    Then every fact the node read is listed with:
         key, value summary, writing node, evidence handles, timestamp, confidence
    And each row links to the fact.written event that produced it
    And each row links to the writing node's inspector

  Scenario: A fact that later proved wrong
    Given a fact this node consumed was subsequently invalidated
    Then the row is marked invalidated with the reason and the invalidating node
    And the node itself is flagged as tainted

  Scenario: The trade this represents
    Then this table answers "which node produced the wrong assumption?" for one node
    And the full memory graph (KAR-17.9) answers it across the whole run
    And per roadmap §3 the table is M1's coverage of F10.4 if the graph slips
```

**Notes:** [roadmap §3](../../17-roadmap.md): _"the node inspector already answers the 80% question …
a provenance table inside F10.3 — perhaps 40 lines of markup against a graph surface that is a week
of layout, culling and interaction work."_ This scenario is what makes that claim testable rather
than rhetorical.

---

## EPIC-17-S16 — A node that failed before a packet existed

**Verifies:** KAR-17.3 · **Type:** Failure · **Automated at:** browser

```gherkin
Feature: Honest emptiness

  Scenario Outline: Failures that precede context assembly
    Given a node that failed with reason "<reason>" and class "<class>"
    When the Operator opens the inspector
    Then the packet section states explicitly that no packet was built
    And the typed NodeFailure is rendered: reason, class, one-line message, and evidence handles
    And the panel is not blank, and no packet is fabricated

    Examples:
      | reason                          | class     |
      | adapter.spawn-failed             | permanent |
      | adapter.handshake-failed         | transient |
      | safety.permission-unschedulable  | permanent |
      | adapter.capability-missing       | permanent |

  Scenario: A node whose adapter reports no token accounting
    Given the provider's capability manifest declares tokenAccounting "none"
    Then the token figures state the absence explicitly
    And no zero is displayed as though it were a measurement

  Scenario: An oversized frame
    Given a node that failed with "adapter.frame-too-large" at the 8 MiB cap
    Then the evidence handle for the offending frame's first 4 KiB is linked
    And the inspector does not attempt to render the whole frame
```

**Notes:** every failure must be _serialisable into the ledger and renderable in the node inspector_
— _"a thrown `Error` with a V8 stack is neither"_ ([04 §8](../../04-domain-model.md)). This scenario
is where that design pays out: the inspector renders a closed union, not a monospace box.

---

## EPIC-17-S17 — The stacked bar, with the pinned set at the base

**Verifies:** KAR-17.4 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: Context budget visualisation (F10.5)

  Scenario: One bar per invocation
    Given a run with 12 node invocations
    Then the chart renders 12 stacked bars, one per invocation, in seq order
    And each bar is segmented by SegmentKind
    And pinned segments — pinned.constraints, pinned.spec, pinned.pathscope — form the base
        of the stack, matching the order they render in the prompt

  Scenario: Headroom is visible
    Then each bar shows the budget line from budget.limitTokens
    And the default budget fraction is 0.5 and is never above 0.6
    And a bar approaching the line is legible as approaching it, not merely tall

  Scenario: Hover tells the whole story
    When the Operator hovers a segment
    Then it shows the kind, the token count, the counting method
         (gpt-tokenizer/o200k_base | heuristic | vendor-reported), and the sourceEvent
    And clicking it opens that segment in the node inspector

  Scenario: Estimated and vendor-reported are never one number
    Then a bar mixing sources labels them separately
    And no displayed total sums an estimated figure with a vendor-reported one
```

**Notes:** the segment vocabulary is not invented — it mirrors the categories Claude Code itself uses
for its own `/context` breakdown, decompiled from the shipping bundle
(**verified 2026-08-02**, [04 §6.1](../../04-domain-model.md)). Reusing that taxonomy means this
chart lines up visually with what the Operator already sees inside the vendor CLI.

---

## EPIC-17-S18 — The compaction whose "after" does not exist

**Verifies:** KAR-17.4 · **Type:** Failure · **Automated at:** browser

```gherkin
Feature: Render the gap as a gap (F6.6)

  Scenario: DeFlow's own packet compaction
    Given a context.compacted event with scope "DeFlow.packet" and fidelity "exact"
    Then the annotation shows before → after with the delta
    And droppedSegments[] is listed
    And originalHandle links to the full original artifact
    And pinnedKept[] is shown as a positive assertion that the integrity check passed

  Scenario: The vendor's own compaction
    Given a context.compacted event with scope "vendor.session", fidelity "partial",
          after null and droppedSegments []
    Then the annotation renders an explicit GAP
    And it is labelled "vendor-reported; post-count unavailable"
    And there is NO numeric after value anywhere in the DOM for that mark
    And no interpolation, no zero and no dashed guess is drawn

  Scenario: Why the data is missing
    Then Claude Code's stream-json emits
         { type: "system", subtype: "compact_boundary",
           compact_metadata: { trigger, pre_tokens } }
    And pre_tokens only — no post count, no dropped list, no handle to the original
    And that was verified 2026-08-02 by decompiling the shipping bundle

  Scenario: The rule this encodes
    Then a bar with a fabricated "after" number is worse than an honest hole
    And a build that renders one must fail this test
```

**Notes:** this is the single scenario that most directly expresses the project's honesty discipline.
_"Encoding that uncertainty in the type is the difference between an auditable system and one that
quietly lies"_ ([04 §9.1](../../04-domain-model.md)) — and the type only helps if the view respects
it, which is what this asserts.

---

## EPIC-17-S19 — A pinned constraint that did not survive into the prompt

**Verifies:** KAR-17.4 · **Type:** Failure · **Automated at:** browser

```gherkin
Feature: Pin integrity, surfaced (F6.6)

  Scenario: The check that fails the node
    Given a pin.integrity_violated event carrying missingDigests and segmentIds
    Then the chart renders a blocking marker on that invocation
    And it names which pinned segments went missing
    And the node's failure reason "safety.pin-integrity-violated" is shown with it

  Scenario: Why this is a first-class marker and not a warning
    Then the pinned set — TaskSpec, acceptance criteria, safety constraints, path scopes,
         permission level — is never compacted and is re-injected verbatim on every packet
    And compaction actively deleting governance constraints is a documented mechanism,
        distinct from ordinary long-context attention dilution
    And it is the reason the pinned set exists at all

  Scenario: The positive case
    Given a packet whose pinned digests all survived
    Then pinnedKept[] is rendered as evidence that the check ran and passed
    And the absence of a violation marker is therefore meaningful, not merely uninformative
```

**Notes:** [roadmap §3](../../17-roadmap.md) names F10.5 as one of the three views that carry the
diagnosis metric precisely because of this failure mode — _"the failure mode with a peer-reviewed
mechanism behind it (governance decay under compaction)"_. Note A4-5: the arXiv results behind that
claim were read via search indexing rather than the PDFs, so re-verify the specific numbers before
quoting them publicly. The design stands on its own.

---

## EPIC-17-S20 — Tail a live agent, close the panel, come back to it

**Verifies:** KAR-17.5 · **Type:** Happy path · **Automated at:** browser + integration

```gherkin
Feature: Live agent output (F10.6)

  Scenario: A node that has been running for eleven minutes
    Given "n_impl_3" is running against a CLI-shim adapter emitting ANSI output
    When the Operator opens its output panel
    Then the last N KB are fetched via GET /api/runs/:id/nodes/:nodeId/io with fromSeq omitted
         and limit set — never the whole log
    And live chunks stream in after the backfill
    And the terminal is configured with scrollback 5000

  Scenario: Closing and reattaching
    When the Operator closes the panel
    Then an @xterm/addon-serialize snapshot string is taken
    And term.dispose() is called
    And only the string is retained
    When they reopen the panel
    Then a fresh Terminal is constructed and the snapshot is written back
    And no refetch of the whole log occurred

  Scenario: The archive is on disk, not in the tab
    Then the complete output lives at runs/<runId>/nodes/<nodeId>/stdout.log (NF8)
    And the browser terminal is a live tail, not the archive

  Scenario: Honest emptiness
    Given a node that produced no output at all
    Then the panel says so explicitly rather than showing an empty terminal that looks broken
```

**Notes:** the scrollback ceiling is arithmetic, not preference: `BufferLine` allocates
`new Uint32Array(3 * cols)` — **12 bytes per cell**, read out of the v6 source, **verified
2026-08-02**. At 200 columns that is ≈ 13 MB for 5,000 lines and ≈ 260 MB for 100,000, **per
terminal**. _"Set `scrollback: 5000` and never raise it."_

---

## EPIC-17-S21 — Structured ACP output is not a terminal

**Verifies:** KAR-17.5 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: The right renderer for the right stream (12 §6.6)

  Scenario: An ACP adapter's output
    Given "n_impl_3" is running against an ACP adapter
    Then its output renders as a VIRTUALISED LIST OF TYPED MESSAGE COMPONENTS, not a terminal
    And each message is typed: agent_message_chunk, tool_call, tool_call_update, plan update
    And each is individually selectable, searchable and linkable to its seq
    And highlighting uses @shikijs/stream, which colourises incrementally without re-tokenising
        the whole buffer per chunk

  Scenario: Why not xterm here
    Then ACP streaming updates are typed JSON, not a TTY byte stream
    And the list is faster, searchable, selectable, diffable, themeable and accessible

  Scenario: Where xterm still earns its place
    Given a CLI-shim adapter whose output is genuinely ANSI with cursor movement and spinners
    Then that node uses xterm

  Scenario: Incremental highlighting is measured, not assumed
    When a 2,000-chunk stream is rendered
    Then per-chunk render time does not grow linearly with buffer size
```

**Notes:** this split is also the roadmap's soft scope-cut taken deliberately — _"a plain append-only
log pane with `@shikijs/stream` highlighting covers the diagnostic need for M1 at a fraction of the
cost, and full terminal emulation lands in M2"_ ([roadmap §3](../../17-roadmap.md)). The xterm path
is kept only where the output really is a TTY stream.

---

## EPIC-17-S22 — Twenty terminals opened, and the WebGL contexts that were not leaked

**Verifies:** KAR-17.5 · **Type:** Failure · **Automated at:** browser

```gherkin
Feature: Dispose discipline

  Scenario: The silent failure this prevents
    Given the Operator opens and closes 20 node terminals over an hour
    Then the number of live Terminal instances equals the number currently VISIBLE
    And WebGL contexts in use stay under the browser cap of roughly 8–16
    And rendering in the oldest terminals still works

  Scenario: What happens without it
    Given a build that keeps one Terminal per OPENED terminal
    Then enough undisposed terminals silently kill rendering in the oldest ones
    And there is no error, no warning and no obvious cause
    And this test must fail for that build

  Scenario: The renderer choice
    Then @xterm/addon-webgl is loaded with a DOM fallback wired to its onContextLoss event
    And @xterm/addon-canvas is NOT used — it was removed in v6

  Scenario: Vue never proxies the Terminal
    Then the Terminal instance is markRaw'd
    And isProxy(terminal) is false
```

**Notes:** _"Terminal objects hold large typed arrays and, with the WebGL addon, a GL context"_
([12 §6.6](../../12-frontend-architecture.md)). Total memory becomes proportional to _visible_
terminals rather than to every terminal ever opened — which is the same apply-and-drop shape as
EPIC-16's event ring, applied to a different resource.

---

## EPIC-17-S23 — "Open full log" never touches xterm

**Verifies:** KAR-17.5 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: The archive path

  Scenario: A 400 MB stdout log
    When the Operator clicks "Open full log"
    Then the artifact streams into a virtualised read-only viewer
         (@tanstack/vue-virtual, line-indexed, byte-range fetches)
    And no Terminal instance is constructed on this path
    And the tab does not stall

  Scenario: Search within the archive
    Then search operates over byte ranges fetched on demand, not over a fully-loaded buffer

  Scenario: The rule
    Then the browser terminal is a live tail; the viewer is the archive
    And the same rule applies on reattach: ask for the last N KB, never the whole file
```

**Notes:** `GET /api/artifacts/:sha` supports `Range` and is immutably cacheable
([11 §6](../../11-api-and-realtime.md)), which is what makes the byte-range viewer cheap. Putting a
400 MB log into xterm is a tab death with a very clear cause and no warning.

---

## EPIC-17-S24 — Journey: a gate fails and the Operator lands on the offending line

**Verifies:** KAR-17.6 · **Type:** Happy path · **Automated at:** browser + e2e

```gherkin
Feature: Diff and review with inline verdicts (F10.7, F7.7)

  Scenario: From a red gate to a line of code
    Given the gate "typecheck" evaluated node "n_impl_3" and returned outcome "fail"
    And its verdict carries a finding with severity "blocker",
        criterion "AC-3",
        location { file: "packages/ui/src/Button.vue", line: 42 },
        message "Property 'variant' is missing in type but required in type 'ButtonProps'",
        and an evidence handle to the tsc output
    When the Operator clicks the failing gate chip on the plan graph
    Then the diff surface opens on the per-node diff for "n_impl_3"
    And "packages/ui/src/Button.vue" is selected
    And the view is scrolled to line 42
    And the finding renders INLINE at line 42 as a Vue widget in the per-line slot
    And the widget shows severity, message, the criterion it maps to, and a link to the evidence

  Scenario: The evidence is one more click
    When the Operator opens the evidence handle
    Then the tsc output artifact opens in the virtualised viewer
    And the finding's line is highlighted within it

  Scenario: And back again
    When the Operator clicks the criterion "AC-3" on the finding
    Then the acceptance-criteria board opens with that criterion expanded
    And every gate that speaks to it is listed
```

**Notes:** first-class inline widget slots per line are _the_ reason `@git-diff-view/vue` was chosen —
`diff2html` is a string → HTML generator, so attaching Vue verdict widgets at specific lines would
mean DOM surgery ([12 §6.7](../../12-frontend-architecture.md)). The patch itself comes from
`DeFlowd` shelling out to `git diff` and serving `text/x-patch`, which is orders of magnitude faster
and more correct than diffing in JavaScript.

---

## EPIC-17-S25 — `needs-human` is not a red file

**Verifies:** KAR-17.6 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: Three outcomes, three renderings (F7.3)

  Scenario Outline: Outcome rendering
    Given a verdict with outcome "<outcome>"
    Then the file renders "<rendering>"
    And the outcome is encoded by glyph and label as well as colour

    Examples:
      | outcome     | rendering                                              |
      | pass        | a passing marker, no findings surfaced by default        |
      | fail        | a failing marker with blocker/major findings inline      |
      | needs-human | a distinct "judgement required" marker, NOT red          |

  Scenario: Why needs-human must not read as failure
    Given an adversarial reviewer returned needs-human because the question is a judgement call
    Or a deterministic gate returned needs-human because its own tooling failed —
       a flaky runner, a missing binary
    Then neither means the work is wrong
    And conflating them with fail sends work into the repair loop that no amount of repair will fix

  Scenario Outline: Finding severity
    Given a finding with severity "<severity>"
    Then it renders with a distinct glyph and the label "<severity>"
    And blockers and majors are surfaced by default; minors and infos are collapsible

    Examples:
      | severity |
      | blocker  |
      | major    |
      | minor    |
      | info     |

  Scenario: A finding with no location
    Then it renders at FILE level
    And it is not dropped, and it is not guessed onto line 1
```

**Notes:** _"`needs-human` is a first-class outcome, not a failure mode"_
([04 §7](../../04-domain-model.md)). The location-less finding case is small and worth asserting: the
naive implementation puts it on line 1, which is silently misleading in exactly the way this whole
surface exists to prevent.

---

## EPIC-17-S26 — Three scopes of diff, one selection

**Verifies:** KAR-17.6 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: Per-node, per-worktree, cumulative

  Scenario Outline: Switching scope
    When the Operator selects scope "<scope>"
    Then the view requests "<request>"
    And the file selection is preserved where the file exists in the new scope

    Examples:
      | scope      | request                                   |
      | node       | GET /api/runs/:id/diff?node=n_impl_3       |
      | worktree   | GET /api/runs/:id/diff?worktree=<name>     |
      | cumulative | GET /api/runs/:id/diff?cumulative=1        |

  Scenario: A large diff does not freeze the tab
    Given a file with 5,000 changed lines
    Then it renders collapsed with an explicit expand control
    And expanding it virtualises rather than rendering every line at once

  Scenario: Findings follow the scope
    Then findings are fetched via GET /api/runs/:id/findings?file= and attached per file,
         ordered by line
    And a finding produced by a gate on a different node still attaches to the file it names
```

**Notes:** the diff route is lazy — `@git-diff-view/*` must be absent from the initial chunk
([12 §10](../../12-frontend-architecture.md)) — which also means the first open of this view has a
load cost worth showing honestly rather than hiding behind a blank panel.

---

## EPIC-17-S27 — The repair loop, made legible at a glance

**Verifies:** KAR-17.6 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: @shikijs/magic-move on the surgical repair loop (F7.5)

  Scenario: One issue, one fix
    Given the gate-fail-repair fixture: a failing gate, a surgical fix node, a second attempt,
          a pass
    When the Operator opens the repaired file
    Then a magic-move transition animates the before → after at token level
    And the failing finding is pinned beside it
    And the Operator can see precisely what the fix agent touched without reading a diff

  Scenario: The cap is visible
    Then the repair loop's attempt count and its cap (default 3) are shown
    And a loop that exhausted its cap and escalated to a human is labelled as such,
        not as a failure of the fix agent

  Scenario: Reduced motion
    Given prefers-reduced-motion is reduce
    Then the transition does not animate and the before/after render side by side

  Scenario: Scroll position survives
    When the transition plays
    Then the view does not re-mount and the scroll position is preserved
```

**Notes:** _"the single highest-ratio visual win in the app: it makes 'one issue, one fix, capped at
three attempts' legible at a glance instead of requiring a diff read"_
([12 §7](../../12-frontend-architecture.md)). It is also cheap — `@shikijs/magic-move` is in the
version-locked Shiki 4.4.1 family already being pulled for highlighting.

---

## EPIC-17-S28 — Has the requested outcome been achieved?

**Verifies:** KAR-17.7 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: Acceptance criteria board (F10.8, F7.4)

  Scenario: The literal question, answered
    Given an approved TaskSpec with six acceptance criteria
    When the Operator opens the board
    Then all six appear in spec order with their ids and text
    And each shows status satisfied | unsatisfied | unverifiable with a colour, a glyph and a label
    And the header shows counts by status

  Scenario: The evidence behind each
    When the Operator expands criterion "AC-3"
    Then every gate that speaks to it is listed with its verdict outcome and its one-line summary
    And each finding links into the diff at its file and line
    And each verdict links to the gate.evaluated event that produced it

  Scenario: It updates live
    When a gate.evaluated event arrives for "AC-5"
    Then that row flips status without a refetch
    And the header counts update

  Scenario: Copy for a PR description
    When the Operator uses "copy as markdown"
    Then a criteria checklist suitable for a pull request body is placed on the clipboard
```

**Notes:** this is _"the literal answer to 'has the requested outcome been achieved'"_
([12 §6.8](../../12-frontend-architecture.md)) and it is the surface a colleague reads first, which
makes it disproportionately valuable relative to its size — it is the smallest story in the epic.

---

## EPIC-17-S29 — `unverifiable` is a spec defect, not a failure

**Verifies:** KAR-17.7 · **Type:** Failure · **Automated at:** browser

```gherkin
Feature: The third state (F7.4)

  Scenario: A criterion with no gate
    Given criterion "AC-6" — "the migration must not regress perceived performance" —
          has no gate mapped to it
    Then the board renders it as "unverifiable"
    And it is coloured distinctly from BOTH satisfied and unsatisfied, with its own glyph and label
    And the row states "no gate maps to this criterion — spec defect (F7.4)"

  Scenario: Why this is the point of the board
    Then F7.4 requires every criterion to map to at least one gate
    And the board is where you find out that one does not
    And a shallow spec is the primary documented failure mode of spec-driven development

  Scenario: The headline must not lie
    Given five criteria satisfied and one unverifiable
    Then the header does not claim the run is done
    And no percentage is displayed, because "80% satisfied with 20% unverifiable" invites
        exactly the misreading this state exists to prevent

  Scenario: Conflicting verdicts
    Given two gates that speak to "AC-2" and disagree
    Then the most recent verdict sets the headline status
    And the conflict is surfaced explicitly rather than silently resolved
```

**Notes:** _"`unverifiable` is a first-class state, not a variant of failure"_
([12 §6.8](../../12-frontend-architecture.md)). The no-percentage rule is a judgement call recorded
here so it does not get "improved" into a progress bar later.

---

## EPIC-17-S30 — Parallelism, stalls and where the money went

**Verifies:** KAR-17.8 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: Run timeline with cost overlay (F10.9, F9.1)

  Scenario: One glance at a four-hour run
    Given a run with 18 nodes, 6 of which executed in parallel
    When the Operator opens the timeline
    Then each node has a lane and each (nodeId, attempt) has a bar
    And the six parallel nodes overlap vertically, so parallelism is visible without counting
    And bars are coloured by node state from the --state-* tokens, with a glyph or pattern
        so state is not colour-only

  Scenario: The cost overlay
    Then a second axis carries cumulative cost from budget.consumed
    And the steepest section of that line identifies where the money went
    And a budget.exceeded event marks the point where the run PAUSED — not failed

  Scenario: Stalls with an external cause
    Given a provider.rate_limited event with a resetsAt
    Then it renders as a marker on the timeline
    And a stall caused by a rate limit is distinguishable from one caused by the run itself

  Scenario: A stall the daemon noticed
    Given a run.stalled event with watermarkSeq, idleMs and runningNodes
    Then it renders as a marker naming the idle duration and the nodes that were running
    And it is presented as an observation, never as a kill,
        because a long build looks identical to a stall

  Scenario: A node still running
    Then its bar is open-ended to "now" with a distinct end cap
    And no end time is invented
```

**Notes:** [roadmap §3](../../17-roadmap.md) keeps this at P0 with the argument that _"it looks like
the expensive one and is not"_ — roughly 150 lines of `d3-scale` plus Vue-rendered SVG over
projections that already exist. The payoff is that the SVG is fully themeable by the CSS custom
properties and the DOM is yours to put ARIA on.

---

## EPIC-17-S31 — Six idle hours are not six busy hours

**Verifies:** KAR-17.8 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: Suspension rendered as suspension

  Scenario: A human gate across a night
    Given "n_approve_scope" suspended with until { kind: "human" } at 18:40
    And answered at 09:15 the next morning
    Then the timeline shows the wait as a visually distinct segment from execution time
    And the node's cost for that period is zero, and the chart shows it as zero

  Scenario: Why the distinction matters
    Then six idle hours and six busy hours cost very different things
    And a timeline that renders them identically makes a cheap run look expensive
        and hides where the wall clock actually went

  Scenario: A backwards timestamp
    Given a laptop sleep or an NTP correction moved ts backwards between two events
    Then the bars still render in seq order
    And a bar that appears to start before its predecessor finished is labelled as a ts artefact
    And the data is not clamped to hide it, because ts is informational and seq is the order
```

**Notes:** ordering is by `seq`, never by `ts` ([04 §9](../../04-domain-model.md)). The last scenario
is the honest handling of a real artefact: clamping would make the chart look correct and be wrong,
which is the same failure class as the fabricated compaction "after" in S18.

---

## EPIC-17-S32 — Every chart has a data-table twin

**Verifies:** KAR-17.8, KAR-17.4 · **Type:** Edge case · **Automated at:** browser

```gherkin
Feature: Non-visual reachability, and the PR-description surface (12 §9.4)

  Scenario Outline: Each chart is reachable without seeing it
    Given the chart "<chart>"
    Then its <svg> carries a <title> and an aria-label
    And a toggleable data-table view lists "<columns>"
    And the table is built from the SAME derivation as the chart, not a second one

    Examples:
      | chart                 | columns                                                   |
      | run timeline          | node, attempt, start, end, duration, state, cost           |
      | context budget        | invocation, segment kind, tokens, method                   |
      | plan graph            | node, type, state, provider, permission, duration, cost    |

  Scenario: The second payoff
    Then the table doubles as the copy-paste-into-a-PR-description surface
    And that is the M1 stand-in for the shareable run report (F10.13, P2)

  Scenario: It is about twenty lines
    Then the table view is one shared component parameterised per chart
    And building it costs roughly twenty lines and doubles as accessibility compliance
```

**Notes:** _"a ~20-line component and it doubles as the copy-paste-into-a-PR-description surface"_
([12 §9.4](../../12-frontend-architecture.md)). The same-derivation requirement matters: a table
built from a second query is a second source of truth and will disagree with the chart eventually.

---

## EPIC-17-S33 — The memory graph aggregates before it renders

**Verifies:** KAR-17.9 · **Type:** Happy path · **Automated at:** browser

```gherkin
Feature: Memory and data-flow graph (F10.4) — if it ships

  Scenario: The default view on a long run
    Given a run whose blackboard holds 3,000 facts
    When the Operator opens the memory graph
    Then the default view shows ONE BUBBLE PER PRODUCING NODE with a fact count
    And raw facts are not rendered by default at any run size
    And the view renders within the NF3 interaction budget

  Scenario: Expansion on demand
    When the Operator clicks a producing node
    Then that node's facts expand inline
    And the expanded set is capped and paginated rather than unbounded

  Scenario: What the Operator actually wanted
    Then the question being answered is "which node produced the wrong assumption?"
    And it is NOT "here are 3,000 dots"
    And solving that in product rather than in rendering is why this design was chosen

  Scenario: Fact detail
    When the Operator clicks a fact
    Then provenance shows the writing node, evidence handles, timestamp and confidence
    And the complete consumer set is fetched from
        GET /api/runs/:id/facts/:factId/consumers
    And an invalidated fact renders distinctly with every node in its taints[] highlighted

  Scenario: Through the facade
    Then the view renders through GraphCanvas with no direct @vue-flow/core import
    And it is a lazy route, absent from the initial chunk
```

**Notes:** _"solve it in product before you solve it in rendering"_
([12 §6.4](../../12-frontend-architecture.md)). If the expanded view genuinely exceeds ~1,500 nodes,
the escape hatch is `sigma@^3.0.3` + `graphology@^0.26.0`, or `@cosmograph/cosmos@^3.4.1` for GPU
force layout at 100k+ — and because everything goes through `GraphCanvas`, that swap touches one file
and does not disturb the plan graph.

---

## EPIC-17-S34 — The measurement decides whether this view ships at all

**Verifies:** KAR-17.9 · **Type:** Failure · **Automated at:** manual (a recorded decision)

```gherkin
Feature: A scope cut taken deliberately (roadmap §3)

  Scenario: The blocking condition
    Given KAR-17.9 has status "Blocked"
    Then it stays blocked until docs/measurements/vue-flow-400.md exists
    And the decision to build or defer is recorded in that file, with the numbers that drove it

  Scenario: The measurement does not support a second graph surface
    Given the measured smooth ceiling is below what an expanded fact graph would need
    Then KAR-17.9 is closed as deferred to M2
    And F10.4's M1 coverage is KAR-17.3's provenance table plus the blackboard.ts projection
    And nothing is lost: fact.written and fact.read are ledger events regardless,
        the data accrues from day one, and adding the view in M2 needs no migration and no re-run

  Scenario: The deviation is recorded, not silent
    Then the PRD assigns F10.4 priority P0
    And KAR-17.9 carries priority P1 with this reason attached
    And the board reconciler sees F10.4 as covered by KAR-17.3 for M1

  Scenario: If it does ship
    Then EPIC-17-S33's assertions apply in full
    And the 3,000-fact fixture is the acceptance bar
```

**Notes:** [roadmap §3](../../17-roadmap.md) gives four reasons this is the natural candidate, of
which the strongest is the second: _"nothing is lost by deferring it … only the rendering slips."_
Recording the decision in the measurement file — beside the number — is what stops it from becoming
folklore.

---

## EPIC-17-S35 — The five-minute diagnosis, end to end

**Verifies:** KAR-17.1, KAR-17.2, KAR-17.3, KAR-17.4, KAR-17.6, KAR-17.7, KAR-17.8 ·
**Type:** Happy path · **Automated at:** e2e + timed manual

**This scenario is the epic's Definition of Done, not an illustration.** PRD §12 sets _median
time-to-diagnose a failed run < 5 min_ as an M1 target, and PRD §13 states the mitigation for
_"the visualisation is pretty but not diagnostic"_ as: **measure it. If it doesn't drop, the views
are wrong.**

**Automated by** `e2e/five-minute-diagnosis.test.ts`, over the seeded fixture
`test/fixtures/runs/five-minute-diagnosis/`, with the timed result committed at
[docs/measurements/five-minute-diagnosis.md](../../measurements/five-minute-diagnosis.md).
Three clauses below were **amended when the scenario was automated**, because the domain cannot
express them as written; each amendment is marked `# amended:` in place, and the timed-manual half
of _"Automated at: e2e + timed manual"_ is **still owed** — the committed number times a scripted
walk, not a person, and the measurement document says so.

```gherkin
Feature: Median time-to-diagnose a failed run under five minutes (PRD §12)

  Background:
    Given a recorded failure fixture served by "deflow replay"
    And a stopwatch started the moment the Operator opens the run
    And the Operator has not seen this fixture before

  Scenario: A four-hour design-system migration produced a bad diff
    # 0:00 — orientation
    When the Operator opens the run
    Then the plan graph shows 22 nodes: 18 passed, 1 failed, 2 abandoned, 1 awaiting-human
    # amended: node ids are kebab-case. NodeIdSchema is /^[a-z0-9][a-z0-9-]{0,62}$/, so
    # "n_impl_3" is an id this system cannot mint; the fixture's node is "n-impl-3".
    And the failed node "n-impl-3" is immediately identifiable by state colour, glyph and label

    # 0:20 — what failed, and against what
    When the Operator opens the acceptance-criteria board
    # amended: criterion ids are kebab-case too, for the same reason — CriterionIdSchema is the
    # same pattern, so "AC-3" is "ac-3". The statement is unchanged.
    Then criterion "ac-3" — "no component may import from @voyado/ui/internal" — is unsatisfied
    And the gate "import-boundary" is listed as the gate that speaks to it
    And its verdict summary reads "3 files import from the internal namespace"

    # 0:50 — where, exactly
    When the Operator clicks the first finding
    Then the diff surface opens on packages/ui/src/Button.vue at line 42
    And the finding renders inline at that line with severity "blocker" and its evidence handle

    # 1:30 — was the agent wrong, or was it told the wrong thing?
    When the Operator opens the node inspector for "n-impl-3"
    Then the context packet lists its segments with per-segment token counts
    # amended: confidence is an enum, not a number. FactSchema.provenance.confidence is
    # asserted | verified | speculative, so "0.6" is recorded as the band it falls in.
    And the provenance table shows it read fact "decision/import-policy"
         written by "n-recon" with confidence "speculative"

    # 2:20 — what did compaction do to it?
    When the Operator opens the context-budget view for that invocation
    Then a context.compacted mark sits between attempt 1 and attempt 2
    And its fidelity is "exact", its droppedSegments include the segment carrying
        "decision/import-policy", and pinnedKept[] shows the pinned spec survived
    And the honest conclusion is available: the constraint that was dropped was a FACT,
        not a pinned constraint — a plan defect, not a pinning failure

    # 3:10 — why was this node here at all, and why with this provider?
    When the Operator opens the plan scrubber and steps to the version that introduced the node
    Then the reason reads "Recon found 3 additional packages; splitting the migration node"
    And the next version's patch shows the provider re-route with its RFC 6902 patch

    # 3:50 — what did it cost, and where did the time go
    When the Operator opens the timeline
    Then the failed node's three attempts are visible as three bars
    And the cumulative cost line shows this node as the steepest section

    # 4:10 — the diagnosis
    # amended: the re-route is v3, not v4. The clause above asks for the version that introduced
    # the node and then for *the next version's* re-route, so the two are adjacent by
    # construction: v2 splits, v3 re-routes, v4 abandons the legacy branch.
    Then the Operator can state, in one sentence:
         "n-impl-3 was split out by the v2 patch, re-routed to Codex in v3, and its third attempt
          failed ac-3 because the import-policy fact it needed was compacted out of its packet —
          the fact was never pinned, which is a plan defect in the node's reads declaration."
    And the elapsed time is under five minutes

  Scenario: The measurement is repeated, not anecdotal
    Given at least three different seeded failure fixtures with different root causes
    Then the median elapsed time across them is under five minutes
    And the result is recorded with the date, the fixtures and the times

  Scenario: What a failure of this scenario means
    Given the median exceeds five minutes
    Then the conclusion is that THE VIEWS ARE WRONG, not that the Operator was slow
    And the epic is not Done
    And the specific step that consumed the time identifies which view to fix
```

**What the automation does and does not settle.** The committed measurement times a *scripted*
walk: seven navigations in a real Chromium against a real `deflow replay` daemon, clocked from
opening the run to the last checkpoint having its evidence on screen. That is the part of the five
minutes this codebase controls — daemon response, projection fold, render, navigation — and it is a
lower bound on nothing else. **A person reading a chart and forming a hypothesis is not in the
number**, and the "timed manual" half of this scenario's `Automated at:` line is therefore still
outstanding: run it against a fixture the operator has not seen, with a real stopwatch, before
quoting five minutes as a human figure. What the scripted walk *does* settle is the property PRD
§13 doubts — that the evidence is reachable, that each stop hands the next the fact it needs, and
that no stop requires a log, a second tool or a database query.

Two of the three fixtures the median is taken over cannot answer every stop, and that is a property
of those recordings rather than of the views: `gate-failure-repair` never built a context packet and
`repair-attempts` has no gate verdict. `five-minute-diagnosis` was seeded for this scenario because
nothing in the corpus carried the whole chain. The two corpus entries left out — `compaction`, which
has no `run.created` at all, and `crash-resume-seq-gap`, which records a sequence hole and no
failure — are excluded on evidence asserted by the spec, not by preference.

**Notes:** the five checkpoints in the main scenario map one-to-one onto the views
[roadmap §3](../../17-roadmap.md) argues carry the metric — plan graph for orientation, criteria
board for _what_, diff for _where_, inspector for _what it received_, context budget for _what was
deleted_ — plus the scrubber for _why the step exists at all_. That correspondence is the argument
for the P0 view set, and this scenario is what tests the argument rather than assuming it. Run it
against a fixture the Operator has not seen: familiarity is the confound that makes every internal
usability test come out fine.

---

**Related:** [EPIC-17](../epics/EPIC-17-p0-views.md) ·
[Frontend architecture](../../12-frontend-architecture.md) ·
[Roadmap §3](../../17-roadmap.md) ·
[API and realtime](../../11-api-and-realtime.md) ·
[Domain model](../../04-domain-model.md) ·
[UI foundation flows](./EPIC-16-ui-foundation-flows.md) · [Board](../board.md)

[← Back to the delivery plan](../README.md)
