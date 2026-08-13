# EPIC-19 flows — The live run pipeline, end to end

> Behavioural specification for [EPIC-19](../epics/EPIC-19-live-run-pipeline.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 13 August 2026

## Actors

| Actor                 | Description                                                                                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Operator**          | The engineer at a terminal who typed `DeFlow run --file <path>` and watched nothing happen. Every scenario here is written from what they can observe                    |
| **`DeFlow` CLI**      | `packages/cli` — `run`, `status`, `doctor`. In the smoke scenarios it is the **built binary**, not `src/`                                                                |
| **DeFlowd**           | The local daemon: the HTTP API, the SSE stream, the ticker, and the run driver this epic gives it                                                                        |
| **The ticker**        | `packages/daemon/src/ticker.ts` at ~1 Hz. It owns no policy and no waits — every wait is a `node_wake` row. `boot()` must actually start it                              |
| **The ledger**        | A file-backed SQLite database. `event` is the control plane; `io_chunk` is the data plane; `node_wake` is every wait in the system                                       |
| **Framing agent**     | An ACP session over `DeFlow-mock-agent`, scripted per scenario to return a valid draft, an invalid one, or a clarifying question                                         |
| **Provider registry** | EPIC-05's spec table. `spec.bin` is what DeFlow spawns; `spec.shim.bin` is the vendor CLI. The 2026-08-12 machine had the second and not the first                       |
| **Web application**   | `packages/web`, subscribed to `?runs=*` at the root route and to `?runs=<id>` on a run route                                                                             |
| **The smoke harness** | KAR-19.5's fixture-free path: real binary, real daemon, real ledger, real socket, mock agent. The only thing it fakes is the vendor                                      |

## Preconditions common to all flows

```gherkin
Background:
  Given a real git repository created with "git init -b main" in an fs.mkdtemp directory
  And GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_SYSTEM=/dev/null and forced author/committer identity
  And XDG_DATA_HOME points at a directory inside that same tmpdir, so no scenario touches ~/.DeFlow
  And "DeFlow init" has already run in that repository
  And DeFlow-mock-agent is symlinked onto a temp PATH as the only provider, unless a scenario says
      the PATH holds a vendor CLI without its adapter, or is empty
  And no credential variable — no *_API_KEY, no *_TOKEN — is present in any child environment (AR-1)
  And the ledger is a file-backed SQLite database, never ":memory:", because every resume and
      crash clause here depends on reopening it
  And time enters the engine through the injected Clock port, never Date.now()
  And no scenario calls vi.useFakeTimers() while DeFlowd or an agent child process is alive
  And the normalising snapshot serializer is registered before any snapshot is written, covering
      timestamps, run and node ids, durations, absolute paths, ports and worktree directory names
  And every kill-verification assertion excludes processes in state "Z"
  And no scenario reads a recorded fixture or the replay harness — that substitution is precisely
      what this epic exists to stop relying on
```

> The last line carries this epic. Every other flow file in the backlog may legitimately assert
> against a recorded ledger; here, a fixture would satisfy the assertion **without any of the code
> under test existing**, which is exactly how run `run_20260812T133934Z_468702` reached an operator.
> Where a scenario declares `web`, the substitution is the transport and never the events'
> provenance: the frames pushed in are the frames a live daemon emits, asserted elsewhere in this
> file at `e2e`.
>
> Two more carry unusual weight here. **`XDG_DATA_HOME` inside the tmpdir** is what makes the
> ticker, lease and crash scenarios safe to run beside a developer's own daemon. And **the injected
> `Clock`** is what makes the stall window in S4, the human suspension in S18 and the budget ceiling
> in S31 run in microseconds instead of hours — with no fake timers, so a mock agent child's real
> I/O still arrives.

## Flow index

| Scenario    | Title                                                                              | Verifies | Type        |
| ----------- | ---------------------------------------------------------------------------------- | -------- | ----------- |
| EPIC-19-S1  | **Happy path: submitting a task starts the run, and it is visible in two seconds** | KAR-19.1 | Happy path  |
| EPIC-19-S2  | **A run created while the UI is open appears in the list without a refresh**       | KAR-19.1 | Happy path  |
| EPIC-19-S3  | `GET /api/runs` lists a run that has been accepted but not yet framed              | KAR-19.1 | Happy path  |
| EPIC-19-S4  | **A run that cannot proceed says so instead of sitting silent**                    | KAR-19.1 | Failure     |
| EPIC-19-S5  | The daemon dies between `task.submitted` and framing; the wake survives            | KAR-19.1 | Recovery    |
| EPIC-19-S6  | Two submissions in the same millisecond, two runs, neither dropped                 | KAR-19.1 | Concurrency |
| EPIC-19-S7  | Three surfaces, one status string, at the same head sequence                       | KAR-19.1 | Edge case   |
| EPIC-19-S8  | A run submitted while no ticker is running starts when one does                    | KAR-19.1 | Recovery    |
| EPIC-19-S9  | **Happy path: a vendor CLI with no ACP adapter is refused at submission**          | KAR-19.2 | Happy path  |
| EPIC-19-S10 | **`DeFlow run` exits 5, and the refusal is in the ledger**                         | KAR-19.2 | Failure     |
| EPIC-19-S11 | The refusal names the mock agent as the way to proceed with nothing installed      | KAR-19.2 | Edge case   |
| EPIC-19-S12 | A usable machine is never refused, and pays no extra handshake                     | KAR-19.2 | Edge case   |
| EPIC-19-S13 | **One sentence, three surfaces: `doctor`'s words and no second wording**           | KAR-19.2 | Edge case   |
| EPIC-19-S14 | An adapter that resolves and then fails its handshake                              | KAR-19.2 | Failure     |
| EPIC-19-S15 | A refused run is terminal: the stream closes and the UI stops waiting              | KAR-19.2 | Failure     |
| EPIC-19-S16 | **Happy path: framing → spec → pin → recon → `PlanGraph` v1**                      | KAR-19.3 | Happy path  |
| EPIC-19-S17 | The graph is drawn as it is compiled, not after the first node result              | KAR-19.3 | Happy path  |
| EPIC-19-S18 | **Framing needs an answer: the run suspends rather than blocks**                   | KAR-19.3 | Edge case   |
| EPIC-19-S19 | No plan is compiled before the operator approves the spec                          | KAR-19.3 | Failure     |
| EPIC-19-S20 | Plan validation fails before a token is spent                                      | KAR-19.3 | Failure     |
| EPIC-19-S21 | Recon on a repository it does not recognise still produces planner input           | KAR-19.3 | Edge case   |
| EPIC-19-S22 | A crash between `spec.pinned` and `plan.proposed` does not re-frame                | KAR-19.3 | Recovery    |
| EPIC-19-S23 | **One implementation per step: no second planner, no second interview**            | KAR-19.3 | Edge case   |
| EPIC-19-S24 | **Happy path: the plan's nodes execute and the run completes**                     | KAR-19.4 | Happy path  |
| EPIC-19-S25 | **Agent output reaches the terminal while the node is still running**              | KAR-19.4 | Happy path  |
| EPIC-19-S26 | The same output reaches the web UI, and backfills after a reconnect                | KAR-19.4 | Happy path  |
| EPIC-19-S27 | Cost and node states arrive as they happen, not in one burst at the end            | KAR-19.4 | Edge case   |
| EPIC-19-S28 | A gate fails: the verdict is live, and the run says so                             | KAR-19.4 | Failure     |
| EPIC-19-S29 | A node fails permanently: a named reason, never an empty one                       | KAR-19.4 | Failure     |
| EPIC-19-S30 | A human gate mid-plan pauses the run and says which end it reached                 | KAR-19.4 | Edge case   |
| EPIC-19-S31 | A budget ceiling pauses rather than fails, and is resumable                        | KAR-19.4 | Edge case   |
| EPIC-19-S32 | `SIGKILL` mid-node: resume, and nothing executes twice                             | KAR-19.4 | Recovery    |
| EPIC-19-S33 | **Happy path: the live smoke test, real binary to executed node**                  | KAR-19.5 | Happy path  |
| EPIC-19-S34 | **Every link cut in turn, and the smoke test goes red for each**                   | KAR-19.5 | Failure     |
| EPIC-19-S35 | No vendor CLI, no credential, no network, no home directory touched                | KAR-19.5 | Edge case   |
| EPIC-19-S36 | It is in `pnpm test`, it is serialised, and it fits its budget                     | KAR-19.5 | Edge case   |
| EPIC-19-S37 | **Happy path: `DeFlow cancel <runId>` stops a live run and says how**              | KAR-19.6 | Happy path  |
| EPIC-19-S38 | The mode is stated, never guessed, and never escalated behind you                  | KAR-19.6 | Edge case   |
| EPIC-19-S39 | **A run that never started can finally be got rid of**                             | KAR-19.6 | Happy path  |
| EPIC-19-S40 | **The three stuck runs of 2026-08-12, cleared by one command each**                | KAR-19.6 | Edge case   |
| EPIC-19-S41 | Cancelling twice, an ended run, and a run that is not there                        | KAR-19.6 | Failure     |
| EPIC-19-S42 | A stopped run stops being live in every surface that lists runs                    | KAR-19.6 | Edge case   |
| EPIC-19-S43 | A crash mid-cancel finishes the cancel, it does not resume the run                 | KAR-19.6 | Recovery    |
| EPIC-19-S44 | **Happy path: a framing turn served by the bundled agent, no vendor CLI at all**   | KAR-19.7 | Happy path  |
| EPIC-19-S45 | Recon and planner turns come back schema-valid from the same binary                | KAR-19.7 | Happy path  |
| EPIC-19-S46 | **The registry says `native` because the binary is, and admission is untouched**   | KAR-19.7 | Edge case   |
| EPIC-19-S47 | The same turn twice: byte-identical, whatever the machine underneath               | KAR-19.7 | Edge case   |
| EPIC-19-S48 | A schema it cannot serve is refused, never approximated                            | KAR-19.7 | Failure     |
| EPIC-19-S49 | An invalid return can be scripted, so the refusal paths need no vendor CLI         | KAR-19.7 | Failure     |
| EPIC-19-S50 | EPIC-04's scenarios and recordings are byte-identical after the change             | KAR-19.7 | Edge case   |
| EPIC-19-S51 | The mock entry never becomes the machine's default provider                        | KAR-19.7 | Edge case   |

---

## EPIC-19-S1 — Happy path: submitting a task starts the run, and it is visible in two seconds

**Verifies:** KAR-19.1 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: intake hands off to framing

  Scenario: a submitted task actually starts
    Given a running DeFlowd with the mock agent as the only provider
    And the mock agent is scripted to return a valid "DeFlow.taskspecdraft.v1" document
    When the operator runs "DeFlow run --file spec.md"
    Then a "task.submitted" event is appended
    And a node_wake row for the framing step exists in the same transaction as that event
    And the ticker consumes that row within two tick intervals
    And a "run.created" event is appended within 2000 ms of "task.submitted"
    And the ledger for the run contains, in seq order, "task.submitted", "provider.probed",
        "run.created"
    And "DeFlow status" reports the run with a status that is not "task submitted"
    And the CLI's attached view has printed at least one line naming the framing step
```

**Notes:** this is the regression test for the reported defect. On 2026-08-12 run
`run_20260812T133934Z_468702` had exactly one event in the ledger and the operator had no
indication of it: the Then clauses above are the difference between that run and a working one, and
the `seq`-ordered assertion is what makes "it appended something eventually" insufficient.

---

## EPIC-19-S2 — A run created while the UI is open appears in the list without a refresh

**Verifies:** KAR-19.1 · **Type:** Happy path · **Automated at:** web

```gherkin
Feature: the run becomes visible

  Scenario: the root route is a live run list
    Given the web application is open at "/" with an SSE subscription to "?runs=*"
    And the list currently shows no runs
    When a "run.created" frame for run "r-new" arrives on that subscription
    Then a row for "r-new" appears in the list
    And no refetch of "GET /api/runs" was issued to make it appear
    And the page was not reloaded
    And clicking the row navigates to "/runs/r-new"
    And a subsequent "run.completed" frame for "r-new" updates that row in place
```

**Notes:** the operator had to type the run id into the address bar because the root route rendered
the plan graph with no run and no list. The global topic already exists for exactly this — its
membership is the four low-volume lifecycle kinds and nothing else — so a live list costs one
subscription rather than a poll or a firehose. The "no refetch" clause is the one that matters: a
list that re-fetches on an interval looks identical until the interval is long and the run is short.

---

## EPIC-19-S3 — `GET /api/runs` lists a run that has been accepted but not yet framed

**Verifies:** KAR-19.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: the run becomes visible

  Scenario: the documented list endpoint exists and hides nothing
    Given a run whose ledger contains only "task.submitted"
    And a second run that has reached "run.completed"
    When a client requests "GET /api/runs?limit=10"
    Then the response is 200 and lists both runs, newest first
    And each entry carries runId, status, title, createdAt, headSeq, planVersion and cost
    And the un-framed run is present with a status the operator can act on
    And "GET /api/runs?status=active" excludes the completed run and includes the un-framed one
    And an unauthenticated request to the same path is refused with 401
```

**Notes:** `GET /runs?status=&limit=&cursor=` has been in
[11 §6](../../11-api-and-realtime.md)'s endpoint table since the architecture was written and has
never existed. The un-framed clause is deliberate and is the trap: a list built from `RunState`
alone omits exactly the runs that are stuck before `run.created`, which are the only runs an
operator in this situation is looking for.

---

## EPIC-19-S4 — A run that cannot proceed says so instead of sitting silent

**Verifies:** KAR-19.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: silence is the defect

  Scenario: an accepted run stops advancing
    Given a run that reached "run.created" and then stopped advancing
    And nothing is in flight for that run
    When the TestClock advances past the stall window
    Then exactly one "run.stalled" event is appended, carrying watermarkSeq, idleMs and the empty
         running-node list
    And the run is not killed and no process is signalled
    And the CLI prints one line naming the run, how long it has been idle, and "DeFlow status"
    And the UI shows the run as stalled rather than as running
    When the TestClock advances ten further stall windows
    Then still exactly one "run.stalled" event exists for that run
```

**Notes:** F4.7's `run.stalled` is specified as _"surfaced, never auto-killed"_ and this is the
first path that appends it. The repeated-advance clause is the whole difference between a useful
signal and a log the operator learns to ignore — a detector that fires per tick produces one line a
second and trains exactly the habit that lost the afternoon.

---

## EPIC-19-S5 — The daemon dies between `task.submitted` and framing; the wake survives

**Verifies:** KAR-19.1 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: intake hands off to framing

  Scenario: a crash in the handoff window
    Given a task submitted through "POST /api/runs" that returned 201
    And the ticker has not yet consumed the framing wake
    When the daemon is SIGKILLed before the next tick
    And a new daemon boots over the same data directory
    Then the node_wake row for the framing step is still present
    And "boot()" performs "start-ticker" and the row is consumed
    And "run.created" is appended by the new daemon
    And no second node_wake row was created for the same framing step
```

**Notes:** this is why the wake is written in the same transaction as `task.submitted` rather than
after the response. [05 §10](../../05-durable-execution.md)'s argument is that a durable row is the
wait and a promise is not; split the pair and the lost half is the one nobody notices, because a run
that never comes back looks identical to a run that has not got there yet.

---

## EPIC-19-S6 — Two submissions in the same millisecond, two runs, neither dropped

**Verifies:** KAR-19.1 · **Type:** Concurrency · **Automated at:** integration

```gherkin
Feature: intake hands off to framing

  Scenario: two tasks arrive together
    Given a Clock pinned so both submissions carry the same timestamp
    When two tasks are submitted through "POST /api/runs" without awaiting between them
    Then two distinct runIds are minted
    And two distinct node_wake rows exist, one per run
    And both runs reach "run.created"
    And neither run's framing packet contains the other run's submitted text
```

**Notes:** the failure this guards is a wake key that is unique on `(reason)` or on a timestamp
rather than on the run, in which case the second submission silently inherits the first's row and
one of the two runs never starts — the same symptom as the reported defect, arriving intermittently
and therefore much harder to diagnose.

---

## EPIC-19-S7 — Three surfaces, one status string, at the same head sequence

**Verifies:** KAR-19.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: the run becomes visible

  Scenario Outline: the CLI, status and the API agree
    Given a run whose ledger has been advanced to <state>
    When "DeFlow run --attach", "DeFlow status" and "GET /api/runs" each report that run at the
         same head sequence
    Then all three print the same status string
    And that string was produced by one function in @DeFlow/core

    Examples:
      | state                  |
      | submitted, not framed  |
      | awaiting spec approval |
      | planning               |
      | running                |
      | paused on a budget     |
      | completed              |
      | aborted                |
```

**Notes:** on 2026-08-12 the three surfaces said `task submitted`, `created — no nodes yet` and
`No plan yet` about the same run at the same instant, and each was locally defensible. Three
independently defensible descriptions of one state is how an operator concludes the problem is
somewhere they have not looked.

---

## EPIC-19-S8 — A run submitted while no ticker is running starts when one does

**Verifies:** KAR-19.1 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: intake hands off to framing

  Scenario: a submission the daemon was not around to drive
    Given a data directory containing a run with "task.submitted" and a due framing wake
    And no daemon is running
    When "DeFlow up" boots a daemon over that data directory
    Then recovery loads the wake and the ticker consumes it
    And "run.created" is appended without the operator resubmitting anything
    And the run's provenance still names the original submission's source and locator
```

**Notes:** the operator's instinct after a silent run is to submit it again, which is how one task
becomes three runs and two of them are abandoned. A daemon that picks up what it finds is what makes
resubmission unnecessary; the provenance clause is what makes the recovered run recognisable as the
one they submitted rather than a new one.

---

## EPIC-19-S9 — Happy path: a vendor CLI with no ACP adapter is refused at submission

**Verifies:** KAR-19.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: admission at submission time

  Scenario: claude is installed, its ACP bridge is not
    Given a fake "claude" shim on the temp PATH that answers "--version"
    And no "claude-agent-acp" anywhere on the PATH
    And no other provider resolves
    When a task is submitted through "POST /api/runs"
    Then the response is a 4xx carrying code "no_usable_provider"
    And the ledger for the run contains "task.submitted", then "provider.probed", then
        "run.aborted" with outcome "failed"
    And the "provider.probed" payload records claude as "adapter-missing" with its absolute
        resolved path
    And the refusal message names "@agentclientprotocol/claude-agent-acp" and the npm command that
        installs it
    And the run appears on the "?runs=*" topic as an ended run
```

**Notes:** this is the operator's actual machine. `boot-probe.ts` already promises the behaviour —
_"the daemon starts, reports what to install, and refuses to schedule agent nodes later (NF7)"_ —
and the refusal it promises was never implemented, so "refuses to schedule" became "never schedules,
and says nothing". Recording the refusal in the ledger rather than only in the HTTP response is what
makes it answerable six weeks later (NF8) and what puts it on the topic the UI already listens to.

---

## EPIC-19-S10 — `DeFlow run` exits 5, and the refusal is in the ledger

**Verifies:** KAR-19.2 · **Type:** Failure · **Automated at:** e2e

```gherkin
Feature: admission at submission time

  Scenario: the machine cannot host a run
    Given a running DeFlowd with an empty temp PATH
    When the operator runs "DeFlow run --file spec.md"
    Then the process exits 5
    And stderr carries the refusal sentence, wrapped and without a stack trace
    And the on-disk ledger contains the run and its "run.aborted"
    And the command returned in under five seconds
    And "RUN_EXIT_CODES" still has exactly seven members
```

**Notes:** exit 5 is `environmentUnusable`, already documented as _"this machine cannot host a
run"_, and the point of the last clause is that this scenario must not add an eighth code. The
five-second clause is not decoration: the value of refusing at submission is entirely in how quickly
it happens, and a refusal that takes as long as a framing attempt has spent the thing it was saving.

---

## EPIC-19-S11 — The refusal names the mock agent as the way to proceed with nothing installed

**Verifies:** KAR-19.2 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: admission at submission time

  Scenario Outline: every refusal offers the zero-install path
    Given a probed manifest in state <state>
    When the refusal message is rendered
    Then it names DeFlow-mock-agent as shipping in this package
    And it states that a run against it needs no vendor CLI, no credential and no network
    And it names the exact flag to use

    Examples:
      | state                                 |
      | no provider resolves at all           |
      | vendor CLI present, adapter missing   |
      | adapter present, handshake failed     |
```

**Notes:** the mock agent is how a person evaluates DeFlow before installing anything, and how every
test in this repository runs. Attaching the hint only to the zero-providers case — the tempting
shortcut, since that reads as the "new user" case — sends the far more common `adapter-missing`
operator to npm before they have any evidence the tool is worth it.

---

## EPIC-19-S12 — A usable machine is never refused, and pays no extra handshake

**Verifies:** KAR-19.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: admission at submission time

  Scenario: the green path
    Given the mock agent resolves and its capability manifest is in the ledger
    When a task is submitted through "POST /api/runs"
    Then the response is 201
    And no "run.aborted" is appended
    And admission spawned no child process of its own
    And the time between the request and the response is within the same envelope as a submission
        with admission disabled
```

**Notes:** admission is a read of the persisted manifest, not a probe. A check that re-handshakes
every vendor on every submission would put a second of latency on the one path that has to feel
instant, and would make the NF3 argument in KAR-18.2's `--timings` table meaningless — the probe was
measured at 441 ms cold and 8 ms warm precisely because it is not repeated.

---

## EPIC-19-S13 — One sentence, three surfaces: `doctor`'s words and no second wording

**Verifies:** KAR-19.2 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: admission at submission time

  Scenario: the words are already written
    Given a machine state where "claude" resolves and "claude-agent-acp" does not
    When the Agents section of "doctor", the admission refusal body and the CLI's stderr line are
         each rendered
    Then all three contain the same sentence, byte for byte
    And the string "claude is not installed" appears in none of them
    And a source guard finds exactly one function producing that sentence
    And no module added by this story contains a second install-hint literal
```

**Notes:** KAR-18.8 already fought this argument and won it — every fact in _"claude is not
installed here"_ was true and the first four words were wrong, which is what stopped the rest of the
report being trusted. A second, friendlier wording written here would be correct on the day it is
written and drift within a month; the guard is what makes that structurally impossible rather than a
thing to remember.

---

## EPIC-19-S14 — An adapter that resolves and then fails its handshake

**Verifies:** KAR-19.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: admission at submission time

  Scenario: installed but broken
    Given an adapter shim on the temp PATH that resolves and exits non-zero on "initialize"
    When a task is submitted through "POST /api/runs"
    Then the refusal code is "provider_handshake_failed" and not "no_usable_provider"
    And the child's own stderr appears in the message, trimmed but not paraphrased
    And the message does not say the adapter is not installed
    And the message names the resolved path of the binary that failed
```

**Notes:** a broken bridge reported as an absent one is the worst outcome available: the operator
uninstalls and reinstalls a package that was already there, twice, before suspecting the daemon.
Carrying the child's own stderr is what turns that loop into a single reading.

---

## EPIC-19-S15 — A refused run is terminal: the stream closes and the UI stops waiting

**Verifies:** KAR-19.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: admission at submission time

  Scenario: a refusal that ends things
    Given an SSE client subscribed to a run that is about to be refused
    When admission refuses the run
    Then the client receives the "run.aborted" frame
    And the subscription for that run closes cleanly rather than continuing with keepalives only
    And "GET /api/runs/:id" reports a terminal status carrying the typed refusal code
    And the UI renders the run as ended with the reason, never as "created — no nodes yet"
    And the CLI's attached view stops rather than waiting
```

**Notes:** _"created — no nodes yet"_ is the string the operator actually stared at, and it was
truthful. The defect is that it was also the final state, with nothing in any surface saying so.
A keepalive-only tail on a run that will never emit again is the same defect one layer down.

---

## EPIC-19-S16 — Happy path: framing → spec → pin → recon → `PlanGraph` v1

**Verifies:** KAR-19.3 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: the live chain to a plan

  Scenario: the whole pre-execution chain runs
    Given a running DeFlowd with the mock agent scripted to return a valid draft
    When the operator submits a task and approves the spec at the F1.3 gate
    Then the ledger contains, in seq order, "task.submitted", "provider.probed", "run.created",
         "run.spec.approved", "spec.pinned", "plan.proposed"
    And the recon facts recorded before compilation each carry provenance
    And "compilePlanV1" received the spec, the recon facts and the probed capability manifest
    And the compiled PlanGraph has at least two nodes and validates
    And each event was appended as its step completed, not batched at the end
```

**Notes:** every function in this chain exists, is exported and has a passing suite; none of them
had a caller that ships. The "not batched" clause is what makes the graph appear while it is being
built rather than in one frame at the end, which is the difference between supervising a run and
being told about it afterwards.

---

## EPIC-19-S17 — The graph is drawn as it is compiled, not after the first node result

**Verifies:** KAR-19.3 · **Type:** Happy path · **Automated at:** web

```gherkin
Feature: the live chain to a plan

  Scenario: a plan with no results yet is still a plan
    Given the web application is open at "/runs/r1" with an empty run store
    When a "plan.proposed" frame carrying a four-node PlanGraph arrives
    Then four nodes are rendered
    And the empty-state text "No plan yet" is no longer shown
    And no "node.started" event was required to draw them
    When a later "plan.patched" frame adds a fifth node
    Then five nodes are rendered without a full re-layout of the four
```

**Notes:** _"No plan yet. A run's graph appears here as soon as its first plan is compiled."_ was
the honest report of an empty ledger. This scenario asserts the other half of that sentence, which
had never been exercised against a live compilation because no live compilation existed.

---

## EPIC-19-S18 — Framing needs an answer: the run suspends rather than blocks

**Verifies:** KAR-19.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: the live chain to a plan

  Scenario: a clarifying question
    Given the mock agent is scripted to ask one clarifying question
    When the framing wake is consumed and the interview runs
    Then "human.requested" and a node_wake row with reason "human_gate" are written in one
         transaction
    And no promise, timer or worker is held open across the suspension
    And the daemon's CPU use returns to idle
    When the TestClock advances six hours
    And the operator answers through "POST /runs/:id/nodes/:nodeId/respond"
    Then "human.responded" and the deletion of that wake row happen in one transaction
    And the interview resumes and the run reaches "run.created"
```

**Notes:** EPIC-13 already built this — a `human` node blocks a branch for six hours at the cost of
one SQLite row — and `runFramingInterview` already writes the pair. What was missing is the caller
that resumes. Holding an in-memory deferred instead would work in every unit test and lose the
question on the first daemon restart, which is the failure mode where the run simply never returns.

---

## EPIC-19-S19 — No plan is compiled before the operator approves the spec

**Verifies:** KAR-19.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: the live chain to a plan

  Scenario: the F1.3 gate is a real gate
    Given a run sitting at the spec approval gate
    When the TestClock advances by an hour
    Then no "plan.proposed" event exists
    And "compilePlanV1" was not called
    And no agent child process was spawned since the framing turn ended
    When the operator rejects the spec instead of approving it
    Then the run does not compile a plan at any point afterwards
    And the framing interview is re-run rather than the rejection being ignored
```

**Notes:** the tempting optimisation is to compile speculatively while the operator reads the spec,
so the graph is ready the instant they click approve. It is the wrong trade: F1.3 exists because the
spec is what every gate verdict is measured against, and a rejection that arrives after the spend
has already spent it.

---

## EPIC-19-S20 — Plan validation fails before a token is spent

**Verifies:** KAR-19.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: the live chain to a plan

  Scenario: a plan no gate can judge
    Given an approved spec with an acceptance criterion no gate in the plan covers
    When the plan is compiled and validated
    Then "plan.validation_failed" is appended naming the uncovered criterion
    And "run.needs_human" is appended with reason "plan-invalid"
    And no "node.started" event exists for the run
    And the run's accumulated cost is unchanged
    And the UI shows the run as needing a decision rather than as failed
```

**Notes:** validation before execution is the reason [06 §3](../../06-planning-and-replanning.md) is
titled _"Plan validation, before a token is spent"_. A run that stops here is a decision for the
operator, not an outcome, and rendering it as `failed` would train exactly the wrong response.

---

## EPIC-19-S21 — Recon on a repository it does not recognise still produces planner input

**Verifies:** KAR-19.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: the live chain to a plan

  Scenario: an unfamiliar repository
    Given a git repository with no package manifest, no lockfile and no recognised build system
    When recon runs as part of the live chain
    Then it records at least the facts it can establish — the head, the branch, the file tree shape
    And every recorded fact carries provenance
    And it does not throw, and it does not record a fact it did not observe
    And "compilePlanV1" is called with that reduced input and produces a plan that validates
```

**Notes:** this repository was docs-only until recently and the first real target may be anything.
Recon that throws on an unfamiliar tree turns the chain's silence into the chain's crash, which is
better but still not the answer; recon that invents a build command it never observed is worse than
either, because the plan then contains a gate that cannot pass.

---

## EPIC-19-S22 — A crash between `spec.pinned` and `plan.proposed` does not re-frame

**Verifies:** KAR-19.3 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: the live chain to a plan

  Scenario: resume from the pinned spec
    Given a run whose ledger ends at "spec.pinned"
    When the database is closed and a fresh engine is constructed over the same file
    And the daemon resumes the run
    Then the plan is compiled from the pinned spec
    And no framing turn is issued to any agent
    And the specHash carried into "plan.proposed" equals the one in "spec.pinned"
    And no second "run.created" is appended
```

**Notes:** re-framing on resume produces a second spec, a second `specHash`, and a plan judged
against criteria the operator never approved — a failure that is silent, expensive and only visible
weeks later when a gate verdict cites a criterion nobody recognises. The reopen-with-a-fresh-engine
shape is required here: `:memory:` cannot express it at all.

---

## EPIC-19-S23 — One implementation per step: no second planner, no second interview

**Verifies:** KAR-19.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: the live chain to a plan

  Scenario: the wiring did not become a rewrite
    Given the shipped source tree under "packages/*/src"
    When the call graph is scanned
    Then exactly one shipped module calls "runFramingInterview"
    And exactly one shipped module calls "compilePlanV1"
    And exactly one shipped module calls the plan validator
    And no module outside @DeFlow/daemon's plan package defines a function returning a PlanGraph
    And the caller added by this epic imports those functions rather than re-declaring them
```

**Notes:** the pressure to write a small local planner "just to see a graph" arrives at about hour
three of this story and is entirely reasonable in the moment. It is also how a codebase acquires two
answers to the same question, one of which is tested and one of which ships. The guard is
mechanical because the judgement is not reliable at hour three.

---

## EPIC-19-S24 — Happy path: the plan's nodes execute and the run completes

**Verifies:** KAR-19.4 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: nodes execute

  Scenario: a four-node plan runs to completion
    Given a validated four-node plan compiled from a mock-agent-scripted spec
    When the ticker drives the run
    Then each node appends "node.scheduled", "node.started" and "node.completed" in that order
    And no node is started twice, including across a tick before its own "node.started" landed
    And the concurrency ceiling is never exceeded
    And "run.completed" is appended exactly once
    And "DeFlow run" exits 0
    And the rendered transcript matches a file snapshot through the normalising serializer
```

**Notes:** this closes the deferral EPIC-18 recorded twice — KAR-18.3 AC1 and KAR-18.6 AC2 — where
the completion half was honestly marked unreachable rather than faked. The "started twice" clause is
`executeRun`'s own `admitted` set, and it matters here because a shipped caller that re-implements
admission reintroduces the window the executor already closed.

---

## EPIC-19-S25 — Agent output reaches the terminal while the node is still running

**Verifies:** KAR-19.4 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: output streams to both surfaces

  Scenario: live, not buffered
    Given the mock agent is scripted to emit chunk A, wait on a signal the test controls, then
          emit chunk B
    When the node runs under "DeFlow run"
    Then chunk A is observed on the CLI's stdout before the test releases the signal
    And chunk B is observed after
    And the node has not yet appended "node.completed" when chunk A is observed
    And with "--json", the same content arrives as one JSON object per line with no ANSI escape
```

**Notes:** the operator saw no output at all, and the failure that would replace it is subtler:
output buffered and flushed at `node.completed`, which is indistinguishable from working on a
two-second mock node and useless on a ten-minute real one. Releasing the signal from the test is
what makes "before" mean something.

---

## EPIC-19-S26 — The same output reaches the web UI, and backfills after a reconnect

**Verifies:** KAR-19.4 · **Type:** Happy path · **Automated at:** web

```gherkin
Feature: output streams to both surfaces

  Scenario: the node output view over a live node
    Given the node output view is open on a running node
    When io_chunk frames arrive incrementally
    Then the rendered output grows without a full re-render of what is already shown
    When the connection is dropped and re-established
    Then the client re-requests from its last fromSeq
    And the resulting chunk set is exactly equal to the produced set — no gap and no duplicate
    And the view does not scroll away from a position the operator had pinned
```

**Notes:** the `io_chunk` data plane is separate from the control-plane `event` table precisely so a
chatty agent cannot drown the ledger, and both the terminal reattach and this view read the same
tail. Re-fetching from zero on reconnect is the easy implementation and duplicates everything
already on screen, which on a long node is worse than losing the connection.

---

## EPIC-19-S27 — Cost and node states arrive as they happen, not in one burst at the end

**Verifies:** KAR-19.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: nodes execute

  Scenario: the numbers move during the run
    Given a four-node plan where each node's scripted turn reports token usage
    When two of the four nodes have completed
    Then "GET /api/runs/:id" reports a cost greater than zero and less than the final cost
    And the four nodes report at least two distinct states between them
    And the run timeline has at least one bar per started node
    And "run.completed" is not the first frame carrying a cost figure
```

**Notes:** F9.1 is _live_ per-node, per-provider, per-run accounting, and a cost that only appears at
the end satisfies the letter of a projection test and none of the purpose — the ceiling in
[EPIC-14](../epics/EPIC-14-cost-governance.md) can only pause a run it is watching.

---

## EPIC-19-S28 — A gate fails: the verdict is live, and the run says so

**Verifies:** KAR-19.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: nodes execute

  Scenario: a deterministic gate that does not pass
    Given a plan whose typecheck gate is scripted to fail
    When the run reaches that gate
    Then the gate verdict event is appended as the gate resolves, before the run ends
    And the verdict is visible in the CLI's transcript and in the UI before the terminal event
    And the run reaches a terminal state whose classification maps to exit 1
    And that exit code came from "classifyRun" and from no other derivation
```

**Notes:** the exit code's single derivation is KAR-18.3's own rule and the red it was written
against — _"exit code is derived at three call sites and they disagree"_. Adding a run driver is
exactly the change that tempts a fourth derivation, because the driver knows the outcome first.

---

## EPIC-19-S29 — A node fails permanently: a named reason, never an empty one

**Verifies:** KAR-19.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: nodes execute

  Scenario: a permanent failure ends the run out loud
    Given a node scripted to fail with a permanently classified error
    When retries are exhausted according to the node's own policy
    Then "node.failed" carries a reason from the closed failure taxonomy
    And the run reaches a terminal state
    And the CLI's final line names that reason and is not empty
    And the UI shows the same reason on the same node
    And no surface prints "undefined" or an empty reason string
```

**Notes:** the closed taxonomy exists (KAR-02.10) so that a failure is answerable rather than
described. The empty-string clause is the one that catches the realistic bug: a driver that reads the
reason off a field the failure path never populated, producing `run failed:` with nothing after it —
which is silence wearing a different hat.

---

## EPIC-19-S30 — A human gate mid-plan pauses the run and says which end it reached

**Verifies:** KAR-19.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: nodes execute

  Scenario: the plan contains a human node
    Given a validated plan with a "human" node between two agent nodes
    When execution reaches that node
    Then the run halts at "needs-human" rather than concluding
    And the open gate appears in the cross-run approval queue
    And "DeFlow run --no-wait" exits 4, naming the gate and the command that answers it
    And "DeFlow run" without "--no-wait" keeps watching and resumes when the gate is answered
    And the downstream agent node runs only after the answer
```

**Notes:** the executor's `HALTED_STATUSES` already distinguishes _deliberately stopped_ from
_finished_, and the reason it must is here: concluding a run because there is nothing to do and
nothing in flight would turn every human gate into a completed run with half a plan unexecuted.

---

## EPIC-19-S31 — A budget ceiling pauses rather than fails, and is resumable

**Verifies:** KAR-19.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: nodes execute

  Scenario: the ceiling is a decision
    Given a run budget ceiling set below the scripted spend of the plan
    When the accumulated cost crosses the ceiling mid-run
    Then "run.needs_human" is appended with reason "budget"
    And no node is killed and no work already done is discarded
    And "DeFlow run" exits 3
    When the operator raises the ceiling and resumes
    Then the run continues from where it stopped rather than restarting
    And no completed node is executed a second time
```

**Notes:** F4.6 and F9.2 both say pause, not fail, and the exit code table already separates 3 from
1 for this reason. Collapsing a ceiling into a failure is how an operator learns to treat both as
noise, which removes the ceiling's only purpose.

---

## EPIC-19-S32 — `SIGKILL` mid-node: resume, and nothing executes twice

**Verifies:** KAR-19.4 · **Type:** Recovery · **Automated at:** e2e

```gherkin
Feature: nodes execute

  Scenario: a crash in the middle of the run
    Given a four-node plan with two nodes completed and one in flight
    When the daemon is SIGKILLed
    And a new daemon boots over the same data directory
    Then the two completed nodes are not re-executed
    And the interrupted attempt is reconciled through the effect journal
    And the run reaches the same terminal state it would have reached uninterrupted
    And no process remains in the killed daemon's group, excluding entries in state "Z"
    And "PRAGMA integrity_check" on the ledger returns "ok"
```

**Notes:** the `Z`-state exclusion is the verified false-negative trap: after a *successful* group
SIGKILL, `ps` still lists grandchildren as zombies with `ppid=1`, and a naive assertion concludes
the kill failed when it did not. The rest of this scenario is EPIC-06's contract, asserted for the
first time over a run that a shipped code path actually drove.

---

## EPIC-19-S33 — Happy path: the live smoke test, real binary to executed node

**Verifies:** KAR-19.5 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: the smoke test that would have caught this

  Scenario: an operator's command, all the way through
    Given the built DeFlow binary, not the source tree
    And an fs.mkdtemp git repository with "DeFlow init" already run
    And DeFlow-mock-agent symlinked onto a temp PATH as the only provider
    And no recorded fixture and no replay harness anywhere in the scenario
    When the operator command "DeFlow run --file spec.md" is executed as a child process
    Then the on-disk ledger contains, in seq order, "task.submitted", "run.created",
         "plan.proposed", "node.started", "node.completed" and a terminal "run.*"
    And the compiled plan has at least two nodes
    And at least one node executed
    And agent output appeared on the child's stdout while the run was still in flight
    And the process exit code is the one classifyRun prescribes for that terminal state
```

**Notes:** this is the test whose absence is the epic. Every substitution it declines is one that
would have let 2026-08-12 pass green: the source tree instead of the binary, a function call instead
of a process, a fixture instead of a ledger the run itself wrote. The only fake is the vendor, and it
is a real executable speaking real ACP over a real subprocess.

---

## EPIC-19-S34 — Every link cut in turn, and the smoke test goes red for each

**Verifies:** KAR-19.5 · **Type:** Failure · **Automated at:** e2e

```gherkin
Feature: the smoke test that would have caught this

  Scenario Outline: a test that cannot go red is worse than none
    Given the smoke scenario, with <link> removed from the shipped path
    When the smoke test runs
    Then it fails
    And its failure message names <link>
    And it does not fail with a timeout alone

    Examples:
      | link                                   |
      | the framing wake written at intake     |
      | the ticker started by boot()           |
      | the call that reaches run.created      |
      | the call that compiles the plan        |
      | the call that executes the plan        |
      | the io_chunk producer                  |
```

**Notes:** the first row is the actual 2026-08-12 defect, and it is in a table with five siblings
because the same class of gap existed at four other joints simultaneously. The "not a timeout alone"
clause matters: a smoke test that only ever fails by running out of time tells the next reader
nothing about which link is missing, which is most of the diagnosis.

---

## EPIC-19-S35 — No vendor CLI, no credential, no network, no home directory touched

**Verifies:** KAR-19.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: the smoke test that would have caught this

  Scenario: it runs anywhere, including a fresh CI runner
    Given the smoke harness's child environment
    Then no variable matching "*_API_KEY" or "*_TOKEN" is present
    And XDG_DATA_HOME resolves inside the scenario's tmpdir
    And GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM are "/dev/null" with a forced identity
    And the temp PATH contains DeFlow-mock-agent and no vendor CLI
    And no outbound socket is opened for the duration of the run
    And nothing under the developer's home directory is read or written
```

**Notes:** a smoke test that quietly depends on the developer's machine is a smoke test that goes
red for the first colleague and is then disabled. NF1 says DeFlow works with no network beyond the
provider CLIs' own; here there is no provider CLI, so the correct number of outbound sockets is zero
and it is asserted rather than assumed.

---

## EPIC-19-S36 — It is in `pnpm test`, it is serialised, and it fits its budget

**Verifies:** KAR-19.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: the smoke test that would have caught this

  Scenario: it cannot rot
    Given "vitest.config.ts" and the root "package.json"
    Then a "smoke" project slice exists
    And "pnpm test" includes it without an extra flag
    And the slice declares fileParallelism false and a single worker
    And its declared timeout is the budget written in the epic
    When the smoke test runs on the author's machine
    Then it completes within that budget
    And on failure it preserves its tmpdir under DeFlow_KEEP_TMP=1 and uploads it in CI
```

**Notes:** the whole failure this epic corrects lived in the gap between "we should run that" and
"we ran it", so a smoke test behind a flag would reproduce it exactly. The budget is asserted by the
test's own timeout so that a regression in cold start or scheduling latency is a red test rather
than a slow afternoon that someone eventually raises the number for.

---

## EPIC-19-S37 — Happy path: `DeFlow cancel <runId>` stops a live run and says how

**Verifies:** KAR-19.6 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: one command stops a run

  Scenario: the command the detach sentence has always named
    Given a running DeFlowd driving a plan with one mock-agent node in flight
    And the operator has never opened the token file
    When the operator runs "DeFlow cancel <runId>"
    Then the command posts to "POST /api/runs/<runId>/cancel" with mode "cooperative"
    And it prints which mode it used and that the agent is being allowed to flush its transcript
    And "run.cancel.requested" with mode "cooperative" is appended
    And the agent answers with stopReason "cancelled" and its trailing updates are accepted
    And "run.aborted" is appended and the run's projected status is "aborted"
    And the process exit code is the one classifyRun prescribes for that terminal state

  Scenario: the same command, forcefully
    When the operator runs "DeFlow cancel <runId> --force"
    Then the request carries mode "forceful"
    And the output names the session/cancel → SIGTERM → grace → SIGKILL ladder and that the
        transcript may be truncated
    And the response is sent only after the kill is verified
    And no process remains in the agent's process group, excluding entries in state "Z"
```

**Notes:** `'DeFlow cancel <runId>' to stop` has been printed by KAR-18.3 AC3's detach sentence since
2026-08-11 and has never resolved to a command. The Z-state exclusion is the verified false-negative
trap from [09 §11.1](../../09-workspace-and-safety.md), and it belongs here rather than only in
EPIC-06 because this is the first scenario in which an **operator's own command** claims a kill
happened — a claim the endpoint deliberately makes only after verifying it.

---

## EPIC-19-S38 — The mode is stated, never guessed, and never escalated behind you

**Verifies:** KAR-19.6 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: one command stops a run

  Scenario Outline: every invocation says what it did
    Given the cancel command invoked as <invocation>
    When its request and its first line of output are rendered
    Then the request body carries mode <mode>
    And the output names <mode> and what it means for the agent's transcript

    Examples:
      | invocation                   | mode        |
      | DeFlow cancel r1             | cooperative |
      | DeFlow cancel r1 --force     | forceful    |

  Scenario: a mode the daemon does not have
    When the operator runs "DeFlow cancel r1 --mode aggressive"
    Then the command refuses before any HTTP request is made
    And the refusal lists exactly the members of CANCEL_MODES
    And the wording is the daemon's own invalid_request sentence, not a second one

  Scenario: cooperative does not become forceful by itself
    Given a cooperative cancel whose agent has not answered
    When the run is inspected
    Then its status is still "cancelling"
    And no SIGTERM and no SIGKILL was sent
    And the command's output names "--force" as the operator's next move
```

**Notes:** the daemon already refuses to guess — its `invalid_request` body says that guessing "would
be guessing about whether that transcript survives" — and a CLI that quietly defaults undoes that
refusal one layer up. The third scenario is the one with teeth: an automatic escalation would make
`--force` decorative and would silently truncate the transcript of every long-running node, which is
the artefact an operator cancels a run in order to read.

---

## EPIC-19-S39 — A run that never started can finally be got rid of

**Verifies:** KAR-19.6 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: a way out for a run that never started

  Scenario: cancelling a run parked before approval
    Given a run whose ledger contains only "task.submitted"
    And no F1.3 gate is open for it, because framing never ran
    When "POST /api/runs/<runId>/cancel" is called
    Then the response is 200 rather than 422 "spec_not_approved"
    And "run.cancel.requested" with mode "cooperative" and "run.aborted" are appended at
        consecutive seq in one transaction
    And no read of the run at any point observes the status "cancelling"
    And no new event kind, no new RunStatus and no new RUN_OUTCOMES member was introduced

  Scenario: pause and resume are unchanged
    Given the same run
    When "POST /api/runs/<runId>/pause" and "POST /api/runs/<runId>/resume" are called
    Then both are refused with 422 "spec_not_approved"
    And the ledger is unchanged

  Scenario: cancelling a run parked at the open spec gate
    Given a run suspended at the F1.3 approval gate
    When "POST /api/runs/<runId>/cancel" is called
    Then "human.responded" with optionId "abandon" is appended
    And the gate's node_wake row is consumed in the same transaction
    And "run.aborted" is appended by the same shipped module as the previous scenario's
```

**Notes:** `abandonRun` opens with `if (!gateIsOpen(events)) throw new SpecGateNotOpen(...)`, and
`planRunControl` refuses every verb while the status is `created` or `awaiting-spec-approval`. Between
them, a run that was accepted and never framed can be stopped by neither route — which KAR-18.3's
amendment recorded as _"a real hole in the daemon's write surface"_ and deferred. The second scenario
is the guard on the fix: widening `cancel` must not widen `pause`, which would leave the API claiming
to have paused a run that was never admitting work.

---

## EPIC-19-S40 — The three stuck runs of 2026-08-12, cleared by one command each

**Verifies:** KAR-19.6 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: a way out for a run that never started

  Scenario Outline: the reported runs, by their exact ledger shapes
    Given a run whose ledger is exactly <shape>
    When the operator runs "DeFlow cancel <runId>" once
    Then the run reaches "aborted"
    And the same code path handled it as every other row of this table
    And "DeFlow status" afterwards does not list it among active runs
    And "GET /api/runs?status=active" does not include it
    And every artifact the run produced is still readable under .DeFlow/runs/<runId>/

    Examples:
      | shape                                  |
      | task.submitted                         |
      | task.submitted, provider.probed        |
```

**Notes:** the operator's three runs — `run_20260812T133401Z_318740`,
`run_20260812T133514Z_ed4f12` and `run_20260812T133934Z_468702` — are two of the first shape and one
of the second, and the "same code path" clause is what stops the fix being two special cases that
each work on the run the author happened to test with. The artifacts clause is NF8: a cancel ends a
run, it does not delete one, which is what makes a mistaken cancel a reading exercise rather than
lost work.

---

## EPIC-19-S41 — Cancelling twice, an ended run, and a run that is not there

**Verifies:** KAR-19.6 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: one command stops a run

  Scenario: the second cancel changes nothing
    Given a run that has already been cancelled
    When it is cancelled again
    Then the response is 200 carrying the seq already in the log
    And the ledger contains exactly one "run.aborted" for that run
    And the CLI exits 0 and says the run had already ended, and how

  Scenario: cancelling a completed run
    Given a run that reached "run.completed"
    When it is cancelled
    Then nothing is appended
    And the response names the terminal status the run already had

  Scenario: a run id that does not exist
    When "DeFlow cancel run_does_not_exist" is run
    Then the response is 404 "run_not_found"
    And the CLI exits non-zero with that sentence and no stack trace
    And no event was appended to any run
```

**Notes:** KAR-15.5 AC2's rule — a repeat answers `200` with the existing `seq` rather than an error
— now has to hold on a path it was never exercised against. The failure it prevents is visible rather
than theoretical: two `run.aborted` events for one run make the run list render the same run ending
twice and make the timeline disagree with itself, on the exact screen the operator opened to confirm
the cleanup worked.

---

## EPIC-19-S42 — A stopped run stops being live in every surface that lists runs

**Verifies:** KAR-19.6 · **Type:** Edge case · **Automated at:** web

```gherkin
Feature: a stopped run stops looking live

  Scenario: the run list updates in place
    Given the web application is open at "/" with a subscription to "?runs=*"
    And the list shows the run as running
    When a "run.aborted" frame for that run arrives on the subscription
    Then the row updates in place rather than duplicating or disappearing
    And no refetch of "GET /api/runs" was issued to make it update
    And the row's status string is the one runStatusLabel produces for "aborted"
    And a subsequent "GET /api/runs?status=active" response does not contain the run
    And "GET /api/runs" with no filter still lists it, with its terminal status
```

**Notes:** the operator's complaint was not only that the runs would not stop — it was that they kept
appearing. A cancel that ends the ledger but leaves three surfaces rendering the run as live has
moved the defect rather than fixed it, and the `runStatusLabel` clause is KAR-19.1 AC6 holding for a
fourth state: three independently defensible descriptions of one run is how 2026-08-12 became an
afternoon.

---

## EPIC-19-S43 — A crash mid-cancel finishes the cancel, it does not resume the run

**Verifies:** KAR-19.6 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: one command stops a run

  Scenario: the daemon dies between the request and the ladder
    Given a run with a node in flight whose ledger ends at "run.cancel.requested"
    When the daemon is SIGKILLed before the ladder finished
    And a new daemon boots over the same data directory
    Then the run's reduced status is "cancelling", not "running"
    And no StartNode is issued for it on any subsequent tick
    And the cancel is carried to completion and "run.aborted" is appended exactly once
    And the operator issues no second command
    And no process remains in the old daemon's agent group, excluding entries in state "Z"
```

**Notes:** this is [05 §10.4](../../05-durable-execution.md)'s argument — _"never in-memory flags"_ —
asserted against the one path where breaking it is most tempting, because the ladder is a sequence of
timed signals and a timer is the natural way to write one. A cancel that does not survive a restart
resumes a run the operator has already decided to stop, which is worse than never having cancelled
it: they are no longer watching.

---

## EPIC-19-S44 — Happy path: a framing turn served by the bundled agent, no vendor CLI at all

**Verifies:** KAR-19.7 · **Type:** Happy path · **Automated at:** e2e — the admission clauses only,
in `e2e/mock-only-run.test.ts`; the completion clauses are **deferred to the composition-root
binding** (see below)

```gherkin
Feature: the bundled agent can answer a turn that carries a schema

  Scenario: a run framed on a machine with nothing installed
    Given a temp PATH holding DeFlow-mock-agent and no vendor agent CLI of any kind
    And no "claude", "codex", "gemini" or ACP adapter resolves anywhere on that PATH
    When the operator runs "DeFlow run --file spec.md"
    Then admission does not refuse the run and no "run.aborted" with code "no_usable_provider" is
         appended
    And the framing turn is served by DeFlow-mock-agent over a real ACP session
    And the document it returns validates against "DeFlow.taskspecdraft.v1"
    And the ledger contains, in seq order, "task.submitted", "run.created", "plan.proposed",
        "node.started" and "node.completed", ending in a terminal "run.*"
    And no variable matching "*_API_KEY" or "*_TOKEN" is present in any child environment
    And no outbound socket is opened and nothing under the developer's home directory is read
```

**Notes:** this is the run [KAR-19.3](../epics/EPIC-19-live-run-pipeline.md)'s amendment recorded as
impossible: every schema-bearing turn needs a `structuredOutputFlag`, only the two vendor exec-shim
paths declare one, and the bundled agent speaks ACP only — so a machine with no vendor CLI could not
get past framing, and this epic's own Definition of Done could not be demonstrated. The clause that
carries the scenario is the PATH: it is asserted to hold no vendor CLI rather than merely to hold the
mock agent, because a developer's own `claude` leaking in would make this pass for the wrong reason
and on their machine only.

**What is automated, and what is not (2026-08-13).** `e2e/mock-only-run.test.ts` carries the scenario
down to its *"admission does not refuse the run"* line. The two `Given`s are asserted rather than
arranged, and mechanically: the PATH is searched for every binary `PROVIDER_SPECS` itself declares
for a non-bundled provider, so a vendor added later is covered without anyone remembering to. Two
further facts are asserted because without them that line could be true for the wrong reason — the
one `provider.probed` row is `mock` and its `capsJson` is a real ACP `initialize` answer from the
binary on that PATH, and the run is parked on the durable `node_wake` row KAR-19.1 AC1 requires
rather than dropped. It is red on the pre-story machine: with bundled entries dropped from
`usableProviders`, `DeFlow run` exits 5 with `no_usable_provider`, which is the state this story
exists to end.

**The remaining lines are blocked one level below this story**, exactly as
[KAR-19.7](../epics/EPIC-19-live-run-pipeline.md)'s amendment records. `DeFlow up` binds no
`runFraming`, `advanceRun` or `executeNodes` port, because no `FramingAgent`, `ReconAgent`,
`PlannerAgent` or agent-node `NodePerformer` over a real process exists in `src/` yet — the chain is
driven end to end only against scripted ports, in
`packages/daemon/test/integration/live-{chain,execution}.test.ts`. `node.completed` needs one thing
more: the default plan's agent nodes return `DeFlow.finding.v1`, and `SCHEMA_GENERATORS` serves the
four documents the *chain* needs and no node return, so a node run against the bundled agent today
would fail its handoff rather than complete. The credential clause is about a turn's child
environment, built by `buildChildEnv`, which nothing on this path calls yet; the only child this
machine spawns is the capability probe, and that one is handed the daemon's environment on purpose.
These close together with KAR-19.3's test plan #1 and KAR-19.4's #1 and #8.

---

## EPIC-19-S45 — Recon and planner turns come back schema-valid from the same binary

**Verifies:** KAR-19.7 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: the bundled agent can answer a turn that carries a schema

  Scenario Outline: every schema the live chain needs
    Given the built DeFlow-mock-agent binary
    And the schema flag its own registry entry declares
    When it is spawned for schema id <schema> with that flag and a schema file
    Then exactly one document is written on the return channel and nothing else
    And that document validates against "schemas/<schema>.json" under ajv
    And the process exits zero

    Examples:
      | schema                     |
      | DeFlow.taskspecdraft.v1    |
      | DeFlow.reconsurvey.v1      |
      | DeFlow.plangraph.v1        |

  Scenario: the default plan is big enough to be a plan
    When the planner schema is served with no scripted scenario
    Then the returned PlanGraph has at least two nodes
    And it passes the plan validator without a repair round
    And each recon fact in "DeFlow.reconsurvey.v1" carries a "DeFlow.reconfact.v1" provenance field
```

**Notes:** three turns, not one — framing alone would leave the chain stopping at recon, which is the
same defect one joint later. The "nothing else on the return channel" clause is what makes the
document parseable without a heuristic: a mock that prefixes a friendly line is indistinguishable
from a vendor that does, and the parser written to tolerate it is the parser that silently accepts a
truncated return. The two-node clause exists because
[KAR-19.5](../epics/EPIC-19-live-run-pipeline.md) AC2 asserts a compiled plan has at least two nodes,
and a one-node default would make that clause unreachable against the only agent the smoke test has.

---

## EPIC-19-S46 — The registry says `native` because the binary is, and admission is untouched

**Verifies:** KAR-19.7 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: the declaration is true, and the guard is not the thing that changed

  Scenario: the registry entry earns its answer
    Given PROVIDER_SPECS' "mock" entry
    Then "providerStructuredOutput('mock')" reports "native"
    And the flag the entry declares and the flag the binary's argument parser reads are one
        exported constant, referenced by both
    And a test spawns the real binary with the entry's own flag rather than comparing two literals

  Scenario: admission reaches the same answer through the questions it already asks
    Given a probed capability row for "mock"
    When "admitFraming" is called for a framing node routed to "mock"
    Then it returns null — the run is admitted
    When the probed capability row is absent
    Then it raises a NodeFailureError, exactly as it does for every other provider

  Scenario: no provider is named outside the one file allowed to name one
    Given the shipped source of "framing-admission.ts", "admission.ts" and "structured-output.ts"
    Then none of them contains the literal "mock", "claude", "codex" or "gemini"
    And "provider-registry.ts" remains the only file exempted by
        "test/no-capability-table.test.ts"
```

**Notes:** the tempting fix was one line in `admitFraming` — let the mock through, or drop the
`structuredOutputFlag` requirement — and both are refused for the same reason KAR-10.2 AC3 gives:
_"the fallback for a spec is not a softer contract, it is a different adapter"_. That guard is what
stops a **real** provider being handed a contract it cannot honour, and a special case for the test
double would leave the production branch exercised by nothing anybody runs. The third scenario is the
mechanical form of that: if admission cannot name the mock agent, it cannot be special-cased for it.

---

## EPIC-19-S47 — The same turn twice: byte-identical, whatever the machine underneath

**Verifies:** KAR-19.7 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: determinism is not negotiable

  Scenario: the same inputs give the same bytes
    Given the same schema id, the same prompt and the same seed
    When the turn is served twenty times across twenty fresh spawns
    Then all twenty documents are byte-identical
    When the same turn is served again under a changed cwd, TMPDIR, TZ and locale
    Then the document is byte-identical to the first twenty
    And no "Date.now()", no unseeded random source and no directory enumeration order reaches the
        document
    And every id and time-like field in it comes from the mock agent's own deterministic sources

  Scenario: the smoke test plans the same plan twice
    Given two runs of the smoke scenario over two fresh tmpdirs
    Then the two compiled PlanGraphs are equal once run and node ids are normalised
```

**Notes:** F3.7 calls the mock provider _"deterministic, free"_ and NF9 puts nondeterminism outside
the adapter boundary; a returned document carrying a timestamp or an unseeded id would flake every
downstream snapshot in the repository, at roughly the rate that trains a person to re-run the suite
rather than read the failure. The changed-`TZ` clause is not decoration — a date rendered through the
host locale is the realistic version of this bug and it passes on the author's machine indefinitely.

---

## EPIC-19-S48 — A schema it cannot serve is refused, never approximated

**Verifies:** KAR-19.7 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: the bundled agent can answer a turn that carries a schema

  Scenario Outline: a turn it cannot honour ends loudly and empty
    Given the built DeFlow-mock-agent binary
    When it is spawned with the schema flag and <input>
    Then it exits non-zero
    And its stderr names the schema id it was asked for
    And its stderr lists the schema ids it can serve
    And exactly zero bytes are written on the return channel
    And no partial or placeholder document is emitted

    Examples:
      | input                                     |
      | an unknown schema id                      |
      | a path to a schema file that is not there |
      | an unreadable schema file                 |
      | a known id with no generator behind it    |
```

**Notes:** a mock that guesses is this epic's own failure mode reproduced inside the test double —
the chain goes green on a document nothing actually produced, and the next reader trusts it. The
zero-bytes clause is the one with teeth: an empty object validates against a permissive schema, and a
caller that receives one has no way to tell a served turn from an unserved one. Listing the servable
ids on stderr is what turns "the smoke test failed" into a one-line diagnosis.

---

## EPIC-19-S49 — An invalid return can be scripted, so the refusal paths need no vendor CLI

**Verifies:** KAR-19.7 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: the failure returns are scriptable too

  Scenario Outline: the caller's own refusal path fires with nothing installed
    Given a temp PATH holding DeFlow-mock-agent and no vendor agent CLI
    And a scenario file scripting the turn to return <return>
    When the live chain reaches that turn
    Then <caller refusal> fires
    And no vendor binary was spawned at any point

    Examples:
      | return                            | caller refusal                                    |
      | a document that fails validation  | KAR-10.2's invalid-draft repair path              |
      | a truncated document              | the adapter's own parse failure, named            |
      | a valid but unsatisfiable plan    | "plan.validation_failed" and "run.needs_human"    |

  Scenario: the unscripted default is always valid
    Given no scenario file for the turn
    When the turn is served
    Then the returned document validates
    And making a turn fail requires a scenario file rather than the absence of one
```

**Notes:** the refusal paths are the half of the chain that is hardest to reach and easiest to leave
untested, and until now reaching them at all needed an installed vendor CLI persuaded to misbehave.
The last scenario is the trap the shape has to avoid: if an absent scenario file produced an invalid
return, every test that forgot one would exercise the repair loop and nobody would notice the happy
path had stopped being covered.

---

## EPIC-19-S50 — EPIC-04's scenarios and recordings are byte-identical after the change

**Verifies:** KAR-19.7 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: EPIC-04's guarantees are binding on this story

  Scenario: nothing that already worked changed
    Given every shipped scenario under "packages/mock-agent/scenarios/"
    And every recording replayed from "recordings/"
    When each is run against the binary built after this story
    Then its transcript is byte-identical to the one produced before this story
    And EPIC-04's suite passes unchanged, with no fixture re-recorded and no expectation relaxed

  Scenario: a turn with no schema flag is the turn it always was
    When the binary is invoked without the structured-output flag, including for every
         pathological scenario EPIC-04 ships
    Then its behaviour and its bytes are exactly what they are today
    And the structured path is entered only when a schema is supplied
```

**Notes:** the mock agent is what every test in this repository runs against, so a change to its
default turn is a change to several hundred expectations at once — and the version of that change
which "only" re-records the fixtures has quietly rewritten the baseline that made the fixtures worth
having. Gating the new path on the flag's presence is what keeps this story's cost proportional to
what it adds, and it is asserted rather than intended.

---

## EPIC-19-S51 — The mock entry never becomes the machine's default provider

**Verifies:** KAR-19.7 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: the new entry is not a routing hazard

  Scenario: a real provider is always preferred
    Given a resolved provider table holding a real vendor adapter and "mock"
    When a run's provider is selected
    Then "mock" is not chosen
    And a run routes onto "mock" only where the operator's PATH or configuration puts it there
    And the selection order is asserted at source rather than described in a comment

  Scenario: doctor tells the truth about a binary that ships in the tarball
    Given the bundled DeFlow-mock-agent resolves
    When "doctor" renders its Agents section
    Then the entry is reported as "installed"
    And no "npm install -g" action is printed for it
    And the string "not installed" does not appear for it
```

**Notes:** the failure this guards is quiet and expensive: a run that "succeeded" against an agent
nobody chose, on a machine where the real provider was sitting right there. And the `doctor` half is
KAR-18.8's rule holding for a new entry — the words have to fit the machine, and telling an operator
to `npm install -g` a package that shipped in the same tarball is the same class of wrong as
_"claude is not installed"_ on a machine where it resolves.

---

**Related:** [EPIC-19](../epics/EPIC-19-live-run-pipeline.md) · [Board](../board.md) ·
[Delivery plan](../README.md) · [05-durable-execution.md](../../05-durable-execution.md) ·
[06-planning-and-replanning.md](../../06-planning-and-replanning.md) ·
[11-api-and-realtime.md](../../11-api-and-realtime.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
