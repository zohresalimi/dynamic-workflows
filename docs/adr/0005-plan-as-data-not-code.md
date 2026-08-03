# ADR 0005: The plan is data, not code

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

Open Dynamic Workflow is the right *shape* and the wrong *depth* (PRD §3.3). Its most instructive
flaw is gap G1: "dynamic" is a misnomer. The dynamism is entirely at **authoring** time — an AI
writes a TypeScript workflow file. Once written, the graph is frozen. There is no mechanism for a
running workflow to add a step, split a task, or change provider based on what it learned.
`loop()` with a `maxRounds` cap is the only runtime adaptivity it has.

That matters because the failure mode in the problem statement is exactly this: *the plan is fixed
too early*. Step 3 discovers the codebase is not what step 1 assumed, and a static graph has no way
to respond except fail (PRD §2.1). One of the six anchor use cases — a cross-cutting refactor with
unknown blast radius — is entirely about the plan changing as the true scope emerges.

The same problem shows up from the other direction in the durable-execution literature. Engines that
model workflows as *code* (Temporal, Restate, Inngest) must reconstruct implicit control flow by
replaying that code, which forces determinism constraints on the workflow author and creates the
"cannot change workflow code while runs are in flight" problem.

And the third pressure: F10.2, the plan-evolution scrubber, is the marquee feature. Being able to
drag back through plan versions and see a rendered diff of every patch, with the reason it was
proposed, is only possible if a plan version is a document you can diff. You cannot diff two
compiled TypeScript files usefully.

## Decision

**The `PlanGraph` is a versioned JSON document. Not a TypeScript file, not a compiled artefact, not
a function.** (F2.1 — "the central departure from ODW")

- The graph is **immutable and content-addressed**. A plan version is a row in the `plan` table
  keyed by hash. A replan does not mutate anything: it writes a *new* plan row and appends a
  `plan.patched` ledger event referencing it. Every plan version is therefore retained for free
  (F2.6), which is the scrubber's entire data requirement.
- **Node identity is `nodeId`, assigned by the planner and stable across patches.** Never derived
  from position, label, or execution order. This is an explicit contract in the `PlanGraph` schema:
  if the planner ever reuses or renumbers ids, both replan and the scrubber break.
- **Runtime mutation happens through typed `PlanPatch` documents** (F2.4). Any node may propose:
  insert nodes, split a node, replace a node's provider, extend a loop budget, or mark a branch
  abandoned. Each patch is auto-applied, queued for approval, or rejected by the declarative patch
  policy engine (F2.5) on cost delta, blast radius, replan depth and permission escalation.
- **Node content is hashed** over the fields whose change matters (type, provider, permission,
  brief, `reads[]`, `writes[]`, retry policy), using `ohash@2.0.11` for stable key ordering, which
  `JSON.stringify` does not give you. **Verified 2026-08-02** that its `serialize` sorts keys.
  Its README promises only "best efforts" at stable serialisation — fine for change detection, not
  for anything requiring cryptographic stability across versions.
- **Declared `reads`/`writes` are validated at plan time** by walking the DAG: every node's declared
  reads must be satisfied by some ancestor's declared writes, or by the pinned spec (F6.2). An
  undeclared read fails validation before a single token is spent.

Mechanism detail lives in [06-planning-and-replanning.md](../06-planning-and-replanning.md); the
document types are in [04-domain-model.md](../04-domain-model.md).

## Consequences

### Positive
- **The plan is diffable, patchable, serialisable and renderable** — the four properties F10.1,
  F10.2, F2.4 and F2.6 each need, and all four fall out of the same choice.
- **karvand is upgradeable mid-run.** Because control flow is data rather than code, there is no
  determinism constraint on the engine and no "workflow version" problem. This is what makes
  [ADR 0006](./0006-journaled-dag-state-machine-not-deterministic-replay.md) possible.
- The plan scrubber needs no bespoke persistence: "show me version N" is `replayTo(planVersionSeq[N])`
  against a projection that already exists.
- Plan templates (F2.8) are just parameterised documents, not a codegen problem.

### Negative
- **No arbitrary expressiveness.** A JSON graph cannot express "whatever TypeScript can". Every
  control-flow construct must be an explicit node type — `agent`, `tool`, `gate`, `human`, `map`,
  `loop`, `subgraph` (F2.3) — and adding a construct means changing the schema, the reducer, the
  scheduler and the renderer. This is a real cost and it is accepted deliberately: the primitive set
  is deliberately small, and ODW demonstrated it covers the patterns that matter.
- Planner output must be schema-valid JSON, so the planner node needs structured-output enforcement
  rather than "write me a file". Claude Code's `--json-schema` and Codex's `--output-schema` are the
  mechanism.
- Plans are verbose. A 40-node graph is a large document to render in a diff. Mitigated by the
  per-node content hash: the scrubber diffs hashes first and only expands what changed.

### Neutral
- A `tool` node still executes arbitrary local code — the *plan* is data, the *steps* are not. The
  boundary is that the engine never evaluates plan content as code.

## Alternatives considered

- **ODW's model: an LLM writes a TypeScript workflow, compiled and run once.** Rejected: this is G1.
  It gives up runtime adaptivity, the plan diff, and the scrubber — three of the four things that
  distinguish Karvan.
- **LangGraph-style graph built in code with checkpointer backends.** Rejected on the ADR 0003
  grounds (it is a library for building agents from raw model APIs) and on this one: the graph is
  still constructed by code, so plan versions are not documents.
- **A DSL — YAML/HCL with expressions.** Rejected: a DSL is code with worse tooling. The moment it
  has conditionals it needs an evaluator, and the diff becomes a diff of expressions rather than of
  structure.
- **Fully imperative TypeScript workflows with deterministic replay (Temporal/Restate).** Rejected
  here and in ADR 0006 — see that record for why replay's one benefit is one Karvan does not need.

## Revisit when

Users start asking for control flow the node vocabulary cannot express, **and** the request cannot
be met by adding one node type. Concretely: three distinct feature requests that all reduce to
"I need to write a conditional/expression the schema has no shape for".

If that happens, the answer is a **second execution mode over the same ledger** — imperative
TypeScript workflows with deterministic replay, as a peer of the data-driven mode — not a retrofit
of expressiveness into the `PlanGraph`. That would require superseding both this ADR and ADR 0006.

---
[← ADR index](./README.md) · [Architecture docs](../README.md)
