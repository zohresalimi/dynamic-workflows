# ADR 0018: A phase is a top-level step of the executing plan

**Status:** Accepted · **Date:** 26 August 2026 · **Deciders:** Meg

## Context — the forces at play, with the evidence

The blueprint's run screen has a **PHASES** panel in its lower left
([`docs/design/expected/EPIC-25/04-frame-fanout-run.png`](../design/expected/EPIC-25/04-frame-fanout-run.png)):
five rows reading `Scope 1/1`, `Search 6/6`, `Fetch 25/25`, `Verify 31/75`, `Synthesize 0/1`, one of
them selected and driving the table beside it. KAR-26.5's frame audit
([`KAR-26.5-frame-audit.md`](../design/expected/EPIC-25/KAR-26.5-frame-audit.md), the lower-band row)
marked the whole band **out of scope: facts the daemon does not have** — *"no phases projection"* —
and that verdict is still correct. KAR-28.5 exists to create the fact and KAR-28.6 to draw it, and
this record is what has to exist first, because **"phase" is currently a picture's word, not
DeFlow's**.

Three forces make the definition load-bearing rather than cosmetic.

**1. The word is already taken, with a different meaning.** `node.progress.phase` is a
`z.string().min(1)` in [`event-payloads.ts`](../../packages/core/src/event-payloads.ts) — a free
string an adapter reports about what one agent is doing *inside* one node (`thinking`, `tool-use`,
`running`). It is per-node, per-attempt, vendor-vocabulary and unbounded. A band that reused it would
be a band of one node's inner states, which is not what the picture shows. Whatever the band means,
it is not that, and shipping a second meaning of a recorded field name is how a projection becomes
quietly wrong.

**2. The plan document has no grouping field.** `DeFlow.plangraph.v1`
([§3.1](../04-domain-model.md#31-node-common-fields)) gives a node `id`, `title`, `deps`,
`lifecycle`, `derivedFrom`, its declarations and its policies. There is no `phase`, no `stage`, no
`group`, and no event that says a phase began or ended. Anything the daemon answers here is derived
from the plan and the node events, or it is invented — and **AR-6** plus this epic's own standing
rule (no faked model metadata, no invented fan-out counts) make "invented" not an option.

**3. The picture's own arithmetic tells us what a phase is made of.** `Search 6/6` is not six
seconds or six percent; it is six agents, which the canvas above it draws as one card labelled
`6 parallel searchers · 6 agents`. `Scope 1/1` is one agent that is not a fan-out. So in the
blueprint a phase is **a step of the workflow, counted in the work it fanned out into** — and DeFlow
already has both halves of that: a plan node, and the nodes materialised from it.

## Decision — what we will do, in the active voice

**A phase is a top-level step of the run's executing plan.**

Precisely, over the graph `run.started`/`plan.patched` adopted (`RunState.plan`), counting only
nodes whose `lifecycle` is `active`:

- **A phase is a node no other node of that plan contains.** A node `C` is *contained* by a node `P`
  when the plan itself says so, in one of three recorded ways: `C.id` has the materialised-child form
  `<P.id>--<itemId>` that [§3.2](../04-domain-model.md#32-the-seven-node-types-f23) fixes for `map`
  and `loop` children; `P` is a `map` or `loop` whose `body` names `C`; or `C` is a node of `P`'s
  inline `subgraph`. Nothing else contains anything.
- **A phase's name is the node's own `title`**, verbatim. Never composed, never derived from a
  position.
- **A phase's work items** are the nodes inside it — its materialised children if it has any, else
  its `body` template if it names one, else the phase node itself. The `body` template is excluded
  once children exist, because it is the shape the children were cut from and never runs: counting
  it would report `401` for a 400-way fan-out.
- **The order is the plan's own dependency order** — `topoSort()` over the whole graph, filtered to
  the top-level nodes, which preserves the relative order of any pair that depends on the other. No
  clock is read, and nothing is sorted by when it happened to start.
- **The counts are `completed` over `total`**, where `completed` is the work items whose folded
  `NodeState.status` is `completed` and `total` is the work items the plan **contains right now**. A
  `map` that has not fanned out yet reports the one node that exists, never the width its `over`
  collection might turn out to have.
- **The state is folded from the items' statuses** by a fixed precedence, never from elapsed time:
  anything live (`scheduled`, `running`, `awaiting-retry`, `suspended`, `blocked`) makes the phase
  `running`; otherwise all-`completed` is `complete`; otherwise a `failed` item makes it `failed` and
  a `cancelled` item `cancelled`; otherwise a partly-done phase with nothing live is `running` and an
  untouched one is `pending`.
- **A run whose ledger holds no adopted plan has no phases at all.** The projection answers an empty
  list and says why (`basis: 'no-plan'`). It is not given the stages of its own lifecycle as a
  consolation shape — see the first alternative below.

It is a pure function of `RunState` in `@DeFlow/core`, served as a field of `GET /api/runs/:id`
beside `gate`, `refusal` and `cancelLadders` (ADR 0012's rule: the run's surface is one projection,
not a family of polling endpoints). Because `RunState` is a fold of the ledger, the answer after a
`kill -9` is the answer before it, with no in-memory state to lose.

## Consequences

### Positive

- **Nothing new is recorded.** No event, no payload version, no schema, no migration, no planner
  prompt change. The projection is arithmetic over facts the ledger already holds, which is why it
  survives a restart without anybody arranging for it to.
- **Every number is a count of node ids**, so there is no estimate to be wrong and no denominator to
  be invented. `total` can only be a set of things that exist.
- **Fan-out reads the way the picture reads.** `stress-400`'s `migrate-views` answers `n/400` from
  the 400 real `migrate-views--<hash>` children, and `migrate-one-view` — the template that "stays in
  the graph and never runs" — is inside the map rather than a phase of its own.
- KAR-28.6 has a fact to draw, and `test/no-context-window-table.test.ts`'s rule is untouched: the
  band carries counts and states, and no per-agent token or throughput figure.

### Negative

- **A flat plan is a long band of `1/1` rows.** `happy-path-12` has twelve top-level nodes and
  therefore twelve phases, each one item. That is the plan's real shape and the band will show it,
  but it means the band duplicates the agent list above it for exactly the runs that have no fan-out
  — which today is most of them, because the planner rarely emits `map` and has never emitted
  `subgraph`. The honest band is the small one; a useful-looking band would have to guess.
- **Containment is a convention, not a field.** `<P.id>--<itemId>` is a documented id form
  (§3.2, `map-child-id.ts`) rather than a foreign key, so a future producer that mints child ids some
  other way silently promotes 400 children to 400 phases. `packages/core/test/run-phases-corpus.test.ts`
  holds the committed corpus to the shape, which is the check that would notice.
- Two readings of "phase" now coexist in the codebase. This record is the disambiguation; the field
  name `node.progress.phase` is not being renamed, because it is in published event payloads.

### Neutral

- Nothing about `node.progress.phase` changes. It keeps its meaning, its vendor vocabulary and its
  place in the activity feed KAR-28.1 built.

## Alternatives considered

- **The run's lifecycle stages — framing, spec approval, planning, execution, verification.**
  Rejected as the definition, and it is the closest call here. Each stage is genuinely evidenced by
  named events (`task.submitted`, `run.spec.approved`, `plan.proposed`, `run.started`,
  `gate.evaluated`), so it clears the honesty bar. What it fails is the arithmetic: only *execution*
  has a denominator. `Framing 1/1` would mean "an event happened", which is a progress bar made out
  of a boolean, and four of those beside one real count is a band that teaches an operator to
  distrust the fifth. The run's lifecycle is already legible where it belongs — the topbar's status
  (KAR-28.3) and the plan panel's pre-execution feed (KAR-28.1).
- **Dependency strata — the "waves" of nodes at equal depth from the roots.** Rejected on naming and
  on stability. A stratum is not something the plan said, so the band would have to compose a label
  (`Wave 3`), which is precisely the *"shape the frontend guessed"* this story exists to replace,
  only computed one layer earlier. And a single `deps` edge added by a replan renumbers every wave
  after it, so a phase an operator selected can become a different phase without anything about it
  changing.
- **Add a `phase` field to `PlanGraph` and have the planner fill it in.** Rejected for now, not
  forever — see "Revisit when". `DeFlow.plangraph.v1` is published and byte-pinned
  (`packages/core/test/schemas-append-only.test.ts`), so this costs a `plangraph.v2`, an upcaster and
  a planner-prompt change, to record something the graph already implies through `map`, `subgraph`
  and `deps`. Buying a schema version before the derived answer has been observed to fail is the
  wrong order.
- **Reuse `node.progress.phase`.** Rejected: different subject (one node's inner state), unbounded
  free-string vocabulary set per vendor adapter, and no notion of completion at all.
- **Compute it in the frontend from `useNodeBodies()`.** Rejected by the story's own reason for
  existing: a projection invented inside a component is one no other surface, no CLI and no replay
  can agree with, and it dies on reload.

## Revisit when

**The planner starts emitting a grouping of its own** — concretely, when a `plan.proposed` graph in
the fixture corpus contains a `subgraph` node, or when the median adopted plan has more than roughly
twelve top-level nodes of which fewer than two are `map` or `subgraph`. Either condition means the
derivation has stopped paying: the first says the plan is trying to express structure this record
reads only incidentally, and the second says the band has become a second copy of the agent list. The
answer at that point is the plan-authored `phase` field (alternative three), not a cleverer
derivation.

Independent trigger: **a producer other than `mapChildId` starts minting `<parent>--<child>` ids, or
a `map` child stops carrying that form.** Containment here is a convention, and the day it stops
holding, this record is wrong in a way that looks like a UI bug three packages away.

---

[← ADR index](./README.md) · [Architecture docs](../README.md)
