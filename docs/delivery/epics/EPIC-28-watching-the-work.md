# EPIC-28: Watching the work — the agent list, the activity feed, and the inspector

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-28-watching-the-work-flows.md)

|                      |                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Epic ID**          | EPIC-28                                                                                                                                                      |
| **Status**           | Not started                                                                                                                                                  |
| **Priority**         | P0                                                                                                                                                           |
| **Milestone**        | M1                                                                                                                                                           |
| **Workstream**       | W21 — added 2026-08-25, after a session spent watching real runs on the workflows screen and being unable to answer "what is it doing?" from it |
| **Depends on**       | EPIC-22 (the screen this reshapes), EPIC-24 (the token layer and primitives it spends), EPIC-27 KAR-27.3 (the io stream this reads) |
| **Blocks**           | M1's own definition of done — see Goal                                                                                                                       |
| **PRD requirements** | F8.1, F8.2, F8.4, NF3                                                                                                                                        |
| **Architecture**     | [12-frontend-architecture.md](../../12-frontend-architecture.md), [11-api-and-realtime.md](../../11-api-and-realtime.md), [05-durable-execution.md](../../05-durable-execution.md) |

## Goal

M1's definition of done, verbatim from [PRD §11](../../prd.md):

> **You complete a real multi-hour task at work with it, from spec to merged PR, and the
> visualisation tells you why every step happened.**

On 2026-08-25 the owner ran real work through the workflows screen for an afternoon and the
visualisation did not tell them why anything happened. Five specific findings, each observed rather
than theorised:

1. **A framing turn ran for five minutes and showed nothing it was doing.** The bytes were all
   there — KAR-27.3 AC2 persists a pre-execution turn's stdout incrementally — but the only surface
   reading them is a one-line strip that shows the **last three tool names** and nothing else. Tool
   *arguments* are parsed and dropped (`turn-activity.ts` keeps `record.name`, discards `input`), so
   `Read` never says which file. Tool *results* are never parsed at all: only `type === 'assistant'`
   frames are read, so what the agent **learned** is thrown away. And the agent's own prose is
   extracted into `lastText`, typed, tested — and never rendered by any component.

2. **The canvas is not practical.** It is the screen's largest object and it answers a question
   ("what depends on what") that the owner does not ask, while the question they do ask ("which
   agent is doing what, on which try, and how long has it taken") has no surface at all.

3. **The right column is one table where three sections were designed.** The node inspector exists,
   but it is a modal `Dialog` that dims the rail, the topbar and the canvas when opened — the
   opposite of every blueprint — and it is reachable only by selecting a graph node, which does not
   exist during pre-execution.

4. **The bottom band shows other runs' history** where the design shows this run's phases and the
   work happening inside the current one.

5. **The topbar describes a run that is not on the screen.** On the composer it renders the
   *previous* run's prompt, provider and status — an operator starting a new run is told, in the
   frame, that it is `aborted`.

Nothing here is a new fact the daemon must invent, with one exception named as such: the phases
band needs a projection that does not exist, and it is split into its own story behind an ADR.

## Stories

| Story | Title | Size | Depends on |
| -- | -- | -- | -- |
| KAR-28.1 | A pre-execution turn shows its course of actions and decisions | L | KAR-27.3 |
| KAR-28.2 | The agent list is the primary surface; the canvas moves behind a toggle | L | — |
| KAR-28.3 | The topbar stops describing a run that is not on the screen | S | — |
| KAR-28.4 | The inspector docks instead of taking the screen over | M | KAR-28.2 |
| KAR-28.5 | A phases projection: the run's own shape, from the ledger | M | — |
| KAR-28.6 | The phases band replaces run history under the agents | M | KAR-28.5, KAR-28.2 |
| KAR-28.7 *(added)* | The status pill stops latching on a gate it has already answered | M | KAR-28.3, KAR-27.3 |
| KAR-28.8 *(added)* | The hidden panel stays hidden: no graph elements over the agent list | M | KAR-28.2 |
| KAR-28.9 *(added)* | A run with no plan neither draws a phases band nor asks for one | S | KAR-28.6 |

*(added)* marks the three stories appended on 2026-08-26 after watching a real run against the
shipped epic, per [README §9](../README.md#9-changing-the-plan). Each is a defect or a guard gap
found **in use**, not a new capability: the epic's goal did not move.

### KAR-28.1 — A pre-execution turn shows its course of actions and decisions

**As** an operator watching a framing turn, **I want** to read what the agent has done and decided,
in order, **so that** five minutes of interrogation is legible work rather than a spinner.

**Why now.** Observed 2026-08-25: a framing turn ran nearly five minutes against Linear and the
repository. The strip showed `mcp__claude_ai_Linear__get_issue Bash Read` — three names, no
arguments, no results, no prose — over a window of the last 64 chunks, so the first four minutes had
already scrolled out. KAR-27.3's AC3 asked for *"at minimum, tool invocations as they happen"* and
the minimum is what shipped. This story is the rest of the sentence.

**Acceptance criteria**

1. The plan panel shows an **activity feed** for the running pre-execution turn: one row per event,
   oldest first, scrollable, holding the whole turn rather than a fixed tail. It updates without a
   refresh and is replaced by the plan when the plan compiles.
2. A tool call names **what it acted on**, not only the tool: the identifying argument is rendered
   beside the name (`Read src/api.ts`, `get_issue MET-1013`, `Bash pnpm test`). The argument is
   printed as the frame spelled it and truncated for width, never re-worded.
3. A tool call's **result** is folded into its row — success or failure and the vendor's own summary
   — by reading the `tool_result` frames that nothing parses today. A result that cannot be read is
   omitted rather than guessed at, and never turns a working turn into an error.
4. The agent's **own text** between calls is rendered as its own rows, in order. `turnActivity`
   already extracts it and every renderer discards it; this is a display gap, not a parsing one.
5. Nothing is invented. Names, arguments, results and prose are the vendor's own bytes; a frame this
   build cannot read is skipped, exactly as `turn-activity.ts` already skips one.
6. The whole-turn window has a stated bound and says when it has one: if the feed is windowed, the
   surface says so and links to the full transcript rather than silently starting mid-turn.

**Execution plan.** TDD. Red first in `lib/turn-activity.ts` over recorded NDJSON — arguments,
`tool_result` frames and text ordering — then the feed component, then its place in the panel. No
daemon change and no new endpoint: every byte is already in the io store and served by the existing
io tail. Model: opus implements; sonnet verifies.

### KAR-28.2 — The agent list is the primary surface; the canvas moves behind a toggle

**As** an operator, **I want** the run's agents as a list — who is doing what, on which attempt,
with which model, for how long — **so that** the screen answers the question I actually ask.

**Why the canvas is not deleted.** The owner's decision, recorded 2026-08-25: the list is what the
screen shows by default and the graph stays reachable behind an `Agents | Graph` toggle. Dependency
shape is occasionally the right question and the graph answers it well; it is simply not the
default. Nothing in EPIC-17 is removed, and the `/plan` and `/evolution` routes are untouched.

**Acceptance criteria**

1. The workflows screen's primary panel is a list of the run's agents, one row each: title, the
   agent and model, state, elapsed, cost, and — where the run has them — the hierarchy of a main
   agent over its sub-agents.
2. A retried step reads as **its own row per attempt** (`… — try #1`, `try #2`), with the failed
   attempt still legible after the successful one. An attempt history that collapses into one row is
   the thing this replaces.
3. Every row carries an **output** control that opens that node's transcript — the existing
   `run-node-output` route or the docked inspector, not a third renderer.
4. The rows are the shared `useNodeBodies()` object the graph draws, in the same tick. No second
   model of the run, and `test/one-workspace-surface.test.ts` still passes.
5. An `Agents | Graph` toggle switches the panel; the choice persists for the session. The graph
   keeps its own feed invariant — one canvas, one subscription — whichever is on screen.
6. The list is the design system's own table language (the dense row `RunListView` and `TaskBoard`
   already spend), not a third padding scale.

**Execution plan.** TDD, starting from `TaskBoard`, which is already most of this: eight facts per
row off the shared bodies. What is new is hierarchy, per-attempt rows and the output control. Model:
opus implements; sonnet verifies.

### KAR-28.3 — The topbar stops describing a run that is not on the screen

**As** an operator starting a new run, **I want** the frame to describe *this* page, **so that** the
composer does not tell me the run I am about to start is `aborted`.

**Why now.** Observed 2026-08-25 on `/projects/:id/new-run`: the topbar rendered the previous run's
provider, bin, route, prompt and an `aborted` status pill. `AppTopBar.vue`'s `runHasHeader` splits
routes into "draws its own run header" and everything else, and the second branch renders three
banners fed by the global run store. There is a third category the split does not model — routes
that show **no run at all** — and `new-run`, `projects`, `settings`, `project-runs`, `gallery` and
`not-found` all fall into it.

**Acceptance criteria**

1. On any route that shows no run, the topbar renders no run provider, no run task and no run status.
   The condition is stated as "does this route show a run", not as "does this view draw its own
   header".
2. On the run views that have no header of their own, the three banners still render exactly as they
   do today — KAR-24.4 AC4's "every element survives" contract is not weakened by this fix.
3. The rule is a single source: one set of route names, asserted by a test that fails when a new
   route is added to neither category, so the next route cannot inherit a stale run silently.

**Execution plan.** TDD. Red first over the route table: mount each route name with a run in the
store and assert the three banners appear only where a run is genuinely on screen. Model: opus.

### KAR-28.4 — The inspector docks instead of taking the screen over

**As** an operator reading a node's output, **I want** the inspector beside the work rather than
over it, **so that** I can read a transcript and watch the list at the same time.

**This reverses a recorded decision, on purpose.** KAR-24.6 chose a Reka `Dialog`; KAR-26.5's audit
then recorded the scrim as *"the largest single visual divergence in the five screenshots"* and
deferred it because an audit story may not change behaviour. This story is where that change is
allowed to happen, and the Dialog-semantics decision in `NodeInspector.vue`'s header is rewritten
rather than left contradicting the code.

**Acceptance criteria**

1. The inspector is a docked right panel: opening it dims nothing, and the rail, the topbar and the
   agent list stay legible and interactive while it is open.
2. Keyboard and screen-reader behaviour survive de-modalising: focus moves into the panel on open,
   `Escape` closes it, focus returns to the row that opened it, and the panel is labelled.
3. Its sections are the ones the daemon can feed. **Logs stays out** and the reason stays recorded:
   no level-tagged per-node log line exists in any projection, and inventing one is barred.
4. It opens from an agent-list row as well as from a graph node, so it is reachable when no graph is
   on screen.

**Execution plan.** TDD at the a11y contract first — focus in, `Escape`, focus restored — because
that is what the Dialog was buying and what de-modalising risks. Model: opus.

### KAR-28.5 — A phases projection: the run's own shape, from the ledger

**As** the run surface, **I want** the daemon to answer what phases this run has and where it is,
**so that** a phases band shows recorded facts rather than a shape the frontend guessed.

**Why this is its own story.** The blueprint's phases band was recorded in KAR-26.5's audit as *out
of scope: facts the daemon does not have*. That is still true. This story creates the fact; KAR-28.6
draws it. Splitting them keeps a projection from being invented inside a component.

**Acceptance criteria**

1. A phases projection over the ledger answers, for a run: the ordered phases, each phase's state,
   and its completed/total counts. Derived from recorded events only — no wall-clock estimates, no
   invented totals.
2. A run whose plan has no phase structure answers with the honest shape it does have rather than a
   fabricated one; the projection never reports a phase the ledger cannot evidence.
3. It is served on the existing run-scoped surface, and it survives a daemon restart because it is a
   fold over the ledger rather than in-memory state.
4. The mechanism is recorded before it is built: an ADR states what a phase *is* in DeFlow's domain,
   since the word is currently a blueprint's, not the domain's.

**Execution plan.** ADR first — this is a mechanism change, and [README §9](../README.md) is explicit
that the architecture doc and ADR precede the stories. Then TDD over seeded ledgers. Model: opus.

### KAR-28.6 — The phases band replaces run history under the agents

**As** an operator, **I want** the band under the agents to show this run's phases and the work
inside the current one, **so that** the screen's lower third is about the run I am watching.

**Acceptance criteria**

1. The band under the primary panel shows this run's phases (from KAR-28.5) beside the work
   happening in the selected phase; run history moves to the Runs view, which is what it is for.
2. Selecting a phase shows that phase's work; the current phase is selected by default.
3. Run history remains reachable in one click from this screen — moved, not removed.
4. The band is a recorded-facts surface: no per-agent token or throughput figures the ledger does
   not carry, per the standing rule against inventing model metadata.

**Execution plan.** TDD after KAR-28.5 lands. Model: opus.

### KAR-28.7 — The status pill stops latching on a gate it has already answered

|                 |                                                                             |
| --------------- | ----------------------------------------------------------------------------- |
| **Status**      | Not started                                                                 |
| **Priority**    | P0                                                                          |
| **Size**        | M                                                                           |
| **Depends on**  | KAR-28.3 (the frame's run banners this corrects), KAR-27.3 (the composed pre-execution label this must let through) |
| **PRD**         | F8.1, F8.4, NF3                                                             |
| **Verified by** | EPIC-28-S26, EPIC-28-S27, EPIC-28-S28, EPIC-28-S29, EPIC-28-S30, EPIC-28-S31 |

**As** an operator watching a run I have already unblocked, **I want** the status pill to say what
the run is doing now, **so that** an answered gate does not leave the frame asking me forever for a
decision I have already made.

**Why now.** Observed 2026-08-26 on a live run, `run_20260826T060745Z_d81b6c`. The web showed a
status pill reading **"needs a decision"** while the run was, in fact, planning. Folding that run's
ledger with the repo's own reducer gives the server truth: status `spec-approved`, `needsHuman:
null`, and the spec gate **answered** — `gate.response` is populated, so `openHumanGates` filters it
out and `pendingGate` returns `null`. For that state the daemon composes the label `planner —
running · attempt 1 of 3 · since 2026-08-26T06:16:16.589Z`. Both `GET /api/runs`
(`packages/daemon/src/http/run-list.ts:167-168`) and `GET /api/runs/:id`
(`packages/daemon/src/http/run-summary.ts:161`) emit the correct status. **The daemon is not at
fault.**

The fault is that the web keeps its **own** sticky status table,
`RUN_STATUS_BY_KIND` in `packages/web/src/stores/useRunListStore.ts:79-111`, covering exactly eight
event kinds. `human.requested` latches `lifecycleStatus` to `needs-human`
(`packages/web/src/stores/useRunStore.ts:434-435`). Neither `run.spec.approved` nor
`human.responded` is in that table, so **nothing can move the status off `needs-human`** until one
of `run.started` / `run.paused` / `run.resumed` / `run.cancel.requested` / `run.completed` /
`run.aborted` arrives — and a run emits none of those between spec approval and the planner adopting
a plan. The events are delivered and are folded into the projections correctly; they simply own no
status entry. The run-list row carries the identical defect:
`packages/web/src/stores/useRunListStore.ts:181-193`'s `clearGate` clears `row.gate` and
deliberately leaves `status` and `label` alone.

**A second, related defect on the same surface.** The pill renders `RUN_STATUS_LABELS[status]`
directly (`packages/web/src/components/frame/RunStatusPill.vue:58`) rather than `runStatusLabel(state)`
from `packages/core/src/run-status-label.ts`. So the composed pre-execution label KAR-27.3 built —
`planner — running · attempt N of M · since <instant>` — can never reach that surface: the best it
can print for `spec-approved` is a bare `planning`. And `packages/web/src/app/frame.test.ts:294-301`
pins only the latch **engaging** on `human.requested`; no test anywhere asserts it ever clears.

**Acceptance criteria**

1. A run whose gate has been answered stops reading `needs a decision` on **both** the status pill
   and the run-list row, within the same tick as the answering event, with no page refresh and no
   re-fetch: replaying the recorded ledger of `run_20260826T060745Z_d81b6c` through the web's own
   folding leaves neither surface in `needs-human`.
2. There is **one** source of a run's status shared by the pill and the run-list row, named in the
   code, and neither surface re-derives it from a table of its own. Whether that source is the
   daemon's `status` taken as given or a client table made total over the status-changing kinds is
   the implementer's call — but the decision is **recorded in the code** with its reason, and the
   losing option is deleted rather than left in place unused.
3. If a client-side table survives, it is **total** over the event kinds that change a status, and a
   guard test fails when a new status-changing kind is added to the reducer without an entry —
   listing the kind by name. If the daemon's status is taken instead, a guard test fails when a
   surface reads a status it computed itself.
4. The composed pre-execution label reaches the surfaces through `runStatusLabel(state)` from
   `packages/core/src/run-status-label.ts`: for the run above, the pill shows the daemon's own
   composed sentence (`planner — running · attempt 1 of 3 · since …`) and not a bare `planning`.
   No second label vocabulary is introduced in `packages/web`.
5. A test pins the latch **clearing**, not only engaging: `human.requested` followed by
   `human.responded`, and `human.requested` followed by `run.spec.approved`, each leave the pill and
   the row off `needs-human`. `frame.test.ts:294-301`'s latch-ON assertion still passes unchanged.
6. Nothing regresses for the kinds that already worked: `run.created`, `run.started`, `run.paused`,
   `run.resumed`, `run.cancel.requested`, `run.completed` and `run.aborted` produce the same pill
   text as they do today, asserted kind by kind.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                             | Red when                                                                                                                    |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 1   | unit        | Fold `human.requested` then `human.responded` through `useRunStore`; assert `lifecycleStatus` is no longer `needs-human`                            | `human.responded` owns no status entry, so an answered gate latches the store forever — the observed defect, at its source        |
| 2   | unit        | Fold `human.requested` then `run.spec.approved`; assert the status follows the daemon's `spec-approved` rather than staying `needs-human`           | The second path off the latch is missing too, so approving a spec leaves the run asking for a decision it already has            |
| 3   | unit        | Feed `useRunListStore` a `human.requested` then a `human.responded` for the same run; assert `row.status` and `row.label` both moved               | `clearGate` clears the gate and leaves status and label, so the list row keeps the stale sentence after the pill is fixed         |
| 4   | unit        | Totality guard: every kind the reducer treats as status-changing has an answer in whatever single source AC2 names; the failure lists the kind      | A new event kind is added and silently owns no status, reproducing this bug for a different gate a year from now                  |
| 5   | unit        | Replay the recorded `run_20260826T060745Z_d81b6c` ledger fixture through the web folding; assert the final pill text is the planner sentence        | The fix passes on synthetic events and still fails on the run that produced the report                                           |
| 6   | component   | Mount the pill with a `spec-approved` state carrying attempt and `since`; assert it renders `runStatusLabel(state)`'s composed sentence            | The pill reads `RUN_STATUS_LABELS[status]` directly, so KAR-27.3's label can never appear on the frame                            |
| 7   | component   | Mount the pill for each of the seven kinds that work today; assert the text is byte-identical to today's                                          | Routing the label through `runStatusLabel` quietly reworded the states that were already right                                   |
| 8   | unit        | Grep-style guard: `packages/web` contains exactly one mapping from run state to status, and `RUN_STATUS_LABELS` is not indexed directly by a view | The two tables both survive the fix and drift apart again, which is the shape of the original defect                              |

**Execution plan.** TDD. Red first at the store, not the component — the latch is a store fact and a
component test would let a `spec-approved`-shaped prop paper over it. Then the single-source decision
(AC2) written down, then the pill. No daemon change: the daemon is already correct and this story may
not touch it. Model: opus implements; sonnet verifies.

### KAR-28.8 — The hidden panel stays hidden: no graph elements over the agent list

|                 |                                                              |
| --------------- | -------------------------------------------------------------- |
| **Status**      | Not started                                                  |
| **Priority**    | P0                                                           |
| **Size**        | M                                                            |
| **Depends on**  | KAR-28.2 (the toggle and the one-canvas invariant this must preserve) |
| **PRD**         | F8.1, F8.2, NF3                                              |
| **Verified by** | EPIC-28-S32, EPIC-28-S33, EPIC-28-S34, EPIC-28-S35, EPIC-28-S36 |

**As** an operator reading the agent list, **I want** the graph to be gone when I have not asked for
it, **so that** the list I chose is not covered by cards from the panel I did not.

**Why now.** Observed 2026-08-26, with a screenshot. While the **Agents** panel was selected,
vue-flow graph node cards were painted **on top of** the agents table — roughly six of them scattered
across the list, several half-faded, each showing a node title, a `Pending` pill and the
`claude · no model reported / agent · worktree` body. They overlapped and obscured the table rows.

**The mechanism, as far as it has been established.** KAR-28.2 AC5 deliberately does **not** unmount
the canvas on a panel change: the canvas owns the run feed, and a `v-if` would close and reopen the
subscription on every toggle. So both panels live in the **same grid cell** —
`packages/web/src/views/ProjectWorkflowsView.vue:755-764`, `grid-area: 1 / 1` — and the inactive one
is hidden with `visibility: hidden` alone
(`packages/web/src/views/ProjectWorkflowsView.vue:787-790`, with the rationale comment at 340-362).
The toggle logic itself is correct: `hidden = (mine) => panel.value !== mine`, and the CSS selector
matches. That approach is sound **only if nothing in the graph subtree escapes visibility
inheritance** — and something does.

**Already ruled out by reading. Do not redo this; extend it.** There is no `Teleport` and no
`position: fixed` in `packages/web/src/components/graph/*.vue` or `PlanGraphView.vue`; there is no
`visibility: visible` override anywhere in `packages/web/src`; and `@vue-flow/core`'s `style.css`
contains no `visibility` rule at all — it sets `z-index` and `position: absolute` on
`.vue-flow__node`. **The escaping element has not been identified.** Identifying it is the first job
of this story and it likely needs a real browser or jsdom repro rather than more static reading. One
lead worth following: the half-faded duplicates suggest **leftover hover or drag state** on nodes
whose trigger went invisible without ever receiving a `pointerleave`.

**Acceptance criteria**

1. With the **Agents** panel selected, no graph element is visible, focusable or hit-testable, at any
   scroll position of the agents table and at any viewport width the screen supports. With **Graph**
   selected, the reverse holds for the agent list.
2. KAR-28.2 AC5's invariant is preserved: exactly **one** canvas and **one** subscription exist
   across any number of toggles, and the canvas is **not** unmounted to achieve AC1. KAR-28.2's own
   test asserting this still passes, unmodified.
3. The escaping element is **named** in the fix — which element, why it escaped `visibility:
   hidden`, and why the chosen remedy addresses that cause — recorded in the code beside the change.
   A blanket rule that smothers the subtree without naming the cause does not satisfy this criterion.
4. The half-faded duplicates are accounted for: either the leftover hover/drag hypothesis is
   confirmed and cleared when the panel loses visibility, or it is disproved in writing and the real
   cause recorded instead.
5. A regression test pins that the hidden panel contributes **nothing** — no element with a non-zero
   rendered box that is visible, nothing reachable by `Tab`, and nothing returned by hit-testing over
   the visible panel's area — and it fails against the current code before the fix.
6. Nothing about the toggle's behaviour changes: the choice still persists for the session and both
   panels still render the same run from the same shared bodies object.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                          | Red when                                                                                                                     |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | browser     | Mount the workflows view on a run with a compiled plan, select Agents, and enumerate every descendant of the graph subtree; assert none is visibly rendered | This is the reported bug and nothing in the suite sees it — it reproduces by hand and passes in CI                            |
| 2   | browser     | The same, after scrolling the agents table to the bottom                                                                                       | The escape is scroll-position dependent and a top-of-list assertion would call it fixed                                       |
| 3   | browser     | With Agents selected, `Tab` through the whole view; assert no focus stop lands inside the graph subtree                                        | The cards are invisible to the eye and still in the tab order, so keyboard users walk through a panel that is not on screen   |
| 4   | browser     | With Agents selected, hit-test the centre of each agent row; assert the element found belongs to the list, not to a node card                  | A card is transparent but still intercepts clicks, so a row's output control silently stops opening                           |
| 5   | browser     | Hover a graph node, toggle to Agents without a `pointerleave`, and assert no node retains hover or drag state                                  | The half-faded duplicates persist, which is the specific artefact the screenshot shows                                        |
| 6   | browser     | Toggle Agents → Graph → Agents ten times; assert exactly one canvas ever existed and the feed subscribed exactly once                          | The fix was a `v-if`, which is the one remedy KAR-28.2 AC5 forbids                                                            |
| 7   | browser     | Select Graph; assert no agent-list element is visible, focusable or hit-testable                                                               | The fix is one-directional and the same defect exists in the other panel, unobserved only because nobody looked               |
| 8   | unit        | Assert the recorded diagnosis exists: the fix names the escaping element and its cause                                                         | The cause was smothered rather than found, and the next component added to the subtree escapes the same way                   |

**Execution plan.** Diagnose first, in a real browser or jsdom repro — this story may not proceed on
a guess, because the two cheapest guesses (`Teleport`, `position: fixed`) are already ruled out. Then
red at AC5's regression test, then the fix. The canvas is not unmounted. Model: opus implements;
sonnet verifies.

### KAR-28.9 — A run with no plan neither draws a phases band nor asks for one

|                 |                                                    |
| --------------- | ------------------------------------------------------ |
| **Status**      | Not started                                        |
| **Priority**    | P1                                                 |
| **Size**        | S                                                  |
| **Depends on**  | KAR-28.6 (the band whose absence this guards), KAR-28.5 (the projection that answers `no-plan`) |
| **PRD**         | F8.1, NF3                                          |
| **Verified by** | EPIC-28-S37, EPIC-28-S38, EPIC-28-S39              |

**As** the run surface, **I want** to neither ask for nor draw phases for a run that has no plan,
**so that** a pre-execution run costs no pointless request and the band's absence is guarded by a
test rather than by luck.

**Why now.** Found 2026-08-26 while verifying KAR-28.6 against a live pre-execution run. Two small,
real gaps — and **neither is the symptom the owner reported**: the band was correctly absent before
the plan compiled and correctly appeared after. KAR-28.6's behaviour is right; what is missing is a
guard and a guard clause.

**Gap 1 — a guaranteed-useless request.** `packages/web/src/app/useRunPhases.ts:113-122` watches with
`immediate: true` and issues `GET /api/runs/:id` even when the run has **zero plan nodes**, a state
in which the only possible answer is `{ basis: "no-plan", phases: [] }`
(`packages/core/src/run-phases.ts:106`). A plan-less run should not ask.

**Gap 2 — an unguarded behaviour.** `packages/web/src/views/project-workflows.test.ts` never asserts
the band is **absent** for a `basis: "no-plan"` run: its `phasesAnswer` fixture is only ever set to a
plan-bearing shape (test lines ~333 and ~1548). And `packages/web/src/components/PhasesBand.vue:104-170`
has **no internal empty state**, so a future change that mounted it with `phases: []` would render a
bare `Phases` header and two empty lists — and the suite would still pass. KAR-28.6 AC1 depends on
that absence.

**Acceptance criteria**

1. A run with no adopted plan issues **no** phases request: mounting the workflows view on a run with
   zero plan nodes results in zero `GET /api/runs/:id` calls from `useRunPhases`, asserted by call
   count, not by absence of an error.
2. The moment a plan is adopted, the request is issued exactly once and the band appears — the guard
   in AC1 delays nothing and drops nothing.
3. A test pins the band's **absence** for a `basis: "no-plan"` answer: the fixture is set to
   `{ basis: "no-plan", phases: [] }` and the assertion is that no band element is rendered. It fails
   if `PhasesBand` is mounted with an empty phase list.
4. Nothing else about the band's behaviour changes. KAR-28.6's existing scenarios (EPIC-28-S23,
   EPIC-28-S24, EPIC-28-S25) pass unmodified, and `PhasesBand.vue`'s rendering for a plan-bearing run
   is untouched.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level     | Test                                                                                                                                  | Red when                                                                                                         |
| --- | --------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | component | Mount the workflows view on a run with zero plan nodes; assert `useRunPhases` made **zero** fetches                                     | `immediate: true` fires a request whose only possible answer is `no-plan` — one wasted round trip per plan-less run |
| 2   | component | With the same view mounted, adopt a plan; assert exactly one phases fetch happened and the band rendered                                | The guard is too eager and a run that compiles a plan never asks, so the band never appears at all                 |
| 3   | component | Set `phasesAnswer` to `{ basis: "no-plan", phases: [] }` and assert no band element exists in the DOM                                   | Nothing pins KAR-28.6 AC1's absence, so a change that mounts the band with an empty list ships a bare `Phases` header |

**Execution plan.** TDD, small. Red at the fetch count first — the request is the observable fact and
the absent band is the guard around it. Two files touched (`useRunPhases.ts` and
`project-workflows.test.ts`); if `PhasesBand.vue` needs an empty state as well, that is a decision to
record, not to slip in. Model: opus implements; sonnet verifies.

## Scope decisions recorded rather than taken quietly

- **The canvas is kept, behind a toggle.** The owner considered deleting EPIC-17's graph stack
  outright and chose not to: the list is the default, the graph stays. Nothing is deleted, and the
  cost accepted is two surfaces over one model.
- **The Logs tab stays out of the inspector.** No level-tagged per-node log fact exists. The io
  stream is the honest equivalent and is already on screen.
- **No model or throughput metadata is faked.** `test/no-context-window-table.test.ts` stands; the
  blueprint's `200k` and `tok/s` figures are not facts DeFlow holds.
- **Fan-out agent counts are not invented.** The blueprint's "75 agents" rows presuppose reusable
  workflow definitions, which do not exist. The agent list shows the agents the ledger records.

## Definition of done

Every AC verified by the flow file's scenarios; the gate green; and one performed walk: start a real
run, read the framing turn's actions and decisions as they happen, watch the agent list fill with
attempts as the plan executes, open a row's output in the docked inspector without losing sight of
the list, and step through the phases band — then answer, from the screen alone, why every step
happened.
