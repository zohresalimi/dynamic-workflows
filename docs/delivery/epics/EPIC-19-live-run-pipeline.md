# EPIC-19: The live run pipeline, end to end

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-19-live-run-pipeline-flows.md)

|                      |                                                                                                                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-19                                                                                                                                                                                                                                                                                     |
| **Status**           | Not started                                                                                                                                                                                                                                                                                 |
| **Priority**         | P0                                                                                                                                                                                                                                                                                          |
| **Milestone**        | M1                                                                                                                                                                                                                                                                                          |
| **Workstream**       | W13 — added 2026-08-12, after the first live run did nothing (see [roadmap §2.2](../../17-roadmap.md) and §2.3)                                                                                                                                                                              |
| **Size**             | ~30 days across 10 stories — over the ~15-day guidance; see Risks                                                                                                                                                                                                                           |
| **Depends on**       | EPIC-10 (intake, framing, spec gate, recon), EPIC-11 (plan compilation and validation), EPIC-06 (`decide()`, the ticker, `node_wake`, the effect journal), EPIC-09 (packet assembly), EPIC-05 (provider registry and capability probe), EPIC-15 (the HTTP API and the SSE stream), EPIC-16 and EPIC-17 (the store and the views that render it), EPIC-18 (`run`, `status`, `doctor`, the exit-code table), EPIC-13 (human nodes), EPIC-12 (gates), EPIC-14 (cost accounting), EPIC-04 (the bundled mock agent — the binary every scenario here runs against, and the one KAR-19.7 extends) |
| **Blocks**           | M1's definition of done. PRD §11 is _"you complete a real multi-hour task at work with it"_; until this epic lands, no task of any length can be completed, because no submitted run proceeds past intake                                                                                    |
| **PRD requirements** | F1.1, F1.2, F1.3, F2.2, F2.3, F3.1, F3.2, F3.4, F3.5, F3.7, F4.1, F4.2, F4.3, F4.4, F4.5, F4.7, F5.7, F6.1, F7.1, F9.1, F9.2, F10.1, F10.6, F10.9, NF1, NF3, NF6, NF7, NF8, NF9, NF10, AR-1                                                                                                 |
| **Architecture**     | [05-durable-execution.md §10](../../05-durable-execution.md) (the scheduler and the ticker), [06-planning-and-replanning.md §1, §2, §3](../../06-planning-and-replanning.md) (intake, framing, compilation, validation), [11-api-and-realtime.md §2, §3, §6, §7.1](../../11-api-and-realtime.md) (the global topic, the documented `GET /api/runs`), [12-frontend-architecture.md §1, §6](../../12-frontend-architecture.md), [14-testing-strategy.md §2, §12](../../14-testing-strategy.md) |

## Goal

At the end of this epic, `DeFlow run --file <path>` against a real repository produces a run that
frames itself, compiles a plan, executes its nodes and reaches a terminal state — with the operator
watching it happen in the terminal and in the browser, and with a refusal in plain words when the
machine cannot host it. Nothing in this epic is a new capability. Every mechanism it needs already
exists, is individually tested, and is exported by a package. **What does not exist is the wiring
between them, and a test that would notice.**

## Why this matters

**This epic exists because of a specific failure, on 2026-08-12.** An operator ran
`DeFlow run --file <path>` against a real repository and the run did nothing. The ledger for
`run_20260812T133934Z_468702` contains exactly one event — `task.submitted` — and nothing after it.
Two other runs from the same day contain only `provider.probed`. The CLI sat at _"task submitted"_
until the operator gave up; the web UI, once they had navigated to `/runs/<id>` by hand because the
root route showed them nothing, said _"No plan yet"_. There was no error anywhere: not on stdout,
not in the ledger, not in the daemon log.

**The diagnosis is a missing call.** `runFramingInterview` in
`packages/daemon/src/framing/interview.ts` is exported, documented, and has no production caller —
`grep` outside the test tree returns only its own definition. `POST /api/runs` normalises the input
into `task.submitted` and returns 201 by design (KAR-10.1: _"No interpretation happens here"_), and
nothing schedules what comes next. So `run.created` is never appended; and because `run.created` is
what mints a `RunState`, no plan is compiled, no node is scheduled, the global `runs=*` topic — whose
membership is exactly `run.created`, `run.completed`, `run.aborted`, `human.requested` — carries
nothing, and every surface downstream is honestly reporting an empty ledger. The same hole exists at
three more joints: `compilePlanV1` and `executeRun` have no shipped caller either (only test support
and fixture scripts), and `boot()` never performs `RECOVERY_STEPS`' eighth step, `start-ticker`.

**The deeper problem is why nobody noticed, and that is what KAR-19.5 is for.** Every epic was built
and verified in isolation, and the e2e level runs against **recorded fixtures through the replay
harness** — which is the right design for view work ([14 §12](../../14-testing-strategy.md): the
fixtures are _"the UI's entire test and dev story"_) and is exactly what made this invisible. A
fixture is a ledger that already contains `run.created`, a plan and executed nodes; replaying it
proves the projections are right and proves nothing about who appends them. Roughly ten thousand
tests pass green while a live run does nothing at all, because **no test ever drove an operator's
real command through a live daemon to a node executing**. Each epic's own Definition of Done was
satisfied. The integration between them belonged to nobody, so it was nobody's red test.

Three things follow, and they shape the first five stories. A sixth was added later the same day,
after the operator's attempt to clean up after the failure hit a second dead end: there is no
`DeFlow cancel` command at all, and a run that never started cannot be got rid of by any route.
KAR-19.6 is that story, and it is the same defect wearing different clothes — a capability that
exists in the daemon and reaches no operator.

**And on 2026-08-13 the same operator ran it again by hand, this time with `claude` installed, and
found three more.** The chain is bound and it reached framing — which is the first five stories
working — and then: every turn died on `Error: Invalid session ID. Must be a valid UUID.`, because
DeFlow puts its own `run_…`-shaped identifier on a flag the vendor validates (KAR-19.8); the run
retried that identical failure every ~31 s indefinitely, recorded none of it in the ledger, printed
nothing to the terminal and never exited (KAR-19.9); and it had chosen `claude` at all on a machine
where `doctor` had just called `claude`'s ACP adapter missing and the bundled agent the only usable
provider, with no way for the operator to say otherwise and no statement of what had been chosen
(KAR-19.10). All three are the same sentence as the first five — **silence is the defect** — one
layer further in: the run now moves, and when it cannot, it still says nothing.

1. **Silence is the defect, not the symptom.** A run that cannot proceed must say so — in the
   ledger, in the terminal and in the UI. The operator lost an afternoon not because DeFlow refused,
   but because it did not.
2. **Refuse at submission, not after.** The operator had `claude` on `PATH` and no ACP adapter, so
   no provider could serve the run. That is knowable before the 201, `doctor` already has the words
   for it (KAR-18.8), and exit code `5` — _"this machine cannot host a run"_ — already exists for it.
3. **Wire, do not rewrite.** Every step this epic connects has an implementation and a test suite.
   A second implementation would double the surface and halve the trust, and KAR-19.3 carries a
   source guard against exactly that.

## Scope

**In scope:**

- Scheduling the framing step when intake accepts a task: a `node_wake` row written in the same
  transaction as `task.submitted`, consumed by the ticker `boot()` now actually starts.
- `run.created` appended on the live path, and therefore the global `runs=*` topic carrying it.
- `GET /api/runs?status=&limit=&cursor=` — already documented in
  [11 §6](../../11-api-and-realtime.md) and never implemented — and the web root route rendering
  that list, updated live from the global topic rather than on refresh.
- Admission at submission time: no usable provider is a typed, ledger-recorded refusal with
  `doctor`'s own wording, `DeFlow run` exit `5`, and the mock agent named as the zero-install path.
- Driving framing → spec gate → spec pinning → recon → `compilePlanV1` on the live path, through
  the existing functions, with each step's events appended as it happens.
- Driving `executeRun` over the compiled plan, with `io_chunk` output reaching both the terminal
  renderer and the web UI live, and the run reaching `completed` / `failed` / `paused` and saying
  which.
- A stall statement: a run with no forward progress and nothing in flight appends `run.stalled`
  (F4.7's existing event) rather than sitting silent.
- `pnpm test:smoke` — one live, fixture-free path from the real CLI binary through a real daemon and
  a real on-disk ledger to an executed node, against the bundled mock agent — wired into `pnpm test`.
- `DeFlow cancel <runId>` over the control endpoint that already exists, and a way out for a run
  that never started — the hole [KAR-18.3](./EPIC-18-cli-packaging.md#kar-183--DeFlow-run-headless-execution)'s
  amendment recorded and left open. Every surface that lists runs stops showing a stopped run as
  live (KAR-19.6).
- **One named exception to the rule below: a structured-output path for the bundled mock agent**
  (KAR-19.7, added 2026-08-13). It is mock-agent work, which the Out-of-scope rule sends to
  EPIC-04, and it is being done here on purpose — this epic's Definition of Done says a run must
  work end to end with only the bundled agent, and no vendor-free run can be framed today because
  every turn with a `returns` contract needs a `structuredOutputFlag` no ACP adapter has. A
  capability the acceptance test depends on cannot be out of scope for the epic that declares that
  test. The exception is this one capability, in the mock agent and its registry entry only; it does
  not reopen mock-agent scope generally, and EPIC-04's determinism guarantees and fixtures are
  binding on it.
- **The three defects the 2026-08-13 by-hand run found** (added that day): the exec-shim session-id
  argument the vendor rejects and the conformance row that would have caught it (KAR-19.8); a
  bounded, journalled, terminating failure path for a run that cannot get past a turn, using
  EPIC-06's own classified retry rather than a second policy (KAR-19.9); and `DeFlow run
  --provider`, the statement of which provider and which route a run chose, and the reconciliation of
  `doctor`'s view with admission's (KAR-19.10).

**Out of scope:**

- **Any new mechanism** (except the one named above). If a step needs behaviour that does not exist,
  that is a story in the epic that owns the mechanism, not here. This epic's diff is calls, scheduling records, one documented
  endpoint and one route — plus tests. KAR-19.6 adds no endpoint and no mechanism either: it is a
  CLI command over the control route that has always existed, plus one reordering inside
  `planRunControl`'s existing state machine. It does amend one shipped contract —
  [KAR-15.5](./EPIC-15-daemon-api.md) AC6's blanket _"no control verb applies before approval"_ —
  and that amendment is recorded in KAR-15.5's own file rather than absorbed here.
- **New event kinds.** The refusal in KAR-19.2 is recorded with `provider.probed` and `run.aborted`,
  both of which exist and both of which already reduce correctly. Widening the `Event` union is
  [EPIC-02](./EPIC-02-domain-model.md)'s, and doing it from here would be a schema change made in
  the wrong file.
- **Replacing the replay harness.** [KAR-16.5](./EPIC-16-ui-foundation.md) stays exactly as it is
  and stays the UI's development loop. KAR-19.5 adds the level that was missing above it; it removes
  nothing.
- **The nine views' own correctness.** EPIC-17 owns what each view draws. This epic owns only that
  the events reach them, and asserts the two clauses the owner named — a run appearing in the list
  without a refresh, and node output rendering as it streams.
- **Multi-hour realism.** The smoke test is deliberately a small mock-agent plan. Whether DeFlow
  completes a _real_ multi-hour task is PRD §11's question and is answered by using it, not by a test.
- **Windows.** NF5 is unchanged; M3 at the earliest.
- **Re-recording the existing fixtures.** Once a live run completes, the fixtures in
  [03 §6.2](../../03-local-development.md) can finally be recorded from real runs rather than built
  by script — but that is a follow-up, not a criterion here.

## Definition of Ready (epic level)

- [ ] EPIC-10 KAR-10.1, KAR-10.2, KAR-10.3, KAR-10.4 and KAR-10.5 are Done: intake, the framing
      interview, the F1.3 gate, spec pinning and recon each exist as callable functions.
- [ ] EPIC-11 KAR-11.1 and KAR-11.2 are Done: `compilePlanV1` and plan validation exist.
- [ ] EPIC-06 KAR-06.1, KAR-06.6 and KAR-06.9 are Done: `decide()`, `node_wake` + the ticker, and
      `recover()` with `RECOVERY_STEPS`.
- [ ] EPIC-15 KAR-15.3 is Done: the multiplexed stream and the `runs=*` global topic.
- [ ] EPIC-18 KAR-18.2 and KAR-18.3 are Done: `DeFlow up` boots a daemon and `DeFlow run` submits
      and attaches.
- [ ] EPIC-04 is Done: `DeFlow-mock-agent` is a real bin, so every scenario here runs with no vendor
      CLI, no credential and no network.
- [ ] The three deferrals this epic closes are re-read first, so nothing is re-litigated:
      [KAR-18.3](./EPIC-18-cli-packaging.md#kar-183--DeFlow-run-headless-execution)'s amendment,
      KAR-18.6 AC2's amendment, and EPIC-18's Out-of-scope entry _"driving a submitted run to
      completion"_.

## Definition of Done (epic level)

- [ ] All ten stories are Done.
- [ ] **On a machine with no vendor agent CLI installed at all, a run can be framed, planned and
      executed using only `DeFlow-mock-agent`** — with no credential, no network and no read of
      `~/.DeFlow`. This is the epic's manual acceptance test and the property KAR-19.5's smoke test
      automates; KAR-19.7 is what makes it reachable, and until it is, the two amendments in
      KAR-19.3 and KAR-19.4 stand open.
- [ ] Every scenario in [the flow file](../flows/EPIC-19-live-run-pipeline-flows.md) is automated at
      the level it declares and passes on `ubuntu-26.04` and `macos-26`, Node 24 and 26.
- [ ] `pnpm test:smoke` is part of `pnpm test`, drives the real CLI binary against a real daemon and
      a real on-disk ledger, and asserts a terminal run with a compiled plan, at least one executed
      node and streamed output. It is proved able to go red by KAR-19.5 AC4's sabotage table.
- [ ] `grep` for a production caller of `runFramingInterview`, `compilePlanV1` and `executeRun`
      returns a shipped source file for each, and `packages/cli/test/integration/support/run-fixture.ts`'s
      deferral note and `test/run-completion-deferral.test.ts` are **deleted**, not amended — the
      test that fails the day a shipped source compiles a plan has done its job and must not be left
      inverted.
- [ ] EPIC-18's two amendments (KAR-18.3 AC1, KAR-18.6 AC2) are closed in their own files, with the
      completion half now asserted rather than deferred. A deferral that outlives its reason is the
      failure mode [README §9](../README.md#9-changing-the-plan) exists to prevent.
- [ ] A run submitted while the web UI is open at `/` appears in the list without a refresh, and a
      run that cannot proceed states why in all three of the ledger, the terminal and the UI.
- [ ] `DeFlow run` on a machine with a vendor CLI and no ACP adapter exits `5` with `doctor`'s own
      sentence, and the same sentence appears in `GET /api/runs/:id` and in the UI.
- [ ] `DeFlow cancel <runId>` exists, is the only documented way to stop a run, and stops one in
      **any** state — including a run that never started. The three runs from 2026-08-12
      (`run_20260812T133401Z_318740`, `run_20260812T133514Z_ed4f12`,
      `run_20260812T133934Z_468702`) are each cleared by one command, and afterwards
      `DeFlow status`, `GET /api/runs?status=active` and the web run list show none of them as live.
      No documented path to stopping a run involves `curl` or a hand-extracted bearer token.
- [ ] **A run that cannot get past a turn ends.** With a provider that fails every attempt,
      `DeFlow run --file <task>` prints each failure as it happens, stops after the node's own
      `RetryPolicy` ceiling, exits `1`, and the ledger and the UI both show a failed run carrying the
      typed reason. No path retries without a bound, and no attached CLI is left holding the terminal
      (KAR-19.9).
- [ ] **Every exec-shim argv DeFlow builds is one the vendor it names accepts.** The F3.4 conformance
      battery covers the argument forms on every commit against the mock and the fake vendor CLI, and
      the real-vendor rows run behind `DeFlow_MANUAL_VENDOR_CLI=1` and are reported as skipped rather
      than silently absent when they do not (KAR-19.8).
- [ ] **A run states which provider it chose and by which route**, in the terminal, the ledger and
      the UI; `DeFlow run --provider <id>` selects one and is validated against the registry; and
      `doctor` and admission answer the provider question through one function, so no route `doctor`
      calls unusable is one a run silently takes (KAR-19.10).
- [ ] No `Unverified` claim is introduced. Where this epic discovers that an architecture doc
      describes a call nothing makes, the doc is corrected in the same session (AR-6).

## User stories

### KAR-19.1 — Intake hands off to framing, and the run becomes visible

|                 |                                                                                                                                                                                            |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                                                                |
| **Priority**    | P0                                                                                                                                                                                         |
| **Size**        | M                                                                                                                                                                                          |
| **Depends on**  | EPIC-10 KAR-10.1 (intake and `task.submitted`) and KAR-10.2 (`runFramingInterview`, which appends `run.created`), EPIC-06 KAR-06.6 (`node_wake` and the ticker) and KAR-06.9 (`RECOVERY_STEPS`' `start-ticker`), EPIC-15 KAR-15.1 (routing) and KAR-15.3 (the `runs=*` global topic), EPIC-16 KAR-16.2 (the SSE client) |
| **PRD**         | F1.1, F4.1, F4.4, F4.7, F10.1, NF3, NF10                                                                                                                                                   |
| **Verified by** | EPIC-19-S1, EPIC-19-S2, EPIC-19-S3, EPIC-19-S4, EPIC-19-S5, EPIC-19-S6, EPIC-19-S7, EPIC-19-S8                                                                                              |

**As** an operator who has just submitted a task, **I want** the run to start doing something and to
be visible everywhere I might look for it, **so that** the first two seconds tell me whether DeFlow
took the job — instead of a prompt that returns and a system that never moves.

Three separate joints are broken here and they fail as one symptom. **Nothing schedules framing:**
intake appends `task.submitted` and returns, and `runFramingInterview` — the function that appends
`run.created` — has no caller. **Nothing runs the schedule:** `boot()` performs five of
`RECOVERY_STEPS`' eight and stops before `start-ticker`, which `recovery.ts` explicitly leaves to
its caller, so even a written `node_wake` row would never be read. **Nothing shows the result:**
`GET /api/runs` is documented in [11 §6](../../11-api-and-realtime.md) and does not exist, and the
web root renders `PlanGraphView` with no run id, which is why the operator had to type the run id
into the address bar to see the run they had just created.

The fix respects two existing designs rather than inventing around them. The wake is written **in
the same transaction as `task.submitted`**, because [05 §10](../../05-durable-execution.md)'s whole
argument is that a durable row is the wait and a promise is not: split the pair and a crash between
them loses the half nobody notices — the run that simply never comes back. And the run reaches the
UI over the **global topic**, whose membership is already exactly the four low-volume lifecycle
kinds (`run.created`, `run.completed`, `run.aborted`, `human.requested`) that the run list and the
approval queue were designed around — so a live list costs one subscription and not a firehose.

**The silence itself is in scope.** A run that has been accepted and cannot move must say so.
F4.7's `run.stalled` already exists for _"surfaced, never auto-killed"_ and carries
`watermarkSeq`, `idleMs` and `runningNodes`; this story is where a run whose ledger has not advanced
and which has nothing in flight starts appending it.

**Acceptance criteria**

1. `POST /api/runs` writes a `node_wake` row for the framing step in the **same transaction** as
   `task.submitted`, before the 201 is returned. A `SIGKILL` between the response and the next tick
   loses neither: on restart the row is still there and framing still runs.
2. `boot()` performs `start-ticker` — the eighth of `RECOVERY_STEPS` — so the wake written by AC1 is
   consumed. `DeFlow status` reports the ticker as running, and `recovery.ts` no longer has a step
   its only caller declines to perform.
3. On a machine with a usable provider, `run.created` is appended within **2 s** of `task.submitted`
   for a task that needs no clarifying question, and the elapsed milliseconds between the two are
   derivable from the two events' own timestamps.
4. `GET /api/runs?status=&limit=&cursor=` exists, returns runs newest first with `{ runId, status,
   title, createdAt, headSeq, planVersion, cost }`, and includes a run whose ledger contains only
   `task.submitted` — a run that has been accepted but has not yet been framed is a run the operator
   must be able to see.
5. A `run.created` frame arrives on the `?runs=*` stream, and the web application's root route
   renders a run list fed from it: a run created while the page is open appears **without a
   refresh** and without a poll, and clicking it navigates to `/runs/<id>`.
6. `DeFlow run`'s attached view, `DeFlow status` and the UI's run list report the same status for
   the same run at the same head sequence. The status string is produced by one function in
   `@DeFlow/core` and rendered by three callers, not derived three times.
7. A run whose head sequence has not advanced for the configured stall window with nothing in
   flight appends `run.stalled` once — not once per tick — and the CLI prints one line naming the
   run, how long it has been idle, and `DeFlow status` as the next command. The run is not killed.
8. Two tasks submitted within the same millisecond each get their own `node_wake` row and each
   reaches `run.created`; neither wake is coalesced into the other and neither is dropped.

**Test plan (TDD)** — write these first, in this order, and watch each fail before writing the
implementation.

| #   | Level       | Test                                                                                                                                                                                     | Red when                                                                                                                                          |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | integration | `submitTask` against a file-backed ledger; assert a `node_wake` row for the framing node exists at the same `seq` boundary as `task.submitted`, by reading the DB after the call returns | The wake is written after the append, so a crash between them leaves the run parked exactly as `run_20260812T133934Z_468702` is               |
| 2   | integration | `boot()` over a temp data dir; assert the ticker handle is live and that a pre-seeded due `node_wake` row is consumed within two tick intervals of a `TestClock`                         | `boot()` still stops after `load-wakes`, so the row is read by nothing                                                                            |
| 3   | e2e         | Real daemon, mock agent on a temp `PATH`; `POST /api/runs`, then poll the ledger; assert `run.created` within 2 s and assert the run's event kinds in order                              | `runFramingInterview` has no caller, so the ledger holds one event forever — this is the regression test for the reported defect                   |
| 4   | integration | `GET /api/runs` after one submission and before framing; assert the run is listed with a status, and assert the shape against the schema `11 §6` documents                               | The route does not exist and the list 404s, or it filters out runs with no `RunState`, hiding exactly the run the operator is looking for          |
| 5   | web         | Mount the root route against a fake `runs=*` stream, push a `run.created` frame; assert a row appears with no refetch and that its link resolves to `/runs/<id>`                         | The root route renders `PlanGraphView` with no run and the frame changes nothing on screen                                                        |
| 6   | unit        | One `runStatusLabel(state)` over a table of reduced `RunState`s, asserted to be the only producer of the string the three surfaces print                                                 | The CLI says `created`, `status` says `awaiting-spec-approval` and the UI says `no plan yet` for the same run at the same seq                      |
| 7   | integration | `TestClock`-driven stall: advance past the window with an unadvanced head seq; assert exactly one `run.stalled`, then advance ten more windows and assert still exactly one              | The detector fires per tick and the operator gets a line per second                                                                               |
| 8   | integration | Two `submitTask` calls with the same injected `ts`; assert two distinct `node_wake` rows and two `run.created` events                                                                    | The wake key is `(runId, reason)` but the reason is a constant and the ids collide, so the second submission silently inherits the first's wake |

---

### KAR-19.2 — A run with no usable provider fails loudly instead of hanging

|                 |                                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                                                           |
| **Priority**    | P0                                                                                                                                                                                    |
| **Size**        | S                                                                                                                                                                                     |
| **Depends on**  | KAR-19.1 (there must be a hand-off to refuse), EPIC-05 KAR-05.2 (the capability probe and its persisted manifest) and KAR-05.3 (the registry's `bin` / `shim.bin` / `kind` fields), EPIC-18 KAR-18.4 and KAR-18.8 (`doctor`'s three provider states and the sentences this reuses verbatim) |
| **PRD**         | F1.1, F3.5, NF1, NF6, NF7, AR-1                                                                                                                                                       |
| **Verified by** | EPIC-19-S9, EPIC-19-S10, EPIC-19-S11, EPIC-19-S12, EPIC-19-S13, EPIC-19-S14, EPIC-19-S15                                                                                               |

**As** an operator whose machine is not fully set up, **I want** DeFlow to refuse the run in the
first second and tell me what to install, **so that** an environment problem costs me a sentence
rather than an afternoon of watching nothing happen.

This is the operator's actual situation, and it is the common one: `claude` was installed and
authenticated, `claude-agent-acp` was not, so `detectProviders` reported `adapter-missing` and
**no provider could serve the run**. The run was accepted anyway. That acceptance is the bug:
`boot-probe.ts` already states the intended contract — _"the daemon starts, reports what to install,
and refuses to **schedule** agent nodes later (NF7)"_ — and the refusal it promises is not
implemented anywhere, so "refuses to schedule" became "never schedules, and says nothing".

**Admission belongs at submission, not at the first agent node.** By the time a plan exists, minutes
of framing have already been spent and the operator has already been told the run started. The probe
result is in the ledger before the run is submitted (`provider.probed` is the only event two of the
three broken runs contain), so the question _"can anything here serve this run?"_ is answerable
before the 201.

**The words are already written.** KAR-18.8 settled that `claude is not installed` must never be
printed when `claude` resolves on `PATH`, and produced the three-state vocabulary and the install
sentence naming `@agentclientprotocol/claude-agent-acp`. This story renders **the same sentence from
the same function** — a second wording is a second thing to keep true.

**And the mock agent is a legitimate answer.** `DeFlow-mock-agent` ships in the same tarball and needs
no vendor CLI, no credential and no network; it is how a person evaluates DeFlow before installing
anything, and how every test in this repository runs. A refusal that does not mention it sends an
evaluator away at the first step.

**Acceptance criteria**

1. `POST /api/runs` performs admission before it returns: if no provider in the registry resolves to
   a spawnable adapter with the capabilities the framing step requires, the request is refused. The
   run still exists in the ledger — `task.submitted`, then `provider.probed` recording what was and
   was not found, then `run.aborted` with `outcome: 'failed'` — so the refusal is inspectable six
   weeks later (NF8) and reaches the `runs=*` topic like any other run ending.
2. The refusal carries a typed code and a rendered sentence: `{ code: 'no_usable_provider',
   providers: [{ id, state, vendorPath, adapterPackage }], message }`, exposed on the 4xx body, on
   `GET /api/runs/:id`, and on the `run.aborted` projection the UI reads.
3. `message` is produced by the **same renderer `doctor` uses** (KAR-18.8 AC1/AC2). With `claude` on
   `PATH` and no adapter, it names the vendor CLI's absolute resolved path, names
   `@agentclientprotocol/claude-agent-acp` as what is missing and the `npm install -g` command that
   installs it, and the string `claude is not installed` appears in no stream — stdout, stderr,
   `--json` or the HTTP body. A source guard asserts there is one renderer and this story added no
   second one.
4. The message ends with the mock-agent sentence: that `DeFlow-mock-agent` ships in this package and
   a run against it needs no vendor CLI, no credential and no network — with the exact flag to use.
5. `DeFlow run` exits **5** on this refusal — `environmentUnusable`, already in `RUN_EXIT_CODES` and
   already documented as _"this machine cannot host a run"_. Not 1, not 2. The exit-code table gains
   no eighth member.
6. A machine with at least one usable provider is **never** refused: the admission check is a
   function of the probed manifest, and a green machine's submission path appends no
   `run.aborted` and pays no extra provider handshake at submission time.
7. A provider that resolves and then fails its handshake at submission — a bridge that is installed
   but broken — is refused with the same shape and a different code (`provider_handshake_failed`),
   carrying the child's own stderr trimmed but not paraphrased. It is never reported as
   `not installed`.
8. The refusal is terminal: the run reaches a terminal state immediately, the CLI's attached view
   stops rather than waiting, the SSE subscription for that run closes cleanly, and the UI shows the
   run as ended with the reason — not as _"created — no nodes yet"_.
9. AR-1 holds through the whole path: admission reads no credential file, captures no auth
   subcommand's output, and forwards no `*_TOKEN` or `*_API_KEY` variable into any child.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                          | Red when                                                                                                          |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | unit        | The admission reducer over a table of probed manifests → `admitted` / `no_usable_provider` / `provider_handshake_failed`, with the rendered sentence per row  | Admission is inferred from "is any binary on `PATH`", so a vendor CLI with no bridge is admitted — the reported bug |
| 2   | integration | `POST /api/runs` with a fake `claude` shim on a temp `PATH` and no `claude-agent-acp`; assert the three-event ledger and the 4xx body's typed code            | The run is accepted, one event lands, and the request looks successful                                             |
| 3   | unit        | A wording guard: the refusal string and `doctor`'s Agents string for the same machine state are produced by one function and are byte-identical               | Someone writes a second, friendlier sentence here and the two drift within a month                                 |
| 4   | unit        | Assert the rendered message contains the mock-agent sentence and the exact flag, for every refusal code                                                        | The hint is attached only to the zero-providers case, so the common `adapter-missing` operator is sent to npm      |
| 5   | e2e         | Real daemon, empty temp `PATH`, `DeFlow run "…"`; assert exit **5**, the sentence on stderr, and `run.aborted` in the on-disk ledger                          | The CLI exits 1 because it classified a failed run rather than an unusable machine                                 |
| 6   | integration | The same, with the mock agent linked onto the `PATH`; assert no `run.aborted`, and assert the submission spawned no additional handshake child                | Admission re-probes on every submission and every run pays a second's provider handshake                           |
| 7   | integration | A shim that resolves and exits non-zero on `initialize`; assert `provider_handshake_failed`, the child's stderr present, and that `not installed` is absent   | A broken bridge reduces to the absent case and the operator uninstalls a working CLI                               |
| 8   | integration | Refuse a run with an SSE client attached; assert the client receives the ending frame and the connection closes, with no keepalive-only tail                  | The stream stays open on a run that will never emit again, so the UI spins forever                                 |
| 9   | unit        | An AR-1 guard over the admission module's import graph and source: no read of `~/.claude`, `~/.codex`, `~/.config/gcloud`, no `*_TOKEN` / `*_API_KEY` read    | An "is it authenticated?" convenience check is added to make the message friendlier                                |

> **Amended 2026-08-13 by [KAR-19.10](#kar-1910--provider-selection-is-explicit-and-honest-about-what-it-picked-added).**
> AC1's *"resolves to a spawnable adapter with the capabilities the framing step requires"* becomes
> **route-aware**. A vendor CLI with no ACP bridge is not unusable: it is usable on the exec-shim
> route — which is the route every schema-bearing pre-execution turn actually takes — and unusable on
> the ACP route that agent-node execution needs. Admission therefore admits per route and states
> which, rather than answering one word per provider. The refusal shape, the typed codes, the shared
> renderer and exit `5` are all unchanged; what changes is which machines reach them. The reasoning
> is in KAR-19.10 and is not restated here.

---

### KAR-19.3 — Framing to recon to plan, on the live path

|                 |                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                                                         |
| **Priority**    | P0                                                                                                                                                                                  |
| **Size**        | L                                                                                                                                                                                   |
| **Depends on**  | KAR-19.1, KAR-19.2, EPIC-10 KAR-10.2 (`runFramingInterview`), KAR-10.3 (the F1.3 spec gate), KAR-10.4 (spec pinning), KAR-10.5 (recon), EPIC-11 KAR-11.1 (`compilePlanV1`) and KAR-11.2 (validation), EPIC-09 KAR-09.2 (packet assembly), EPIC-13 KAR-13.1 (blocking human nodes), EPIC-06 KAR-06.1 (`decide()`) |
| **PRD**         | F1.2, F1.3, F2.2, F2.3, F6.1, F10.1, NF4, NF10                                                                                                                                      |
| **Verified by** | EPIC-19-S16, EPIC-19-S17, EPIC-19-S18, EPIC-19-S19, EPIC-19-S20, EPIC-19-S21, EPIC-19-S22, EPIC-19-S23                                                                               |

**As** an operator who has approved a spec, **I want** the run to frame itself, survey the
repository and compile a plan, **so that** the graph the whole product is built around actually
appears — drawn as it is built rather than after the fact.

Every step in this chain exists and is tested. `runFramingInterview` assembles a
`DeFlow.taskspecdraft.v1` return through EPIC-09's handoff contract, seals a `TaskSpec`, and
appends `run.created` plus the F1.3 gate in one transaction. `compilePlanV1` turns spec, recon and
the probed capability list into `PlanGraph` v1. Recon, pinning and validation each have their own
story and their own suite. **None of them is called by anything that ships.** This story is the
scheduling and the calls between them, and its hardest constraint is negative: **write no second
implementation of any step.** A parallel "simple planner" written to get a demo moving is how a
codebase acquires two answers to the same question, and the guard in AC7 exists because the
temptation is real and arrives at about hour three.

The one genuinely new decision is what happens when a step needs a human. Framing may return a
clarifying question, and the spec gate always requires an approval. Neither may block a worker:
[EPIC-13](./EPIC-13-human-in-the-loop.md) already built the answer — a `human` node suspends onto a
`node_wake` row, at the cost of one SQLite row and no held process, and survives restart and laptop
sleep. This story uses that path and adds no waiting of its own. `runFramingInterview` already
writes the `human.requested` and its wake in one transaction; what is missing is the caller that
resumes when the answer arrives.

**Acceptance criteria**

1. A framing wake consumed by the ticker calls `runFramingInterview` with a packet assembled by
   EPIC-09's `renderPacket` over the intake event, against a session opened on the provider
   admission chose — and appends `run.created` on success, exactly as that function already does.
2. On `run.spec.approved`, the run continues without a further operator action: the spec is pinned
   (`spec.pinned`), recon runs and records its facts with provenance, `compilePlanV1` is called with
   spec + recon + the probed capability manifest, and `plan.proposed` is appended. Each step appends
   its own events as it completes; nothing is batched to the end.
3. No plan is compiled before approval. A run sitting at the F1.3 gate has `run.created` and
   `human.requested` and **no** `plan.proposed`, however long it sits, and `compilePlanV1` is not
   called even speculatively.
4. Framing that returns a clarifying question **suspends**: `human.requested` and a `node_wake` row
   in one transaction, no process held, no timer. The answer arriving over
   `POST /runs/:id/nodes/:nodeId/respond` consumes the wake and resumes the interview in the same
   transaction as `human.responded`, and the run proceeds to `run.created`.
5. Plan validation failing appends `plan.validation_failed` and `run.needs_human` with reason
   `plan-invalid`, naming the uncovered acceptance criterion or the unsupported capability. **No
   token is spent on execution**: no `node.started` follows, and the run is a decision for the
   operator rather than a failure.
6. The graph is visible while it is being built: `plan.proposed` reaches the subscribed UI, and the
   plan graph renders from the first plan version rather than waiting for the first node result.
   The root list's status for the run moves through the same steps in the same order.
7. **One implementation per step.** A source guard asserts that exactly one shipped module calls
   each of `runFramingInterview`, `compilePlanV1` and `validatePlan`, that no module under
   `packages/*/src` other than the owning package defines a function producing a `PlanGraph`, and
   that the caller added here imports from `@DeFlow/daemon`'s existing exports rather than copying.
8. A `SIGKILL` between `spec.pinned` and `plan.proposed` resumes without re-framing: on restart the
   run picks up from the pinned spec, the framing agent is not invoked a second time, and the same
   `specHash` is carried forward.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                                                     | Red when                                                                                                                       |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | e2e         | Real daemon + mock agent scripted to return a valid draft; submit, approve at the gate, assert the ledger's kind sequence `task.submitted → provider.probed → run.created → run.spec.approved → spec.pinned → plan.proposed` | Nothing calls the framing interview, so the sequence stops at event one                                                        |
| 2   | integration | Approve the spec, then assert `compilePlanV1` was reached with a recon input containing at least one fact with provenance                                                                | The planner is called with the spec alone because recon has no caller either, and the plan is generic                          |
| 3   | integration | Submit and never approve; advance a `TestClock` by an hour; assert no `plan.proposed` and no agent child was spawned                                                                     | Compilation is kicked off optimistically alongside the gate and the operator's rejection arrives after the spend               |
| 4   | integration | Mock agent scripted to ask a clarifying question; assert `human.requested` + one `node_wake` in one transaction, that no promise is held across the suspension, and that answering resumes to `run.created` | The interview awaits an in-memory deferred, so a daemon restart loses the question and the run never returns                   |
| 5   | integration | A spec whose criteria no gate covers; assert `plan.validation_failed`, `run.needs_human` with `plan-invalid`, the named criterion, and zero `node.started`                               | Validation runs after the first node starts, so the invalid plan has already cost money                                        |
| 6   | web         | Push `plan.proposed` into the store over a fake stream; assert the graph renders nodes before any `node.started` arrives                                                                 | The view waits for a node result to draw, so a compiled plan still reads as "No plan yet"                                      |
| 7   | unit        | A source guard over `packages/*/src`: exactly one shipped caller each for `runFramingInterview`, `compilePlanV1`, `validatePlan`; no second `PlanGraph` producer                         | A "temporary" inline planner is added to get a run moving and is still there at M1                                             |
| 8   | integration | File-backed ledger; close the DB after `spec.pinned`, reopen with a fresh engine; assert resume compiles the plan, invokes no framing turn, and carries the same `specHash`             | Resume replays from `task.submitted` and re-frames, producing a second spec and a `specHash` nothing downstream agrees with    |

> **Amended 2026-08-13 while implementing KAR-19.3.** The chain shipped:
> `packages/daemon/src/pipeline/run-chain.ts` is the one production caller of
> `runFramingInterview`, `runReconNode` and `compilePlanV1`, the driver dispatches both halves off
> the ticker, and AC1–AC8 are asserted at the levels above — with **two departures recorded here
> rather than absorbed** ([README §9](../README.md#9-changing-the-plan)):
>
> - **Test plan #1 was automated at `integration`, not `e2e`, and its `provider.probed` clause was
>   dropped.** Both changes follow from what shipped rather than from convenience. The framing,
>   recon and planner turns all carry a `returns` contract, so `admitFraming` (KAR-10.2 AC3) refuses
>   every adapter without a `structuredOutputFlag` — today that is every adapter except `claude`'s
>   **exec-shim** path, and the bundled `DeFlow-mock-agent` speaks ACP only. There is therefore no
>   agent on this machine that can serve a framing turn, so an e2e against a real binary cannot yet
>   exist, and a fake vendor binary at e2e would assert nothing the integration spec does not. And
>   `provider.probed` is written by intake **only on a refusal** (KAR-19.2's shipped shape), so an
>   admitted run's ledger does not contain one; the sequence asserted is
>   `task.submitted → run.created → run.spec.approved → spec.pinned → plan.proposed`, by `seq`.
> - **The chain is not yet bound in `DeFlow up`.** `boot()` takes `runFraming` and `advanceRun` as
>   ports and `@DeFlow/daemon` exports `createRunChain`; what is missing between them is a
>   `FramingAgent`/`ReconAgent`/`PlannerAgent` over a real vendor process, which for the reason above
>   cannot be exercised against anything installable today. Building it unexercised would be the
>   defect this epic exists to remove, one level up, so it is **not** done here.
>
> Both point at the same prerequisite: **a structured-output path for the bundled mock agent**
> (an exec-shim mode, or an ACP-native return), which is [EPIC-04](./EPIC-04-mock-agent.md)'s
> mechanism and this epic's Out-of-scope rule sends there. It blocks the e2e half of this story,
> KAR-19.4's binding, KAR-19.5's `pnpm test:smoke` and the epic's own manual acceptance test —
> *"in a scratch repository, with only the bundled mock agent, `DeFlow run --file <path>` produces
> a plan and executes nodes"* — so it is the next thing to build, before KAR-19.4.
>
> **Resolved as a plan change on 2026-08-13:** that prerequisite is now
> [KAR-19.7](#kar-197--the-mock-agent-can-serve-a-framing-turn-so-a-run-works-with-no-vendor-cli-added),
> authored in this epic rather than in EPIC-04, with the Out-of-scope override recorded in the Scope
> section. This departure closes when KAR-19.7 is Done and test plan #1 is re-automated at `e2e`.
>
> **Narrowed on 2026-08-13:** KAR-19.7 shipped. `DeFlow-mock-agent` takes a schema and returns a
> document that validates against it, `PROVIDER_SPECS` has a `mock` entry whose declaration is true,
> and `admitFraming` admits a framing node routed there — so *"no agent on this machine can serve a
> framing turn"* is no longer the case, and the reason this departure gave for existing is spent.
> What is left of it is the second bullet alone, and it is now **unbuilt** rather than
> **unexercisable**: the `FramingAgent`/`ReconAgent`/`PlannerAgent` over a real process, and the
> `DeFlow up` binding that hands them to `createRunChain`. Test plan #1 moves to `e2e` in the same
> change.
>
> **Closed on 2026-08-13.** Both departures are spent, and the binding they were about now ships:
>
> - `packages/daemon/src/pipeline/live-agents.ts` implements the three ports over a real process,
>   through `PROVIDER_SPECS`'s own exec-shim argv builder — so the schema flag the registry declares
>   is the flag the child actually gets. Both dialects are exercised against real binaries
>   (`packages/daemon/test/integration/live-agents.test.ts`): `document` against the bundled agent,
>   `stream-json` against the testkit's fake vendor CLI.
> - `packages/daemon/src/pipeline/live-chain.ts` is the resolver, and **`packages/cli/src/up.ts` and
>   `packages/daemon/src/main.ts` now pass `runFraming` and `advanceRun` to `boot()`.** That is the
>   line whose absence was the whole 2026-08-12 failure. The provider is the one
>   `usableProviders` already chose, its capability row is read from the probed table and nowhere
>   else, the run's contracts are written with `writeRunSchemas` (which had no production caller
>   either), and the child's environment is `buildChildEnv()`'s.
> - **Test plan #1 is automated at `e2e`** — `e2e/live-chain.test.ts`, a real `DeFlow run --file` on
>   a `PATH` holding only `DeFlow-mock-agent`, approved over the daemon's own HTTP route, asserting
>   `task.submitted → run.created → run.spec.approved → spec.pinned → plan.proposed` by `seq`. The
>   `provider.probed` clause stays dropped, for the reason recorded above: intake writes that row
>   only on a refusal. EPIC-19-S16's flow line already declared `e2e` and is now true.
> - **One defect in KAR-19.7's own output had to be fixed to get here**, recorded rather than
>   absorbed: its default `PlanGraph` carried `provider.prefer: []` on both agent nodes, and
>   `validatePlanVersion` reads an empty list as *a preference nothing satisfies* — every compile
>   against the bundled agent ended in two `plan.validation_failed` rows and `run.needs_human`. The
>   generator now names `mock`, which is not the routing hazard KAR-19.7 AC8 is about: that hazard
>   is a default plan naming a **vendor CLI the machine may not have**, and this binary ships in
>   DeFlow's own tarball.
>
> **`executeNodes` was still unbound when this was written; it is bound now** —
> [KAR-19.5](#kar-195--a-live-smoke-test-that-would-have-caught-this) supplied
> `packages/daemon/src/pipeline/live-nodes.ts` to both composition roots, so a run no longer stops
> at `plan.proposed`. What follows is the record of the state this story left behind. Performed by hand on 2026-08-13 against the
> packed `packages/cli/dist/bin.mjs`, in a scratch git repository with only the bundled agent on
> `PATH`: `DeFlow run --file task.md` printed `task submitted`, `run created` and the spec at the
> F1.3 gate, and after the approval the ledger held
> `run.spec.approved → spec.pinned → workspace.worktree_created → 4 × fact.written →
> workspace.worktree_removed → plan.proposed` with a three-node plan. Two gaps that run exposed and
> that belong to the stories after this one: the attached `DeFlow run` renderer has no case for
> `plan.proposed`, so a compiled plan is silent on the terminal (KAR-18.3's renderer, KAR-19.4's
> DoD), and the bundled agent still serves no `DeFlow.finding.v1`, so a node run against it would
> fail its handoff.

---

### KAR-19.4 — Nodes actually execute, and their output streams to both surfaces

|                 |                                                                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                                                           |
| **Priority**    | P0                                                                                                                                                                                     |
| **Size**        | L                                                                                                                                                                                     |
| **Depends on**  | KAR-19.3, EPIC-06 KAR-06.1–KAR-06.5 and KAR-06.9 (`executeRun`, the effect journal, retry, recovery), EPIC-03 KAR-03.4 (the `io_chunk` stream), EPIC-15 KAR-15.3 (SSE) and KAR-15.6 (the io tail), EPIC-17 KAR-17.1 and KAR-17.5 (the graph and the output view), EPIC-18 KAR-18.3 (the terminal renderer and exit codes), EPIC-12 KAR-12.1 (gates), EPIC-14 KAR-14.1 (cost accounting) |
| **PRD**         | F4.2, F4.4, F4.6, F5.7, F7.1, F9.1, F9.2, F10.1, F10.6, F10.9, NF10                                                                                                                   |
| **Verified by** | EPIC-19-S24, EPIC-19-S25, EPIC-19-S26, EPIC-19-S27, EPIC-19-S28, EPIC-19-S29, EPIC-19-S30, EPIC-19-S31, EPIC-19-S32                                                                    |

**As** an operator watching a run, **I want** the plan's nodes to actually run and to see what the
agent is producing while it produces it, **so that** DeFlow is a tool I can supervise rather than a
process I have to trust and then inspect.

`executeRun` is a complete, tested loop — it folds the ledger, calls `decide()`, admits attempts,
tracks what is in flight so one node is never started twice, and terminates on a real condition
rather than a tick count. Its only callers are `packages/daemon/test/support/run-loop.ts` and two
fixture-building scripts. This story gives it a shipped caller, driven by the ticker that KAR-19.1
started, over the plan KAR-19.3 compiled.

**The second half is the one the operator actually noticed.** They saw no output in either surface.
The `io_chunk` data plane exists and is deliberately separate from the control-plane `event` table
(KAR-03.4) precisely so that a chatty agent does not drown the ledger; `GET /runs/:id/nodes/:nodeId/io`
serves its tail and the SSE stream carries the control events. Both surfaces already know how to
render this — EPIC-17's node output view and EPIC-18's terminal renderer — and neither has ever been
handed a live byte. **This story is where output is produced, not where it is displayed**, and the
assertion is that it arrives _during_ the node, not in a burst at the end.

**And the run must end, saying which end it reached.** Three terminal shapes exist and each has a
different operator action: `completed` (read the diff), `failed` (read the reason), `paused` (make a
decision — a budget ceiling under F4.6/F9.2 pauses rather than fails, and a human gate waits). A
fourth shape — stopping without a statement — is what happened on 2026-08-12 and is what this story
removes.

**Acceptance criteria**

1. When a plan exists and is valid, the ticker drives `executeRun` over it: nodes reach
   `node.scheduled` → `node.started` → `node.completed`, ready-set order is `decide()`'s, and the
   concurrency ceiling is the one KAR-06.2 already enforces. No node is started twice, including
   across a tick that arrives before the performer's own `node.started` lands.
2. The run reaches exactly one terminal state and appends it: `run.completed`, `run.aborted`, or a
   halt at `paused` / `needs-human` with the reason. Every path out of the executor ends in a
   statement; there is no path that stops and appends nothing.
3. Agent output reaches the terminal **while the node runs**: `DeFlow run` prints chunks as they
   arrive, and a test that scripts the mock agent to emit, pause, then emit again observes the first
   chunk before the second is produced. `--json` emits the same content as NDJSON with no ANSI.
4. The same output reaches the web UI: `io_chunk` rows are tailable through
   `GET /runs/:id/nodes/:nodeId/io`, the node output view renders them incrementally, and a
   reconnect mid-node backfills from `fromSeq` with no gap and no duplicate.
5. Node state transitions, accumulating cost and gate verdicts arrive as they happen. A run's cost
   after node 2 of 4 is non-zero and less than its final cost; `run.completed` is not the first
   frame that carries a number.
6. A failing deterministic gate appends its verdict as it resolves, the verdict is visible in both
   surfaces before the run ends, and the run reaches a terminal state whose classification maps to
   `DeFlow run` exit **1** through the single `classifyRun` — with no second derivation of the code.
7. A node that fails permanently ends the run with the failure's own typed reason from the closed
   taxonomy (KAR-02.10), named in the terminal line and in the UI. A run never ends with an empty
   reason string.
8. A budget ceiling breach pauses the run (F4.6) rather than failing it: `run.needs_human` with
   reason `budget`, `DeFlow run` exits **3**, and the run is resumable — the ceiling is a decision,
   not an outcome.
9. A `SIGKILL` mid-node is resumable: on restart, completed nodes are not re-executed, the
   interrupted attempt is reconciled through the effect journal, and the run reaches the same
   terminal state it would have reached uninterrupted. The kill-verification assertion excludes
   `Z`-state processes.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                                            | Red when                                                                                                                    |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | e2e         | A four-node mock plan driven end to end through a real daemon; assert `run.completed`, one `node.completed` per node, and the transcript against a normalised file snapshot     | `executeRun` has no shipped caller, so the plan is compiled and then nothing happens — the completion half EPIC-18 deferred |
| 2   | integration | Mock agent scripted to emit, wait on a gate the test controls, then emit; assert the first chunk is observed on the CLI's stdout before the second is produced                  | Output is buffered and flushed at `node.completed`, so a ten-minute node shows nothing for ten minutes                      |
| 3   | web         | Feed `io_chunk` frames into the node output view over a fake stream; assert incremental render and a `fromSeq` backfill after a forced reconnect with an exactly-equal chunk set | The view re-fetches from zero on reconnect and duplicates every line already on screen                                      |
| 4   | integration | Read `GET /runs/:id` at node 2 of 4; assert cost > 0 and < final, and that node states differ from each other                                                                   | Cost is projected only from a run-ending event, so the live figure the whole cost view exists for is always zero            |
| 5   | integration | A scripted failing gate; assert the verdict event precedes the terminal event, and assert exit 1 through `classifyRun` and nowhere else                                         | The exit code is re-derived in the run command and disagrees with `classifyRun` on a gate failure                           |
| 6   | integration | A node failing with a permanent classified error; assert the terminal line contains the taxonomy reason and is not empty                                                        | The reason is read off a field the failure path never sets, and the operator gets `run failed: undefined`                   |
| 7   | integration | `TestClock` + a ceiling set below the scripted spend; assert `run.needs_human` reason `budget`, exit 3, and that resuming continues rather than restarting                      | The ceiling is treated as a failure, so a pause becomes an abort and the work is lost                                       |
| 8   | e2e         | `SIGKILL` the daemon mid-node, restart over the same data dir; assert no effect ran twice, the same terminal state, and no non-`Z` process left in the group                    | The kill check counts zombie grandchildren and reports a false negative                                                     |
| 9   | unit        | `decide()` + the admitted-set over a fold where a node is ready and its `node.started` has not landed; assert one attempt                                                       | The shipped caller re-implements admission instead of using the executor's, and one node runs twice                         |

> **Amended 2026-08-13 while implementing KAR-19.4.** The executor shipped:
> `packages/daemon/src/pipeline/run-execution.ts` is the one production caller of
> `executeRun`, the driver dispatches it off the ticker, and `DeFlow run` follows the `io_chunk`
> data plane alongside the control stream so the agent's own bytes reach the terminal while its
> node is still running. AC1–AC8 are asserted at the levels below — with **three departures
> recorded here rather than absorbed** ([README §9](../README.md#9-changing-the-plan)):
>
> - **Test plan #1 and #8 were automated at `integration`, not `e2e`.** The same prerequisite
>   KAR-19.3 recorded: the framing, recon and planner turns all carry a `returns` contract, so
>   `admitFraming` refuses every adapter without a `structuredOutputFlag`, and the bundled
>   `DeFlow-mock-agent` speaks ACP only. There is therefore no agent on this machine that can
>   carry a run as far as a compiled plan through a real binary, so an e2e that started at
>   `DeFlow run` and ended at an executed node cannot yet exist. What shipped instead:
>   `packages/daemon/test/integration/live-execution.test.ts` drives the **whole** chain —
>   `submitTask` → framing → the F1.3 gate → recon → `compilePlanV1` → `executeRun` — over a real
>   file-backed ledger with scripted agent *ports*, and `packages/cli/test/integration/`
>   `run-output-live.test.ts` spawns the real CLI binary against a real daemon over a real socket
>   for the streaming half. The transcript **file snapshot** in #1 is not written, because the
>   transcript it would pin is a rendering of scripted output rather than of a real turn.
> - **#8's process-group clause is not asserted, and the `SIGKILL` is a second daemon life rather
>   than a signal.** EPIC-19-S32's *"no process remains in the killed daemon's group, excluding
>   entries in state `Z`"* is a claim about real grandchildren, and this story's performer spawns
>   none — asserting it here would be asserting that zero processes are zero processes.
>   `packages/daemon/test/crash-fuzz/` already holds that assertion against a real agent binary
>   (KAR-06.9). What is asserted is the half this story newly owns: the ledger is closed and
>   reopened at a higher epoch, a driver that inherited nothing picks the run up, no completed node
>   is executed a second time, and the run reaches the terminal state it would have reached
>   uninterrupted.
> - **`executeNodes` is not yet bound in `DeFlow up`,** for the same reason `runFraming` and
>   `advanceRun` are not (KAR-19.3's amendment): a daemon whose chain cannot reach a plan has
>   nothing for an executor to execute, so binding one alone would be unexercised wiring — the
>   defect this epic exists to remove, one level up. The prerequisite is
>   [KAR-19.7](#kar-197--the-mock-agent-can-serve-a-framing-turn-so-a-run-works-with-no-vendor-cli-added),
>   added 2026-08-13; this departure and the two above close when it is Done.
>
>   **Narrowed on 2026-08-13:** KAR-19.7 shipped, so the bundled agent can serve every
>   schema-bearing turn the chain needs and a run on a `PATH` with no vendor CLI is admitted. The
>   binding is now merely unbuilt: `executeNodes`, `runFraming` and `advanceRun` are still
>   unsupplied in `DeFlow up`, and #1 and #8's `e2e` halves move up when they are supplied.
>
>   **Closed 2026-08-13 by [KAR-19.5](#kar-195--a-live-smoke-test-that-would-have-caught-this),
>   with one of the two rows re-levelled and the other left where it is** — re-verified honestly
>   rather than declared closed:
>
>   - **Test plan #1 is now at `e2e`.** `packages/daemon/src/pipeline/live-nodes.ts` is the missing
>     `NodePerformer`, both composition roots bind `executeNodes`, and
>     `e2e/smoke/live-run.test.ts` drives a real `DeFlow run --file` against the built binary
>     through `node.started`, `node.completed` and `run.completed` with exit 0. AC1 and AC8's
>     binding clause are satisfied by a shipped path rather than by a spec's own wiring. Three of
>     this story's own claims turned out to be false in production and are listed in KAR-19.5's
>     amendment — an unreadable `node.started`, an uncomposable node branch, and an unwired scope
>     auditor — none of which the integration specs could see, which is the argument for the level
>     change stated as evidence.
>   - **Test plan #8 stays at `integration`, and the reason is unchanged.** The clause that made it
>     e2e is *"no non-`Z` process left in the killed daemon's group"*, and that is a claim about
>     real grandchildren. This story's performer spawns an agent per node now, so the claim is at
>     last *meaningful* — but nothing asserts it, and moving the row without writing the assertion
>     would be exactly the bookkeeping this epic exists to stop. `EPIC-19-S32`'s flow line has been
>     corrected to `integration` to match. **Raising it is a real follow-up, not a formality.**
>
> One thing shipped that no criterion asked for, and it is the kind of thing that is cheaper to
> record than to rediscover. **The execution turn is launched by the tick, never awaited by it.**
> `startTicker` schedules the next tick only once the current one has settled, so a driver that
> waited for `executeRun` would freeze the whole daemon for the length of a node — no framing wake
> dispatched, no stall reported, and KAR-19.6's cancel never carried out — on a run that can
> legitimately take hours. What stops a second turn is the driver's `executing` set; what stops a
> second *attempt* is the executor's own `admitted` set one level down. The cost is that a turn
> outlives the tick, so `RunDriver.settle()` exists and `boot()`'s `shutdown()` waits on it before
> closing the ledger — otherwise a daemon stopped mid-node would pull the connection out from
> under a node that was part-way through appending its own completion.
>
> One deferral marker was **removed early**: `test/run-completion-deferral.test.ts` held while
> *"nothing shipped drives a submitted run"*, and its own instructions say the day a shipped source
> executes one, the record has outlived its reason. It went red on this story and was deleted
> rather than relaxed; the stronger claim took its place in `test/one-live-chain-caller.test.ts`
> (exactly one shipped caller of `executeRun`, which may not re-implement admission) and in
> `test/one-run-verdict.test.ts` (AC6's single derivation). That is the first of
> [KAR-19.5](#kar-195--a-live-smoke-test-that-would-have-caught-this) AC8's three markers; the
> other two are notes whose premise — no agent can serve a schema-bearing turn — is still true, and
> they were **narrowed** rather than deleted.

---

### KAR-19.5 — A live smoke test that would have caught this

|                 |                                                                                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Done                                                                                                                                                     |
| **Priority**    | P0                                                                                                                                                       |
| **Size**        | M                                                                                                                                                        |
| **Depends on**  | KAR-19.1, KAR-19.2, KAR-19.3, KAR-19.4 (it asserts all four), EPIC-04 (the mock agent binary it runs against), EPIC-01 KAR-01.4 (the test runner's project slices), EPIC-18 KAR-18.5 (the built binary it invokes) |
| **PRD**         | F3.7, F4.2, NF1, NF6, NF9, and the DoD in [README §5](../README.md#5-definition-of-done)                                                                  |
| **Verified by** | EPIC-19-S33, EPIC-19-S34, EPIC-19-S35, EPIC-19-S36                                                                                                       |

**As** the person who will break this again, **I want** one test that drives an operator's real
command all the way to a node executing, **so that** a disconnected link fails a test run instead of
an afternoon.

**This is the story the epic is really about.** Ten thousand tests were green on 2026-08-12 and the
product did nothing, and the reason is structural rather than careless: the e2e level runs against
**recorded fixtures through the replay harness**, and a fixture is a ledger that already contains
everything the missing code was supposed to append. Replaying it proves the projections are correct
and proves nothing about who produces the events. Every epic verified its own half of every seam,
and every seam belonged to nobody.

The missing property has a name: **no test started at the operator's command and ended at an
executed node, through processes rather than function calls.** So the smoke test is defined by what
it refuses to substitute — the real CLI binary, a real daemon in its own process, a real SQLite file
on disk, real event frames over a real socket. The only substitution is the agent, and it is
`DeFlow-mock-agent`, which is a real executable on `PATH` speaking real ACP over a real subprocess
([14 §3](../../14-testing-strategy.md): fake binaries, not mocked modules) and needs no vendor CLI,
no credential and no network.

**A test that cannot go red is worse than no test**, which is why AC4 is a sabotage table rather
than a sentence of intent: each link in the chain is cut in turn, and the smoke test must fail for
each cut, naming the link. That table is the executable form of the property this epic is buying.

**It has to be fast enough to belong in `pnpm test`.** A smoke test that lives behind a flag is a
smoke test nobody runs, and this failure mode is precisely the one that survives in the gap between
"we should run that" and "we ran it". The budget is stated and asserted.

**Acceptance criteria**

1. `pnpm test:smoke` runs one scenario end to end with no fixture, no recording and no replay: it
   builds or resolves the real `DeFlow` binary, runs `init` and then `run --file <spec>` in an
   `fs.mkdtemp` git repository, against a daemon the CLI itself starts, with `DeFlow-mock-agent`
   symlinked onto a temp `PATH` as the only provider.
2. It asserts the whole chain from the on-disk ledger and from the command's own output, not from
   internal state: the event kinds appear in order (`task.submitted` → `run.created` →
   `plan.proposed` → `node.started` → `node.completed` → a terminal `run.*`), the compiled plan has
   at least two nodes, at least one node executed, agent output appeared on the CLI's stdout while
   the run was in flight, and the process exit code is the one `classifyRun` prescribes.
3. It needs no vendor CLI, no credential and no network: the child environment carries no
   `*_API_KEY` / `*_TOKEN` variable, `XDG_DATA_HOME` points inside the tmpdir so it never touches
   `~/.DeFlow`, `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` are `/dev/null` with a forced identity,
   and the assertion that no outbound socket was opened is a test rather than a claim.
4. A sabotage table proves it can go red. Each row removes exactly one link — intake's framing wake,
   the ticker start, the framing→`run.created` call, the approval→`compilePlanV1` call, the
   plan→`executeRun` call, the `io_chunk` producer — and the smoke test must fail for every row,
   with a message naming the link that is missing. A row that still passes is a hole in the smoke
   test and fails this story.
5. It is wired into the repository's normal test run — `pnpm test` includes it, and CI runs it on
   `ubuntu-26.04` and `macos-26`, Node 24 and 26 — as its own vitest project slice with
   `fileParallelism: false`, because it binds a port and owns a data directory.
6. It completes within **90 s** on the author's machine and the budget is asserted by the test's own
   timeout, so a regression in cold start or scheduling latency is a failure rather than a slow
   afternoon. If it cannot be made to fit, the plan is changed in writing rather than the test moved
   behind a flag.
7. It preserves its temp directory under `DeFlow_KEEP_TMP=1` and uploads it as a CI artifact on
   failure, so the ledger of a failed smoke run can be opened with plain `sqlite3` — the same
   diagnostic route KAR-18.7 established.
8. The three deferral markers this epic closes are removed as part of this story:
   `test/run-completion-deferral.test.ts`, the deferral note in
   `packages/cli/test/integration/support/run-fixture.ts`, and the corresponding note in
   `e2e/run.test.ts`. They are deleted, not inverted.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                                       | Red when                                                                                                             |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | e2e         | The smoke scenario itself: real binary, real daemon, real ledger, mock agent; assert the ordered kind sequence, ≥ 2 plan nodes, ≥ 1 executed node, live stdout, exit code | Written first, it fails for the actual reason — the chain is disconnected — and that failure is the epic's definition |
| 2   | e2e         | The sabotage table as a `Scenario Outline`: one row per cut link, each asserting the smoke test fails **and** naming the link                                              | A cut link still passes because the assertion reads a projection that a fixture also satisfies                        |
| 3   | integration | Inspect the smoke harness's child environment and `PATH`; assert no credential variable, `XDG_DATA_HOME` inside the tmpdir, and the mock agent as the only provider        | The harness inherits the developer's environment and passes on their laptop only                                     |
| 4   | integration | Parse `vitest.config.ts` and `package.json`; assert the smoke project exists, is included by `pnpm test`, is serialised, and declares a timeout at the stated budget       | The slice is added but excluded from the default run, so the test exists and never executes                          |
| 5   | integration | A guard asserting the three deferral markers no longer exist in the tree                                                                                                   | The deferral note survives its own resolution and the next reader believes completion is still impossible            |

> **Implemented 2026-08-13.** `pnpm test:smoke` exists, is the `smoke` vitest project over
> `e2e/smoke/`, is collected by a bare `pnpm test`, and runs the built `packages/cli/dist/bin.mjs` —
> `DeFlow init` then `DeFlow run --file spec.md` — in an `fs.mkdtemp` git repository against a
> `PATH` holding `DeFlow-mock-agent` and nothing else. It reaches `run.completed` and exit 0 in
> **≈8 s** against the 90 s budget. All six AC4 rows are red when their link is cut, and each names
> it. The three AC8 markers are gone and a guard holds them gone.
>
> **The story could not be written without finishing KAR-19.4's binding, so that is part of it.**
> `executeNodes` was still unsupplied in both composition roots; `packages/daemon/src/pipeline/`
> `live-nodes.ts` is the missing `RunExecutionResolver` — `byNodeType` over an agent performer that
> provisions the node's own worktree, builds the packet with `buildPacket` and drives a real ACP
> process through `runAcpNode`, and `gateNodePerformer` over gates discovered from the repository's
> own `.DeFlow/gates` — and `packages/cli/src/up.ts` and `packages/daemon/src/main.ts` now pass it
> to `boot()`. `RunExecutionResolver` gained `epoch` and `daemonStartedAt`, because a production
> resolver builds the effect journal's runner and one stamped with a previous daemon life's epoch
> journals this life's effects under the last one's.
>
> **Four defects the smoke test found on its first green chain**, none of which any existing test
> could see, and all four fixed here:
>
> - **`node.started` with an empty `binary.sha256`.** `NodeStartedSchema` requires a bare sha256 and
>   `appendEvents` does not validate payloads on **write** — so the event landed in the ledger and
>   `parseEvent` refused it on **read**. The SSE stream dropped it, `DeFlow run` never learned the
>   node had started, and it therefore never followed the node's `io_chunk` tail: a run that
>   completed with **no agent output on the terminal at all**, which is the exact 2026-08-12
>   symptom. This is also a standing hazard worth naming: an invalid payload is accepted on write
>   and lost on read, silently.
> - **No `RunId` could ever have a node branch.** A run id is `run_YYYYMMDDTHHMMSSZ_<hex>` and its
>   `T`/`Z` are uppercase; `BRANCH_SAFE` is lowercase-only, so `nodeBranch` threw `UnsafeRefError`
>   for **every run in existence** — invisible because nothing shipped had ever called it.
>   `runRef()` (`git/branch-name.ts`) is the one place a run id is lowercased, and the note there
>   records why that is injective for run ids and would not be for node ids.
> - **A declared path scope with no auditor refuses the node.** Every agent node the planner emits
>   declares one, and `runAcpNode` refuses before the spawn unless `scopeAudit` is wired — correctly,
>   since *"a declared scope with nothing behind it reads exactly like an agent that behaved"*. The
>   resolver wires `createScopeAudit()`.
> - **A booted daemon is no longer inert beside a run with a plan.** `e2e/gate-ladder.test.ts` took
>   its "before" cost reading from a real daemon over the seeded run and then expected a second
>   process to run the gates; the daemon now wins that race and drives the run itself. The reading
>   moved to a copy of the data directory, which is what it was always asserting.
>
> **One departure recorded rather than absorbed** ([README §9](../README.md#9-changing-the-plan)):
> the live performer provisions a **worktree per node attempt** and does not merge its branch back.
> That is EPIC-07's integration loop and inventing a second merge here would give a run two answers
> about how work reaches the integration branch — but it does mean the second agent node starts from
> `HEAD` rather than from the first one's output. `StartNode.worktree` is `null` on every node, so
> the performer chooses the path itself — not because nothing writes `node.scheduled` (this claim was
> made here on 2026-08-13 and is **false**: `packages/adapters/src/run-node.ts` appends it, and a
> hand-driven run's ledger carries one per agent node), but because the payload it appends names the
> node, provider and permission and **carries no worktree**. Whoever raises this to a real hand-off
> is changing that payload, not adding a producer.
>
> **The composition-root binding itself was cut and the smoke test went red**, which is the one
> sabotage the table above does not contain and the one the epic is actually about — every row in
> AC4 cuts a call *inside* the pipeline, and the 2026-08-12 defect was a port left unbound *outside*
> it. Removing `executeNodes: execution.executeNodes` from the bundled `up.ts` (exactly one
> occurrence in `bin.mjs`) and running the scenario against that copy raised
> `SmokeStageMissing: the smoke chain stopped at the plan reaching executeRun`. So the smoke test
> fails for the original defect and names it, rather than only for the six rewired calls beneath it.
>
> **Performed by hand, as the Definition of Done requires**, on 2026-08-13 in a scratch git
> repository with only `DeFlow-mock-agent` on `PATH` and the packed `packages/cli/dist/bin.mjs`:
> `DeFlow init` reported `mock ✓ ok` and every vendor `– skipped`; `DeFlow run --file task.md`
> printed `task submitted`, `run created` and the spec at the F1.3 gate; approving it over the
> daemon's own route produced `implement → verify → review` with the agent's own bytes on the
> terminal, `typecheck gate pass`, and `run … completed — every gate passed`. `GET /` served the
> SPA, `GET /api/runs/:id` answered `status: completed, outcome: succeeded`, and
> `GET /api/runs/:id/nodes/implement/io` served the same bytes the terminal showed.
>
> **Three follow-ups the walkthrough exposed**, none in this story's scope and all operator-facing:
>
> - `DeFlow run --attach <a run that is already terminal>` renders the whole transcript and the
>   verdict and then **does not exit**. `run.ts`'s `watch()` resolves from inside the hydrate, so its
>   `.then` runs `following?.close()` before `onFollowing` has assigned the handle — the SSE
>   connection is never closed and holds the process open. `--file` is unaffected, because there the
>   terminal event arrives after `onFollowing`. KAR-18.3's.
> - The human renderer prints an `io_chunk` as `chunk.data`, which on the ACP path is the **raw
>   JSON-RPC frame**. The agent's words are in it, so AC3 is satisfied and the smoke test asserts
>   them there — but what an operator reads is a wall of `{"method":"session/update",…}`. Extracting
>   the text belongs to KAR-18.9's renderer.
> - Every agent node prints `▸ <node> started attempt 1` **twice**. The ledger is right and the
>   renderer is not: `run-node.ts` appends `node.started` deliberately twice per attempt — once
>   before the spawn, which is what makes at-least-once recovery possible, and once when
>   `session/new` resolves the session id — and the human renderer draws a line per event without
>   folding the pair. Confirmed on the hand-driven run below (ledger seq 21/22 and 33/34, against a
>   single `node.started` for the gate-only `review` node, which spawns no session). Cosmetic, but it
>   is the first thing an operator asks about; KAR-18.9's renderer again.

---

### KAR-19.6 — Cancel and discard a run from the CLI, including one that never started _(added)_

|                 |                                                                                                                                                                                                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                                                                                                                                                            |
| **Priority**    | P0                                                                                                                                                                                                                                                                                     |
| **Size**        | M                                                                                                                                                                                                                                                                                      |
| **Depends on**  | KAR-19.1 (`GET /api/runs`, the live run list and the one status string every surface prints), EPIC-06 KAR-06.7 (pause/resume/cancel as events and the three-stage ladder), EPIC-08 KAR-08.6 (the kill switch's process-group mechanics), EPIC-15 KAR-15.5 (the control routes, their idempotency rules and the `spec_not_approved` refusal this story amends), EPIC-10 KAR-10.3 (the F1.3 gate's four options, of which `abandon` is one), EPIC-18 KAR-18.3 (the exit-code table and the detach sentence that already names this command), KAR-18.7 (`DeFlow status`) and KAR-18.9 (the shared terminal renderer) |
| **PRD**         | F1.3, F4.1, F4.4, F5.7, F10.1, NF8, NF10                                                                                                                                                                                                                                               |
| **Verified by** | EPIC-19-S37, EPIC-19-S38, EPIC-19-S39, EPIC-19-S40, EPIC-19-S41, EPIC-19-S42, EPIC-19-S43                                                                                                                                                                                              |

**As** an operator with a run I no longer want, **I want** one command that stops it — whether it is
halfway through a node or has never started at all — **so that** cleaning up after a bad afternoon
costs me one line rather than a hand-extracted bearer token and a `curl` invocation I have to look
up.

**This is the second half of the same 2026-08-12 afternoon.** Having watched three runs do nothing,
the operator typed `DeFlow cancel <runId>` — the command KAR-18.3 AC3's own detach sentence prints,
verbatim: _"detached — run `<runId>` continues; `'DeFlow run --attach <runId>'` to watch,
`'DeFlow cancel <runId>'` to stop"_. There is no such command. The daemon has had the capability
since KAR-15.5: `POST /api/runs/:id/cancel` takes `{ mode: 'cooperative' | 'forceful' }`, `forceful`
walks F5.7's ladder and answers only once the kill is verified. Nothing in the CLI is wired to it, so
the only route to it is `curl` with the bearer token read out of the token file by hand. A capability
no operator can reach is not a capability, and this is the third instance of that shape in this epic.

**The dead end is the second half, and it is worse.** `planRunControl` refuses **every** control verb
while the spec is unapproved — `UNAPPROVED = ['created', 'awaiting-spec-approval']` — with
`422 spec_not_approved` and the sentence _"creating a run does not start it, and no control verb
applies until `POST /api/runs/:id/spec/approve` has been answered"_. The gate's own escape hatch,
`POST /runs/:id/spec/abandon`, calls `abandonRun`, which begins `if (!gateIsOpen(events)) throw new
SpecGateNotOpen(...)`. A run stuck at `created` — no approval, and no gate open either, which is
exactly the state KAR-19.1 exists to fix and exactly the state all three reported runs are in — can
therefore be stopped by **neither** route, and accumulates in `DeFlow status` forever. KAR-18.3's
amendment already named this _"a real hole in the daemon's write surface rather than in this
command"_ and deferred it. This story is where the deferral is paid.

**The vocabulary decision, and why it is not a new word.** Four candidate spellings were available
and three are rejected in writing, because a second word for an outcome the ledger already has one
for is a second thing to keep true — the argument KAR-18.8 won and KAR-19.2 AC3 re-states:

- **No new run status.** `RUN_STATUSES` already ends at `aborted`, and it is reduced from events
  rather than set, so a `discarded` member would be a `run-state.ts` change to express a distinction
  the operator cannot act on differently.
- **No new event kind and no new `RUN_OUTCOMES` member.** Both are `@DeFlow/core`'s files and
  [EPIC-02](./EPIC-02-domain-model.md)'s story, and this epic's Out-of-scope forbids widening the
  `Event` union from here. `run.aborted` already reduces correctly, is already one of the four
  members of the `runs=*` global topic, and already ends a run.
- **The word for ending an unstarted run is `abandon`,** which is already the vocabulary of
  KAR-10.3's four gate options, of `human.responded.optionId = 'abandon'`, and of the shipped
  `POST /runs/:id/spec/abandon` route. "Discard" would be a fifth spelling of a fourth concept.
- **The operator's verb stays `cancel`,** because that is the word they typed, the word the detach
  sentence prints and the word `POST /runs/:id/cancel` already carries. One operator verb, two
  daemon paths, and the CLI says which one it took — the daemon chooses from reduced state, and the
  operator is never asked to know which of two commands their run's status entitles them to.

**What the ledger records, and the tempting shortcut.** An abandon of an unapproved run appends
`run.cancel.requested { mode: 'cooperative' }` **and** `run.aborted` in one transaction. The
shortcut is to append `run.aborted` alone, which is what `abandonRun` does today — and that is
defensible at the gate, where `human.responded { optionId: 'abandon' }` sits immediately in front of
it and records that a person asked. With no gate open nothing does, and a bare
`run.aborted { outcome: 'failed' }` is **indistinguishable from a run that died of a defect** — which
is precisely how these three runs were produced, so it is the one distinction this story cannot
afford to lose. Both events in one transaction means `cancelling` never becomes an observable status
for a run with nothing in flight, so no surface has to render a kill ladder that has zero rungs.

**Acceptance criteria**

1. `DeFlow cancel <runId>` exists as a first-class command and posts to the existing
   `POST /api/runs/:id/cancel`, authenticating through the same token-file path every other CLI
   command uses. It is `cooperative` by default — the mode that lets the agent flush its transcript
   — and `--force` sends `{ mode: 'forceful' }`, F5.7's ladder. No documented way to stop a run
   involves `curl` or a hand-extracted bearer token, and a guard asserts the string `curl` appears in
   no CLI help text, error message or docs page as a way to control a run.
2. The mode is stated, never guessed silently. The command's output names which mode it used and what
   that mode means: cooperative names that the agent is being given the chance to flush its
   transcript first; `--force` names the `session/cancel` → `SIGTERM` → grace → `SIGKILL` ladder and
   that the transcript may be truncated. A `--mode` value outside `CANCEL_MODES` is refused by the
   CLI with the closed list **before** any request is sent, mirroring the daemon's own refusal
   wording rather than inventing a second one.
3. `cancel` on a run whose spec has not been approved terminates it instead of refusing.
   `planRunControl`'s `UNAPPROVED` check moves below the verb split: `pause` and `resume` on a run in
   `created` or `awaiting-spec-approval` still answer `422 spec_not_approved` — there is nothing
   admitting work to pause — and `cancel` plans a termination. This **amends KAR-15.5 AC6**, whose
   blanket rule is what makes `run_20260812T133401Z_318740` unstoppable, and the amendment is
   recorded in EPIC-15's file.
4. That termination appends `run.cancel.requested { mode: 'cooperative' }` and `run.aborted` at
   consecutive `seq` **in one transaction**. No intermediate read ever observes the run as
   `cancelling`, no new event kind, run status or `RUN_OUTCOMES` member is introduced, and a crash
   between the two is impossible by construction rather than by ordering luck.
5. When the F1.3 gate **is** open, `cancel` goes through the shipped gate path: `human.responded`
   with `optionId: 'abandon'` is still written and the gate's `node_wake` row is still consumed in
   the same transaction, so the run's history records the option the operator effectively chose.
   There is one abandon implementation, not two — a source guard asserts that exactly one shipped
   module appends `run.aborted` on an operator stop.
6. Repeats and unknown ids are safe. Cancelling a run that has already ended returns `200` with the
   `seq` already in the log, appends nothing (KAR-15.5 AC2's rule, now reaching this path), and the
   CLI exits `0` saying the run had already ended and how it ended. An unknown run id is
   `404 run_not_found` with a non-zero exit and no partial write. Cancelling twice produces exactly
   one `run.aborted`.
7. Every surface stops showing a stopped run as live, at the same head sequence: `DeFlow status`
   drops it from its active-run summary, `GET /api/runs?status=active` excludes it while plain
   `GET /api/runs` still lists it with a terminal status, and the web run list updates the row in
   place from the `run.aborted` frame on the `runs=*` topic **without a refresh**. The status string
   is the one `runStatusLabel` produces (KAR-19.1 AC6); this story adds no fourth spelling.
8. A cancel survives a restart and never escalates by itself. A daemon `SIGKILL`ed after
   `run.cancel.requested` and before the ladder finished comes back, finishes the cancel, admits no
   further work, and reaches `aborted` once — without the operator issuing a second command. A
   cooperative cancel whose agent never answers **stays** `cancelling`: the CLI reports that and
   names `--force`, and nothing promotes cooperative to forceful automatically, because the whole
   point of the two modes is that one of them may lose a transcript.
9. The three reported runs are the acceptance case. `run_20260812T133401Z_318740` (`task.submitted`
   then `provider.probed`), `run_20260812T133514Z_ed4f12` (the same) and
   `run_20260812T133934Z_468702` (`task.submitted` alone) are each cleared by a single
   `DeFlow cancel <runId>` taking the same code path, and afterwards `DeFlow status` lists none of
   them. Kill verification, where a ladder ran at all, excludes `Z`-state processes.

**Test plan (TDD)** — write these first, in this order, and watch each fail before writing the
implementation.

| #   | Level       | Test                                                                                                                                                                                              | Red when                                                                                                                                          |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | unit        | `planRunControl` over the full `RunStatus` × verb table; assert `cancel` plans a termination for `created` and `awaiting-spec-approval`, and that `pause` / `resume` still refuse `spec_not_approved` | The `UNAPPROVED` check still runs above the verb split, so all three verbs refuse and a run that never started can never be got rid of            |
| 2   | unit        | The mode renderer and argument parser: cooperative and `--force` sentences, and an out-of-range `--mode` refused against `CANCEL_MODES` before any request is made                                  | The CLI silently defaults, so the operator cannot tell whether the agent was given the chance to flush its transcript                             |
| 3   | integration | File-backed ledger holding only `task.submitted`; cancel it and assert `run.cancel.requested` and `run.aborted` at consecutive `seq`, written in one transaction, with no observable `cancelling`   | The two are appended separately, so a crash between them parks the run in `cancelling` forever — the reported defect under a new name              |
| 4   | integration | Cancel with the F1.3 gate open; assert `human.responded { optionId: 'abandon' }`, the gate's `node_wake` row consumed in the same transaction, and one shipped module appending `run.aborted`      | A second abandon path is written for the CLI, and the record of which gate option the operator chose is lost                                       |
| 5   | integration | Cancel twice, then cancel a `completed` run; assert `200` with the existing `seq`, exactly one `run.aborted` in the ledger, and exit `0` both times; then an unknown id → `404` and a non-zero exit | The repeat appends a second `run.aborted`, so the run list renders the same run ending twice and the timeline disagrees with itself                |
| 6   | e2e         | Built binary + real daemon + a live mock-agent child; `DeFlow cancel <runId> --force`; assert the mode named on stdout, `run.aborted` on disk, the documented exit code, and no non-`Z` process left in the agent's group | The command does not exist, so the operator is back to `curl` with a token they extracted by hand — the reported defect                            |
| 7   | web         | Run list open on the `runs=*` topic; push `run.aborted` for a listed run; assert the row updates in place with no refetch, and that a subsequent `?status=active` fetch omits it                   | The list keeps the run as live until a reload, so stopped runs accumulate on screen exactly as the operator's three did                            |
| 8   | integration | `SIGKILL` the daemon after `run.cancel.requested` with a child in flight; reboot over the same data dir; assert the cancel completes, nothing further is admitted, and `run.aborted` appears once  | The ladder was held in memory, so the restart resumes a run the operator stopped and the second `DeFlow cancel` is the operator's job again        |
| 9   | integration | A `Scenario Outline` over the three reported runs' exact ledger shapes; assert one command clears each and that `DeFlow status` afterwards lists none of them                                       | The `task.submitted`-only shape and the `provider.probed` shape take different paths, so one command clears one run and the operator has to guess |

**Notes / risks** — the temptation here is a client-side special case: let the CLI notice a `422` and
fall back to `POST /runs/:id/spec/abandon`, which is what `packages/cli/src/run/cancel.ts` already
does for the second Ctrl-C. That fallback is what proves the point rather than solving it — it cannot
help a run with no gate open, and it puts the daemon's state machine in the CLI, where the web UI and
any future client cannot reach it. The fix belongs in `planRunControl`, and the CLI's fallback is
deleted once one route answers for every state.

---

### KAR-19.7 — The mock agent can serve a framing turn, so a run works with no vendor CLI _(added)_

|                 |                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                                                                                                                                                                                                                                           |
| **Priority**    | P0                                                                                                                                                                                                                                                                                                                                                                    |
| **Size**        | M                                                                                                                                                                                                                                                                                                                                                                     |
| **Depends on**  | KAR-19.3 (the chain whose amendment discovered this, and whose e2e half it unblocks), EPIC-04 KAR-04.1 (the mock agent binary and its real ACP session), KAR-04.2 (the scripted scenario format the scripted returns join) and KAR-04.4 (the capability-profile honesty rule this field joins), EPIC-05 KAR-05.2 (the probed capability row admission reads) and KAR-05.3 (`PROVIDER_SPECS`, the one file allowed to name a vendor), EPIC-09 KAR-09.9 (the `returns` contract and `structuredOutputContract`), EPIC-10 KAR-10.2 (`admitFraming`, which this story satisfies rather than relaxes) |
| **PRD**         | F1.2, F2.2, F3.5, F3.7, NF1, NF6, NF9                                                                                                                                                                                                                                                                                                                                 |
| **Verified by** | EPIC-19-S44 (**partly** — the admission clauses, in `e2e/mock-only-run.test.ts`; the completion clauses are deferred with AC9, see the amendment), EPIC-19-S45, EPIC-19-S46, EPIC-19-S47, EPIC-19-S48, EPIC-19-S49, EPIC-19-S50, EPIC-19-S51                                                                                                                            |

> **Amendment (implementation, 2026-08-13).** Three departures, and one wording in the scenarios
> that the emitted schemas do not support.
>
> - **The structured path is exec-shaped, not ACP-native.** EPIC-19-S44 says the framing turn is
>   *"served by `DeFlow-mock-agent` over a real ACP session"*, and the story's own prose leaves the
>   choice open — _"an exec-shim mode, or an ACP-native return"_. It is the exec-shim mode, because
>   the criteria decide it: AC2 puts the flag on `shim.structuredOutputFlag`, which is the field
>   `providerStructuredOutput` reads and therefore the only field that can make admission answer
>   `native`; AC1 says the return channel carries **one document and nothing else**, which is stdout
>   rather than a frame inside a session; and AC6 and test plan #6 want a **non-zero exit** and zero
>   bytes, which are process-level facts an ACP turn cannot state. So the flag selects an
>   exec-shaped invocation and no transport is opened on that path — which is also what keeps a
>   turn *without* the flag byte-identical to the one EPIC-04 shipped (AC5).
> - **AC1's recon clause is two schema ids, not a nested provenance field.** EPIC-19-S45 asks that
>   *"each recon fact in `DeFlow.reconsurvey.v1` carries a `DeFlow.reconfact.v1` provenance field"*,
>   and `schemas/DeFlow.reconsurvey.v1.json` has no facts array to carry one: the survey is the
>   agent's *claims* (toolchain, commands), and a `reconfact` is the separate document `runReconNode`
>   writes when it establishes one. Serving both ids — which is what AC1's *"`DeFlow.reconsurvey.v1`
>   with `DeFlow.reconfact.v1`"* literally asks for — is what shipped. Changing the emitted schema to
>   make the scenario's sentence true would be EPIC-10's mechanism, altered to satisfy a test double.
> - **Test plan #5's "before and after" is the suite itself, not a new spec.** *"Run each shipped
>   scenario and each `recordings/` replay before and after this story; assert byte-identical
>   transcripts"* cannot be written as a test that only exists afterwards — the "before" side has no
>   observer. What EPIC-04's unchanged suite already asserts is byte-identity per seed and per
>   golden, and it passes with no fixture re-recorded and no expectation relaxed, which is the claim.
>   What is newly automated is the half a later reader could break: the structured path is entered
>   only when a schema is supplied, a `returns` block is invisible to an ACP turn (byte-compared),
>   and no shipped scenario declares one.
> - **AC9 and test plan #9 are not automated here, and the reason is one level below this story.**
>   Everything AC9 needs *from this story* is in place: a `PATH` holding only `DeFlow-mock-agent` now
>   passes admission (`PROVIDER_SPECS` has a `mock` entry that resolves), `providerStructuredOutput`
>   reports `native` because the binary honours the flag, and `admitFraming` admits a framing node
>   routed there. What is still missing is the wiring KAR-19.3 and KAR-19.4 recorded as their own
>   departure: `DeFlow up` binds no `runFraming`, `advanceRun` or `executeNodes` port, because no
>   `FramingAgent`/`ReconAgent`/`PlannerAgent` over a real process exists yet. That was **blocked**
>   before this story and is merely **unbuilt** after it, which is the whole of what KAR-19.7 was
>   for. AC9 closes with that binding, and the acceptance case is automated at `e2e` then — together
>   with KAR-19.3's test plan #1 and KAR-19.4's #1 and #8, which close at the same moment.
>
> **Corrected 2026-08-13, after the gate.** The paragraph above was true and the *record* was not:
> `EPIC-19-S44` was left declared *"Automated at: e2e"* in the flows file and listed unqualified in
> the `Verified by` row, so the plan claimed an e2e that did not exist, and
> `packages/mock-agent/test/integration/structured-returns.test.ts` carried a `Verifies:
> EPIC-19-S44` line for a spec that never runs `DeFlow run` or reads a ledger. Three things changed.
> **The half AC9 does deliver is now automated at `e2e`**, in `e2e/mock-only-run.test.ts`: a `PATH`
> holding only `DeFlow-mock-agent` — asserted against the binary names `PROVIDER_SPECS` declares,
> not a list kept by hand — admits the run rather than refusing it, the one probe row is `mock`
> carrying a real ACP `initialize` answer, no `run.aborted` is appended, and the run parks on the
> durable framing wake. It goes red on the pre-story machine: with bundled entries dropped from
> `usableProviders`, `DeFlow run` exits 5 with `no_usable_provider`. **The completion half is
> recorded as deferred** in both the flows file and the `Verified by` row rather than only here.
> **And one blocker below the binding is now written down**, because it would otherwise be found the
> morning the binding lands: the default plan's agent nodes return `DeFlow.finding.v1`, and
> `SCHEMA_GENERATORS` serves the four documents the *chain* needs and no node return — so
> `node.completed` against the bundled agent needs a generator for the node contract too, and AC1's
> *"the three turns the live chain needs"* did not cover it.
>
> One thing shipped that no criterion named, and it is cheaper to record than to rediscover.
> **`ProviderSpec` gained a `bundled` flag**, and `provider-install.ts` a `usableProviders` ordering
> that puts bundled entries last. AC8 asks for both halves — *"nothing prefers `mock` to it"* and
> *"never prints an `npm install -g` action for a package that ships in the same tarball"* — and both
> have to be answered without naming a provider outside `provider-registry.ts`. A boolean on the spec
> is what lets `providerVerdict` stay a pure function of the resolution it was handed, and
> `admitRun` now reduces `usableProviders` rather than asking `some(installed)` a second time, so
> the ordering is on the path a run actually takes rather than beside it.

**As** a person evaluating DeFlow on a machine with no vendor agent CLI, **I want** the bundled mock
agent to be able to answer a turn that carries a schema, **so that** framing, planning and execution
work end to end with nothing installed — and **so that** this epic's own acceptance test can be
written at all.

**This story exists because the gate found EPIC-19's acceptance test unreachable.** The framing,
recon and planner turns each carry a `returns` contract, and `admitFraming`
(`packages/adapters/src/framing-admission.ts`) refuses any provider without a `structuredOutputFlag`.
In `packages/adapters/src/provider-registry.ts` only `claude` (`--json-schema`) and `codex`
(`--output-schema`) have one, and both on the **exec-shim** path; `DeFlow-mock-agent` speaks ACP
only. So on a machine with no vendor CLI nothing can get past framing — which is why KAR-19.3's
amendment could not write its `e2e`, why KAR-19.4's amendment could not bind the chain in
`DeFlow up`, and why KAR-19.5's smoke test — **the whole point of which is to need no vendor CLI, no
credential and no network** — cannot be written.

**The epic's Out-of-scope rule sends mock-agent work to [EPIC-04](./EPIC-04-mock-agent.md), and that
rule is being overridden here deliberately.** The reason belongs in the story rather than in a commit
message: EPIC-19's Definition of Done is behavioural — `DeFlow run` must work end to end with only
the bundled mock agent — and **a capability that acceptance test depends on cannot be out of scope
for the epic that declares it.** The override is recorded in this epic's Out-of-scope section too, so
the exception is visible from the rule rather than only from here.

**The guard is not the thing to change.** The tempting fix is one line in `admitFraming`: let the
mock agent through, or drop the `structuredOutputFlag` requirement. Both are refused. That guard is
what stops a **real** provider being handed a contract it cannot honour — KAR-10.2 AC3's argument
that _"the fallback for a spec is not a softer contract, it is a different adapter"_ — and a
special case for the test double is exactly the kind of exception that makes the production path
untested by the only path anyone runs. So the change stays inside the mock agent and its registry
entry: the binary genuinely takes a schema and genuinely returns a document that validates against
it, the registry says so because it is true, and admission reaches the same `native` answer through
the two questions it already asks, having learned nothing about mocks.

**Determinism is not negotiable, and neither are EPIC-04's fixtures.** F3.7's mock provider is
_"deterministic, free"_ and NF9 puts nondeterminism outside the adapter boundary; a document that
carries a timestamp, an unseeded id or a directory-listing order would make every downstream snapshot
in the repository flake. And the structured path is entered only when a schema is supplied, so a turn
without one behaves byte-for-byte as it does today — otherwise this story's cost is re-recording
every fixture EPIC-04 owns.

**Acceptance criteria**

1. `DeFlow-mock-agent` gains a structured-output path: given the schema flag its registry entry
   declares and a schema file naming a schema it can serve, the turn returns **one** document that
   validates against that schema and nothing else on the return channel. It serves at least
   `DeFlow.taskspecdraft.v1` (framing), `DeFlow.reconsurvey.v1` with `DeFlow.reconfact.v1` (recon) and
   `DeFlow.plangraph.v1` (planner) — the three turns the live chain needs — and its default plan
   document has **at least two nodes**, so KAR-19.5 AC2's "at least two nodes" clause is reachable
   against it.
2. The registry declares the capability and the declaration is true. `PROVIDER_SPECS` gains a `mock`
   entry whose `shim.structuredOutputFlag` is the flag AC1 implements, so
   `providerStructuredOutput('mock')` reports `native` **because the binary honours the flag**, not
   in order to make a check pass. The flag string the entry declares and the flag string the binary
   parses are one exported constant, so a rename cannot leave the registry lying, and a test spawns
   the real binary with the entry's own flag rather than asserting the two literals match.
3. `admitFraming` is unchanged, and a source guard proves it. Framing on `mock` is admitted because a
   probed capability row exists and the manifest says `native` — the same two questions
   `framing-admission.ts` asks of every provider. `framing-admission.ts`, `admission.ts` and
   `structured-output.ts` name no provider, `mock` included, and `provider-registry.ts` remains the
   only file allowed to (KAR-05.3's `test/no-capability-table.test.ts` exemption).
4. The returns are deterministic. The same schema id, the same prompt and the same seed produce a
   **byte-identical** document across repeated spawns and across a changed `cwd`, `TMPDIR`, `TZ` and
   locale. No `Date.now()`, no unseeded random and no filesystem enumeration order reaches the
   document: ids and any time-like field come from the mock agent's existing deterministic sources
   (`src/ids.ts`, `src/clock.ts`). Two runs of the smoke test produce the same plan.
5. EPIC-04's existing behaviour is untouched. Every shipped scenario under
   `packages/mock-agent/scenarios/` and every recording replayed under `recordings/` produces
   byte-identical output before and after this story, and EPIC-04's suite passes **unchanged** — no
   fixture is re-recorded and no expectation is relaxed. A turn invoked without a schema flag,
   including every pathological scenario, behaves exactly as it does today.
6. A schema it cannot serve is refused, never approximated. An unknown schema id, an absent or
   unreadable schema file, or a schema for which the agent has no generator exits non-zero, names the
   schema id, lists the ids it can serve, and writes **zero bytes** on the return channel. It never
   emits a plausible-but-wrong document and never falls back to prose — a mock that guesses turns the
   whole chain green for the wrong reason, which is this epic's own failure mode reproduced inside
   the test double.
7. The failure returns are scriptable too. A scenario can make the turn return a document that fails
   validation, a truncated one, or one that is valid but unsatisfiable, so the invalid-draft path
   (KAR-10.2), plan-validation failure (KAR-19.3 AC5, EPIC-19-S20) and schema-repair exhaustion are
   all reachable **with no vendor CLI installed**. The unscripted default return is always valid, so
   a scenario file is what makes a turn fail rather than the absence of one.
8. The new entry does not become a silent routing hazard. On a machine where a real provider
   resolves, nothing prefers `mock` to it: a run routes onto `mock` only when the operator's `PATH`
   or configuration puts it there, and a source-level assertion covers the selection order rather
   than a comment. `doctor` reports the entry truthfully — `installed` when the bundled binary
   resolves — and never prints an `npm install -g` action for a package that ships in the same
   tarball (KAR-18.8's rule that the words must fit the machine).
9. **The acceptance case.** In an `fs.mkdtemp` git repository, on a `PATH` holding no vendor agent CLI
   at all and only `DeFlow-mock-agent`, `DeFlow run --file <spec>` reaches `plan.proposed` and at
   least one `node.completed`, with no credential variable in any child environment, no outbound
   socket and no read of `~/.DeFlow`. This is precisely the run KAR-19.3's amendment recorded as
   impossible today.

**Test plan (TDD)** — write these first, in this order, and watch each fail before writing the
implementation.

| #   | Level       | Test                                                                                                                                                                                          | Red when                                                                                                                                    |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | integration | Spawn the built `DeFlow-mock-agent` with the registry entry's own flag for each of the three schema ids; validate each returned document against `schemas/<id>.json` with ajv, and assert the plan document has ≥ 2 nodes | The binary ignores the flag and answers in prose, so the framing turn returns "valid-ish" and everything downstream is judged against it   |
| 2   | unit        | `providerSpec('mock')` and `providerStructuredOutput('mock')`; assert `native`, and assert the declared flag is the same exported constant the binary's argument parser reads                 | The entry declares a flag the binary does not implement, and the registry becomes the lie admission trusts                                  |
| 3   | unit        | `admitFraming({ provider: 'mock' }, row)` → `null` with a probed row, `NodeFailureError` with `row === null`; plus a source guard that `framing-admission.ts`, `admission.ts` and `structured-output.ts` name no provider | Admission was special-cased for the mock agent, so the guard that stops a real provider taking a contract it cannot honour now has a hole  |
| 4   | integration | The same turn spawned twenty times with the same seed, under changed `cwd`, `TMPDIR`, `TZ` and locale; assert byte-identical documents every time                                             | A timestamp, a `Math.random()` or a readdir order reaches the document, and the smoke test's snapshot flakes about once a week             |
| 5   | integration | EPIC-04's shipped scenarios and the `recordings/` replay, run before and after; assert byte-identical transcripts and an unchanged EPIC-04 suite                                              | The structured path changes the default turn, and every EPIC-04 fixture has to be re-recorded to stay green                                |
| 6   | integration | An unknown schema id, an absent schema file and a schema with no generator; assert non-zero exit, the id named, the servable list printed, and zero bytes on the return channel                | It returns its nearest guess or an empty object, and the whole chain goes green on a document nothing actually produced                    |
| 7   | integration | A scenario scripting an invalid draft and one scripting a truncated document; assert the caller's own refusal path fires for each, with no vendor CLI on `PATH`                               | Only the happy return is scriptable, so EPIC-19-S20's validation failure still needs an installed vendor to reach                          |
| 8   | unit        | Provider selection over a resolved table holding a real vendor and `mock`; assert `mock` is never preferred, and assert `doctor`'s verdict for the bundled binary carries no `npm install -g` | Adding the entry quietly makes every machine's default provider a fake agent, and a run "succeeds" against a mock nobody chose             |
| 9   | e2e         | A `PATH` with no vendor CLI and only `DeFlow-mock-agent`; `DeFlow run --file spec.md`; assert `plan.proposed`, ≥ 1 `node.completed` and a terminal `run.*` in the on-disk ledger              | The chain still cannot be framed on a clean machine, so this epic's Definition of Done and KAR-19.5 both remain unreachable                |

**Notes / risks** — two things constrain the implementation and are cheaper to write down than to
rediscover. **`@DeFlow/mock-agent` ships with exactly one dependency**
([07 §13](../../07-provider-adapter-layer.md)), so ajv cannot come along: the emitted document is
validated **in the tests**, not at runtime by the binary, and AC1's guarantee is therefore a
test-time property of a generator that must be written to be obviously correct rather than a runtime
check. And the second temptation, after special-casing admission, is to have the mock agent emit
whatever the *caller* wants — reading the run's own context to shape the plan. It must not: a mock
whose output depends on more than (schema, prompt, seed) is a second planner wearing a fixture's
clothes, and KAR-19.3 AC7's one-implementation-per-step guard is the rule it would be evading.

---

### KAR-19.8 — The `claude` exec-shim sends a session id `claude` accepts _(added)_

|                 |                                                                                                                                                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                                                                                                                                                                                                                              |
| **Priority**    | P0                                                                                                                                                                                                                                                                                                                                                       |
| **Size**        | S                                                                                                                                                                                                                                                                                                                                                        |
| **Depends on**  | KAR-19.3 (`live-agents.ts`, which fills the shim context for every pre-execution turn), KAR-19.4 (`live-nodes.ts`, the same argv on the node path), EPIC-05 KAR-05.3 (`PROVIDER_SPECS` and its argv builders — the one file allowed to name a vendor), KAR-05.7 (the conformance battery this joins), KAR-05.8 (the exec-shim adapter and its dialects), EPIC-12 KAR-12.2 (the client-chosen session id and the independence assertion it exists to make), EPIC-02 KAR-02.8 (the `.manual` vendor-CLI spec this sits beside) |
| **PRD**         | F1.2, F3.2, F3.4, F4.3, NF9, NF10                                                                                                                                                                                                                                                                                                                        |
| **Verified by** | EPIC-19-S52, EPIC-19-S53, EPIC-19-S54, EPIC-19-S55, EPIC-19-S56, EPIC-19-S57                                                                                                                                                                                                                                                                              |

**As** an operator on a machine where `claude` is installed and authenticated, **I want** the turn
DeFlow spawns to be one `claude` will actually accept, **so that** a run that reached framing does
the work instead of dying on an argument DeFlow chose.

**Observed by hand on 2026-08-13**, on this branch at commit `1a17d31`, in a scratch git repository
with `DeFlow_DATA_DIR` pointed at a fresh directory. `DeFlow run --file task.md` reached framing —
which is the good news, and the whole of KAR-19.3 working — and then failed on every attempt with:

```
claude exited 1 without completing the turn: Error: Invalid session ID. Must be a valid UUID.
```

The stack is `structuredTurn → open → runFramingInterview → runFraming → runOneFraming →
dispatchWakes → tick`, and the typed failure is
`{ reason: 'agent.nonzero-exit', class: 'transient', detail: { provider: 'claude', code: 1, stderr:
'Error: Invalid session ID. Must be a valid UUID.' } }`.

**The cause is one value, chosen by DeFlow.** `packages/adapters/src/provider-registry.ts` passes
`--session-id ctx.sessionId` on the `claude` shim path (and the same field feeds `--resume`), and
`packages/daemon/src/pipeline/live-chain.ts` fills it with `` `${runId}-framing` `` —
`run_20260813T110608Z_379fc8-framing`. DeFlow's own run ids are not UUIDs and were never meant to
be; Claude Code 2.1.220 validates the flag and refuses outright. The same shape is one line away on
the recon and planner turns, which are filled the same way.

**The fix keeps DeFlow's id as the record.** The vendor gets an identifier of the form it demands;
the ledger, the UI and every log line keep naming `run_…_379fc8`, because that is the id an operator
greps for six weeks later (NF8). And the vendor-side id must be a **stable function** of DeFlow's —
a fresh UUID per attempt would break `--resume` and would make the transcript on disk unfindable,
which is the quiet half of this bug. `(runId, nodeId, attempt)` is already how F4.3 derives an
idempotency key; the session id is the same question asked of the same tuple.

**Why no test caught it, and where the test belongs.** The provider contract tests exercise the shim
against fixtures and against the testkit's fake exec-shim agent, which accepts whatever it is given —
so *"DeFlow builds an argv the real vendor rejects"* is outside every level in the suite. The honest
home for it is the F3.4 conformance battery, whose whole purpose is that flag churn is detected here
and not by a user's failed three-hour run. Part of that battery can only run where a real, installed,
authenticated `claude` exists, so **that part is opt-in and is labelled opt-in** — `DeFlow_MANUAL_
VENDOR_CLI=1`, the mechanism KAR-02.8 already established — and this story does not pretend
otherwise. What runs everywhere is the argument-*form* guard: a table over `PROVIDER_SPECS` asserting
that every value DeFlow puts on a validated flag matches the form that vendor documents.

**Acceptance criteria**

1. Every exec-shim invocation DeFlow builds for `claude` carries a `--session-id` whose value is a
   syntactically valid UUID, on all four turn kinds that reach the shim (framing, recon, planner and
   an agent node). The value is produced by one exported function; no call site formats a session id
   itself.
2. The mapping is **stable and derived, not random**: the same `(runId, nodeId, attempt)` yields the
   same UUID across repeated calls, across processes and across daemon lives, and two different
   tuples never collide. A UUID minted per attempt is a failing implementation of this criterion,
   and the test that says so is not a snapshot.
3. DeFlow's own identifier remains what is recorded and displayed. `node.started`, the run's events,
   `DeFlow status`, the CLI's attached view and the UI all still name the DeFlow run and node ids;
   the vendor-side id is carried **beside** it — in the session field the adapter already records
   (`session: { id, origin }`) — so a transcript under `~/.claude/projects/` can be found from the
   ledger without a second lookup table.
4. Resume and continuation still work. A second attempt on the same node reaches the vendor with the
   session id its first attempt used where the adapter's resume strategy is `native`, and the
   assertion that a review node ran in its own session (KAR-12.2 AC5) is still made on a value
   DeFlow minted rather than one parsed back out of a frame.
5. A vendor that refuses an argument is reported as an argument problem. When a shim child exits
   non-zero having written a message naming a flag DeFlow passed, the typed failure carries the flag
   and the offending value alongside the child's stderr, and the terminal line names them. The
   operator must not have to read a stack trace to learn which of DeFlow's own arguments was
   rejected.
6. The failure class is right. An argument the vendor will reject on every attempt is **not**
   `transient`: it is `permanent` under KAR-02.10's taxonomy, because retrying it thirty times
   changes nothing. The 2026-08-13 log — the identical error at 11:07:13, 11:07:44, 11:08:14, … — is
   what a wrong class looks like from the outside.
7. The F3.4 battery gains a conformance row per exec-shim vendor: *the vendor accepts the argv this
   registry entry builds*. It runs against the mock and the testkit's fake vendor CLI on every
   commit; the half that needs a real, authenticated CLI is skipped unless
   `DeFlow_MANUAL_VENDOR_CLI=1` is set, is reported as skipped rather than silently absent, and is
   named as opt-in in the story, the flow file and `doctor`'s own output.
8. The other three exec-shim vendors are checked, not assumed. A table-driven guard over
   `PROVIDER_SPECS` asserts, for every entry that passes a session id, that the value DeFlow supplies
   matches the form that entry declares — so `gemini`'s `--session-id` and `codex`'s session handling
   are covered by the same test rather than by the next by-hand run.

**Test plan (TDD)** — write these first, in this order, and watch each fail before writing the
implementation.

| #   | Level       | Test                                                                                                                                                                              | Red when                                                                                                                            |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | unit        | `shimPlan` for `claude` over the four turn kinds; assert the `--session-id` value parses as a UUID and that the builder is the only producer of it                                | The value is `` `${runId}-framing` ``, which is what the vendor rejected — this is the reported defect at the smallest level          |
| 2   | unit        | The mapping function over a table of `(runId, nodeId, attempt)`; assert stability across calls and no collision across 10 000 tuples                                              | A `randomUUID()` per attempt passes "is a UUID" and silently breaks resume, which no other assertion here would notice                |
| 3   | integration | Drive a framing turn against the testkit's fake vendor CLI configured to refuse a non-UUID session id, exactly as Claude Code 2.1.220 does; assert the turn completes             | The fake accepts anything, so the suite is green on the machine where the product is not — the reason this bug shipped               |
| 4   | integration | The same turn's ledger: assert `node.started` and the run's events name the DeFlow run and node ids, and that the vendor-side id appears only in the session field                | The fix renames the run in the ledger to keep the vendor happy, and every id in the operator's logs changes meaning                  |
| 5   | integration | A second attempt on the same node; assert the vendor received the same session id and that resume took the `native` strategy                                                      | The id is derived from a clock or a counter, so attempt 2 opens a session attempt 1's transcript is not in                           |
| 6   | integration | A shim child that exits non-zero with `Invalid session ID` on stderr; assert the typed failure carries the flag and the value, and that the class is `permanent`                  | It is classified `transient` and retried forever — which is precisely what the 2026-08-13 log shows, and KAR-19.9's other half       |
| 7   | unit        | A `Scenario Outline` over `PROVIDER_SPECS`: every entry that passes a session id, asserted against the form that entry declares                                                   | Only `claude` is fixed and `gemini`'s next validated flag repeats this afternoon                                                     |
| 8   | manual      | The F3.4 battery's real-vendor row, behind `DeFlow_MANUAL_VENDOR_CLI=1`: spawn the installed `claude` with the argv the registry builds; assert exit 0 and a parsed return        | Nothing anywhere spawns the real binary with DeFlow's own argv, so the next flag validation the vendor adds is found by an operator  |

**Notes / risks** — the tempting shortcut is `randomUUID()` at the call site: it makes the error go
away in a minute and takes resume, the transcript path and KAR-12.2's independence assertion with it,
none of which fails a test today. The second temptation is to widen the DeFlow run-id format to be a
UUID, which would satisfy the vendor and destroy the property the id was chosen for — a
`run_20260813T110608Z_379fc8` sorts by time and is readable in a terminal, and NF8's *"inspectable on
disk"* is mostly about being able to read a directory listing.

---

### KAR-19.9 — A run that keeps failing gives up, says why, and never hangs the terminal _(added)_

|                 |                                                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Status**      | Not started                                                                                                                                                                                                                                                                                                 |
| **Priority**    | P0                                                                                                                                                                                                                                                                                                          |
| **Size**        | M                                                                                                                                                                                                                                                                                                           |
| **Depends on**  | KAR-19.1 (the driver, its wake settlement and the stall detector), KAR-19.3 (the framing dispatch that is doing the retrying), KAR-19.4 (the executor, the terminal renderer and `classifyRun`), KAR-19.5 (the smoke test and the sabotage table this adds a row to), EPIC-06 KAR-06.5 (classified retry, `planRetry` and `recordNodeFailure` — the policy this story must use rather than write a second one), KAR-06.9 (recovery), EPIC-02 KAR-02.10 (the closed failure taxonomy), EPIC-18 KAR-18.3 (the exit-code table and the attached view) |
| **PRD**         | F4.1, F4.5, F4.7, F10.1, NF8, NF10                                                                                                                                                                                                                                                                          |
| **Verified by** | EPIC-19-S58, EPIC-19-S59, EPIC-19-S60, EPIC-19-S61, EPIC-19-S62, EPIC-19-S63, EPIC-19-S64                                                                                                                                                                                                                    |

**As** an operator whose run has hit something it cannot get past, **I want** DeFlow to stop, tell me
why and give me my terminal back, **so that** a broken environment costs me one screen of output
rather than an afternoon and a `kill`.

**This is the second defect from the 2026-08-13 by-hand run, and it is the more serious one.** After
the framing turn failed (KAR-19.8), DeFlow retried it every ~31 s indefinitely — the identical
`NodeFailureError` at 11:07:13, 11:07:44, 11:08:14, 11:08:45, 11:09:15, and on. The operator's
`DeFlow run` printed **nothing** about any of it and never exited; it was still hanging after seven
minutes and had to be killed. And the ledger for that run contains `provider.probed`,
`provider.probed`, `task.submitted` — **not one of those failures was recorded as an event**, so
neither the UI nor `DeFlow status` could have shown them either.

Three things are wrong and all three are in scope. They are one defect wearing three coats: **a
failure that nothing bounds, nothing records and nothing says out loud.**

1. **The retry is unbounded.** `runOneFraming` catches, logs to the daemon's own log, and
   `settleFramingWake` pushes the wake forward by `FRAMING_RETRY_MS` — 30 s, forever, with no attempt
   ceiling and no backoff cap. EPIC-06 already owns classified retry: `planRetry` bounds attempts at
   `maxAttempts` (3 by default) and returns `{ action: 'fail', exhausted: true }` after them, and
   `recordNodeFailure` writes the events and the wake row in one transaction. **The drive loop is
   bypassing it, and that is the bug** — this story wires the existing policy in, it does not invent
   a second one.
2. **The failures were not journalled.** A turn that throws must append an event carrying the typed
   failure, so the run's own history explains why it is stuck. Silence in the ledger is exactly what
   made KAR-19.8 invisible: the only evidence that anything had happened at all was a daemon log the
   operator had no reason to open.
3. **The attached CLI showed nothing and never terminated.** A failing run must stream its failures
   to the terminal as they happen and exit with the documented code — `1` for a failed node, through
   `classifyRun` and nowhere else. `--no-wait` is not the answer: this run was not waiting on a
   human, it was waiting on nothing.

**No new event kinds.** This epic's Out-of-scope rule holds: `node.failed`, `node.retry.scheduled`
and `run.aborted` all exist, all reduce correctly today, and `run.aborted` is already one of the four
members of the `runs=*` global topic, so a run that gives up reaches the run list without a new
subscription.

**Acceptance criteria**

1. A failing pre-execution turn is journalled. Every attempt that throws appends `node.failed`
   carrying the typed `NodeFailure` from KAR-02.10's closed taxonomy — reason, class and the
   provider-level detail including the child's trimmed stderr — before the wake is settled. A run
   whose ledger explains nothing is the failure this criterion exists to remove.
2. Retry is bounded by **EPIC-06's** policy and by no other. The framing and chain dispatch route
   their failures through `recordNodeFailure`/`planRetry`, so the attempt ceiling, the jittered
   backoff and the cap are the node's own `RetryPolicy`. A source guard asserts that `drive.ts`
   contains no second ceiling, no second backoff constant and no second classification, and that
   `FRAMING_RETRY_MS` is either removed or is demonstrably not an attempt policy.
3. Exhaustion is terminal and says so. When attempts are exhausted, or the failure is classified
   `permanent`, the run reaches a terminal state — `run.aborted` with `outcome: 'failed'` — with the
   reason carried on it, within one tick of the last attempt. No wake row for that node is left due,
   and no further child is spawned for the run afterwards.
4. The attached CLI streams the failures as they happen. Each attempt's failure prints one line
   naming the node, the attempt number out of the ceiling, and the typed reason; the line appears
   **while the run is still retrying**, not at the end. `--json` emits the same content as NDJSON
   with no ANSI.
5. The command exits, and with the documented code. `DeFlow run --file <task>` against a provider
   that fails every attempt exits **1** through `classifyRun` — not 0, not a hang — and the process
   is gone within the documented shutdown budget of the terminal event. A test asserts the process
   exited rather than asserting on a promise.
6. Both surfaces show the same ending. `GET /api/runs/:id` and the web run list show the run as
   failed with the reason at the same head sequence the CLI printed, and the run's own view shows the
   failed attempts in order. `runStatusLabel` (KAR-19.1 AC6) produces the string; this story adds no
   fourth spelling.
7. A retry that would have succeeded is not cut short. A turn that fails twice and succeeds on the
   third attempt reaches `run.created` and the run proceeds; the ceiling is `maxAttempts` and not a
   heuristic, and the two failed attempts are still journalled. **Giving up early is the same class
   of defect as never giving up**, and this criterion is what stops the fix overshooting.
8. Backoff is bounded above as well as below. Successive attempts are separated by the policy's
   jittered backoff up to its cap, and a run that is retrying spawns at most one child per node at a
   time — asserted by counting spawns over a `TestClock`-driven window, not by reading the constant.
9. KAR-19.5's sabotage table gains a row: **a provider that fails every turn**. With it, the smoke
   test must fail with a message naming the run as failed rather than timing out, and the row is red
   before this story and green after — a regression that reintroduces the infinite retry turns the
   smoke test red rather than slow.

**Test plan (TDD)** — write these first, in this order, and watch each fail before writing the
implementation.

| #   | Level       | Test                                                                                                                                                                                     | Red when                                                                                                                                |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | integration | A framing runner that always throws, over a file-backed ledger; assert one `node.failed` per attempt carrying the typed failure, in `seq` order                                          | The failure is written to the daemon log and nowhere else — the reported defect, and the reason nobody could diagnose the first one      |
| 2   | integration | The same, driven on a `TestClock` past the ceiling; assert exactly `maxAttempts` attempts, then `run.aborted` with the reason, then no further spawn over ten more windows               | The wake is pushed forward by 30 s forever, so the run retries all night and the daemon looks busy rather than broken                    |
| 3   | unit        | A source guard over `drive.ts` and the chain dispatch: no second attempt ceiling, no second backoff constant, no `NodeFailureReason` literal                                             | A local "try three times" is added beside `planRetry`, and two retry policies disagree the first time one is tuned                       |
| 4   | integration | Real CLI binary against a real daemon with an always-failing provider; assert the failure lines appear on stdout **before** the terminal event, and that the process exits 1             | The CLI prints nothing and never returns — the operator's actual experience, asserted directly                                           |
| 5   | integration | Assert the exit code comes from `classifyRun` and that no second derivation exists in the run command                                                                                    | The run command maps "it threw" to 1 by itself and disagrees with the projection the UI shows                                            |
| 6   | integration | `GET /api/runs/:id` and the `runs=*` frames after exhaustion; assert the failed status, the reason, and the attempts in order                                                            | The run ends in the ledger and the API still reports it active, so the UI shows a live run nobody is running                             |
| 7   | integration | A runner that fails twice and succeeds on the third attempt; assert `run.created`, the run proceeding, and two journalled failures                                                       | The bound is applied to the first failure, so a flaky vendor becomes a failed run and the fix is worse than the bug                      |
| 8   | integration | `TestClock` over the backoff window, counting real child spawns; assert one in flight per node and the intervals inside the policy's cap                                                 | The backoff is read from the constant rather than observed, and a concurrent second attempt slips through the `framing` set             |
| 9   | e2e         | The new sabotage row: the smoke scenario against a provider scripted to fail every turn; assert the run fails, names the reason and exits 1 within the smoke budget                      | The smoke test hangs to its own timeout instead of failing, which is the same silence one level up                                       |

**Notes / risks** — the shortcut here is a counter in `drive.ts`: three lines, correct-looking, and a
second retry policy that nothing reconciles with the node's own `RetryPolicy` the first time somebody
sets `maxAttempts: 5` in a plan. The other trap is the CLI half: making `run` exit by giving it a
timeout would make this test pass and would fail every legitimate multi-hour run, which is the whole
product. The exit is caused by the run reaching a terminal state, and nothing else.

---

### KAR-19.10 — Provider selection is explicit, and honest about what it picked _(added)_

|                 |                                                                                                                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                                                                                                                                                                                              |
| **Priority**    | P0                                                                                                                                                                                                                                                                                                       |
| **Size**        | M                                                                                                                                                                                                                                                                                                        |
| **Depends on**  | KAR-19.2 (admission, the refusal shape and the wording this amends), KAR-19.3 (`chooseProvider` in `live-chain.ts`, the selection this makes explicit), KAR-19.7 (`usableProviders` and the bundled ordering), EPIC-05 KAR-05.2 (the probed capability manifest) and KAR-05.3 (`PROVIDER_SPECS`, the one file allowed to name a vendor), KAR-05.8 (the exec-shim route this reconciles), EPIC-18 KAR-18.3 (`DeFlow run`'s argument parser and exit codes), KAR-18.4 and KAR-18.8 (`doctor`'s provider report and its state vocabulary) |
| **PRD**         | F3.1, F3.2, F3.5, NF7, NF8, NF10                                                                                                                                                                                                                                                                         |
| **Verified by** | EPIC-19-S65, EPIC-19-S66, EPIC-19-S67, EPIC-19-S68, EPIC-19-S69, EPIC-19-S70                                                                                                                                                                                                                             |

**As** an operator with more than one agent on my machine, **I want** to say which provider a run
uses and to be told which one it picked, **so that** I am never debugging a run against an agent I
did not know it had chosen.

**Third finding from the 2026-08-13 session, and it is the one that wasted the afternoon.** `doctor`
reported `claude`'s ACP adapter as missing and the bundled mock agent as the only usable provider —
and the run selected `claude` anyway, through the exec-shim path, and spawned the real vendor CLI.
Two problems, plus the mismatch underneath them:

1. **There is no way to say which provider to use.** The operator tried `--provider mock` and got
   `DeFlow run: unknown option "--provider"`. The flag does not exist, on a command whose entire job
   is to start a run on an agent.
2. **Nothing told the operator which provider was chosen, or by which route.** `chooseProvider`
   reduces `usableProviders(resolveProviderStates(roots))` and takes the first survivor, silently.
   The ACP-adapter route and the exec-shim route have materially different capabilities — the shim
   is what carries a `returns` contract (KAR-19.7), the ACP session is what carries streaming,
   permission negotiation and cancellation — so *which route* is not an implementation detail an
   operator can be spared.

**The decision this story records.** The two views must agree, and the honest direction is that
**`doctor` should report the exec-shim path as a usable route for `claude`**, not that admission
should stop selecting it. The reasoning, written down because it will be re-litigated otherwise:

- `chooseProvider` takes `spec.shim.bin` **on purpose** — a pre-execution turn is driven through the
  vendor's own CLI because the return contract rides on `structuredOutputFlag`, which only the CLI
  has. Refusing to select it would mean deleting the path the whole chain runs on, or demanding an
  ACP bridge for a turn that never opens an ACP session.
- So a machine with `claude` and no `claude-agent-acp` genuinely **can** frame, survey and plan. Its
  state is not *"unusable"* — it is *"usable on one route and not the other"*, and one word per
  provider cannot express that. `adapter-missing` was a true sentence about a machine and a false
  sentence about a run.
- Therefore provider state becomes **one answer per route** — `{ acp, shim }`, each `available` or
  `missing` — produced by one function that `doctor`, admission and selection all call.
  KAR-18.8's install sentence is unchanged and stays attached to the missing ACP route, because
  agent-node execution still needs the bridge; what changes is that `doctor` stops implying the
  machine can do nothing.
- **And the corollary this story owns:** a machine that can frame but cannot execute must be told so
  **at admission**, not at the first agent node, three minutes and one framing turn later. That is
  the same rule as KAR-19.2's *"refuse at submission, not after"*, applied to a partial capability
  rather than to none.

This **amends KAR-19.2 AC1** (*"resolves to a spawnable adapter"* becomes route-aware) and
**KAR-18.8's state vocabulary** (three states per provider become two answers per route); both
amendments are recorded in their own files rather than absorbed here, exactly as KAR-19.6 records
its amendment to KAR-15.5.

**Acceptance criteria**

1. `DeFlow run --provider <id>` exists and routes the run onto that provider. It is validated
   against the registry **before** anything is submitted: an id `PROVIDER_SPECS` does not contain is
   refused with a message naming the ids that are registered and, of those, which are usable on this
   machine, and the command exits `EX_USAGE` with no run created. The list is derived from the
   registry, never a literal kept by hand.
2. A registered provider that this machine cannot serve is refused with KAR-19.2's own refusal —
   `doctor`'s sentence from the same renderer, the typed code, exit **5** — and not with an argument
   error. Asking for something real that is not installed is an environment problem, and the two
   codes must not be confused.
3. Without `--provider`, selection is unchanged: `usableProviders`' order, bundled entries last
   (KAR-19.7 AC8). This story makes the choice statable, not different.
4. **The run states its choice up front, in all three surfaces.** Before the first turn, the CLI
   prints one line naming the provider, the resolved binary's absolute path and the route (`ACP
   adapter` or `exec shim`); the same three facts are recorded in the ledger on the `provider.probed`
   payload the run already writes, and are served on `GET /api/runs/:id` and rendered in the UI's run
   header. One function produces the sentence and three callers render it.
5. The route is named because it changes what the run can do. The stated route is the route actually
   taken by the next turn — asserted by comparing the announcement against the binary the child was
   spawned from — and a run whose route changes between phases says so again rather than announcing
   once and drifting.
6. `doctor` and admission answer the provider question through **one** function. `doctor`'s Agents
   section reports both routes per provider, admission reduces the same structure, and a source guard
   asserts there is one producer: a machine on which `doctor` says a route is usable and a run refuses
   it — or the reverse, which is what happened — fails the guard.
7. A provider usable only on the exec-shim route is admitted for the turns that route can serve and
   the operator is told, at admission, that agent-node execution needs the ACP bridge and how to
   install it. The run does not reach `plan.proposed` and then discover it cannot execute.
8. `--provider` is honoured everywhere the run touches a provider, or the run is refused. If the
   requested provider cannot serve one of the run's turns, that is stated at admission with the turn
   named; the run never silently falls back onto a different provider than the one it was told to
   use. A fallback that is not announced is the defect this whole story is about.
9. No provider is named outside `provider-registry.ts`. The new flag, its validation message, the
   announcement renderer and the route reducer all read the registry; `test/no-capability-table.test.ts`'s
   exemption list gains no second file.

**Test plan (TDD)** — write these first, in this order, and watch each fail before writing the
implementation.

| #   | Level       | Test                                                                                                                                                                                | Red when                                                                                                                            |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | unit        | `parseRunArgs` over `--provider mock`, `--provider=mock`, a missing value and an unregistered id; assert the accepted shape, `EX_USAGE`, and a message listing registry ids          | The option does not exist and the parser answers `unknown option "--provider"` — the reported defect, at the level it is cheapest at |
| 2   | integration | `--provider <registered but not installed>`; assert exit **5**, `doctor`'s own sentence and the typed refusal code, not an argument error                                            | A real provider that is missing is reported as a bad argument, and the operator edits their command line instead of their machine   |
| 3   | e2e         | Real binary, a `PATH` holding the bundled agent; `DeFlow run --provider mock --file spec.md`; assert the run executes on `mock` and the child spawned was the bundled binary         | The flag is accepted and ignored, which is worse than not having it                                                                 |
| 4   | integration | Assert the announcement's three facts (provider, absolute binary path, route) appear on stdout, on the `provider.probed` payload and on `GET /api/runs/:id`, from one producer       | Two surfaces say different things about the same run, which is how `doctor` and the run came to disagree in the first place         |
| 5   | integration | Compare the announced route against the binary the first child was actually spawned from                                                                                            | The announcement is computed from the registry's preference rather than from what was taken, and it lies on exactly the machine that matters |
| 6   | unit        | The route reducer over a table of resolutions — both routes, ACP only, shim only, neither — asserted to be the single input to `doctor`'s report and to `admitRun`                   | `doctor` folds the probe and selection does not, so one calls a provider unusable while the other spawns it                          |
| 7   | integration | A machine with the vendor CLI and no bridge; assert admission admits the chain, states at submission that node execution needs the bridge, and names the install command             | The run is admitted silently and dies at the first agent node, having spent a framing turn to learn what was knowable at second one  |
| 8   | integration | `--provider <p>` where `p` cannot serve one of the run's turns; assert a refusal naming the turn and assert no other provider was spawned                                            | The run quietly falls back and the operator debugs the wrong agent's output                                                         |
| 9   | unit        | The vendor-name guard over the new modules                                                                                                                                          | The flag's validation list is a hand-kept array, and it is stale the day a vendor is added                                          |

**Notes / risks** — the reconciliation is the risky half, not the flag. Making state per-route
touches `providerVerdict`, `usableProviders`, `admitRun` and `doctor`'s report at once, and the
tempting middle path — leave the states alone and special-case `claude` in `chooseProvider` — is a
vendor name in a file that is not allowed to have one, and it re-creates the mismatch under a
different name. The second risk is announcement fatigue: three lines of provider preamble on every
run is noise, so it is **one** line, and `--json` carries the same facts as fields rather than as
prose.

---

## Risks

| #   | Risk                                                                                                                                                                                                                                                | Mitigation                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **~30 days is over the ~15-day guidance**, and this epic arrives after the plan believed M1 was nearly assembled. It has also grown twice from the same cause — each by-hand run finds the next layer of silence.                                                                                                                                   | KAR-19.1 and KAR-19.2 alone (~5 days) already convert the reported failure from silence into a sentence, which is most of the operator harm. KAR-19.4's cost, gate and budget clauses can follow the completion clauses by a week if the schedule demands it — but KAR-19.5 cannot be the thing that slips, because it is the only story that stops this recurring, and KAR-19.7 (~3 days, added 2026-08-13) cannot slip either, because KAR-19.5 cannot be written without it. The three stories added later on 2026-08-13 (~7 days) are ordered by how much of the operator's afternoon each returns: KAR-19.9 first — an unbounded, silent retry is what turns any other defect into a lost afternoon — then KAR-19.8, then KAR-19.10. |
| R2  | **The temptation to write a second, simpler implementation** of framing or planning to get a run moving today.                                                                                                                                      | KAR-19.3 AC7 is a source guard, not a convention, and it is in the test plan before the wiring. One caller per step, asserted mechanically.                                                                                                                                                                                                                     |
| R3  | **The wiring may reveal that two components' contracts do not actually meet** — a packet shape, a capability field, an id that framing mints and the planner expects differently. Integration is where that is discovered, by construction.         | Any mismatch is fixed **in the owning epic's code with its own test**, and the divergence is written back into the architecture doc in the same session (AR-6). This epic's diff stays calls and scheduling; a mismatch that needs a mechanism change is a story in the owning epic, recorded under [README §9](../README.md#9-changing-the-plan).             |
| R4  | **A green smoke test that cannot go red** — the exact failure this epic exists to correct, reproduced one level up.                                                                                                                                 | KAR-19.5 AC4's sabotage table: every link cut in turn, every cut asserted to fail. A row that passes fails the story.                                                                                                                                                                                                                                          |
| R5  | **The e2e slice is already well past the ~5 budget** [14-testing-strategy.md](../../14-testing-strategy.md) sets, and this epic adds eleven (EPIC-19-S1, S10, S16, S24, S33, S34, S37, S44, S58, S64, S65 — S32 having been re-levelled to `integration` by KAR-19.4's amendment).                                                      | Eleven is the honest count and it is recorded here rather than absorbed. S44 is the ninth and is the one that makes four of the others runnable at all — an e2e against a real binary on a machine with no vendor CLI is exactly what KAR-19.3's and KAR-19.4's amendments recorded as impossible today. Four of them (S1, S16, S24, S32) are chain assertions nothing below e2e can make; the smoke pair (S33, S34) is the epic's product; S10 and S37 are exit codes and a verified process-group kill, neither of which exists anywhere but in a process. Everything else was pushed down to `integration`, `web` or `unit` deliberately — KAR-19.6 spends one e2e out of seven scenarios for exactly that reason — and the budget line in 14 §2 should be restated as a per-epic figure rather than a global one. The three added on 2026-08-13 hold their level for the same reason: a hung process, a non-zero exit code and a spawned vendor binary are all facts about processes, and S58 and S64 in particular are assertions that a command *returned*, which nothing below e2e can make. |
| R8  | **Widening the cancel path could turn a refusal into a deletion.** `422 spec_not_approved` is a blunt rule, but it is currently the only thing standing between a mistyped run id and a terminal event on someone else's run.                        | KAR-19.6 changes what `cancel` does and nothing about what `pause` and `resume` do, keeps `404 run_not_found` ahead of every other check in `planRunControl`'s asserted order, and ends the run with events rather than deleting anything — every artifact stays inspectable on disk (NF8), which is what makes a mistaken cancel recoverable reading rather than lost work.                                                                    |
| R6  | **Cold start plus framing plus compilation may not fit the smoke test's 90 s budget** on a cold CI runner, and the reflex will be to raise the number.                                                                                              | The budget is asserted by the test's own timeout and the number is written into this file. Raising it is a plan change with a written reason, not an edit — and the first place to look is the probe cache, measured at 441 ms cold and 8 ms warm in KAR-18.2's Notes.                                                                                          |
| R9  | **KAR-19.10's per-route provider state touches shipped admission behaviour** — `providerVerdict`, `usableProviders`, `admitRun` and `doctor`'s report at once, on a path KAR-19.2 and KAR-19.7 both already assert against.                          | The direction is decided in writing in KAR-19.10 rather than in a commit, the two amendments it makes (KAR-19.2 AC1, KAR-18.8's vocabulary) are recorded in those stories' own files, and AC6's guard is a single producer for all three callers — so a future divergence fails a test instead of an afternoon. The alternative that is explicitly refused is a `claude` special case inside `chooseProvider`, which would put a vendor name in a file not allowed to have one. |
| R10 | **KAR-19.9's fix can overshoot**: a bound applied too eagerly turns a flaky vendor into a failed run, which is worse than the bug for anyone on a rate-limited plan.                                                                                  | AC7 and its test are the counterweight and are written before the bound: two failures then a success must still reach `run.created`. The ceiling is the node's own `RetryPolicy` under KAR-06.5 — one policy, tunable in a plan — and AC2's source guard fails the day a second one appears in `drive.ts`.                                                                                                                                                                    |
| R7  | **Fixtures recorded from the pre-fix system may encode the broken shape**, so a projection tuned to them could disagree with a live run.                                                                                                            | The smoke test never reads a fixture. Once it passes, re-recording [03 §6.2](../../03-local-development.md)'s fixtures from real runs is the immediate follow-up, and any projection that changes as a result is a finding rather than a surprise.                                                                                                              |

---

**Related:** [Flows](../flows/EPIC-19-live-run-pipeline-flows.md) · [Board](../board.md) ·
[EPIC-04](./EPIC-04-mock-agent.md) ·
[EPIC-10](./EPIC-10-task-intake.md) · [EPIC-11](./EPIC-11-dynamic-planning.md) ·
[EPIC-06](./EPIC-06-orchestrator.md) · [EPIC-18](./EPIC-18-cli-packaging.md) ·
[05-durable-execution.md](../../05-durable-execution.md) ·
[06-planning-and-replanning.md](../../06-planning-and-replanning.md) ·
[11-api-and-realtime.md](../../11-api-and-realtime.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
