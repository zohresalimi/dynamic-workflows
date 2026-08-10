# EPIC-12 flows — Verification gates and the repair loop

> Behavioural specification for [EPIC-12](../epics/EPIC-12-verification-gates.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor                   | Description                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Operator**            | The engineer driving DeFlow. Approves the `TaskSpec`, reads verdicts, answers a `needs-human` gate                             |
| **DeFlowd**             | The local daemon: scheduler, ledger, gate runner                                                                               |
| **Gate Runner**         | `packages/gates` — loads definitions, orders the ladder, spawns deterministic gates, constructs `Verdict`s                     |
| **Producer node**       | The `agent` node whose work is under test. Owns a worktree and the branch `DeFlow/<runId>__<nodeId>`                           |
| **Reviewer node**       | The `gate` node of kind `adversarial`. A different session, and where possible a different provider                            |
| **Provider agent**      | A `DeFlow-mock-agent` subprocess on a temp `PATH`, or the `packages/testkit` fake exec-shim agent for the CLI path             |
| **Plan validator**      | `validate(plan, spec)` from [EPIC-11](../epics/EPIC-11-dynamic-planning.md) — this epic contributes the criteria-coverage rule |
| **Patch policy engine** | Decides `auto` / `approve` / `reject` on the repair loop's `PlanPatch`es                                                       |
| **Blob store**          | `runs/<runId>/artifacts/<sha>/`, content-addressed                                                                             |

## Preconditions common to all flows

```gherkin
Background:
  Given a DeFlow workspace initialised in a real git repository on branch "main"
  And the repository was created by "git init -b main" with
      GIT_CONFIG_GLOBAL=/dev/null, GIT_CONFIG_SYSTEM=/dev/null and forced identity env
  And the ledger is a file-backed SQLite database opened with
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000"
  And "DeFlow-mock-agent" is symlinked onto a temp PATH under the vendor binary names the run uses
  And time enters the engine through an injected Clock port, never Date.now()
  And no test in this file calls vi.useFakeTimers() while a child process is alive
  And the normalising snapshot serializer is registered before the first snapshot is written
  And a TaskSpec has been approved, producing "run.spec.approved" and a pinned specHash
  And ".DeFlow/schemas/verdict.schema.json" has been emitted by z.toJSONSchema()
```

> Two of these are load-bearing rather than hygiene. **File-backed SQLite** is mandatory for every
> milestone-advance and repair-loop scenario below: `:memory:` cannot be reopened after a simulated
> crash and hides the ordering bugs the milestone rule is entirely about
> ([testing strategy §7](../../14-testing-strategy.md)). And **the mock agent's `--capabilities`
> flag** is what turns "only one provider can review" from an uninstall into a 40 ms unit test.

## Flow index

| Scenario    | Title                                                                                     | Verifies | Type        |
| ----------- | ----------------------------------------------------------------------------------------- | -------- | ----------- |
| EPIC-12-S1  | Happy path: the deterministic tier passes and the milestone advances                      | KAR-12.1 | Happy path  |
| EPIC-12-S2  | Short-circuit: a red typecheck never buys a review                                        | KAR-12.1 | Happy path  |
| EPIC-12-S3  | The ladder order across all four gate classes                                             | KAR-12.1 | Happy path  |
| EPIC-12-S4  | The stale green: a `pass` recorded before the last write advances nothing                 | KAR-12.1 | Edge case   |
| EPIC-12-S5  | There is no override flag anywhere in the data model                                      | KAR-12.1 | Edge case   |
| EPIC-12-S6  | A gate whose own tooling failed returns `needs-human`, not `fail`                         | KAR-12.1 | Failure     |
| EPIC-12-S7  | The seven findings parsers against real tool output                                       | KAR-12.1 | Edge case   |
| EPIC-12-S8  | `severityFloor` decides what fails, not what is recorded                                  | KAR-12.1 | Edge case   |
| EPIC-12-S9  | Evidence over 256 KiB spills to a handle and dedupes across attempts                      | KAR-12.1 | Edge case   |
| EPIC-12-S10 | A gate is not a licence: the deny list applies to gate commands                           | KAR-12.1 | Failure     |
| EPIC-12-S11 | Happy path: the review runs on a different session and a different provider               | KAR-12.2 | Happy path  |
| EPIC-12-S12 | Same session id: `REVIEW_SESSION_NOT_INDEPENDENT` before a prompt is sent                 | KAR-12.2 | Failure     |
| EPIC-12-S13 | Fork and resume-of-producer both refused, including when there is no alternative          | KAR-12.2 | Failure     |
| EPIC-12-S14 | Single installed provider: the stated fallback, and its visible marker                    | KAR-12.2 | Edge case   |
| EPIC-12-S15 | No capable reviewer: `needs-human`, never a fabricated pass                               | KAR-12.2 | Failure     |
| EPIC-12-S16 | The reviewer's packet contains the spec, the diff and the gate output — and no transcript | KAR-12.2 | Edge case   |
| EPIC-12-S17 | Session ids are knowable on both adapter paths                                            | KAR-12.2 | Edge case   |
| EPIC-12-S18 | The verdict schema is enforced at the adapter boundary, not by prompt                     | KAR-12.3 | Happy path  |
| EPIC-12-S19 | A schema-invalid verdict fails the node with every Ajv error                              | KAR-12.3 | Failure     |
| EPIC-12-S20 | `error_max_structured_output_retries` is not retried over the top                         | KAR-12.3 | Failure     |
| EPIC-12-S21 | An oversize verdict gets one compression re-prompt and is never truncated                 | KAR-12.3 | Failure     |
| EPIC-12-S22 | Stable `Finding.id` across four attempts                                                  | KAR-12.3 | Edge case   |
| EPIC-12-S23 | `blobSha`: findings from attempt 2 do not attach to attempt 3's lines                     | KAR-12.3 | Edge case   |
| EPIC-12-S24 | An uncovered acceptance criterion refuses to start the run                                | KAR-12.4 | Failure     |
| EPIC-12-S25 | `unverifiable` is a first-class outcome, and it costs one sentence                        | KAR-12.4 | Edge case   |
| EPIC-12-S26 | A criterion the reviewer omitted is unverifiable, never satisfied                         | KAR-12.4 | Edge case   |
| EPIC-12-S27 | A spec edited mid-run voids the verdict and re-runs the gate                              | KAR-12.4 | Recovery    |
| EPIC-12-S28 | A patch that abandons the last covering gate is rejected                                  | KAR-12.4 | Failure     |
| EPIC-12-S29 | Repair happy path: one finding, regression test first, re-run from the top                | KAR-12.5 | Happy path  |
| EPIC-12-S30 | One fix node per finding, and the cases that produce none                                 | KAR-12.5 | Edge case   |
| EPIC-12-S31 | Attempt 2 receives the previous verdicts and not the previous transcript                  | KAR-12.5 | Edge case   |
| EPIC-12-S32 | Three attempts, then escalation with all three diffs and all three verdicts               | KAR-12.5 | Failure     |
| EPIC-12-S33 | A repair that needs more permission is queued, not auto-applied                           | KAR-12.5 | Edge case   |
| EPIC-12-S34 | A repair loop that became a churn loop stops rather than accelerates                      | KAR-12.5 | Concurrency |
| EPIC-12-S35 | The agent fixes the check instead of the code, and fails on path scope                    | KAR-12.5 | Failure     |
| EPIC-12-S36 | Gate discovery hashes file **bytes** into the run manifest                                | KAR-12.6 | Happy path  |
| EPIC-12-S37 | A gate file edited mid-run diverges from the manifest                                     | KAR-12.6 | Failure     |
| EPIC-12-S38 | `doctor` reports gates nobody schedules, and both tails of the first-pass rate            | KAR-12.6 | Edge case   |
| EPIC-12-S39 | A custom producer parsed with `jsonl` and `$.violations`                                  | KAR-12.6 | Happy path  |

---

## EPIC-12-S1 — Happy path: the deterministic tier passes and the milestone advances

**Verifies:** KAR-12.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Deterministic gates advance a milestone

  Scenario: typecheck, lint and unit all pass, in that order
    Given ".DeFlow/gates/typecheck.yaml" declaring
          run "pnpm exec tsc -p tsconfig.json --noEmit", cwd "worktree",
          effect "pure", permission "worktree", expect.exitCode 0,
          findings.parser "tsc", satisfies [AC-3, AC-7]
    And a milestone "m1" whose requires list is ["typecheck", "lint", "unit"]
    And the producer node has committed work to "DeFlow/r1__impl-1"
    When the gate set for "m1" is evaluated
    Then the ledger contains three "gate.evaluated" events with outcome "pass"
    And each Verdict carries the run's current specHash
    And each Verdict.criteria lists every criterion in the gate's satisfies list with a status
    And each Verdict.cost.durationMs is present and greater than zero
    And the milestone projection for "m1" reports advanced true

  Scenario: The verdict is the same shape whichever tier produced it
    When a deterministic verdict and an adversarial verdict are both read from the ledger
    Then both validate against ".DeFlow/schemas/verdict.schema.json"
    And both carry gate, node, outcome, specHash, criteria, findings and cost
```

**Notes:** the acceptance criteria board (F10.8) and the diff surface (F7.7) both read this one
shape. If deterministic and adversarial verdicts diverge in shape, EPIC-17 grows two renderers and
they drift.

---

## EPIC-12-S2 — Short-circuit: a red typecheck never buys a review

**Verifies:** KAR-12.1 · **Type:** Happy path · **Automated at:** integration + e2e

```gherkin
Feature: The ladder short-circuits on the first fail

  Scenario: The adversarial gate is never scheduled
    Given a milestone requiring "typecheck" then a structural conflict probe then an "adversarial" review
    And the worktree contains a real TypeScript error
    When the gate set is evaluated
    Then "gate.evaluated" for "typecheck" carries outcome "fail"
    And the ledger contains no "node.scheduled" event for the review gate
    And the ledger contains no "node.started" event for the review gate
    And the run's total costUsd is byte-identical before and after the evaluation
    And the transport recording contains zero "session/new" frames for the review gate
```

**Notes:** the assertion that matters is the cost delta, not the absence of a log line. The reason
the ladder short-circuits is economic _and_ qualitative — a reviewer looking at broken code spends
its attention on the breakage and misses the design problem you needed it to find
([§1](../../10-verification-gates.md)).

---

## EPIC-12-S3 — The ladder order across all four gate classes

**Verifies:** KAR-12.1 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: deterministic → structural → adversarial → human

  Scenario Outline: The first failing tier stops the rest
    Given a milestone requiring one gate of each class
    And the "<failing>" tier returns outcome "fail"
    When decide() is called over the reduced state
    Then the tiers that ran are "<ran>"
    And the tiers that were never scheduled are "<skipped>"

    Examples:
      | failing       | ran                                          | skipped                          |
      | deterministic | deterministic                                | structural, adversarial, human   |
      | structural    | deterministic, structural                    | adversarial, human               |
      | adversarial   | deterministic, structural, adversarial       | human                            |
      | none          | deterministic, structural, adversarial, human| —                                |

  Scenario: Ordering is derived, not incidental
    Given the three gate nodes are inserted into the plan in the order adversarial, deterministic, structural
    When decide() derives the ready set
    Then the first admitted gate is the deterministic one
```

**Notes:** written at unit level over a hand-built `RunState` with no I/O, which is the whole point
of `decide()` being pure ([05 §4](../../05-durable-execution.md)). The insertion-order scenario is
the regression test that stops someone "simplifying" the ordering into a sort by array position.

---

## EPIC-12-S4 — The stale green: a `pass` recorded before the last write advances nothing

**Verifies:** KAR-12.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: The milestone rule has two halves

  Scenario: A repair loop touches files after the gate ran
    Given milestone "m1" requires gate "unit" over scope "packages/ui/**"
    And "gate.evaluated" for "unit" recorded outcome "pass" at seq 4120
    When a fix node commits to "packages/ui/src/DatePicker.vue" at seq 4180
    Then the milestone projection for "m1" reports advanced false
    And the reason is "stale-green"
    And decide() re-schedules the "unit" gate rather than advancing

  Scenario: The re-run pass advances it
    Given the "unit" gate re-runs and records outcome "pass" at seq 4230
    Then the milestone projection reports advanced true
    And the advancing verdict's seq is greater than the last write event's seq

  Scenario: Writes outside the milestone's scope do not invalidate it
    Given a commit at seq 4180 touching only "docs/adr/0004.md"
    And the milestone scope is "packages/ui/**"
    Then the milestone stays advanced and no gate is re-scheduled
```

**Notes:** this is the exact shape a run drifts into when a repair loop touches files after a gate
ran, which is why it is called out separately in [§1](../../10-verification-gates.md). Because the
rule compares `seq` values and not timestamps, it is immune to the non-monotonic wall clock
([05 §9.6](../../05-durable-execution.md)) — write the assertion against `seq`, never against `ts`.

---

## EPIC-12-S5 — There is no override flag anywhere in the data model

**Verifies:** KAR-12.1 · **Type:** Edge case · **Automated at:** unit + integration

```gherkin
Feature: Overriding is possible, and never invisible

  Scenario: The reducer advances on pass verdicts and on nothing else
    Given a milestone with one gate whose latest verdict is "fail"
    When every field of the run state is mutated in turn by a property test
    Then no field value causes the milestone projection to report advanced true

  Scenario: A source-level assertion
    When "packages/gates" is grepped for /override|forceAdvance|skipGate|ignoreGate/i
    Then there are zero hits outside test fixtures

  Scenario: The only path past a red gate is attributed and timestamped
    Given a gate whose verdict is "fail"
    When the operator chooses to proceed
    Then a "human" node was scheduled with the verdict rendered in its prompt
    And the ledger contains "human.responded" with optionId, an at timestamp and the responder
    And the milestone advances only after that event
```

**Notes:** [§9.1](../../10-verification-gates.md) ranks this second of five, behind the protected
path set. Overriding _must_ be possible or the tool is unusable; the design decision is that it can
only happen through an event with an identity attached.

**The third scenario is automated as far as EPIC-12 owns it, and the remainder is EPIC-13's.** The
first two lines are covered here: the escalation after three failed repair attempts schedules a
`human` node whose prompt carries every attempt's verdict (`packages/gates/src/repair.ts`,
asserted by `repair.test.ts` and EPIC-12-S32), and the negative half — that no field, flag or
config key advances a milestone past a non-`pass` verdict — is
`packages/gates/test/no-escape-hatch.test.ts` plus the `S5` suite in
`test/integration/milestone-rule.test.ts`. The last two lines were not, and could not be until
**EPIC-13** landed: `HumanRespondedSchema` carried `node`, `optionId`, `text` and `at` but **no
`responder`**, and there was no `POST /api/runs/:id/nodes/:node/respond` to produce the event.

**Closed by EPIC-13.** `HumanRespondedSchema` v2 adds `by`, and `respondToHumanNode` produces the
event, so the remaining two lines are now automated against the same wording in
`packages/daemon/test/integration/red-gate-override.test.ts` — a red `unit` verdict, the `human`
node it forces, and the response carrying `optionId`, an ISO `at` and `by: 'operator'`. The
ordering line is asserted from both ends: the milestone is unadvanced before the response, **still
unadvanced after it** — which is what stops `human.responded` from quietly becoming the override
flag [§9.1](../../10-verification-gates.md) says does not exist — and the `pass` that finally
advances it sits at a `seq` strictly greater than the decision's. Dropping `by` from the payload,
or letting a non-`pass` verdict advance a milestone, each fails it.

---

## EPIC-12-S6 — A gate whose own tooling failed returns `needs-human`, not `fail`

**Verifies:** KAR-12.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Tooling failure is not the work being wrong

  Scenario Outline: Three ways a gate cannot answer
    Given a gate definition whose run line is "<command>" with timeout <timeout>
    When the gate is evaluated
    Then the Verdict outcome is "needs-human"
    And the verdict's findings are empty
    And the reason recorded is "<reason>"
    And no fix node is created

    Examples:
      | command                          | timeout | reason              |
      | pnpm exec tsc-that-does-not-exist| 300s    | gate-tool-missing   |
      | node -e "setInterval(()=>{},1e3)"| 5s      | gate-timeout        |
      | node -e "process.exit(7)"        | 300s    | gate-no-output      |

  Scenario: The timeout kills the process group, not just the child
    Given a gate command "bash -c 'sleep 300 & sleep 300 & sleep 300; wait'" with timeout 5s
    When the timeout elapses
    Then the group was signalled with process.kill(-pid, 'SIGTERM') then SIGKILL after the grace period
    And the kill verification excludes Z-state processes
    And no process in that group remains in a state other than Z
```

**Notes:** `needs-human` is a first-class outcome, not a failure mode
([04 §7](../../04-domain-model.md)). Conflating it with `fail` sends work into the repair loop that
no amount of repair will fix — the fix node would be asked to repair a missing binary. The Z-state
exclusion is the verified false negative from
[testing strategy §10](../../14-testing-strategy.md): after a _successful_ group SIGKILL, `ps` still
lists the grandchildren as zombies with `ppid=1`.

---

## EPIC-12-S7 — The seven findings parsers against real tool output

**Verifies:** KAR-12.1 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: findings.parser turns tool output into typed Findings

  Scenario Outline: Each parser against a captured fixture
    Given a captured stdout fixture from "<tool>"
    When it is parsed with findings.parser "<parser>"
    Then every Finding has a repo-relative POSIX file path
    And every Finding has a 1-based range.startLine
    And every Finding has a non-empty rule matching "<ruleExample>"
    And every Finding has a stable id of exactly 12 hex characters

    Examples:
      | tool                        | parser        | ruleExample           |
      | tsc --noEmit                | tsc           | ts2345                |
      | oxlint --format=json        | eslint-json   | no-floating-promises  |
      | biome check --reporter=json | biome-json    | lint/suspicious/noAny |
      | vitest --reporter=json      | vitest-json   | test/failed           |
      | a JUnit XML report          | junit-xml     | test/failed           |
      | a custom --json producer    | jsonl         | budget/bundle-size    |
      | a plain exit-code-only gate | none          | —                     |

  Scenario: parser "none" still produces a verdict
    Given a gate with findings.parser "none" that exits 1 against expect.exitCode 0
    Then the Verdict outcome is "fail" with an empty findings array
    And the full stdout is attached as an artifact Handle

  Scenario: A Windows-shaped path in tool output is normalised
    Given a captured fixture containing "packages\\ui\\src\\App.vue"
    Then the Finding's file is "packages/ui/src/App.vue"
```

**Notes:** the fixtures are captured from the real tools at pinned versions and committed, not
invented. A parser written against an imagined shape passes its own test and fails on the first real
run — which is the whole reason [§4](../../10-verification-gates.md) insists the verdict shape is
enforced at the boundary rather than by prompt.

---

## EPIC-12-S8 — `severityFloor` decides what fails, not what is recorded

**Verifies:** KAR-12.1 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Findings below the floor are recorded but do not fail the gate

  Scenario Outline: The floor matrix
    Given a gate with severityFloor "<floor>"
    And the parser produced findings with severities <severities>
    Then the Verdict outcome is "<outcome>"
    And the Verdict findings array length is <recorded>

    Examples:
      | floor   | severities              | outcome | recorded |
      | error   | error, warning, info    | fail    | 3        |
      | error   | warning, info           | pass    | 2        |
      | warning | warning, info           | fail    | 2        |
      | warning | info                    | pass    | 1        |
      | error   | (none)                  | pass    | 0        |

  Scenario: Sub-floor findings still reach the diff view and the blast-radius estimate
    Given a "pass" verdict carrying two warning findings
    Then GET-shaped projection of findings by file returns both
    And both feed the blast-radius input the patch policy engine reads
```

**Notes:** the second scenario is [§6.2](../../10-verification-gates.md)'s rule that violations are
never free even when they do not fail a gate. A warning that is invisible is a warning that will be
re-learned expensively at merge time.

---

## EPIC-12-S9 — Evidence over 256 KiB spills to a handle and dedupes across attempts

**Verifies:** KAR-12.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Large evidence lives behind handles, not in the event

  Scenario: A 5 MB test log
    Given a gate whose command emits a 5 MB failing test log
    When the gate is evaluated
    Then the log is written to "runs/<runId>/artifacts/<sha256>/"
    And the Finding's artifact Handle carries { sha256, bytes, mime, head, tail }
    And head and tail are each about 2 KiB
    And the serialised "gate.evaluated" payload is under 256 KiB

  Scenario: Content addressing dedupes the identical log across three repair attempts
    Given three repair attempts each producing a byte-identical failing test log
    Then exactly one blob directory exists under artifacts/
    And all three Findings reference the same sha256

  Scenario: Replay stays fast because the ledger stayed small
    Given a run with 40 gate evaluations each carrying a spilled artifact
    Then the control-plane event table holds fewer than 256 KiB per gate.evaluated row
    And reducing the run's control-plane events to state completes in under 100 ms
```

**Notes:** un-spilled tool output is what makes replay time explode
([§8](../../10-verification-gates.md)), and replay time is a function of event-log size. The
control-plane / data-plane split ([05 §5.1](../../05-durable-execution.md)) is what keeps the
reducer at 29 ms per 10,000 events; inlining a 5 MB log into `event` undoes it.

---

## EPIC-12-S10 — A gate is not a licence: the deny list applies to gate commands

**Verifies:** KAR-12.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Gate commands run under the same execution boundary as any node

  Scenario Outline: A gate that is really an infrastructure action
    Given a gate definition whose run line is "<command>" at permission "worktree"
    When the gate is evaluated
    Then no child process is spawned
    And the node fails with reason "safety.execution-boundary"
    And the failure names the rule that matched

    Examples:
      | command                                     |
      | psql -h db.prod.internal -c "TRUNCATE runs" |
      | terraform apply -auto-approve               |
      | kubectl delete ns staging                   |
      | git push --force origin main                |

  Scenario: cwd repo requires an explicit opt-in
    Given a gate declaring cwd "repo" and ".DeFlow/config.yaml" without the repo-cwd opt-in
    Then the definition fails to load with "GATE_REPO_CWD_NOT_PERMITTED"
```

**Notes:** _"a gate that wants to run a migration against a database is not a gate; it is an
infrastructure action wearing a gate's clothing"_ ([§2](../../10-verification-gates.md)). The deny
list itself is [EPIC-08](../epics/EPIC-08-safety-model.md)'s; this scenario asserts that the gate
path does not route around it.

---

## EPIC-12-S11 — Happy path: the review runs on a different session and a different provider

**Verifies:** KAR-12.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Independent adversarial review

  Scenario: Two capable providers probed
    Given "provider.probed" rows for two adapters, both with structuredOutput true
    And the producer node ran on provider "claude-agent-acp"
    And the deterministic and structural tiers are green
    When the adversarial gate is admitted
    Then "node.scheduled" for the review carries a provider other than "claude-agent-acp"
    And the review's "node.started" session id differs from the producer's "node.started" session id
    And the Verdict has no "weakened" field
    And the Verdict outcome is one of pass, fail, needs-human

  Scenario: Independence is checkable from the ledger alone
    When the two "node.started" payloads are read from the event table
    Then a test asserting review.resolvedSessionId !== producer.resolvedSessionId needs no other input
```

**Notes:** _"'preferably a different provider' is a routing decision. 'A different session' is a hard
scheduling precondition. Both are checked, not assumed"_
([§3](../../10-verification-gates.md)). The reason the assertion is written against
`node.started` payloads rather than against an in-memory field is NF10: any state in the UI must
trace to specific ledger events, and "this review was independent" is exactly such a state.

---

## EPIC-12-S12 — Same session id: `REVIEW_SESSION_NOT_INDEPENDENT` before a prompt is sent

**Verifies:** KAR-12.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The scheduling precondition

  Scenario: A hand-patched plan reuses the producer's session
    Given a plan patched so the review node resolves to the producer's session id
    When decide() considers the review node
    Then assertIndependentReview throws SchedulingRefused("REVIEW_SESSION_NOT_INDEPENDENT", "<reviewNodeId>")
    And the node is never admitted
    And the recorded transport log contains zero "session/prompt" frames for that node
    And the ledger contains "node.failed" carrying the refusal code

  Scenario: The refusal is not a retry
    Then no "node.retry.scheduled" event is appended for the review node
    And the run transitions to needs_human rather than looping
```

**Notes:** the refusal is a _precondition_, so it is a permanent failure class, not a transient one
— retrying a structurally impossible schedule is how a run burns an afternoon at 1 Hz.

---

## EPIC-12-S13 — Fork and resume-of-producer both refused, including when there is no alternative

**Verifies:** KAR-12.2 · **Type:** Failure · **Automated at:** unit + integration

```gherkin
Feature: A fork inherits the producer's reasoning and voids F7.2

  Scenario Outline: The resume shape decides admission
    Given a review node whose resume field is <resume>
    When assertIndependentReview runs
    Then the outcome is "<outcome>"

    Examples:
      | resume                          | outcome                                  |
      | { kind: 'fork' }                | REVIEW_INHERITS_PRODUCER_CONTEXT         |
      | { of: '<producerNodeId>' }      | REVIEW_INHERITS_PRODUCER_CONTEXT         |
      | { kind: 'native-if-available' } | admitted                                 |
      | 'always-replay'                 | admitted                                 |

  Scenario: Forking is never the single-provider fallback
    Given only "claude-agent-acp" is installed and it advertises session.fork true
    When the reviewer is routed
    Then the reviewer's resume is not a fork
    And the reviewer opened a new session via "session/new"
    And the Verdict carries weakened "same-provider"

  Scenario: Forking stays legitimate for continuation work
    Given a non-gate agent node whose resume is { kind: 'fork' }
    Then it is admitted normally
```

**Notes:** `claude-agent-acp` and `opencode acp` both advertise `session.fork`
(**verified 2026-08-02**), which is exactly why this needs a scheduling precondition rather than a
convention. The third scenario exists so nobody "fixes" the refusal by banning `fork` globally.

---

## EPIC-12-S14 — Single installed provider: the stated fallback, and its visible marker

**Verifies:** KAR-12.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: NF7 degradation without a fabricated verdict

  Scenario: The fallback rule, in order
    Given the candidate set C is computed from probed rows filtered by
          structuredOutput, the node's permission level being in caps.permissionLevels,
          and estimatePacketTokens(node) <= caps.maxContext * 0.6
    And C contains only the producer's provider
    When the reviewer is routed
    Then the reviewer runs on the producer's provider
    And it opened a fresh session via "session/new", never fork and never resume
    And the review's session id differs from the producer's
    And the Verdict carries weakened "same-provider"

  Scenario: The marker survives into the projections the UI reads
    Then the criteria projection carries weakened "same-provider" for every criterion this gate covered
    And the gates projection carries it on the verdict
    And no join against the provider table is required to see it

  Scenario Outline: Candidate filtering excludes for the stated reasons
    Given a second probed provider whose row has <defect>
    Then it is excluded from C and the fallback branch is taken

    Examples:
      | defect                                                    |
      | structuredOutput false                                    |
      | permissionLevels missing "worktree"                       |
      | maxContext below estimatePacketTokens(node) / 0.6         |
      | health "unavailable" after a provider.rate_limited event  |
```

**Notes:** _"Do not silently accept a weakened review — the whole value of F7.2 is that you can trust
a green review, and a review you cannot distinguish from a self-assessment does not carry that
trust"_ ([§3.1](../../10-verification-gates.md)). The second scenario is the one that actually
protects that property: a marker stored but not projected is a marker nobody sees.

---

## EPIC-12-S15 — No capable reviewer: `needs-human`, never a fabricated pass

**Verifies:** KAR-12.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: An empty candidate set is a refusal, not a default

  Scenario: Every probed provider fails a requirement
    Given two probed providers, one with structuredOutput false and one rate limited
    When the adversarial gate is admitted
    Then "gate.evaluated" carries outcome "needs-human"
    And the reason is "no-capable-reviewer"
    And the reason detail names, per provider, which requirement it failed
    And a "human" node is opened carrying that detail
    And no Verdict with outcome "pass" exists for that gate at any seq
```

**Notes:** NF7 says one provider being unavailable degrades the plan; it does not say a degraded plan
may invent a verdict. This is also the branch that the acceptance-criteria board renders as
`unsatisfied`, not as `unverifiable` — the criterion is verifiable, it just was not verified.

---

## EPIC-12-S16 — The reviewer's packet contains the spec, the diff and the gate output — and no transcript

**Verifies:** KAR-12.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: No implicit context inheritance (F6.1) applied to review

  Scenario: The packet manifest
    When the reviewer's "context.built" event is read
    Then the packet manifest contains a pinned segment for the TaskSpec goal and non-goals
    And a pinned segment for the acceptance criteria
    And a segment carrying the unified diff of the producer's branch
    And segments carrying the deterministic and structural gate output
    And no segment whose provenance is the producer node's transcript
    And the pinned segments appear first, verbatim, before any other segment

  Scenario: The pin integrity check protects the criteria specifically
    Given the packet builder is forced to compact under budget pressure
    When a pinned acceptance-criteria segment fails to survive into the outgoing prompt
    Then the ledger contains "pin.integrity_violated" naming the missing digests
    And the node fails rather than proceeding
    And no Verdict is recorded for that attempt

  Scenario: Prohibitions are restated as requirements
    Then the rendered reviewer prompt contains "judge each finding against AC-3 as written above"
    And it does not contain a bare "do not judge against the code" prohibition
```

**Notes:** _"a review gate whose acceptance criteria were compacted away is a review gate that has
silently become a code-reads-well check"_ ([§5.2](../../10-verification-gates.md)). The measured
asymmetry behind the third scenario is that prohibitions decay under context pressure while
requirements persist — see [EPIC-09](../epics/EPIC-09-context-memory.md) KAR-09.4, which owns the
rewriting; this scenario asserts the reviewer actually gets it.

---

## EPIC-12-S17 — Session ids are knowable on both adapter paths

**Verifies:** KAR-12.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: DeFlow asserts on the session id rather than hoping

  Scenario: CLI shim path — DeFlow mints the uuid
    Given the fake exec-shim agent stands in for Claude Code
    When the reviewer is spawned
    Then the argv contains "--session-id <uuid>" with a uuid DeFlow generated
    And the independence check ran before the process was spawned
    And every emitted frame carries that uuid verbatim

  Scenario: A frame carrying a different session id is a failure, not a warning
    Given the fake agent is scripted to emit a different session id
    Then the node fails with a typed error naming both ids
    And the Verdict is discarded

  Scenario: ACP path — the id arrives from session/new
    Given the mock agent speaks ACP
    When "session/new" returns a sessionId
    Then it is journaled to "node.started" as its own event before any prompt is sent
    And the independence check ran after session/new and before session/prompt
    And zero "session/prompt" frames were sent if the check failed
```

**Notes:** journaling the session id _the instant it arrives, never buffered_, is
[05 §8.3](../../05-durable-execution.md)'s rule — a buffered session id is a session id you lose in
exactly the crash where you needed it. Here it does double duty: it is also what makes independence
auditable after the fact.

---

## EPIC-12-S18 — The verdict schema is enforced at the adapter boundary, not by prompt

**Verifies:** KAR-12.3 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Native structured output

  Scenario Outline: The schema is passed by flag, from the file on disk
    Given ".DeFlow/schemas/verdict.schema.json" written by z.toJSONSchema()
    When a gate node runs on adapter "<adapter>"
    Then the argv contains "<flag> <absolutePathToSchema>"
    And the returned object is read from "<field>"
    And it validates under Ajv 8.20.0 with strict true and allErrors true plus ajv-formats

    Examples:
      | adapter     | flag            | field                        |
      | claude-code | --json-schema   | result.structured_output     |
      | codex       | --output-schema | the result envelope's output |

  Scenario: The schema declares the 2020-12 dialect
    Then the emitted file's $schema is "https://json-schema.org/draft/2020-12/schema"
    And Ajv compiles it with zero strict-mode warnings

  Scenario: There is exactly one copy
    Then the path passed to the adapter is the same file the daemon validates against
    And no second in-memory schema object is constructed
```

**Notes:** 2020-12 is not arbitrary — it is the dialect MCP tool `inputSchema` defaults to, so one
dialect covers the MCP host and the handoff contracts alike
([§4](../../10-verification-gates.md)). Passing the on-disk file rather than an in-memory twin is
what makes NF8's "every artifact inspectable on disk" true for the contract itself.

---

## EPIC-12-S19 — A schema-invalid verdict fails the node with every Ajv error

**Verifies:** KAR-12.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Never accept a prose verdict

  Scenario Outline: Six malformed verdicts
    Given the mock agent is scripted to return <payload>
    When the adapter validates it
    Then the node fails with reason "contract.schema-invalid"
    And the failure detail contains every Ajv error, not only the first
    And the raw payload is stored as an artifact Handle for inspection

    Examples:
      | payload                                             |
      | a prose paragraph                                   |
      | { outcome: "ok" }                                   |
      | a verdict with findings as an array of strings      |
      | a Finding with severity "critical"                  |
      | a Finding with a range but no blobSha               |
      | a verdict missing the criteria array                |

  Scenario: No prose fallback parser exists
    When "packages/gates" is grepped for a regex-based verdict extractor
    Then there are zero hits
```

**Notes:** _"Parsing findings out of prose breaks on the next CLI release"_
([§10](../../10-verification-gates.md)). `allErrors: true` matters because a verdict that is wrong in
four places should tell you all four — one round trip per error is how a repair loop becomes four.

---

## EPIC-12-S20 — `error_max_structured_output_retries` is not retried over the top

**Verifies:** KAR-12.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Do not retry over the top of a retry

  Scenario: The vendor's own repair loop exhausted
    Given the fake exec-shim agent emits a result envelope with subtype
          "error_max_structured_output_retries"
    When the adapter processes it
    Then the node fails with reason "agent.schema-repair-exhausted"
    And exactly one "node.started" event exists for that attempt
    And DeFlow performed no additional schema-repair prompt of its own

  Scenario: The node's retry policy still applies at the attempt level
    Given the node's RetryPolicy has maxAttempts 3
    Then a new attempt may be scheduled with a new idempotency key
    But the new attempt is a fresh invocation, not a continuation of the exhausted repair
```

**Notes:** Claude Code runs its own internal schema-repair loop and surfaces exhaustion as this
subtype (**verified 2026-08-02**, decoded from one shipping bundle — A4-1). The distinction in the
second scenario matters: `attempt` is part of the idempotency key, so a retry mints a new key by
construction and is genuinely a different operation from crash-resume
([05 §9.2](../../05-durable-execution.md)).

---

## EPIC-12-S21 — An oversize verdict gets one compression re-prompt and is never truncated

**Verifies:** KAR-12.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Truncated JSON is invalid JSON

  Scenario: One bounded re-prompt, then hard fail
    Given a gate node with returns.maxTokens 600
    And the mock agent is scripted to return a verdict serialising to ~900 tokens
    When the adapter counts the serialised structured_output with the Tier-2 tokenizer
    Then "handoff.oversize" is appended with { budget: 600, actual: ~900, repairAttempted: false }
    And exactly one compression re-prompt is issued
    When the second response is still over budget
    Then the node fails with reason "contract.handoff-oversize"
    And the stored payload is byte-identical to what the agent sent
    And at no point was any payload truncated

  Scenario: A findings-heavy failure fits inside the headroom
    Given a verdict with 12 findings serialising to 540 tokens
    Then it is accepted with no re-prompt
    And no "handoff.oversize" event is appended
```

**Notes:** typical verdicts land around 300 tokens; the 600 budget is headroom for findings-heavy
failures against the 500–2,000 default band in F6.4. The byte-identity assertion is the important
one — F6.9 exists to stop invalid output entering the blackboard, and a truncated JSON payload is
precisely the silent propagation of garbage it forbids.

---

## EPIC-12-S22 — Stable `Finding.id` across four attempts

**Verifies:** KAR-12.3 · **Type:** Edge case · **Automated at:** unit + integration

```gherkin
Feature: The stable id is what everything else hangs off

  Scenario: The same lint error after an unrelated edit keeps its id
    Given attempt 1 produced a Finding with rule "no-floating-promises" in "src/api/client.ts"
    When attempt 2 edits an unrelated function in the same file and the same rule fires
    Then the Finding id is unchanged
    And the diff view deduplicates the two occurrences to one annotation

  Scenario: Normalisation strips the volatile part of the message
    Given two messages differing only by an embedded line number
    Then both hash to the same id

  Scenario: A different rule is a different finding
    Given the same file and message but rule "ts2345"
    Then the id differs

  Scenario: The delta across attempts is computable
    Given attempt 1 findings { a13f…, 55c1… } and attempt 2 findings { 55c1…, 9c02… }
    Then findingDelta reports fixed [a13f…], remaining [55c1…], introduced [9c02…]
    And the churn detector sees the same finding recurring rather than three distinct failures
```

**Notes:** the id is `sha256(gate|file|rule|normalisedMessage).slice(0,12)`. It is how attempt 2 is
known to have fixed `a13f…` and introduced `9c02…`, how the diff view deduplicates across four
attempts, and how the churn detector recognises recurrence
([§4](../../10-verification-gates.md)).

---

## EPIC-12-S23 — `blobSha`: findings from attempt 2 do not attach to attempt 3's lines

**Verifies:** KAR-12.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Line numbers are anchored to a blob, not to "the current file"

  Scenario: A repair attempt shifts every line
    Given attempt 2 produced a Finding at src/App.vue:42 with blobSha "b1…"
    And attempt 3 inserts ten lines at the top of src/App.vue producing blobSha "c7…"
    When the diff view projection renders the attempt-3 revision
    Then the attempt-2 Finding is projected with stale true and fromAttempt 2
    And it is not drawn against line 42 of the new blob

  Scenario: A finding whose blob is unchanged is not stale
    Given a Finding whose blobSha equals the rendered blob's sha
    Then it is projected with stale false and rendered at its recorded range

  Scenario: Every Finding carries a blobSha
    Then a Finding produced by any of the seven parsers has a non-empty blobSha
    And a Finding constructed without one fails schema validation
```

**Notes:** _"Without it, the second repair attempt silently attaches every earlier finding to the
wrong lines, and the reviewer stops trusting the annotations within about ten minutes"_
([§8](../../10-verification-gates.md)). The margin text — _"stale — from attempt 2"_ — is
[EPIC-17](../epics/EPIC-17-p0-views.md)'s; the `stale` and `fromAttempt` fields are this epic's.

---

## EPIC-12-S24 — An uncovered acceptance criterion refuses to start the run

**Verifies:** KAR-12.4 · **Type:** Failure · **Automated at:** integration + e2e

```gherkin
Feature: The criterion → gate mapping is total

  Scenario: One criterion nothing checks
    Given a pinned TaskSpec with criteria AC-1 through AC-9
    And active gate nodes whose criteria lists cover AC-1 through AC-8
    And AC-9 is not marked unverifiable
    When plan validation runs
    Then a diagnostic { severity: "error", code: "CRITERION_UNCOVERED", criterion: "AC-9" } is emitted
    And the run does not start
    And no agent process is spawned
    And POST /api/runs/:id/spec/approve returns the diagnostic rather than a 201

  Scenario: The mapping is total, not merely non-empty
    Given every criterion is covered
    Then coveredByGates is populated for every criterion with plan NodeIds
    And validateCriteriaCoverage returns an empty diagnostic list

  Scenario: A gate file naming a criterion the spec does not have
    Given ".DeFlow/gates/a11y.yaml" declaring satisfies [AC-99]
    Then gate load fails with "GATE_UNKNOWN_CRITERION" naming the file and the id
```

**Notes:** this scenario is the literal answer to _"has the requested outcome been achieved?"_
(F7.4). The reason it is a hard validation failure and not a report is that a warning here
reproduces "gates that exist but are not treated as real gates" one layer up — the board would show
a criterion in a fourth, undocumented state: _not looked at_.

---

## EPIC-12-S25 — `unverifiable` is a first-class outcome, and it costs one sentence

**Verifies:** KAR-12.4 · **Type:** Edge case · **Automated at:** unit + integration

```gherkin
Feature: The escape hatch that keeps false precision visible

  Scenario: A subjective criterion, properly marked
    Given a criterion
          """
          id: AC-9
          text: "The migrated date picker feels as responsive as the old one."
          unverifiable: true
          reason: "Subjective. No harness exists. Route to a human node at the end of the milestone."
          verifiedBy: [human-review-ui]
          """
    When plan validation runs
    Then no diagnostic is emitted for AC-9
    And the criteria projection renders AC-9 in the "unverifiable" state
    And AC-9 is not counted toward the satisfied total

  Scenario: The hatch requires the sentence
    Given a criterion with unverifiable true and an empty reason
    Then validation emits "CRITERION_UNVERIFIABLE_NO_REASON"

  Scenario: An EARS timing claim with no harness cannot name a gate
    Given a criterion "WHEN the user submits an invalid form, THE system SHALL display an error within 200ms"
    And no gate whose run line measures it
    Then it must be marked unverifiable to pass validation
    And once marked it renders in its own column rather than counting as green
```

**Notes:** [§9.2](../../10-verification-gates.md) is explicit that EARS-style criteria _"have the
grammar of a test and none of the machinery"_, and that a gate forced to choose between `satisfied`
and `unsatisfied` for an unmeasurable claim will pick one, and the one it picks tells you nothing.

---

## EPIC-12-S26 — A criterion the reviewer omitted is unverifiable, never satisfied

**Verifies:** KAR-12.4 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Omission is not assent

  Scenario: The reviewer returns two of three criteria
    Given a gate node whose criteria are [AC-3, AC-5, AC-7]
    And the reviewer's Verdict.criteria contains only AC-3 and AC-5
    When the verdict is materialised
    Then AC-7 is recorded with status "unverifiable"
    And AC-7 is never recorded with status "satisfied"
    And the criteria projection shows AC-7 in the unverifiable state, not the satisfied one

  Scenario: The criteria array is required
    Given a gate declaring criteria and a verdict with an empty criteria array
    Then the node fails with "contract.schema-invalid"
```

**Notes:** _"a criterion the reviewer omits is treated as `unverifiable`, not as satisfied"_
([§5.2](../../10-verification-gates.md)). This is the smallest rule in the epic and one of the
easiest to get backwards, because the natural default of a `Map.get` is `undefined` and the natural
rendering of `undefined` is "nothing wrong here".

---

## EPIC-12-S27 — A spec edited mid-run voids the verdict and re-runs the gate

**Verifies:** KAR-12.4 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: The verdict carries the specHash it was judged against

  Scenario: The operator edits one word of AC-3 at seq 5200
    Given "gate.evaluated" for "review" recorded pass at seq 5100 with specHash "sha256:aaa…"
    When the spec is edited, producing specHash "sha256:bbb…" and a new spec.pinned event
    Then the verdict at seq 5100 is void
    And it does not satisfy any criterion
    And it does not advance any milestone
    And it remains in the ledger, visible as void rather than deleted
    And decide() re-schedules the "review" gate

  Scenario: Re-approving an unchanged spec does not void anything
    Given the spec is re-approved with no textual change
    Then specHash is unchanged, because it excludes approvedBy
    And no verdict is voided

  Scenario: Plan revalidation is mandatory after a spec edit
    When the new spec adds AC-10 with no covering gate
    Then revalidation fails and the run transitions to needs_human
    And it does not continue against a spec it no longer satisfies
```

**Notes:** `specHash` deliberately excludes `approvedBy` — _"re-approving an unchanged spec must not
change its identity, but editing one word must"_
([04 §2](../../04-domain-model.md)). Editing the spec mid-run is a first-class operation
([06 §1.3](../../06-planning-and-replanning.md)), which is precisely why the voiding rule has to be
mechanical.

---

## EPIC-12-S28 — A patch that abandons the last covering gate is rejected

**Verifies:** KAR-12.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Validation runs on every plan version, not only v1

  Scenario: A patch removes coverage
    Given AC-3 is covered only by gate node "gate-typecheck"
    When a PlanPatch { op: 'abandon', node: 'gate-typecheck', cascade: false } is proposed
    Then revalidation emits CRITERION_UNCOVERED for AC-3
    And the ledger contains "plan.patched" with decision "rejected" carrying the diagnostic
    And the plan hash is unchanged
    And the patch is never partially applied

  Scenario: The rejected patch is visible, not silent
    Then the approval queue shows the rejected patch so the operator can approve it explicitly
    And "plan.patch.proposed" was recorded even though the patch was rejected
```

**Notes:** _"the patch that adds a node reading a key nothing writes is the one that actually bites,
because it happens at node 27 of 40"_
([06 §8](../../06-planning-and-replanning.md)) — the same argument applies to a patch that removes a
gate. A rejection is _"not without you"_, not a dead end.

---

## EPIC-12-S29 — Repair happy path: one finding, regression test first, re-run from the top

**Verifies:** KAR-12.5 · **Type:** Happy path · **Automated at:** integration + e2e

```gherkin
Feature: The surgical repair loop

  Scenario: A single typecheck error is repaired
    Given "gate.evaluated" for "typecheck" recorded fail with one Finding "a13f…"
          rule "ts2345" at "packages/ui/src/DatePicker.vue:88"
    When the repair loop runs
    Then a PlanPatch { op: 'insert', nodes: ['fix-a13f…'] } is proposed
    And its reason is "typecheck failed: Argument of type 'string' is not assignable to parameter of type 'Date'"
    And the patch policy engine decides "auto" because the node adds no permission and costs under $5.00
    And the fix node runs at attempt 1 in its own worktree on "DeFlow/r1__fix-a13f"
    And the fix node's first commit adds a failing test
    And the gate re-run at that commit returns fail
    And the fix node's second commit makes it pass
    And the gate set re-runs from the deterministic tier
    And "gate.evaluated" for "typecheck" records pass
    And the milestone advances because the pass seq is after the last write seq

  Scenario: The ledger fixture is produced by this run
    Then exporting the run yields test/fixtures/runs/gate-failure-repair/ledger.db
    And it contains a failing gate, a fix node, a second attempt and a pass
```

**Notes:** _"The gate re-run after the fix includes the new test, so 'fixed' is demonstrated rather
than asserted"_ ([§7](../../10-verification-gates.md)). The fixture in the second scenario is what
EPIC-16 and EPIC-17 build against; producing it from a real run rather than by hand is what stops it
drifting from the engine ([testing strategy §12](../../14-testing-strategy.md)).

---

## EPIC-12-S30 — One fix node per finding, and the cases that produce none

**Verifies:** KAR-12.5 · **Type:** Edge case · **Automated at:** unit + integration

```gherkin
Feature: A fix node given five findings will fix two and introduce a sixth

  Scenario: Five findings, five fix nodes
    Given a fail verdict with five error-severity findings
    Then five fix nodes are proposed, one per Finding.id
    And each node id contains its finding id
    And each node's packet contains exactly one Finding

  Scenario Outline: What produces no fix node
    Given a verdict with <shape>
    Then zero fix nodes are proposed
    And <instead>

    Examples:
      | shape                                    | instead                                 |
      | outcome needs-human                      | a human node is opened                  |
      | outcome pass                             | the milestone advance is evaluated      |
      | findings all below severityFloor         | the verdict is pass and findings record |

  Scenario: The fix node's packet is narrow
    Then it contains the pinned spec, one Finding, the files that Finding names,
         and a handle to the failing command's output artifact
    And it contains no other finding
    And it contains no producer transcript
```

**Notes:** the narrow packet is _"both cheaper and measurably more reliable"_ than the producer's
large, mostly-irrelevant context ([§7](../../10-verification-gates.md)). The stable `Finding.id` from
[EPIC-12-S22](#epic-12-s22--stable-findingid-across-four-attempts) is what makes the split
mechanical rather than a heuristic.

---

## EPIC-12-S31 — Attempt 2 receives the previous verdicts and not the previous transcript

**Verifies:** KAR-12.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Fresh context is not optional

  Scenario: The second attempt's packet
    Given fix attempt 1 failed the re-run gate with a new Finding "9c02…"
    When attempt 2 is assembled
    Then its packet contains attempt 1's Verdict rendered as findings
    And its packet contains no segment derived from attempt 1's transcript
    And the node's resume is neither a fork nor a resume of the producer
    And the packet manifest snapshot matches the golden file for the "repair attempt 2" archetype

  Scenario: It does not repeat a fix already shown not to work
    Given attempt 1's verdict names the change it made and why the gate still failed
    Then that text is present verbatim in attempt 2's packet
```

**Notes:** three independent reasons, all in [§7](../../10-verification-gates.md): the producing
session has committed to the reasoning that produced the bug; it is the session most likely to have
compacted away the constraint the bug violates — omission compliance fell from **73% at turn 5 to
33% at turn 16** while commission compliance held at 100%; and its context is large and mostly
irrelevant to a one-line null check. A fresh node is at turn 0.

---

## EPIC-12-S32 — Three attempts, then escalation with all three diffs and all three verdicts

**Verifies:** KAR-12.5 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Capped at 3, then escalate

  Scenario: The third failure escalates
    Given fix attempts 1, 2 and 3 each fail the re-run gate
    Then "human.requested" is appended for the run
    And its payload carries three diff handles, one per attempt
    And three verdict handles, one per attempt
    And no fourth fix attempt is scheduled

  Scenario: The cap is 3, asserted as 3
    When a fourth attempt would be scheduled
    Then decide() returns a human.requested command instead
    And a test that changes the cap to 4 fails

  Scenario: The cap matches the scheduler's default
    Then maxAttemptsPerNode for a fix node is 3
    And the repair cap and the scheduler cap are the same number, read from one place
```

**Notes:** matching `maxAttemptsPerNode` is deliberate ([§7](../../10-verification-gates.md)) — two
independent caps that happen to agree is a bug waiting for one of them to be tuned. The third
scenario is the regression test for that.

---

## EPIC-12-S33 — A repair that needs more permission is queued, not auto-applied

**Verifies:** KAR-12.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: The repair loop goes through the patch policy engine like anything else

  Scenario: A fix needing worktree+net in a worktree run
    Given the run's ambient permission is "worktree"
    And the repair patch's estimate.maxPermission is "worktree+net"
    When the patch policy engine evaluates it
    Then the "escalates-permission" rule matches first
    And the decision is "approve", meaning queued for a human
    And the ledger contains "plan.patch.proposed" and no "plan.patched" with decision "auto"
    And the patch appears in the cross-run approval queue

  Scenario: The run does not stall on a queued repair
    Given two other branches of the plan are runnable
    Then those branches continue to be admitted
    And the run status is not "paused"

  Scenario: A read-only repair is auto-applied
    Given a repair patch with maxPermission "read" and costUsdDelta 0.40
    Then the "read-only-analysis" rule matches and the decision is "auto"
```

**Notes:** _"a fix needing more permission is NOT auto-applied"_ is stated in the repair-loop diagram
itself ([§7](../../10-verification-gates.md)) and falls out of the first rule in the default table
([06 §4.3](../../06-planning-and-replanning.md)). The middle scenario is the one people forget:
_the patch is pending, not the run_.

---

## EPIC-12-S34 — A repair loop that became a churn loop stops rather than accelerates

**Verifies:** KAR-12.5 · **Type:** Concurrency · **Automated at:** integration

```gherkin
Feature: The churn circuit breaker sees repair attempts as node attempts

  Scenario: The same work redone with the same inputs
    Given the sliding window holds the last 20 completed node attempts
    When the same (node_id, request_hash) appears a sixth time
    Then "run.needs_human" is appended with reason "churn"
    And the patch policy engine stops auto-applying patches
    And the next repair patch is neither auto-applied nor silently dropped
    And it appears in the approval queue

  Scenario: A human-authored patch resets the breaker
    Given the operator approves a patch that changes the approach
    Then the sliding window is reset
    And auto-application resumes

  Scenario: The stall detector is separate and does not auto-kill
    Given a legitimate 12-minute integration gate producing no state transitions
    Then "run.stalled" is appended and surfaced
    And the run is not killed
```

**Notes:** _"A repair loop that has become a churn loop must stop, not accelerate"_
([§7](../../10-verification-gates.md)). The third scenario is the boundary with F4.7: a long build,
a large test suite and a wedged agent look identical from the stall detector's position, so it
surfaces and never kills ([05 §11.2](../../05-durable-execution.md)).

---

## EPIC-12-S35 — The agent fixes the check instead of the code, and fails on path scope

**Verifies:** KAR-12.5 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The real defence in §9.1

  Scenario Outline: A repair node writes to a protected path
    Given a fix node whose declared pathScopes.write is ["packages/ui/src/**"]
    When it writes "<path>"
    Then the structural gate emits a Finding with rule "scope/undeclared-write"
    And the severity is promoted to "error" because the path is in the run's protected set
    And the node fails before its Verdict is considered

    Examples:
      | path                                |
      | .DeFlow/gates/typecheck.yaml        |
      | .DeFlow/config.yaml                 |
      | .github/workflows/ci.yml            |
      | pnpm-lock.yaml                      |

  Scenario: An ordinary undeclared write is a warning, not a failure
    Given the fix node also edits "packages/ui/src/index.ts", one import site outside its scope
    And git merge-tree reports no conflict at that path
    Then the Finding severity is "warning"
    And the gate does not fail on it
    And the violation still appears in the diff view and feeds the blast-radius estimate

  Scenario: The same path becomes an error when it also conflicts
    Given git merge-tree reports a conflict at "packages/ui/src/index.ts"
    Then the severity is promoted to "error"
```

**Notes:** _"the classic failure is not a human overriding a gate, it is an agent 'fixing' the
check"_ ([§9.1](../../10-verification-gates.md)). The second scenario is the counterweight and it is
equally load-bearing: hard-failing on scope alone trains you to declare `src/**` on every node, at
which point path scopes mean nothing and you have lost both the prediction and the ground truth
(D14).

---

## EPIC-12-S36 — Gate discovery hashes file **bytes** into the run manifest

**Verifies:** KAR-12.6 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Definitions are hashed into the run manifest at run creation

  Scenario: Three definitions discovered
    Given ".DeFlow/gates/" contains typecheck.yaml, bundle-budget.yml and a11y.yaml
    When the run is created
    Then "gates.loaded" is appended carrying { id, path, sha256 } for each
    And each sha256 equals the sha256sum of the file's bytes on disk
    And built-in definitions derived from package.json scripts appear in the same event
          with a path naming the recon source

  Scenario: The hash is over bytes, not over the parsed object
    Given a gate file is edited to add only a comment line
    Then its sha256 changes

  Scenario Outline: A bad definition prevents the run from starting
    Given "<file>" contains <defect>
    Then the run refuses to start
    And the message names the file, the field and the line

    Examples:
      | file            | defect                              |
      | a11y.yaml       | invalid YAML syntax                 |
      | a11y.yaml       | effect omitted                      |
      | a11y.yaml       | effect "mutating"                   |
      | bundle.yml      | timeout "soon"                      |
```

**Notes:** a parsed-object hash normalises away comments, key order and whitespace, so a
_"temporarily loosen this"_ comment edit becomes invisible — and the entire purpose of the manifest
hash is that a mid-run edit is visible. Bad files are refused rather than skipped, because a skipped
gate is a gate nobody notices missing.

---

## EPIC-12-S37 — A gate file edited mid-run diverges from the manifest

**Verifies:** KAR-12.6 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Weakening a gate mid-run is a visible divergence, not a quiet edit

  Scenario: The file on disk no longer matches the manifest
    Given "gates.loaded" recorded sha256 "aaa…" for ".DeFlow/gates/typecheck.yaml"
    When the file is edited during the run, giving sha256 "bbb…"
    And the typecheck gate is next evaluated
    Then "gate.evaluated" carries outcome "needs-human"
    And the reason is "gate-definition-diverged" carrying both hashes
    And the gate did not run against the new definition
    And the gate did not run against the cached definition either

  Scenario: An unrelated gate file's edit does not affect this gate
    Given only ".DeFlow/gates/a11y.yaml" changed
    Then the typecheck gate evaluates normally
    And the a11y gate is the one that diverges

  Scenario: An agent cannot cause this in the first place
    Given a node attempts to write ".DeFlow/gates/typecheck.yaml"
    Then the write is a hard "error" on path scope, per EPIC-12-S35
```

**Notes:** this is the same anti-drift principle as the pinned spec, applied to the checks
([§2](../../10-verification-gates.md)). Refusing to run against _either_ definition is deliberate:
running the old one hides the operator's intent, running the new one silently changes the contract
mid-run.

---

## EPIC-12-S38 — `doctor` reports gates nobody schedules, and both tails of the first-pass rate

**Verifies:** KAR-12.6 · **Type:** Edge case · **Automated at:** unit + integration

```gherkin
Feature: A gate nothing schedules is decoration

  Scenario: Defined but never evaluated
    Given ".DeFlow/gates/a11y.yaml" is defined
    And the last 10 runs contain no "gate.evaluated" for gate id "a11y"
    When the gate-hygiene projection is computed
    Then "a11y" is reported as defined-but-never-evaluated with the run count it was checked over

  Scenario Outline: The first-pass rate is informative at both tails
    Given gate "<gate>" has <passes> passes and <fails> fails across the sampled runs
    Then the projection reports rate <rate>
    And the advice is "<advice>"

    Examples:
      | gate      | passes | fails | rate | advice                                        |
      | typecheck | 3      | 4     | 0.43 | healthy                                       |
      | unit      | 1      | 9     | 0.10 | below 40%: the plan or the spec is wrong      |
      | a11y      | 10     | 0     | 1.00 | at 100%: testing nothing, or being written to |

  Scenario: The rate is per gate id, not per run
    Then computing it over all gates jointly is not what the projection returns
```

**Notes:** PRD §12 targets a gate first-pass rate above 40%, and
[§9.1](../../10-verification-gates.md) is explicit that **both** tails are informative — at 100% the
right response is to investigate rather than celebrate. The `doctor` command itself is
[EPIC-18](../epics/EPIC-18-cli-packaging.md) KAR-18.4; this epic owns the projection it prints.

The scenario has two halves and they are automated at two levels, which is why the line above says
both. The rate arithmetic and the 40%/100% advice are a pure reducer and are pinned at unit. **"The
last 10 runs"** is not — choosing the sample is a read of the log across runs, and every way of
getting it wrong (ranking runs by `ts`, taking the newest N _events_ rather than the newest N
_runs_, reading `gates.loaded` only from the latest run) yields a report that is confidently wrong
while the reducer's own tests stay green. So the window is exercised at integration against a real
file-backed ledger holding eleven runs, where widening the window by one run has to flip `a11y`
from decoration to healthy.

---

## EPIC-12-S39 — A custom producer parsed with `jsonl` and `$.violations`

**Verifies:** KAR-12.6 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The cases the built-in parsers do not cover

  Scenario: A bundle-size budget gate
    Given ".DeFlow/gates/bundle-budget.yaml" declaring
          run "node scripts/bundle-budget.mjs --json", cwd "worktree",
          timeout 120s, effect "pure",
          findings.parser "jsonl", findings.path "$.violations",
          satisfies [AC-11]
    And the script emits one JSON object per line with a violations array
    When the gate is evaluated
    Then each object under $.violations becomes a Finding
    And each Finding has a computed stable 12-hex id
    And each Finding has a blobSha for the file its range names
    And the Verdict criteria contains AC-11 with a status

  Scenario: A line that is not Finding-shaped
    Given one emitted line lacks a "file" field
    Then the gate outcome is "needs-human" with reason "gate-output-unparseable"
    And the raw output is attached as an artifact Handle
    And no partial Finding set is recorded
```

**Notes:** the failure branch matters as much as the happy one. A partially-parsed finding set is
worse than none: the diff view would render three of five problems and the operator would reasonably
conclude there were three.

---

**Related:** [EPIC-12](../epics/EPIC-12-verification-gates.md) ·
[Verification gates](../../10-verification-gates.md) ·
[Human in the loop flows](./EPIC-13-human-in-the-loop-flows.md) ·
[Workspace isolation flows](./EPIC-07-workspace-isolation-flows.md) ·
[Board](../board.md)

[← Back to the delivery plan](../README.md)
