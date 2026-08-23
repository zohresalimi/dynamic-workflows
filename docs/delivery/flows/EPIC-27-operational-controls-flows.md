# EPIC-27 flows — operational controls

> BA-level scenarios for [EPIC-27](../epics/EPIC-27-operational-controls.md). Same working
> agreement as EPIC-26's flow file: the TDD exception covers **visual** work only — pixel
> placement, spacing, colour. Everything else is test-first, without exception.

## KAR-27.1 — Pause and resume a run, from the UI and the CLI

**EPIC-27-S01 — pause holds the run before its next advance**
- **Given** a run mid-framing with a wake scheduled
- **When** `POST /api/runs/:id/pause` lands
- **Then** `run.paused` is appended, and on the next tick the due wake is deferred, no node is spawned, and no retry fires.

**EPIC-27-S02 — an in-flight child finishes its turn; nothing is signalled**
- **Given** a framing child process in flight
- **When** pause lands
- **Then** no signal reaches the child's process group; its result is recorded normally when it exits; the run holds before the next advance.

**EPIC-27-S03 — resume continues from exactly where the run held**
- **Given** a paused run with one wake deferred during the pause
- **When** `POST /api/runs/:id/resume` lands
- **Then** `run.resumed` is appended and the next tick dispatches the deferred wake; the ledger between `run.paused` and `run.resumed` contains no node activity for this run.

**EPIC-27-S04 — an open gate on a paused run is answerable, and the answer waits**
- **Given** a paused run with `spec-approval` open
- **When** the operator answers `approve`
- **Then** the answer is recorded, the gate shows answered, and no planning starts until resume — after which planning starts from the recorded answer without re-asking.

**EPIC-27-S05 — paused survives a daemon restart**
- **Given** a run paused, then the daemon killed and restarted
- **When** recovery completes
- **Then** the run is still held (recovery read `run.paused` with no matching `run.resumed`), and `deflow status` names it `paused`.

**EPIC-27-S06 — pause refuses states it cannot hold**
- **Given** a run already concluded (done, failed, or cancelled)
- **When** pause is requested
- **Then** the API refuses with a message naming the state, appends nothing, and the UI control was not offered for that run in the first place.

**EPIC-27-S07 — cancelling a paused run is ordinary cooperative cancel**
- **Given** a paused run
- **When** cancel is requested
- **Then** cooperative cancel proceeds exactly as for a running run, and the run concludes cancelled.

**EPIC-27-S08 — the controls exist in both surfaces and agree**
- **Given** a running run in the workflow view
- **When** the operator clicks pause, then later resume
- **Then** the status chip reads `paused — by operator` with the since-instant while held; and `deflow pause <runId>` / `deflow resume <runId>` drive the same transitions with the same refusals.

## KAR-27.2 — Orphaned daemons: counted, named and killable from the UI

**EPIC-27-S09 — the listing is exactly the orphans**
- **Given** a process table holding the answering daemon, a `node --watch` supervisor with its current child, two `deflow up` processes under `_npx` temp paths, one ppid-1 `packages/daemon/src/main.ts`, and a user's own unrelated `node main.ts`
- **When** `GET /api/hygiene/daemons` answers
- **Then** it lists exactly the two `_npx` daemons and the ppid-1 orphan — with pid, start time, identifying path and orphan class each — and neither the answering daemon, nor the watcher's child, nor the unrelated `main.ts`.

**EPIC-27-S10 — no positive attribution, no listing**
- **Given** a process whose command line resembles but does not carry a DeFlow entrypoint
- **When** the listing is computed
- **Then** the process is absent, and nothing offered through this surface can signal it.

**EPIC-27-S11 — the sweep kills what it listed and reports per pid**
- **Given** S09's listing
- **When** `POST /api/hygiene/daemons/kill` runs
- **Then** each listed pid receives SIGTERM, then SIGKILL after the grace window if still alive; the answer names each pid's outcome; the daemon's log records the sweep; the next listing is empty.

**EPIC-27-S12 — a reused pid is not killed**
- **Given** a listed orphan that exited after listing, its pid now reused by another process
- **When** the sweep runs
- **Then** the start-time guard notices the mismatch, no signal is sent to that pid, and its outcome reads `already gone`.

**EPIC-27-S13 — the panel appears only when there is something to clean**
- **Given** zero orphans
- **When** the Runtimes panel renders
- **Then** no hygiene row renders at all; **and given** three orphans, the row shows the count, the list is one click away, the kill button sits beside it, and the count refreshes after a sweep.

**EPIC-27-S14 — headless parity**
- **Given** the same process table as S09
- **When** the doctor's kill-orphans path runs headless
- **Then** the same attribution decides, the same sweep runs, and the same per-pid report prints.

## KAR-27.3 — A run that is framing looks alive (added 2026-08-23)

**EPIC-27-S15 — an in-flight framing attempt is never labeled "waiting"**
- **Given** a ledger holding `provider.session_opened` for framing attempt 0 and no completion for it
- **When** the run's status label is derived (UI projection and `deflow status` both)
- **Then** it names the node and that it is running — `framing — running · attempt 1 of 3` with the since-instant — and not `submitted — waiting to be framed`.

**EPIC-27-S16 — "waiting to be framed" is reserved for actual waiting**
- **Given** a run submitted with no `provider.session_opened` yet, or whose last attempt concluded and the retry wake is in the future
- **When** the label is derived
- **Then** it reads `submitted — waiting to be framed`, unchanged.

**EPIC-27-S17 — a pre-execution turn's stdout lands incrementally**
- **Given** a framing child that emits stream frames over 30 seconds before exiting
- **When** the io store is read mid-turn (before the child exits)
- **Then** the frames emitted so far are present under the run/node/attempt, served by the existing io-tail API, and the store's content at exit equals what the buffered path would have captured.

**EPIC-27-S18 — the activity strip shows life and goes away**
- **Given** the workflow view open on a run whose framing turn is in flight
- **When** the agent makes a tool call
- **Then** the strip shows elapsed, time-since-last-output, attempt number, and the call, without a refresh; **and when** the turn concludes, the strip is gone.

**EPIC-27-S19 — the plan panel names the actual state, never a stuck loading line**
- **Given** a hydrated feed and no plan
- **When** the plan panel renders during framing, during an open spec gate, and during planner compilation
- **Then** each state shows its own named copy derived from ledger facts, and "Reading the run's ledger…" appears only while the feed is genuinely hydrating.

**EPIC-27-S20 — empty stderr no longer hides the cause**
- **Given** a pre-execution turn that exits 1 with empty stderr after emitting a rate-limit frame on stdout
- **When** the node failure is recorded
- **Then** the failure evidence includes the persisted stdout tail, and the ledger message names the vendor's stated cause rather than an empty string.
