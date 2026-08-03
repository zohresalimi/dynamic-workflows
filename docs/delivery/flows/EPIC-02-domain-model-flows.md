# EPIC-02 flows — Domain model and schemas

> Behavioural specification for [EPIC-02](../epics/EPIC-02-domain-model.md) ·
> [Board](../board.md) · [Delivery plan](../README.md)

**Status:** Draft v1.0 · **Last reviewed:** 2 August 2026

## Actors

| Actor | Description |
|---|---|
| **Operator** | The engineer driving Karvan — writes and approves the `TaskSpec`, reads the inspector |
| **Planner** | The agent (or human) that allocates `NodeId`s and emits `PlanGraph` documents and `PlanPatch`es |
| **Scheduler** | The component that reads `NodeFailure.class` and decides retry / fail / suspend |
| **karvand** | The local daemon; here, only as the thing that parses events and may be an older or newer build |
| **Blackboard** | The projection over `fact.*` events; validates a fact's `value` against its `schemaId` |
| **Provider agent** | A vendor CLI subprocess handed an emitted JSON Schema file via `--json-schema` / `--output-schema` |
| **CI** | The `check` job that runs `pnpm schemas:check` and the unit slice |

## Preconditions common to all flows

```gherkin
Background:
  Given the package "@karvan/core" is built with erasableSyntaxOnly: true and ESM only
  And "zod@4.4.3" is the only runtime dependency of @karvan/core
  And the normalising snapshot serialiser from testing-strategy §9 is registered in test/setup.ts
  And every schema in this file is authored as a Zod 4 schema with its TypeScript type derived by z.infer
  And no test in this file opens a database, spawns a process, or reads the wall clock
```

Every scenario here runs in the `unit` project (`environment: node`, default timeout, threads pool)
unless its `Automated at:` line says otherwise. That is deliberate: this whole epic is pure
functions, so it is the cheapest and fastest part of the suite and should stay that way.

## Flow index

| Scenario | Title | Verifies | Type |
|---|---|---|---|
| EPIC-02-S1 | A `NodeId` is accepted or rejected by format | KAR-02.1 | Happy path / edge |
| EPIC-02-S2 | A patch may change anything about a node except its id | KAR-02.1, KAR-02.4 | Failure |
| EPIC-02-S3 | `split-node` retires the id and mints successors | KAR-02.1, KAR-02.4 | Happy path |
| EPIC-02-S4 | Map children keep their ids when the collection is re-derived | KAR-02.1, KAR-02.3 | Edge case |
| EPIC-02-S5 | A `RunId` is a legal path segment and sorts by creation order | KAR-02.1 | Happy path |
| EPIC-02-S6 | Re-approving an unchanged spec does not change its `specHash` | KAR-02.2, KAR-02.9 | Happy path |
| EPIC-02-S7 | A shallow or malformed `TaskSpec` is rejected at the boundary | KAR-02.2 | Failure |
| EPIC-02-S8 | The canonical encoder is invariant to key order and refuses lossy values | KAR-02.9 | Edge case |
| EPIC-02-S9 | A graph with all seven node types parses and snapshots stably | KAR-02.3 | Happy path |
| EPIC-02-S10 | A node missing a `NodeBase` contract field is rejected | KAR-02.3 | Failure |
| EPIC-02-S11 | An undeclared read is caught before a token is spent | KAR-02.3 | Failure |
| EPIC-02-S12 | A patch with an incomplete `policy` block cannot be proposed | KAR-02.4 | Failure |
| EPIC-02-S13 | A rejected patch is still a recorded, well-formed value | KAR-02.4 | Edge case |
| EPIC-02-S14 | A fact's value is validated against its `schemaId` before acceptance | KAR-02.5, KAR-02.8 | Happy path |
| EPIC-02-S15 | An `ext:` fact with no registered schema is refused | KAR-02.5, KAR-02.8 | Failure |
| EPIC-02-S16 | A corrected fact is a new `FactId` that supersedes the old one | KAR-02.5 | Happy path |
| EPIC-02-S17 | A packet's totals and pin digests are self-consistent | KAR-02.6 | Happy path |
| EPIC-02-S18 | Token counts declare their source and are never silently mixed | KAR-02.6, KAR-02.10 | Failure |
| EPIC-02-S19 | An older build meets an event kind it has never heard of | KAR-02.7 | Recovery |
| EPIC-02-S20 | An upcaster chain lifts a v1 payload to v3 at read time | KAR-02.7 | Happy path |
| EPIC-02-S21 | A hole in the upcaster chain fails at build, not at 3am | KAR-02.7 | Failure |
| EPIC-02-S22 | A lossy payload change becomes a new `kind`, not a new `v` | KAR-02.7 | Edge case |
| EPIC-02-S23 | Vendor-internal compaction cannot fabricate an "after" number | KAR-02.7 | Edge case |
| EPIC-02-S24 | An edited Zod schema without re-emission fails CI | KAR-02.8 | Failure |
| EPIC-02-S25 | Every emitted schema compiles under Ajv2020 in strict mode | KAR-02.8 | Happy path |
| EPIC-02-S26 | A vendor CLI consumes an emitted schema file directly | KAR-02.8 | Contract |
| EPIC-02-S27 | A thrown `Error` never reaches the ledger | KAR-02.10 | Failure |
| EPIC-02-S28 | Failure class is assigned at construction, not derived at render | KAR-02.10 | Edge case |

---

## EPIC-02-S1 — A `NodeId` is accepted or rejected by format

**Verifies:** KAR-02.1 · **Type:** Happy path / edge · **Automated at:** unit

```gherkin
Feature: Identifier format rules

  Scenario Outline: NodeId validation
    Given the planner proposes a node id "<id>"
    When NodeIdSchema.safeParse("<id>") is called
    Then the result's success is <ok>
    And when it fails the issue path is [] and the message names the pattern "^[a-z0-9][a-z0-9-]{0,62}$"

    Examples:
      | id                                                                  | ok    | why                                  |
      | recon-auth-surface                                                  | true  | the documented example               |
      | a                                                                   | true  | one character, lower bound           |
      | 9-lives                                                             | true  | may start with a digit               |
      | Recon-Auth                                                          | false | uppercase breaks case-insensitive fs |
      | recon_auth                                                          | false | underscore not in the class          |
      | -leading                                                            | false | must start alphanumeric              |
      | recon auth                                                          | false | space is not a path segment          |
      | recon/auth                                                          | false | separator would split the ikey       |
      |                                                                     | false | empty                                |
      | <64 lowercase characters>                                           | false | 63 is the cap                        |
```

**Notes:** The uppercase rejection is not fussiness. Roadmap risk **A5-7** records that git worktree
behaviour on APFS is untested and that a case-insensitive filesystem could collide worktree paths
for node ids differing only in case — `.karvan/wt/<runId>__<nodeId>` is built from this string.
Rejecting uppercase at the schema is the cheapest possible fix and it belongs here, not in the
worktree manager.

---

## EPIC-02-S2 — A patch may change anything about a node except its id

**Verifies:** KAR-02.1, KAR-02.4 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: NodeId stability under runtime plan mutation

  Background:
    Given a PlanGraph v3 containing an agent node "migrate-header-component"
    And an effect row exists with ikey "run_20260802T141133Z_9f2a1c/migrate-header-component/1/0" in state 'pending'

  Scenario: changing the provider keeps the id
    When a PlanPatch with op "replace-provider" for node "migrate-header-component" is validated
    Then patchIsWellFormed returns ok
    And the resulting node's id is still "migrate-header-component"
    And the node's lifecycle is still 'active'

  Scenario: renaming a node is refused
    Given a hand-built patch whose insert-nodes op carries a node with id "migrate-header-cmp"
    And whose intent is to replace "migrate-header-component"
    When patchIsWellFormed is called
    Then it returns an error of kind 'node-id-would-move'
    And the error names both "migrate-header-component" and "migrate-header-cmp"

  Scenario: reusing a retired id is refused
    Given the graph also contains node "recon-auth-surface" with lifecycle 'abandoned'
    When a patch proposes an insert-nodes op containing a node with id "recon-auth-surface"
    Then patchIsWellFormed returns an error of kind 'node-id-reused'
```

**Notes:** The `Background`'s pending effect row is the reason this matters and should be stated in
the test name. Per [04-domain-model §1.1](../../04-domain-model.md), if the id moves between the
`pending` row being written and the daemon restarting, the memoised result is orphaned and the side
effect runs twice — **and there is no way to detect this after the fact.** This scenario is the only
place the system can stop it, so it is a hard error and never a warning.

---

## EPIC-02-S3 — `split-node` retires the id and mints successors

**Verifies:** KAR-02.1, KAR-02.4 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: Structural node operations retire rather than rename

  Scenario: splitting one write node into three
    Given a PlanGraph containing node "migrate-forms" with lifecycle 'active'
    And a PlanPatch with op "split-node" targeting "migrate-forms"
    And the patch's "into" array contains nodes "migrate-forms-a", "migrate-forms-b", "migrate-forms-c"
    When the patch is validated and applied
    Then node "migrate-forms" is still present in the graph
    And its lifecycle is 'superseded'
    And each of the three new nodes carries derivedFrom: ["migrate-forms"]
    And the id registry refuses a later allocation of "migrate-forms"

  Scenario: a split whose successors omit derivedFrom is refused
    Given the same patch with derivedFrom removed from "migrate-forms-b"
    When patchIsWellFormed is called
    Then it returns an error of kind 'split-missing-derived-from' naming "migrate-forms-b"
```

**Notes:** The retained superseded node is what lets the plan-evolution scrubber (F10.2) animate a
split as a split. Delete the node instead and the scrubber renders one delete plus three inserts,
which is exactly the wrong story about a plan that was refined.

---

## EPIC-02-S4 — Map children keep their ids when the collection is re-derived

**Verifies:** KAR-02.1, KAR-02.3 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Deterministic map child identity

  Scenario: value-hash ids survive a re-derived collection
    Given a MapNode "migrate-components" with itemIdFrom 'value-hash'
    And its "over" fact resolves to ["Header.vue", "Footer.vue", "Sidebar.vue"]
    When map children are materialised
    Then the child ids are the set {"migrate-components--<h(Header.vue)>", "migrate-components--<h(Footer.vue)>", "migrate-components--<h(Sidebar.vue)>"}
    When a replan re-derives the collection as ["Sidebar.vue", "Header.vue", "Footer.vue", "Nav.vue"]
    And map children are materialised again
    Then the three original child ids are present and unchanged
    And exactly one new child id has been added for "Nav.vue"

  Scenario: index-derived ids move, which is why they are not the default
    Given the same MapNode with itemIdFrom 'index'
    When the collection is re-derived in the reordered form
    Then the child id "migrate-components--0" now denotes a different item than before
    And this test is annotated as a regression guard documenting why 'value-hash' is the schema default
```

**Notes:** The second scenario deliberately asserts the *bad* behaviour so that nobody "simplifies"
the default. `itemIdFrom` defaults to `'value-hash'` in the Zod schema, so a plan authored without
the field gets the safe path.

---

## EPIC-02-S5 — A `RunId` is a legal path segment and sorts by creation order

**Verifies:** KAR-02.1 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: RunId is a directory name and a sort key

  Scenario: filesystem safety
    Given 100 RunIds are generated
    When each is joined onto a temp directory path
    Then path.basename of the result equals the RunId for all 100
    And none contains "/", ":", "\", or an uppercase letter

  Scenario: lexicographic order matches creation order
    Given a RunId r1 minted at 2026-08-02T14:11:33Z
    And a RunId r2 minted at 2026-08-02T14:11:34Z
    Then r1 < r2 under a plain string comparison
    And both match /^run_\d{8}T\d{6}Z_[0-9a-f]{6}$/
```

**Notes:** Sorting matters because `.karvan/runs/` is browsed by a human and listed by `karvan run
--list`; the format puts the timestamp before the random suffix precisely so `ls` is chronological.

---

## EPIC-02-S6 — Re-approving an unchanged spec does not change its `specHash`

**Verifies:** KAR-02.2, KAR-02.9 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: TaskSpec identity under approval

  Scenario: approval is not part of identity
    Given a TaskSpec with approvedBy: null and specHash "sha256-…a1"
    When the operator approves it in the UI and approvedBy becomes { at: "2026-08-02T15:00:00Z", via: "ui" }
    Then specHash is still "sha256-…a1"
    And a run.spec.approved event carrying that same specHash is emittable

  Scenario: editing one word changes identity
    Given the approved spec
    When one character of `goal` is edited
    Then specHash changes
    And the previously recorded run.spec.approved specHash no longer matches, so the approval gate must be re-run

  Scenario: serialisation does not change identity
    Given the approved spec
    When it is round-tripped through JSON.parse(JSON.stringify(spec)) and its keys shuffled
    Then specHash is unchanged
```

**Notes:** The third scenario is the reason KAR-02.9 exists. If `specHash` were computed with
`JSON.stringify`, a spec that travelled through the HTTP API and back would change identity and the
approval gate would re-fire for no reason — which trains the operator to click through it, which is
exactly the "gates that exist but aren't treated as real gates" failure mode PRD §4.5 names.

---

## EPIC-02-S7 — A shallow or malformed `TaskSpec` is rejected at the boundary

**Verifies:** KAR-02.2 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: TaskSpec validation

  Scenario Outline: rejections
    Given a TaskSpec fixture modified by "<mutation>"
    When TaskSpecSchema.safeParse is called
    Then success is false
    And the first issue's path is "<path>"

    Examples:
      | mutation                                          | path                              |
      | acceptanceCriteria set to []                      | acceptanceCriteria                |
      | criterion check.expect set to "passes"            | acceptanceCriteria.0.check.expect |
      | criterion check.kind set to "script"              | acceptanceCriteria.0.check.kind   |
      | goal set to ""                                    | goal                              |
      | knownFailureModes[0].detection removed            | knownFailureModes.0.detection     |
      | schemaId set to "karvan.taskspec"                 | schemaId                          |

  Scenario: coveredByGates is not required from an author
    Given a hand-written spec with no coveredByGates on any criterion
    When it is parsed
    Then success is true
    And every criterion's coveredByGates is []
```

**Notes:** `schemaId: 'karvan.taskspec'` without the `.v1` suffix is rejected because the version
suffix is part of the id — schemas are append-only and an unsuffixed id has no upgrade path.
`knownFailureModes[].detection` is required rather than optional because a failure mode with no
detection story is the "shallow spec" the SDD literature names as the primary failure mode.

---

## EPIC-02-S8 — The canonical encoder is invariant to key order and refuses lossy values

**Verifies:** KAR-02.9 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Canonical JSON encoding

  Scenario: key-order invariance at depth
    Given 200 randomly generated nested objects up to depth 6 containing arrays of objects
    When each is re-created with its keys inserted in a shuffled order
    Then canonicalJson(shuffled) equals canonicalJson(original) byte for byte

  Scenario: undefined is omitted and null is preserved
    When canonicalJson({ a: undefined, b: null, c: 1 }) is called
    Then the output is exactly '{"b":null,"c":1}'

  Scenario Outline: lossy values are refused, never coerced
    When canonicalJson(<value>) is called
    Then it throws <error> naming the JSON pointer of the offending value

    Examples:
      | value                       | error                  |
      | { at: new Date() }          | CanonicalJsonUnsupported |
      | { m: new Map() }            | CanonicalJsonUnsupported |
      | { s: new Set() }            | CanonicalJsonUnsupported |
      | { n: NaN }                  | CanonicalJsonUnsupported |
      | { i: Infinity }             | CanonicalJsonUnsupported |
      | { b: 1n }                   | CanonicalJsonUnsupported |
      | a self-referencing object   | CanonicalJsonCycle       |

  Scenario: the golden plan hash has not moved
    Given the committed fixture test/fixtures/plans/seven-types.json
    When planHash is computed over it
    Then it equals the committed golden hex string in __snapshots__/plan-hash.golden

  Scenario: ohash is not the hasher
    When packages/core/src is searched for an import of "ohash"
    Then there are zero matches
```

**Notes:** The last two scenarios encode a verified caution. `ohash`'s stable key-ordering behaviour
*is* confirmed, but its README promises only "best efforts" at stable serialisation — acceptable for
"did this object change since last render" in the UI, and wrong for the primary key of the `plan`
table. If the golden hex in the fourth scenario ever changes, every existing ledger's `plan` rows
have been orphaned; treat that diff as a migration, not a snapshot update.

---

## EPIC-02-S9 — A graph with all seven node types parses and snapshots stably

**Verifies:** KAR-02.3 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: PlanGraph parsing

  Scenario: the seven-types fixture
    Given the fixture test/fixtures/plans/seven-types.json containing one node each of
      | type     |
      | agent    |
      | tool     |
      | gate     |
      | human    |
      | map      |
      | loop     |
      | subgraph |
    When PlanGraphSchema.parse is called
    Then it succeeds
    And the parsed graph matches the file snapshot __snapshots__/plan-seven-types.json
    And running the same test twice produces no snapshot diff

  Scenario: type-specific required fields
    Given the parsed graph
    Then the agent node has brief and provider.prefer
    And the gate node has criteria and independence.notSessionOf
    And the loop node has noProgress.sameFailureSignatureLimit and noProgress.diffSimilarityThreshold
    And the human node's options each have an effect in {approve, reject, edit, inject}
    And the tool node has effectClass in {pure, mutating}

  Scenario: the discriminator is real
    When PlanNodeSchema.safeParse({ type: "agent", gate: { kind: "deterministic", gateId: "typecheck" }, ... }) is called
    Then success is false
    And the issue is a discriminated-union mismatch on "gate", not an unknown-key warning
```

**Notes:** `tool.effectClass` is classified **at plan time**, not at run time, because it decides the
reconcile strategy in the effect journal — a `mutating` command whose `reconcile()` returns
`unknown` is never auto-retried. Getting it into the schema here is what makes that possible in
EPIC-06.

---

## EPIC-02-S10 — A node missing a `NodeBase` contract field is rejected

**Verifies:** KAR-02.3 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Every node carries the safety and memory contract

  Scenario Outline: omission is a parse failure
    Given a valid node of type "<type>"
    When the field "<field>" is deleted and PlanNodeSchema.safeParse is called
    Then success is false
    And the issue path is "<field>"

    Examples:
      | type     | field      |
      | agent    | permission |
      | agent    | pathScopes |
      | agent    | returns    |
      | agent    | reads      |
      | agent    | writes     |
      | agent    | lifecycle  |
      | tool     | permission |
      | tool     | pathScopes |
      | gate     | permission |
      | gate     | returns    |
      | human    | permission |
      | map      | pathScopes |
      | loop     | permission |
      | subgraph | pathScopes |

  Scenario: defaults are applied, not required
    Given a node with retry, budget and returns.maxTokens absent
    When it is parsed
    Then returns.maxTokens is 1500
    And retry equals { maxAttempts: 3, backoff: { base: 2000, cap: 300000, jitter: "full" } }
    And budget is {}
```

**Notes:** `permission` and `pathScopes` are required on *every* node type including `human` and
`subgraph`, with no default. A defaulted permission level is how a system ends up silently
escalating, which is precisely the ODW binary-permission hazard (PRD G6) this design exists to
avoid. The retry defaults match F7.5's cap of 3 and the full-jitter constants in
[05-durable-execution §10.3](../../05-durable-execution.md).

---

## EPIC-02-S11 — An undeclared read is caught before a token is spent

**Verifies:** KAR-02.3 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Declared reads must be satisfiable

  Scenario: a dangling fact read
    Given a 12-node plan where node "implement-auth" declares reads [{ kind: "fact", key: "finding/auth-uses-jwt" }]
    And no ancestor of "implement-auth" declares a write of "finding/auth-uses-jwt"
    When readsAreSatisfiable(graph) is called
    Then it returns exactly one violation { node: "implement-auth", read: "finding/auth-uses-jwt" }

  Scenario: an ancestor two hops up satisfies it
    Given node "recon-auth-surface" is an ancestor at depth 2 and declares writes [{ kind: "fact", key: "finding/auth-uses-jwt", schemaId: "karvan.finding.v1" }]
    When readsAreSatisfiable(graph) is called
    Then it returns []

  Scenario: a sibling does not satisfy it
    Given "recon-auth-surface" is a sibling rather than an ancestor
    When readsAreSatisfiable(graph) is called
    Then the violation is reported

  Scenario: prefix reads match
    Given node "summarise" declares reads [{ kind: "fact", key: "finding/*" }]
    And an ancestor writes "finding/auth-uses-jwt"
    Then readsAreSatisfiable returns []

  Scenario: spec reads are always satisfiable
    Given node "implement-auth" declares reads [{ kind: "spec", section: "constraints" }]
    Then readsAreSatisfiable returns [] regardless of ancestry
```

**Notes:** This is described in [04-domain-model §3.1](../../04-domain-model.md) as "roughly 60
lines, and the cheapest correctness gate in the system" — pure reachability over the DAG, run before
a single token is spent. The sibling scenario is the one that catches real planner errors: a parallel
node writing a fact you read is a race, not a dependency.

---

## EPIC-02-S12 — A patch with an incomplete `policy` block cannot be proposed

**Verifies:** KAR-02.4 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: The policy block is mandatory

  Scenario Outline: each field is required
    Given a valid PlanPatch fixture
    When policy.<field> is deleted and PlanPatchSchema.safeParse is called
    Then success is false and the issue path is "policy.<field>"

    Examples:
      | field                     |
      | estimatedCostDeltaUsd     |
      | estimatedWallClockDeltaMs |
      | blastRadius               |
      | replanDepth               |
      | escalatesPermission       |
      | addsWriteCapability       |

  Scenario: policy itself is not optional
    When the whole policy block is deleted
    Then success is false and the issue path is "policy"

  Scenario: escalatesPermission is null or a from/to pair, never a bare level
    When policy.escalatesPermission is set to "full"
    Then success is false
    When it is set to { from: "worktree", to: "worktree+net" }
    Then success is true
```

**Notes:** These six fields are mandatory rather than optional because the entire F2.5 default policy
— auto-apply read-only analysis, require approval for anything adding write capability or cost above
a threshold or replan depth over 3 — is expressible as predicates over exactly these fields. A patch
that cannot fill them in is a patch the policy engine cannot rule on, so it is rejected at
validation rather than defaulted to "auto".

---

## EPIC-02-S13 — A rejected patch is still a recorded, well-formed value

**Verifies:** KAR-02.4 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: Rejections are first-class records

  Scenario: a rejection names the rule that fired
    Given a PlanPatch whose policy.addsWriteCapability is true and replanDepth is 4
    When the decision is recorded as rejected by policy
    Then PatchDecisionSchema.parse({ decision: "rejected", by: "policy", rule: "replan-depth-gt-3", at: "…" }) succeeds
    And PatchDecisionSchema.parse({ decision: "rejected", by: "policy", at: "…" }) fails on "rule"

  Scenario: the proposal event exists independently of the outcome
    Then a plan.patch.proposed event carrying the full patch is constructible
    And a plan.patch.rejected event carrying { patchId, rule, by } is constructible
    And neither requires the patch to have been applied

  Scenario: a scheduler-proposed re-route is an ordinary patch
    Given a patch with proposedBy "scheduler" and a single replace-provider op
    Then PlanPatchSchema.parse succeeds
    And nothing in the schema distinguishes it from a planner-proposed patch
```

**Notes:** The third scenario is F3.9. Quota-driven provider re-routing is deliberately *not* a
special case, so it appears in the plan-evolution scrubber alongside every other patch — "why did
this node switch to Codex halfway through?" is answerable in one click rather than buried in a log.

---

## EPIC-02-S14 — A fact's value is validated against its `schemaId` before acceptance

**Verifies:** KAR-02.5, KAR-02.8 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: Facts are schema-validated on acceptance

  Background:
    Given .karvan/schemas/karvan.finding.v1.json has been emitted from the Zod source
    And makeValidator("karvan.finding.v1") returns an Ajv2020 validator configured { strict: true, allErrors: true }

  Scenario: a conforming finding is accepted
    Given a Fact with key "finding/auth-uses-jwt", kind "finding", schemaId "karvan.finding.v1"
    And a value conforming to that schema
    And provenance { byNode: "recon-auth-surface", byProvider: "claude-code", byModel: "claude-sonnet-4-6", fromEvidence: ["artifact://<64 hex>"], atEvent: 412, confidence: "verified" }
    When acceptFact is called
    Then it returns ok
    And a fact.written event carrying the whole Fact is constructible

  Scenario: a non-conforming value is rejected with every error
    Given the same Fact with two schema violations in its value
    When acceptFact is called
    Then it returns an error of kind 'schema-invalid'
    And the error carries at least 2 issues, each with a JSON Pointer into the value

  Scenario Outline: kind and key prefix must agree
    Given a Fact with kind "<kind>" and key "<key>"
    Then acceptFact returns <ok>

    Examples:
      | kind     | key                                  | ok    |
      | finding  | finding/auth-uses-jwt                | true  |
      | decision | decision/use-pinia-not-vuex          | true  |
      | verdict  | verdict/typecheck-gate               | true  |
      | finding  | decision/use-pinia-not-vuex          | false |
      | ext      | ext:migration/vue3-incompat-list     | true  |
      | finding  | ext:migration/vue3-incompat-list     | false |
      | hunch    | hunch/maybe-its-the-router           | false |
```

**Notes:** `allErrors: true` matters for the repair path: an agent handed one error at a time takes
N turns to fix N problems, and each turn costs quota. `confidence` is not decoration — it is what
lets `fact.invalidated` and the §5.2 taint rule distinguish "this was speculative and turned out
wrong" from "this was verified and the world changed".

---

## EPIC-02-S15 — An `ext:` fact with no registered schema is refused

**Verifies:** KAR-02.5, KAR-02.8 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: The free-form namespace is schema-validated but not enumerated

  Scenario: an unregistered ext schema is refused
    Given .karvan/schemas/ contains no file named "ext.migration.vue3-incompat.v1.json"
    And a Fact with kind "ext", key "ext:migration/vue3-incompat-list", schemaId "ext.migration.vue3-incompat.v1"
    When acceptFact is called
    Then it returns an error of kind 'unknown-schema-id'
    And the message names "ext.migration.vue3-incompat.v1" and the directory ".karvan/schemas/"

  Scenario: registering the schema makes the same fact acceptable
    Given the operator writes ext.migration.vue3-incompat.v1.json into .karvan/schemas/
    When acceptFact is called with the same Fact
    Then it returns ok
    And Karvan applies no further constraint on what the namespace means
```

**Notes:** This is the concrete answer to PRD open question §15.2 — a small fixed core plus one
schema-validated free-form namespace. The fixed core gives the marquee visualisations something
renderable and diffable; the `ext:` space stops the vocabulary becoming a straitjacket the first
time an unanticipated task archetype appears. The registration requirement is what stops it becoming
an untyped bag.

---

## EPIC-02-S16 — A corrected fact is a new `FactId` that supersedes the old one

**Verifies:** KAR-02.5 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: Facts are immutable; corrections supersede

  Scenario: correction chain
    Given a Fact f1 with id "fact_01hq…a" and key "finding/auth-uses-jwt" written at atEvent 412
    When a later node discovers the finding was wrong and writes a correction
    Then the new Fact f2 has a different FactId
    And f2.supersedes equals f1.id
    And f1 is unchanged and still present
    And there is no exported function that mutates f1

  Scenario: self-supersession is refused
    When a Fact is constructed with supersedes equal to its own id
    Then FactSchema.safeParse fails

  Scenario: ordering is by atEvent, never by the timestamp
    Given facts written at atEvent 412, 419 and 431
    And their provenance.at timestamps run 412 → 431 → 419 because the laptop slept and NTP corrected backwards
    When the exported comparator sorts them
    Then the order is 412, 419, 431
    And no exported comparator reads provenance.at
```

**Notes:** The third scenario encodes
[05-durable-execution §9.6](../../05-durable-execution.md): the wall clock is not monotonic, laptop
sleep and NTP correction both move `Date.now()` backwards, and any logic comparing two timestamps to
decide what happened first is a bug waiting for a daylight-saving transition. `atEvent` is the
ordering key; `at` is display only.

---

## EPIC-02-S17 — A packet's totals and pin digests are self-consistent

**Verifies:** KAR-02.6 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: ContextPacket internal consistency

  Scenario: totals reconcile
    Given a ContextPacket with 6 segments across kinds pinned.spec, pinned.constraints, task.brief, fact, artifact.handle, history.summary
    When packetTotalsAreConsistent(packet) is called
    Then it returns true
    And totals.tokens equals the sum of segments[].tokens.estimated
    And totals.byKind["fact"] equals the sum over the fact segments only

  Scenario: a doctored total is caught
    Given the same packet with totals.tokens increased by 100
    Then packetTotalsAreConsistent returns false naming 'totals.tokens'

  Scenario: pinned implies not compactable, one way only
    Given a segment with pinned: true and compactable: true
    Then SegmentSchema.safeParse fails
    Given a segment with pinned: false and compactable: false
    Then SegmentSchema.safeParse succeeds

  Scenario: pinnedDigests are derivable from the segments
    Then pinnedDigests has one entry per pinned segment
    And each entry equals that segment's contentHash
    And a packet whose pinnedDigests contains an extra or mismatched digest is rejected

  Scenario Outline: the budget fraction is capped
    When budget.fraction is <f>
    Then parsing <result>

    Examples:
      | f    | result    |
      | 0.5  | succeeds  |
      | 0.6  | succeeds  |
      | 0.61 | fails     |
      | 0.9  | fails     |

  Scenario: render order
    Given a packet with two pinned segments and one history.summary that replaced turns 3–7
    When renderOrderOf(packet) is called
    Then the two pinned segments come first
    And the history.summary appears in the chronological position of turns 3–7, not in a preamble
```

**Notes:** `pinnedDigests` is the *input* to the F6.6 integrity check: after rendering, the packet
builder asserts that each pinned segment's sha256 still appears in the outgoing prompt, and a
mismatch emits `pin.integrity_violated` and fails the node. Deriving the digests from
`contentHash` rather than maintaining them separately means the check cannot be defeated by a
builder bug that forgets to update one of the two.

---

## EPIC-02-S18 — Token counts declare their source and are never silently mixed

**Verifies:** KAR-02.6, KAR-02.10 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Estimated and vendor-reported token counts stay separate

  Scenario: method is mandatory on a TokenCount
    When TokenCountSchema.parse({ estimated: 4210 }) is called
    Then it throws on the missing "method"
    And there is no default value for method

  Scenario: source is mandatory on a TokenUsage
    When TokenUsageSchema.parse({ inputTokens: 100, outputTokens: 20 }) is called
    Then it throws on the missing "source"

  Scenario: summing across sources is refused
    Given usageA with source "vendor-reported" and usageB with source "estimated"
    When sumUsage([usageA, usageB]) is called
    Then it returns { vendorReported: <sum of A>, estimated: <sum of B> }
    And it does not return a single number

  Scenario: summing within one source is a plain sum
    Given three usages all with source "vendor-reported"
    Then sumUsage returns { vendorReported: <sum>, estimated: null }
```

**Notes:** Vendor-reported figures come from the CLI's result envelope (Claude Code's
`modelUsage[model]`, Codex's `turn.completed.usage` — **Verified 2026-08-02**) and are the billing
truth. Estimated figures come from `gpt-tokenizer`'s `o200k_base` encoding and carry a known 15–20%
undercount on Claude prose and worse on code. A budget ceiling (F4.6) computed from a silently-mixed
number fires at the wrong time — either burning quota past the ceiling or pausing a healthy run.
Keeping them separate all the way to the chart is a product requirement, not tidiness.

---

## EPIC-02-S19 — An older build meets an event kind it has never heard of

**Verifies:** KAR-02.7 · **Type:** Recovery · **Automated at:** unit

```gherkin
Feature: Forward compatibility of the event union

  Scenario: an unknown kind is reported, not thrown
    Given an event envelope { seq: 9001, runId: "run_…", ts: 1, kind: "future.thing", v: 1, epoch: 3, payload: { anything: true } }
    When parseEvent(envelope) is called
    Then it returns { status: "unknown-kind", kind: "future.thing", seq: 9001 }
    And it does not throw
    And it does not log at error level

  Scenario: a known kind at a future version is not guessed at
    Given the current version of "node.completed" is 3
    And an envelope for "node.completed" with v: 4
    When parseEvent is called
    Then it returns { status: "future-version", kind: "node.completed", v: 4, current: 3 }
    And no upcaster and no downcaster is applied
    And payload is not parsed

  Scenario: a known kind at a known version parses
    Given an envelope for "node.completed" with v: 3
    Then parseEvent returns { status: "ok", event: <typed event> }
```

**Notes:** This is the single forward-compatibility mechanism in the system. It exists so that a user
who installs a newer `karvand`, starts a run, then downgrades gets a daemon that skips events it does
not understand rather than one that refuses to open the ledger. The corresponding reducer behaviour
— `return state` unchanged — is [EPIC-03-S16](./EPIC-03-event-ledger-flows.md). Note the "does not
log at error level" clause: an error-level log on every skipped event during a downgraded replay is
its own denial of service.

---

## EPIC-02-S20 — An upcaster chain lifts a v1 payload to v3 at read time

**Verifies:** KAR-02.7 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: Payload evolution through upcasters

  Background:
    Given upcasters are registered for ("node.completed", 1) and ("node.completed", 2)
    And the current version of "node.completed" is 3

  Scenario: two-hop chain
    Given a v1 node.completed payload written in March
    When upcast("node.completed", 1, payload) is called
    Then both upcasters run in ascending version order
    And the result parses against the v3 schema
    And the on-disk payload is unmodified

  Scenario: upcasters are pure
    When upcast is called twice on the same input
    Then both results are deeply equal
    And the input object is not mutated

  Scenario: a duplicate registration is refused
    When an upcaster is registered a second time for ("node.completed", 1)
    Then registerUpcaster throws 'duplicate-upcaster' naming the kind and version

  Scenario: an upcaster whose output its own target rejects is caught
    Given a property test over every registered upcaster and its fixture
    Then for each, targetSchema.safeParse(upcaster(fixture)).success is true
```

**Notes:** Events are never rewritten on disk — the ledger is append-only and immutable, so a v1
payload written in March is still a v1 payload in December. The chain from v1 to v4 must still exist
when v5 ships; upcasters are append-only and never deleted.

---

## EPIC-02-S21 — A hole in the upcaster chain fails at build, not at 3am

**Verifies:** KAR-02.7 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Upcaster chain completeness

  Scenario: a missing hop is detected eagerly
    Given the current version of "gate.evaluated" is 3
    And an upcaster is registered for ("gate.evaluated", 1) but not for ("gate.evaluated", 2)
    When assertUpcasterChainsComplete() is called
    Then it throws naming kind "gate.evaluated" and the missing version 2

  Scenario: the assertion runs in the unit suite and at daemon boot
    Then a unit test calls assertUpcasterChainsComplete() over the real registry
    And karvand calls it during startup before opening the ledger
    And a failure at boot exits with a typed error naming the gap, not a stack trace
```

**Notes:** The alternative to eager checking is discovering the hole during replay of a nine-hour
run, at the one moment the data is least recoverable. The check is O(kinds × versions) over a static
registry, so running it at every boot costs nothing.

---

## EPIC-02-S22 — A lossy payload change becomes a new `kind`, not a new `v`

**Verifies:** KAR-02.7 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: The versioning rule has a stated boundary

  Scenario: a field-adding change is a version bump
    Given node.progress v1 gains an optional ioChunkSeq field
    When the upcaster for ("node.progress", 1) is written
    Then it can produce a valid v2 payload by omitting the new optional field
    And the change ships as v2

  Scenario: a meaning-changing removal is a new kind
    Given a proposed change that removes a required field from context.compacted with no way to reconstruct it
    When an upcaster is attempted
    Then no pure function from the old payload to the new one exists
    And the change ships as a new kind rather than as v2
    And schemas/CHANGELOG.md records the reason

  Scenario: the guard test
    Given a property test over every registered upcaster
    Then no upcaster drops a field that its target schema marks required
```

**Notes:** "If an upcaster cannot be written (a genuinely lossy schema change), that is a new `kind`,
not a new `v`." The guard test cannot prove intent, but it catches the mechanical version of the
mistake — an upcaster that produces a payload missing a required field, which would otherwise fail
only when that specific historical event is replayed.

---

## EPIC-02-S23 — Vendor-internal compaction cannot fabricate an "after" number

**Verifies:** KAR-02.7 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: context.compacted carries a fidelity discriminator

  Scenario: Karvan's own packet compaction is exact
    Given a compaction performed by Karvan's own context builder
    When the context.compacted payload is constructed with scope "karvan.packet" and fidelity "exact"
    Then before and after are both numbers
    And droppedSegments lists the SegmentIds removed
    And originalHandle is an artifact:// Handle
    And pinnedKept lists one sha256 per pinned segment

  Scenario: vendor-internal compaction is partial and says so
    Given Claude Code emits { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 148000 } }
    When the context.compacted payload is constructed with scope "vendor.session"
    Then fidelity is "partial"
    And before is 148000
    And after is null
    And droppedSegments is []
    And originalHandle is null

  Scenario: fabricating the missing number is refused by the schema
    When a payload with fidelity "partial" and after: 60000 is parsed
    Then it fails, naming "after"
    When a payload with fidelity "partial" and droppedSegments: ["seg_1"] is parsed
    Then it fails, naming "droppedSegments"
```

**Notes:** **Verified 2026-08-02** by decoding Claude Code 2.1.220's shipping bundle:
`compact_boundary` carries `pre_tokens` only — no post count, no dropped list, no handle to the
original. Encoding that uncertainty in the type is the difference between an auditable system and
one that quietly lies. A chart with a fabricated "after" number is worse than an honest gap, and
[12-frontend-architecture.md](../../12-frontend-architecture.md) renders the `partial` case as an
open-ended bar for exactly this reason. Roadmap standing-maintenance row "Claude Code internal
shapes" makes this assertion part of the conformance suite so a CLI upgrade breaks a test rather
than a chart.

---

## EPIC-02-S24 — An edited Zod schema without re-emission fails CI

**Verifies:** KAR-02.8 · **Type:** Failure · **Automated at:** integration

```gherkin
Feature: Zod and JSON Schema cannot drift

  Scenario: the check is green on a clean tree
    Given the repository at HEAD
    When `pnpm schemas:check` runs
    Then it exits 0 and prints nothing to stderr

  Scenario: a schema edited without re-emission is caught
    Given FactSchema gains a required field "sourceRun"
    And `pnpm schemas:emit` has not been run
    When `pnpm schemas:check` runs
    Then it exits non-zero
    And stderr names "karvan.fact.v1"
    And stderr contains a unified diff showing the added "sourceRun" under "required"

  Scenario: re-emitting makes it green
    When `pnpm schemas:emit` runs and the changed file is committed
    Then `pnpm schemas:check` exits 0

  Scenario: a shipped .v1 file may not change content
    Given the committed schemas/ fixture directory and its content-hash table
    When any .v1 file's content hash differs from the table
    Then the test fails naming the file and the append-only rule
```

**Notes:** `schemas:check` regenerates into a tmpdir and diffs content — never mtimes, never file
counts alone. It belongs in the CI `check` job alongside `biome ci` and `typecheck`, not in a
pre-commit hook: [testing strategy §14](../../14-testing-strategy.md) keeps pre-commit under ~2
seconds and this is a full package build.

---

## EPIC-02-S25 — Every emitted schema compiles under Ajv2020 in strict mode

**Verifies:** KAR-02.8 · **Type:** Happy path · **Automated at:** unit

```gherkin
Feature: The emitted dialect is usable by the one validator we ship

  Scenario Outline: strict compilation
    Given the emitted file .karvan/schemas/<schemaId>.json
    Then it declares "$schema": "https://json-schema.org/draft/2020-12/schema"
    And new Ajv2020({ strict: true, allErrors: true }) with ajv-formats compiles it without warnings
    And the compiled validator accepts the schema's own fixture and rejects its counter-fixture

    Examples:
      | schemaId                  |
      | karvan.taskspec.v1        |
      | karvan.plangraph.v1       |
      | karvan.planpatch.v1       |
      | karvan.fact.v1            |
      | karvan.finding.v1         |
      | karvan.verdict.v1         |
      | karvan.contextpacket.v1   |

  Scenario: a schema is a standalone document
    Then no emitted file contains a $ref to a sibling file path
    And each compiles in isolation with no addSchema call
```

**Notes:** 2020-12 is the dialect MCP tool `inputSchema` defaults to, so the MCP host
([EPIC-05](../epics/EPIC-05-provider-adapters.md), KAR-05.6) and the F6.9 handoff contracts speak one
dialect and one validator, and Ajv arrives transitively via `@modelcontextprotocol/sdk` anyway
(**Verified 2026-08-02**). The standalone-document rule matters for the next scenario — a vendor CLI
handed a file with a relative `$ref` cannot resolve it.

---

## EPIC-02-S26 — A vendor CLI consumes an emitted schema file directly

**Verifies:** KAR-02.8 · **Type:** Contract · **Automated at:** contract (manual until EPIC-04 lands)

```gherkin
Feature: Emitted schemas are the vendor's structured-output contract

  Scenario: Claude Code accepts the file
    Given .karvan/schemas/karvan.finding.v1.json emitted from the Zod source
    When an agent node is invoked with --json-schema .karvan/schemas/karvan.finding.v1.json
    Then the CLI accepts the file without a parse error
    And a conforming structured_output is returned on the success path

  Scenario: Codex accepts the same file
    When the same file is passed as --output-schema
    Then the CLI accepts it

  Scenario: an oversize structured return is repaired or failed, never truncated
    Given the returned structured_output exceeds the node's returns.maxTokens
    Then a handoff.oversize event is emitted with { budget, actual, repairAttempted }
    And the node fails with reason 'contract.handoff-oversize' if repair does not fit it
    And the output is never truncated to fit
```

**Notes:** **Verified 2026-08-02**: Claude Code 2.1.220 ships `--json-schema <schema>`, its result
envelope carries `structured_output`, and it has a dedicated `error_max_structured_output_retries`
failure subtype — the CLI performs bounded internal repair against your schema before giving up, and
F6.9 maps that subtype to `agent.schema-repair-exhausted`. **Never truncate an oversized structured
return**: it produces invalid JSON and propagates exactly the garbage F6.9 exists to prevent.
Until [EPIC-04](../epics/EPIC-04-mock-agent.md) ships the mock agent and a recording, run this
against the developer's installed CLI and name the spec `*.manual.test.ts` so it is excluded from
CI — roadmap risk **A4-2** records that `structured_output`'s presence on every success case is
**Unverified** and M0-S1 is where it is settled.

---

## EPIC-02-S27 — A thrown `Error` never reaches the ledger

**Verifies:** KAR-02.10 · **Type:** Failure · **Automated at:** unit

```gherkin
Feature: Failures are values, not throws

  Scenario Outline: everything thrown maps to the closed union
    Given <thrown> is thrown inside an effect
    When toNodeFailure(<thrown>, ctx) is called
    Then the result parses against NodeFailureSchema
    And result.reason is "<reason>"
    And result.message is a single line with no newline
    And the result has no "stack" property
    And JSON.parse(JSON.stringify(result)) is deeply equal to the result

    Examples:
      | thrown                                   | reason                    |
      | new Error("boom")                        | internal                  |
      | "a bare string"                          | internal                  |
      | undefined                                | internal                  |
      | new AggregateError([e1, e2])             | internal                  |
      | a SpawnFailed with code ENOENT           | adapter.spawn-failed      |
      | an AjvValidationError                    | contract.schema-invalid   |
      | a FrameTooLarge over 8 MiB               | adapter.frame-too-large   |

  Scenario: the stack is preserved as evidence, not as a payload field
    Given new Error("boom") with a V8 stack
    When toNodeFailure is called
    Then result.evidence contains exactly one artifact:// Handle
    And the blob behind that handle contains the stack text

  Scenario: reason 'internal' is treated as a bug
    Then a test asserts the internal-reason counter is 0 across the full unit corpus
    And the counter is exported so the daemon can surface it
```

**Notes:** A thrown `Error` with a V8 stack does not survive `JSON.stringify`, does not survive a
daemon restart, and gives the node inspector nothing to render but a monospace box. The boundary is
exactly one function. `internal` existing at all is a design concession, and the last scenario keeps
it visible: an `internal` in production is a mapping that was never written, not an expected
outcome.

---

## EPIC-02-S28 — Failure class is assigned at construction, not derived at render

**Verifies:** KAR-02.10 · **Type:** Edge case · **Automated at:** unit

```gherkin
Feature: The scheduler reads class and nothing else

  Scenario Outline: the same reason carries different classes
    Given a failure with reason "<reason>" in context "<context>"
    When it is constructed
    Then class is "<class>"
    And NodeFailureSchema.safeParse succeeds

    Examples:
      | reason                  | context                                  | class     |
      | provider.unavailable    | vendor returned 429 with a reset time    | transient |
      | provider.unavailable    | the binary was uninstalled mid-run       | permanent |
      | timeout                 | the agent hung mid-turn, attempt 1 of 3  | transient |
      | timeout                 | the agent hung mid-turn, attempt 3 of 3  | permanent |
      | gate.failed             | a deterministic gate returned fail       | gate      |

  Scenario Outline: some reasons are constrained by the schema
    When a failure with reason "<reason>" and class "<class>" is parsed
    Then parsing <result>

    Examples:
      | reason                    | class     | result   |
      | effect.reconcile-unknown  | gate      | succeeds |
      | effect.reconcile-unknown  | transient | fails    |
      | effect.reconcile-unknown  | permanent | fails    |
      | budget.cost-exceeded      | gate      | succeeds |
      | budget.cost-exceeded      | permanent | fails    |
      | budget.wallclock-exceeded | gate      | succeeds |

  Scenario: there is no classify(reason) function
    When packages/core/src is searched for an exported function mapping reason to class
    Then there are zero matches
```

**Notes:** Two rules from [04-domain-model §8](../../04-domain-model.md), both worth more than they
look. `class` is not derived from `reason` because the same reason is transient or permanent
depending on context, and the scheduler reads `class` and nothing else. `effect.reconcile-unknown`
is schema-constrained to `gate` because there is **no correct automatic action** when the reconcile
probe cannot determine whether a mutating effect landed — retrying might double-apply, skipping
might drop the work, and neither is detectable. Making the type refuse `transient` means nobody can
"helpfully" add a retry later. Budget ceilings are `gate` for the same structural reason: F4.6
pauses for a human decision rather than dying with hours of work half-done.

---

**Related:** [EPIC-02](../epics/EPIC-02-domain-model.md) · [Board](../board.md) ·
[04-domain-model.md](../../04-domain-model.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
