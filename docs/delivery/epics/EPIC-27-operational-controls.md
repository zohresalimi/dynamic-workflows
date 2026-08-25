# EPIC-27: Operational controls — pause a run for real, and kill what leaked, from the UI

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-27-operational-controls-flows.md)

|                      |                                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Epic ID**          | EPIC-27                                                                                                                                                      |
| **Status**           | Not started                                                                                                                                                  |
| **Priority**         | P1                                                                                                                                                           |
| **Milestone**        | M1                                                                                                                                                           |
| **Workstream**       | W20 — added 2026-08-23, after an afternoon of running real workloads left the operator with no lever between "let it run" and "cancel it", and with `kill` one-liners as the only answer to leaked daemons |
| **Depends on**       | EPIC-15 (daemon API and event stream), EPIC-22 (the run view the controls land on), EPIC-13 (gates — pause must compose with an open gate)                     |
| **Blocks**           | Nothing mechanical. It blocks the operator's ability to share a machine between DeFlow and anything else without a terminal open                              |
| **PRD requirements** | F10.1, NF1, NF8                                                                                                                                              |
| **Architecture**     | [05-orchestration.md](../../05-orchestration.md) (the drive loop pause hooks into), [09-workspace-and-safety.md §4](../../09-workspace-and-safety.md), [11-daemon-api.md](../../11-daemon-api.md) |

## Goal

On 2026-08-23 the operator ran real framing loads, a redesign build, and a test gate on one
machine. Two controls were missing, and both were felt, not imagined:

1. **There is no pause.** When load average passed 100, the only levers on a running run were
   cooperative cancel (the run is over; nothing resumes) and the kill switch (everything is
   over). An operator who needs the machine for twenty minutes — or who wants a run held while
   they think about a gate — has no way to say *hold, exactly here, and continue later*. The
   ledger already records everything needed to resume; what is missing is a state the drive
   respects.

2. **Leaked daemons are invisible until they are a load problem.** MET-807's leak put six
   orphaned `deflow up` daemons on the machine in one day, then six more by evening. Each was
   found by `ps | grep` in a terminal and killed by hand-typed pids — twice, because the list
   grew back. The daemon knows what a DeFlow process looks like better than a grep does; the UI
   should show the orphans and offer the kill, so process hygiene does not require a terminal
   and a steady hand at `kill`.

Neither story invents new run semantics. Pause is a scheduling fact (the drive does not advance a
paused run), not a process fact (nothing is signalled, nothing torn down); the orphan sweep kills
only processes it can positively attribute to DeFlow, and never itself.

## Stories

| Story | Title | Size | Depends on |
| -- | -- | -- | -- |
| KAR-27.1 | Pause and resume a run, from the UI and the CLI | M | — |
| KAR-27.2 | Orphaned daemons: counted, named and killable from the UI | M | — |
| KAR-27.3 | A run that is framing looks alive: status, heartbeat and live activity (added) | M | — |
| KAR-27.4 | The live-turn strip's facts run together: it styles itself with tokens the system does not have (added) | S | KAR-27.3 |
| KAR-27.5 | While a run is framing, the workflows screen keeps its panels (added) | M | KAR-27.3 |
| KAR-27.6 | A cooperative cancel stops parking silently: bounded, reported, and it names the way out (added) | M | — |
| KAR-27.7 | Pause, resume and stop, from the run surface (added) | M | KAR-27.6 |
| KAR-27.8 | `daemon.json` does not outlive its daemon (added) | S | — |
| KAR-27.9 | The cooperative rung exists outside the test suite (added) | M | KAR-27.6 |
| KAR-27.10 | A daemon that exits does not orphan the processes it spawned (added) | S | — |

### KAR-27.1 — Pause and resume a run, from the UI and the CLI

**As** an operator sharing a machine with a running run, **I want** a pause button that actually
holds the run — and a resume that continues it exactly where it held — **so that** "not right
now" stops meaning "never" (cancel) or "let it fight me for the machine" (nothing).

**Acceptance criteria**

1. `POST /api/runs/:id/pause` appends `run.paused` (by whom: operator) to the ledger; from that
   event on, the drive does not advance the run: no new node is spawned, no retry fires, no
   scheduled wake is dispatched. A wake that comes due while paused is deferred, not dropped.
2. A child process already in flight when pause lands is **not** signalled. Its turn completes
   and its result is recorded normally; the run then holds before the next advance. Pause is a
   scheduling state, not a kill.
3. `POST /api/runs/:id/resume` appends `run.resumed`; the next tick advances the run from
   exactly the ledger state it held at, including any wake deferred during the pause.
4. An open human gate on a paused run remains visible and answerable; the recorded answer does
   not advance the run until resume. Pausing changes what the *drive* does, never what the
   operator may say.
5. The paused state survives a daemon restart: recovery reads `run.paused` without a matching
   `run.resumed` and holds the run, same as an unbroken daemon life would.
6. The run/workflow view shows a pause control on a running run and a resume control on a paused
   one; the status chip says `paused — by operator` with the since-instant. `deflow pause <runId>`
   and `deflow resume <runId>` do the same through the same endpoints, and `deflow status` names
   the state.
7. Pause composes with cancel: cancelling a paused run works and is exactly cooperative cancel.
   Pausing a run that is already concluded, cancelled or awaiting nothing refuses with a message
   naming the state, and changes nothing.

**Execution plan.** TDD. Red first at the drive: a paused run's due wake does not dispatch and an
unpaused one's does; then the ledger events and recovery; then the API pair; then CLI and UI. The
UI control lands on the run header the EPIC-24/27-era redesign of the workflow view defines —
coordinate, do not fork, if that redesign is mid-flight. Model: opus for implementation and
review; fable may plan.

### KAR-27.2 — Orphaned daemons: counted, named and killable from the UI

**As** an operator whose test runs leak daemons (MET-807), **I want** the UI to show every
DeFlow process on this machine that is not the daemon serving me — and a button that kills the
orphans — **so that** reclaiming my machine does not require `ps`, a regex, and hand-typed pids.

**Why this is mitigation, not the fix.** The leak itself is MET-807's to close at the source.
This story assumes leaks will exist anyway (a crashed test leg leaves one regardless) and makes
them visible and disposable.

**Acceptance criteria**

1. `GET /api/hygiene/daemons` answers the DeFlow-shaped processes on this machine that are not
   the answering daemon: `deflow up` invocations under ephemeral install paths (`_npx`, temp
   dirs) and `packages/daemon/src/main.ts` processes whose parent is gone (ppid 1). Each row
   carries pid, start time, the path that identifies it as DeFlow's, and why it is classed an
   orphan. The answering daemon itself, and a live `node --watch` supervisor's current child,
   are never listed.
2. Attribution is positive, never pattern-luck: a process is listed only when its command line
   carries a DeFlow entrypoint the daemon recognises. A process the daemon cannot positively
   attribute is not listed and not killable through this surface, whatever it looks like.
3. `POST /api/hygiene/daemons/kill` kills the *currently listed* orphans — SIGTERM, a bounded
   grace, then SIGKILL — and answers per-pid outcomes (killed / already gone / survived, with
   errno). The sweep is recorded in the answering daemon's own log with the pids and outcomes.
4. The Runtimes panel (or Settings, wherever the daemon rows live) shows the orphan count when
   it is non-zero, with the list one click away and the kill button beside it; the count
   refreshes after a sweep. Zero orphans renders nothing — hygiene is not a permanent fixture.
5. A pid that was reused between list and kill is not killed: the kill verifies the process
   start time still matches the listing before signalling (the same guard `killTree`'s pid-reuse
   check already implements — reuse it, do not re-derive it).
6. The one-command story stays honest: everything the button does, `deflow doctor --kill-orphans`
   (or the doctor section the CLI already has) can do headless, with the same attribution rules
   and the same per-pid report.

**Execution plan.** TDD. Red first at attribution: a fixture `ps` table with DeFlow orphans, the
live daemon, a watcher pair, and near-miss impostors (a user's own `node main.ts` that is not
DeFlow's) — the classifier must list exactly the orphans. Then the kill sweep over killTree's
existing pid-reuse guard; then the endpoints; then the panel. Model: opus for implementation and
review; fable may plan.

### KAR-27.3 — A run that is framing looks alive: status, heartbeat and live activity (added 2026-08-23)

**As** an operator who just started a run, **I want** the page to show that the framing agent is
alive and what it is doing, **so that** three minutes of real interrogation does not read as a
stuck run.

**Why now.** On 2026-08-23 a framing turn spent minutes making five Linear queries and reading
the repository — visible in the vendor transcript, invisible in DeFlow. The workflow view said
`submitted — waiting to be framed` (the `created`-state label, even though
`provider.session_opened` was in the ledger) over a plan panel stuck on *"Reading the run's
ledger…"*. The operator's words: *"the user is unsure if anything is going on."* The daemon
holds the child's stdout stream the whole time and throws it away unless the turn fails.

**Acceptance criteria**

1. While a pre-execution turn (framing, recon, planner) is in flight, the run's status label
   names the node and the fact it is running — e.g. `framing — running · attempt 1 of 3` with
   the since-instant — and `submitted — waiting to be framed` appears only when no attempt is
   actually in flight. The distinction is derived from the ledger (`provider.session_opened`
   without a matching completion), never from in-memory daemon state, so it survives a restart
   and renders identically in the UI and `deflow status`.
2. A pre-execution turn's stdout is persisted incrementally as the run's io stream (the same
   store execution nodes use), not buffered until exit — so the evidence of what a turn did
   exists in the ledger even for a turn that is still running, and the existing io-tail API
   serves it without a new endpoint.
3. The workflow view, while a pre-execution turn runs, shows a live activity strip: elapsed
   time, time since last output, attempt number, and a human-readable tail of what the agent is
   doing now (at minimum, tool invocations as they happen). It updates from the io stream
   without a page refresh and disappears when the turn concludes.
4. The plan panel never shows a bare loading sentence indefinitely: when the feed is hydrated
   and no plan exists, it says what is actually happening now (framing running / awaiting
   spec approval / planner compiling), each state named from ledger facts.
5. Failure detail improves for free: when a pre-execution turn exits non-zero with empty
   stderr, the failure's evidence includes the tail of the persisted stdout — closing the
   2026-08-23 gap where a rate-limited turn died with `stderr: ""` and the operator-readable
   cause existed only in the vendor's own transcript file.

**Execution plan.** Designed, implemented and verified in a dynamic workflow (design: fable;
implementation: opus; verification: sonnet). TDD: red first at the status projection (a seeded
ledger with `session_opened` and no completion must not label `waiting`), then the incremental
io persistence at `spawnTurn`, then the API/UI strip.

### KAR-27.4 — The live-turn strip's facts run together (added 2026-08-25)

**As** an operator watching a framing turn, **I want** the activity strip's facts to read as
separate facts, **so that** the one surface that proves the run is alive is not an unbroken run of
letters.

**Why now.** On 2026-08-25 the operator opened the workflows screen on a framing run and read
`framingattempt 1 of 3running 1m 24slast output 1s agomcp__claude_ai_Linear__list_issuesmcp__claude_ai_Linear__get_issueBash`.
`TurnActivityStrip.vue` sets its flex gutters with `var(--space-2)` and `var(--space-1)`. **No
`--space-*` token exists** — `docs/design-system.md` § *The tokens* names three families plus the
`--text-*`, `--radius-*`, `--state-*` ramps and has no spacing scale at all; every other component
states geometry literally with a `/* geometry */` note. An undefined custom property makes the
declaration invalid at computed-value time, so `gap` falls back to `normal` — zero — and every fact
in KAR-27.3's strip abuts the next. The layout was never wrong; the gutters were never applied.

**Acceptance criteria**

1. The strip's facts are separated by real gutters in both themes: node name, attempt, elapsed,
   time-since-last-output and each tool call are visually distinct, and no two adjacent facts
   touch. The wrap behaviour at narrow widths is unchanged.
2. The strip states its geometry in the vocabulary the design system actually has — literal
   lengths carrying the same `/* geometry */` note its siblings use — and references no
   `--space-*` token anywhere.
3. No CSS custom property referenced in `packages/web/src` resolves to a token the stylesheet does
   not define. A check in `packages/web/scripts/` fails the build when one does, so the next
   undefined token is a red test rather than a screenshot an operator has to notice.
4. Behaviour is untouched: the poll interval, the held-chunk bound, the shown-call count, the
   unmount teardown and the four facts are exactly as KAR-27.3 left them.

**Execution plan.** TDD. Red first at the token check — it must fail on the two live `--space-*`
references before anything is edited — then the strip's own rules, then a rendering assertion that
the strip's computed gutter is non-zero. Model: opus for implementation; sonnet verifies.

### KAR-27.5 — While a run is framing, the workflows screen keeps its panels (added 2026-08-25)

**As** an operator watching a run frame, **I want** the plan panel and the tasks panel to stay on
screen saying what they are waiting for, **so that** the minutes before a plan exists do not read
as a broken page.

**Why now.** Found in the same 2026-08-25 session as KAR-27.4, on the same screen. The workflows
view computes `stripped = pendingPlan || hydratingPlan`, and `hydratingPlan` is true for the
*whole* framing phase — no plan nodes and no open gate. While `stripped`, the tasks panel is
removed from the DOM (`v-if="!stripped"`) and the plan panel is collapsed to `height: 0`
(`.workspace__graph--tucked`), leaving a single column of three `auto` rows inside a `height: 100%`
grid; grid's default `align-content: stretch` then grows all three tracks equally. What the
operator sees for minutes is a one-line strip, a large void, and a history table floating
mid-page — touching neither the bottom edge nor the right edge, with no tasks panel at all.

**The collapse was a deliberate decision, and only half of it was needed.** Commit `81bd0df`
records it: the canvas is collapsed rather than unmounted *because unmounting it would close the
run's feed*. That reason justifies keeping the graph mounted; it never required hiding the panel
that contains it. This story keeps the invariant and drops the hiding.

**Acceptance criteria**

1. While a run has no plan — framing, awaiting spec approval, or planner compiling — the plan
   panel and the tasks panel are both on screen, each carrying its own empty state naming what it
   is waiting for. Neither is removed from the DOM; neither is collapsed to zero height.
2. The live activity strip of KAR-27.3 renders *inside* the plan panel as its header line, rather
   than as a separate band standing in for the panel. When the turn concludes the strip goes and
   the panel stays.
3. The one-canvas / one-subscription-per-run invariant holds unchanged: the graph is still never
   unmounted between plan states, and `test/one-workspace-surface.test.ts` passes **unmodified**.
4. The screen fills its viewport at every run state: the last row meets the bottom edge and the
   right column meets the right edge, modulo the shell's own padding, with no stretched empty
   track between sections. A run with a plan, a run framing, and a run at a gate lay out on the
   same grid rather than on two grids that disagree.
5. When the plan arrives the panels are already there: the graph fills in place, with no layout
   jump between the pending and planned states.
6. The gate card keeps the primacy `81bd0df` gave it — an open gate is still the page's one raised
   card, full width, above the panels.

**Execution plan.** TDD. Red first at the view: a run whose feed is hydrated with no plan and no
gate must render both panels and must not render a zero-height graph section; then the grid, whose
assertion is that the pending and planned states resolve to the same track structure. No daemon
call changes, no store changes, no new projection. Model: opus for implementation; sonnet verifies.

### KAR-27.6 — A cooperative cancel stops parking silently (added 2026-08-25)

**As** an operator who has cancelled a run, **I want** to be told when the agent is not answering,
**so that** `cancelling` is a state I can act on rather than a place runs go to stay.

**Why now, and the correction that produced this story.** Observed twice on 2026-08-25, an hour
apart. `POST /api/runs/:id/cancel` answered `cancelling`; both runs then sat there indefinitely, and
the agent child — a real `claude` process working against a real repository — survived the cancel,
survived the daemon being killed, reparented to PID 1, and ran until it was killed by hand.

The first reading of that was "cancel does not signal the child", and it was **wrong**. The request
carried no `mode`, so it took the default — `cooperative` — and cooperative is *designed* not to
signal. `drive.ts` says so on the record:

> **Cooperative is never promoted.** A cooperative cancel whose agent has not answered leaves live
> processes behind, and this loop leaves them alone: an automatic escalation would make `--force`
> decorative and would truncate the transcript the operator cancelled the run in order to read
> (EPIC-19-S38).

That decision stands. `forceful` runs the real ladder and would have ended both runs.

**What is genuinely broken is narrower and worse.** Cooperative's *first rung* is asking the agent
to stop over the protocol, through `ports.protocolCancel`. That port is supplied in exactly three
places in this repository, and **all three are tests** (`kill-switch.test.ts` ×2,
`cancel-cooperative.test.ts`). Production wires it nowhere: `drive.ts` builds its kill runner with
`{db, clock, epoch, mode, by}` and no `protocolCancel` at all. So on a real run the default cancel
asks nobody anything, `finishCancels` reaches `if (live.length > 0) continue`, and the run parks —
with no bound, no report, and nothing on any surface saying that `--force` is the way out.

**This story does not add escalation.** It makes the wait honest and bounded. KAR-27.9 is where the
missing rung gets built; this is what makes the gap legible in the meantime.

**Acceptance criteria**

1. A cooperative cancel that has not completed within a stated window records that it is waiting —
   the run's own state carries "cancelling · the agent has not answered since &lt;instant&gt;" rather
   than a bare `cancelling`, and the window is a named constant, not a magic number.
2. The waiting state names the way out: every surface that shows it also names forceful cancel
   (`deflow cancel <runId> --force`, or the equivalent control) as the operator's next move.
3. Nothing is escalated automatically. A cooperative cancel never becomes a forceful one, and the
   live processes are left alone — EPIC-19-S38's decision is preserved, and a test asserts it.
4. The processes still running under a parked cancel are **named**: pid and node, in the ledger and
   on the surface, so "what is still running" is answerable without `ps`.
5. A forceful cancel is unchanged, and a test pins that it still ends the run and empties the group.
6. `deflow status` and the API report the same waiting state in the same words.

**Execution plan.** TDD. Red first at the projection: a seeded ledger with a cooperative
`run.cancel.requested`, no completion and a live process, past the window, must report waiting-with-
survivors rather than `cancelling`. Then the surfaces. No change to either ladder. Model: opus
implements; sonnet verifies.

### KAR-27.7 — Pause, resume and stop, from the run surface (added 2026-08-25)

**As** an operator watching a run, **I want** the buttons on the screen, **so that** controlling a
run does not require `curl` and a bearer token.

**Why now.** The endpoints have existed since KAR-15.5 — `POST /api/runs/:id/pause`, `/resume`,
`/cancel` — and KAR-26.5's audit recorded that **no frame surface calls any of them**. On
2026-08-25 the owner asked for the control three times in one session, and every stop performed that
day was performed with `curl`.

**Scope.** The controls and the wiring, over the endpoints that exist. Drive-level pause semantics —
deferred wakes, held retries, surviving a restart — remain KAR-27.1's and are not smuggled in here.

**The stop control sends `forceful`, and says so.** A button labelled Stop that took the default
would take the cooperative ladder, whose first rung is unbuilt (KAR-27.6) — so it would appear to do
nothing, which is the worst behaviour a stop control can have. The button is the forceful ladder, its
confirmation says the transcript may be truncated, and the cooperative ladder stays available where
an operator can choose it deliberately.

**Acceptance criteria**

1. The run surface shows a pause control on a running run, a resume control on a paused one, and a
   stop control on any run that is not already terminal. Each calls the endpoint that exists, and
   stop sends `mode: "forceful"` explicitly rather than taking the default.
2. Each control reports what happened: the run's state changes on screen from the ledger, and a
   refusal (already concluded, already cancelled) is shown as the message the daemon gave, not
   swallowed.
3. A control is disabled, with a reason, exactly when the daemon would refuse it — never enabled
   into a predictable error.
4. Stop asks for confirmation, because it is not reversible; pause does not, because it is.
5. The controls are reachable by keyboard and named for assistive technology.

**Execution plan.** TDD at the component contract: which control is offered in which run state, and
what each sends. Model: opus.

### KAR-27.8 — `daemon.json` does not outlive its daemon (added 2026-08-25)

**As** anything that looks for the daemon, **I want** the file to describe a daemon that exists,
**so that** a dead pid and a dead token are not what a client finds.

**Why now.** Observed 2026-08-25: after a daemon was killed, `~/.DeFlow/daemon.json` still named its
pid, its port and its token. A client reading it was sent to a corpse, and the token it carried
answered `bad_token`. Separately, the epoch climbed by ~120 during one gate run, because the test
suites boot daemons against the same data dir and each rewrites this file — so the staleness is not
a rare crash case, it is routine.

**Acceptance criteria**

1. A reader of `daemon.json` can tell a live daemon from a dead one without making a request: the
   recorded `processStartedAt` is verified against the pid, and a mismatch or a missing process reads
   as "no daemon", exactly as the boot reaper already compares it.
2. A daemon that exits by any path it can observe removes the file; a daemon that cannot (SIGKILL)
   is covered by the check above rather than by hope.
3. A test daemon booting against a shared data dir does not leave the file naming itself after it
   exits.
4. `deflow status` and every client that reads this file report "no daemon" rather than a stale
   endpoint.

**Execution plan.** TDD. Red first: write a `daemon.json` naming a pid that is not a daemon, and
assert every reader says no daemon. Model: opus.

### KAR-27.9 — The cooperative rung exists outside the test suite (added 2026-08-25)

**As** an operator who cancelled a run in order to keep its transcript, **I want** the agent to
actually be asked to stop, **so that** the gentle ladder is a ladder rather than a wait.

**Why now.** `cancel.ts`'s rung 1 — *"the only rung that ends with a transcript somebody can read"* —
is reached only when `ports.protocolCancel` is supplied, and production supplies it nowhere. The
whole cooperative mode therefore has no implementation outside three integration tests, which is why
it can only ever park (KAR-27.6). This story builds the rung; KAR-27.6 makes its absence legible
until it exists, and removes that legibility copy when it does.

**The open question this story must answer first.** Whether a cooperative stop can even be delivered
to the process this daemon spawns. The ACP transport has a protocol to carry it; a `claude -p` child
on the shim route may have no channel at all. If it does not, the honest answer is that cooperative
is unavailable *for that route* and the surfaces say so — not a rung that silently does nothing.

**Acceptance criteria**

1. `protocolCancel` is supplied in production for every route that has a channel to carry it, and a
   cooperative cancel on such a run reaches the agent, ends with a flushed transcript, and completes
   without any signal being sent.
2. For a route with **no** such channel, cooperative cancel is refused at the point of request with a
   message naming forceful as the available ladder — never accepted into a wait that cannot end.
3. The refusal and the capability are one fact, read from the route, so the CLI and the API cannot
   disagree about which ladders a run supports.
4. The transcript survives: a cooperatively cancelled run's output is readable afterwards, which is
   the entire reason this ladder exists.
5. KAR-27.6's waiting copy is removed on the paths where it can no longer occur, rather than left to
   describe a state that has become unreachable.

**Execution plan.** Spike first — establish whether each route can carry a cooperative stop, and
record the answer — then TDD the wiring per route. Model: opus.

### KAR-27.10 — A daemon that exits does not orphan the processes it spawned (added 2026-08-25)

**As** an operator, **I want** the daemon to take its children with it, **so that** stopping DeFlow
does not leave agents running against my repository.

**Why now.** Observed 2026-08-25: killing the daemon left its agent child alive and reparented to
PID 1, still working. Separately, one gate run left four `deflow up` daemons orphaned under `_npx`
paths. The reparented agent is the sharper case — it was still writing to a repository nobody was
watching.

**Acceptance criteria**

1. A daemon asked to stop terminates the process trees it spawned before it exits, using the ladder
   and the pid-reuse guard that already exist rather than a second implementation.
2. Anything it cannot terminate is recorded — pid, node, reason — before the process exits, so the
   next daemon and the operator both know what survived.
3. A daemon that cannot run its shutdown at all (SIGKILL) is covered by the next boot: recovery
   attributes and reports the survivors it finds, which is the seam KAR-27.2's sweep already owns.
4. Nothing is killed that cannot be positively attributed to this daemon's own runs.

**Execution plan.** TDD with a fake agent that outlives its parent: stop the daemon, assert the child
is gone and the record exists. Model: opus.

## Scope decisions recorded rather than taken quietly

- **Pause does not signal children (SIGSTOP was considered and rejected).** Stopping a vendor CLI
  mid-API-call risks timeouts, half-written transcripts and vendor-side session damage that
  DeFlow cannot repair. Letting the in-flight turn finish costs at most one turn of latency and
  keeps every recorded invariant true. If a hard freeze is ever needed, that is a new story with
  its own risks, not a widening of this one.
- **The orphan sweep does not reach into containers or other machines.** NF6 keeps M1 on one
  machine; the sweep's scope is the daemon's own host, full stop.
- **Workflow-granular pause (pausing one node while siblings run) is out.** The run is the unit
  the drive schedules and the unit the operator reasons about; per-node holds are M2 material if
  they are anything.

## Definition of done

Every AC verified by the flow file's scenarios; the gate green; and one performed walk: start a
real run, pause it mid-framing from the browser, watch the drive go quiet, resume it, watch it
conclude — then leak a daemon on purpose (kill a test leg mid-install), see the count appear,
and clear it with the button.
