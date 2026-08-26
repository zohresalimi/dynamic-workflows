# EPIC-28 flows — watching the work

> BA-level scenarios for [EPIC-28](../epics/EPIC-28-watching-the-work.md). Same working agreement as
> EPIC-26 and EPIC-27's flow files: the TDD exception covers **visual** work only — pixel placement,
> spacing, colour. Everything else is test-first, without exception.

## KAR-28.1 — A pre-execution turn shows its course of actions and decisions

**EPIC-28-S01 — a tool call names what it acted on**
- **Given** a framing turn whose stdout carries `tool_use` frames for `Read` with a path, `Bash` with a command, and an MCP call with an issue id
- **When** the activity feed renders
- **Then** each row shows the vendor's tool name **and** its identifying argument, spelled as the frame spelled it and truncated only for width.

**EPIC-28-S02 — a tool call's result is folded into its row**
- **Given** a `tool_use` frame followed by its `tool_result` frame
- **When** the feed renders
- **Then** the row shows whether the call succeeded and the vendor's own summary of it; **and given** a result this build cannot read, **then** the row shows the call alone and no error is reported.

**EPIC-28-S03 — the agent's own words are on screen**
- **Given** a turn that emits assistant text between two tool calls
- **When** the feed renders
- **Then** the text appears as its own row, in the order it was emitted, rather than being discarded as it is today.

**EPIC-28-S04 — the feed holds the whole turn, or says it does not**
- **Given** a turn that has emitted more output than the feed's window holds
- **When** an operator reads it from the top
- **Then** either the whole turn is present, or the surface states that earlier output is windowed and links to the full transcript — never a silent start mid-turn.

**EPIC-28-S05 — the feed gives way to the plan**
- **Given** an activity feed on a running framing turn
- **When** the plan compiles
- **Then** the feed is replaced by the plan in the same panel, with no refresh and no second subscription.

**EPIC-28-S06 — an unreadable frame makes the feed quieter, never broken**
- **Given** a stdout frame in a dialect this build does not know
- **When** the feed renders
- **Then** the frame is skipped, every readable frame around it still renders, and nothing reports the turn as failed.

## KAR-28.2 — The agent list is the primary surface

**EPIC-28-S07 — the list is what the screen shows**
- **Given** a run with a compiled plan
- **When** the workflows screen opens
- **Then** the primary panel is the agent list, one row per agent, each carrying title, agent, model, state, elapsed and cost.

**EPIC-28-S08 — a retry is its own row**
- **Given** a step that failed on its first attempt and succeeded on its second
- **When** the list renders
- **Then** both attempts are present as their own rows, labelled by attempt, and the failed one is still readable after the successful one.

**EPIC-28-S09 — sub-agents read as sub-agents**
- **Given** a run whose ledger records a main agent and the sub-agents it spawned
- **When** the list renders
- **Then** the hierarchy is legible — a sub-agent is visibly subordinate to the agent that spawned it — and a run with no sub-agents renders a flat list with no empty hierarchy chrome.

**EPIC-28-S10 — every row can be opened**
- **Given** any row in the list
- **When** its output control is used
- **Then** that node's transcript opens through the surface that already renders one, and no second transcript renderer exists in the codebase.

**EPIC-28-S11 — the graph is one toggle away, and still one canvas**
- **Given** the agent list on screen
- **When** the operator switches to Graph and back
- **Then** the graph renders the same run, exactly one canvas and one subscription have existed throughout, and the choice persists for the session.

**EPIC-28-S12 — one model, two surfaces**
- **Given** the list and the graph both open on the same run over the same tick
- **When** a node's state changes
- **Then** both show the change from the one shared bodies object, and neither formats a duration or a price the other formats differently.

## KAR-28.3 — The topbar stops describing a run that is not on the screen

**EPIC-28-S13 — the composer describes no run**
- **Given** a run in the store, concluded as `aborted`
- **When** the operator opens the new-run composer
- **Then** the topbar shows no run provider, no run task and no run status pill.

**EPIC-28-S14 — every run-less route is covered, not just the composer**
- **Given** the same store
- **When** each of the routes that show no run is opened in turn
- **Then** none of them renders the three run banners.

**EPIC-28-S15 — the run views keep what they have**
- **Given** a run view with no header of its own
- **When** it renders
- **Then** the provider, task and status banners appear exactly as they do today.

**EPIC-28-S16 — a new route cannot inherit a stale run by accident**
- **Given** a route name in neither category
- **When** the guard runs
- **Then** it fails, naming the route and asking which category it belongs to.

## KAR-28.4 — The inspector docks

**EPIC-28-S17 — opening the inspector dims nothing**
- **Given** the agent list on screen
- **When** a row's output is opened
- **Then** the inspector is docked at the right, and the rail, the topbar and the list remain at full brightness and remain interactive.

**EPIC-28-S18 — the keyboard contract survives de-modalising**
- **Given** the inspector opened from a row
- **When** focus is examined, `Escape` is pressed, and focus is examined again
- **Then** focus moved into the panel on open, the panel closed on `Escape`, and focus returned to the row that opened it.

**EPIC-28-S19 — it opens without a graph**
- **Given** a run with no graph on screen
- **When** an agent row is opened
- **Then** the inspector opens on that node — node selection is not the only route into it.

## KAR-28.5 — A phases projection

**EPIC-28-S20 — phases are read from the ledger**
- **Given** a seeded ledger for a run with several phases, some complete and one in progress
- **When** the phases projection folds it
- **Then** it answers the ordered phases, each phase's state, and completed/total counts, all evidenced by recorded events.

**EPIC-28-S21 — a run with no phase structure is not given one**
- **Given** a run whose plan carries no phase structure
- **When** the projection folds it
- **Then** it answers the shape the ledger evidences and never fabricates a phase.

**EPIC-28-S22 — phases survive a restart**
- **Given** a run with phases, and the daemon killed and restarted
- **When** the projection is read again
- **Then** it answers identically, because it is a fold over the ledger rather than in-memory state.

## KAR-28.6 — The phases band

**EPIC-28-S23 — the band is about this run**
- **Given** the workflows screen on a run with phases
- **When** the lower band renders
- **Then** it shows this run's phases and the work in the selected phase, and does not show other runs' history.

**EPIC-28-S24 — the current phase is where you land**
- **Given** a run mid-execution
- **When** the band renders
- **Then** the phase in progress is selected, and selecting another shows that phase's work.

**EPIC-28-S25 — history moved, not removed**
- **Given** the workflows screen
- **When** the operator looks for previous runs
- **Then** they are one click away on the Runs view, and no run's history is unreachable.

## KAR-28.7 — The status pill stops latching on a gate it has already answered

**EPIC-28-S26 — an answered gate lets go of the pill**
- **Given** a run whose status pill reads "needs a decision" after `human.requested`
- **When** the operator's answer arrives as `human.responded`
- **Then** in the same tick, and with no refresh and no re-fetch, the pill no longer reads "needs a decision" and reads what the run is actually doing.

**EPIC-28-S27 — approving a spec also releases it**
- **Given** the same latched pill
- **When** `run.spec.approved` arrives instead — the path `run_20260826T060745Z_d81b6c` actually took
- **Then** the pill follows the daemon's `spec-approved` status rather than staying on `needs-human`, which is the status the daemon has been reporting correctly all along.

**EPIC-28-S28 — the run-list row is fixed with the pill, not after it**
- **Given** the runs list showing a row whose gate is open
- **When** that gate is answered
- **Then** the row's status **and** its label both move, rather than only its gate being cleared as `clearGate` does today.

**EPIC-28-S29 — one source of status, and it is total**
- **Given** the pill and the run-list row on the same run
- **When** the codebase is inspected
- **Then** exactly one mapping from run state to status exists in `packages/web`, both surfaces read it, and a guard fails — naming the kind — when a status-changing event kind is added without an answer in it.

**EPIC-28-S30 — the composed pre-execution label reaches the frame**
- **Given** a run in `spec-approved` with an attempt number and a start instant, for which the daemon composes `planner — running · attempt 1 of 3 · since <instant>`
- **When** the status pill renders
- **Then** it shows that composed sentence through `runStatusLabel(state)`, not a bare `planning` from a direct `RUN_STATUS_LABELS` lookup, and `packages/web` invents no second label vocabulary.

**EPIC-28-S31 — the states that already worked still work**
- **Given** each of `run.created`, `run.started`, `run.paused`, `run.resumed`, `run.cancel.requested`, `run.completed` and `run.aborted`
- **When** the pill renders after each
- **Then** the text is byte-identical to today's, and the existing latch-ON assertion at `frame.test.ts:294-301` still passes unchanged.

## KAR-28.8 — The hidden panel stays hidden

**EPIC-28-S32 — the graph is not painted over the agents**
- **Given** the workflows screen on a run with a compiled plan, with the Agents panel selected
- **When** the view is inspected
- **Then** no graph element is visible anywhere over the agents table — not the node cards, their `Pending` pills or their `claude · no model reported` bodies — at the top of the list and after scrolling to the bottom.

**EPIC-28-S33 — the hidden panel is not reachable either**
- **Given** the Agents panel selected
- **When** the operator tabs through the view, and when each agent row's centre is hit-tested
- **Then** no focus stop lands inside the graph subtree and every hit-test returns a list element, so an invisible card can neither take focus nor swallow a click.

**EPIC-28-S34 — no ghosts left behind by the toggle**
- **Given** a graph node under the pointer, carrying hover or drag state
- **When** the operator switches to Agents without the node ever receiving a `pointerleave`
- **Then** no node retains hover or drag state, and none of the half-faded duplicates the 2026-08-26 screenshot recorded appears.

**EPIC-28-S35 — the fix does not unmount the canvas**
- **Given** the toggle switched between Agents and Graph ten times
- **When** the canvas and the feed are counted
- **Then** exactly one canvas has ever existed and the feed subscribed exactly once — KAR-28.2 AC5's invariant, which this story may not spend to buy the hiding.

**EPIC-28-S36 — the reverse direction holds too**
- **Given** the Graph panel selected
- **When** the view is inspected
- **Then** no agent-list element is visible, focusable or hit-testable, so the remedy is symmetric rather than a patch on the one direction somebody happened to look at.

## KAR-28.9 — A run with no plan neither draws a phases band nor asks for one

**EPIC-28-S37 — a plan-less run does not ask for phases**
- **Given** the workflows view mounted on a run with zero plan nodes, whose only possible phases answer is `{ basis: "no-plan", phases: [] }`
- **When** the view settles
- **Then** `useRunPhases` has made zero requests, counted rather than inferred from the absence of an error.

**EPIC-28-S38 — adopting a plan asks exactly once**
- **Given** that same view, still mounted
- **When** the run adopts a plan
- **Then** exactly one phases request is issued and the band appears — the guard delays nothing and drops nothing.

**EPIC-28-S39 — the band's absence is pinned, not assumed**
- **Given** a phases answer of `{ basis: "no-plan", phases: [] }`
- **When** the workflows view renders
- **Then** no band element exists in the DOM — and the assertion fails if `PhasesBand` is ever mounted with an empty phase list, which today would render a bare `Phases` header and two empty lists with the suite still green.
