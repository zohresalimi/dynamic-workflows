# EPIC-10 flows — Task intake and framing

> Behavioural specification for [EPIC-10](../epics/EPIC-10-task-intake.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor             | Description                                                                                                                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator**      | The engineer driving DeFlow. In this epic they are a first-class participant, not an observer: they submit the task, answer the framing agent's questions, edit the draft spec, and hold the approval that unblocks execution |
| **DeFlowd**       | The local daemon: HTTP + SSE API, orchestrator tick loop, Context Builder, Blackboard, Workspace Manager                                                                                                                      |
| **`deflow` CLI**  | `deflow run "…"` and the approval commands. A **client of the HTTP API**, never a second engine                                                                                                                               |
| **Framing agent** | A `deflow-mock-agent` subprocess at `read` permission in a fresh ACP session, returning a `DeFlow.taskspec.v1` document as structured output                                                                                  |
| **Recon node**    | One or more `read`-permission agent nodes in a `--detach --lock` worktree, writing `finding/*` and `scope/*` facts                                                                                                            |
| **Approval gate** | A blocking `human` node suspended on one `node_wake` row with `reason = 'human_gate'`                                                                                                                                         |
| **Ledger**        | The file-backed SQLite database from [EPIC-03](../epics/EPIC-03-event-ledger.md) — `event`, `run`, `node_wake`, `fact`, `plan`                                                                                                |
| **Blackboard**    | The `fact` / `fact_edges` projection over `fact.written` / `fact.read` / `fact.invalidated`                                                                                                                                   |
| **Repository**    | A real git working copy created by `makeRepo(...)` with `GIT_CONFIG_GLOBAL=/dev/null` and forced identity env                                                                                                                 |
| **Pin compiler**  | `compilePinnedSegments(spec, node)` in `@DeFlow/core` — pure, total, byte-preserving                                                                                                                                          |
| **Gate runner**   | [EPIC-12](../epics/EPIC-12-verification-gates.md)'s runner, appearing here only as the consumer that must read the spec from the ledger                                                                                       |

## Preconditions common to all flows

```gherkin
Background:
  Given a DeFlow workspace initialised in a git repository on branch "main"
  And the ledger is a FILE-BACKED SQLite database — ":memory:" only where "Automated at: unit"
      names a pure function or a pure projection
  And deflow-mock-agent is on a temp PATH, resolved to an ABSOLUTE path before spawn, and every
      invocation passes --seed so the run is byte-reproducible
  And the mock agent's advertised agentCapabilities are set explicitly per scenario, never assumed
  And time enters through the injected Clock port — never Date.now() or setTimeout
  And no test calls vi.useFakeTimers() while a mock-agent child process is alive
  And the normalising snapshot serializer is registered, so timestamps, ULIDs, durations and
      absolute paths do not churn every golden spec and packet
  And a run created by POST /api/runs does NOT start execution: it returns
      status "awaiting-spec-approval"
  And specHash is sha256 over the canonicalised TaskSpec EXCLUDING approvedBy
```

> Two rules bind this whole file. **Intake interprets nothing** — every assertion about the raw
> source is a byte equality against what the operator submitted, not a similarity. And **the gate is
> proven negatively**: the load-bearing assertion is the _absence_ of a `node.scheduled` event, read
> from the ledger, never from an in-memory status flag.

## Flow index

| Scenario    | Title                                                                            | Verifies           | Type                 |
| ----------- | -------------------------------------------------------------------------------- | ------------------ | -------------------- |
| EPIC-10-S1  | Happy path: free text in, run id out, nothing executed                           | KAR-10.1           | Happy path           |
| EPIC-10-S2  | Four intake kinds, one `task.submitted` shape                                    | KAR-10.1           | Happy path (outline) |
| EPIC-10-S3  | Intake normalises and does not interpret                                         | KAR-10.1           | Edge case            |
| EPIC-10-S4  | A file path that escapes the repository root is refused, and no run is born      | KAR-10.1           | Failure              |
| EPIC-10-S5  | `Idempotency-Key` makes a retried submission free                                | KAR-10.1           | Edge case            |
| EPIC-10-S6  | Happy path: the framing interview returns a complete `TaskSpec`                  | KAR-10.2           | Happy path           |
| EPIC-10-S7  | **The framing agent asks a clarifying question and the operator answers**        | KAR-10.2           | Happy path           |
| EPIC-10-S8  | The framing agent is `read`-only and a write attempt does not kill the interview | KAR-10.2           | Failure              |
| EPIC-10-S9  | A criterion with no gate and no `unverifiable` flag is a validation failure      | KAR-10.2           | Failure              |
| EPIC-10-S10 | Structured output at the adapter boundary, or refuse to schedule                 | KAR-10.2           | Failure              |
| EPIC-10-S11 | One bounded repair, then a typed node failure — never a half-written spec        | KAR-10.2           | Failure              |
| EPIC-10-S12 | The framing agent inherits no other node's context                               | KAR-10.2           | Edge case            |
| EPIC-10-S13 | **The approval gate genuinely blocks execution**                                 | KAR-10.3           | Happy path           |
| EPIC-10-S14 | **The operator edits the draft `TaskSpec` before approving**                     | KAR-10.3           | Happy path           |
| EPIC-10-S15 | **The operator rejects the spec and the interview re-runs with the reason**      | KAR-10.3           | Edge case            |
| EPIC-10-S16 | Six hours, a closed lid and a `SIGKILL` cost one SQLite row                      | KAR-10.3           | Recovery             |
| EPIC-10-S17 | `specHash` excludes `approvedBy` in both directions                              | KAR-10.3           | Edge case            |
| EPIC-10-S18 | Approving from the CLI and from the API produce the same ledger                  | KAR-10.3           | Happy path (outline) |
| EPIC-10-S19 | Approval mints the pinned set in one transaction                                 | KAR-10.4           | Happy path           |
| EPIC-10-S20 | Every node archetype's packet carries the pinned spec first and byte-identical   | KAR-10.4           | Happy path           |
| EPIC-10-S21 | **Anti-drift: the gate is judged against the pinned spec, not the current code** | KAR-10.4           | Failure              |
| EPIC-10-S22 | A verdict carrying a stale `specHash` is void and the gate re-runs               | KAR-10.4           | Failure              |
| EPIC-10-S23 | A vanished pin fails the node and is never silently retried                      | KAR-10.4           | Failure              |
| EPIC-10-S24 | Happy path: recon surveys the repo into typed facts with evidence                | KAR-10.5           | Happy path           |
| EPIC-10-S25 | A claimed test command that does not exist is `speculative`, not `verified`      | KAR-10.5           | Failure              |
| EPIC-10-S26 | Recon runs detached, locked and read-only                                        | KAR-10.5           | Edge case            |
| EPIC-10-S27 | `.DeFlow/gates/` in the repo is discovered and bindable to a criterion           | KAR-10.5           | Edge case            |
| EPIC-10-S28 | Recon output is offloaded, never truncated, and never handed on as a transcript  | KAR-10.5           | Failure              |
| EPIC-10-S29 | A mid-run spec edit re-pins and forces revalidation                              | KAR-10.3, KAR-10.4 | Recovery             |

---

## EPIC-10-S1 — Happy path: free text in, run id out, nothing executed

**Verifies:** KAR-10.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Task intake

  Background:
    Given a git repository at /tmp/DeFlow-<rand>/repo on branch "main"
    And DeFlowd is running with that repository as cwd

  Scenario: free text submitted over HTTP
    When the Operator sends POST /api/runs with
      """
      { "input": { "kind": "text", "text": "Migrate the design system across packages/ui" },
        "cwd": "/tmp/DeFlow-<rand>/repo",
        "budget": { "costUsd": 25, "wallclockMs": 14400000 },
        "permission": "worktree" }
      """
    Then the response is 201 with status "awaiting-spec-approval"
    And the response carries a runId and the seq of the appended event
    And the ledger contains a "task.submitted" event whose payload.raw is byte-identical to
        "Migrate the design system across packages/ui"
    And the ledger contains NO "run.created" event — intake has no TaskSpec to put in its
        payload, so the framing interview appends it (EPIC-10-S6)
    And the ledger contains NO "node.scheduled" event for any node other than the framing node
    And the ledger contains NO "plan.proposed" event

  Scenario: the CLI is a client, not a second engine
    When the Operator runs: deflow run "Migrate the design system across packages/ui"
    Then the ledger is byte-identical to the HTTP case modulo runId, seq and timestamps
    And task.submitted provenance records by: 'cli'
```

**Notes:** `run.created` used to be asserted here and moved to EPIC-10-S6 on 7 August 2026 — its
payload carries the `TaskSpec` ([04 §9](../../04-domain-model.md)) and the repo head at the moment
framing runs, neither of which intake may invent
([06 §1.1](../../06-planning-and-replanning.md): _"no interpretation happens here"_). Its absence is
now a positive assertion rather than an omission, so nobody quietly re-adds it to intake.

The last two Then clauses of the first scenario are the point of the scenario. Creating a
run must not start it — [11 §7.1](../../11-api-and-realtime.md) is explicit that _"execution begins
only after `POST /runs/:id/spec/approve`"_, and the cheapest way to get this wrong is to have the
scheduler's tick loop treat "a run exists" as "a run is runnable".

---

## EPIC-10-S2 — Four intake kinds, one `task.submitted` shape

**Verifies:** KAR-10.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: F1.1 accepts a task as free text, a file, a git issue reference or a spec document

  Scenario Outline: every source normalises to the same event
    Given the repository contains <fixture>
    When the Operator submits <input>
    Then a "task.submitted" event is appended with payload.provenance.kind = "<kind>"
    And payload.sha256 equals the sha256 of the source bytes
    And payload.provenance carries <provenanceFields>
    And the run status is "awaiting-spec-approval"

    Examples:
      | kind  | fixture                    | input                                                        | provenanceFields                          |
      | text  | —                          | { kind: 'text', text: 'Fix the flaky checkout test' }         | submittedAt, by                           |
      | file  | docs/spec.md (3 KB)        | { kind: 'file', path: 'docs/spec.md' }                        | resolvedPath (absolute), bytes, mediaType |
      | file  | docs/spec.md (200 KB)      | { kind: 'file', path: 'docs/spec.md' }                        | resolvedPath, bytes, handle               |
      | issue | —                          | { kind: 'issue', url: 'https://github.com/acme/web/issues/412' } | url, resolver, httpStatus, fetchedAt   |

  Scenario: a spec document is the file kind, not a fourth wire shape
    When the Operator submits { kind: 'file', path: 'docs/OPENSPEC-412.md' }
    Then payload.provenance.kind is "file"
    And payload.provenance.mediaType is "text/markdown"
    And no branch in the intake code inspects the document's content to classify it

  Scenario: a large file is stored by handle, not inlined into the event row
    Given docs/spec.md is 200 KB
    When it is submitted
    Then payload.raw is absent and payload.handle matches "artifact://[0-9a-f]{64}"
    And reading that handle from the CAS returns the file's exact bytes
```

**Notes:** Four sources, one event — the whole design of [06 §1.1](../../06-planning-and-replanning.md)
is that the _only_ thing intake does is normalise. The 64 KiB inline threshold exists so a 200 KB
spec document does not bloat every ledger read; the number matters less than the rule that the
event row stays small and the bytes stay addressable.

---

## EPIC-10-S3 — Intake normalises and does not interpret

**Verifies:** KAR-10.1 · **Type:** Edge case · **Automated at:** integration

````gherkin
Feature: The raw source survives every later transformation

  Scenario: awkward input is preserved exactly
    When the Operator submits free text containing CRLF line endings, a trailing space, a tab-indented
        code block, an emoji, and the literal string "```"
    Then payload.raw is byte-identical to the submitted bytes
    And no whitespace was trimmed, no line ending was normalised, and no markdown was reflowed

  Scenario: the raw task is still readable after framing, approval and two replans
    Given the run has completed framing, been approved, and had two plan.patched events applied
    When the raw source is read back from the ledger at seq 0
    Then it is byte-identical to what was submitted
    And answering "what did I actually ask for?" required no reconstruction from a later artifact

  Scenario: intake writes no interpretation
    When a task is submitted
    Then no "fact.written" event exists before the recon nodes run
    And the task.submitted payload contains no goal, scope, criteria or inferred archetype field
````

**Notes:** The temptation to "helpfully" trim or title-case here is real and it is exactly what
[06 §1.1](../../06-planning-and-replanning.md) forbids. The third scenario is a structural guard: if
intake ever starts inferring an archetype, the F1.4 template work has quietly leaked out of M2 and
into the one component that is supposed to be dumb.

---

## EPIC-10-S4 — A file path that escapes the repository root is refused, and no run is born

**Verifies:** KAR-10.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Intake failures leave no half-born run

  Scenario Outline: rejected inputs create nothing
    When the Operator submits <input>
    Then the response is a 4xx with a typed error naming <field>
    And SELECT count(*) FROM run returns 0
    And no "run.created" and no "task.submitted" event was appended

    Examples:
      | input                                                    | field         |
      | { kind: 'file', path: '../../../etc/passwd' }            | input.path    |
      | { kind: 'file', path: 'docs/does-not-exist.md' }         | input.path    |
      | { kind: 'issue', url: 'https://github.com/acme/web/issues/999999' }  | input.url  |
      | { kind: 'text', text: '' }                               | input.text    |

  Scenario: a symlink that resolves outside the repo is refused after realpath
    Given docs/outside.md is a symlink to /etc/hosts
    When the Operator submits { kind: 'file', path: 'docs/outside.md' }
    Then the response is a 4xx naming input.path
    And the rejection happened after realpath resolution, not before

  Scenario: the network is unavailable
    Given the issue resolver cannot reach the host
    When the Operator submits an issue reference
    Then the error message names the URL and the resolver used
    And it tells the Operator they may paste the issue text as { kind: 'text' } instead
    And no run row exists
```

**Notes:** The `realpath`-then-check ordering is the same trap the permission ladder has
([08-safety](../epics/EPIC-08-safety-model.md)), and it bites here first because intake runs _before_
any permission level exists for the run. The offline path matters for NF1: `{kind:'issue'}` is the
only outbound request DeFlowd itself makes, so its failure must be a clean, actionable refusal
rather than a stack trace.

---

## EPIC-10-S5 — `Idempotency-Key` makes a retried submission free

**Verifies:** KAR-10.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Run creation is idempotent under retry

  Scenario: the same key twice
    When the Operator sends POST /api/runs with Idempotency-Key "k-1"
    And the same request is sent again with Idempotency-Key "k-1"
    Then both responses carry the same runId
    And exactly one "task.submitted" event exists, and no "run.created" event exists

  Scenario: a different key is a different run
    When the same body is sent with Idempotency-Key "k-2"
    Then a second runId is returned
    And two "task.submitted" events exist

  Scenario: a flaky client that never saw the first 201
    Given the first response was lost in transit
    When the client retries with the same key
    Then it receives 201 with the original runId and the original seq
    And no second framing node was scheduled
```

**Notes:** This is cheap and it prevents the most annoying possible first-week bug: a CLI that
retries on a timeout and quietly starts two framing interviews against the same repository, both of
which will want a worktree.

---

## EPIC-10-S6 — Happy path: the framing interview returns a complete `TaskSpec`

**Verifies:** KAR-10.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The framing interview (F1.2)

  Background:
    Given a task was submitted as free text
    And the probed provider_capabilities row for the resolved adapter advertises structuredOutput: true
    And deflow-mock-agent is scripted to return a valid DeFlow.taskspec.v1 document

  Scenario: a complete spec lands in the ledger
    When the framing node runs
    Then it was scheduled with permission "read" and a fresh ACP session
    And the returned document was read from the result envelope's structured_output field,
        not parsed out of stdout text
    And the document validates against .DeFlow/schemas/DeFlow.taskspec.v1.json with Ajv
        (strict: true, allErrors: true)
    And the TaskSpec carries a non-empty goal, scope, nonGoals, constraints, priorDecisions,
        acceptanceCriteria and knownFailureModes
    And every acceptanceCriteria entry has an id matching /^AC-\d+$/ and a single testable statement
    And every knownFailureModes entry has both a description and a detection
    And exactly one "run.created" event is appended after the node succeeds, carrying that spec,
        the cwd and repo.head with repo.branch "main"
    And the run status becomes "awaiting-spec-approval"

  Scenario: the framing node's return budget is set for its type
    Then the framing node's returns.maxTokens is 4000, not the 1500 default
```

**Notes:** [06 §1.2](../../06-planning-and-replanning.md) calls framing _"the one place where a model
is allowed to be expansive, because everything downstream is judged against what it produces"_ —
hence the raised return budget. Reading `structured_output` rather than stdout is not a preference:
_"do not accept a prose plan… a regex over prose is how the planner layer starts breaking on every
CLI update."_

---

## EPIC-10-S7 — The framing agent asks a clarifying question and the operator answers

**Verifies:** KAR-10.2 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The interview is an interview

  Background:
    Given the task text is "Migrate the design system" and names no packages
    And deflow-mock-agent is scripted to emit a clarifying question before returning a spec

  Scenario: the run suspends on the question and resumes on the answer
    When the framing node runs
    Then a "human.requested" event is appended carrying the question text and its options
    And exactly one node_wake row exists for the framing node with reason = 'human_gate'
    And the run consumes no CPU between ticks — the tick performs one indexed node_wake query
    And no further prompt was sent to the agent while suspended
    When the Operator answers "Only packages/ui and packages/forms. Leave packages/legacy alone."
    Then a "human.responded" event is appended carrying that text
    And the answer is delivered into the same ACP session because the adapter advertises steering
    And the framing node completes with a TaskSpec whose nonGoals name "packages/legacy"
    And the TaskSpec.priorDecisions contains an entry with source 'operator' quoting the answer

  Scenario: the adapter cannot steer mid-session
    Given the resolved adapter's probed row does not advertise mid-turn steering
    When the Operator answers
    Then a fresh session is opened and the question and answer are replayed into its packet
    And the ledger records that a replay was used, so the node inspector can explain the extra turn
    And the delivery is never reported as 'delivered' when it was in fact a replay

  Scenario: the Operator ignores the question for six hours
    Given the TestClock advances six hours
    Then the node_wake row still exists and no timeout fired
    And the framing node is still suspended, not failed
```

**Notes:** Two subtleties. First, the answer must land in **both** the agent's context and the spec's
`priorDecisions` — a clarification that only reaches the model is a decision nobody can audit six
weeks later. Second, the honest reporting of replay-versus-steering mirrors
[11 §7.5](../../11-api-and-realtime.md)'s rule for interjection: _"the UI must render that honestly
rather than showing a delivered guidance bubble that never arrived."_

---

## EPIC-10-S8 — The framing agent is `read`-only and a write attempt does not kill the interview

**Verifies:** KAR-10.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The framing agent runs at read permission (F5.4)

  Background:
    Given deflow-mock-agent is scripted with testkit scenario 4 (call back into the client)

  Scenario: a write is rejected at the ACP boundary
    When the agent calls fs/write_text_file with a path inside the repository
    Then DeFlow's client implementation rejects the call
    And the rejection is recorded so the node inspector can show it
    And the agent's turn continues and still produces a TaskSpec
    And no bytes were written to the repository

  Scenario: a mutating terminal command is rejected
    When the agent calls terminal/create with "pnpm install"
    Then the call is rejected because the level is 'read'
    And the ledger records the attempted command verbatim

  Scenario: a read is allowed
    When the agent calls fs/read_text_file for package.json inside the repository
    Then the call succeeds
    And a corresponding evidence handle is available for any fact derived from it
```

**Notes:** This is the ACP-client dividend from [14 §10](../../14-testing-strategy.md): because
DeFlow implements `fs/*` and `terminal/*`, the whole ladder is _"one policy function in DeFlow's own
code"_ and this scenario needs no vendor CLI at all. The rule that the interview **continues** after
a refusal matters — a framing agent that probes and gets told no is behaving correctly, and killing
the node would make `read` unusable in practice.

---

## EPIC-10-S9 — A criterion with no gate and no `unverifiable` flag is a validation failure

**Verifies:** KAR-10.2 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: The acceptance-criteria contract is enforced structurally (F7.4)

  Scenario: a criterion nothing checks
    Given a TaskSpec containing
      """
      acceptanceCriteria:
        - id: AC-3
          statement: "All 47 components under packages/ui/src/** compile under Vue 3 with no type errors."
          verifiedBy: [typecheck, build]
        - id: AC-7
          statement: "The migration does not regress bundle size."
          verifiedBy: []
      """
    When the spec is validated
    Then validation fails with exactly one error naming AC-7
    And the error text says the criterion must name at least one gate or be marked unverifiable

  Scenario: unverifiable is a legitimate answer, with a reason
    Given AC-9 is
      """
        - id: AC-9
          statement: "The migrated date picker feels as responsive as the old one."
          unverifiable: true
          reason: "Subjective. No harness exists. Route to a human node at the end of the milestone."
          verifiedBy: [human-review-ui]
      """
    When the spec is validated
    Then validation passes
    And AC-9 will render on the F10.8 board in the third state, not counted as green

  Scenario: unverifiable without a reason is not an escape hatch
    Given AC-9 carries unverifiable: true and an empty reason
    Then validation fails naming AC-9

  Scenario: all violations are reported at once
    Given four criteria each violate the contract
    Then validation returns four errors ordered by criterion id
```

**Notes:** Ten seconds of author cost that _"removes an entire class of false confidence"_
([10 §5.1](../../10-verification-gates.md)). The three-state rendering in scenario 2 is the reason
`unverifiable` is a first-class flag rather than an omission: an unverifiable criterion must be
**visible**, not quietly counted as satisfied.

---

## EPIC-10-S10 — Structured output at the adapter boundary, or refuse to schedule

**Verifies:** KAR-10.2 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Never parse a prose spec

  Scenario Outline: the schema goes to the adapter that can take it
    Given the probed provider_capabilities row for <adapter> says structuredOutput = <supported>
    When the framing node is resolved onto <adapter>
    Then the outcome is <outcome>

    Examples:
      | adapter               | supported | outcome                                                       |
      | claude-agent-acp      | true      | scheduled, --json-schema passed at the adapter boundary        |
      | codex-acp             | true      | scheduled, --output-schema <FILE> passed                       |
      | a probed adapter with structuredOutput false | false | refused with adapter.capability-missing     |
      | an unprobed adapter   | —         | refused; capabilities are read from the row, never a constant  |

  Scenario: there is no prose fallback
    Given the mock agent returns a well-formed spec as markdown prose in an agent_message_chunk
    And structured_output is absent from the result envelope
    Then the node fails with reason 'contract.schema-invalid'
    And no regex, no JSON-block extraction and no heuristic parse was attempted

  Scenario: the capability matrix is not hardcoded
    Then a CI grep proves no source file contains a literal capability table keyed by provider name
```

**Notes:** [06 §8](../../06-planning-and-replanning.md) states both halves: _"do not hardcode a
provider capability matrix — it will be wrong within a month"_, and _"do not accept a prose plan"_.
The same argument applies to the spec, and it applies harder, because the spec is what everything
downstream is judged against.

---

## EPIC-10-S11 — One bounded repair, then a typed node failure — never a half-written spec

**Verifies:** KAR-10.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Handoff contract validation on the framing return (F6.9)

  Scenario: one repair fixes it
    Given the mock agent's first return omits knownFailureModes
    When the framing node runs
    Then exactly one repair prompt was sent, carrying the Ajv errors
    And the second return validates
    And the node completes
    And the ledger shows both attempts, so the repair is visible in the inspector

  Scenario: still invalid after the repair
    Given both returns omit knownFailureModes
    Then the node fails with reason 'contract.schema-invalid'
    And no TaskSpec was written to the ledger — not a partial one, not a defaulted one
    And no "run.created" event was appended, since its payload is that TaskSpec
    And the run does not advance to "awaiting-spec-approval"

  Scenario: the vendor exhausted its own repair loop first
    Given the adapter returns the error subtype error_max_structured_output_retries
    Then the node fails with reason 'agent.schema-repair-exhausted'
    And DeFlow does not add its own repair attempt on top of the vendor's

  Scenario: an oversize spec is offloaded, never truncated
    Given the returned document exceeds returns.maxTokens of 4000
    Then a "handoff.oversize" event is appended with budget 4000 and the actual count
    And one bounded repair is attempted
    And a still-oversize document fails the node rather than being cut at 4000 tokens
```

**Notes:** _"Never truncate an oversized structured return — it produces invalid JSON and propagates
exactly the garbage F6.9 exists to prevent. Repair or fail."_
([roadmap §7](../../17-roadmap.md)). The third scenario stops a doubled repair loop: Claude Code
already performs bounded internal repair against the schema, so stacking DeFlow's on top burns quota
to reach the same conclusion more slowly.

---

## EPIC-10-S12 — The framing agent inherits no other node's context

**Verifies:** KAR-10.2 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: No implicit context inheritance (F6.1)

  Scenario: a second framing attempt after a rejection
    Given a previous framing attempt produced a spec the Operator rejected
    When the second framing attempt is scheduled
    Then its context packet contains the raw task, the rejected spec, the rejection reason and the
        pinned safety constraints
    And it contains NO history.summary segment sourced from the first attempt's transcript
    And every segment's sourceEvent points at an event in this run's ledger

  Scenario: the packet is a golden file
    When the framing packet is rendered
    Then it matches __snapshots__/packet-framing.json under the normalising serializer
    And pinned segments appear first
```

**Notes:** F6.1 exists _"so that the edges in the plan graph mean something"_. A framing agent that
silently inherits the previous attempt's transcript is the smallest possible violation and the
easiest to introduce, because "just resume the session" looks like an optimisation.

---

## EPIC-10-S13 — The approval gate genuinely blocks execution

**Verifies:** KAR-10.3 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: F1.3 is a real gate, not a formality

  Background:
    Given the framing node has completed and produced a valid TaskSpec
    And a blocking human node exists with a "human.requested" event carrying the rendered spec
        and options [approve, edit, reject, abandon]

  Scenario: nothing runs while the gate is open
    When the scheduler's tick loop is advanced by 30 simulated minutes on the TestClock
    Then the derived ready set is empty on every tick
    And the ledger contains NO "node.scheduled" event for any node other than the framing and
        recon nodes
    And the ledger contains NO "plan.proposed" event
    And no agent subprocess was spawned — the testkit's side-effect log file is empty

  Scenario: approval unblocks it, in that order
    When the Operator approves
    Then "run.spec.approved" { specHash, by } is appended
    And "spec.pinned" is appended in the SAME transaction
    And only after both are durably committed does the ready set become non-empty

  Scenario: the block is derived from the log, not from a flag
    Given the daemon is restarted between the framing completion and the approval
    Then the reduced state still reports "awaiting-spec-approval"
    And no in-memory boolean was consulted to reach that conclusion
```

**Notes:** This is the epic's headline assertion and it is deliberately negative — the absence of
`node.scheduled`, read from the ledger. [05 §](../../05-durable-execution.md) is explicit that pause
is _"an **event**, never an in-memory flag"_, and the same reasoning applies here: a status field
that says `awaiting-spec-approval` while the scheduler happily derives a ready set is a gate that
exists in the UI and nowhere else.

---

## EPIC-10-S14 — The operator edits the draft `TaskSpec` before approving

**Verifies:** KAR-10.3 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Human edit of the TaskSpec (F1.3)

  Background:
    Given the framing agent produced a spec whose nonGoals is ["rewriting the router"]
    And whose AC-4 statement is "The build passes."

  Scenario: the Operator sharpens a criterion and adds a non-goal
    When the Operator edits AC-4 to "pnpm build exits zero and emits no new type errors."
    And adds "changing the public API of @voyado/ui" to nonGoals
    And submits the edit
    Then a "spec.amended" event is appended carrying an RFC 6902 patch of exactly those two changes
    And the new specHash differs from the framing agent's specHash
    And the pre-edit spec is still readable from the ledger at its original hash
    And nothing was overwritten in place

  Scenario: approval after an edit pins the edited spec
    When the Operator approves
    Then "run.spec.approved" carries the post-edit specHash
    And the pinned segments compiled from it contain the edited AC-4 text byte-for-byte
    And the framing agent's original wording appears nowhere in any packet

  Scenario: an edit that breaks the criteria contract is refused at the gate
    When the Operator edits AC-4 to remove its verifiedBy without marking it unverifiable
    Then the edit is refused with the same error text as EPIC-10-S9
    And the gate stays open, the run is not failed, and the Operator can correct the edit

  Scenario: an edit is diffable in the UI
    Then GET the spec history returns each version with its hash and the rfc6902 patch between them
```

**Notes:** The RFC 6902 patch is the same mechanism the plan-evolution scrubber uses
([11 §7.4](../../11-api-and-realtime.md), `rfc6902@5.3.0` — _not_ `fast-json-patch`, which last
shipped in 2022), which means the spec history and the plan history render through the same
component. The third scenario is the one people forget: the contract check has to run on the human's
edit too, or the gate becomes a way to launder an untestable criterion into the run.

---

## EPIC-10-S15 — The operator rejects the spec and the interview re-runs with the reason

**Verifies:** KAR-10.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Reject and re-frame

  Scenario: rejection is not abandonment
    When the Operator rejects with the reason
        "The criteria are untestable and you missed that packages/legacy is frozen."
    Then the rejection and its reason are appended to the ledger
    And the rejected TaskSpec remains readable at its own specHash
    And a second framing attempt is scheduled
    And that attempt's packet contains the raw task, the rejected spec and the rejection reason
    And no plan was proposed and no worktree was created in between

  Scenario: the second attempt is judged by the same contract
    When the second attempt returns a spec
    Then the acceptance-criteria contract is validated identically
    And a fresh human node opens with the new draft

  Scenario: repeated rejection does not loop forever
    Given the Operator has rejected three framing attempts
    Then the run transitions to needs_human with reason 'churn'
    And the approval queue shows all three rejected drafts and their reasons
    And no fourth framing attempt is auto-scheduled

  Scenario: abandon closes the run cleanly
    When the Operator chooses abandon
    Then "run.aborted" is appended
    And every artifact produced so far is still inspectable on disk under .DeFlow/runs/<runId>/
```

**Notes:** The third scenario deliberately reuses the churn vocabulary from
[05 §11.3](../../05-durable-execution.md). Three framing attempts with no accepted spec is the same
shape as three replans with no completed nodes — _"a plan built on a false premise, and the only
thing that can supply the missing premise is the person who wrote the spec."_ Auto-scheduling a
fourth attempt is the failure this scenario forbids.

---

## EPIC-10-S16 — Six hours, a closed lid and a `SIGKILL` cost one SQLite row

**Verifies:** KAR-10.3 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Durable suspension at the approval gate (F8.1, F4.8, NF4)

  Background:
    Given the run is suspended at the approval gate
    And the ledger is a real file at <tmp>/.DeFlow/DeFlow.db with journal_mode = WAL

  Scenario: the cost of waiting
    Then exactly one node_wake row exists for the gate node with reason = 'human_gate'
    And no timer was created — a grep of the daemon's source finds no setTimeout on this path
    And each 1 Hz tick performs one indexed query against node_wake(wake_at)

  Scenario: SIGKILL and restart
    When the daemon is killed with SIGKILL — no cleanup, no flush, no handlers
    And a fresh engine is constructed over the SAME database file
    Then PRAGMA integrity_check returns 'ok'
    And the reduced state still reports "awaiting-spec-approval"
    And the same human node is still open with the same "human.requested" payload
    And approving now advances the run exactly as it would have before the crash

  Scenario: six hours on the TestClock
    When the Clock advances six hours with no operator input
    Then the gate is still open
    And no deadline fired, because this human node declares no deadline
    And the run's cost accounting shows zero tokens consumed during the wait
```

**Notes:** `:memory:` cannot express this scenario at all — it _"cannot be reopened after a simulated
crash, which is the one property that matters most"_ ([14 §7](../../14-testing-strategy.md)). The
`SIGKILL`, not `SIGTERM`, is deliberate: SIGTERM tests the shutdown handler, SIGKILL tests
durability.

---

## EPIC-10-S17 — `specHash` excludes `approvedBy` in both directions

**Verifies:** KAR-10.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: specHash identity (04 §2)

  Scenario: re-approving an unchanged spec preserves identity
    Given a TaskSpec with specHash H
    When approvedBy is set to { at: <t1>, via: 'ui' }
    And the hash is recomputed
    Then it still equals H
    When approvedBy is replaced with { at: <t2>, via: 'cli' }
    Then it still equals H

  Scenario: editing one word changes identity
    When one character of goal is changed
    Then the recomputed hash differs from H
    When one whitespace character is added inside a criterion statement
    Then the recomputed hash differs from H

  Scenario: canonicalisation is key-order independent
    Given two structurally identical specs whose JSON key order differs
    Then both canonicalise to the same bytes and hash to the same value

  Scenario: the hash uses node:crypto over an owned canonical encoder
    Then no source file computes specHash with ohash
```

**Notes:** _"`specHash` excludes `approvedBy` deliberately: re-approving an unchanged spec must not
change its identity, but editing one word must"_ ([04 §2](../../04-domain-model.md)). The last
scenario carries the same `ohash` prohibition as `planHash` — best-effort stable serialisation is
fine for change detection and not fine for a value that voids verdicts.

---

## EPIC-10-S18 — Approving from the CLI and from the API produce the same ledger

**Verifies:** KAR-10.3 · **Type:** Happy path · **Automated at:** e2e

```gherkin
Feature: Approval is reachable without the UI

  Scenario Outline: two surfaces, one code path
    Given a run suspended at the approval gate
    When the Operator approves via <surface>
    Then "run.spec.approved" is appended with by = "<by>"
    And the ledgers from the two surfaces are identical modulo the by field and timestamps
    And the run becomes schedulable in both cases

    Examples:
      | surface                                   | by  |
      | POST /api/runs/:id/spec/approve           | ui  |
      | the DeFlow CLI in a second terminal       | cli |

  Scenario: a second daemon cannot approve behind the first's back
    Given a second DeFlowd is started over the same data directory
    Then it fails fast on the flock with a message naming the pid holding the lock
    And no approval is recorded twice
```

**Notes:** M1's UI arrives in W10–W11, well after W7a, so the CLI approval path is not a convenience
— it is the only way this epic is testable end to end when it is built. The `flock` scenario is
cheap insurance against the _"user runs `npx deflow up` in two terminals"_ case
[05 §12](../../05-durable-execution.md) says _"happens the first week"_.

---

## EPIC-10-S19 — Approval mints the pinned set in one transaction

**Verifies:** KAR-10.4 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Approval mints the pinned spec (F1.5)

  Scenario: the pinned set is exactly the enumerated five
    When the Operator approves
    Then "spec.pinned" is appended carrying the sha256 of each pinned segment and the specHash
    And the pinned set is exactly: TaskSpec goal and nonGoals, acceptance criteria, safety
        constraints, declared path scopes, and the node's permission level
    And every pinned segment has pinned: true and therefore compactable: false

  Scenario: approval and pinning share one transaction
    Then "run.spec.approved" and "spec.pinned" carry adjacent seq values from the same commit
    And no crash point exists between them — a SIGKILL either produces both or neither

  Scenario: the compiler preserves bytes
    When compilePinnedSegments(spec, node) runs
    Then each segment's text is a byte-exact slice of the approved spec's canonical form
    And no reflow, re-wrapping or bullet normalisation was applied
    And the function is pure: a deep-frozen spec, two calls, deeply equal results, no port constructed
```

**Notes:** One transaction, because a run that is approved but not pinned is a run whose first packet
silently omits the spec — and the integrity check cannot fire for a pin that was never minted. The
byte-preservation clause is not pedantry: _"verbatim means identical bytes — the summariser is never
allowed near them"_ ([04 §2](../../04-domain-model.md)).

---

## EPIC-10-S20 — Every node archetype's packet carries the pinned spec first and byte-identical

**Verifies:** KAR-10.4 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Verbatim re-injection into every packet

  Scenario Outline: pinned first, everywhere
    Given the run has an approved spec at specHash H
    When a packet is built for a <archetype> node
    Then the packet's first segments are the pinned ones, in the order
        pinned.spec, pinned.constraints, pinned.pathscope
    And the sha256 of each pinned segment matches the digest recorded in spec.pinned
    And assertPinIntegrity ran after render and passed
    And context.built carries the packet manifest minus segment text

    Examples:
      | archetype |
      | agent     |
      | gate      |
      | human     |
      | recon     |
      | map-child |

  Scenario: pinning is not agent-only
    Then a gate node's packet contains the pinned acceptance criteria
    And a human node's prompt contains the pinned goal and nonGoals

  Scenario: a compaction proves the check ran
    Given a compaction occurs mid-node
    Then context.compacted.pinnedKept equals the pinned digest list from spec.pinned
    And after re-injection the pinned bytes are identical, not paraphrased
```

**Notes:** The `gate` row of the Examples table is the one that carries the anti-drift argument —
_"a review gate whose acceptance criteria were compacted away is a review gate that has silently
become a code-reads-well check"_ ([10 §5.2](../../10-verification-gates.md)). `pinnedKept` is
positive evidence: an absent violation event is not proof that the check ran.

---

## EPIC-10-S21 — Anti-drift: the gate is judged against the pinned spec, not the current code

**Verifies:** KAR-10.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Gates evaluate against the spec, not the current state of the code (F1.5)

  Background:
    Given an approved TaskSpec at specHash H containing
      """
        - id: AC-3
          statement: "All 47 components under packages/ui/src/** compile under Vue 3 with no type errors."
          verifiedBy: [typecheck, build]
      """
    And an implementation node has produced a worktree in which 41 components compile and 6 were
        deleted rather than migrated
    And the worktree's own README now describes the task as "migrate the components worth migrating"

  Scenario: the reviewer judges against the spec it was given, not the story the code tells
    When the adversarial review gate runs
    Then its context packet's pinned.spec segment is byte-identical to the ledger's spec at H
    And no segment in the packet was sourced from the worktree's README
    And the verdict's criteria[] marks AC-3 unsatisfied
    And the verdict carries specHash H

  Scenario: the gate reads the spec from the ledger, never from the node's context
    When the Gate runner loads the criteria
    Then it read them via the ledger at the run's current specHash
    And a test that corrupts the agent-side copy of the spec does not change the verdict's criteria list

  Scenario: passing gates are not evidence that prohibitions were honoured
    Given the spec constrains "must not change the public API of @voyado/ui"
    And the diff changes that public API
    And every deterministic gate passes
    Then the run does not report the constraint as satisfied on the strength of the green gates
    And the constraint is checked explicitly, with its own criterion and its own verdict entry
```

**Notes:** This is the scenario the whole story exists for. Drift _"is subtle because nothing visibly
breaks — the reviewer reads the code, forms a model of what the code is trying to do, and judges the
code against that model. It always passes."_ The third scenario encodes
[08 §4.3](../../08-context-and-memory.md)'s warning about Security-Recall Divergence: a green board
is exactly the signal that stays healthy while prohibitions rot, so it must never be treated as
evidence about them.

---

## EPIC-10-S22 — A verdict carrying a stale `specHash` is void and the gate re-runs

**Verifies:** KAR-10.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: A verdict is scoped to the spec it judged

  Background:
    Given a gate produced a pass verdict for AC-3 at specHash A

  Scenario: the Operator amends the spec mid-run
    When the Operator edits AC-3 and the run's specHash becomes B
    Then the existing verdict's specHash A no longer equals the run's specHash
    And that verdict is void: it is excluded from the acceptance-criteria board
    And the gate node is re-scheduled
    And the board renders AC-3 as "re-running against the amended spec", not as blank and not as green

  Scenario: an unchanged spec does not void anything
    When the Operator re-approves the spec without editing it
    Then specHash is unchanged
    And no verdict is voided and no gate is re-run

  Scenario: the void is recorded
    Then the ledger explains why the gate re-ran, naming the old and new specHash
    And NF10 holds: the board state traces to specific events
```

**Notes:** Mechanism 1 of [10 §5.2](../../10-verification-gates.md)'s four. It has a real cost — a
mid-run edit can discard an hour of gate work — and the correct response is to make that cost
_visible_ rather than to soften the rule by diffing only the changed criteria. The reviewer's
judgement was formed against a different contract; there is no partial validity.

---

## EPIC-10-S23 — A vanished pin fails the node and is never silently retried

**Verifies:** KAR-10.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The pin integrity check (F6.6)

  Scenario: a pinned segment does not survive into the prompt
    Given a test double removes one pinned segment from the rendered prompt after render
    When assertPinIntegrity runs
    Then "pin.integrity_violated" is appended naming the missing digest and its segmentId
    And the node fails with reason 'safety.pin-integrity-violated'
    And the retry count for that node is ZERO — the runner does not retry a pin failure
    And the failure escalates to the Operator

  Scenario: every violating segment is reported
    Given three pinned segments are removed
    Then missingDigests has length 3
    And the event was not truncated to the first violation

  Scenario: the successful case is recorded too
    Given no segment was removed
    Then context.compacted.pinnedKept carries the full digest list on the next compaction
```

**Notes:** _"A pin that vanished is either a bug in the packet builder or an adapter that mangled the
prompt; both need a human"_ ([08 §4.1](../../08-context-and-memory.md)). Silent retry is the
dangerous behaviour here, because the second attempt has an excellent chance of also dropping the
pin and a small chance of dropping a _different_ one.

---

## EPIC-10-S24 — Happy path: recon surveys the repo into typed facts with evidence

**Verifies:** KAR-10.5 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Repository reconnaissance as planner input (F2.2)

  Background:
    Given makeRepo({ files: {
        'package.json': { scripts: { test: 'vitest run', build: 'vite build' } },
        'packages/ui/src/**': 47 Vue SFCs,
        '.DeFlow/gates/typecheck.yaml': a gate definition } })
    And the spec names packages/ui as in scope

  Scenario: the survey lands as facts, not as a report
    When the recon node completes
    Then "fact.written" events exist for
        finding/toolchain, finding/test-command, finding/build-command, scope/touched-paths
    And each fact carries Provenance with byNode, byProvider, byModel, atEvent and confidence
    And each fact carries fromEvidence handles — file://package.json#L4-L7 for the test command
    And scope/touched-paths carries a path set and a file count of 47
    And the facts are readable from the blackboard projection

  Scenario: the facts are what the planner reads
    When the planner packet is assembled
    Then it contains the finding/* and scope/* segments
    And it contains NO history.summary segment sourced from the recon node
```

**Notes:** _"The planner gets the spec, the recon output and the capability list. F6.1 exists so that
the edges in the plan graph mean something"_ ([06 §8](../../06-planning-and-replanning.md)). The file
count on `scope/touched-paths` is not decoration — it becomes the patch policy's
`blastRadiusFiles` input in [EPIC-11](../epics/EPIC-11-dynamic-planning.md), and a missing count
there turns a `> 25` rule into a no-op.

---

## EPIC-10-S25 — A claimed test command that does not exist is `speculative`, not `verified`

**Verifies:** KAR-10.5 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Recon reports what exists, not what is plausible

  Scenario: the model asserts a command the repo does not have
    Given package.json declares no "test:unit" script
    And the mock agent's recon return claims the test command is "pnpm test:unit"
    When the fact is accepted onto the blackboard
    Then its confidence is 'speculative'
    And its fromEvidence is empty or points only at the model's own assertion
    And it is NOT recorded as 'verified'

  Scenario: a command that does exist is verified
    Given package.json declares "test": "vitest run"
    And the recon return claims the test command is "pnpm test"
    Then the fact's confidence is 'verified'
    And fromEvidence points at file://package.json#L4-L4

  Scenario: no manifest at all
    Given a repository with no package.json, no Cargo.toml and no pyproject.toml
    Then facts are written with confidence 'asserted' stating that detection failed
    And no toolchain, test command or build command was fabricated
    And the planner is left to plan a discovery step

  Scenario: the distinction survives into the plan
    Then a gate node whose command came from a 'speculative' fact is flagged in the plan
    And plan validation can treat it as a warning rather than silently trusting it
```

**Notes:** This is the concrete answer to the failure the whole epic is designed against — _"a plan
whose gate node runs `pnpm test:unit` in a repo with no such script fails at node 27 of 40"_.
`confidence` exists exactly so that _"the repo probably uses Pinia"_ and _"`package.json` lists
`pinia@3.0.4`"_ are not indistinguishable to the planner.

---

## EPIC-10-S26 — Recon runs detached, locked and read-only

**Verifies:** KAR-10.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Recon isolation

  Scenario: the worktree is detached and locked at creation
    When the recon node is scheduled
    Then DeFlow ran
        git -C <mainRepo> worktree add --detach --lock --reason "DeFlow run=<runId> node=<nodeId>" <path> <baseRef>
    And git worktree list --porcelain -z reports the worktree as detached and locked
    And --force was never passed to worktree add

  Scenario: a read node needs no branch
    Then no ref named DeFlow/<runId>__<nodeId> was created for the recon node
    And the main working copy was not touched

  Scenario: writes are refused
    When the recon agent calls fs/write_text_file inside its worktree
    Then the call is rejected because the level is 'read'
    And the attempt is recorded

  Scenario: the worktree is removed cleanly afterwards
    When the recon node completes and the worktree is removed
    Then removal succeeded even though the worktree contains a gitignored node_modules/
```

**Notes:** Detached HEAD is not a stylistic choice — git refuses to check the same branch out twice,
which is the _"hard practical lesson"_ [PRD §4.1](../../prd.md) records from the session-manager
category. The `node_modules/` clause encodes a verified result from
[14 §6](../../14-testing-strategy.md): gitignored files do **not** block removal, so nobody should
build a salvage path for them.

---

## EPIC-10-S27 — `.DeFlow/gates/` in the repo is discovered and bindable to a criterion

**Verifies:** KAR-10.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Existing gate definitions feed criteria coverage

  Scenario: a repo that already defines gates
    Given .DeFlow/gates/typecheck.yaml and .DeFlow/gates/visual-regression.yaml exist
    When recon completes
    Then facts name gate ids "typecheck" and "visual-regression" with their file handles
    And a TaskSpec criterion whose verifiedBy names "typecheck" resolves against a real definition

  Scenario: a criterion naming a gate that does not exist
    Given AC-5 declares verifiedBy: [contract-tests]
    And no such gate is defined in the repo and none is planned
    Then plan validation (EPIC-11) reports an uncovered criterion
    And the error names AC-5 and the missing gate id

  Scenario: discovery is read-only cataloguing
    Then no gate was executed during recon
    And no .DeFlow/gates/ file was created, modified or normalised
```

**Notes:** F7.6's full custom-gate execution is P1 and belongs to
[EPIC-12](../epics/EPIC-12-verification-gates.md); this is only the catalogue that lets criteria
coverage bind at plan time. Doing the discovery here is what makes the coverage check in
[KAR-11.2](../epics/EPIC-11-dynamic-planning.md) able to fail _before_ a token is spent rather than
at the first gate node.

---

## EPIC-10-S28 — Recon output is offloaded, never truncated, and never handed on as a transcript

**Verifies:** KAR-10.5 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Bounded returns from a 200-file survey (F6.4, F6.5)

  Scenario: the survey exceeds the return budget
    Given the recon node's returns.maxTokens is 4000
    And the survey would serialise to roughly 11,000 tokens
    Then a "handoff.oversize" event is appended with budget 4000 and the actual count
    And exactly one bounded repair is attempted
    And the full survey is written to the CAS and referenced as artifact://<sha256>
    And the fact bodies in context are summaries plus handles, never truncated JSON

  Scenario: an agent can pull the full survey on demand
    When a downstream node calls the DeFlow_read_artifact MCP tool with that handle
    Then it receives the full survey
    And the call is subject to the node's permission level

  Scenario: the planner never receives the recon transcript
    Then the planner's packet contains facts and handles
    And it contains no agent_message_chunk text and no history.summary from the recon session
```

**Notes:** Offload, don't summarise — handles are lossless and cheap, summaries are lossy and
unauditable. The third scenario restates [06 §8](../../06-planning-and-replanning.md)'s pitfall in
the place it is most tempting to break: the recon transcript is _right there_ and it looks like free
context.

---

## EPIC-10-S29 — A mid-run spec edit re-pins and forces revalidation

**Verifies:** KAR-10.3, KAR-10.4 · **Type:** Recovery · **Automated at:** integration

```gherkin
Feature: Editing the spec mid-run is a first-class operation, not a hack

  Background:
    Given the run is executing at plan version 3 with two nodes completed
    And the current specHash is A

  Scenario: the edit re-pins and revalidates
    When the Operator edits the spec, adding AC-8 "No component may import from packages/legacy."
    Then "spec.amended" is appended with the rfc6902 patch
    And a new "spec.pinned" is appended at specHash B
    And plan revalidation runs against the current PlanGraph
    And every packet built after this point carries the B-hash pinned bytes

  Scenario: revalidation fails
    Given AC-8 is covered by no gate node in the current plan and is not marked unverifiable
    When revalidation runs
    Then it fails with an uncovered-criterion diagnostic naming AC-8
    And the run transitions to needs_human rather than continuing against a spec it no longer satisfies
    And running nodes are not killed — the run stops scheduling new ones

  Scenario: verdicts produced against A are voided
    Then every verdict carrying specHash A is excluded from the acceptance board
    And the affected gates are re-scheduled once the plan satisfies B

  Scenario: the edit does not rewrite history
    Then the pre-edit spec, its pinned digests and the A-hash verdicts all remain in the ledger
    And the plan versions produced under A are unchanged and still addressable by hash
```

**Notes:** [06 §1.3](../../06-planning-and-replanning.md): _"If revalidation fails, the run goes to
`needs_human` rather than continuing against a spec it no longer satisfies."_ The "running nodes are
not killed" clause is a deliberate choice — a spec edit is not a kill switch (F5.7 is), and killing
in-flight work on every edit would make editing feel dangerous, which is the opposite of what F1.3
needs.

---

**Related:** [EPIC-10](../epics/EPIC-10-task-intake.md) · [Board](../board.md) ·
[06-planning-and-replanning.md](../../06-planning-and-replanning.md) ·
[04-domain-model.md](../../04-domain-model.md) ·
[08-context-and-memory.md](../../08-context-and-memory.md) ·
[10-verification-gates.md](../../10-verification-gates.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
