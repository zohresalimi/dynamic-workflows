# EPIC-06 flows — Orchestrator: scheduling and durable effects

> Behavioural specification for [EPIC-06](../epics/EPIC-06-orchestrator.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor              | Description                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Operator**       | The engineer driving DeFlow — pauses, cancels, and resolves the `needs_human` gate                                                                                                   |
| **DeFlowd**        | The local daemon. In several scenarios there is an old life and a new life, separated by `kill -9`                                                                                   |
| **Scheduler**      | `decide(state, now) -> Command[]` in `@DeFlow/core` — pure, total, no I/O, no clock of its own                                                                                       |
| **Reducer**        | `reduce(state, event) -> RunState` in `@DeFlow/core` — the only thing that produces state                                                                                            |
| **EffectRunner**   | `@DeFlow/orchestrator`'s imperative shell — the only place effects happen                                                                                                            |
| **Ticker**         | The ~1 Hz loop draining `node_wake` and calling `decide()`                                                                                                                           |
| **Provider agent** | A `DeFlow-mock-agent` subprocess on a temp `PATH`, spawned `{ detached: true }`, appending `{runId, nodeId, attempt, idempotencyKey}` to its own side-effect log on every invocation |
| **Repository**     | A real `git` working copy in a tmpdir, with `GIT_CONFIG_GLOBAL=/dev/null` and forced identity env                                                                                    |
| **Ledger**         | The file-backed SQLite database from [EPIC-03](../epics/EPIC-03-event-ledger.md) — `event`, `effect`, `node_wake`, `run`                                                             |
| **CI**             | The `integration`, `e2e` and `crash-fuzz` projects on `ubuntu-26.04` and `macos-26`, Node 24 and 26                                                                                  |

## Preconditions common to all flows

```gherkin
Background:
  Given a DeFlow workspace initialised in a git repository on branch "main"
  And the ledger is a FILE-BACKED SQLite database at <dataDir>/ledger.db — never ":memory:"
  And all six tables exist from migration 0001 and are declared STRICT
  And "seq" is INTEGER PRIMARY KEY AUTOINCREMENT, so sequence numbers have gaps and every
      consumer resumes from "strictly greater than my cursor"
  And DeFlow-mock-agent is on a temp PATH, resolved to an ABSOLUTE path before spawn
  And every mock agent runs with --seed so the pre-crash side of any run is deterministic
  And time enters the engine through the injected Clock port — never Date.now() or setTimeout
  And the run's scheduling policy is: globalAgentSlots 3, repo write lock 1, worktree lock 1
  And retry defaults are maxAttempts 3, backoff base 2000 ms, cap 300000 ms, jitter "full"
  And the stall threshold is 10 minutes and the churn window is the last M=20 completed attempts
```

> Two rules bind every scenario in this file. **`:memory:` is permitted only where
> `Automated at: unit` appears** — it cannot be reopened after a simulated crash, which is the one
> property this epic exists to guarantee. And **no scenario calls `vi.useFakeTimers()` while a child
> process is alive**: the process's real I/O never arrives, the `await` never resolves, and the test
> deadlocks for the full 30 s timeout in CI while passing locally. Advance the injected `Clock`.

## Flow index

| Scenario    | Title                                                                    | Verifies           | Type                   |
| ----------- | ------------------------------------------------------------------------ | ------------------ | ---------------------- |
| EPIC-06-S1  | Happy path: the ready set admits an unblocked node                       | KAR-06.1           | Happy path             |
| EPIC-06-S2  | `decide()` is pure — no clock, no I/O, no mutation                       | KAR-06.1           | Happy path             |
| EPIC-06-S3  | Five reasons a node is withheld from the ready set                       | KAR-06.1           | Edge case              |
| EPIC-06-S4  | Global agent slots cap admission at three                                | KAR-06.1, KAR-06.2 | Edge case              |
| EPIC-06-S5  | Two write nodes contend for the repository lock                          | KAR-06.2           | Concurrency            |
| EPIC-06-S6  | The repo lock survives a restart because it lives in the ledger          | KAR-06.2, KAR-06.9 | Recovery               |
| EPIC-06-S7  | One agent per worktree, always                                           | KAR-06.2           | Concurrency            |
| EPIC-06-S8  | Happy path: intent, act, record                                          | KAR-06.3           | Happy path             |
| EPIC-06-S9  | The ordinal comes from the reducer's view, not a runtime counter         | KAR-06.3           | Failure                |
| EPIC-06-S10 | A patch lands under a journaled effect and the hash catches it           | KAR-06.3           | Failure                |
| EPIC-06-S11 | A `done` row short-circuits the effect after a restart                   | KAR-06.3, KAR-06.9 | Recovery               |
| EPIC-06-S12 | Reconciliation per effect type                                           | KAR-06.4           | Recovery               |
| EPIC-06-S13 | The `DeFlow-Effect-Id` trailer makes a commit structurally idempotent    | KAR-06.4           | Recovery               |
| EPIC-06-S14 | An orphaned `.DeFlow-<ikey>.tmp` sibling means redo                      | KAR-06.4           | Recovery               |
| EPIC-06-S15 | `reconcile()` returns `unknown` and there is no correct automatic action | KAR-06.4           | Failure (known hole)   |
| EPIC-06-S16 | The irreducible window between the effect landing and the `done` row     | KAR-06.4, KAR-06.9 | Failure (known hole)   |
| EPIC-06-S17 | Crash-resume memoises; failure-retry re-executes                         | KAR-06.3, KAR-06.5 | Edge case (known hole) |
| EPIC-06-S18 | Error class drives retry, fail or gate                                   | KAR-06.5           | Failure                |
| EPIC-06-S19 | Full jitter spreads a correlated rate-limit retry storm                  | KAR-06.5           | Edge case              |
| EPIC-06-S20 | `node.failed` and the `node_wake` row commit together                    | KAR-06.5, KAR-06.6 | Failure                |
| EPIC-06-S21 | A 30-day gate written with `setTimeout` fires after 1 ms                 | KAR-06.6           | Failure                |
| EPIC-06-S22 | A six-hour human gate across laptop sleep costs one row                  | KAR-06.6           | Happy path             |
| EPIC-06-S23 | Pause is an event, so it survives a restart                              | KAR-06.7           | Recovery               |
| EPIC-06-S24 | Cancel escalates through three stages; zombies are not survivors         | KAR-06.7           | Failure                |
| EPIC-06-S25 | Killing by bare pid after a restart kills the operator's editor          | KAR-06.7, KAR-06.9 | Failure (known hole)   |
| EPIC-06-S26 | The stall detector reports and never auto-kills                          | KAR-06.8           | Edge case              |
| EPIC-06-S27 | The churn breaker trips on the same work redone five times               | KAR-06.8           | Failure                |
| EPIC-06-S28 | Three replans with no completed-node increase trip the breaker           | KAR-06.8           | Failure                |
| EPIC-06-S29 | Crash-fuzz: SIGKILL at a random point, restart, four invariants          | KAR-06.9           | Recovery               |
| EPIC-06-S30 | Orphaned detached agents keep burning tokens after the daemon dies       | KAR-06.9           | Failure                |
| EPIC-06-S31 | A budget ceiling pauses the run instead of failing it                    | KAR-06.5           | Edge case              |

---

## EPIC-06-S1 — Happy path: the ready set admits an unblocked node

**Verifies:** KAR-06.1 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: Ready-set derivation

  Background:
    Given a reduced RunState for a plan with nodes "recon" -> "implement" -> "gate-typecheck"
    And every node is state "pending" with attempt 0 and no wakeAt

  Scenario: only the root is ready at the start of a run
    When decide(state, 1754150000000) is called
    Then the returned commands contain exactly one StartNode for node "recon"
    And no command references "implement" or "gate-typecheck"

  Scenario: completing a dependency releases the next node
    Given the ledger has "node.started" then "node.completed" for "recon" at attempt 0
    And the state is rebuilt by reduce() over those events
    When decide(state, 1754150060000) is called
    Then the returned commands contain exactly one StartNode for node "implement"
    And it carries the provider, model, permission level and worktree path from the plan,
        so the EffectRunner never consults state

  Scenario: the command list is ordered deterministically
    Given three sibling nodes "a", "b" and "c" all become ready on the same tick
    When decide() is called 50 times over a state whose node map key order is shuffled each time
    Then all 50 results are deeply equal
    And their StartNode order is by (seq of the enabling event, then node id)
```

**Notes:** The third scenario is not pedantry — a non-deterministic command order makes every
snapshot in this epic churn, and it is the kind of bug that only appears once the plan has enough
parallel branches to matter. `Command` carrying everything the runner needs is the design rule that
keeps `decide()` the only place policy lives.

---

## EPIC-06-S2 — `decide()` is pure — no clock, no I/O, no mutation

**Verifies:** KAR-06.1 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: NF9 enforced by a package boundary

  Scenario: the same input produces the same output, forever
    Given a RunState with 12 nodes in mixed states
    When decide(state, 1754150000000) is called 100 times
    Then all 100 results are deeply equal

  Scenario: the input is not mutated
    Given the RunState is deeply frozen with Object.freeze
    When decide(state, now) is called
    Then it does not throw
    And no property of state has changed

  Scenario: now is a parameter, not a call
    Given a source scan of packages/core/src
    Then it contains no occurrence of "Date.now(", "setTimeout(", "setInterval(",
        "Math.random(" or "process.hrtime"
    And the lint rule that enforces this names each banned identifier explicitly

  Scenario: the core cannot perform I/O
    When the resolved dependency graph of @DeFlow/core is walked
    Then it contains no "node:fs", "node:child_process", "node:net", "node:dgram"
        or "better-sqlite3", transitively
    And importing @DeFlow/core in a process where fs.readFileSync is patched to throw
        completes without throwing
```

**Notes:** The architecture states the corollary as a hard rule: anything nondeterministic goes
through a port — time via `Clock`, randomness via a seeded generator, ids via an injected factory —
and _an import of `node:fs` inside `@DeFlow/core` means the design has already broken_. The fourth
scenario turns that sentence into a test, which is the only version of it that survives six months.

---

## EPIC-06-S3 — Five reasons a node is withheld from the ready set

**Verifies:** KAR-06.1 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Admission preconditions

  Scenario Outline: a node with satisfied-looking preconditions is still not ready
    Given a node "implement" whose only dependency "recon" is completed
    And <condition>
    When decide(state, 1754150000000) is called
    Then no StartNode command references "implement"
    And the reason is observable as <observable>

    Examples:
      | condition                                            | observable                                              |
      | its state is "running"                               | it already appears in state.running                     |
      | attempt equals retry.maxAttempts (3)                  | the last node.failed for it is the final attempt        |
      | wakeAt is 1754150000001, one ms in the future        | a node_wake row exists with reason "backoff"            |
      | its lifecycle is "superseded"                        | a plan.patched event replaced it                        |
      | its lifecycle is "abandoned"                         | a plan.patched event marked the branch abandoned        |
      | the run's reduced status is "paused"                 | a run.pause.requested event with no matching run.resumed |
      | the run's reduced status is "needs_human"            | a run.needs_human event with no human.responded         |

  Scenario: the wakeAt boundary is inclusive
    Given a node with wakeAt exactly 1754150000000
    When decide(state, 1754150000000) is called
    Then a StartNode for it IS returned

  Scenario: a permanently-failed dependency poisons its dependents
    Given "recon" failed with class "permanent" and reason "adapter.spawn-failed"
    When decide() is called
    Then "implement" never enters the ready set on any subsequent tick
    And a command is returned that appends node.failed for "implement" with
        reason "dependency.failed" and class "permanent"
    And the same propagation reaches "gate-typecheck", transitively
```

**Notes:** `wakeAt <= now` rather than `<` matters more than it looks: the ticker fires on a due row
and calls `decide` with that same instant, so a strict comparison means every wake is late by one
tick and a six-hour gate becomes six hours and a second — harmless — while a 2-second backoff
becomes 3 seconds, which is visible in the timeline and confusing.

---

## EPIC-06-S4 — Global agent slots cap admission at three

**Verifies:** KAR-06.1, KAR-06.2 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Bounded concurrency

  Scenario: five ready nodes, three slots
    Given five read-only analysis nodes are simultaneously ready
    And globalAgentSlots is 3
    When decide(state, now) is called
    Then exactly 3 StartNode commands are returned
    And the other two nodes remain state "pending"

  Scenario: a slot frees on completion, not on scheduling
    Given three nodes are running
    When decide() is called on the next tick
    Then 0 StartNode commands are returned
    When node.completed is reduced for one of them
    And decide() is called again
    Then exactly 1 StartNode command is returned

  Scenario: admission counts running, not ready
    Given three nodes are running and seven are ready
    Then admit evaluates to
        min(globalAgentSlots - running.length, classSlots(n) - runningInClass(n))
    And equals 0

  Scenario: the slot count is state, not a constant
    Given .DeFlow/config.yaml sets globalAgentSlots to 5 and the daemon is restarted
    When decide() is called with three nodes already running
    Then 2 further StartNode commands are returned
    And the three in-flight nodes are untouched
```

**Notes:** The default of 3 is bounded by laptop RAM and vendor rate limits, not by anything
intrinsic. Making it read from state rather than a module constant is what allows an operator to
turn it down mid-run after a rate-limit episode, without a code change and without killing anything.

---

## EPIC-06-S5 — Two write nodes contend for the repository lock

**Verifies:** KAR-06.2 · **Type:** Concurrency · **Automated at:** unit, then integration

```gherkin
Feature: Serialise writes, parallelise reads (F5.2)

  Scenario: only one write node is admitted
    Given two nodes "impl-auth" and "impl-router", both permission "worktree",
          both declaring writes against repository key "repo:/home/u/proj"
    And both are ready on the same tick
    When decide(state, now) is called
    Then exactly one AcquireLock command with lock "repo" is returned
    And exactly one StartNode is returned, for the node that acquires it
    And the other node stays "pending" with no lock command

  Scenario: the lock is released on every terminal outcome
    Given "impl-auth" holds the repo lock
    When it reduces to <terminal state>
    Then a ReleaseLock command is returned on the next tick
    And node.lock.released { node: "impl-auth", lock: "repo", key: "repo:/home/u/proj" }
        is appended

    Examples:
      | terminal state |
      | completed      |
      | failed         |
      | cancelled      |

  Scenario: read-only nodes never ask for it
    Given eight nodes with permission "read" are ready
    When decide() is called
    Then no AcquireLock command with lock "repo" is returned
    And admission is bounded only by globalAgentSlots

  Scenario: two real agents never interleave their git index writes
    Given two mock agents scripted to run "git add ." in the same repository
    When both nodes are scheduled through the real EffectRunner
    Then their node.started and node.completed seqs do not overlap in the ledger
    And "git status --porcelain" between them is stable
```

**Notes:** PRD §13 rates _parallel write agents produce incompatible work_ as **High**, and the
mitigation is exactly this lock plus worktree isolation. The fourth scenario is the one that catches
a lock that is computed correctly and then not actually respected at the effect boundary — a
surprisingly common shape of bug, because the unit test passes.

---

## EPIC-06-S6 — The repo lock survives a restart because it lives in the ledger

**Verifies:** KAR-06.2, KAR-06.9 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Locks are events, not a JavaScript Map

  Scenario: an unreleased lock is still held after kill -9
    Given "impl-auth" acquired the repo lock and node.lock.acquired is in the ledger
    And no matching node.lock.released exists
    When the daemon is killed with SIGKILL and restarted over the same .DeFlow directory
    Then reduce() reports the repo lock as held by "impl-auth"
    And "impl-router" is still withheld on the first post-restart tick

  Scenario: a lock whose owner is gone is reclaimed, not leaked
    Given "impl-auth" held the repo lock and its last event reduces to node.failed
    When the daemon restarts
    Then node.lock.released { node: "impl-auth", lock: "repo", reason: "reclaimed" }
        is appended before the first decide()
    And "impl-router" is admitted on that tick

  Scenario: no in-memory lock state exists at all
    Given a source scan of packages/orchestrator/src
    Then no module-scope Map, Set or object is used to hold lock ownership
    And the only reader of lock state is reduce()
```

**Notes:** This is the scenario the architecture argues for directly: _an in-memory lock evaporates
on restart, and the first thing that happens after a crash is that you resume several nodes at once
— precisely when you need the lock most._ The third scenario exists because the in-memory version is
so much easier to write that it will be written unless something fails when it is.

---

## EPIC-06-S7 — One agent per worktree, always

**Verifies:** KAR-06.2 · **Type:** Concurrency · **Automated at:** unit

```gherkin
Feature: Per-worktree exclusive lock

  Scenario: two nodes assigned the same worktree serialise
    Given nodes "fix-1" and "fix-2" both assigned worktree
          ".DeFlow/wt/run_20260802T141133Z_9f2a1c__implement"
    When both are ready and decide() is called
    Then exactly one AcquireLock with lock "worktree" and that path as the key is returned
    And only that node is started

  Scenario: distinct worktrees do not contend
    Given "fix-1" and "fix-2" are assigned distinct worktree paths
    And neither declares a repository write
    When decide() is called with globalAgentSlots 3
    Then both are started on the same tick

  Scenario: a suspended node holds neither slot nor lock
    Given "fix-1" holds the worktree lock and then emits node.suspended
    Then it is excluded from running and from runningInClass
    And its worktree lock is released
    And "fix-2" is admitted
```

**Notes:** The worktree lock and the repo lock are different constraints even though they usually
coincide: the repo lock protects the shared git index and object store, the worktree lock protects a
single checkout from two agents editing the same files. Collapsing them is the schedule lever named
in the epic's Risks, and it costs real parallelism on plans with many independent worktrees.

---

## EPIC-06-S8 — Happy path: intent, act, record

**Verifies:** KAR-06.3 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The write-ahead effect journal

  Scenario: the intent row precedes the side effect
    Given node "implement" at attempt 0 is about to invoke an agent
    When durable() is entered for that effect
    Then an effect row exists with
        ikey "run_20260802T141133Z_9f2a1c/implement/0/0", kind "agent", state "pending",
        a non-null request_hash and started_at set
    And an effect.started event carrying { ikey, kind, requestHash } is in the ledger
    And the mock agent's side-effect log is still EMPTY at this point

  Scenario: the result is recorded after the effect
    When the agent turn completes
    Then the effect row moves to state "done" with result_json populated and ended_at set
    And effect.completed { ikey, result, reconciled: false } is appended
    And the mock agent's side-effect log contains exactly one line for that ikey

  Scenario: a concurrent second entry does not double-perform
    Given two callers enter durable() for the same ikey within the same tick
    Then the INSERT … ON CONFLICT(ikey) DO NOTHING leaves one row
    And both callers read that same row
    And exactly one of them calls perform()
    And the mock agent's side-effect log still contains exactly one line
```

**Notes:** _"The pre-effect record is the thing that makes at-least-once recovery possible at all.
Without it, a crash between 'started work' and 'finished work' is indistinguishable from 'never
started'."_ Asserting the side-effect log is **empty** at the intent point is the only way to prove
the ordering — asserting the row exists proves nothing about when.

---

## EPIC-06-S9 — The ordinal comes from the reducer's view, not a runtime counter

**Verifies:** KAR-06.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Ordinal derivation across a restart

  Scenario: the second effect of an interrupted attempt does not collide with the first
    Given node "migrate" at attempt 0 performs two effects in sequence
    And the first effect completed with ikey ".../migrate/0/0"
    When the daemon is killed with SIGKILL before the second effect starts
    And the daemon restarts over the same ledger
    And node "migrate" resumes at the SAME attempt 0
    Then the second effect is journaled with ikey ".../migrate/0/1"
    And it is NOT journaled with ordinal 0
    And no ON CONFLICT collision occurs against the first effect's row

  Scenario: the counter is derived, never held
    Given a source scan of packages/orchestrator/src
    Then no field named "ordinal" is incremented on an instance, module or closure variable
    And nextOrdinal(state, runId, nodeId, attempt) reads the count of effect.started events
        already reduced for that triple

  Scenario: the derivation is stable across arbitrarily many restarts
    Given an attempt with five effects
    When the daemon is killed and restarted between each pair
    Then the five ikeys end in ordinals 0, 1, 2, 3, 4 exactly once each
```

**Notes:** This is the single subtlest bug in the whole epic and it fails only after a crash, which
means it fails only in production if it is not tested here. _"A runtime counter resets to zero when
the process restarts, so the second effect of an interrupted attempt would come back as ordinal 0
and collide with the first."_ The collision is silent: `ON CONFLICT DO NOTHING` reads the first
effect's `done` row and memoises **the wrong result**.

---

## EPIC-06-S10 — A patch lands under a journaled effect and the hash catches it

**Verifies:** KAR-06.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: request_hash guards a live effect against a plan edit

  Scenario: changing the node's brief invalidates the memoised result
    Given an effect row for ikey ".../implement/0/0" in state "done"
    And its request_hash covers the node's brief, provider, model, permission level,
        path scopes and declared reads/writes
    When a PlanPatch changes "implement"'s permission from "worktree" to "worktree+net"
    And durable() is re-entered for the same ikey
    Then it raises a NodeFailure with reason "effect.request-hash-mismatch" and class "permanent"
    And the message names both the stored hash and the computed one
    And the memoised result_json is NOT returned

  Scenario: an irrelevant plan change does not invalidate anything
    Given the same done effect row
    When a PlanPatch changes an unrelated node's title
    And durable() is re-entered for ikey ".../implement/0/0"
    Then the memoised result is returned normally

  Scenario: the hash is canonical, not incidental
    Given two request descriptors with identical content but different key insertion order
    Then requestHash produces the same value for both
    And a descriptor with an explicit "undefined" field hashes equal to one omitting it
```

**Notes:** _"Without the hash you would happily return the memoised result of the old operation as if
it were the new one."_ Use the project's own canonical JSON encoder here, never `ohash` — `ohash`
promises only "best efforts" at stable serialisation, which is adequate for change detection in the
UI and inadequate for a value that gates whether a side effect re-runs.

---

## EPIC-06-S11 — A `done` row short-circuits the effect after a restart

**Verifies:** KAR-06.3, KAR-06.9 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: F4.2 at effect granularity — completed work is never re-executed

  Scenario: memoisation on the restart path
    Given a five-node run in which three nodes completed
    And each completed node's effect rows are state "done"
    When the daemon is killed with SIGKILL and restarted
    Then decide() returns StartNode for exactly the two remaining nodes
    And no perform() is called for any done ikey
    And the mock agents' side-effect log contains no duplicate idempotencyKey

  Scenario: a failed row is rethrown, not re-run
    Given an effect row in state "failed" carrying a NodeFailure with class "permanent"
    When durable() is entered for that ikey
    Then EffectFailed is thrown carrying that exact NodeFailure
    And perform() is not called
    And the SCHEDULER, not the runner, decides whether that is a retry or a node failure

  Scenario: a pending row from THIS daemon life is ordinary concurrency
    Given an effect row in state "pending" whose started_at >= daemonStartedAt
    When durable() is entered for it
    Then reconcile() is NOT called
    And execution falls through to perform()
```

**Notes:** The four branches of `durable()` are four genuinely different real situations and the
third scenario is the one people collapse into the crash case. A `pending` row from the current
epoch means another in-process caller is mid-flight; calling `reconcile()` there would probe the
world for an effect that is _currently happening_, which is both wasteful and wrong.

---

## EPIC-06-S12 — Reconciliation per effect type

**Verifies:** KAR-06.4 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: reconcile() answers "did this already happen out there?"

  Background:
    Given an effect row in state "pending" whose started_at < daemonStartedAt
    And the daemon has just restarted after SIGKILL

  Scenario Outline: the probe per effect kind
    Given the effect kind is <kind> in situation <situation>
    When reconcile(row) is called
    Then it returns <verdict>
    And the follow-on action is <action>

    Examples:
      | kind             | situation                                              | verdict     | action                                        |
      | agent            | a session_id is journaled and caps.session.resume=true | done        | ResumeNative, skip re-sending context         |
      | agent            | a session_id is journaled and caps.session.resume=false| not-started | ResumeByReplay: session/new + replay packet   |
      | agent            | no session_id was ever journaled                       | not-started | clean restart is safe                         |
      | shell (pure)     | any                                                    | not-started | re-run; the cost is time                      |
      | shell (mutating) | git status --porcelain hash matches the BEFORE hash    | not-started | re-run inside the dedicated worktree          |
      | shell (mutating) | the hash matches the AFTER hash                        | done        | memoise the journaled result                  |
      | shell (mutating) | the hash matches neither                               | unknown     | escalate — see EPIC-06-S15                    |
      | git (worktree)   | the worktree path already exists                       | done        | "already exists" is a SUCCESS, not an error   |
      | git (commit)     | git log --grep finds the DeFlow-Effect-Id trailer      | done        | memoise the found sha                         |
      | git (commit)     | the trailer is absent from the branch                  | not-started | re-commit with the same trailer               |
      | file             | a <target>.DeFlow-<ikeyHash>.tmp sibling exists        | not-started | unlink the tmp and redo                       |
      | file             | no tmp and the target's content hash matches           | done        | memoise                                       |
      | file             | no tmp and the target's content hash differs           | unknown     | escalate — see EPIC-06-S15                    |

  Scenario: the session id is journaled unbuffered
    Given the mock agent emits a session id in its first frame then calls process.exit(1)
    When the daemon restarts
    Then that session id is present as its own event row in the ledger
    And it was written in the same tick it arrived, not on turn completion

  Scenario: every reconcile outcome is visible
    When any reconcile returns "done"
    Then effect.completed { ikey, result, reconciled: true } is appended
    And a reconcile that mutates the effect row without appending an event does not exist
```

**Notes:** The five-adapter capability matrix (**Verified 2026-08-02**) is what makes the outline
worth writing rather than assuming: `claude-agent-acp@0.64.1`, `codex-acp@1.1.9` and
`opencode acp@1.18.11` advertise `session.resume`; `copilot --acp@1.0.77` and `gemini --acp@0.53.1`
**do not**. Two of five cannot resume at all. Drive this with the mock agent's
`--agent-capabilities` flag and the whole matrix becomes a 40 ms unit test instead of an integration
test that needs an installed, authenticated Gemini CLI. An adapter without resume means a crashed
agent node restarts from scratch — a **cost-model** difference, not a correctness one, because the
ledger always reconstructs the prompt.

---

## EPIC-06-S13 — The `DeFlow-Effect-Id` trailer makes a commit structurally idempotent

**Verifies:** KAR-06.4 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Making git idempotent instead of journaling around it

  Background:
    Given a real git repository created with
        git init -b main, GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_SYSTEM=/dev/null
        and forced GIT_AUTHOR_* / GIT_COMMITTER_* identity
    And a worktree at ".DeFlow/wt/run_20260802T141133Z_9f2a1c__implement"
        on branch "DeFlow/run_20260802T141133Z_9f2a1c__implement"

  Scenario: a commit carries its ikey as a trailer
    When the git effect commits
    Then the command is
        git commit -m "<subject>" -m "DeFlow-Effect-Id: <ikey>"
    And "git log -1 --format=%B" contains the line "DeFlow-Effect-Id: <ikey>"

  Scenario: reconcile finds a commit that landed before the crash
    Given the commit succeeded and the daemon died before markDone
    When the daemon restarts and reconcile runs for that ikey
    Then "git log --grep=\"DeFlow-Effect-Id: <ikey>\" --format=%H -1" returns one sha
    And reconcile returns "done" with that sha as the memoised result
    And "git rev-list --count HEAD" is unchanged — no second commit was made

  Scenario: worktree creation is idempotent by construction
    When "git worktree add" is run a second time for the same path
    Then it exits non-zero with a message containing "already exists"
    And the git effect maps that outcome to SUCCESS
    And a message containing "already used by worktree at" for a branch collision is
        NOT mapped to success — that is a real failure

  Scenario: forbidden operations inside a retriable node
    Then the Git wrapper throws before executing any of
        "push --force", "reset --hard", "clean -fdx"
    And the assertion names the argument it refused
```

**Notes:** The branch scheme is the flat `DeFlow/<runId>__<nodeId>` (D13). The PRD's original
slashed form `DeFlow/<run-id>/<node-id>` is a **verified bug** — git cannot have
`refs/heads/DeFlow/r1` be both a file and a directory, which blocks any run-level integration
branch. The real error string for a branch collision is `already used by worktree at`, **not** "is
already checked out at", which is what most blog posts claim; the third scenario keeps those two
outcomes distinguishable, because conflating them turns a genuine collision into a silent success.

---

## EPIC-06-S14 — An orphaned `.DeFlow-<ikey>.tmp` sibling means redo

**Verifies:** KAR-06.4 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Atomic file writes with the ikey in the temp filename

  Scenario: the write sequence
    When the file effect writes <target>
    Then the sequence is: open "<target>.DeFlow-<ikeyHash>.tmp", write, fsync(fd), close,
        rename(tmp, target), fsync(directory fd)
    And the temp path's dirname equals the target's dirname
    And the temp path does NOT start with os.tmpdir()

  Scenario: crash before the rename
    Given a "<target>.DeFlow-<ikeyHash>.tmp" file exists and the target does not
    When reconcile runs after a restart
    Then it returns "not-started"
    And the orphaned tmp file is unlinked before perform() re-runs
    And after the retry exactly one file exists at <target> and no tmp sibling remains

  Scenario: crash after the rename
    Given no tmp sibling exists and <target>'s content hash equals the journaled hash
    When reconcile runs
    Then it returns "done"
    And the file is not rewritten

  Scenario: a third party edited the target
    Given no tmp sibling exists and <target>'s content hash differs from the journaled hash
    When reconcile runs
    Then it returns "unknown"
    And the escalation of EPIC-06-S15 applies
```

**Notes:** `rename` is atomic only **within one filesystem**, which is exactly why the temp file must
be a sibling and never in `/tmp`; the assertion in the first scenario exists because "move the temp
files to the temp directory" is a plausible-sounding tidy-up that silently removes the atomicity
guarantee. Directory `fsync` is a **no-op on Windows** and both guarantees break on network mounts —
M1 targets macOS and Linux (NF5) and the Windows gap is known and documented, not discovered later.

---

## EPIC-06-S15 — `reconcile()` returns `unknown` and there is no correct automatic action

**Verifies:** KAR-06.4 · **Type:** Failure (known hole) · **Automated at:** integration

```gherkin
Feature: The escalation designed on day one, not bolted on

  Background:
    Given a node "db-migrate" whose shell command is classified "mutating" at PLAN time
    And its before-hash of "git status --porcelain" was journaled before perform()

  Scenario: the probe genuinely cannot tell
    Given the daemon was SIGKILLed mid-migration
    And the worktree's current git status hash matches NEITHER the before nor the after hash
    When the daemon restarts and reconcile runs for that ikey
    Then it returns "unknown"
    And NO retry is attempted — a mutating command whose reconcile is unknown is never auto-retried
    And node.failed is appended with reason "effect.reconcile-unknown" and class "gate"
    And run.needs_human { reason: "reconcile-unknown", detail } is appended
    And the run's projected status becomes "needs_human"

  Scenario: the operator is given evidence, not a message
    Then the needs_human detail carries the ikey, the effect kind, the request_hash,
        the journaled before-hash, the journaled after-hash and the observed hash
    And the effect row is linked so the node inspector can render all three

  Scenario: nothing moves until a human decides
    When 1000 ticks elapse and clock.advance(hours(6)) is applied
    Then decide() returns no StartNode for "db-migrate" on any of them
    And no other node depending on it is started

  Scenario Outline: the human's two answers
    When the operator responds <answer>
    Then <outcome>

    Examples:
      | answer      | outcome                                                                    |
      | "it ran"    | the effect row moves to "done" with a human-attested result and the node completes |
      | "it didn't" | the effect row moves to "failed"; a NEW attempt with a NEW ikey is scheduled |
```

**Notes:** This is roadmap risk **A1-5**, rated **High**, and roadmap §7's second new open question:
_"What is the correct human action when effect reconciliation returns `unknown`? There is no correct
automatic one."_ Retrying might double-apply; skipping might drop the work; both are wrong in some
cases and neither is detectable. A migration that half-ran is not a thing to guess about. The
escalation beyond this — running every mutating node copy-on-write against a content-addressed
overlay, diffing, then applying — is large complexity that still does not help with network effects,
so it is explicitly **not** pre-built. If `unknown` turns out to be common in practice, that is the
measurement that justifies it.

---

## EPIC-06-S16 — The irreducible window between the effect landing and the `done` row

**Verifies:** KAR-06.4, KAR-06.9 · **Type:** Failure (known hole) · **Automated at:** integration

```gherkin
Feature: The honest floor of the whole design

  Scenario: crashing inside the window
    Given the fake effect binary is instrumented to append its side-effect log line and then
          send SIGKILL to the daemon before markDone can commit
    When the daemon restarts
    Then the effect row is still state "pending" with started_at < daemonStartedAt
    And the side effect HAS landed in the world
    And reconcile() is what resolves it — the journal alone cannot

  Scenario Outline: what each kind does with a landed-but-unrecorded effect
    Given the effect kind is <kind>
    When reconcile runs inside the window
    Then it returns <verdict> and the run <outcome>

    Examples:
      | kind             | verdict | outcome                                              |
      | git (commit)     | done    | continues, memoising the sha found by the trailer     |
      | file             | done    | continues, memoising the matching content hash        |
      | shell (pure)     | not-started | re-runs the command; the cost is time             |
      | shell (mutating) | unknown | halts at the needs_human gate of EPIC-06-S15         |
      | agent (resume)   | done    | resumes the session rather than re-prompting          |
      | agent (no resume)| not-started | replays the packet from the ledger                |

  Scenario: the window is shrunk, not closed
    Then markDone commits immediately after perform() returns, with no intervening await
    And the ledger's synchronous setting is NORMAL so that commit is fast
    And packages/orchestrator/README.md states that there is no two-phase commit with git,
        a shell command or an HTTP POST, and that this window is irreducible

  Scenario: an irreversible external effect pays for full durability
    Given an effect declared irreversible (a publish, a deploy, a push to a remote)
    When its done row is committed
    Then that single transaction runs under withFullSync
    And the rest of the ledger stays at synchronous = NORMAL
```

**Notes:** _"Every design that claims exactly-once side effects against git and a shell is lying."_
The measured price of the alternative is why `NORMAL` is the default: **979 ev/s at
`synchronous = FULL` versus 22,982 ev/s at `NORMAL`**, roughly a **23×** penalty, so `FULL` is
applied per-transaction around genuinely irreversible effects rather than globally. And `NORMAL`
itself is honest about what it buys — **Verified 2026-08-02**, SIGKILL mid-write at ~45k committed
rows recovered all **45,339** rows with `PRAGMA integrity_check = ok`, but a kernel panic or a power
cut can still lose the most recent commits.

---

## EPIC-06-S17 — Crash-resume memoises; failure-retry re-executes

**Verifies:** KAR-06.3, KAR-06.5 · **Type:** Edge case (known hole) · **Automated at:** integration

```gherkin
Feature: Two operations that look identical and are not

  Scenario: crash-resume — SAME attempt, memoise
    Given node "implement" is at attempt 1 with an effect done at ikey ".../implement/1/0"
    When the daemon is SIGKILLed and restarts
    Then the node resumes at attempt 1
    And the ikey computed for its first effect is ".../implement/1/0" — unchanged
    And the done row short-circuits: perform() is not called
    And EffectCtx.mode is "resume"

  Scenario: failure-retry — NEW attempt, re-execute
    Given node "implement" failed at attempt 1 with class "transient"
    When the backoff wake fires and the node is retried
    Then it runs at attempt 2
    And the ikey computed for its first effect is ".../implement/2/0" — a DIFFERENT key
    And no effect row exists for it, so perform() IS called
    And EffectCtx.mode is "fresh"
    And the mock agent's side-effect log now contains two lines with different ikeys

  Scenario: the adapter is told which situation it is in
    Then every EffectRunner receives EffectCtx.mode of "fresh" or "resume"
    And a test asserts an adapter that ignores mode fails the conformance suite,
        because "re-run this" and "check whether this already ran" are different instructions

  Scenario: the two are distinguishable in the timeline
    Given the ledger contains both a crash-resume and a failure-retry for the same node
    When the run timeline is projected
    Then the retry shows as a new attempt with its own node.started
    And the resume shows as a continuation of the existing attempt with no new node.started
```

**Notes:** [05-durable-execution §9.2](../../05-durable-execution.md): _"`attempt` is part of the
key, so a retry mints a new key by construction. That is intentional, but it means crash-resume and
failure-retry are genuinely different operations."_ The reason this needs its own scenario rather
than a comment is that the code paths converge — both arrive at `durable()` — and the only thing
that distinguishes them is a number inside a string. A test that asserts both ikeys and both
side-effect-log shapes is the cheapest possible guard.

---

## EPIC-06-S18 — Error class drives retry, fail or gate

**Verifies:** KAR-06.5 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Classification happens at construction, not at render time

  Scenario Outline: the scheduler reads class and nothing else
    Given a node fails with NodeFailure { reason: <reason>, class: <class> }
    When decide() is called on the next tick
    Then the action is <action>

    Examples:
      | reason                          | class     | action                                                     |
      | provider.rate-limited           | transient | node.retry.scheduled with a backoff wake                   |
      | timeout                         | transient | node.retry.scheduled with a backoff wake                   |
      | adapter.spawn-failed            | permanent | node.failed final; dependency.failed propagated            |
      | contract.schema-invalid         | permanent | node.failed final; dependency.failed propagated            |
      | safety.pathscope-violation      | permanent | node.failed final; dependency.failed propagated            |
      | effect.request-hash-mismatch    | permanent | node.failed final; no retry, no gate                       |
      | effect.reconcile-unknown        | gate      | node.suspended + run.needs_human                           |
      | budget.cost-exceeded            | gate      | budget.exceeded + run.paused, work preserved               |
      | agent.schema-repair-exhausted   | permanent | node.failed final                                          |

  Scenario: the same reason classifies differently by context
    Given "provider.unavailable" because the vendor is rate-limiting
    Then class is "transient" and the node is retried
    Given "provider.unavailable" because the user uninstalled the binary mid-run
    Then class is "permanent" and the node fails
    And in both cases the classifier assigned class when the NodeFailure was CONSTRUCTED

  Scenario: the scheduler never branches on reason
    Given a source scan of packages/orchestrator/src
    Then no NodeFailureReason string literal appears outside the classifier module

  Scenario: retry.onFailure overrides the class default
    Given retry.onFailure contains { when: "provider.rate-limited", action: "reroute" }
    When that failure occurs
    Then a PlanPatch proposal changing the node's provider is emitted
    And it is visible in the plan-evolution scrubber rather than happening silently
```

**Notes:** _"`class` is not derived from `reason` at render time"_ is the rule the third scenario
enforces mechanically. The `reroute` case matters for F3.9 — automatic re-routing to a healthy
provider is recorded as a `PlanPatch` precisely so it shows up in the visualisation, because a
silent provider swap is exactly the kind of thing that makes a run's cost profile inexplicable
afterwards.

---

## EPIC-06-S19 — Full jitter spreads a correlated rate-limit retry storm

**Verifies:** KAR-06.5 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Backoff with full jitter

  Scenario: the formula and its bounds
    Given base 2000 ms, cap 300000 ms and a seeded generator
    Then delay = random() * min(cap, base * 2 ** (attempt - 1))
    And for attempt 1 the delay is in [0, 2000)
    And for attempt 2 the delay is in [0, 4000)
    And for attempt 8 the delay is in [0, 256000)
    And for attempt 9 and beyond the delay is in [0, 300000) — capped

  Scenario: correlated failures do not retry in lockstep
    Given 20 nodes all fail with "provider.rate-limited" at the same instant
    When their backoff wakes are computed at attempt 1
    Then the 20 wake_at values are distinct
    And they span more than 80% of the [now, now+2000) window
    And no two are within 10 ms of each other

  Scenario: randomness comes through a port
    Given the seeded generator is initialised with seed 42
    When attempts 1 through 6 are computed
    Then the delays equal the recorded golden sequence exactly
    And Math.random is never called inside @DeFlow/core
```

**Notes:** Full jitter rather than equal jitter or none, _"because the common failure here is
correlated: several nodes hit the same vendor rate limit at the same moment, and you do not want
them retrying in lockstep and re-tripping it."_ The architecture writes the formula with
`Math.random()` as shorthand; copying that literally into `@DeFlow/core` breaks NF9 and makes the
third scenario impossible to write, which is why the third scenario exists.

---

## EPIC-06-S20 — `node.failed` and the `node_wake` row commit together

**Verifies:** KAR-06.5, KAR-06.6 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: One transaction, or the backoff is a lie

  Scenario: the three writes are atomic
    When a transient failure is recorded for node "implement" at attempt 1
    Then one transaction contains
        the node.failed event,
        the node.retry.scheduled { node, nextAttempt: 2, wakeAt } event,
        and the node_wake upsert with reason "backoff"

  Scenario: a rollback leaves nothing behind
    Given the transaction is forced to ROLLBACK after the node.failed insert
    Then no node.failed event exists
    And no node.retry.scheduled event exists
    And no node_wake row exists
    And the AUTOINCREMENT values it consumed are burned — the next event's seq has a gap

  Scenario: restarting inside the backoff window neither storms nor double-counts
    Given a backoff wake 240 seconds out and attempt at 1
    When the daemon is SIGKILLed and restarted 5 seconds later
    Then the node's wakeAt is read from the node_wake row, not recomputed
    And attempt is still 1
    And decide() returns no StartNode for it until clock.advance reaches wakeAt
    And exactly one StartNode is returned then, at attempt 2
```

**Notes:** _"Split them and a restart inside the backoff window either loses the delay (immediate
retry storm) or double-counts the attempt."_ The second scenario's final line is a deliberate
reminder of EPIC-03's contract: one global sequence is shared by every run and `AUTOINCREMENT` never
reissues a pruned number, so **sequence numbers have gaps**, and every consumer must resume from
strictly-greater-than rather than assuming `cursor + 1`.

---

## EPIC-06-S21 — A 30-day gate written with `setTimeout` fires after 1 ms

**Verifies:** KAR-06.6 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Why durable wake rows exist at all

  Scenario: the verified Node behaviour this design routes around
    Given a delay of 2**31 milliseconds — one over Node's maximum of 2**31 - 1 (24.9 days)
    When it is passed to setTimeout
    Then the callback fires after approximately 1 millisecond
    And no exception is thrown and no clamping occurs
    And the only signal is a TimeoutOverflowWarning on stderr

  Scenario: the same wait as a node_wake row
    Given a human gate 30 days out
    When it is stored as
        INSERT INTO node_wake(run_id, node_id, wake_at, reason) VALUES (?,?,?, 'human_gate')
          ON CONFLICT(run_id,node_id) DO UPDATE SET wake_at=excluded.wake_at, reason=excluded.reason
    And clock.advance(days(29)) is applied
    Then the node does not become ready
    When clock.advance(days(1)) is applied
    Then "SELECT * FROM node_wake WHERE wake_at <= ?" returns it and it becomes ready exactly once

  Scenario: the ticker's only permitted timer
    Given a source scan of packages/orchestrator/src
    Then the single permitted setTimeout call site is the ticker's sleep hint
        setTimeout(min(nextWakeAt - now, 1000))
    And it is named explicitly in the lint rule's allowlist
    And every other wait in the system is a node_wake row
```

**Notes:** **Verified 2026-08-02.** The first scenario is a regression test against Node itself, kept
because the failure it describes is invisible: _"a 30-day human gate implemented with `setTimeout`
fires instantly and nothing in your logs says 'durability failure'."_ Below the ceiling it is no
better — timers do not fire during laptop sleep and do not survive a restart at all.

---

## EPIC-06-S22 — A six-hour human gate across laptop sleep costs one row

**Verifies:** KAR-06.6 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Long suspension (F4.8) and NF4

  Scenario: four problems, one mechanism
    Given a "human" node emits human.requested and node.suspended
    Then exactly one node_wake row exists for it with reason "human_gate"
    And the node holds no agent slot, no repo lock, no worktree lock and no child process
    And runningInClass excludes it

  Scenario: six hours pass in microseconds
    When clock.advance(hours(6)) is applied
    Then the wall clock has not advanced
    And the ticks in between performed no writes beyond the due-row SELECT

  Scenario: the gate survives a restart and a sleep
    Given the wake is 6 hours out
    When the daemon is SIGKILLed at hour 2 and restarted at hour 5
    Then the node_wake row is intact with its original wake_at
    And the node becomes ready at hour 6 and not before

  Scenario: the wall clock is not monotonic
    Given now moves BACKWARDS by one hour, as laptop sleep and NTP correction both do
    When the ticker runs across the correction and then forward by two hours
    Then every due wake fires exactly once
    And no wake is skipped
    And no ordering decision anywhere compared two timestamps to each other — ordering is by seq

  Scenario: the consumption of a due row is atomic with its effect
    Given a wake row is due
    When the daemon is SIGKILLed between the SELECT and the resulting event append
    Then after restart the row still exists and fires normally
```

**Notes:** The payoff the architecture claims is real and worth stating in the suite: a six-hour
human gate, laptop sleep across that gate, crash-and-restart mid-wait, and retry backoff are **the
same mechanism** — one code path exercised constantly instead of four exercised rarely. The
non-monotonic-clock scenario guards §9.6: _"any logic that compares two timestamps to decide what
happened first is a bug waiting for a daylight-saving transition."_

---

## EPIC-06-S23 — Pause is an event, so it survives a restart

**Verifies:** KAR-06.7 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Pause, resume and cancel are events, never in-memory flags (F4.4)

  Scenario: pausing stops admission but not in-flight work
    Given two nodes are running and three are ready
    When run.pause.requested { by: "user" } is appended
    Then the run's projected status is "paused"
    And decide() returns zero StartNode commands on the next tick
    And the two running nodes are NOT cancelled
    And their node.completed events are accepted normally and their locks released

  Scenario: pause survives kill -9
    Given the run is paused
    When the daemon is SIGKILLed and restarted
    Then the run comes back "paused"
    And 100 subsequent ticks produce no StartNode
    And no in-memory flag was consulted — reduce() alone produced the status

  Scenario: resume re-admits under the same semaphores
    Given a paused run in which node "impl-auth" still holds the repo lock
    When run.resumed is appended
    Then decide() admits work on the next tick
    And "impl-router" is still withheld because the repo lock is still held
    And when impl-auth completes, impl-router is admitted

  Scenario: pause is auditable
    Then run.pause.requested and run.resumed appear in the run timeline with their ts and by
    And the paused interval is renderable as a gap in the Gantt
```

**Notes:** _"Because they are events, pause survives a restart, appears in the timeline, and is
auditable — a flag on an object satisfies none of those."_ The aggressive mode, in which in-flight
nodes are suspended rather than allowed to finish, is the same event with a different payload and
should not become a second code path.

---

## EPIC-06-S24 — Cancel escalates through three stages; zombies are not survivors

**Verifies:** KAR-06.7 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The kill switch's scheduling contract (F5.7)

  Scenario: cooperative cancel lets the agent flush
    Given a mock agent scripted to emit two session/update notifications AFTER a cancel
    When run.cancel.requested { mode: "cooperative" } is appended
    Then session/cancel is sent first
    And the prompt response returns stopReason "cancelled"
    And the client keeps accepting the trailing notifications without deadlocking

  Scenario: forceful cancel escalates and records every stage
    Given a mock agent that ignores SIGTERM
    When run.cancel.requested { mode: "forceful" } is appended
    Then process.kill(-pid, "SIGTERM") is issued — note the NEGATIVE pid
    And after the 5 second grace period process.kill(-pid, "SIGKILL") is issued
    And after a further 2 seconds the outcome is verified
    And each stage is an event carrying pid and pgid

  Scenario: a successful group kill leaves zombies, and that is not a failure
    Given a detached child spawned as bash -c "sleep 300 & sleep 300 & sleep 300; wait"
    And all four processes share pgid === child.pid
    When process.kill(-child.pid, "SIGKILL") is issued
    Then "ps -eo pid,pgid,stat | awk -v g=$PGID '$2==g && $3 !~ /Z/'" returns empty
    And an unfiltered ps STILL LISTS the grandchildren in state Z with ppid 1
    And the kill is reported as successful

  Scenario: the positive-pid regression guard
    When process.kill(child.pid, "SIGTERM") is issued with a POSITIVE pid
    Then the direct child dies
    And BOTH grandchildren remain alive, reparented to ppid 1
    And this test exists so nobody "simplifies" the negative pid away

  Scenario: a kill that did not take is an event
    Given a process that survives all three stages
    Then a typed failure event is appended naming the surviving pids
    And the run does not silently continue and does not wedge

  Scenario: cancelled nodes leave no ambiguity behind
    Then every lock the node held is released
    And its in-flight effect rows move to "failed" with NodeResult.status "cancelled"
    And a later restart does not reconcile them as prior-epoch ambiguous pending rows
```

**Notes:** Both traps are **Verified**. The positive-pid form killed only the direct child and left
both grandchildren alive; only the negative form killed everything — and agent CLIs spawn their own
subprocess trees (git, node, ripgrep) that `child.kill()` would leave running. The zombie
false-negative _"costs hours"_: after a successful group SIGKILL `ps` still lists the grandchildren
in state `Z` awaiting reaping by init, and reaping is prompt under launchd and systemd but can lag
badly inside containers — so this bites hardest in CI, where an intermittently-failing kill-switch
test is the least welcome kind of flake.

---

## EPIC-06-S25 — Killing by bare pid after a restart kills the operator's editor

**Verifies:** KAR-06.7, KAR-06.9 · **Type:** Failure (known hole) · **Automated at:** integration

```gherkin
Feature: The pid-reuse guard

  Scenario: the journal records identity, not just a number
    When an agent is spawned { detached: true }
    Then the ledger records (pid, process_start_time) for it
    And process_start_time comes from /proc/<pid>/stat field 22 on Linux
    And from "ps -o lstart= -p <pid>" on macOS

  Scenario: a reused pid is not killed
    Given the ledger records pid 4242 with process_start_time T0 for a dead agent
    And the OS has since assigned pid 4242 to a DIFFERENT process with start time T1 != T0
    When the orphan reaper runs at daemon start
    Then it does NOT signal pid 4242
    And it appends a log line naming the skip reason "pid-reused"
    And the unrelated process is still alive afterwards

  Scenario: a genuine orphan IS killed
    Given the ledger records pid 4243 with process_start_time T0
    And pid 4243 is still the same process with start time T0
    When the reaper runs
    Then process.kill(-4243, "SIGTERM") is issued and the escalation ladder applies

  Scenario: the guard is not optional
    Given a source scan of packages/orchestrator/src
    Then no call site signals a journaled pid without first comparing process_start_time
    And a test forces a pid collision rather than asserting the comparison exists in the abstract
```

**Notes:** [05-durable-execution §9.4](../../05-durable-execution.md) states it as an absolute:
**"Never kill by bare pid after a restart. Pids are recycled. You will eventually kill the user's
editor."** The reason this needs a forced-collision test rather than a code review is that the naive
version works perfectly every single time in development — pid reuse needs the pid space to wrap,
which on a developer laptop takes days. The failure lands in production, on someone else's machine,
looking like an unrelated crash.

---

## EPIC-06-S26 — The stall detector reports and never auto-kills

**Verifies:** KAR-06.8 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: The progress watermark (F4.7)

  Scenario: the data plane does not advance the watermark
    Given a node is running and streaming output
    When 10000 io_chunk rows and 50 node.progress events are appended
    Then progress_watermark is unchanged
    And the reducer never read io_chunk

  Scenario: a stall is reported once per episode
    Given one node is running and the watermark last moved at T
    When clock.advance is applied to reach T + 10 minutes 1 second
    Then exactly one run.stalled { watermarkSeq, idleMs, runningNodes } is appended
    When a further 10 minutes pass with no progress
    Then no second run.stalled is appended for the same episode

  Scenario: nothing is killed, failed or rescheduled
    Given the run is stalled
    When decide() is called
    Then the returned commands are deeply equal to those returned on the tick before the stall
    And no CancelNode command is returned
    And no node.failed is appended

  Scenario: the threshold is not tripped early
    Given the watermark last moved 9 minutes 59 seconds ago
    Then no run.stalled is appended

  Scenario: a silent agent that then makes progress never trips it
    Given an agent thinks for 8 minutes and then emits node.completed
    Then no run.stalled was ever appended
    And the watermark advanced on the completion
```

**Notes:** The elegance here _"falls out of the schema for free"_: agent stdout lives in `io_chunk`
and never touches the reducer, so megabytes of output accomplishing nothing does not advance the
watermark, and eight minutes of silence before a real transition does not falsely trip it. And the
deliberate restraint — **do not auto-kill** — is a design decision, not an omission: _"a legitimately
long build, a large test suite and a wedged agent look identical from here, and killing a 40-minute
integration run because it was quiet for 10 minutes is a worse failure than the one being
prevented."_

---

## EPIC-06-S27 — The churn breaker trips on the same work redone five times

**Verifies:** KAR-06.8 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: The churn circuit breaker

  Scenario: the same (node_id, request_hash) more than N=5 times in the last M=20 attempts
    Given a sliding window of the last 20 completed node attempts
    And the pair ("repair-auth", "h:9f2a1c") appears 5 times in it
    When decide() is called
    Then the breaker does NOT trip
    When a 6th completed attempt with the same pair enters the window
    Then run.needs_human { reason: "churn", detail } is appended
    And the run's projected status becomes "needs_human"
    And decide() returns no further StartNode

  Scenario: the window is bounded, so old churn ages out
    Given the same pair appeared 6 times but 21 completed attempts have since occurred
    Then the breaker does not trip

  Scenario: differing inputs are not churn
    Given "repair-auth" runs 8 times with 8 DIFFERENT request_hash values
    Then the breaker does not trip — the node is making different attempts, not the same one

  Scenario: in-flight work is allowed to finish
    Given the breaker trips while two nodes are running
    Then those nodes are not cancelled
    And their completions are recorded normally
    And no NEW node is started

  Scenario: the detail is diagnosable
    Then the run.needs_human detail contains the window's contents —
        the (node_id, request_hash, attempt, seq) tuples that produced the trip
```

**Notes:** _"The same work being redone with the same inputs, which is the literal definition of a
livelock."_ M = 20 and N = 5 are practitioner defaults mirroring what the agent-runtime ecosystem
converged on during 2026 — sliding-window tool-call dedup with small consecutive-no-progress
thresholds — not measured values. Emitting the window contents in the detail is what makes the first
few real trips tunable rather than mysterious. The M1 metric is **runs abandoned due to runaway loop
< 5%**.

---

## EPIC-06-S28 — Three replans with no completed-node increase trip the breaker

**Verifies:** KAR-06.8 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: The planner rearranging deck chairs

  Scenario: flat progress across three consecutive replans
    Given the completed-node count is 7
    When plan.patched is reduced three consecutive times
    And the completed-node count is still 7 after the third
    Then run.needs_human { reason: "churn" } is appended
    And the detail names the three plan versions and the flat count

  Scenario: progress between replans resets the counter
    Given two consecutive replans with a flat count
    When a node completes, raising the count to 8
    And a third replan occurs
    Then the breaker does not trip
    And the consecutive counter restarts from that replan

  Scenario: hard caps backstop the detectors rather than replacing them
    Given the detectors are disabled in config
    Then maxAttemptsPerNode (default 3, matching F7.5's surgical repair cap) still fires
    And maxRunWallClock still fires
    And maxTotalNodeExecutions still fires
    And each produces a typed failure naming WHICH cap fired

  Scenario: the detectors are pure
    Given a 40-minute stall and a 20-attempt churn window
    When both are exercised via clock.advance in a unit test with no database and no spawn
    Then both trip correctly
    And the whole file runs in under a second
```

**Notes:** The replan detector is the schedule lever named in the epic's Risks — it can ship after
the `(node_id, request_hash)` detector if the epic runs long. The hard caps exist _"to bound the
blast radius of a detector bug, not as the primary mechanism"_, which is why the third scenario
tests them with the detectors switched off.

---

## EPIC-06-S29 — Crash-fuzz: SIGKILL at a random point, restart, four invariants

**Verifies:** KAR-06.9 · **Type:** Recovery · **Automated at:** e2e (crash-fuzz project)

```gherkin
Feature: The test that proves the thesis

  Background:
    Given DeFlowd is started as a child process with mock agents on a temp PATH
    And a scripted multi-node run with a known expected duration
    And every mock agent runs with --seed so the pre-crash side is deterministic
    And each fake binary appends {runId, nodeId, attempt, idempotencyKey} to a side-effect log
        on every invocation
    And the harness snapshots the SSE-projected state on every event

  Scenario Outline: kill, restart, assert
    Given the run has been executing for a random interval within its expected duration,
          seeded from $GITHUB_RUN_ID so a failure is reproducible from the log
    When the daemon is killed with <signal>
    And DeFlowd is restarted over the same .DeFlow directory
    Then no idempotencyKey appears twice in the side-effect log
    And the reduced state equals the pre-crash projection at the last durably-written seq
    And PRAGMA integrity_check returns "ok"
    And the run either completes or halts with a typed NodeFailure — it never wedges

    Examples:
      | signal  |
      | SIGKILL |

  Scenario: SIGKILL, not SIGTERM
    Then the harness sends signal 9 with no cleanup, no flush and no handlers
    And a SIGTERM variant is explicitly NOT used here, because SIGTERM tests the shutdown
        handler while SIGKILL tests durability

  Scenario: sequence gaps are expected, not a corruption signal
    Given the crash rolled back an in-flight transaction
    Then the ledger's seq values contain a gap
    And the post-restart projection resumes from "strictly greater than my cursor"
    And no consumer assumed the next event is cursor + 1

  Scenario: startup ordering
    Then the restart sequence is, in order:
        take flock, bump daemon_epoch, rebuild RunState, reconcile every prior-epoch pending
        effect, reclaim locks whose owners are gone, reap orphans, load due node_wake rows,
        start the ticker
    And no StartNode command is issued before reconciliation has completed

  Scenario: failures are diagnosable in CI
    Given DeFlow_KEEP_TMP=1 is set
    When an iteration fails
    Then actions/upload-artifact captures /tmp/DeFlow-* including the ledger
```

**Notes:** _"Everything else in the durability design is theory until this test is green."_ The
shape was already run against SQLite during the research pass and passed — **45,339 rows recovered
after SIGKILL, `integrity_check` ok** — so the harness is cheap to build and known to be worth
building. Assertion (a) is a duplicate-key check on a text file rather than an inference, which is
why the fake binaries' side-effect log is a hard requirement on EPIC-04 rather than a nicety.

---

## EPIC-06-S30 — Orphaned detached agents keep burning tokens after the daemon dies

**Verifies:** KAR-06.9 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Orphan reaping on boot

  Scenario: the orphan really does survive
    Given a mock agent is running as a detached child of DeFlowd
    When DeFlowd is killed with SIGKILL
    Then the agent process is STILL RUNNING
    And it has been reparented to ppid 1
    And it continues consuming CPU — in the real case, tokens

  Scenario: the reaper finds and kills it
    When DeFlowd restarts
    Then it reads the journaled (pid, process_start_time) pairs for the prior epoch
    And for each pair whose live process matches BOTH values it issues
        process.kill(-pid, "SIGTERM") followed by the escalation ladder
    And the orphan is gone, verified with the Z-state filter applied
    And an event records the reap with the pid, pgid and outcome

  Scenario: a worktree whose owner is gone is unlocked
    Given a git worktree was locked by a node whose process is provably dead
    When the reaper runs
    Then "git worktree unlock" is issued for it
    And the worktree is available to a subsequent node

  Scenario: an orphan that already exited is not an error
    Given the journaled pid no longer exists at all
    Then the reaper records a no-op reap and does not fail startup
```

**Notes:** §9.4 is blunt about why this matters: agents are spawned `{ detached: true }`, so _"when
DeFlowd dies they are reparented to init and keep running and keep burning tokens"_. The first
scenario asserting the orphan survives is not padding — it is the precondition that makes the rest
meaningful, and it is the assertion that fails if someone changes the spawn options to
non-detached, which would be worse than useless because then the only process group containing the
grandchildren is DeFlowd's own.

---

## EPIC-06-S31 — A budget ceiling pauses the run instead of failing it

**Verifies:** KAR-06.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Hitting a ceiling is a gate, not a permanent failure (F4.6, F9.2)

  Scenario: the run pauses with its work intact
    Given a run budget ceiling in USD and 6 of 9 nodes completed
    When budget.exceeded { scope: "run", dimension: "cost", limit, actual } is appended
    Then the failure class is "gate", never "permanent"
    And run.paused is appended
    And decide() returns no StartNode
    And every completed node's output, worktree and effect rows are untouched

  Scenario: the operator can raise the ceiling and continue
    When the ceiling is raised and run.resumed is appended
    Then the three remaining nodes are admitted under the usual semaphores
    And no completed node is re-executed

  Scenario: a wall-clock ceiling behaves identically
    Given a maxWallClockMs ceiling on a node
    When clock.advance passes it
    Then budget.exceeded { dimension: "wallclock" } is appended with class "gate"
    And the run pauses rather than failing

  Scenario: the ceiling is never computed from mixed token sources
    Given TokenUsage carries source "vendor-reported" or "estimated"
    Then a ceiling computed from a silently-mixed number is rejected
    And the projection reports which source each figure came from,
        because estimated figures carry a known 15-20% undercount on Claude prose
```

**Notes:** _"Hitting a budget ceiling is deliberately a `gate`, not a `permanent` failure: the run
pauses for a human decision rather than dying with hours of work half-done."_ This epic owns only
the classification and the pause; the accounting, the pre-flight estimate and the ceiling values
belong to [EPIC-14](../epics/EPIC-14-cost-governance.md). The fourth scenario is here rather than
there because the failure it prevents — a ceiling firing at the wrong time because vendor-reported
and estimated figures were added together — surfaces as a scheduling bug.

---

**Related:** [EPIC-06](../epics/EPIC-06-orchestrator.md) · [Board](../board.md) ·
[05-durable-execution.md](../../05-durable-execution.md) ·
[04-domain-model.md](../../04-domain-model.md) ·
[07-provider-adapter-layer.md](../../07-provider-adapter-layer.md) ·
[09-workspace-and-safety.md](../../09-workspace-and-safety.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
