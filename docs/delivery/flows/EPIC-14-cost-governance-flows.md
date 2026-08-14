# EPIC-14 flows — Cost, budget and quota governance

> Behavioural specification for [EPIC-14](../epics/EPIC-14-cost-governance.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor                   | Description                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator**            | The engineer driving DeFlow. Sets ceilings, answers a budget pause, raises a ceiling and resumes                                                                            |
| **DeFlowd**             | The local daemon: scheduler, ledger, reducer, 1 Hz ticker                                                                                                                   |
| **Accountant**          | `packages/cost` — normalises vendor usage into `TokenUsage`, appends `budget.consumed`, projects the rollups                                                                |
| **Estimator**           | `packages/cost/src/estimate.ts` — the pure pre-flight function over Tier-2 counts and the calibration factor                                                                |
| **Scheduler**           | `decide(state, now)` — evaluates ceilings before admission, writes `node_wake` rows                                                                                         |
| **Provider agent**      | A `deflow-mock-agent` subprocess on a temp `PATH`, or the `packages/testkit` fake exec-shim agent when a vendor-shaped `stream-json` / JSONL envelope is what is under test |
| **Patch policy engine** | [EPIC-11](../epics/EPIC-11-dynamic-planning.md) KAR-11.4 — reads `estimate.costUsdDelta` and `elapsedBudgetFraction`                                                        |
| **Capability manifest** | The persisted probe result carrying `tokenAccounting` and `tokenEstimateFactor` per (provider, model)                                                                       |

## Preconditions common to all flows

```gherkin
Background:
  Given a DeFlow workspace initialised in a real git repository on branch "main"
  And the repository was created by "git init -b main" with
      GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_SYSTEM=/dev/null and forced identity env
  And the ledger is a file-backed SQLite database opened with
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000"
  And "deflow-mock-agent" is symlinked onto a temp PATH under the vendor binary names the run uses
  And the fixture corpus under "test/fixtures/streams/" contains a Claude Code "result" envelope
      with populated modelUsage, a "rate_limit_event" frame carrying resetsAt, a "result" with
      subtype "error_max_budget_usd", and a Codex "turn.completed" with usage
  And time enters the engine through an injected Clock port, never Date.now()
  And no test in this file calls vi.useFakeTimers() while a child process is alive
  And the normalising snapshot serializer is registered before the first snapshot is written
  And a TaskSpec has been approved, producing "run.spec.approved"
```

> Two of these are load-bearing rather than hygiene. **File-backed SQLite** is mandatory for every
> pause-and-resume and crash scenario below: `:memory:` cannot be reopened after a simulated crash,
> which is precisely the property a budget pause has to survive
> ([testing strategy §7](../../14-testing-strategy.md)). And **the injected `Clock`** is what makes a
> six-hour wall-clock ceiling and a four-hour quota suspension cost microseconds — while
> `vi.useFakeTimers()` with a live child process deadlocks, which matters because every scenario here
> is _about_ time _around_ a subprocess.

## Flow index

| Scenario    | Title                                                                                  | Verifies | Type        |
| ----------- | -------------------------------------------------------------------------------------- | -------- | ----------- |
| EPIC-14-S1  | Happy path: a completed node's spend lands as `budget.consumed` with provenance        | KAR-14.1 | Happy path  |
| EPIC-14-S2  | Vendor-reported and estimated figures are reported side by side, never summed          | KAR-14.1 | Edge case   |
| EPIC-14-S3  | `tokenAccounting: 'none'` produces a blank cost, not a zero                            | KAR-14.1 | Edge case   |
| EPIC-14-S4  | Subscription quota and API-key currency are two totals, not one                        | KAR-14.1 | Edge case   |
| EPIC-14-S5  | A failed attempt's spend counts; a retry does not refund it                            | KAR-14.1 | Edge case   |
| EPIC-14-S6  | Replay after `kill -9` reproduces the rollups and double-counts nothing                | KAR-14.1 | Recovery    |
| EPIC-14-S7  | Megabytes of stdout move no cost figure                                                | KAR-14.1 | Edge case   |
| EPIC-14-S8  | Happy path: the cost ceiling pauses the run and stops admission                        | KAR-14.2 | Happy path  |
| EPIC-14-S9  | **A paused run retains full state and resumes when the ceiling is raised**             | KAR-14.2 | Recovery    |
| EPIC-14-S10 | Every dimension × scope produces the right `budget.exceeded` payload                   | KAR-14.2 | Edge case   |
| EPIC-14-S11 | A node ceiling suspends one branch; siblings keep running                              | KAR-14.2 | Edge case   |
| EPIC-14-S12 | The pause survives `kill -9` and resumes after restart                                 | KAR-14.2 | Recovery    |
| EPIC-14-S13 | A cost ceiling on an unmeasurable provider is declared unenforceable up front          | KAR-14.2 | Failure     |
| EPIC-14-S14 | The vendor's own ceiling (`error_max_budget_usd`) pauses; it is never retried          | KAR-14.2 | Failure     |
| EPIC-14-S15 | Happy path: a whole-plan estimate is on the spec-approval surface before `run.started` | KAR-14.3 | Happy path  |
| EPIC-14-S16 | The three worked patch examples reproduce exactly                                      | KAR-14.3 | Happy path  |
| EPIC-14-S17 | `elapsedBudgetFraction >= 1.0` rejects the patch and names the rule                    | KAR-14.3 | Failure     |
| EPIC-14-S18 | **An unpriceable node estimates `null`, and `null` never reads as cheap**              | KAR-14.3 | Failure     |
| EPIC-14-S19 | Seed factor below five samples, learned factor from five                               | KAR-14.3 | Edge case   |
| EPIC-14-S20 | Estimate versus actual is reconciled and the accuracy is visible                       | KAR-14.3 | Edge case   |
| EPIC-14-S21 | Happy path: `resetsAt` becomes a `node_wake` row and the run sleeps for free           | KAR-14.4 | Happy path  |
| EPIC-14-S22 | **The `2**31` timer footgun: a long wake must be a row, never a timer\*\*              | KAR-14.4 | Failure     |
| EPIC-14-S23 | The suspension survives `kill -9` and a laptop sleep                                   | KAR-14.4 | Recovery    |
| EPIC-14-S24 | Re-route only onto a capability superset, and only through the policy engine           | KAR-14.4 | Edge case   |
| EPIC-14-S25 | No capable provider: suspend, do not reroute, do not kill the run                      | KAR-14.4 | Failure     |
| EPIC-14-S26 | Correlated limits: three nodes, three distinct jittered wakes, one transaction each    | KAR-14.4 | Concurrency |
| EPIC-14-S27 | An adapter with no rate-limit signal degrades to blind backoff, honestly labelled      | KAR-14.4 | Edge case   |
| EPIC-14-S28 | The **ACP** path normalises to the same `provider.rate_limited` (added)                | KAR-14.4 | Edge case   |

---

## EPIC-14-S1 — Happy path: a completed node's spend lands as `budget.consumed` with provenance

**Verifies:** KAR-14.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Live per-node, per-provider, per-run accounting

  Scenario: one agent node completes on the Claude Code shim path
    Given a run "r1" with one agent node "n_impl_1" routed to provider "claude"
    And the capability manifest for "claude" carries tokenAccounting "exact"
    And the fake exec-shim agent is scripted to emit the committed "result" envelope fixture
        whose modelUsage carries inputTokens 18420, outputTokens 2310, costUSD 0.42
    When the node completes
    Then the ledger contains one "budget.consumed" event for ("r1", "n_impl_1", attempt 1)
    And its payload usage.source is "vendor-reported"
    And its payload usage.inputTokens is 18420 and usage.outputTokens is 2310
    And its payload costUsd is 0.42
    And that event and "node.completed" carry adjacent seq values written in one transaction
    And the run rollup at "GET /api/runs/r1" reports costUsd.subscription 0.42
    And the run rollup reports unaccounted []
    And the per-provider rollup has exactly one key "claude"
    And no source file under packages/ reads the result envelope's "usage" field
```

**Notes:** the `usage` field is typed `z.unknown()` in the CLI's own zod schema — a raw passthrough
with no shape guarantee. `modelUsage` is typed and carries `contextWindow` and `maxOutputTokens`.
The grep in the last Then is a real CI check, not a stylistic preference: reading `usage` produces a
number that works on 2.1.220 and silently changes shape on the next release.

---

## EPIC-14-S2 — Vendor-reported and estimated figures are reported side by side, never summed

**Verifies:** KAR-14.1 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: The three accounting tiers are never silently mixed

  Scenario: one exact provider and one estimated provider in the same run
    Given a run "r1" with node "n_a" on provider "claude" whose manifest says tokenAccounting "exact"
    And node "n_b" on provider "opencode" whose manifest says tokenAccounting "estimated"
    And "budget.consumed" for "n_a" with usage.source "vendor-reported" and costUsd 1.10
    And "budget.consumed" for "n_b" with usage.source "estimated" and costUsd 0.65
    When reduce() projects the run rollup
    Then the rollup exposes costUsd.vendorReported 1.10
    And the rollup exposes costUsd.estimated 0.65
    And the rollup contains no field whose value is 1.75
    And every token total in the rollup carries the method that produced it
    And a figure constructed without a source or method fails to typecheck
```

**Notes:** the architecture's phrasing is a prohibition, not a preference — _"never silently mix the
tiers; every count carries its `method`"_. The `1.75` assertion is deliberately written as an
absence, because the natural implementation of a "run total" is exactly that sum and it will be
added by someone in week three unless a test forbids it.

---

## EPIC-14-S3 — `tokenAccounting: 'none'` produces a blank cost, not a zero

**Verifies:** KAR-14.1 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Honest degradation when a vendor reports nothing

  Scenario: a provider that reports no machine-readable usage
    Given the capability manifest for "gemini" carries tokenAccounting "none"
    And node "n_c" completed on provider "gemini"
    When reduce() projects the run rollup
    Then the per-node cost for "n_c" is null
    And "gemini" appears in the rollup's unaccounted list
    And the run total is rendered as a figure plus a named list of unaccounted providers
    And the projection type makes 0 unrepresentable as "unknown"
```

**Notes:** _"a blank cost cell, not a zero"_. A zero is a claim that nothing was spent, which is
false and which also makes a cost ceiling silently unenforceable — see EPIC-14-S13, which is the
consequence this scenario exists to make visible.

---

## EPIC-14-S4 — Subscription quota and API-key currency are two totals, not one

**Verifies:** KAR-14.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Auth mode changes what a cost figure means

  Scenario: one node on the subscription path and one on the explicit API-key path
    Given node "n_sub" ran with the run manifest recording provider.auth_mode "subscription"
    And node "n_key" ran with the run manifest recording provider.auth_mode "api_key"
    When reduce() projects the run rollup
    Then costUsd.subscription and costUsd.apiKey are separate fields
    And neither is derived from the other and no summed field exists
    And the node inspector payload for each node names its auth mode
    And a run containing an "api_key" node is labelled as such in the run summary
```

**Notes:** from the adapter layer — runs on the direct-API path _"are labelled in the ledger, because
their cost accounting (F9.1) is real currency rather than subscription quota, and the two must not be
summed into one number."_ The related security invariant is that the _effective_ auth mode of every
provider is a recorded, rendered fact and never something the user has to infer from a bill.

---

## EPIC-14-S5 — A failed attempt's spend counts; a retry does not refund it

**Verifies:** KAR-14.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Attempt-level attribution

  Scenario: attempt 1 burns tokens then fails, attempt 2 succeeds
    Given node "n_impl_1" whose provider is scripted to emit usage then exit non-zero on attempt 1
    And to complete normally on attempt 2
    When the node reaches "node.completed" on attempt 2
    Then the ledger contains two "budget.consumed" events for "n_impl_1", one per attempt
    And the node rollup reports per-attempt figures and a cumulative figure equal to their sum
    And the cumulative figure is greater than attempt 2's figure alone
    And the run rollup includes attempt 1's spend
```

**Notes:** the tempting simplification is to account only for the attempt that succeeded, because
that is the one that "produced value". The money is gone either way, and a repair loop capped at
three attempts can spend three times what a naive rollup reports — which is exactly the number a
budget ceiling has to be evaluated against.

---

## EPIC-14-S6 — Replay after `kill -9` reproduces the rollups and double-counts nothing

**Verifies:** KAR-14.1 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Accounting is a projection, so it survives a crash for free

  Scenario: SIGKILL mid-run, then a fresh engine over the same ledger file
    Given a scripted three-node run in progress with two "budget.consumed" events committed
    And the pre-crash rollup has been snapshotted by the harness
    When DeFlowd is killed with SIGKILL
    And a fresh engine is constructed over the same ledger.db file
    Then the replayed rollup is byte-identical to the pre-crash snapshot
    And PRAGMA integrity_check returns "ok"
    And no "budget.consumed" event exists twice for the same (runId, nodeId, attempt)
    And the resumed run appends no "budget.consumed" for any already-completed node
```

**Notes:** `kill -9`, not SIGTERM — SIGTERM tests the shutdown handler, SIGKILL tests durability.
De-duplication is the effect journal's `(runId, nodeId, attempt)` idempotency key doing its job, not
a uniqueness constraint on the projection; asserting it at the projection would hide a genuine
double-execution behind a silent dedup.

---

## EPIC-14-S7 — Megabytes of stdout move no cost figure

**Verifies:** KAR-14.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: The control-plane / data-plane split keeps accounting meaningful

  Scenario: an agent that produces a lot of output and accomplishes little
    Given node "n_noisy" whose provider is scripted to emit 5 MB of stdout before completing
    When the node runs
    Then every stdout byte is recorded in the io_chunk table
    And the run rollup changes only when the final "budget.consumed" event is appended
    And the reducer never reads io_chunk
    And the progress watermark is unchanged by the stdout burst
```

**Notes:** this falls out of the schema rather than being implemented — agent stdout lives in
`io_chunk` and never touches the reducer. It is worth a scenario anyway, because the first person to
"improve" the cost view by estimating tokens from stdout length will break both the accounting and
the no-progress detector in one commit.

---

## EPIC-14-S8 — Happy path: the cost ceiling pauses the run and stops admission

**Verifies:** KAR-14.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Budget ceilings pause rather than fail

  Scenario: the run rollup crosses the configured cost ceiling
    Given a run created with budget { costUsd: 0.50, wallclockMs: 14400000 }
    And a plan with five agent nodes, two of which have completed
    And the run rollup has reached costUsd 0.51
    When the scheduler evaluates decide(state, now)
    Then the ledger contains "budget.exceeded" with
        { scope: "run", dimension: "cost", limit: 0.50, actual: 0.51 }
    And "run.paused" with by "policy" follows it in the same transaction
    And "run.needs_human" with reason "budget" is appended
    And the recorded failure class is "gate", not "permanent" and not "transient"
    And no further "node.scheduled" event is appended for any pending node
    And any node already in state "running" reaches "node.completed" or "node.failed" normally
    And the run appears in "GET /api/approvals" with the budget reason
```

**Notes:** the pause is implemented at _admission_, not by terminating children. Tearing down a node
that is most of the way through a build to save a few cents turns a pause into a partial failure and
breaks EPIC-14-S9's promise.

---

## EPIC-14-S9 — A paused run retains full state and resumes when the ceiling is raised

**Verifies:** KAR-14.2 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: A ceiling is a decision point, not a way to lose four hours of work

  Scenario: the operator raises the ceiling and the run continues from where it stopped
    Given a run paused by "budget.exceeded" with scope "run" and dimension "cost"
    And nodes "n_recon" and "n_impl_1" are in state "completed"
    And node "n_impl_1" owns the worktree at ".DeFlow/runs/r1/worktrees/n_impl_1"
        on branch "DeFlow/r1__n_impl_1"
    And three facts written by "n_recon" are on the blackboard
    And the effect journal holds completed entries for both nodes' idempotency keys
    When the operator raises the run's costUsd ceiling to 5.00
    And "POST /api/runs/r1/resume" is called
    Then "run.resumed" is appended
    And no "node.started" event is appended for "n_recon" or "n_impl_1"
    And the effect journal returns memoised results for their idempotency keys rather than
        re-executing them
    And the worktree at ".DeFlow/runs/r1/worktrees/n_impl_1" is unchanged, still locked,
        and "git worktree list --porcelain -z" still reports it
    And the three blackboard facts are present with unchanged provenance
    And the plan version and planHash are unchanged
    And the next pending node is admitted and reaches "node.completed"
    And the run reaches "run.completed"
    And the run rollup includes the spend from before the pause
```

**Notes:** this is the scenario the whole story exists for. Nothing here needs a checkpoint
mechanism: the ledger _is_ the checkpoint, the effect journal is what makes "never re-execute"
mechanical rather than aspirational, and `run.paused`/`run.resumed` are ordinary events so the pause
is visible in the timeline afterwards. If any assertion in this scenario needs new persistence to
pass, the durability model has been bypassed somewhere upstream.

---

## EPIC-14-S10 — Every dimension × scope produces the right `budget.exceeded` payload

**Verifies:** KAR-14.2 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Both dimensions and both scopes are first class

  Scenario Outline: a ceiling trip in <scope>/<dimension>
    Given a ceiling of <limit> configured at scope "<scope>" for dimension "<dimension>"
    And reduced state whose <dimension> figure for that scope is <actual>
    When decide(state, now) evaluates the ceilings
    Then "budget.exceeded" is appended with
        { scope: "<scope>", dimension: "<dimension>", limit: <limit>, actual: <actual> }
    And the failure class is "gate"
    And the admission effect is "<effect>"

    Examples:
      | scope | dimension | limit    | actual   | effect                          |
      | run   | cost      | 25.00    | 25.40    | no node admitted anywhere       |
      | run   | wallclock | 14400000 | 14400001 | no node admitted anywhere       |
      | node  | cost      | 2.00     | 2.05     | that node suspended and escalated |
      | node  | wallclock | 600000   | 600001   | that node suspended and escalated |

  Scenario: wall-clock is measured on the injected Clock
    Given a run with a wallclockMs ceiling of six hours
    When the TestClock is advanced by six hours and one millisecond
    Then "budget.exceeded" with dimension "wallclock" is appended
    And no setTimeout or setInterval was used to detect it
```

**Notes:** the six-hour advance costs microseconds because the clock is a port. The `25.00 / 25.40`
row is lifted from the error envelope example in the API contract, so the wire message
_"Run budget of $25.00 exceeded; run is paused"_ and the ledger event agree on the same numbers.

---

## EPIC-14-S11 — A node ceiling suspends one branch; siblings keep running

**Verifies:** KAR-14.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Scope matters

  Scenario: a per-node ceiling trips on one branch of a fan-out
    Given a plan with two independent branches "n_a" and "n_b" under a completed recon node
    And a per-node costUsd ceiling of 0.10
    And "n_a" has consumed 0.11 while "n_b" has consumed 0.02
    When decide(state, now) evaluates the ceilings
    Then "budget.exceeded" is appended with scope "node" naming "n_a"
    And "n_a" is suspended and surfaced in "GET /api/approvals"
    And "n_b" continues and reaches "node.completed"
    And the run is not paused
    And dependents of "n_a" are not admitted, while dependents of "n_b" are
```

---

## EPIC-14-S12 — The pause survives `kill -9` and resumes after restart

**Verifies:** KAR-14.2 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Pause is an event, never an in-memory flag

  Scenario: SIGKILL after a budget pause, then restart
    Given a run paused by "budget.exceeded" with "run.paused" committed
    When DeFlowd is killed with SIGKILL
    And DeFlowd is restarted over the same .DeFlow/ directory
    Then ledger replay reconstructs the run in state paused
    And the scheduler admits no node on the first tick after restart
    And the run still appears in "GET /api/approvals" with reason "budget"
    When the ceiling is raised and "POST /api/runs/r1/resume" is called
    Then the run resumes exactly as in EPIC-14-S9
    And no effect appears twice in the effect journal
    And PRAGMA integrity_check returns "ok"
```

**Notes:** this is the crash-fuzz harness pointed at a specific interleaving. The failure it guards
against is the obvious implementation — a `paused` boolean on an in-memory run object — which passes
every test that does not restart the daemon.

---

## EPIC-14-S13 — A cost ceiling on an unmeasurable provider is declared unenforceable up front

**Verifies:** KAR-14.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: DeFlow does not claim a ceiling it cannot measure

  Scenario: a costUsd ceiling over a provider that reports no usage
    Given a run created with budget { costUsd: 25.00, wallclockMs: 14400000 }
    And the plan schedules node "n_x" onto provider "gemini"
    And the capability manifest for "gemini" carries tokenAccounting "none"
    When the plan is validated, before "run.started"
    Then "GET /api/runs/r1" reports budgetEnforceable false
    And the reason names provider "gemini" and node "n_x"
    And the spec-approval surface shows that marker before approval is possible
    And the wallclockMs ceiling is still reported as enforceable
    And "deflow doctor" lists "gemini" under providers with no cost accounting
```

**Notes:** this is EPIC-14-S3's consequence made explicit. Without it, a `tokenAccounting: 'none'`
provider contributes `null`, the rollup never reaches the ceiling, and the operator has a ceiling
that will never fire and no way to know. Refusing to run would be over-strict — the honest answer is
to say so loudly, before approval, while a different provider is still one edit away.

---

## EPIC-14-S14 — The vendor's own ceiling (`error_max_budget_usd`) pauses; it is never retried

**Verifies:** KAR-14.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Defence in depth below DeFlow's ceiling

  Scenario: Claude Code's own --max-budget-usd fires
    Given node "n_impl_1" is spawned with "--max-budget-usd 2.00"
    And the fake exec-shim agent is scripted to return the committed fixture
        { "type": "result", "subtype": "error_max_budget_usd", "is_error": true }
    When the node's process exits
    Then the failure is classified "gate", not "transient"
    And no "node.retry.scheduled" event is appended
    And no second attempt is started
    And "budget.exceeded" records that the vendor's own ceiling fired
    And the run pauses and appears in "GET /api/approvals"
```

**Notes:** the whole point of a `transient` classification is that a retry might succeed. A vendor
budget refusal will refuse identically three more times, at the cost of three more spawns. Copilot
CLI's `--max-ai-credits` is the same shape and belongs in the same classifier row once its exit
behaviour is verified.

---

## EPIC-14-S15 — Happy path: a whole-plan estimate is on the spec-approval surface before `run.started`

**Verifies:** KAR-14.3 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Pre-flight cost estimation

  Scenario: the operator sees the cost before approving the spec
    Given a validated plan v1 with four agent nodes routed to "claude"
    And the calibration for ("claude", "<model>") has n 24 and tokenEstimateFactor 1.18
    When the plan is validated
    Then "GET /api/runs/r1" contains a whole-plan estimate before "run.started" exists
    And every figure in it carries method "gpt-tokenizer/o200k_base"
    And every figure records the tokenEstimateFactor 1.18 and sample count 24 that were applied
    And the estimate is labelled as an estimate wherever it is rendered
    And "POST /api/runs/r1/spec/approve" is the only thing that starts execution
```

---

## EPIC-14-S16 — The three worked patch examples reproduce exactly

**Verifies:** KAR-14.3 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: The estimate drives the patch policy engine

  Scenario Outline: <name>
    Given a PlanPatch whose estimate is
        { costUsdDelta: <cost>, blastRadiusFiles: <files>, maxPermission: <perm>,
          replanDepth: <depth> }
    And the run's ambient permission level is "<ambient>"
    And the run's elapsed budget fraction is <elapsed>
    When the patch policy engine evaluates the default rule table
    Then the decision is "<decision>"
    And the ledger records "plan.patched" with ruleId "<rule>"

    Examples:
      | name                     | cost | files | perm     | depth | ambient | elapsed | decision | rule                  |
      | recon adds analysis      | 0.40 | 0     | read     | 1     | read    | 0.12    | auto     | read-only-analysis    |
      | review adds a codemod    | 6.20 | 140   | worktree | 2     | read    | 0.30    | approve  | escalates-permission  |
      | fourth replan of a hunt  | 1.10 | 4     | worktree | 4     | worktree| 0.55    | reject   | replan-depth-exceeded |
```

**Notes:** these are the three worked examples from the planning document, transcribed rather than
invented, so a change to the default rule table shows up here as a failing example row rather than as
a subtly different production behaviour nobody notices.

---

## EPIC-14-S17 — `elapsedBudgetFraction >= 1.0` rejects the patch and names the rule

**Verifies:** KAR-14.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: A run that has spent its budget does not get to spend more by replanning

  Scenario: a patch proposed after the ceiling was reached
    Given a run whose rollup is 25.40 against a costUsd ceiling of 25.00
    And a node proposes a PlanPatch inserting two more agent nodes
    When the patch policy engine evaluates it
    Then elapsedBudgetFraction is computed as the greater of the cost and wallclock fractions
    And the "budget-exhausted" rule fires
    And "plan.patched" is appended with decision "rejected" and ruleId "budget-exhausted"
    And the rejected patch is still visible in "GET /api/approvals" so the operator can
        approve it explicitly
    And the run remains paused rather than aborted
```

**Notes:** a rejection is _"a 'not without you', not a dead end"_ — the rejected patch stays
addressable and approvable. Recording rejections is also an NF10 obligation: "the run wanted to do X
and was not allowed to" is exactly the state a user asks about later.

---

## EPIC-14-S18 — An unpriceable node estimates `null`, and `null` never reads as cheap

**Verifies:** KAR-14.3 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Unknown cost is not zero cost

  Scenario: a patch onto a provider DeFlow cannot price
    Given a PlanPatch inserting an agent node routed to a provider with no price-table entry
    And the provider's capability manifest carries tokenAccounting "none"
    When the estimator runs
    Then estimate.costUsdDelta is null
    And it is not 0
    When the patch policy engine evaluates the default rule table
    Then the "read-only-analysis" rule does not match, because its costDeltaUsd predicate
        is false for null
    And the "expensive" rule does not match either
    And the patch falls through to the "default" arm with decision "approve"
    And it lands in the approval queue rather than auto-applying
```

**Notes:** the whole failure chain is one coercion. `null → 0` makes `costDeltaUsd <= 5.00` true,
which matches `read-only-analysis`, which is `auto` — so the single most expensive class of patch
auto-applies on exactly the providers DeFlow cannot meter. The rule table's default arm being
`approve` rather than `auto` is the second half of the defence and both halves must hold.

---

## EPIC-14-S19 — Seed factor below five samples, learned factor from five

**Verifies:** KAR-14.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: The estimate says how confident it is

  Scenario Outline: calibration sample count <n>
    Given the calibration for ("<provider>", "<model>") has n <n> and ratio <ratio>
    When the estimator prices a node for that pair
    Then the applied factor is <applied>
    And the estimate is marked seedBased <seedBased>

    Examples:
      | provider  | model | n  | ratio | applied | seedBased |
      | anthropic | m     | 0  | 1.00  | 1.2     | true      |
      | anthropic | m     | 3  | 1.14  | 1.2     | true      |
      | anthropic | m     | 5  | 1.16  | 1.16    | false     |
      | openai    | m     | 2  | 1.03  | 1.0     | true      |
      | other     | m     | 1  | 1.09  | 1.05    | true      |
```

**Notes:** the seeds exist because tiktoken-family tokenizers undercount Claude tokens by roughly
15–20% on prose and more on code, and an undercount systematically _overfills_ — the dangerous
direction. Marking an estimate as seed-based is what lets the UI say "early estimate" for the first
handful of nodes of a fresh (provider, model) pair instead of quietly being wrong.

---

## EPIC-14-S20 — Estimate versus actual is reconciled and the accuracy is visible

**Verifies:** KAR-14.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: The estimator teaches itself

  Scenario: twenty nodes on a fresh provider/model pair
    Given a fresh calibration for ("claude", "<model>") with n 0
    And a scripted run of twenty agent nodes whose true actual/estimated ratio is 1.18
    When each node completes and its Tier-1 actual is recorded
    Then each node appends the estimate/actual delta alongside its "budget.consumed" event
    And the stored tokenEstimateFactor moves monotonically from the 1.2 seed toward 1.18
    And by the twentieth sample it is within 0.02 of 1.18
    And "deflow doctor" reports the factor and sample count for that pair
    And the run summary exposes a per-run estimate-accuracy figure
```

**Notes:** the EWMA itself belongs to EPIC-09 KAR-09.7; what this scenario verifies is that this epic
actually _feeds_ it — the reconciliation step is easy to leave out, and without it the factor never
moves and every estimate stays seed-based forever.

---

## EPIC-14-S21 — Happy path: `resetsAt` becomes a `node_wake` row and the run sleeps for free

**Verifies:** KAR-14.4 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Rate-limit awareness for a days-long orchestrator

  Scenario: Claude Code reports a limit that resets in four hours
    Given node "n_impl_1" is running on provider "claude"
    And the fake exec-shim agent emits the committed fixture
        {"type":"rate_limit_event","rate_limit_info":{"resetsAt": <now + 4h>}}
    When the frame is parsed
    Then the ledger contains "provider.rate_limited" with provider "claude",
        resetsAt <now + 4h>, and raw carrying the vendor payload verbatim
    And a node_wake row exists for ("r1", "n_impl_1") with wake_at <now + 4h>
        and reason "quota"
    And "node.suspended" is appended with until <now + 4h>
    And the node_wake row and the failure event were written in the same transaction
    And no timer handle and no child process exist for that node
    And the failure class recorded is "transient"
    When the TestClock is advanced by four hours
    Then the 1 Hz ticker admits the node again and it reaches "node.completed"
    And the run was never paused and never failed
```

**Notes:** _"a suspended node costs exactly one row and zero CPU."_ The same-transaction requirement
is the one that bites: split the wake row from the failure event and a restart inside the window
either loses the delay (retry storm) or double-counts the attempt.

---

## EPIC-14-S22 — The `2**31` timer footgun: a long wake must be a row, never a timer

**Verifies:** KAR-14.4 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Node timers cannot express a long wait and fail silently when asked to

  Scenario: the demonstration that keeps the lesson alive
    Given a callback scheduled with setTimeout(2 ** 31, cb)
    When the process runs for 50 milliseconds
    Then cb has already fired
    And a TimeoutOverflowWarning was written to stderr
    And nothing else indicated a durability failure

  Scenario: the node_wake path with the same delay
    Given a rate limit whose resetsAt is 30 days in the future
    When the suspension is recorded
    Then a node_wake row exists with wake_at at that exact timestamp
    And advancing the TestClock by 29 days does not admit the node
    And advancing it by 30 days does
    And a lint rule fails the build on setTimeout used as a wait anywhere in engine code
```

**Notes:** **verified 2026-08-02** — Node's maximum timer delay is `2^31 - 1` ms (24.9 days), and
passing `2**31` neither throws nor clamps: it fires after **1 ms** with only a warning on stderr. A
30-day human gate or a monthly quota reset implemented with `setTimeout` fires instantly and nothing
in the logs says so. Timers also do not fire during laptop sleep and do not survive a restart, so
even a four-hour wait is wrong as a timer — this scenario just makes the failure spectacular enough
to remember.

---

## EPIC-14-S23 — The suspension survives `kill -9` and a laptop sleep

**Verifies:** KAR-14.4 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Durable wake times

  Scenario: crash and sleep across a quota suspension
    Given node "n_impl_1" suspended with a node_wake row at <now + 4h>, reason "quota"
    When DeFlowd is killed with SIGKILL
    And the machine's wall clock is advanced by two hours while DeFlowd is down
    And DeFlowd is restarted over the same .DeFlow/ directory
    Then the node_wake row is still present and unchanged
    And the ticker does not admit the node on the first tick
    When the TestClock is advanced to the recorded wake_at
    Then the node is admitted and reaches "node.completed"
    And the attempt counter was not incremented by the restart
```

**Notes:** the same `node_wake` mechanism serves a six-hour human gate, laptop sleep, crash-restart
mid-wait and retry backoff. One code path exercised constantly beats four exercised rarely — which is
also why this scenario is worth automating even though it looks like a duplicate of the human-gate
scenarios in EPIC-13.

---

## EPIC-14-S24 — Re-route only onto a capability superset, and only through the policy engine

**Verifies:** KAR-14.4 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Provider re-routing is a visible plan patch, never a silent swap

  Scenario Outline: node requiring <requires>, rerouted from "claude" to "<target>"
    Given provider "claude" is rate-limited with no resetsAt
    And node "n_impl_1" requires <requires> at permission level "worktree"
    And the probed capability matrix of 2026-08-02 is loaded as a fixture
    When the scheduler considers a reroute onto "<target>"
    Then capabilitySuperset is <superset>
    And the proposed patch is { op: "reroute", node: "n_impl_1",
        provider: "<target>", cause: "quota" }
    And the policy decision is "<decision>"
    And a "plan.patched" event records the decision with its reason rendered verbatim

    Examples:
      | requires        | target      | superset | decision |
      | session.resume  | codex-acp   | true     | auto     |
      | session.resume  | copilot     | false    | approve  |
      | session.resume  | gemini      | false    | approve  |
      | fork            | codex-acp   | false    | approve  |
      | fork            | opencode    | true     | auto     |

  Scenario: a reroute that changes the permission level is never auto
    Given a reroute whose target adapter reports mediatedExecution false
    When the policy engine evaluates it
    Then "quota-reroute-equivalent" does not match, because permissionUnchanged is false
    And the decision is "approve"
```

**Notes:** the matrix rows are the measured 2026-08-02 probe — copilot 1.0.77 and gemini 0.53.1
cannot resume at all, and codex-acp 1.1.9 has no `fork`. That fixture is _a test fixture, never a
constant_: it is regenerated by `deflow doctor` and a diff against it is expected to fail the
conformance suite rather than to be edited into agreement.

---

## EPIC-14-S25 — No capable provider: suspend, do not reroute, do not kill the run

**Verifies:** KAR-14.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: One provider unavailable degrades the plan; it does not kill the run

  Scenario: the only capable provider is rate-limited
    Given node "n_impl_1" requires session.resume and only "claude" provides it
    And "claude" reports a rate limit with resetsAt <now + 6h>
    When the scheduler handles the failure
    Then no reroute patch is proposed
    And a node_wake row is written with wake_at <now + 6h> and reason "quota"
    And "node.suspended" is appended
    And the run is not paused, not failed and not aborted
    And an independent branch "n_docs" continues and reaches "node.completed"
    And "deflow doctor" reports "claude" as rate-limited until <now + 6h>
```

---

## EPIC-14-S26 — Correlated limits: three nodes, three distinct jittered wakes, one transaction each

**Verifies:** KAR-14.4 · **Type:** Concurrency · **Automated at:** integration

```gherkin
Feature: Full jitter, because the failure mode is correlated

  Scenario: three nodes trip the same vendor limit in the same tick
    Given three agent nodes running concurrently on provider "claude"
    And none of the rate-limit signals carries a resetsAt
    When all three fail with a rate limit within one scheduler tick
    Then each node's delay is drawn as
        Math.random() * Math.min(300000, 2000 * 2 ** (attempt - 1))
    And the three wake_at values are distinct
    And each node_wake row was written in the same transaction as its "node.failed" event
    And each ledger entry pairs "node.failed" with "node.retry.scheduled"
    When DeFlowd is killed with SIGKILL inside the backoff window and restarted
    Then each node still has its original wake_at
    And no attempt counter was incremented by the restart

  Scenario: the jitter distribution over a seeded RNG
    Given a seeded RNG and 1000 draws at attempt 4
    Then every delay lies in [0, min(300000, 16000)]
    And the draws are not all equal
```

**Notes:** full jitter rather than equal jitter or none, _"because the common failure here is
correlated: several nodes hit the same vendor rate limit at the same moment, and you do not want them
retrying in lockstep and re-tripping it."_ Asserting distinctness over a seeded RNG rather than a
single run is what makes this test non-flaky.

---

## EPIC-14-S27 — An adapter with no rate-limit signal degrades to blind backoff, honestly labelled

**Verifies:** KAR-14.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Honest degradation when the vendor says nothing machine-readable

  Scenario: a provider that signals a limit only through an exit code
    Given provider "opencode" whose adapter reports no structured rate-limit frame
    And the fake exec-shim agent exits with a known rate-limit exit code and no usage output
    When the failure is classified
    Then the class is "transient"
    And "provider.rate_limited" is appended with resetsAt absent and raw carrying the exit code
    And the retry uses the full-jitter backoff rather than a scheduled reset
    And the projected provider status shows "rate limited, reset time unknown"
        rather than a fabricated reset time
    And "deflow doctor" reports the same wording for that provider
```

**Notes:** the temptation is to invent a plausible reset time so the UI has something to render. A
fabricated reset is worse than an honest gap for exactly the reason a fabricated compaction "after"
number is: the operator schedules their afternoon around it. Whether the ACP path surfaces rate-limit
state at all is **Unverified** and is one of the two questions the M0 ACP spike is told to answer
explicitly; this scenario is the degradation path if the answer is no.

---

## EPIC-14-S28 — The ACP path normalises to the same `provider.rate_limited` (added)

**Verifies:** KAR-14.4 · **Type:** Edge case · **Automated at:** integration (unit for the
classifier table)

Added because every scenario above exercises the **exec-shim** path, and AC1 is a claim about
_both_: "a `rate_limit_event` frame on the shim path, **and the equivalent rate-limit signal on the
ACP path**, both normalise to `provider.rate_limited`". Without this scenario the ACP half of that
sentence had no test behind it, which is how it came to have no code behind it either.

```gherkin
Feature: One normalised rate limit, whichever transport carried it

  Scenario: an ACP agent refuses the prompt with a declared rate-limit error code
    Given node "n_impl_1" runs on an ACP adapter whose rate-limit JSON-RPC code was declared
    And the agent answers "session/prompt" with that code and data { resetsAt: <now + 4h> }
    When the turn fails
    Then the ledger contains "provider.rate_limited" with that provider, resetsAt <now + 4h>,
        and raw carrying { code, message, data } verbatim
    And it is appended before "node.failed", so the cause precedes the effect
    And the failure class recorded is "transient" and rateLimitOf reads the limit back
    And a node_wake row is written for ("r1", "n_impl_1") with wake_at <now + 4h>
        and reason "quota"
    And the payload shape is identical to the one the shim path writes

  Scenario: the same code with no reset instant
    Given the agent's error data names no resetsAt
    Then "provider.rate_limited" is appended with resetsAt absent and raw kept verbatim
    And no node_wake row is written, so the retry ladder's full jitter schedules the attempt
    And every surface renders "rate limited, reset time unknown"

  Scenario Outline: what is not a rate limit stays what it was
    Given the caller declared <declared>
    When the agent answers "session/prompt" with JSON-RPC <code>
    Then no "provider.rate_limited" event is appended
    And the failure is classified from the error itself, not from a quota DeFlow inferred

    Examples:
      | declared | code   |
      | -32042   | -32043 |
      | (none)   | -32042 |

  Scenario: a code ACP has already assigned cannot be declared
    Given the caller declares -32000, which ACP assigns to authRequired
    When the node is started
    Then the node is refused before a process exists
    And the failure class is "permanent"
    And no agent was spawned
```

**Notes:** the signal is a **caller-declared** JSON-RPC error code, not a vendor table. ACP assigns
no rate-limit code — verified against `@agentclientprotocol/sdk` 1.3.0, whose whole assigned set is
parse / invalid-request / method-not-found / invalid-params / internal / request-cancelled /
auth-required / resource-not-found — and whether any adapter surfaces quota state at all remains
**Unverified** (roadmap §1's M0 ACP spike). So DeFlow ships no codes and infers none, exactly as it
ships no `rateLimitExitCodes`: an undeclared error degrades to S27's honest blind backoff rather than
to a quota nobody stated. The last scenario is the one that earns its keep — declaring `authRequired`
as a quota would classify a permanent refusal as a transient retry and spend the node's whole attempt
budget on it, which is precisely the conflation AC9 forbids.

---

**Related:** [Epic](../epics/EPIC-14-cost-governance.md) · [Board](../board.md) ·
[08-context-and-memory.md](../../08-context-and-memory.md) ·
[05-durable-execution.md](../../05-durable-execution.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
