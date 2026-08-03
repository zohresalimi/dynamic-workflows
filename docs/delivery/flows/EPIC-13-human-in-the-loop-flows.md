# EPIC-13 flows — Human-in-the-loop and approvals

> Behavioural specification for [EPIC-13](../epics/EPIC-13-human-in-the-loop.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor                 | Description                                                                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator**          | The engineer driving DeFlow. **The primary actor throughout this file** — every scenario below exists because a decision needs a person                               |
| **DeFlowd**           | The local daemon: scheduler, ledger, 1 Hz ticker                                                                                                                      |
| **Scheduler**         | `decide(state, now)` plus the ticker that reads `node_wake` — the component that suspends and resumes                                                                 |
| **Approval queue**    | The `GET /api/approvals` projection: everything waiting on the Operator, across all runs                                                                              |
| **Provider agent**    | A `DeFlow-mock-agent` subprocess. Scenario 3 of its script — `session/request_permission` per chosen option, including `cancelled` — is what makes this epic testable |
| **Permission policy** | The pure policy function from [EPIC-08](../epics/EPIC-08-safety-model.md). Auto-answers routine requests; escalates the gated categories                              |
| **Browser tab**       | One `EventSource`-shaped connection per tab, opened once at app start, filtered server-side                                                                           |

## Preconditions common to all flows

```gherkin
Background:
  Given a DeFlow workspace initialised in a git repository on branch "main"
  And the ledger is a file-backed SQLite database — never ":memory:" — opened with
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000"
  And "seq" is INTEGER PRIMARY KEY AUTOINCREMENT, so cursors are never reused
  And DeFlowd holds the flock on "<dataDir>/DeFlow.lock" and stamps daemon_epoch on every write
  And time enters the engine through an injected Clock port; tests advance it with clock.advance()
  And the scheduler's only use of setTimeout is the ticker's own sleep hint,
      setTimeout(min(nextWakeAt - now, 1000))
  And "DeFlow-mock-agent" is on a temp PATH, with --capabilities used to shape the adapter profile
  And no test in this file calls vi.useFakeTimers() while a child process is alive
```

> The file-backed database is not a preference. Half of this epic is _"is it still there after the
> daemon died?"_, and `:memory:` cannot be reopened after a simulated crash — it _"cannot test the
> one property that matters most"_ ([testing strategy §7](../../14-testing-strategy.md)). Every
> restart scenario below closes the database and constructs a **fresh engine over the same file**,
> which is the real code path a daemon restart takes.

## Flow index

| Scenario    | Title                                                                      | Verifies | Type        |
| ----------- | -------------------------------------------------------------------------- | -------- | ----------- |
| EPIC-13-S1  | Happy path: a `human` node blocks, the Operator approves, the run advances | KAR-13.1 | Happy path  |
| EPIC-13-S2  | Six hours of suspension for one row and zero CPU                           | KAR-13.1 | Happy path  |
| EPIC-13-S3  | The daemon restarts while a `human` node is pending — the gate survives    | KAR-13.1 | Recovery    |
| EPIC-13-S4  | The `setTimeout` footgun, asserted rather than commented                   | KAR-13.1 | Failure     |
| EPIC-13-S5  | Laptop sleep and a backwards clock do not move the gate                    | KAR-13.1 | Edge case   |
| EPIC-13-S6  | The deadline matrix: `fail`, `escalate`, `default`                         | KAR-13.1 | Edge case   |
| EPIC-13-S7  | The four option effects: approve, reject, edit, inject                     | KAR-13.1 | Edge case   |
| EPIC-13-S8  | Answering twice, and the transaction that makes it safe                    | KAR-13.1 | Failure     |
| EPIC-13-S9  | A pending approval is not a paused run                                     | KAR-13.1 | Concurrency |
| EPIC-13-S10 | The queue aggregates across concurrent runs in one call                    | KAR-13.2 | Happy path  |
| EPIC-13-S11 | Eight kinds, each carrying enough to decide without a second request       | KAR-13.2 | Edge case   |
| EPIC-13-S12 | `runs=*` carries approvals without the firehose                            | KAR-13.2 | Edge case   |
| EPIC-13-S13 | The panel went stale while the Operator was reading it                     | KAR-13.2 | Failure     |
| EPIC-13-S14 | An already-decided patch answers with what actually happened               | KAR-13.2 | Failure     |
| EPIC-13-S15 | The queue is a projection, and it survives a restart intact                | KAR-13.2 | Recovery    |
| EPIC-13-S16 | Resolving an item, and adding a run panel without a second connection      | KAR-13.2 | Concurrency |
| EPIC-13-S17 | Interjection happy path: a correction lands and the run is not discarded   | KAR-13.3 | Happy path  |
| EPIC-13-S18 | An adapter that cannot steer says so, with a `202`                         | KAR-13.3 | Failure     |
| EPIC-13-S19 | `pause-and-inject` resumes the same attempt with the same idempotency key  | KAR-13.3 | Edge case   |
| EPIC-13-S20 | Interjecting a node that finished while the Operator was typing            | KAR-13.3 | Failure     |
| EPIC-13-S21 | The guidance is an attributed segment, not a spliced prompt                | KAR-13.3 | Edge case   |
| EPIC-13-S22 | Routine permission requests never reach the Operator                       | KAR-13.4 | Happy path  |
| EPIC-13-S23 | An escalation carries enough context to decide in five seconds             | KAR-13.4 | Happy path  |
| EPIC-13-S24 | The four `PermissionOptionKind` values, and the run scope of `_always`     | KAR-13.4 | Edge case   |
| EPIC-13-S25 | `cancelled` is an outcome, not an error                                    | KAR-13.4 | Edge case   |
| EPIC-13-S26 | An escalation nobody answers                                               | KAR-13.4 | Failure     |
| EPIC-13-S27 | `mediatedExecution: false` is refused scheduling, never silently escalated | KAR-13.4 | Failure     |
| EPIC-13-S28 | The daemon restarts while a permission escalation is outstanding           | KAR-13.4 | Recovery    |

---

## EPIC-13-S1 — Happy path: a `human` node blocks, the Operator approves, the run advances

**Verifies:** KAR-13.1 · **Type:** Happy path · **Automated at:** integration + e2e

```gherkin
Feature: Blocking human nodes (F8.1)

  Scenario: Approve the design-system swap before the write nodes start
    Given a plan with a "human" node "n_approve_scope" whose prompt is
          "Recon found 3 extra packages. Extend the migration scope?"
    And its options are
          | id      | label            | effect  |
          | yes     | Extend scope     | approve |
          | no      | Keep scope as-is | reject  |
    When the scheduler admits "n_approve_scope"
    Then the ledger contains "human.requested" carrying the node, the prompt and both options
    And the ledger contains "node.suspended" with until { kind: "human" }
    And a node_wake row exists for (runId, "n_approve_scope") with reason "human_gate"
    And the run status is "running"
    And the approval queue contains one item of kind "human-node" for this run

  Scenario: The Operator answers
    When the Operator posts { optionId: "yes" } to /api/runs/r1/nodes/n_approve_scope/respond
    Then the ledger contains "human.responded" with optionId "yes", an at timestamp and the responder
    And the node completes on the same attempt — no new idempotency key was minted
    And the node_wake row for it is deleted
    And the dependent write nodes are admitted on the next tick
    And the item disappears from the approval queue

  Scenario: Every part of that is traceable
    Then each of the three UI states — pending, answered, resumed — maps to a named ledger event
    And no in-memory "pending approvals" map exists in the daemon
```

**Notes:** the response being an _event_ is the load-bearing part. A flag on an object survives
neither a restart nor a timeline, and NF10 requires any state in the UI to trace to specific ledger
events — _"the Operator approved this at 14:12"_ is exactly the state someone asks about three days
later.

---

## EPIC-13-S2 — Six hours of suspension for one row and zero CPU

**Verifies:** KAR-13.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Long suspension costs one SQLite row (F4.8)

  Scenario: The Operator goes to a wedding
    Given a "human" node suspended at seq 4120
    And the run has no other runnable branch
    When clock.advance(hours(6)) is applied to the injected Clock
    Then the node is still suspended
    And exactly one node_wake row exists for it, unchanged
    And no events were appended between seq 4120 and the resume
    And zero agent child processes are alive for the run
    And the ledger file size is unchanged apart from WAL checkpointing

  Scenario: The wake fires when it should
    Given the node has a deadline wakeAt six hours out
    When the clock passes wake_at
    Then the ticker's "SELECT * FROM node_wake WHERE wake_at <= ?" returns the row on the next tick
    And the deadline path runs exactly once

  Scenario: Six hours costs microseconds in the suite
    Then the test completes in under one second of wall time
    And it never calls vi.useFakeTimers()
```

**Notes:** four problems collapse into this one mechanism — a six-hour human gate, laptop sleep
across that gate, crash-and-restart mid-wait, and retry backoff — so it is _"one code path,
exercised constantly, instead of four rarely-exercised ones"_
([05 §10.1](../../05-durable-execution.md)). The last scenario is why `Clock` is a port: with a
`FakeClock`, `clock.advance(hours(6))` exercises a six-hour gate in microseconds, and when it fails
you can print the clock's state instead of interrogating sinon's internals.

---

## EPIC-13-S3 — The daemon restarts while a `human` node is pending — the gate survives

**Verifies:** KAR-13.1 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: NF4 — run state survives daemon restart

  Scenario: SIGKILL mid-suspension
    Given a "human" node suspended at seq 4120 with a node_wake row and a queue item
    And two other runs also have pending approvals
    When DeFlowd is killed with SIGKILL — no cleanup, no flush, no handlers
    And a fresh engine is constructed over the same .DeFlow/ directory
    Then ledger replay reduces to a state in which the node is still suspended
    And exactly one "human.requested" event exists for that node — the restart did not re-request
    And the node_wake row is intact with the same wake_at
    And the approval queue contains the same three items with the same creating seqs
    And PRAGMA integrity_check returns "ok"

  Scenario: It is still answerable
    When the Operator posts { optionId: "yes" } after the restart
    Then "human.responded" is appended and the node resumes on the same attempt
    And no effect from before the crash is re-executed

  Scenario: The new daemon epoch does not invalidate the gate
    Then hello.daemonEpoch on the stream has increased
    And the browser tab detects the restart and re-hydrates from its persisted cursor
    And the pending item is present after re-hydration, not duplicated

  Scenario: The wake is not lost even if the crash landed inside the suspend transaction
    Given a fuzz harness that kills the daemon at a random point during admission
    Then across 50 iterations there is never a "human.requested" without its node_wake row
    And never a node_wake row with reason "human_gate" without its "human.requested"
```

**Notes:** this is the scenario that proves the thesis for this epic, and it is the reason the three
writes are one transaction. `SIGKILL` rather than `SIGTERM` is deliberate: _"SIGTERM tests your
shutdown handler; SIGKILL tests your durability"_
([testing strategy §11](../../14-testing-strategy.md)). The `daemonEpoch` scenario matters because
the tab's own recovery must not manufacture a duplicate item — `hello.daemonEpoch` is precisely how
a client detects that the daemon restarted under it ([11 §3.2](../../11-api-and-realtime.md)).

---

## EPIC-13-S4 — The `setTimeout` footgun, asserted rather than commented

**Verifies:** KAR-13.1 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Never use setTimeout for a wait

  Scenario: The verified overflow
    When setTimeout(fn, 2 ** 31) is scheduled
    Then fn fires after approximately 1 millisecond, not after 24.9 days
    And the only signal is a TimeoutOverflowWarning on stderr

  Scenario: A 30-day gate implemented the wrong way fires instantly
    Given a hypothetical implementation using setTimeout for a 30-day human gate
    Then it would resolve immediately and nothing in the logs would say "durability failure"

  Scenario: The implementation uses a node_wake row instead
    When a 30-day human gate is admitted
    Then a node_wake row is written with wake_at 30 days out
    And no timer longer than 1000 ms is created anywhere in the scheduler

  Scenario: The lint enforces it
    When "packages/core" and "packages/daemon/src/scheduler" are grepped for setTimeout
    Then the only hit is the ticker's sleep hint
    And CI fails on any other hit
```

**Notes:** **Verified 2026-08-02.** Node's maximum timer delay is `2^31 - 1` ms = 24.9 days;
passing `2**31` does not throw and does not clamp to the maximum
([05 §10.1](../../05-durable-execution.md)). Keeping the assertion in the suite rather than in a
comment is the point — a comment does not fail when someone "simplifies" the wait.

---

## EPIC-13-S5 — Laptop sleep and a backwards clock do not move the gate

**Verifies:** KAR-13.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: The wall clock is not monotonic

  Scenario Outline: Clock movement during a suspension
    Given a "human" node suspended with wake_at at T+6h
    When the injected clock <movement>
    Then the wake fires at wake_at and not before
    And no event is skipped or replayed
    And every ordering assertion in the test is written against seq, never against ts

    Examples:
      | movement                                    |
      | jumps forward 8 hours (laptop resumes)      |
      | moves backwards 2 hours (NTP correction)    |
      | moves backwards 1 hour (DST transition)     |
      | advances smoothly                           |

  Scenario: A sleeping laptop does not consume the wait
    Given the machine sleeps for 8 hours across the gate
    Then on wake the ticker finds the due node_wake row on its next 1 Hz tick
    And the node resumes normally
```

**Notes:** _"Journal timestamps for display; order strictly by `seq`. Any logic that compares two
timestamps to decide what happened first is a bug waiting for a daylight-saving transition"_
([05 §9.6](../../05-durable-execution.md)). Timers do not fire during laptop sleep at all, which is
the second independent reason the wait is a row.

---

## EPIC-13-S6 — The deadline matrix: `fail`, `escalate`, `default`

**Verifies:** KAR-13.1 · **Type:** Edge case · **Automated at:** unit + integration

```gherkin
Feature: HumanNode.deadline

  Scenario Outline: What happens when nobody answers in time
    Given a "human" node with deadline { wakeAt: T+2h, onTimeout: "<onTimeout>", default: "<default>" }
    When the clock passes wakeAt with no response
    Then <outcome>

    Examples:
      | onTimeout | default | outcome                                                                  |
      | fail      | —       | the node fails with a typed reason and the branch is failed              |
      | escalate  | —       | a second, higher-visibility "human.requested" is appended, still pending |
      | default   | no      | "human.responded" is appended with optionId "no" and by "policy"         |

  Scenario: A default naming an option that does not exist is caught at plan time
    Given deadline { onTimeout: "default", default: "maybe" } and options [yes, no]
    Then plan validation emits an error naming the node and the unknown option id
    And the run does not start

  Scenario: No deadline means wait indefinitely
    Given a "human" node with no deadline
    When the clock advances thirty days
    Then the node is still suspended and still costs one node_wake row
```

**Notes:** the third example is the branch KAR-13.4 reuses for permission escalations, where the
declared default is `reject_once`. Catching the unknown option id at plan validation rather than at
expiry is the same economics as everywhere else in the system: _"the cheapest correctness gate"_
runs before a token is spent ([06 §3](../../06-planning-and-replanning.md)).

---

## EPIC-13-S7 — The four option effects: approve, reject, edit, inject

**Verifies:** KAR-13.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: options[{ id, label, effect }]

  Scenario Outline: Each effect
    Given a "human" node offering an option with effect "<effect>"
    When the Operator selects it
    Then <result>

    Examples:
      | effect  | result                                                                        |
      | approve | the node completes and its dependents are admitted                            |
      | reject  | the branch fails with a typed reason and dependents are marked dependency.failed |
      | edit    | the supplied payload replaces the node's output after validating against returns.schemaId |
      | inject  | the node completes and the Operator's text is carried into the dependents' packets |

  Scenario: An edit payload that fails validation is refused
    Given an "edit" response whose payload violates the node's returns.schemaId
    Then the response is rejected with a schema_violation error
    And no "human.responded" event is appended
    And the node stays suspended so the Operator can correct it

  Scenario: The injected text is attributed
    Given an "inject" response with text "Use the existing useToast composable, don't add a new one."
    Then the dependent node's context.built manifest contains a segment with provenance "human"
    And the segment text is byte-identical to what was submitted
```

**Notes:** the refusal in the second scenario keeps the node suspended rather than failing it. An
Operator who mistypes a JSON payload at 23:00 should get another go, not a failed branch — and
because the node's state is entirely in the ledger, "another go" costs nothing.

---

## EPIC-13-S8 — Answering twice, and the transaction that makes it safe

**Verifies:** KAR-13.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Writes are idempotent because they are event appends over a state machine

  Scenario: The Operator double-clicks
    Given a "human" node answered with optionId "yes"
    When a second respond with optionId "no" arrives
    Then the response is 409 with the original decision echoed
    And exactly one "human.responded" event exists for the node
    And the node's outcome reflects "yes"

  Scenario: Two browser tabs answer simultaneously
    Given two clients post different optionIds within the same tick
    Then exactly one succeeds and one receives 409
    And the ledger contains exactly one "human.responded"
    And the losing client can re-read the item and see what was decided

  Scenario: The response append and the wake-row delete are one transaction
    Given a fault injected between the two writes
    Then either both landed or neither did
    And a restart never finds an answered node still holding a node_wake row
```

**Notes:** _"Pausing a paused run is a no-op that returns the existing `seq` and `200`, not an error.
Approving an already-approved patch returns `409` with the original decision, so the UI can show what
actually happened rather than double-applying"_ ([11 §11](../../11-api-and-realtime.md)). The
difference between those two shapes is whether the second call carries a _different intent_, and it
does here.

---

## EPIC-13-S9 — A pending approval is not a paused run

**Verifies:** KAR-13.1 · **Type:** Concurrency · **Automated at:** integration

```gherkin
Feature: A human node blocks its dependents and nothing else

  Scenario: Three branches, one blocked
    Given a plan with branches A, B and C
    And branch B contains a suspended "human" node
    When the scheduler ticks
    Then nodes in A and C with satisfied deps continue to be admitted
    And nodes downstream of the human node in B are not admitted
    And the run status is "running", not "paused"
    And the approval queue shows one item while the run continues to make progress

  Scenario: A genuine pause is different
    When the Operator posts /api/runs/r1/pause
    Then "run.paused" is appended
    And no new nodes are admitted in any branch
    And in-flight nodes run to completion by default

  Scenario: The progress watermark still moves
    Given branches A and C are producing state transitions
    Then the stall detector does not fire while the human node waits
```

**Notes:** [06 §4.3](../../06-planning-and-replanning.md) states the same property for queued
patches — _"The run does not stall on it if other branches are runnable — the patch is pending, not
the run"_ — and it must be true for human nodes for the same reason: a run that halts entirely on
every approval turns a four-branch plan into a serial one.

---

## EPIC-13-S10 — The queue aggregates across concurrent runs in one call

**Verifies:** KAR-13.2 · **Type:** Happy path · **Automated at:** integration + e2e

```gherkin
Feature: One surface listing everything waiting on you (F8.3)

  Scenario: Three runs, four pending decisions
    Given run "r1" has a suspended "human" node from seq 4120
    And run "r2" has a queued PlanPatch from seq 880 and a needs-human verdict from seq 951
    And run "r3" has a budget.exceeded pause from seq 233
    When the Operator calls GET /api/approvals
    Then the response contains four items in one call
    And they are ordered oldest-first by creating seq: r3/233, r2/880, r2/951, r1/4120
    And each item carries runId, nodeId, kind, a summary, the creating seq and an age
    And no per-run request was made

  Scenario: Per-run counts for the run list badge
    Then the response also carries counts { r1: 1, r2: 2, r3: 1 }
    And the run list renders a badge without a second query
```

**Notes:** the ordering is by `seq` rather than by `ts` for the same reason everything else in the
system is: `seq` is the total order and the wall clock is not monotonic. Oldest-first is deliberate
— the item that has been blocking longest is the one costing the most.

---

## EPIC-13-S11 — Eight kinds, each carrying enough to decide without a second request

**Verifies:** KAR-13.2 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: The queue is not a list of links

  Scenario Outline: Each kind and its decision payload
    Given a run in the state described by "<source event>"
    Then the queue contains an item of kind "<kind>"
    And it carries "<payload>"

    Examples:
      | source event                                     | kind               | payload                                                        |
      | human.requested                                  | human-node         | prompt, options, deadline                                      |
      | plan.patch.proposed with a queued decision       | patch              | reason, estimate{costUsdDelta,blastRadiusFiles,maxPermission,replanDepth}, the plan diff |
      | gate.evaluated outcome needs-human               | gate-needs-human   | the verdict's findings, the reason, the gate id                |
      | node.failed reason effect.reconcile-unknown      | reconcile-unknown  | the effect row, the before and after reconciliation hashes     |
      | budget.exceeded                                  | budget             | scope, dimension, limit, actual                                |
      | run.needs_human reason churn                     | churn              | the repeated (node_id, request_hash) and the window contents   |
      | fact.invalidated with a non-empty taints list    | tainted            | the fact, its provenance, every tainted node                   |
      | an escalated session/request_permission          | permission         | command, args, cwd, resolved path, matched rule, node scope    |

  Scenario: reconcile-unknown is the one with no automatic answer
    Then the item's options are exactly "it ran" and "it didn't"
    And neither is preselected
    And the item explains that retrying might double-apply and skipping might drop the work

  Scenario: A tainted node is never auto-re-run
    Given three nodes marked taint "stale-input"
    Then they appear in the queue
    And no re-run was scheduled automatically
```

**Notes:** `reconcile-unknown` is rated **High** in the open-risks register (A1-5) precisely because
_"there is no correct automatic action"_ ([05 §9.3](../../05-durable-execution.md)) — the product
answer is this queue item, designed on day one rather than bolted on. The tainted case is the same
shape: _"Automatic re-running on invalidation is a very efficient way to build a loop that never
terminates"_ ([06 §7](../../06-planning-and-replanning.md)).

---

## EPIC-13-S12 — `runs=*` carries approvals without the firehose

**Verifies:** KAR-13.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: One SSE connection per tab, filtered server-side

  Scenario: The idle tab
    Given a browser tab opened one connection with GET /api/stream?runs=*&since=<cursor>
    And run "r2" is streaming heavy agent output
    When run "r2" appends "human.requested"
    Then the tab receives that frame within one tick
    And the tab received zero "node.progress" frames from r2
    And the tab received zero io_chunk data on this connection

  Scenario: The global topic's membership is exactly four kinds
    Then runs=* delivers run.created, run.completed, run.aborted and human.requested
    And nothing else

  Scenario: The connection budget is respected
    Given three run panels are open in one tab
    Then exactly one EventSource-shaped connection exists for that tab
    And subsequent fetch calls to /api/runs/... complete rather than queueing

  Scenario: Frames carry id: <seq> so a reconnect resumes exactly
    Then every ledger frame carries "id: <seq>"
    And a reconnect sends Last-Event-ID and the server resumes with "seq > ?"
    And a gap in seq values is not treated as data loss
```

**Notes:** the connection cap is an architecture constraint, not a tuning knob: HTTP/1.1 allows
about six connections per origin, an SSE connection never closes, and _"the failure mode is not an
error — it is that every subsequent `fetch` silently queues behind the streams, forever"_
([11 §2](../../11-api-and-realtime.md)). The last scenario is the other verified trap: a rolled-back
transaction burns `AUTOINCREMENT` values, so `seq` 4, 5, 7 is a healthy log and gap detection reports
false data loss.

---

## EPIC-13-S13 — The panel went stale while the Operator was reading it

**Verifies:** KAR-13.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Optimistic concurrency via ifLastSeq

  Scenario: A patch is auto-applied on the policy timer mid-read
    Given the Operator's panel rendered a queued patch at cursor 10891
    And the policy timer auto-applies a different patch at seq 10895, changing the decision surface
    When the Operator approves with ifLastSeq 10891
    Then the response is 409 with code "stale_cursor" carrying the current head
    And nothing was applied
    And the Operator's client re-hydrates from 10891 and re-renders

  Scenario: A head that advanced without changing the decision surface is not stale
    Given the run appended twenty node.progress events since the cursor
    When the Operator approves with the old ifLastSeq
    Then the write succeeds
    And the 409 is reserved for changes that actually affect the decision

  Scenario: A write without ifLastSeq is accepted
    Given the CLI posts an approval with no ifLastSeq
    Then the write is accepted on current state
    And the response carries the seq it appended
```

**Notes:** _"This is what stops an operator approving a patch on a panel that went stale while they
read it — a real hazard given that patches are auto-applied on a policy timer (F2.5)"_
([11 §11](../../11-api-and-realtime.md)). The middle scenario is what keeps it usable: a `409` on
every progress frame would train the Operator to retry blindly, which is the same failure as an
always-on approval dialog.

---

## EPIC-13-S14 — An already-decided patch answers with what actually happened

**Verifies:** KAR-13.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: 409 patch_already_decided

  Scenario: Two tabs, one patch
    Given tab A and tab B both show patch "p_07" as queued
    When tab A posts { decision: "approve" } and it succeeds
    And tab B posts { decision: "reject" }
    Then tab B receives 409 with code "patch_already_decided"
    And the body carries the original decision "approve", who made it and the seq
    And the plan was patched exactly once

  Scenario: A rejected patch is not a dead end
    Given patch "p_09" was rejected by the policy rule "replan-depth-exceeded"
    Then it still appears in the approval queue
    And the Operator can approve it explicitly, producing plan.patched with decision "approved"

  Scenario: The rejection itself is never silent
    Then "plan.patch.proposed" was recorded even for the rejected patch
    And "plan.patched" with decision "rejected" carries the ruleId
```

**Notes:** _"a rejection is a 'not without you', not a dead end"_
([06 §4.3](../../06-planning-and-replanning.md)). And _"No event means no UI, and 'the run silently
decided not to do the thing it decided to do' is unanswerable"_ — which is why the third scenario is
here rather than only in EPIC-11.

---

## EPIC-13-S15 — The queue is a projection, and it survives a restart intact

**Verifies:** KAR-13.2 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: No auxiliary pending table

  Scenario: Derived, not accumulated
    Given a run with five historical approvals, three resolved and two pending
    When the projection cache is deleted and the ledger is replayed from seq 0
    Then the resulting queue is identical to the cached one, asserted by snapshot
    And it contains exactly the two pending items

  Scenario: Restart with items pending
    Given three items pending across two runs
    When DeFlowd is SIGKILLed and restarted over the same directory
    Then the same three items are present, with the same creating seqs
    And none is duplicated
    And none triggers a second notification

  Scenario: An unknown event kind does not corrupt the queue
    Given the ledger contains an event kind this daemon build does not know
    Then the reducer ignores it and returns state unchanged
    And the queue is degraded, never corrupted, and the daemon does not crash-loop
```

**Notes:** the third scenario is the forward-compatibility rule applied here: _"A user who installs a
newer `DeFlowd`, starts a run, then downgrades, must get a daemon that skips the events it does not
understand rather than one that refuses to open the ledger"_
([04 §9.2](../../04-domain-model.md)). A queue that throws on an unknown kind takes the whole
approval surface down on a downgrade.

---

## EPIC-13-S16 — Resolving an item, and adding a run panel without a second connection

**Verifies:** KAR-13.2 · **Type:** Concurrency · **Automated at:** integration

```gherkin
Feature: Filter mutation without a reconnect

  Scenario: Resolution propagates on the existing connection
    Given a client subscribed with runs=* is showing three items
    When one is answered
    Then the resolving event arrives on the same connection
    And the client's projection drops the item without a refetch

  Scenario: Opening a run panel
    When the Operator opens a panel for run "r2"
    Then the client posts /api/stream/<streamId>/subscribe { runs: ["r2"] }
    And a "subscribed" control frame is received
    And the daemon backfills r2 from the client's current cursor before resuming live delivery
    And a "caught_up" frame with { runId: "r2", seq } marks the end of the backfill
    And no second connection was opened and no reconnect occurred

  Scenario: Control frames never reach the reducer
    Then hello, subscribed and caught_up are named SSE events
    And the ledger reducer only ever sees default-typed frames
```

**Notes:** the backfill-before-live ordering is the same two-phase drain the serving loop uses —
subscribe-then-drain-again, never subscribe-only, or every event committing between the last drain
and the subscription is lost ([11 §5](../../11-api-and-realtime.md)).

---

## EPIC-13-S17 — Interjection happy path: a correction lands and the run is not discarded

**Verifies:** KAR-13.3 · **Type:** Happy path · **Automated at:** integration + e2e

```gherkin
Feature: Interject at any time (F8.2)

  Scenario: The Operator sees the node reaching for the wrong composable
    Given node "n_impl_3" is running and streaming output
    When the Operator posts to /api/runs/r1/interject
          """
          { "nodeId": "n_impl_3",
            "text": "Use the existing useToast composable, don't add a new one.",
            "mode": "next-turn",
            "ifLastSeq": 10891 }
          """
    Then the response is 202 with { "seq": 10892, "delivery": "queued" }
    And the ledger contains "human.interjected" at seq 10892 carrying the node, text and mode
    And the run status is unchanged
    And no node was cancelled, reset or re-attempted

  Scenario: It reaches the agent
    Given the adapter's capability row reports mid-turn steering
    When the node's next turn is constructed
    Then the text appears in the outgoing session/prompt content
    And the projection updates the item's delivery to "delivered"

  Scenario: The run completes normally afterwards
    Then the node completes on the same attempt
    And the ledger contains exactly one "human.interjected" for it
```

**Notes:** _"A running node can be paused and given a correction without discarding the run"_ (F8.2).
The assertion that no attempt was re-minted is the one that matters: `attempt` is part of the
idempotency key, so a re-attempt would re-execute effects
([05 §9.2](../../05-durable-execution.md)) — an interjection must never look like a retry.

---

## EPIC-13-S18 — An adapter that cannot steer says so, with a `202`

**Verifies:** KAR-13.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: delivery: "unsupported" is honest, not an error

  Scenario: The adapter cannot accept mid-turn steering
    Given the mock agent was started with --capabilities excluding mid-turn steering
    When the Operator interjects with mode "next-turn"
    Then the response status is 202, not 4xx
    And the body is { "seq": <n>, "delivery": "unsupported" }
    And no frame was sent to the agent
    And the projection carries delivery "unsupported" for that interjection

  Scenario: The UI cannot render it as delivered
    Then the item's rendered state is "not delivered — this adapter cannot be steered mid-turn"
    And it offers "pause-and-inject" as the alternative that always works

  Scenario Outline: The capability drives the answer, not the vendor name
    Given a capability row with steering "<steering>"
    Then the delivery is "<delivery>"

    Examples:
      | steering | delivery  |
      | true     | queued    |
      | false    | unsupported |
```

**Notes:** F8.5 is P1 and adapter-dependent, and the capability matrix is genuinely uneven — two of
five probed adapters cannot even resume a session (**verified 2026-08-02**). _"The UI must render
that honestly rather than showing a delivered guidance bubble that never arrived"_
([11 §7.5](../../11-api-and-realtime.md)). An error status would be worse in both directions: it
implies the Operator did something wrong and invites a retry that will also not work.

---

## EPIC-13-S19 — `pause-and-inject` resumes the same attempt with the same idempotency key

**Verifies:** KAR-13.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: The mode that always works

  Scenario: Suspend, rebuild the packet, resume
    Given node "n_impl_3" is running with attempt 1 and ikey "r1/n_impl_3/1/3"
    When the Operator interjects with mode "pause-and-inject"
    Then the node is suspended at the next safe boundary with "node.suspended"
    And the packet is re-assembled including the guidance segment
    And the node resumes with attempt still 1
    And the next effect's ikey continues the same ordinal sequence
    And no "node.retry.scheduled" event is appended

  Scenario: Completed effects are memoised, not re-executed
    Given two effects completed before the interjection
    Then their effect rows are state "done" and are returned from the journal
    And the fake agent's side-effect log shows each executed exactly once

  Scenario: The ordinal comes from reduced state, not a runtime counter
    Then the ordinal after resume is derived from how many effect intents the reducer has seen
          for (run_id, node_id, attempt)
    And it does not restart at 0
```

**Notes:** the ordinal detail is [05 §8.1](../../05-durable-execution.md)'s: _"A runtime counter
resets to zero when the process restarts, so the second effect of an interrupted attempt would come
back as ordinal 0 and collide with the first."_ A pause-and-inject is an interruption of exactly that
shape, so it exercises the same path a crash does — which is why it is worth asserting here rather
than only in EPIC-06.

---

## EPIC-13-S20 — Interjecting a node that finished while the Operator was typing

**Verifies:** KAR-13.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The write lands on a world that moved

  Scenario: The node completed between the read and the post
    Given the Operator's panel rendered node "n_impl_3" as running at cursor 10891
    And the node completed at seq 10894
    When the Operator interjects with ifLastSeq 10891
    Then the response is 409 stale_cursor carrying the current head
    And no "human.interjected" event is appended
    And the response tells the Operator the node has completed

  Scenario: Without ifLastSeq the refusal is still typed
    When the Operator interjects a completed node with no ifLastSeq
    Then the response is a typed error naming the node's terminal state
    And nothing is appended

  Scenario: Interjecting a suspended human node is the wrong call
    Given node "n_approve_scope" is a suspended "human" node
    When the Operator interjects it
    Then the response is a typed error naming POST /runs/:id/nodes/:nodeId/respond as the correct call
    And nothing is appended
```

**Notes:** appending an interjection to a completed node would produce a ledger event with no
possible effect, which is worse than an error — it is an audit trail that implies something happened.
The third scenario keeps the two "tell the run something" mechanisms from silently overlapping.

---

## EPIC-13-S21 — The guidance is an attributed segment, not a spliced prompt

**Verifies:** KAR-13.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: What the node received is inspectable (F10.3)

  Scenario: The segment appears in the packet manifest
    Given an interjection was delivered to node "n_impl_3"
    When the node's next "context.built" event is read
    Then the packet manifest contains a segment with provenance "human"
    And its text is byte-identical to what the Operator posted
    And it carries the seq of the "human.interjected" event that produced it
    And the node inspector can render it beside every other segment with a token count

  Scenario: Multiple interjections before the next turn
    Given three interjections at seqs 10892, 10894 and 10897
    Then all three appear as segments in seq order
    And none is coalesced or dropped

  Scenario: The guidance is not pinned
    Then the segment is eligible for compaction like any other non-pinned segment
    And the pinned set remains exactly the TaskSpec goal, non-goals, constraints,
        acceptance criteria, path scopes and permission level
```

**Notes:** the third scenario is a deliberate boundary. It is tempting to pin operator guidance
forever, but the pinned set is what the pin-integrity check asserts on every render
([04 §2](../../04-domain-model.md)), and growing it without bound is how the check starts failing on
long runs. Guidance that must survive belongs in the spec, where editing it produces a new
`specHash` and re-validates the plan.

---

## EPIC-13-S22 — Routine permission requests never reach the Operator

**Verifies:** KAR-13.4 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: DeFlow auto-responds from the policy table (F5.4)

  Scenario: Twenty in-scope reads
    Given a node at permission "worktree" with pathScopes.write ["packages/ui/src/**"]
    And the mock agent makes twenty fs/read_text_file calls inside the worktree
    When the run completes
    Then zero "human.requested" events exist for permission
    And the approval queue was empty throughout
    And each auto-response is still a ledger event, so the history is reconstructable

  Scenario Outline: The ladder decides, per method and level
    Given a node at permission level "<level>"
    When the agent calls "<method>" with "<target>"
    Then the auto-decision is "<decision>"

    Examples:
      | level        | method              | target                          | decision |
      | read         | fs/write_text_file  | inside the worktree             | reject   |
      | read         | terminal/create     | "pnpm test"                     | reject   |
      | worktree     | fs/write_text_file  | inside the worktree             | allow    |
      | worktree     | fs/write_text_file  | ../outside/the/worktree         | reject   |
      | worktree     | terminal/create     | "pnpm test" (allowlisted)       | allow    |
      | worktree     | terminal/create     | "curl https://example.com"      | escalate |
      | worktree+net | terminal/create     | "pnpm install"                  | allow    |
      | full         | terminal/create     | "kubectl delete ns staging"     | escalate |

  Scenario: The path is resolved before the decision
    Then "resolve(path) is inside the worktree" is evaluated after realpath,
         so a symlink pointing outside is rejected
```

**Notes:** this is the whole reason ACP-first pays off for safety: _"DeFlow sits in the path of every
file access and every command execution"_, so the ladder collapses from an N-vendors × M-levels
matrix into **one policy function in DeFlow's own code**
([14 §10](../../14-testing-strategy.md)) — a fast unit test with nothing installed. The last row of
the outline is the point of KAR-13.4: even at `full`, the F5.6 categories escalate.

---

## EPIC-13-S23 — An escalation carries enough context to decide in five seconds

**Verifies:** KAR-13.4 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The escalation payload

  Scenario: The agent wants network egress at worktree level
    Given a node "n_impl_3" at permission "worktree",
          pathScopes.write ["packages/ui/src/**"],
          brief "Migrate the toast component to the new design system"
    When the agent calls terminal/create with
          command "curl", args ["-sS","https://registry.example.com/token"], cwd the worktree
    Then "human.requested" is appended and the queue item carries
          | field           | value                                              |
          | command         | curl                                               |
          | args            | ["-sS","https://registry.example.com/token"]       |
          | cwd             | .DeFlow/wt/r1__n_impl_3                            |
          | matchedRule     | egress-outside-allowlist                           |
          | nodeId          | n_impl_3                                           |
          | nodePermission  | worktree                                           |
          | nodePathScopes  | ["packages/ui/src/**"]                             |
          | nodeBrief       | Migrate the toast component to the new design system |
          | enforcement     | the sandbox mode actually in effect for this node  |
    And the options offered are allow_once, allow_always, reject_once, reject_always

  Scenario: A write that resolves outside the worktree shows the resolved target
    Given the agent requests fs/write_text_file for "./tmp/x"
    And "tmp" is a symlink to "/etc"
    Then the payload's requestedPath is "./tmp/x"
    And the payload's resolvedPath is "/etc/x"
    And the resolved path is what the UI shows first

  Scenario: The ToolCallLocation is carried through
    Given the agent supplied ToolCallLocation { path, line }
    Then the payload carries it, so the request is rejected before the write rather than diffed after
```

**Notes:** `ToolCallLocation.path` is the improvement over F5.3 noted in
[09 §8.2](../../09-workspace-and-safety.md): DeFlow rejects the write _before it happens_, with a
reason the UI can render, rather than diffing at completion and calling it a gate failure. The
`enforcement` field exists because of A5-1 and A5-2 — if the platform's sandbox silently degraded,
the Operator is deciding under different assumptions and should be told so.

---

## EPIC-13-S24 — The four `PermissionOptionKind` values, and the run scope of `_always`

**Verifies:** KAR-13.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: PermissionOptionKind

  Scenario Outline: The effect on the current call and the next matching one
    Given an escalated request for "<request>"
    When the Operator chooses "<option>"
    Then the current call is "<now>"
    And the next matching request in the same run is "<next>"

    Examples:
      | request                     | option         | now     | next               |
      | curl https://example.com    | allow_once     | allowed | escalates again    |
      | curl https://example.com    | allow_always   | allowed | auto-allowed       |
      | curl https://example.com    | reject_once    | denied  | escalates again    |
      | curl https://example.com    | reject_always  | denied  | auto-denied        |

  Scenario: _always is scoped to the run, never to the machine
    Given "allow_always" was chosen in run r1
    When run r2 makes the same request
    Then it escalates to the Operator again
    And nothing was written to .DeFlow/config.yaml

  Scenario: The decision is recorded as an event, so the history is auditable
    Then "human.responded" carries the optionId, the matched request signature and the scope
    And a later reader can answer "why was this command allowed at 14:12?"

  Scenario: "Matching" is defined narrowly
    Given "allow_always" was chosen for curl against registry.example.com
    When the agent calls curl against a different host
    Then it escalates again
```

**Notes:** the four kinds are **verified 2026-08-02** from the shipped type definitions of
`@agentclientprotocol/sdk@1.3.0` ([09 §8.2](../../09-workspace-and-safety.md)). Run-scoping
`_always` is the direct application of the Kiro lesson: the incident was about **ambient
authority**, not about a missing review step, and a permission decision that outlives its context is
ambient authority by another name.

---

## EPIC-13-S25 — `cancelled` is an outcome, not an error

**Verifies:** KAR-13.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: RequestPermissionOutcome

  Scenario: The agent cancels its own request
    Given an escalated permission request is pending
    When the agent's turn is cancelled and the outcome is { outcome: "cancelled" }
    Then DeFlow records the cancellation
    And the node is not failed with a protocol error
    And the queue item is removed with reason "cancelled-by-agent"
    And the Operator's stale panel shows it as withdrawn rather than as still pending

  Scenario: The client keeps accepting trailing updates
    Given session/cancel was sent
    Then the prompt response returns stopReason "cancelled"
    And the client keeps accepting the trailing session/update notifications the agent flushes
    And the client does not deadlock

  Scenario: The selected outcome shape
    When the Operator chooses an option
    Then DeFlow responds { outcome: "selected", optionId: "<id>" }
```

**Notes:** _"Cancellation must be handled as a first-class outcome, not an error"_
([09 §8.2](../../09-workspace-and-safety.md)), and the trailing-updates behaviour is one of M0-S1's
explicit success criteria — the client must keep accepting notifications after a cancel _without
deadlocking_. This scenario is where that requirement is regression-tested after the spike is gone.

---

## EPIC-13-S26 — An escalation nobody answers

**Verifies:** KAR-13.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: An open agent session is not free

  Scenario: The Operator is asleep
    Given an escalated permission request with deadline { wakeAt: T+30m, onTimeout: "default",
          default: "reject_once" }
    When the clock passes wakeAt with no response
    Then DeFlow responds { outcome: "selected", optionId: "reject_once" }
    And "human.responded" is appended with by "policy"
    And the queue item is resolved with the recorded reason "timed out — auto-rejected"
    And the agent receives a refusal and its turn continues or ends per the adapter's contract

  Scenario: The refusal is visible, not silent
    Then the run timeline shows the escalation and its automatic refusal
    And the node's failure, if it fails, names the refused permission rather than a generic error

  Scenario: A long-running escalation does not block other branches
    Given branches A and C are runnable
    Then they continue to be admitted while the escalation waits
```

**Notes:** a silent hang is a worse answer than a recorded refusal. The alternative — leaving a
vendor session open for six hours — is not neutral either: the vendor may time out on its own, at
which point the failure is unattributable. Answering with the declared default keeps the outcome in
the ledger.

---

## EPIC-13-S27 — `mediatedExecution: false` is refused scheduling, never silently escalated

**Verifies:** KAR-13.4 · **Type:** Failure · **Automated at:** unit + integration

```gherkin
Feature: F5.4 — refuse to schedule rather than silently escalate

  Scenario: An adapter that cannot mediate execution
    Given a probed capability row with mediatedExecution false
    And a node at permission "worktree"
    When plan validation runs
    Then it emits an error naming the adapter and the level
    And the node is never scheduled
    And no permission escalation is created for the Operator to approve

  Scenario: The Operator cannot approve their way past it
    Then no queue item exists for this refusal
    And the resolution is re-routing the node to a capable adapter, recorded as a PlanPatch

  Scenario: read-level nodes are unaffected
    Given the same adapter and a node at permission "read"
    Then the node is scheduled normally
```

**Notes:** this is the one case in the epic where the answer is deliberately **not** "ask the human".
Offering an approval for a boundary the adapter cannot enforce would produce a decision the system
cannot honour — ODW's binary permission model is a documented hazard (G6) and the failure shape is
exactly this: a level that means different things on different vendors.

---

## EPIC-13-S28 — The daemon restarts while a permission escalation is outstanding

**Verifies:** KAR-13.4 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: A queue item must never outlive the thing that can answer it

  Scenario: SIGKILL with an escalation pending
    Given an escalated session/request_permission is pending for node "n_impl_3"
    And the agent subprocess is detached, so it survives the daemon's death
    When DeFlowd is SIGKILLed and restarted over the same directory
    Then the orphan reaper matches the recorded (pid, process_start_time) and terminates the group
    And the kill verification excludes Z-state processes
    And the node fails with a typed reason naming the lost session
    And the permission queue item is removed rather than left unanswerable
    And a new attempt is scheduled with a new idempotency key

  Scenario: The human node gates in the same run are unaffected
    Given the same run also has a suspended "human" node from EPIC-13-S3
    Then that node is still pending after the restart
    And the distinction is that a human gate needs no live process and a permission request does

  Scenario: The PID-reuse guard
    Given the recorded pid now belongs to a different process
    Then the reaper compares the stored process start time and does not kill it
    And the node still fails with the lost-session reason
```

**Notes:** this is the scenario that separates the two kinds of waiting in this epic. A `human` node
is durable because it needs nothing but a row; a permission escalation is bound to a live ACP session
and cannot outlive it. _"Never kill by bare pid after a restart. Pids are recycled. You will
eventually kill the user's editor"_ ([05 §9.4](../../05-durable-execution.md)) — and the Z-state
exclusion is the verified false negative that makes a successful group kill look like a failed one.

---

**Related:** [EPIC-13](../epics/EPIC-13-human-in-the-loop.md) ·
[API and realtime](../../11-api-and-realtime.md) ·
[Durable execution](../../05-durable-execution.md) ·
[Workspace and safety](../../09-workspace-and-safety.md) ·
[Verification gates flows](./EPIC-12-verification-gates-flows.md) · [Board](../board.md)

[← Back to the delivery plan](../README.md)
