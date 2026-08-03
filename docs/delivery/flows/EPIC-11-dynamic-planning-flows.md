# EPIC-11 flows — Dynamic planning and patch policy

> Behavioural specification for [EPIC-11](../epics/EPIC-11-dynamic-planning.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor                       | Description                                                                                                                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator**                | The engineer driving DeFlow — approves queued patches, receives the run when the policy engine or the circuit breaker hands it back, and is the only proposer the breaker does not block |
| **DeFlowd**                 | The local daemon: orchestrator tick loop, Planner, policy engine, MCP host, Workspace Manager                                                                                            |
| **Planner agent**           | A `DeFlow-mock-agent` subprocess receiving exactly three inputs — the pinned `TaskSpec`, the recon facts, the probed capability list — and returning a `PlanGraph` as structured output  |
| **Proposing node**          | Any node in the run. `agent` nodes propose through the `DeFlow.propose_plan_patch` MCP tool; `scheduler` proposes reroutes; `human` proposes rescues                                     |
| **Policy engine**           | `decidePatch(patch, state)` — a **pure function** in `@DeFlow/core` over the patch's `policy` block and the reduced `RunState`                                                           |
| **Validator**               | `validatePlan(plan, spec, caps)` — pure, returns a `Diagnostic[]`, never throws past `PlanCycleError`                                                                                    |
| **Churn circuit breaker**   | [EPIC-06](../epics/EPIC-06-orchestrator.md)'s detector over a 20-attempt sliding window. This epic **reads** its state; it does not implement it                                         |
| **`provider_capabilities`** | The SQLite table populated by a real ACP `initialize` probe. The 2026-08-02 matrix is a committed **fixture**, never a constant                                                          |
| **Ledger**                  | The file-backed SQLite database — `event`, `plan`, `run`, `node_wake`, `effect`                                                                                                          |
| **Git**                     | The real `git` binary, used here only for `check-ref-format`                                                                                                                             |

## Preconditions common to all flows

```gherkin
Background:
  Given a DeFlow workspace initialised in a git repository on branch "main"
  And an approved TaskSpec exists at specHash H with acceptance criteria AC-1 … AC-n
  And the ledger is a FILE-BACKED SQLite database — ":memory:" only where "Automated at: unit"
      names a pure function or a pure projection
  And DeFlow-mock-agent is on a temp PATH, resolved to an ABSOLUTE path before spawn, and every
      invocation passes --seed
  And provider_capabilities is seeded from the committed 2026-08-02 probe fixture:
      | adapter            | version | session.resume | session.fork | session.list |
      | claude-agent-acp   | 0.64.1  | yes            | yes          | yes          |
      | codex-acp          | 1.1.9   | yes            | no           | yes          |
      | opencode acp       | 1.18.11 | yes            | yes          | yes          |
      | copilot --acp      | 1.0.77  | NO             | no           | yes          |
      | gemini --acp       | 0.53.1  | NO             | no           | NO           |
  And time enters through the injected Clock port — never Date.now() or setTimeout
  And no test calls vi.useFakeTimers() while a mock-agent child process is alive
  And the normalising snapshot serializer is registered, so plan snapshots do not churn on ids,
      hashes, timestamps and absolute paths
  And branch names are FLAT: DeFlow/<runId>__<nodeId>
```

> Three rules bind this whole file. **Capabilities are read from the probed row, never from a
> constant** — every capability assertion names the fixture, not a literal. **Plans are never
> mutated** — every assertion about a new version also asserts the old hash still resolves. And
> **every decision is recorded**, including the ones that stopped something happening: a rejected
> patch with no event is a UI state that cannot be explained.

## Flow index

| Scenario    | Title                                                                                 | Verifies           | Type                  |
| ----------- | ------------------------------------------------------------------------------------- | ------------------ | --------------------- |
| EPIC-11-S1  | Happy path: three inputs compile to `PlanGraph` v1                                    | KAR-11.1           | Happy path            |
| EPIC-11-S2  | The planner sees the spec, the recon facts and the capability list — and nothing else | KAR-11.1           | Edge case             |
| EPIC-11-S3  | A prose plan is refused; there is no extraction fallback                              | KAR-11.1           | Failure               |
| EPIC-11-S4  | `planHash` is canonical, key-order independent, and not `ohash`                       | KAR-11.1           | Edge case             |
| EPIC-11-S5  | A planner failure gets one retry with diagnostics, then a human                       | KAR-11.1           | Failure               |
| EPIC-11-S6  | **An undeclared read fails validation before a token is spent**                       | KAR-11.2           | Failure               |
| EPIC-11-S7  | Cycles, orphan writes and the severity distinction                                    | KAR-11.2           | Edge case             |
| EPIC-11-S8  | **A node scheduled onto an adapter that cannot honour it is refused**                 | KAR-11.2           | Failure (outline)     |
| EPIC-11-S9  | `NO_RESUME` is soft unless the node declares `requiresResume`                         | KAR-11.2           | Edge case             |
| EPIC-11-S10 | Node ids are validated by real git, then by a stricter charset                        | KAR-11.2           | Failure               |
| EPIC-11-S11 | Criteria coverage: an unverified criterion fails the plan                             | KAR-11.2           | Failure               |
| EPIC-11-S12 | Validation runs on every patched plan, not only on v1                                 | KAR-11.2           | Failure               |
| EPIC-11-S13 | Happy path: an agent proposes a patch through the MCP tool                            | KAR-11.3           | Happy path            |
| EPIC-11-S14 | Plans are never mutated; every version stays addressable                              | KAR-11.3           | Edge case             |
| EPIC-11-S15 | Application is atomic with the event append                                           | KAR-11.3           | Recovery (crash-fuzz) |
| EPIC-11-S16 | `PATCH_STALE`: a stale base is rejected and never rebased                             | KAR-11.3           | Failure               |
| EPIC-11-S17 | `split-node` and `abandon-branch` retire ids; nothing is ever renamed                 | KAR-11.3           | Edge case             |
| EPIC-11-S18 | A patch that fails revalidation is rejected whole                                     | KAR-11.3, KAR-11.2 | Failure               |
| EPIC-11-S19 | **Auto-applied: read-only analysis**                                                  | KAR-11.4           | Happy path            |
| EPIC-11-S20 | **Queued for approval: the patch adds write capability**                              | KAR-11.4           | Happy path            |
| EPIC-11-S21 | **Rejected: replan depth exceeded**                                                   | KAR-11.4           | Failure               |
| EPIC-11-S22 | Ordered evaluation, first match wins, and the `default` arm is `approve`              | KAR-11.4           | Edge case             |
| EPIC-11-S23 | **The churn circuit-breaker trip stops replanning rather than causing more of it**    | KAR-11.4           | Failure               |
| EPIC-11-S24 | The policy table is hashed into the run manifest                                      | KAR-11.4           | Edge case             |
| EPIC-11-S25 | Tainted downstream nodes are flagged, never auto-re-run                               | KAR-11.4           | Failure               |
| EPIC-11-S26 | Every version retained, deduplicated and inspectable on disk                          | KAR-11.5           | Happy path            |
| EPIC-11-S27 | The plan diff is field-level, and the reason is verbatim                              | KAR-11.5           | Happy path            |
| EPIC-11-S28 | A rejected patch is still part of the history                                         | KAR-11.5           | Edge case             |
| EPIC-11-S29 | Quota reroute onto a capability superset auto-applies and is visible                  | KAR-11.6           | Happy path            |
| EPIC-11-S30 | A reroute onto a weaker adapter is not equivalent and is not auto                     | KAR-11.6           | Edge case             |
| EPIC-11-S31 | **No healthy provider: suspend on a durable row, never `setTimeout`**                 | KAR-11.6           | Failure (footgun)     |

---

## EPIC-11-S1 — Happy path: three inputs compile to `PlanGraph` v1

**Verifies:** KAR-11.1 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Plan compilation (F2.2)

  Background:
    Given the pinned TaskSpec names packages/ui as in scope with criteria AC-1 … AC-4
    And recon wrote finding/toolchain, finding/test-command and scope/touched-paths (47 files)
    And provider_capabilities holds the 2026-08-02 fixture rows

  Scenario: the planner returns a schema-valid graph
    When the planner node runs
    Then the returned document was read from the result envelope's structured_output field
    And it validates against .DeFlow/schemas/DeFlow.plangraph.v1.json with Ajv
        (strict: true, allErrors: true)
    And every node carries id, type, deps, reads, writes, pathScopes, permission, returns
        { schemaId, maxTokens } and retry.maxAttempts
    And the node types used are drawn from
        agent | tool | gate | human | map | loop | subgraph

  Scenario: the graph is persisted content-addressed and on disk
    Then a row exists in plan(hash, run_id, created_at, doc) whose hash equals
        sha256(canonicalJson(doc))
    And .DeFlow/runs/<runId>/plan/v1.json contains the same document
    And "plan.proposed" { version: 1, planHash, graph, by: 'planner' } was appended in the SAME
        transaction as the plan row insert
    And run.plan_hash points at that hash

  Scenario: the measurement fields are recorded from day one
    Then plan.proposed carries planner.model, planner.effort and planner.tier
    And where the adapter exposes a reasoning-effort control, the initial plan used the strongest
        available setting resolved from the probed row
```

**Notes:** The third scenario is not speculative instrumentation. [06 §6](../../06-planning-and-replanning.md)
is explicit that _"which model plans?"_ is \*_Unverified — a proposal with a measurement plan
attached, not a finding"_, and the plan is to join these fields against the cross-run dashboard's
gate first-pass rate and replans-per-run. Recording them now costs a field; adding them later costs
an upcaster.

---

## EPIC-11-S2 — The planner sees the spec, the recon facts and the capability list — and nothing else

**Verifies:** KAR-11.1 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: No implicit context inheritance for the planner (F6.1)

  Scenario: exactly three input groups
    When the planner's packet is assembled
    Then it contains pinned.spec, pinned.constraints and pinned.pathscope segments first
    And it contains fact segments for the recon findings and scopes
    And it contains one segment carrying the capability list built from provider_capabilities rows
    And it contains NO history.summary segment sourced from the recon session
    And it contains NO agent_message_chunk text from any other node
    And the packet matches __snapshots__/packet-planner.json under the normalising serializer

  Scenario: capabilities come from the table, not from code
    Given the provider_capabilities row for opencode is deleted
    When the planner packet is rebuilt
    Then the capability list no longer mentions opencode
    And a CI grep proves no source file contains a literal capability table keyed by provider name

  Scenario: an unprobed provider is not offered to the planner
    Given a binary is installed but has never been probed
    Then it does not appear in the capability list
    And any plan naming it fails validation with PROVIDER_NOT_PROBED
```

**Notes:** _"Do not let the planner see another node's transcript. It gets the spec, the recon output
and the capability list. F6.1 exists so that the edges in the plan graph mean something"_
([06 §8](../../06-planning-and-replanning.md)). The second scenario is the guard against the most
tempting shortcut in the epic — a constant matrix, which
[06 §2.2](../../06-planning-and-replanning.md) says _"will be wrong within a month"_ and which the
measured 2026-08-02 probe already contradicts in two places.

---

## EPIC-11-S3 — A prose plan is refused; there is no extraction fallback

**Verifies:** KAR-11.1 · **Type:** Failure · **Automated at:** integration

````gherkin
Feature: The plan is data, not prose (F2.1)

  Scenario: markdown with a fenced JSON block
    Given the mock agent returns a markdown explanation containing a ```json fenced PlanGraph
    And structured_output is absent from the result envelope
    When the planner node completes its turn
    Then the node fails with reason 'contract.schema-invalid'
    And no fenced-block extraction, regex or heuristic parse was attempted
    And no plan row was written

  Scenario: valid JSON that is not a valid PlanGraph
    Given structured_output contains valid JSON with an unknown node type "workflow"
    Then Ajv reports the failing instance path
    And the node fails rather than dropping the unknown node

  Scenario: the adapter cannot enforce a schema
    Given the resolved adapter's probed row reports structuredOutput false
    Then the planner node is refused with 'adapter.capability-missing' before it is spawned
    And no tokens were spent
````

**Notes:** _"Do not accept a prose plan. Enforce the schema at the adapter boundary with
`--json-schema` / `--output-schema`. A regex over prose is how the planner layer starts breaking on
every CLI update"_ ([06 §8](../../06-planning-and-replanning.md)). The third scenario keeps the
refusal cheap: the check is on the probed row, so it costs a table read rather than a spawned
process.

---

## EPIC-11-S4 — `planHash` is canonical, key-order independent, and not `ohash`

**Verifies:** KAR-11.1 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: The plan document is content-addressed

  Scenario: key order does not change identity
    Given two structurally identical PlanGraph documents whose JSON key order differs
    When canonicalJson runs over each
    Then both produce identical bytes
    And both hash to the same sha256

  Scenario: insignificant whitespace and undefined do not change identity
    Given one document is pretty-printed and the other minified
    And one carries an explicit undefined-valued optional field
    Then both canonicalise identically

  Scenario: one character changes identity
    When a single node's title gains a trailing space
    Then the hash differs

  Scenario: the hash is computed with node:crypto over an owned encoder
    Then no source file computes planHash with ohash
    And planHash for the committed fixture graph equals the committed golden hex string
```

**Notes:** [06 §2.3](../../06-planning-and-replanning.md): _"Do not use `ohash` for this hash. Its
stable-key-ordering behaviour is confirmed, but its README only promises 'best efforts' at stable
serialisation — acceptable for change detection, not for a value that is a primary key in the `plan`
table and is referenced by `run.plan_hash` across DeFlowd versions."_ `ohash` remains fine for "did
this object change since last render" in the UI.

---

## EPIC-11-S5 — A planner failure gets one retry with diagnostics, then a human

**Verifies:** KAR-11.1 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Validation diagnostics are events, not exceptions (06 §3.5)

  Scenario: the first plan fails validation
    Given the planner's v1 contains a node reading a key nothing writes
    When validation runs
    Then diagnostics are appended as events, not thrown
    And exactly one planner retry is scheduled, whose packet carries the diagnostics verbatim
    And no plan row was persisted for the failing document

  Scenario: the second attempt also fails
    When the retry's plan also fails validation
    Then "run.needs_human" is appended
    And the diagnostics are rendered in the payload for the Operator
    And no third automatic attempt is made

  Scenario: the human supplies a corrected plan
    When the Operator resolves the problem and the run continues
    Then the plan that finally validates is the one persisted as v1
    And the failed attempts remain visible in the ledger
```

**Notes:** _"A failing v1 goes back to the planner once with the diagnostics as input; a second
failure escalates to a `human` node with the diagnostics rendered"_
([06 §3.5](../../06-planning-and-replanning.md)). Two attempts, not three: an unbounded planner
retry loop is the same failure shape the churn breaker exists to stop, arriving earlier.

---

## EPIC-11-S6 — An undeclared read fails validation before a token is spent

**Verifies:** KAR-11.2 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Reachability of declared reads (F6.2, 06 §3.1)

  Scenario: no ancestor writes the key
    Given a plan where "implement" declares reads [{ kind: 'fact', key: 'finding/db-schema' }]
    And no node declares a write matching that key
    And the pinned spec's providedKeys do not include it
    When validatePlan runs
    Then it returns a diagnostic
      """
      { severity: 'error', code: 'READ_UNREACHABLE', node: 'implement', key: 'finding/db-schema',
        message: "node 'implement' reads 'finding/db-schema' but no ancestor writes it and it is
                  not in the pinned spec" }
      """
    And no agent subprocess was spawned — the testkit side-effect log file is empty
    And run.plan_hash was not set

  Scenario: the pinned spec satisfies a spec read with no ancestor
    Given a root node declares reads [{ kind: 'spec', section: 'criteria' }]
    Then validation returns no error for that read
    And the reachable set was seeded from spec.providedKeys
        ('spec/goal', 'spec/ac/AC-3', 'spec/pathscope', …)

  Scenario: all diagnostics are returned, ordered
    Given four nodes each declare one unreachable read
    Then validatePlan returns four diagnostics ordered by node id
    And the output is stable enough to snapshot

  Scenario: a sibling's write is not an ancestor's write
    Given "analyse-a" and "analyse-b" are parallel siblings
    And "analyse-b" reads a key only "analyse-a" writes
    Then a READ_UNREACHABLE diagnostic names "analyse-b"
```

**Notes:** _"An undeclared read is a plan validation failure before a single token is spent. At 40
nodes the transitive closure is free; do not optimise it"_
([06 §3.1](../../06-planning-and-replanning.md)). The empty side-effect log is the observable form of
"before a token is spent" — the fake binaries each append `{runId, nodeId, attempt, idempotencyKey}`
on every invocation, so "nothing ran" is a file assertion rather than an inference.

---

## EPIC-11-S7 — Cycles, orphan writes and the severity distinction

**Verifies:** KAR-11.2 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Two more checks for free from the same walk

  Scenario: a cycle is detected by topoSort throwing
    Given nodes "a" -> "b" -> "c" -> "a"
    When validatePlan runs
    Then topoSort threw PlanCycleError
    And a diagnostic names the nodes on the cycle
    And no second, divergent cycle detector exists in the codebase

  Scenario: an orphan write is a warning, not an error
    Given "recon" writes 'finding/unused' and no node reads it
    Then the diagnostic has severity 'warning'
    And the plan is still runnable
    And the warning survives into the UI, because an orphan write is usually a leftover from a patch

  Scenario: warnings never block, errors always do
    Given a plan with three warnings and no errors
    Then the plan is committed and the run becomes schedulable
    Given a plan with one error and no warnings
    Then no plan row is committed
```

**Notes:** _"Cycle detection. `topoSort` throwing is the check"_ — one implementation, not two, so a
graph that is acyclic for the validator and cyclic for the scheduler cannot exist. The orphan-write
severity is a deliberate product call: _"it is usually a leftover from a patch, occasionally
deliberate."_

---

## EPIC-11-S8 — A node scheduled onto an adapter that cannot honour it is refused

**Verifies:** KAR-11.2 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Adapter capability checks at plan time (F3.5, F5.4)

  Scenario Outline: refuse at plan time, where it costs nothing
    Given the node declares <requirement>
    And the resolved adapter's probed provider_capabilities row says <rowState>
    When validatePlan runs
    Then it emits <code>

    Examples:
      | requirement                              | rowState                                | code                    |
      | provider 'cursor'                        | no row exists                           | PROVIDER_NOT_PROBED     |
      | returns.schemaId set                     | structuredOutput: false                 | NO_STRUCTURED_OUTPUT    |
      | requiresResume: true                     | copilot --acp 1.0.77, session.resume no | NO_RESUME               |
      | permission 'worktree'                    | permissionLevels omits 'worktree'       | PERMISSION_UNSUPPORTED  |
      | estimatePacketTokens = 61% of maxContext | maxContext from the probed row          | PACKET_EXCEEDS_BUDGET   |
      | estimatePacketTokens = 59% of maxContext | maxContext from the probed row          | (no diagnostic)         |

  Scenario: refusing to schedule is the point, not escalating
    Given a node requires permission 'worktree'
    And the adapter cannot express anything above 'read'
    Then the plan is refused with PERMISSION_UNSUPPORTED
    And DeFlow did NOT schedule the node at 'read' and hope
    And DeFlow did NOT silently escalate the adapter to 'full'

  Scenario: the 0.6 ceiling comes from the packet-assembly policy
    Then PACKET_EXCEEDS_BUDGET fires at estimatePacketTokens(node) > caps.maxContext * 0.6
    And the estimate used is the calibrated one, not the raw tokenizer count
```

**Notes:** This is F5.4's _"where a provider cannot express the requested level, DeFlow **refuses to
schedule** rather than silently escalating"_, moved to plan time where it costs nothing
([06 §3.2](../../06-planning-and-replanning.md)). The `copilot --acp` row is not hypothetical: **two
of the five probed adapters cannot resume a session at all**, and Gemini returned no
`sessionCapabilities` key whatsoever. A planner assuming a uniform surface schedules nodes that
cannot run.

---

## EPIC-11-S9 — `NO_RESUME` is soft unless the node declares `requiresResume`

**Verifies:** KAR-11.2 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Resume is an optimisation, never the durability mechanism

  Scenario: a node that merely benefits from resume
    Given the node declares resume: 'native-if-available'
    And the adapter is gemini --acp 0.53.1, which advertises no sessionCapabilities at all
    When validatePlan runs
    Then NO_RESUME is emitted with severity 'warning'
    And the node is annotated to use the ResumeByReplay strategy
    And the plan is runnable

  Scenario: a node that genuinely requires resume
    Given the node declares requiresResume: true
    Then NO_RESUME is emitted with severity 'error'
    And the plan is refused

  Scenario: a capable adapter produces neither
    Given the adapter is claude-agent-acp 0.64.1, whose row advertises session.resume yes
    Then no NO_RESUME diagnostic is emitted for either node
```

**Notes:** _"`NO_RESUME` is a soft error: a node that merely benefits from resume falls back to
replay-from-ledger (the `ResumeByReplay` strategy). It is a hard error only for nodes that declare
`requiresResume`"_ ([06 §3.2](../../06-planning-and-replanning.md)). This is the same claim
[01 §](../../01-architecture-overview.md) makes structurally: _"DeFlow's own ledger is the sole
source of truth for a run, and every prompt must be reconstructible from it alone."_

---

## EPIC-11-S10 — Node ids are validated by real git, then by a stricter charset

**Verifies:** KAR-11.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Identifier validation (06 §3.3, D13)

  Background:
    Given a real git repository with GIT_CONFIG_GLOBAL=/dev/null and forced identity env

  Scenario: git is the authority on ref names
    When the validator checks node id "impl-checkout" for run "r1"
    Then it ran: git check-ref-format "refs/heads/DeFlow/r1__impl-checkout"
    And the exit code was 0
    And git's own rules were not reimplemented in TypeScript

  Scenario Outline: ids that cannot become refs, directories or URL segments
    When the validator checks node id "<id>"
    Then it is rejected, naming <why>

    Examples:
      | id                    | why                                   |
      | impl:checkout         | git check-ref-format non-zero          |
      | impl checkout         | git check-ref-format non-zero          |
      | Impl-Checkout         | DeFlow charset /^[a-z0-9][a-z0-9._-]{0,62}$/ |
      | -impl                 | DeFlow charset (leading separator)     |
      | <a 70-character id>   | DeFlow charset (length)                |

  Scenario: duplicates are rejected case-insensitively
    Given a plan containing node ids "recon" and "Recon"
    Then validation emits a duplicate diagnostic
    And the reason names case-insensitive filesystems, since the id is also a directory name

  Scenario: the PRD's nested branch scheme stays dead
    Given a plan whose branch names would be DeFlow/<runId>/<nodeId>
    And the run also needs a run-level integration branch DeFlow/<runId>
    Then the scheme is refused
    And the reason states that git refs are files in a directory tree, so DeFlow/r1 cannot be both
        a file and a directory
```

**Notes:** [06 §3.3](../../06-planning-and-replanning.md) and D13. _"This catches the entire class of
'the run died at node 31 because the id had a colon in it' three seconds after the planner
returns."_ The last scenario is a permanent regression test — the PRD's `DeFlow/<run-id>/<node-id>`
scheme is a **verified bug** and it is exactly the kind of thing that gets reintroduced by someone
tidying up branch names.

---

## EPIC-11-S11 — Criteria coverage: an unverified criterion fails the plan

**Verifies:** KAR-11.2 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Every acceptance criterion reaches a gate (F7.4, 06 §3.4)

  Scenario: a criterion no gate node covers
    Given the pinned spec contains AC-5 "No component may import from packages/legacy."
    And AC-5 is not marked unverifiable
    And no gate node in the plan names AC-5 in its criteria list
    When validatePlan runs
    Then it emits a coverage error naming AC-5
    And the plan is refused

  Scenario: a gate node covering it fixes the plan
    Given a gate node "gate-import-rules" declares criteria [AC-5]
    Then validation passes

  Scenario: unverifiable criteria are covered by a human node
    Given AC-9 is marked unverifiable with a reason and verifiedBy [human-review-ui]
    And the plan contains a human node "human-review-ui"
    Then validation passes
    And the F10.8 board will render AC-9 in the unverifiable state, not as satisfied

  Scenario: coverage is checked against the plan, not only against the spec
    Given the spec's AC-5 names gate id "import-rules"
    And the plan contains no node implementing that gate
    Then validation still fails — naming a gate in the spec is not the same as planning one
```

**Notes:** The last scenario is the one that distinguishes this check from
[EPIC-10](../epics/EPIC-10-task-intake.md)'s. EPIC-10 forces the _spec author_ to name a gate;
EPIC-11 forces the _plan_ to contain one. _"A criterion nothing checks is a lie on the acceptance
board"_ ([06 §3.4](../../06-planning-and-replanning.md)).

---

## EPIC-11-S12 — Validation runs on every patched plan, not only on v1

**Verifies:** KAR-11.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The patch that bites is the one at node 27 of 40

  Background:
    Given the run is executing plan v3 with 26 of 40 nodes completed

  Scenario: a patch introduces an unreachable read
    When a node proposes an insert-nodes patch whose new node reads 'finding/db-schema'
    And no ancestor in the patched graph writes that key
    Then revalidation emits READ_UNREACHABLE before the transaction commits
    And "plan.patch.rejected" is appended carrying the code
    And run.plan_hash still points at v3
    And no plan row for v4 exists

  Scenario: there is exactly one entry point to plan persistence
    Then a CI assertion proves no code path inserts into plan without having produced a
        Diagnostic[] first
    And the assertion covers both the plan.proposed path and the plan.patched path

  Scenario: a patch that passes revalidation commits
    When the same patch is corrected to read a key its new ancestor writes
    Then v4 is committed and run.plan_hash advances
```

**Notes:** _"Do not skip validation on patched plans. v1 validation is the obvious case; the patch
that adds a node reading a key nothing writes is the one that actually bites, because it happens at
node 27 of 40"_ ([06 §8](../../06-planning-and-replanning.md)). The structural assertion in the
second scenario is what keeps this true after six months of edits, when someone adds a "quick" second
write path.

---

## EPIC-11-S13 — Happy path: an agent proposes a patch through the MCP tool

**Verifies:** KAR-11.3 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Runtime plan mutation (F2.4)

  Background:
    Given DeFlow's stdio MCP server is injected into the agent session via session/new's mcpServers
    And it exposes the tool DeFlow.propose_plan_patch

  Scenario: a recon node proposes three read-only analysis nodes
    When the agent calls DeFlow.propose_plan_patch with an insert-nodes patch carrying
        reason "recon found @acme/ui, @acme/forms and @acme/charts also import the v2 API"
    Then the input is validated against DeFlow.planpatch.v1 at the tool boundary
    And "plan.patch.proposed" { patch } is appended
    And the policy engine is invoked with the patch and the reduced RunState
    And on an auto decision, "plan.patched" { version, fromHash, toHash, patchId, decision }
        is appended

  Scenario: a malformed proposal fails at the tool boundary
    When the agent calls the tool with ops missing their edges
    Then the MCP tool returns a schema error the agent can act on
    And no plan.patch.proposed event carrying an invalid body was appended
    And the policy engine was never reached

  Scenario: every op kind round-trips
    Then insert-nodes, split-node, replace-provider, extend-loop and abandon-branch each apply
        to a base graph and match their golden-file snapshot

  Scenario: reason is required
    When a patch is proposed with reason ""
    Then it fails schema validation
    And the reason is stored verbatim when valid, never summarised anywhere in the pipeline
```

**Notes:** _"The tool takes the patch as structured input validated against the same schema, so a
malformed proposal fails at the tool boundary rather than in the policy engine"_
([06 §4.1](../../06-planning-and-replanning.md)). The verbatim `reason` is load-bearing for F10.2:
_"why is there a step here that I didn't ask for?"_ must be answerable in one click, and the answer
is the sentence the proposer wrote.

---

## EPIC-11-S14 — Plans are never mutated; every version stays addressable

**Verifies:** KAR-11.3 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Immutable, content-addressed plan documents

  Scenario: a patch produces a new row
    Given run.plan_hash is H3
    When a patch is applied
    Then a NEW row exists in plan with hash H4
    And the row with hash H3 is unchanged, byte-for-byte
    And run.plan_hash is now H4
    And SELECT doc FROM plan WHERE hash = H3 still returns the exact document that ran

  Scenario: nothing updates or deletes a plan row
    Then a CI assertion proves the only statements issued against the plan table are
        INSERT and SELECT

  Scenario: the old version renders
    When the scrubber requests v3
    Then it receives the byte-identical document, not a reconstruction
```

**Notes:** _"Do not mutate a plan row in place. Ever. The scrubber, replay, and every 'why' question
depend on old versions being byte-identical to what actually ran"_
([06 §8](../../06-planning-and-replanning.md)). This is also why the storage argument is stated
explicitly in the architecture — so nobody optimises the thing that makes the marquee feature
possible.

---

## EPIC-11-S15 — Application is atomic with the event append

**Verifies:** KAR-11.3 · **Type:** Recovery · **Automated at:** crash-fuzz

```gherkin
Feature: A crash mid-apply never leaves a torn state

  Background:
    Given the ledger is a real file with journal_mode = WAL and synchronous = NORMAL
    And the crash-fuzz harness includes a kill point inside patch application

  Scenario: kill -9 during patch application
    When DeFlowd is killed with SIGKILL at a random point inside the apply transaction
    And a fresh engine is constructed over the SAME database file
    Then PRAGMA integrity_check returns 'ok'
    And the ledger holds EITHER the old plan and no plan.patched event
        OR the new plan row, the updated run.plan_hash and the plan.patched event
    And never a new plan row without its event, or an event without its row
    And no effect was executed twice, checked against the effect journal and the fake agents'
        own side-effect log

  Scenario: the transaction is genuinely one transaction
    Then INSERT INTO plan, UPDATE run SET plan_hash and INSERT INTO event happen inside a single
        BEGIN IMMEDIATE … COMMIT
    And a test that forces a failure between the second and third statement rolls back all three

  Scenario: the sequence number burned by the rollback is not reused
    Given a rolled-back transaction burned seq N
    Then the next successful append receives a seq strictly greater than N
    And consumers resume from "strictly greater than n", never "expect n+1"
```

**Notes:** The third scenario connects to a **verified** measurement in
[04 §1.2](../../04-domain-model.md): with a plain `INTEGER PRIMARY KEY` the sequence number is
_reused_ after a delete, which silently corrupts every persisted SSE cursor. `AUTOINCREMENT` is
mandatory, and the streaming contract is always _"resume from strictly greater than `n`"_.

---

## EPIC-11-S16 — `PATCH_STALE`: a stale base is rejected and never rebased

**Verifies:** KAR-11.3 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Optimistic concurrency on basePlanHash

  Scenario: another patch landed first
    Given a node derived a patch against basePlanHash H3
    And another patch has since advanced run.plan_hash to H4
    When the stale patch is submitted
    Then it is rejected with PATCH_STALE
    And the rejection tells the proposer the current hash H4
    And NO automatic rebase was attempted
    And run.plan_hash is still H4

  Scenario: two map children propose in the same tick
    Given two map children each propose a patch against H3, applied concurrently
        under pool: 'forks'
    Then exactly one plan.patched event exists
    And exactly one PATCH_STALE rejection exists
    And no merged graph was produced

  Scenario: the proposer may re-derive
    When the rejected proposer re-reads the graph at H4 and proposes again
    Then the new proposal is evaluated normally
```

**Notes:** _"Do not attempt automatic rebasing — the proposer had a reason based on a graph that no
longer exists"_ ([06 §4.2](../../06-planning-and-replanning.md)). A rebase would silently apply that
reason to a graph it was never about, which is a much more expensive failure than asking the proposer
to look again.

---

## EPIC-11-S17 — `split-node` and `abandon-branch` retire ids; nothing is ever renamed

**Verifies:** KAR-11.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: The stable-NodeId invariant (04 §1.1)

  Scenario: a patch may change anything except an id
    When a patch changes a node's provider, brief, permission, budget, retry policy and
        declared reads/writes
    Then all of those apply and the node keeps its id
    When a patch attempts to change a node's id
    Then it is rejected before the policy engine sees it

  Scenario: split retires rather than deletes
    Given "impl-checkout" is split into "impl-checkout-cart" and "impl-checkout-payment"
    Then "impl-checkout" remains in the graph with lifecycle 'superseded'
    And each successor carries derivedFrom ["impl-checkout"]
    And the retired id is never allocated again, including after a later replan

  Scenario: abandon marks rather than removes
    When a branch is abandoned with cascade true
    Then the root and its descendants carry lifecycle 'abandoned'
    And they remain renderable in the scrubber

  Scenario: identity across versions is NodeId and nothing else
    Given a node whose provider changed between v3 and v4
    Then the diff reports it as changed, not as removed plus added
```

**Notes:** Two subsystems break silently if ids move: the effect journal's idempotency key
`(runId, nodeId, attempt, ordinal)` — _"if a node's id changes between the `pending` effect row being
written and the daemon restarting, the memoised result is orphaned and the side effect runs twice.
There is no way to detect this after the fact"_ — and the scrubber, where _"a renamed node renders as
a delete plus an insert, which is exactly the wrong story to tell about a plan that was merely
edited."_

---

## EPIC-11-S18 — A patch that fails revalidation is rejected whole

**Verifies:** KAR-11.3, KAR-11.2 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: A failing patch is never partially applied

  Scenario: three ops, one of which breaks the plan
    Given a patch carrying insert-nodes, extend-loop and replace-provider
    And the inserted node reads a key no ancestor writes
    When the patch is evaluated and applied
    Then revalidation fails before the transaction commits
    And NONE of the three ops is present in any committed plan
    And run.plan_hash is unchanged
    And "plan.patch.rejected" carries the diagnostic code and the patch id

  Scenario: the policy engine approved it and validation still refuses
    Given the policy engine returned 'auto' for the patch
    Then validation still runs and still refuses
    And the policy decision does not override structural correctness

  Scenario: the rejection is visible
    Then the approval queue shows the rejected patch, its reason and the diagnostic
    And the Operator can correct and resubmit it
```

**Notes:** _"A failing **patch** is rejected outright — never partially applied"_
([06 §3.5](../../06-planning-and-replanning.md)). The second scenario matters because the two checks
answer different questions: the policy engine asks _should we?_ and the validator asks _can we?_, and
a `yes` to the first can never substitute for the second.

---

## EPIC-11-S19 — Auto-applied: read-only analysis

**Verifies:** KAR-11.4 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: The patch policy engine, auto path (F2.5)

  Background:
    Given the default policy.patch rule table is in effect
    And the run's elapsed budget fraction is 0.12
    And the churn circuit breaker is not tripped

  Scenario: recon discovers three more packages
    Given a read-permission recon node proposes insert-nodes of three read-only analysis nodes
    And the patch's policy block is
      """
      { estimatedCostDeltaUsd: 0.40, blastRadius: { paths: [], nodeCount: 3 },
        replanDepth: 1, escalatesPermission: null, addsWriteCapability: false }
      """
    When decidePatch runs
    Then no earlier rule matched: not escalates-permission, not touches-execution-boundary,
        not replan-depth-exceeded (1 <= 3), not budget-exhausted (0.12 < 1.0),
        not expensive (0.40 <= 5.00), not wide-blast-radius (0 <= 25)
    And the decision is { decision: 'auto', ruleId: 'read-only-analysis' }

  Scenario: the ledger explains the change
    Then "plan.patched" is appended with decision 'auto'
    And the reason is stored verbatim:
        "recon found @acme/ui, @acme/forms and @acme/charts also import the v2 API"
    And the scrubber shows three new nodes appearing at v2 with that sentence attached

  Scenario: the boundaries are exclusive at the stated thresholds
    Given costUsdDelta is exactly 5.00
    Then read-only-analysis still matches, because expensive fires on '> 5.00'
    Given costUsdDelta is 5.01
    Then expensive matches first and the decision is 'approve'
```

**Notes:** The worked example from [06 §4.3](../../06-planning-and-replanning.md), used verbatim so
the test and the architecture cannot drift apart. The third scenario pins the boundary conditions,
which is where a rule table quietly changes meaning: `> 5.00` and `>= 5.00` differ by exactly one
common case.

---

## EPIC-11-S20 — Queued for approval: the patch adds write capability

**Verifies:** KAR-11.4 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: The patch policy engine, approval path

  Background:
    Given the run's ambient permission is 'read'
    And other branches of the plan are currently runnable

  Scenario: an adversarial review demands a codemod
    Given a review gate proposes insert-nodes of one agent write node at 'worktree' permission
        over packages/ui/** (140 files) plus a follow-up gate
    And the policy block is
      """
      { estimatedCostDeltaUsd: 6.20, blastRadius: { paths: ['packages/ui/**'], nodeCount: 2 },
        replanDepth: 2, escalatesPermission: { from: 'read', to: 'worktree' },
        addsWriteCapability: true }
      """
    When decidePatch runs
    Then the FIRST rule matches: escalates-permission
    And the decision is { decision: 'approve', ruleId: 'escalates-permission' }
    And the later rules expensive (6.20 > 5.00) and wide-blast-radius (140 > 25) were never
        evaluated

  Scenario: the queue entry is actionable
    Then the approval queue entry carries the estimate, the plan-graph diff and the review findings
        that motivated it

  Scenario: the patch is pending, not the run
    Then nodes on unrelated branches continue to be scheduled
    And the run does not transition to needs_human
    And no worktree was created for the proposed write node

  Scenario: the Operator approves
    When the Operator approves the queued patch
    Then plan.patched is appended with decision 'approved' and by 'human'
    And revalidation ran before the commit
```

**Notes:** _"The run does not stall on it if other branches are runnable — the patch is pending, not
the run"_ ([06 §4.3](../../06-planning-and-replanning.md)). Ordering matters here as much as the
outcome: asserting `ruleId: 'escalates-permission'` rather than merely `decision: 'approve'` is what
catches a rule table that has been reordered or evaluated as a set.

---

## EPIC-11-S21 — Rejected: replan depth exceeded

**Verifies:** KAR-11.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: The patch policy engine, rejection path

  Background:
    Given a bug-hunt loop has already replanned three times

  Scenario: the fourth replan is refused
    Given the loop proposes extend-loop plus insert-nodes of two more hypothesis nodes
    And the policy block carries replanDepth: 4
    When decidePatch runs
    Then the decision is { decision: 'reject', ruleId: 'replan-depth-exceeded' }
    And "plan.patched" is appended with decision 'rejected', the verbatim reason and the ruleId
    And the run transitions to needs_human

  Scenario: a rejection is "not without you", not a dead end
    Then the approval queue shows the rejected patch
    And the Operator may approve it explicitly
    When the Operator approves it
    Then it is applied, revalidated and recorded with by 'human'

  Scenario: the budget rule rejects too
    Given elapsedBudgetFraction is 1.0
    Then budget-exhausted matches and the decision is reject
    And this fires before expensive, so a cheap patch on an exhausted run is still rejected

  Scenario: nothing is silent
    Then no patch anywhere in this scenario was dropped without an event
    And NF10 holds: every UI state traces to a specific ledger event
```

**Notes:** _"Do not let a rejected patch be silent. No event means no UI, and 'the run silently
decided not to do the thing it decided to do' is unanswerable"_
([06 §8](../../06-planning-and-replanning.md)). The second scenario is the humane part of the design
— a depth-4 replan is refused _by policy_, not forbidden, and the human override is the escape hatch
that keeps the rule from being a wall.

---

## EPIC-11-S22 — Ordered evaluation, first match wins, and the `default` arm is `approve`

**Verifies:** KAR-11.4 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: The rule table is ordered, declarative and closed

  Scenario: a patch matching several rules reports the first
    Given a patch that satisfies escalates-permission, expensive AND wide-blast-radius
    Then the decision's ruleId is 'escalates-permission'
    And a test that shuffles the rule order changes the reported ruleId, proving order is honoured

  Scenario: an unrecognised patch goes to a human
    Given a patch matching none of the seven substantive rules
    Then the decision is { decision: 'approve', ruleId: 'default' }
    And it is NOT auto-applied

  Scenario: touching the execution boundary always asks
    Given a patch with touchesExecutionBoundary true, costUsdDelta 0.10 and blastRadiusFiles 0
    Then the decision is approve via touches-execution-boundary
    And cheapness did not buy it an auto

  Scenario: decidePatch is pure
    Given deep-frozen inputs
    When decidePatch is called twice
    Then both calls return deeply equal decisions
    And no Clock, Db or filesystem port was constructed
    And the function read nothing from disk
```

**Notes:** _"The default arm is `approve`, not `auto`. Anything the rules do not recognise goes to a
human"_ ([06 §4.3](../../06-planning-and-replanning.md)). The execution-boundary scenario encodes
F5.6 and, behind it, the Kiro/AWS incident from [PRD §4.5](../../prd.md): approved specs and reviewed
designs did not prevent an agent from deleting a production environment, _"because nothing reviewed
the moment of action."_

---

## EPIC-11-S23 — The churn circuit-breaker trip stops replanning rather than causing more of it

**Verifies:** KAR-11.4 · **Type:** Failure · **Automated at:** unit + integration

```gherkin
Feature: Interaction with no-progress detection (F4.7, 06 §7)

  Background:
    Given the churn circuit breaker has tripped because the count of completed nodes did not
        increase across 3 consecutive planner replans
    And the run has transitioned to needs_human with reason 'churn'

  Scenario: a patch that would otherwise auto-apply is rejected
    Given a read-permission node proposes insert-nodes of read-only analysis nodes
    And its policy block is { estimatedCostDeltaUsd: 0.40, blastRadius: { paths: [], nodeCount: 3 },
        replanDepth: 1, escalatesPermission: null, addsWriteCapability: false }
    And that patch WOULD match read-only-analysis with the breaker clear
    When decidePatch runs
    Then the decision is { decision: 'reject', ruleId: 'circuit-breaker-tripped' }
    And evaluateRules was never reached — the short-circuit precedes it

  Scenario Outline: every non-human proposer is short-circuited
    Given a patch proposed by <proposer>
    Then the decision is <decision> with ruleId <ruleId>

    Examples:
      | proposer   | decision | ruleId                   |
      | a NodeId   | reject   | circuit-breaker-tripped   |
      | 'planner'  | reject   | circuit-breaker-tripped   |
      | 'scheduler'| reject   | circuit-breaker-tripped   |
      | 'human'    | (evaluated normally against the rule table)         |

  Scenario: the human patch is how the run is rescued, and it resets the breaker
    When the Operator proposes a patch that supplies the missing premise
    Then it is evaluated against the ordinary rule table
    And on application the circuit breaker is reset
    And the sliding window is cleared, because a human-supplied insight invalidates it

  Scenario: the run does not replan its way out
    Given the breaker is tripped
    When the tick loop runs for 30 simulated minutes
    Then zero patches were auto-applied
    And zero additional planner invocations were spawned — the side-effect log is unchanged
    And the run is still needs_human, waiting

  Scenario: the trip itself is recorded
    Then "run.needs_human" { reason: 'churn' } exists with the detector's detail
    And each rejected patch has its own plan.patched with decision 'rejected'
```

**Notes:** [06 §7](../../06-planning-and-replanning.md) calls this _"the sharpest edge in the whole
design, and getting it backwards is expensive"_. The failure it prevents is intuitive to build and
wrong: _"a churning run's instinct is to replan. That is exactly the behaviour to stop. Three
consecutive replans with no completed nodes is not a plan that needs a fourth revision; it is a plan
built on a false premise, and the only thing that can supply the missing premise is the person who
wrote the spec."_ The first scenario's second Then clause — that `evaluateRules` was never reached —
is the one that catches the natural mis-ordering, because a system that checks the rules first and
the breaker second will happily auto-apply analysis patches during a trip and still pass a test that
only asserts the final decision on a _rejected-anyway_ patch.

---

## EPIC-11-S24 — The policy table is hashed into the run manifest

**Verifies:** KAR-11.4 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: Mid-run config edits do not silently change the rules

  Scenario: the table is pinned at run start
    Given .DeFlow/config.yaml declares policy.patch with the default rules
    When the run starts
    Then the sha256 of the canonicalised rule table is recorded in the run manifest

  Scenario: editing the config mid-run
    When the Operator edits policy.patch to raise the cost threshold to 50.00
    And a patch with costUsdDelta 6.20 is proposed in the same run
    Then the decision is computed against the MANIFEST-hashed table, not the file on disk
    And the mismatch is surfaced to the Operator rather than silently ignored

  Scenario: a new run picks up the edit
    When a second run is started
    Then its manifest records the new hash and its patches are judged by the new thresholds

  Scenario: a missing policy.patch block uses the documented defaults
    Given .DeFlow/config.yaml has no policy.patch key
    Then the eight default rules are in effect and their hash is recorded
```

**Notes:** _"Lives in `.DeFlow/config.yaml` under `policy.patch` and is hashed into the run manifest
so mid-run edits do not silently change the rules"_
([06 §4.3](../../06-planning-and-replanning.md)). Surfacing the mismatch rather than ignoring it
matters: an operator who edits the config expecting it to take effect and gets no signal will assume
the engine is broken.

---

## EPIC-11-S25 — Tainted downstream nodes are flagged, never auto-re-run

**Verifies:** KAR-11.4 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: fact.invalidated routes through the policy engine, not around it

  Background:
    Given node "analyse" wrote fact/finding-auth-uses-jwt at seq 400
    And nodes "impl-a" and "impl-b" each read it at seq 420 and seq 455

  Scenario: invalidation taints earlier readers
    When "gate-security" appends fact.invalidated for that fact at seq 900
    Then "impl-a" and "impl-b" are marked taint: 'stale-input'
    And they are surfaced in the approval queue

  Scenario: nothing re-runs on its own
    When the tick loop advances
    Then neither tainted node was re-scheduled automatically
    And no patch was auto-proposed to re-run them

  Scenario: a later reader is not tainted
    Given "impl-c" reads the fact at seq 950, after the invalidation
    Then "impl-c" is not tainted

  Scenario: the human or the policy engine decides
    When a patch proposing to re-run the tainted nodes is submitted
    Then it goes through decidePatch like any other patch
```

**Notes:** _"Do not auto-re-run them. Flag them, surface them in the approval queue, and let the patch
policy engine decide. Automatic re-running on invalidation is a very efficient way to build a loop
that never terminates"_ ([06 §7](../../06-planning-and-replanning.md), and
[04 §5.2](../../04-domain-model.md)). It pairs with S23: both are cases where the reflexive automated
response is the one that burns the budget.

---

## EPIC-11-S26 — Every version retained, deduplicated and inspectable on disk

**Verifies:** KAR-11.5 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Plan version retention (F2.6, NF8)

  Scenario: three patches produce four versions
    When three patches are applied to a 40-node plan
    Then the plan table holds four rows
    And .DeFlow/runs/<runId>/plan/ holds v1.json, v2.json, v3.json and v4.json
    And each file is the byte-identical document of its row

  Scenario: content addressing deduplicates for free
    Given a patch produces a document byte-identical to an earlier version
    Then no duplicate row is created
    And both versions resolve to the same hash

  Scenario: the storage argument holds
    Given a pathological run with twelve plan versions of roughly 30 KB each
    Then total plan storage on disk is under 512 KB
    And nothing prunes, compacts or garbage-collects it

  Scenario: no pruning path exists
    Then a CI assertion proves no DELETE FROM plan statement exists in the codebase
```

**Notes:** The storage numbers are stated in [06 §5](../../06-planning-and-replanning.md)
specifically _"so nobody is tempted to prune"_ — a 40-node plan is ~30 KB, a target 1–4-replan run is
under 200 KB, and a 12-version run is under half a megabyte. Retention is not a nice-to-have: it is
what makes F10.2 possible at all.

---

## EPIC-11-S27 — The plan diff is field-level, and the reason is verbatim

**Verifies:** KAR-11.5 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: GET /api/runs/:id/plans/diff (the scrubber's server-side contract)

  Scenario: a provider change is a field-level patch, not a remove plus add
    Given v3 → v4 replaced node "n_impl_3"'s provider with codex
    When GET /api/runs/:id/plans/diff?from=3&to=4 is called
    Then the response contains
      """
      { "from": 3, "to": 4,
        "nodes": { "added": [], "removed": [],
                   "changed": [{ "id": "n_impl_3",
                                 "patch": [{ "op": "replace", "path": "/provider",
                                             "value": "codex" }] }],
                   "unchanged": ["n_spec", "n_recon", "n_impl_1", "n_impl_2"] },
        "edges": { "added": [], "removed": [] },
        "unionLayoutKey": "<runId>:union:v3-v4",
        "reason": "Anthropic rate limit hit; re-routing implementation node to Codex",
        "decision": "auto" }
      """
    And the patch array is RFC 6902, produced with rfc6902@5.3.0

  Scenario: the reason is byte-identical to the event
    Given the plan.patched reason contains a newline and a double quote
    Then the API returns those bytes unchanged
    And nothing truncated, summarised or re-cased it

  Scenario: unionLayoutKey is a cache key, not coordinates
    Then the response carries no x/y values
    And the client computes the union layout once and caches it under that key

  Scenario: an inserted node appears as added, with its edges
    Given v1 → v2 inserted "n_probe_deps" downstream of "n_recon"
    Then nodes.added contains "n_probe_deps"
    And edges.added contains "n_recon->n_probe_deps"
```

**Notes:** `rfc6902@5.3.0` — **not** `fast-json-patch`, which last shipped in 2022
([11 §7.4](../../11-api-and-realtime.md)). The `unionLayoutKey` clause exists because
[06 §5](../../06-planning-and-replanning.md) records that the elkjs `layerChoiceConstraint` /
`positionChoiceConstraint` recipe _"does **not** work as commonly written"_, so the load-bearing
design is _"lay the union graph out once, then per version show, hide and restyle nodes against the
fixed coordinates"_ — which needs a stable key from the server and nothing else.

---

## EPIC-11-S28 — A rejected patch is still part of the history

**Verifies:** KAR-11.5 · **Type:** Edge case · **Automated at:** integration

```gherkin
Feature: The history explains what did NOT happen

  Scenario: a rejection produces no version but a full record
    Given a patch was rejected with ruleId 'replan-depth-exceeded'
    Then no new plan row and no new vN.json exist
    And "plan.patch.proposed" carries the full proposal
    And "plan.patch.rejected" carries the patchId, the rule and by 'policy'

  Scenario: the full "why" is answerable
    When the Operator asks why a step is or is not in the plan
    Then the ledger yields: who proposed it, the verbatim reason, the estimate, which policy rule
        fired, and whether a human approved it

  Scenario: the scrubber can show a rejected proposal alongside the version that ran
    Then the rejected patch is addressable by patchId
    And its ops can be rendered against the base plan without being applied
```

**Notes:** [06 §5](../../06-planning-and-replanning.md) states the full answer explicitly: _"who
proposed it, why, what the estimate was, which policy rule fired, and whether a human approved
it."_ The third scenario is what turns _"the run wanted to do X and was not allowed to"_ from a log
line into a view.

---

## EPIC-11-S29 — Quota reroute onto a capability superset auto-applies and is visible

**Verifies:** KAR-11.6 · **Type:** Happy path · **Automated at:** integration

```gherkin
Feature: Provider re-routing recorded as a patch (F3.9, NF7)

  Background:
    Given node "impl-checkout" is running on claude-code
    And codex-acp 1.1.9's probed row covers every AdapterRequirement the node declares
    And the node's permission level is unchanged by the reroute

  Scenario: the rate-limit frame drives the proposal
    When the adapter emits {"type":"rate_limit_event","rate_limit_info":{ … "resetsAt": <t> }}
    Then "provider.rate_limited" { provider, resetsAt, raw } is appended
    And the scheduler proposes a replace-provider patch with proposedBy 'scheduler',
        cause 'quota' and a non-empty reason

  Scenario: the equivalence rule auto-applies it
    When decidePatch runs
    Then the decision is { decision: 'auto', ruleId: 'quota-reroute-equivalent' }
    And capabilitySuperset was computed from the probed rows, not from a constant
    And permissionUnchanged was true

  Scenario: the swap is visible, which is the entire point
    Then "plan.patched" carries decision 'auto' and the verbatim reason
    And plans/diff reports "impl-checkout" as changed with a /provider replace patch
    And the scrubber renders the swap as a version, not as an invisible scheduler decision

  Scenario: the scheduler never swaps silently
    Then no code path changes a node's provider without producing a PlanPatch
```

**Notes:** _"The scheduler does not silently swap providers… so the swap appears in the visualisation
— which is the entire point of F3.9's wording"_
([06 §4.4](../../06-planning-and-replanning.md)). The `rate_limit_event` frame shape is **verified
2026-08-02**, so the parser is tested against a committed fixture rather than an assumed schema.

---

## EPIC-11-S30 — A reroute onto a weaker adapter is not equivalent and is not auto

**Verifies:** KAR-11.6 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: capabilitySuperset is computed, not assumed

  Scenario Outline: superset or not, from the probed rows
    Given node "impl-checkout" requires <requirement>
    And the reroute target is <target>
    Then capabilitySuperset is <superset> and the decision is <decision>

    Examples:
      | requirement          | target             | superset | decision                          |
      | structuredOutput     | codex-acp 1.1.9    | true     | auto (quota-reroute-equivalent)    |
      | session.fork         | codex-acp 1.1.9    | false    | approve (default)                  |
      | resumableSessions    | copilot --acp 1.0.77 | false  | approve (default)                  |
      | session.list         | gemini --acp 0.53.1 | false   | approve (default)                  |

  Scenario: a permission change is never equivalent
    Given the reroute would also raise the node's permission from read to worktree
    Then quota-reroute-equivalent does not match, because permissionUnchanged is false
    And escalates-permission matches first and the decision is approve

  Scenario: the matrix is a fixture, not a constant
    Given the probe fixture is regenerated with codex-acp advertising fork: yes
    Then the first Examples row's session.fork case becomes a superset
    And no source change was required
```

**Notes:** The Examples table is drawn directly from the 2026-08-02 measurement, where `codex-acp`
advertises `fork: no`, `copilot --acp` advertises no resume, and `gemini --acp` advertises no
`session.list` at all. _"A reroute onto a weaker adapter is not equivalent and is not auto"_
([06 §4.4](../../06-planning-and-replanning.md)) — and the last scenario is the proof that the
implementation reads the row rather than the table in this document.

---

## EPIC-11-S31 — No healthy provider: suspend on a durable row, never `setTimeout`

**Verifies:** KAR-11.6 · **Type:** Failure (footgun) · **Automated at:** integration

```gherkin
Feature: NF7 degradation is implemented by a durable wake row

  Background:
    Given every installed provider that satisfies "impl-checkout"'s requirements is rate limited
    And the rate_limit_event carried resetsAt four hours in the future

  Scenario: suspend, do not reroute
    When the scheduler evaluates the node
    Then NO replace-provider patch is proposed
    And a node_wake row is written with wake_at = resetsAt and reason = 'quota'
    And "node.suspended" is appended
    And the run continues scheduling other runnable branches

  Scenario: the timer footgun
    Then no source file uses setTimeout for a quota wait, proven by a CI grep
    Given a wake_at of now + 2**31 + 1000 milliseconds
    When the TestClock is advanced past it
    Then the node wakes at that time
    And it did NOT fire after 1 ms with a TimeoutOverflowWarning

  Scenario: the wait survives everything a timer would not
    When DeFlowd is killed with SIGKILL and restarted over the same directory
    Then the node_wake row is still present with the same wake_at
    And the node still wakes at resetsAt
    Given the laptop sleeps across the wake time
    Then the 1 Hz tick finds wake_at <= now on resume and schedules the node

  Scenario: resumption is recorded
    When the node wakes
    Then it runs on the original provider if that provider is healthy again
    And the suspension and resumption are both visible in the run timeline
```

**Notes:** Three verified facts collide here.
[06 §4.4](../../06-planning-and-replanning.md): _"Never use `setTimeout` for this: Node's maximum
timer delay is `2^31-1 ms`, and passing `2**31` **fires the callback after 1 ms** with only a
`TimeoutOverflowWarning`. **Verified 2026-08-02.** Timers also do not fire during laptop sleep and do
not survive a restart."_ A four-hour quota wait is well inside the 2^31 ms limit, which is exactly
why this bug survives casual testing and detonates on the first genuinely long wait.

---

**Related:** [EPIC-11](../epics/EPIC-11-dynamic-planning.md) · [Board](../board.md) ·
[06-planning-and-replanning.md](../../06-planning-and-replanning.md) ·
[04-domain-model.md](../../04-domain-model.md) ·
[05-durable-execution.md](../../05-durable-execution.md) ·
[11-api-and-realtime.md](../../11-api-and-realtime.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
