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
