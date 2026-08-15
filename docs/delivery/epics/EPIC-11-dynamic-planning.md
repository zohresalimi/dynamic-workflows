# EPIC-11: Dynamic planning and patch policy

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-11-dynamic-planning-flows.md)

|                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-11                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Status**           | Not started                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Priority**         | P0                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Milestone**        | M1                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Workstream**       | W7b (see [roadmap §2.2](../../17-roadmap.md))                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Size**             | ~16 days across 6 stories — **over the ~15-day guidance, see Risks**                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Depends on**       | EPIC-10 (the pinned `TaskSpec` and the recon facts — two of the planner's three inputs), EPIC-09 (`validateDeclaredReads`, packet token estimation, the blackboard), EPIC-06 (`decide()`, the effect journal, the churn circuit breaker and durable `node_wake`), EPIC-05 (`provider_capabilities` rows, the MCP host that exposes `DeFlow.propose_plan_patch`), EPIC-03 (the `plan` table and the atomic append), EPIC-02 (`PlanGraph`, `PlanPatch`, `PatchDecision`) |
| **Blocks**           | EPIC-12 (plan validation is where acceptance-criteria coverage is enforced), EPIC-15 (`GET /api/runs/:id/plans/diff` and every plan projection), EPIC-17 (F10.1 the live plan graph and F10.2 the plan-evolution scrubber — the marquee view)                                                                                                                                                                                                                          |
| **PRD requirements** | F2.1, F2.2, F2.3, F2.4, F2.5, F2.6 (all P0) · F3.5, F3.9, F4.7, F5.4, F6.2, F7.4, F9.3 · NF7, NF9, NF10                                                                                                                                                                                                                                                                                                                                                                |
| **Architecture**     | [06-planning-and-replanning.md](../../06-planning-and-replanning.md) §2–§8 (the whole document less §1) · [04-domain-model.md](../../04-domain-model.md) §3, §4 · [05-durable-execution.md](../../05-durable-execution.md) §11                                                                                                                                                                                                                                         |

## Goal

At the end of this epic DeFlow's plan is genuinely dynamic: a versioned JSON graph compiled from the
pinned spec, the recon facts and the **probed** provider capabilities; validated by pure graph
reachability before a single token is spent; and mutated at runtime only through `PlanPatch`
documents that a declarative, ordered policy engine auto-applies, queues for a human, or rejects —
recording all three outcomes. Every version is retained and content-addressed, so the answer to
_"why is there a step here that I didn't ask for?"_ is one query away: who proposed it, why, what the
estimate was, which rule fired, and whether a human approved it.

## Why this matters

This is the epic that makes DeFlow's central claim true.
[PRD §3.2 G1](../../prd.md) rates _"dynamic is a misnomer"_ as the **Critical** gap in the closest
prior art: Open Dynamic Workflow's dynamism is entirely at authoring time, _"once written, the graph
is frozen. There is no mechanism for a running workflow to add a step, split a task, or change
provider based on what it learned."_ The competitive matrix in [PRD §4.8](../../prd.md) has exactly
one row with _yes_ under **dynamic re-plan**, and this epic is where that cell is earned. Everything
else DeFlow does — durability, provider neutrality, visualisation — exists somewhere else in the
landscape. This does not.

Two of the six stories carry disproportionate weight.

**`KAR-11.2` is the cheapest correctness gate in the system.**
[06 §3](../../06-planning-and-replanning.md) says so in as many words, and the arithmetic backs it:
walking the DAG in topological order and asserting every declared read is satisfied by an ancestor's
declared write is _"pure graph reachability — roughly 60 lines"_, and at 40 nodes _"the transitive
closure is free; do not optimise it"_. For that price it catches an unreachable read, a cycle, an id
that will not survive `git check-ref-format`, a criterion no gate covers, and a node scheduled onto
an adapter that cannot honour its requirements — all **before a single token is spent**. The
capability half matters more than it looks, because the measured matrix already contradicts the
vendor docs in two places: `copilot --acp` 1.0.77 and `gemini --acp` 0.53.1 **cannot resume a
session at all**, and Gemini returns no `sessionCapabilities` key whatsoever. _"Any planner that
assumes a uniform capability surface will schedule nodes that cannot run."_

**`KAR-11.4` is where the run's cost ceiling and its safety ceiling are actually enforced.**
[PRD §13](../../prd.md) rates runaway cost **High** and destructive action at the execution boundary
**High**; the patch policy is the control on both, and it is the control most easily got backwards.
[06 §7](../../06-planning-and-replanning.md) calls the interaction with no-progress detection _"the
sharpest edge in the whole design"_: **when the churn circuit-breaker trips, every non-human-authored
patch short-circuits to `reject`.** A churning run's instinct is to replan, and _"three consecutive
replans with no completed nodes is not a plan that needs a fourth revision; it is a plan built on a
false premise."_ Getting that backwards — letting read-only analysis patches keep auto-applying
during a trip — produces exactly the metric [PRD §12](../../prd.md) measures as _"runs abandoned due
to runaway loop"_, target < 5%.

Downstream, `KAR-11.5` is the precondition for the marquee view. The plan-evolution scrubber (F10.2)
is _"the direct visual expression of dynamic workflow"_ and [roadmap §3](../../17-roadmap.md) names
it as one of three views that carry the whole _time-to-diagnose < 5 min_ metric. It is renderable
only because every plan version is retained, immutable and content-addressed — and because
`NodeId`s never move.

## Scope

**In scope:**

- Plan compilation: the planner agent receiving **exactly three inputs** (the pinned `TaskSpec`, the
  recon facts, the probed capability list) and emitting a `PlanGraph` as structured output enforced
  at the adapter boundary (`--json-schema` / `--output-schema`), authored in Zod 4.4.3, emitted with
  `z.toJSONSchema()` into `.DeFlow/schemas/`, validated with Ajv 8.20.0 (`strict: true`,
  `allErrors: true`) against JSON Schema 2020-12.
- `planHash = sha256(canonicalJson(doc))` using `node:crypto` over an owned canonical encoder —
  explicitly **not** `ohash`, whose README promises only best-effort stable serialisation and which
  cannot back a primary key.
- Plan validation on **every** version, v1 and every patched successor: reachability of declared
  reads (`READ_UNREACHABLE`), cycle detection via `topoSort` throwing `PlanCycleError`, orphan writes
  as warnings, adapter capability checks (`PROVIDER_NOT_PROBED`, `NO_STRUCTURED_OUTPUT`, `NO_RESUME`,
  `PERMISSION_UNSUPPORTED`, `PACKET_EXCEEDS_BUDGET`), identifier validation through real
  `git check-ref-format` plus the stricter DeFlow charset, and criteria coverage (F7.4).
- Validation diagnostics as **events, not exceptions**: a failing v1 goes back to the planner once
  with the diagnostics as input; a second failure escalates to a `human` node. A failing patch is
  rejected outright and never partially applied.
- The `PlanPatch` lifecycle: proposal (including from `agent` nodes via the `DeFlow.propose_plan_patch`
  MCP tool injected through `session/new`), estimation, policy decision, application, revalidation,
  and the single SQLite transaction that inserts the new `plan` row, updates `run.plan_hash` and
  appends `plan.patched`.
- `basePlanHash` optimistic concurrency with `PATCH_STALE` and **no automatic rebasing**.
- The declarative, ordered, first-match-wins policy engine from `.DeFlow/config.yaml` under
  `policy.patch`, hashed into the run manifest, with the eight default rules and their exact
  thresholds (`replanDepth > 3`, `elapsedBudgetFraction >= 1.0`, `costDeltaUsd > 5.00`,
  `blastRadiusFiles > 25`), the `default: approve` arm, and the `circuit-breaker-tripped`
  short-circuit for every non-human-authored patch.
- Plan version retention: an immutable row per version in the content-addressed `plan` table plus
  `.DeFlow/runs/<runId>/plan/v1.json … vN.json` on disk (NF8), with nothing pruning either.
- Provider re-routing (F3.9) as a `replace-provider` patch proposed by `scheduler`, driven by Claude
  Code's `{"type":"rate_limit_event","rate_limit_info":{…}}` frame and by non-retryable rate-limit
  exits, auto-applied only under `quota-reroute-equivalent` when the target is a genuine capability
  superset; and **suspension via a durable `node_wake(reason = 'quota')` row when no healthy
  provider satisfies the node**.

**Out of scope:**

- Intake, the framing interview, the approval gate and spec pinning —
  [EPIC-10](./EPIC-10-task-intake.md). This epic consumes a pinned spec and never elicits one.
- Executing the plan: `decide()`, the ready set, semaphores, the effect journal, retries, the stall
  detector and the churn circuit breaker itself — [EPIC-06](./EPIC-06-orchestrator.md). This epic
  **reads** the breaker's state and changes its own behaviour; it does not implement it.
- `validateDeclaredReads` itself, which is `KAR-09.1` in [EPIC-09](./EPIC-09-context-memory.md).
  This epic calls it from the plan-validation pipeline and owns the diagnostic plumbing around it.
- Gate execution and the repair loop — [EPIC-12](./EPIC-12-verification-gates.md). This epic
  enforces that every criterion is _covered_ by a gate node; EPIC-12 makes those nodes produce
  verdicts.
- The approval queue surface a queued patch lands in — [EPIC-13](./EPIC-13-human-in-the-loop.md).
  This epic emits the queued decision and its estimate.
- Pre-flight cost estimation and budget ceilings — [EPIC-14](./EPIC-14-cost-governance.md). This
  epic _consumes_ `estimatedCostDeltaUsd` and `elapsedBudgetFraction`; it does not compute the
  underlying token model.
- Rendering: the live plan graph (F10.1) and the plan-evolution scrubber (F10.2), including the
  union-graph elkjs layout and the rfc6902 field-level diff panel, are
  [EPIC-17](./EPIC-17-p0-views.md). This epic owns the API-side plan diff contract and the guarantee
  that node ids are stable enough for a union layout to mean anything.
- Planner provider selection by measured past success (F2.7), plan templates (F2.8) and learned
  planning (F2.9) — **P1/P2, M2 and beyond**.

## Definition of Ready (epic level)

- [ ] **EPIC-10 Done.** A pinned `TaskSpec` with a `specHash` and recon facts on the blackboard
      exist, because a planner with two of its three inputs missing cannot be meaningfully tested.
- [ ] **EPIC-09 KAR-09.1 Done.** `validateDeclaredReads` exists as a pure function in
      `@DeFlow/core`, so `KAR-11.2` wires it in rather than reimplementing reachability.
- [ ] **EPIC-06 KAR-06.8 Done.** The stall detector and churn circuit breaker exist and expose
      `RunState.circuitBreaker`, because `KAR-11.4`'s hardest scenario is the interaction with it.
- [ ] **EPIC-05 KAR-05.2 Done.** The `provider_capabilities` table is populated by a real probe, and
      the 2026-08-02 matrix is committed as a **fixture, never a constant**.
- [ ] **EPIC-05 KAR-05.6 Done.** DeFlow's stdio MCP server can expose a tool into an agent session
      via `session/new`, so `DeFlow.propose_plan_patch` has a delivery mechanism.
- [ ] The `PatchOp` naming discrepancy between [04 §4](../../04-domain-model.md)
      (`insert-nodes` / `split-node` / `replace-provider` / `extend-loop` / `abandon-branch`) and
      [06 §4.1](../../06-planning-and-replanning.md) (`insert` / `split` / `reroute` / `extend` /
      `abandon`) is resolved in `KAR-02.4`. **04's names are canonical**; 06's are shorthand. See
      Risks — this must not ship as two vocabularies.
- [ ] A committed `test/fixtures/runs/three-patches/ledger.db` is planned (insert, split,
      provider-replace, each with a reason and a decision), because
      [14 §12](../../14-testing-strategy.md) names it as the fixture the scrubber is built against.

## Definition of Done (epic level)

- [ ] All six stories Done.
- [ ] Every scenario in [the flow file](../flows/EPIC-11-dynamic-planning-flows.md) exists as an
      automated test at the level its `Automated at:` line names, and passes on `ubuntu-26.04` and
      `macos-26` under Node 24 and 26.
- [ ] **Validation runs on every plan version.** A CI assertion proves there is exactly one entry
      point to plan persistence and that it validates: no code path writes a `plan` row without
      having produced a diagnostics array first.
- [ ] **A test exists for each of the three policy decision paths**, using the worked examples from
      [06 §4.3](../../06-planning-and-replanning.md) verbatim — the `0.40` / `blastRadius 0` /
      `read` / `depth 1` auto case, the `6.20` / `140 files` / `worktree` escalation case, and the
      `replanDepth 4` rejection — asserting the `ruleId` that fired, not merely the decision.
- [ ] **The churn interaction is tested in the direction that is easy to get backwards**: with the
      breaker tripped, a patch that would otherwise match `read-only-analysis` is rejected with
      `ruleId: 'circuit-breaker-tripped'`, and a human-authored patch applies and resets the breaker.
- [ ] `test/fixtures/runs/three-patches/ledger.db` is committed and serves through `deflow replay`.
- [ ] The crash-fuzz suite ([14 §11](../../14-testing-strategy.md)) includes a kill point inside
      patch application, and asserts the ledger holds either the old plan and no event or the new
      plan and its event — never a torn state.
- [ ] A CI grep proves no source file contains a hardcoded provider capability table, computes a plan
      hash with `ohash`, uses `setTimeout` for a quota wait, or constructs a branch name matching
      `DeFlow/<runId>/<nodeId>`.
- [ ] Every `Unverified` claim in [06](../../06-planning-and-replanning.md) that this epic depends on
      is resolved or carried forward: the elkjs `layerChoiceConstraint` pinning recipe (§5, resolved
      by using the union-graph approach), the "scrubber is ~200 lines" estimate (§5, budget a week),
      and the planner-model tier proposal (§6, which is a measurement plan and not a finding).

## User stories

### KAR-11.1 — Plan compilation from spec, recon and capabilities

|                 |                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                                                         |
| **Priority**    | P0                                                                                                                                  |
| **Size**        | L                                                                                                                                   |
| **Depends on**  | KAR-10.4 (the pinned spec), KAR-10.5 (recon facts), KAR-05.2 (probed capabilities), KAR-02.3 (`PlanGraph` and the seven node types) |
| **PRD**         | F2.1, F2.2, F2.3, F3.5, F6.1, NF8                                                                                                   |
| **Verified by** | EPIC-11-S1, EPIC-11-S2, EPIC-11-S3, EPIC-11-S4, EPIC-11-S5                                                                          |

**As** the operator, **I want** the planner to compile the approved spec, what recon actually found
and the providers actually installed into a versioned JSON graph, **so that** the plan is a document
I can read, diff and argue with rather than a TypeScript file an LLM wrote once.

[06 §2](../../06-planning-and-replanning.md) is precise about the inputs and unusually blunt about
which one people get wrong: the planner receives _"exactly three things, and nothing else"_ — the
pinned `TaskSpec`, the recon survey, and **the provider capability list read from the
`provider_capabilities` row, never a constant**. Its output is a `PlanGraph` v1 whose nodes each
carry, at minimum, `id`, `type`, `deps`, declared `reads` and `writes`, `pathScope`, `permission`,
`provider` requirements, `returns: { schemaId, maxTokens }` and `maxAttempts`. The document is
immutable and content-addressed with sha256 over a canonical JSON encoding DeFlow owns.

Two hard prohibitions attach. **Do not accept a prose plan** — enforce the schema at the adapter
boundary, because _"a regex over prose is how the planner layer starts breaking on every CLI
update"_. And **do not let the planner see another node's transcript** (F6.1) — it gets the spec,
the recon output and the capability list, _"so that the edges in the plan graph mean something"_.

**Acceptance criteria**

1. The planner node's packet contains exactly three input segment groups — pinned spec, recon facts,
   capability list — plus the pinned safety segments. A golden-file snapshot asserts there is no
   `history.summary` segment sourced from any other node.
2. The capability list is materialised from `SELECT … FROM provider_capabilities` rows at plan time.
   A CI grep proves no source file contains a literal capability table keyed by provider name.
3. The `PlanGraph` is returned as structured output through `--json-schema` (Claude Code) or
   `--output-schema <FILE>` (Codex) and validated with Ajv 8.20.0 (`strict: true`,
   `allErrors: true`). Prose is never parsed; a prose return fails the node with
   `contract.schema-invalid`.
4. `planHash` is `sha256` over DeFlow's own canonical JSON (recursively sorted keys, no insignificant
   whitespace, `undefined` omitted), computed with `node:crypto`. Two structurally identical graphs
   with different key order hash identically. `ohash` is not used.
5. The graph is persisted to `plan(hash, run_id, created_at, doc)` **and** to
   `.DeFlow/runs/<runId>/plan/v1.json`, and `plan.proposed { version, planHash, graph, by }` is
   appended in the same transaction.
6. `plan.proposed` records `planner.model`, `planner.effort` and `planner.tier`, so
   [06 §6](../../06-planning-and-replanning.md)'s measurement plan (which model should plan?) is
   answerable from the ledger later without a schema change.
7. All seven node types (`agent`, `tool`, `gate`, `human`, `map`, `loop`, `subgraph`) round-trip
   through the schema, and a graph using a type the schema does not know fails validation rather
   than being dropped.
8. Where the adapter exposes a reasoning-effort control, the initial plan uses the strongest
   available setting — Claude Code accepts `--effort low|medium|high|xhigh|max` — resolved against
   the probed row, not a constant.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                   | Red when                                                        |
| --- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1   | unit        | `canonicalJson` over two key-order-shuffled equivalents produces identical bytes; `planHash` matches a committed golden hex string     | The encoder relies on `JSON.stringify` key order                |
| 2   | unit        | A graph containing all seven node types validates; one with `type: 'workflow'` fails naming the path                                   | The schema is permissive                                        |
| 3   | integration | `deflow-mock-agent --seed` returns a valid `PlanGraph` → `plan.proposed` with the hash, the `plan` row and `plan/v1.json` all agreeing | The three writes are not one transaction                        |
| 4   | integration | Mock agent returns a markdown plan with a fenced JSON block → node fails `contract.schema-invalid`, no extraction attempted            | A JSON-block fallback exists                                    |
| 5   | integration | Planner packet golden snapshot → three input groups, no foreign transcript                                                             | Context is inherited                                            |
| 6   | unit        | Capability list built from two seeded `provider_capabilities` rows; deleting a row changes the list                                    | Capabilities are cached in a constant                           |
| 7   | integration | `plan.proposed` payload contains `planner.model`, `planner.effort`, `planner.tier`                                                     | The measurement fields are added later, which needs an upcaster |
| 8   | integration | An adapter whose probed row lacks structured output → the planner node is refused with `adapter.capability-missing`                    | The planner falls back to prose                                 |

**Notes / risks** — [06 §6](../../06-planning-and-replanning.md) is explicit that the planner-tier
proposal (strongest model for v1 and for high-blast-radius patches, cheap model for routine ones) is
**Unverified** — _"a proposal with a measurement plan attached, not a finding"_. AC 6 exists purely
so the measurement is possible later; do not build tier-switching logic in M1 beyond honouring the
configured effort.

---

### KAR-11.2 — Plan validation before execution

|                 |                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| **Status**      | Not started                                                                                                  |
| **Priority**    | P0                                                                                                           |
| **Size**        | M                                                                                                            |
| **Depends on**  | KAR-11.1, KAR-09.1 (`validateDeclaredReads`), KAR-05.2, KAR-07.1 (the `Git` wrapper, for `check-ref-format`) |
| **PRD**         | F2.2, F3.5, F5.4, F6.2, F7.4, F9.3                                                                           |
| **Verified by** | EPIC-11-S6, EPIC-11-S7, EPIC-11-S8, EPIC-11-S9, EPIC-11-S10, EPIC-11-S11, EPIC-11-S12, EPIC-11-S18           |

**As** the operator, **I want** every plan version checked for unreachable reads, cycles, unusable
node ids, uncovered criteria and adapters that cannot honour what the plan asks of them, **so that**
a structurally impossible plan costs milliseconds instead of three hours and forty nodes of quota.

This is [06 §3](../../06-planning-and-replanning.md) implemented literally, and it is _"the cheapest
correctness gate in the system"_. One topological walk produces four checks:

- **Reachability** — every declared `read` satisfied by a transitive ancestor's declared `write` or
  by the pinned spec's `providedKeys`, else `READ_UNREACHABLE` with the message
  `node '<id>' reads '<key>' but no ancestor writes it and it is not in the pinned spec`.
- **Cycles** — `topoSort` throwing `PlanCycleError` _is_ the check.
- **Orphan writes** — a key nothing reads is a `warning`, not an error; it is usually a leftover
  from a patch and occasionally deliberate.
- **Identifiers** — node ids become branch names, worktree directory names, artifact paths and URL
  segments, so validate the ref with git itself
  (`git check-ref-format "refs/heads/DeFlow/${runId}__${nodeId}"`) and then apply the stricter
  `/^[a-z0-9][a-z0-9._-]{0,62}$/`, rejecting duplicates **case-insensitively**.

The capability half (§3.2) is the one that stops F5.4's promise from being decorative: _"where a
provider cannot express the requested permission level, DeFlow refuses to schedule rather than
silently escalating"_, and `PERMISSION_UNSUPPORTED` is that refusal moved to plan time where it costs
nothing. `NO_RESUME` is deliberately **soft** — a node that merely benefits from resume falls back to
`ResumeByReplay`; it is hard only for nodes declaring `requiresResume`.

Diagnostics are events, not exceptions. A failing v1 goes back to the planner once; a second failure
escalates to a `human` node with the diagnostics rendered. **A failing patch is rejected outright,
never partially applied.**

**Acceptance criteria**

1. `validatePlan(plan, spec, caps)` returns a `Diagnostic[]` with `severity`, `code`, `node`, `key`
   and `message`, and returns **all** diagnostics rather than the first.
2. An undeclared read produces `READ_UNREACHABLE` with the exact message text above, naming the node
   and the key.
3. A cyclic graph produces a diagnostic derived from `PlanCycleError` naming the nodes on the cycle;
   `topoSort` is the only cycle detector, not a second implementation.
4. A node whose write no node reads produces `severity: 'warning'`, and warnings never block
   execution.
5. Capability checks read the probed `provider_capabilities` row and emit `PROVIDER_NOT_PROBED`,
   `NO_STRUCTURED_OUTPUT`, `NO_RESUME`, `PERMISSION_UNSUPPORTED` or `PACKET_EXCEEDS_BUDGET`.
   `PACKET_EXCEEDS_BUDGET` fires when `estimatePacketTokens(node) > caps.maxContext * 0.6`.
6. `NO_RESUME` is an error only when the node declares `requiresResume`; otherwise it is a warning
   and the node is annotated to use `ResumeByReplay`.
7. Node ids are validated by invoking real `git check-ref-format` on
   `refs/heads/DeFlow/<runId>__<nodeId>` **and** by the DeFlow charset regex, with case-insensitive
   duplicate rejection. A regression test asserts the PRD's `DeFlow/<runId>/<nodeId>` scheme is
   refused.
8. Criteria coverage: every criterion in the pinned spec is named by at least one `gate` node's
   `satisfies`/`criteria` list, or is marked `unverifiable`. A miss is an error naming the criterion.
9. Validation runs on `plan.proposed` **and** on every patched plan before the patch is committed.
   A test proves there is no code path that persists a `plan` row without validating.
10. A failing v1 produces a `plan.proposed` retry carrying the diagnostics as planner input, exactly
    once; a second failure appends `run.needs_human` with the diagnostics rendered.
11. A failing patch is rejected whole — the base plan remains `run.plan_hash` and no partial ops
    were applied.
12. A 400-node `map` fan-out validates in under 100 ms, including the capability pass.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                                                              | Red when                                                   |
| --- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | unit        | Two-node plan, `implement` reads `finding/*`, `recon` writes it → `[]`; remove the edge → one `READ_UNREACHABLE` with the exact message string                                                                    | The validator does not exist                               |
| 2   | unit        | A three-node cycle → a diagnostic naming all three; assert `topoSort` threw `PlanCycleError`                                                                                                                      | Cycles are detected by a second, divergent implementation  |
| 3   | unit        | A node writing `finding/unused` that nothing reads → one `severity: 'warning'`, and `validatePlan` still reports the plan runnable                                                                                | Orphan writes block execution                              |
| 4   | unit        | Table-driven capability matrix seeded from the 2026-08-02 fixture: a node with `requiresResume` on a `copilot --acp` 1.0.77 row → `NO_RESUME` error; the same node with `resume: 'native-if-available'` → warning | Resume support is assumed uniform                          |
| 5   | unit        | `permission: 'worktree'` against a row whose `permissionLevels` omits it → `PERMISSION_UNSUPPORTED`                                                                                                               | The ladder silently escalates                              |
| 6   | unit        | `estimatePacketTokens` returning 61% of `maxContext` → `PACKET_EXCEEDS_BUDGET`; 59% → clean                                                                                                                       | The 0.6 ceiling is not applied                             |
| 7   | integration | Real `git check-ref-format` against `refs/heads/DeFlow/r1__n1` (exit 0) and against a node id containing `:` (non-zero)                                                                                           | Ref rules are reimplemented in TypeScript                  |
| 8   | integration | Regression: a plan built with `DeFlow/<runId>/<nodeId>` and a run-level `DeFlow/<runId>` integration branch → refused, with the reason naming the directory/file conflict                                         | Somebody reintroduces the PRD's scheme                     |
| 9   | unit        | Node ids `Recon` and `recon` in one plan → duplicate diagnostic (case-insensitive)                                                                                                                                | Duplicates are compared case-sensitively                   |
| 10  | unit        | A spec with AC-5 covered by no gate node and not `unverifiable` → one coverage error naming AC-5                                                                                                                  | Coverage is checked only at the spec, not against the plan |
| 11  | integration | A patch introducing an undeclared read → `plan.patch.rejected` with the code, `run.plan_hash` unchanged, no new `plan` row                                                                                        | The patch is applied and then validated                    |
| 12  | integration | v1 fails → one planner retry with diagnostics in the packet; the retry fails → `run.needs_human`                                                                                                                  | The retry loop is unbounded                                |
| 13  | unit        | 400-node fan-out validates in < 100 ms                                                                                                                                                                            | Ancestor sets are recomputed per read                      |

**Notes / risks** — the whole story is worth about three days and prevents a category of failure that
costs hours each time, which makes it the best value in the epic. The one trap is _"do not skip
validation on patched plans"_: v1 validation is the obvious case, but _"the patch that adds a node
reading a key nothing writes is the one that actually bites, because it happens at node 27 of 40"_.
AC 9's structural assertion — one entry point, always validated — is what keeps that true after six
months of edits.

---

### KAR-11.3 — Runtime plan mutation via PlanPatch

|                 |                                                                                                           |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                                               |
| **Priority**    | P0                                                                                                        |
| **Size**        | L                                                                                                         |
| **Depends on**  | KAR-11.2, KAR-05.6 (the MCP host), KAR-03.3 (the atomic append), KAR-02.1 (the stable-`NodeId` invariant) |
| **PRD**         | F2.4, F2.6, NF9, NF10                                                                                     |
| **Verified by** | EPIC-11-S13, EPIC-11-S14, EPIC-11-S15, EPIC-11-S16, EPIC-11-S17, EPIC-11-S18                              |

**As** a running node that has just learned something the plan did not anticipate, **I want** to
propose a structured change to the graph and have it evaluated, **so that** the run adapts instead of
failing or quietly doing the wrong thing.

[06 §4](../../06-planning-and-replanning.md) defines the whole lifecycle. Any node may propose;
`agent` nodes do it through the `DeFlow.propose_plan_patch` MCP tool exposed by DeFlow's own stdio
MCP server and injected into the session via ACP `session/new`, _"so a malformed proposal fails at
the tool boundary rather than in the policy engine"_. Four properties fall out of the design and all
four matter:

- **Plans are never mutated.** A patch produces a _new_ immutable row; the old version is still
  addressable by hash and still renderable.
- **Application is atomic with the event append.** One SQLite transaction inserting the `plan` row,
  updating `run.plan_hash` and appending `plan.patched`, so a crash mid-apply leaves either the old
  plan and no event or the new plan and its event — never a torn state.
- **`basePlanHash` gives optimistic concurrency.** A stale proposal is rejected with `PATCH_STALE`
  and the proposer re-derives. _"Do not attempt automatic rebasing — the proposer had a reason based
  on a graph that no longer exists."_
- **Rejections are recorded too**, because _"the run silently decided not to do the thing it decided
  to do"_ is unanswerable, and NF10 requires every UI state to trace to events.

The `NodeId` invariant from [04 §1.1](../../04-domain-model.md) is enforced here: a patch may change
anything about a node **except its id**. `split-node` and `abandon-branch` **retire** ids — the node
stays in the graph with `lifecycle: 'superseded' | 'abandoned'` and its successors carry
`derivedFrom`. A renamed node renders in the scrubber as a delete plus an insert, _"which is exactly
the wrong story to tell about a plan that was merely edited"_.

**Acceptance criteria**

1. `DeFlow.propose_plan_patch` is exposed through DeFlow's stdio MCP server, injected via
   `session/new`'s `mcpServers`, and takes the patch as structured input validated against
   `DeFlow.planpatch.v1`. A malformed proposal fails at the tool boundary with a schema error the
   agent can act on, and never reaches the policy engine.
2. All five `PatchOp` kinds apply correctly: `insert-nodes`, `split-node`, `replace-provider`,
   `extend-loop`, `abandon-branch`.
3. `plan.patch.proposed { patch }` is appended for **every** proposal, including ones that will be
   rejected.
4. Application is one SQLite transaction: `INSERT INTO plan`, `UPDATE run SET plan_hash = ?`,
   `INSERT INTO event` (`plan.patched`). The crash-fuzz harness includes a kill point inside it.
5. No `plan` row is ever updated or deleted. A CI assertion proves the only statements against
   `plan` are `INSERT` and `SELECT`.
6. A proposal whose `basePlanHash` does not equal the current `run.plan_hash` is rejected with
   `PATCH_STALE`; no rebase is attempted, and the rejection tells the proposer the current hash.
7. Node ids are never reused: `split-node` retires the source id with `lifecycle: 'superseded'` and
   mints successors carrying `derivedFrom: [sourceId]`; `abandon-branch` sets
   `lifecycle: 'abandoned'`. The retired id is never allocated again, including after a later replan.
8. Every applied patch is revalidated (KAR-11.2) **before** the transaction commits; a validation
   failure rejects the whole patch.
9. `reason` is required and non-empty on every patch, is stored verbatim, and is never summarised or
   rewritten anywhere in the pipeline.
10. Two patches proposed concurrently against the same base produce one applied and one
    `PATCH_STALE` — never two applied, never a merged graph.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                              | Red when                                |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| 1   | unit        | `applyOps(base, ops)` for each of the five op kinds → golden-file snapshot of the resulting graph                                                                                 | The applier does not exist              |
| 2   | unit        | `split-node` retires the source with `lifecycle: 'superseded'` and successors carry `derivedFrom`                                                                                 | Split deletes the node                  |
| 3   | unit        | Any op attempting to change a node's `id` is rejected before the policy engine sees it                                                                                            | Renaming is allowed                     |
| 4   | integration | Mock agent calls `DeFlow.propose_plan_patch` with a malformed patch → an MCP tool error, no `plan.patch.proposed` event with an invalid body                                      | Validation happens in the policy engine |
| 5   | integration | Valid patch → `plan.patch.proposed`, then `plan.patched` with the new hash, and the old hash still `SELECT`s from `plan`                                                          | Rows are mutated in place               |
| 6   | integration | Stale `basePlanHash` → `PATCH_STALE`, `run.plan_hash` unchanged, and the response carries the current hash                                                                        | Auto-rebase is attempted                |
| 7   | integration | Two proposals against the same base applied concurrently (`pool: 'forks'`) → exactly one `plan.patched`, one `PATCH_STALE`                                                        | Concurrency is unguarded                |
| 8   | crash-fuzz  | `kill -9` inside patch application, restart over the same file → either (old plan, no event) or (new plan, event); never both halves torn, and `PRAGMA integrity_check` is `'ok'` | Application spans two transactions      |
| 9   | integration | A patch whose inserted node reads an unwritten key → rejected whole, `run.plan_hash` unchanged                                                                                    | Ops are applied then validated          |
| 10  | unit        | A patch with `reason: ''` fails schema validation                                                                                                                                 | `reason` is optional                    |

**Notes / risks** — the concurrency case (AC 10) is more real than it looks even for a single-user
tool: two `map` children finishing within the same tick can both propose. The rule is deliberately
crude — one wins, the other re-derives — because _"the proposer had a reason based on a graph that no
longer exists"_, and a rebase would silently apply that reason to a graph it was never about.

---

### KAR-11.4 — The patch policy engine

|                 |                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Status**      | Not started                                                                                                        |
| **Priority**    | P0                                                                                                                 |
| **Size**        | M                                                                                                                  |
| **Depends on**  | KAR-11.3, KAR-06.8 (`RunState.circuitBreaker`), KAR-14.3 (the pre-flight estimate feeding `estimatedCostDeltaUsd`) |
| **PRD**         | F2.5, F4.7, F5.4, F5.6, F9.3, NF10                                                                                 |
| **Verified by** | EPIC-11-S19, EPIC-11-S20, EPIC-11-S21, EPIC-11-S22, EPIC-11-S23, EPIC-11-S24, EPIC-11-S25                          |

**As** the operator, **I want** each proposed patch auto-applied, queued for me, or rejected by
declarative rules I can read, **so that** the run adapts freely where it is cheap and safe, and stops
to ask where it is neither.

[06 §4.3](../../06-planning-and-replanning.md) specifies a **declarative, ordered, first-match-wins**
rule table living in `.DeFlow/config.yaml` under `policy.patch` and **hashed into the run manifest**,
so a mid-run edit of the config cannot silently change the rules a live run is playing by. Five
dimensions feed it: cost delta, blast radius, replan depth, elapsed budget, and permission
escalation. The default table matches F2.5's stated defaults exactly, including the thresholds
`replanDepth > 3`, `elapsedBudgetFraction >= 1.0`, `costDeltaUsd > 5.00` and `blastRadiusFiles > 25`
— and its last arm is **`approve`, not `auto`**: _"anything the rules do not recognise goes to a
human."_

The story's sharpest requirement is the interaction with no-progress detection, which
[06 §7](../../06-planning-and-replanning.md) calls _"the sharpest edge in the whole design, and
getting it backwards is expensive"_:

```ts
function decidePatch(p: PlanPatch, s: RunState): Decision {
  if (s.circuitBreaker === "tripped" && p.proposedBy !== "human") {
    return { decision: "reject", ruleId: "circuit-breaker-tripped" };
  }
  return evaluateRules(p, s);
}
```

A churning run's instinct is to replan; that is precisely the behaviour to stop. Human-authored
patches still apply — _"that is how the run is rescued"_ — and a human patch also resets the breaker,
because a human-supplied insight invalidates the sliding window.

**Acceptance criteria**

1. `decidePatch(patch, state)` is a **pure function** in `@DeFlow/core`: no clock, no I/O, no
   database. Every input it needs is in the patch's `policy` block or the reduced `RunState`.
2. Rules are evaluated in declared order and the **first match wins**; the returned decision carries
   the `ruleId` that fired, and that id is recorded on `plan.patched` / `plan.patch.rejected`.
3. The eight default rules and their thresholds are implemented exactly as
   [06 §4.3](../../06-planning-and-replanning.md) states, and a config with no `policy.patch` block
   uses them.
4. **Auto path:** a read-only analysis insert with `costUsdDelta 0.40`, `blastRadiusFiles 0`,
   `maxPermission read`, `replanDepth 1` at 12% of budget matches `read-only-analysis` → `auto`, and
   `plan.patched { decision: 'auto', reason: <verbatim> }` is appended.
5. **Queue path:** a patch inserting a `worktree`-permission write node over 140 files with
   `costUsdDelta 6.20` and `replanDepth 2`, on a run whose ambient permission is `read`, matches
   `escalates-permission` **first** → `approve`. It lands in the approval queue with the estimate,
   the plan diff and the motivating findings. **The run does not stall on it if other branches are
   runnable** — the patch is pending, not the run.
6. **Reject path:** a patch with `replanDepth 4` matches `replan-depth-exceeded` → `reject`;
   `plan.patched { decision: 'rejected', reason, ruleId: 'replan-depth-exceeded' }` is appended and
   the run transitions to `needs_human`. The rejected patch remains visible in the approval queue so
   a human can approve it explicitly — _"a rejection is a 'not without you', not a dead end."_
7. The `default` arm is `approve`. A patch matching nothing is queued for a human, never
   auto-applied.
8. **Circuit-breaker short-circuit:** with `state.circuitBreaker === 'tripped'`, every patch whose
   `proposedBy !== 'human'` is rejected with `ruleId: 'circuit-breaker-tripped'` — **including one
   that would otherwise match `read-only-analysis`**. A human-authored patch is evaluated normally,
   applies, and resets the breaker.
9. `touchesExecutionBoundary` (F5.6's deny list — infrastructure, deploy, migrations against
   non-local databases, destructive commands) routes to `approve` regardless of cost or blast radius.
10. The policy table's hash is recorded in the run manifest at run start; editing
    `.DeFlow/config.yaml` mid-run does not change the rules applied to that run, and the mismatch is
    surfaced rather than silently ignored.
11. A patch whose `policy` block cannot be filled in (a missing `estimatedCostDeltaUsd`, a missing
    `replanDepth`) is rejected at validation. The five fields are mandatory, not advisory.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                         | Red when                                                     |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | unit        | `decidePatch` purity: deep-frozen inputs, two calls, deeply equal results, no port constructed                               | It reads config from disk                                    |
| 2   | unit        | The three worked examples from 06 §4.3, asserting `ruleId` as well as decision                                               | Thresholds are off by one, or `>` is `>=`                    |
| 3   | unit        | A patch matching both `expensive` and `escalates-permission` returns `escalates-permission`                                  | Rules are evaluated as a set, not in order                   |
| 4   | unit        | **Breaker tripped + a `read-only-analysis`-matching patch → `reject`, `ruleId: 'circuit-breaker-tripped'`**                  | The short-circuit is placed after `evaluateRules`            |
| 5   | unit        | Breaker tripped + `proposedBy: 'human'` → evaluated normally; applying it clears `circuitBreaker`                            | Human patches are also blocked, so the run cannot be rescued |
| 6   | unit        | An unrecognised patch → `approve` via the `default` rule, never `auto`                                                       | The default arm is `auto`                                    |
| 7   | unit        | `touchesExecutionBoundary: true` with `costUsdDelta 0.10` and `blastRadiusFiles 0` → `approve`                               | Cheap boundary-touching patches slip through                 |
| 8   | integration | Queue path: the patch is queued, `plan.patched` records `queued`, and an unrelated runnable branch continues to be scheduled | The whole run blocks on a pending patch                      |
| 9   | integration | Reject path: `run.needs_human` is appended and the rejected patch is retrievable from the approval queue                     | The rejection is a dead end                                  |
| 10  | integration | Edit `.DeFlow/config.yaml` mid-run → the live run still uses the manifest-hashed table, and the mismatch is surfaced         | The engine re-reads config per patch                         |
| 11  | unit        | A patch missing `estimatedCostDeltaUsd` fails schema validation before `decidePatch` is reached                              | The policy block is optional                                 |

**Notes / risks** — test 4 is the single most important test in this epic and it exists because the
natural implementation puts `evaluateRules` first and the breaker check second, which produces a
system that responds to churn by replanning harder. Related and equally easy to get backwards:
[04 §5.2](../../04-domain-model.md)'s rule that on `fact.invalidated`, tainted downstream nodes are
**flagged, not auto-re-run** — _"automatic re-running on invalidation is a very efficient way to
build a loop that never terminates."_

---

### KAR-11.5 — Plan version retention and diffable history

|                 |                                       |
| --------------- | ------------------------------------- |
| **Status**      | Not started                           |
| **Priority**    | P0                                    |
| **Size**        | S                                     |
| **Depends on**  | KAR-11.3                              |
| **PRD**         | F2.6, F10.2, NF8, NF10                |
| **Verified by** | EPIC-11-S26, EPIC-11-S27, EPIC-11-S28 |

**As** the operator, **I want** every plan version kept and diffable against its predecessor,
**so that** _"why is there a step here that I didn't ask for?"_ is answerable in one click rather
than by archaeology.

[06 §5](../../06-planning-and-replanning.md) settles the storage argument so nobody is tempted to
prune: _"a 40-node plan serialises to roughly 30 KB. A run with the target 1–4 replans is under
200 KB of plan history; a pathological 12-version run is still under half a megabyte, and content
addressing deduplicates identical documents for free."_ Every version lives in SQLite as an immutable
`plan` row and on disk as `.DeFlow/runs/<runId>/plan/vN.json` (NF8).

Retention is what makes the marquee view possible at all, and this story owns the server-side half of
its contract: `GET /api/runs/:id/plans/diff?from=3&to=4` returning added/removed/changed/unchanged
node sets, RFC 6902 field-level patches (`rfc6902@5.3.0` — **not** `fast-json-patch`, which last
shipped in 2022), the `unionLayoutKey` cache key, and the `plan.patched` event's `reason` and
`decision` joined in. The `reason` is _rendered verbatim, never summarised_, because the full answer
to the "why" question is _who proposed it, why, what the estimate was, which policy rule fired, and
whether a human approved it_.

**Acceptance criteria**

1. Every plan version is retained for the life of the run in both stores; nothing prunes, compacts or
   garbage-collects either. A CI assertion proves no `DELETE FROM plan` exists.
2. Two identical plan documents produced at different times deduplicate to one `plan` row by content
   hash, and both versions still resolve.
3. `GET /api/runs/:id/plans/diff?from=N&to=M` returns `nodes.added/removed/changed/unchanged`,
   `edges.added/removed`, `unionLayoutKey`, `reason` and `decision`, with `changed` entries carrying
   an RFC 6902 patch array.
4. `unionLayoutKey` is a **cache key, not coordinates** — of the form
   `<runId>:union:v<from>-v<to>` — and the layout itself is computed client-side.
5. The `reason` string returned is byte-identical to the one on the `plan.patched` event. Nothing in
   the API path truncates, summarises or re-cases it.
6. Node identity across versions is `NodeId` and nothing else, so a node whose provider changed
   appears in `changed` with a `/provider` patch, never as a removed-plus-added pair.
7. A rejected patch is still visible in the history: the diff endpoint reports no new version, and
   the `plan.patch.rejected` event carries the rule and the proposal.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                | Red when                                                             |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | integration | Apply three patches → four `plan` rows, four `plan/vN.json` files, `run.plan_hash` pointing at the last                                                             | Versions overwrite                                                   |
| 2   | integration | A patch that produces a byte-identical document → one new row is not created; both versions resolve to the same hash                                                | Content addressing is not used                                       |
| 3   | integration | `plans/diff?from=3&to=4` for a `replace-provider` patch → `changed: [{ id, patch: [{op:'replace', path:'/provider', value:'codex'}] }]` and empty `added`/`removed` | Identity is by object equality, so the node reads as removed + added |
| 4   | unit        | `reason` round-trips byte-identically from the event to the API response, including newlines and quotes                                                             | The API re-serialises through a template                             |
| 5   | integration | A 12-version run → total plan storage under 512 KB on disk                                                                                                          | Something is storing rendered graphs rather than documents           |
| 6   | integration | A rejected patch → no new version, and the rejection retrievable with its `ruleId`                                                                                  | Rejections are dropped                                               |

**Notes / risks** — the elkjs `layerChoiceConstraint` / `positionChoiceConstraint` pinning recipe
does **not** work as commonly written, and [06 §5](../../06-planning-and-replanning.md) is explicit
that _"the union-graph-laid-out-once approach is the load-bearing design"_. That is EPIC-17's
problem, but AC 4 is what keeps it possible: the server must hand the client a stable cache key for a
union layout, not per-version coordinates. Also carried forward: _"the scrubber is about 200 lines"_
is **Unverified** and looks optimistic — budget a week, not an afternoon.

---

### KAR-11.6 — Provider re-routing recorded as a patch

|                 |                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------- |
| **Status**      | Not started                                                                              |
| **Priority**    | P1                                                                                       |
| **Size**        | M                                                                                        |
| **Depends on**  | KAR-11.4, KAR-05.2 (probed capabilities for the superset check), KAR-06.6 (durable wake) |
| **PRD**         | F3.9 (P1), F4.8, NF7                                                                     |
| **Verified by** | EPIC-11-S29, EPIC-11-S30, EPIC-11-S31                                                    |

**As** the operator, **I want** a provider running out of quota to move the node to a healthy
provider — or to wait durably if none is suitable — and to see that decision in the plan history,
**so that** one vendor's rate limit degrades the run instead of killing it, and I can see why the
graph changed.

[06 §4.4](../../06-planning-and-replanning.md) is emphatic that _"the scheduler does not silently
swap providers"_. It proposes a `replace-provider` op through the same policy engine and produces the
same `plan.patched` event, _"so the swap appears in the visualisation — which is the entire point of
F3.9's wording."_ One extra rule makes the common case frictionless without weakening the model:

```yaml
- id: quota-reroute-equivalent
  when:
    {
      onlyOps: [replace-provider],
      cause: quota,
      capabilitySuperset: true,
      permissionUnchanged: true,
    }
  decision: auto
```

`capabilitySuperset` is computed from the **probed rows** — the target adapter's capability set must
cover everything the node requires. A reroute onto a weaker adapter is not equivalent and is not
auto.

When **no** healthy provider satisfies the node, the rule reverses: _"do not reroute — suspend."_
Write `node_wake(run_id, node_id, wake_at = resetsAt, reason = 'quota')` and let the tick loop pick
it up. NF7's _"one provider unavailable degrades the plan rather than killing the run"_ is
implemented by a durable row and nothing else — **never `setTimeout`**, whose maximum delay is
`2^31-1 ms` and which, given `2**31`, **fires the callback after 1 ms** with only a
`TimeoutOverflowWarning`. Timers also do not fire during laptop sleep and do not survive a restart.

**Acceptance criteria**

1. Claude Code's `{"type":"rate_limit_event","rate_limit_info":{…}}` frame is parsed into
   `provider.rate_limited { provider, resetsAt, raw }`, and non-retryable rate-limit exits from
   other adapters produce the same event.
2. On rate limiting, the **scheduler** proposes a `replace-provider` patch with
   `proposedBy: 'scheduler'` and a `cause` of `quota`, carrying a non-empty `reason`.
3. `capabilitySuperset` is computed by comparing the node's `AdapterRequirement[]` against the
   target's probed `provider_capabilities` row. A superset with an unchanged permission level matches
   `quota-reroute-equivalent` → `auto`.
4. A reroute onto an adapter that is **not** a superset does not match the rule and falls through to
   the remaining rules — in practice `default` → `approve`.
5. When no healthy provider satisfies the node's requirements, **no reroute is proposed**. Instead a
   `node_wake` row is written with `wake_at = resetsAt` and `reason = 'quota'`, and
   `node.suspended` is appended.
6. No code path uses `setTimeout` for a quota wait. A CI grep enforces it, and a test with a
   `wake_at` more than `2^31` ms in the future proves the wait is honoured rather than firing
   immediately.
7. The reroute is visible: `plan.patched` carries the reason and `decision: 'auto'`, and the diff
   endpoint reports the node as `changed` with a `/provider` replace patch.
8. A suspended node resumes when the tick loop finds `wake_at <= now`, on the original provider if it
   is healthy again, and the resumption is recorded.

**Test plan (TDD)** — write these first, in this order, and watch each fail.

| #   | Level       | Test                                                                                                                                                                                       | Red when                                                        |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 1   | unit        | Parse a committed `rate_limit_event` fixture frame → `provider.rate_limited` with `resetsAt`                                                                                               | The frame shape is assumed rather than read from the fixture    |
| 2   | unit        | `capabilitySuperset(node, targetRow)` over the 2026-08-02 matrix: `claude-agent-acp` → `codex-acp` for a node requiring `session.fork` is **not** a superset (codex advertises `fork: no`) | Superset is computed from a hardcoded table                     |
| 3   | integration | Superset reroute → `plan.patched { decision: 'auto', ruleId: 'quota-reroute-equivalent' }` and the node runs on the new provider                                                           | The scheduler swaps the provider without a patch                |
| 4   | integration | Non-superset reroute → queued for approval, not auto                                                                                                                                       | The rule matches on `cause` alone                               |
| 5   | integration | No healthy provider → no patch proposed; one `node_wake` row with `reason = 'quota'` and `wake_at = resetsAt`; `node.suspended` appended                                                   | The scheduler reroutes onto a provider that cannot run the node |
| 6   | integration | `wake_at = now + 2**31 + 1000` ms; advance the TestClock past it → the node wakes then, not 1 ms later                                                                                     | `setTimeout` is used and silently overflows                     |
| 7   | integration | Kill the daemon while suspended on quota, restart → the `node_wake` row survives and the node still wakes at `resetsAt`                                                                    | The wait lives in memory                                        |
| 8   | integration | `plans/diff` after a reroute → `changed` with a `/provider` patch and the verbatim reason                                                                                                  | The swap is invisible in the history                            |

**Notes / risks** — F3.9 is **P1**, which makes this the epic's natural cut candidate (see Risks).
Cutting it costs the auto-reroute; it must **not** cost the suspend path, because
`node_wake(reason='quota')` is what stops a rate-limited run from failing outright and NF7 is P0.
If the story is trimmed, keep AC 5, AC 6 and AC 8 and drop the superset auto-apply.

## Risks

| Risk                                                                                                                                                                                                                                                                                                               | Severity          | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The epic totals ~16 days, over the ~15-day solo-builder guidance**, and it sits on the critical path between W6 and W9.                                                                                                                                                                                          | High              | Explicit cut order: **KAR-11.6's auto-reroute half** (F3.9 is P1; keep the durable quota suspend, which NF7 needs), then **KAR-11.5's diff endpoint** down to raw version retrieval with the client diffing (retention itself is never cut — it is what makes F10.2 possible), then **KAR-11.1 AC 8's effort control**. That reclaims ~3 days. **KAR-11.2 and KAR-11.4 are never cut**: the first is the cheapest gate in the system and the second is the only control on runaway cost and permission escalation. |
| **The `PatchOp` vocabulary differs between two architecture documents** — [04 §4](../../04-domain-model.md) uses `insert-nodes` / `split-node` / `replace-provider` / `extend-loop` / `abandon-branch`; [06 §4.1](../../06-planning-and-replanning.md) uses `insert` / `split` / `reroute` / `extend` / `abandon`. | **High** (silent) | Resolve in `KAR-02.4` before this epic starts; 04's names are canonical because they are the schema. Two vocabularies would not fail loudly — the reducer ignores unknown kinds by design and Ajv would reject at a layer nobody watches during a demo.                                                                                                                                                                                                                                                            |
| **Getting the churn interaction backwards is the expensive failure**, and the natural implementation ordering produces it.                                                                                                                                                                                         | **High**          | `KAR-11.4` AC 8 and its test 4, promoted to the epic's Definition of Done. Assert the _rejection of an otherwise-auto patch_, not merely that the breaker exists. [PRD §12](../../prd.md) measures the consequence as _runs abandoned due to runaway loop_, target < 5%.                                                                                                                                                                                                                                           |
| **The capability matrix is a snapshot against five specific versions, two of which were published the same day they were probed** (roadmap A0-9, rated High and silent).                                                                                                                                           | **High**          | `KAR-11.2` reads the probed row and never a constant, and the matrix is committed as a **fixture** regenerated on every `deflow doctor`. The CI grep in the DoD is what keeps a "temporary" hardcoded table from surviving.                                                                                                                                                                                                                                                                                        |
| **The planner-model tier proposal is Unverified** ([06 §6](../../06-planning-and-replanning.md)) and is complicated by roadmap A0-11 (whether third-party agent paths meter against a separate credit pool).                                                                                                       | Medium            | Do not build tier-switching in M1. Record `planner.model` / `effort` / `tier` on every `plan.proposed` and `plan.patched` (KAR-11.1 AC 6) so the question is answerable from the cross-run dashboard later without a schema migration.                                                                                                                                                                                                                                                                             |
| **Replans are a metric, not a defect.** [PRD §12](../../prd.md) targets **1–4 per run**; the temptation on seeing a replan is to tighten the policy until there are none.                                                                                                                                          | Medium            | _"Zero replans means the plan was static, which is the thing DeFlow exists not to be. Above four means the framing interview under-delivered."_ Treat a persistently-zero replan count as a signal to look at EPIC-10, not at the policy table.                                                                                                                                                                                                                                                                    |
| **`PACKET_EXCEEDS_BUDGET` depends on `estimatePacketTokens`, whose accuracy is a known 15–20% undercount on Claude prose and worse on code** ([04 §8](../../04-domain-model.md)).                                                                                                                                  | Medium            | Use EPIC-09's calibrated `tokenEstimateFactor` rather than the raw estimate, and keep the 0.6 ceiling deliberately conservative. A false positive costs a re-plan; a false negative costs a mid-run context blowout at node 27.                                                                                                                                                                                                                                                                                    |
| **The plan-evolution scrubber's cost is underestimated in the source material** — _"about 200 lines"_ is **Unverified** and [roadmap §3](../../17-roadmap.md) says it _"looks optimistic given the pieces involved"_.                                                                                              | Medium            | Not this epic's build, but this epic's contract. `KAR-11.5` AC 4 and AC 6 (stable ids, union layout key, `changed` rather than remove+add) are what stop EPIC-17 from paying that cost twice. Budget the scrubber as a week in EPIC-17.                                                                                                                                                                                                                                                                            |
| **Patch application concurrency is real even for one user** — two `map` children can propose within the same tick.                                                                                                                                                                                                 | Low               | `basePlanHash` + `PATCH_STALE`, tested under `pool: 'forks'`. Explicitly no automatic rebasing.                                                                                                                                                                                                                                                                                                                                                                                                                    |

---

**Related:** [Flows](../flows/EPIC-11-dynamic-planning-flows.md) · [Board](../board.md) ·
[06-planning-and-replanning.md](../../06-planning-and-replanning.md) ·
[04-domain-model.md](../../04-domain-model.md) ·
[05-durable-execution.md](../../05-durable-execution.md) ·
[EPIC-10 task intake](./EPIC-10-task-intake.md) ·
[EPIC-06 orchestrator](./EPIC-06-orchestrator.md) ·
[EPIC-09 context and memory](./EPIC-09-context-memory.md) ·
[EPIC-17 P0 views](./EPIC-17-p0-views.md)

[← Back to the delivery plan](../README.md)
