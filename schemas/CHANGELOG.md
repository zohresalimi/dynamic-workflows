# Schema changelog

Every change to a payload schema in `packages/core/src/event-payloads.ts`, and why it was safe.

The ledger is append-only and events are **never rewritten on disk**. A `v1` payload written in
March is still a `v1` payload in December, and the daemon reading it in December may be older than
the one that wrote it. Everything below follows from that.

## The `*.json` files next to this one

The `DeFlow.*.v1.json` documents in this directory are **generated**, never hand-edited: they are
`z.toJSONSchema` output for the registry in `packages/core/src/json-schema.ts`, written by
`pnpm schemas:emit` and proven to match the Zod source by `pnpm schemas:check` in CI (KAR-02.8).
`deflow init` copies them into a run directory as `.DeFlow/schemas/`, which is what an `agent` node
hands a vendor CLI and what the daemon's Ajv2020 validator compiles.

A `schemaId` obeys the same append-only rule as an event payload, for the same reason — a run
directory outlives the daemon that wrote it. A shape change publishes `DeFlow.<name>.v2.json` and
leaves `.v1` byte-for-byte alone; `packages/core/test/schemas-append-only.test.ts` pins a content
hash per shipped file so an in-place edit is a red test rather than a discovery months later. The
same document-level entries belong below, headed `<schemaId>`, whenever a `.v2` ships.

## The rule

**A payload change that an upcaster can express is a new `v`. A change no upcaster can express is a
new `kind`.**

An upcaster is a pure function from the old payload to the new one:

```ts
type Upcaster = (payload: unknown) => unknown;
```

If you cannot write that function — because the new shape needs information the old payload does not
contain, or because a field's meaning changed rather than its name — the change is **lossy**, and a
lossy payload change is a **new `kind`**, **not a new `v`**. Shipping it as a version bump would mean
every historical event of that kind is silently reinterpreted under the new meaning during replay,
and there is no way to detect that after the fact.

Adding an optional field is a version bump. Adding a required field with a computable default is a
version bump. Removing a required field, narrowing a union so old values no longer fit, or changing
what a field means are all new kinds.

### What enforces it

| Mechanism                                                  | Where                                       | Catches                                                            |
| ---------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| `assertUpcasterChainsComplete()`                           | `packages/core/src/upcasters.ts`            | A version bump that shipped without its upcaster — at boot, not at 3am during a replay |
| `checkUpcastersPreserveRequiredFields()`                   | `packages/core/src/upcasters.ts`            | An upcaster that drops a field its target schema still marks required |
| `checkUpcasterFixtures()`                                  | `packages/core/src/upcasters.ts`            | An upcaster whose output its own target schema rejects             |
| `packages/core/test/schema-changelog.test.ts`              | this file                                   | A version bump with no entry below                                 |

None of them can tell whether a change is *semantically* lossy. That judgement is yours, and this
file is where you record it.

## How to bump a version

1. Add the new payload schema and set `v` in `EVENT_SCHEMAS` (`packages/core/src/event-payloads.ts`).
2. Register the hop with `registerUpcaster({ kind, from, to, fixture, up })` in the same commit.
   Upcasters are append-only and never deleted: the chain from `v1` must still exist when `v5` ships.
3. Add an entry below, headed `<kind> v<n>`, saying what changed and why an upcaster exists.

## Entries

### node.failed v2, effect.failed v2

**KAR-23.11.** `failure.reason` widens by one member, `contract.no-work-product`: a node that
declared a non-empty `pathScopes.write` and finished its turn having changed no file and made no
commit in its own worktree. Both payloads embed `NodeFailureSchema`, so both move together — a reader
that trusted `effect.failed` v1 to mean "the pre-KAR-23.11 reason set" would be reading a payload
that can now carry more.

| Change                          | Kind     | Why it is not lossy                                                                                                     |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `failure.reason` gains a member | widening | Every v1 payload is already a valid v2 one — both hops are the identity — and no v1 payload can have carried the reason. |

Both hops are registered at the bottom of `packages/core/src/upcasters.ts`.

**What it is for.** On 2026-08-24, `run_20260824T143505Z_3a7365` took four implementation nodes to
`node.completed` over twenty-two minutes. Every branch `DeFlow/run_20260824t143505z_3a7365__*` holds
zero commits and an empty diff against main. The completion payloads carry `artifacts: []` beside an
`output.text` saying, in the agent's own words, _"I am blocked before any code could land"_ and _"I
wrote no files"_. Nothing in the ledger, the CLI or the UI noticed; the run looked healthy. The
underlying cause is fixed elsewhere (MET-1009's unwired permission fronts), but DeFlow still could
not tell a node that implemented a feature from a node that reported being unable to start.

**The rule.** At the completion chokepoint (`packages/adapters/src/scope-audit.ts`), a node whose
plan-declared `pathScopes.write` is non-empty must have left at least one changed, renamed or
untracked path, **or** at least one commit on its branch since the commit it was provisioned from. If
neither, the attempt is a `node.failed`, appended with `budget.consumed` in one transaction —
twenty-two failed minutes are still spend.

The commit count is not optional polish. DeFlow's model is that a node's work sits dirty and is
salvage-committed at teardown, so `git status` is normally the whole answer; an agent that commits
its own work would show a clean status, and failing *that* node would be the worst false positive
available. It is also literally the measurement the incident was diagnosed with.

**How a legitimately-empty node stays green.** It declares `pathScopes.write: []`, and
`auditCompletionScope` already returns early for exactly that — a reviewer, a verification agent, a
node that only returns a document is never even asked. The planner packet's `plan-rules` brief states
that as a plan-authoring rule up front, which converts the one realistic false-positive class into
something the planner is told before it costs a turn.

**Why not `agent.refused`.** Zero schema work, and a lie:
[§8](../docs/04-domain-model.md) defines it as _"stopReason indicated refusal"_, and these turns
ended `end_turn`. `DeFlow.toolresult.v1` below is the precedent for choosing the bigger diff over a
quiet lie in the ledger.

**Why no `plangraph.v2`.** `NODE_FAILURE_REASONS` was embedded in two published document schemas
through `RetryPolicySchema.onFailure[].when`, so widening it would have rewritten the bytes of
`DeFlow.plangraph.v1.json` and `DeFlow.planpatch.v1.json`. Those are now pinned to a new frozen
`PLAN_AUTHORABLE_FAILURE_REASONS` — the reasons that existed when v1 shipped, held to the taxonomy by
`satisfies readonly NodeFailureReason[]` so a *deletion* is a compile error. Both emitted files stay
byte-identical and `schemas-append-only.test.ts` needed no hash edited. A retry policy therefore
cannot name `contract.no-work-product`, which is correct rather than a gap: it is DeFlow's own verdict
on the node, and its class is `permanent` by construction.

### DeFlow.toolresult.v1

**KAR-23.9.** A new document, not a version bump: nothing shipped under this id before, because
until this story no daemon could perform a `tool` node at all. It is what a script node's
`node.completed` files its output under, exactly as `DeFlow.verdict.v4` is what a gate node's does —
so `outputSchemaId` names a document that really exists rather than a shape nobody can resolve.

| Field                | Why it is here                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `kind: 'script'`     | A discriminator, so `mcp` and `http` arrive as members rather than as optional fields on this one.  |
| `exitCode` nullable  | `null` is *killed before it could exit* — a timeout, a cancel — which is a different fact from `0`. |
| `signal` nullable    | Which signal ended it, when one did.                                                               |
| `durationMs`         | Measured on the injected `Clock` (NF9), never `Date.now()`.                                        |
| `timedOut`           | Whether the deadline is what ended it, stated rather than inferred from a null exit code.          |
| `stdout` / `stderr`  | **Handles**, nullable. The output lives in the data plane — `io_chunk` while it happens, a content-addressed blob afterwards — so the fix for a silent tool node does not become a fat `node.completed` payload. `null` means the stream produced nothing, which is not the same as a handle to an empty blob. |

**Why not the node's own `returns.schemaId`.** That was the smaller diff and it would have put a
quiet lie in the ledger: a script produces an exit code and two streams, not the planner's contract,
and nothing today validates the claim. The ledger would record that the node returned a document it
never produced.

### DeFlow.finding.v2

**KAR-12.3.** A finding's line is anchored to the blob it was read from:
[10 §8](../docs/10-verification-gates.md) — _"without it, the second repair attempt silently attaches
every earlier finding to whatever line now happens to occupy that number, and the reviewer stops
trusting the annotations within about ten minutes."_

| Change                                   | Kind                | Why it is not lossy                                                                                                        |
| ---------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `location.blobSha` (required, when `location` is present) | narrowing, new document | `.v1` is untouched on disk. Nothing upcasts a `finding` fact in place: `.v2` is a new document, and a `.v1` fact stays a `.v1` fact. |

`location` itself stays optional. A verdict about the change as a whole — _"no test covers the new
branch"_ — has no range to be stale against, and demanding a sha for it would only invite a
fabricated one.

### DeFlow.verdict.v3

**KAR-12.3.** The gate contract: blob-anchored findings, and what the verdict cost.

| Change                              | Kind           | Why it is not lossy                                                                                                     |
| ----------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `findings: DeFlow.finding.v1[]` → `.v2[]` | narrowing      | See `gate.evaluated v3` below for the one thing the hop drops and why keeping it would be the actual loss.               |
| `+ cost` (optional)                 | optional field | A `.v2` verdict predates the field and nobody measured it. A zero would claim the node was free, and a budget ceiling (F4.6) would act on the claim. |

**Why `cost` is optional in the schema and mandatory in practice** — the same shape of argument as
`specHash` on `.v2`. `sealVerdict` and the agent-verdict admission both stamp it, so every verdict
DeFlow writes carries one; optionality exists so the `gate.evaluated` v2 → v3 hop is legal without
inventing a measurement. Absence means *nobody measured this*, which is a fact.

### gate.evaluated v3

**KAR-12.3.** The event that carries a verdict follows it to `DeFlow.verdict.v3`.

| Change                       | Kind                    | Why it is not lossy                                                                          |
| ---------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------- |
| `verdict: .v2` → `.v3`       | widening plus one drop  | `cost` is added and left absent. An unanchored `location` is **dropped from the finding, and the finding is kept**. |

This is the only hop in the registry that removes anything, so the reasoning is worth stating in
full. A `.v2` `location` is a file and a line with no statement of *which revision* the line belonged
to. Carrying it forward would let the diff surface draw a historical finding against whatever now
occupies that line — the exact failure [10 §8](../docs/10-verification-gates.md) describes. So the
hop keeps everything still true of the finding (its stable id, severity, message, evidence and
criterion) and drops only the claim it can no longer support. A finding that never had a `location`
is untouched. Judged against the rule at the top of this file: no field's *meaning* changed, and no
information that is still true is lost — what is dropped is an assertion the payload was never able
to support.### run.needs_human v4

**KAR-11.4.** The escalation vocabulary gains a sixth reason, `patch-rejected`:
[06 §4.3](../docs/06-planning-and-replanning.md)'s rule table refused a proposed patch, and the run
stops to ask rather than proceeding as though nothing was proposed.

| Change                            | Kind     | Why it is not lossy                                                                                        |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `reason` gains `'patch-rejected'` | widening | Every v3 payload is already a valid v4 one — the hop is the identity — and no v3 payload can have carried it. |

A sixth reason rather than a reuse of `churn`, because the operator's next action differs in kind.
`churn` says *the plan rests on a premise only you can supply*; this says *the run wanted to do one
specific thing and policy would not let it*, and it is answered by opening the approval queue and
approving the rejected patch explicitly — *"a rejection is a 'not without you', not a dead end"*.

### plan.patched v2

**KAR-11.4.** The event now records who **authored** the patch: `proposedBy`, optional.

| Change                        | Kind           | Why it is not lossy                                                              |
| ----------------------------- | -------------- | ---------------------------------------------------------------------------------- |
| adds optional `proposedBy`    | optional field | Every v1 payload is already a valid v2 one, and the hop leaves the field **absent**. |

**Why `decision.by` could not be reused, and why the hop must not lift it.** `decision.by` says who
*decided* — `'policy'` when a rule fired, `'human'` when an operator answered the approval queue —
and the case this field exists for is a patch a human *proposed* that the rule table then
auto-applied on its merits. [06 §7](../docs/06-planning-and-replanning.md)'s circuit-breaker reset
keys on authorship: a human-supplied premise invalidates the churn window. Copying `decision.by` into
the new field would clear a churn trip whenever an operator approved the planner's own fourth replan
— which is precisely the livelock the breaker exists to stop.

### plan.proposed v2

**KAR-11.1.** The proposal now records **which model planned**:
`planner: { model, effort, tier }`, optional.
[06 §6](../docs/06-planning-and-replanning.md) is explicit that the planner-tier proposal is
_"Unverified — a proposal with a measurement plan attached, not a finding"_, and the measurement it
names is a join of these three fields against the cross-run dashboard's gate first-pass rate and
replans-per-run. EPIC-11-S1 states the trade in one line: _"recording them now costs a field; adding
them later costs an upcaster."_

| Change                                        | Kind     | Why it is not lossy                                                              |
| --------------------------------------------- | -------- | ---------------------------------------------------------------------------------- |
| adds optional `planner: { model; effort; tier }` | widening | Every v1 payload is already a valid v2 one, and the hop leaves the field **absent**. |

`effort` is `string | null` rather than optional, because _"where the adapter exposes a
reasoning-effort control"_ means some expose none, and `null` is that answer. An omitted field could
not be told apart from "nobody recorded it", which is the state the field exists to end.

**The hop is deliberately the identity, and the dishonest alternative is worth naming.** The run's
current planner model sits in the config, and stamping it onto a historical proposal would make the
one comparison this field enables report a model against itself. Absent is a value the analysis can
exclude; a plausible wrong one is not.

### run.needs_human v3

**KAR-11.1.** The escalation vocabulary gains a fifth reason, `plan-invalid`:
[06 §3.5](../docs/06-planning-and-replanning.md) allows a failing plan version exactly one retry with
the diagnostics as input, and _"a second failure escalates to a `human` node with the diagnostics
rendered"_.

| Change                          | Kind     | Why it is not lossy                                                                                        |
| ------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `reason` gains `'plan-invalid'` | widening | Every v2 payload is already a valid v3 one — the hop is the identity — and no v2 payload can have carried it. |

A fifth reason rather than a `detail` on `churn`, for the same reason `spec-revalidation` is a fourth:
the operator's next action differs in kind. Churn is answered by changing the approach; this one is
answered by reading the diagnostics and supplying a plan that satisfies them. It is also the reason a
third automatic attempt is not made — an unbounded planner retry loop is the churn shape arriving
earlier.
### DeFlow.verdict.v2

**KAR-10.4.** A verdict now names the contract it judged:
[10 §5.2](../docs/10-verification-gates.md)'s first anti-drift mechanism — _"the verdict carries
`specHash`. If it does not equal the run's current pinned `specHash`, the verdict is **void** and the
gate is re-run."_

| Change                | Kind           | Why it is not lossy                                                                                                                                       |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `+ specHash` (optional) | optional field | A `.v1` verdict predates the field, and there is no honest value to lift into it — see below. `.v1` is untouched on disk, exactly as the rule requires. |

**Why it is optional in the schema and mandatory in practice.** `verdictAgainst`
(`packages/core/src/acceptance-board.ts`) is how a gate seals a verdict and it always stamps the
hash, so every verdict DeFlow writes carries one. What optionality buys is a legal upcast from `.v1`.
Filling a historical verdict in with the run's current hash would assert that a reviewer was shown a
document that did not exist when it ran, and would turn a criterion green on the strength of it. So
the hop leaves it absent and `isVerdictVoid` treats an unnamed contract exactly as it treats a
mismatched one: **void**. The worst outcome of the upcast is therefore a gate that re-runs, which is
the direction this mechanism is supposed to fail in.

### gate.evaluated v2

**KAR-10.4.** The event that carries a verdict follows it to `DeFlow.verdict.v2`.

| Change                                       | Kind     | Why it is not lossy                                                                             |
| -------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `verdict: DeFlow.verdict.v1` → `.v2` | widening | v2 adds one optional field, so every v1 payload is already a valid v2 one and the hop is the identity. |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`. It is still a version
rather than a silent widening for the usual reason: a v2 payload carrying a `specHash` must be
*refused* by a daemon that predates the void rule, rather than folded into an acceptance board that
would count it unconditionally.

### budget.exceeded v2

**KAR-14.2.** F4.6's ceiling trip became self-describing: a reader of a paused run can now see which
class the breach was recorded under, whose ceiling fired, and whether the figure that stopped the run
was billed by a vendor or estimated by DeFlow.

| Change                        | Kind                               | Why it is not lossy                                                                                                                                                     |
| ----------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `+ failureClass` (required)   | required field, computable default | Filled with `'gate'` — the only value the v2 schema accepts, and the only class `NodeFailureSchema` has ever accepted for a budget reason. A v1 breach *was* a gate.       |
| `+ firedBy` (required)        | required field, computable default | Filled with `'deflow'`. A v1 payload predates the vendor-ceiling path (`--max-budget-usd`) entirely, so every breach written under it came from DeFlow's admission check. |
| `+ node` (optional)           | optional field                     | Left absent. v1 recorded no node on a node-scoped breach, and naming one would be an invention.                                                                          |
| `+ basis` (optional)          | optional field                     | Left absent. v1 carried no rollup breakdown, and a fabricated one would put a figure nobody measured beside a pause somebody has to act on.                              |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

### budget.consumed v3

**KAR-14.3.** The accounting record gained the figure it was *admitted* on, so an estimate and the
actual it was measured against travel together and the per-run estimate-accuracy figure is a fold
over one event kind rather than a join across two.

| Change                | Kind           | Why it is not lossy                                                                                                                                                                        |
| --------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `+ estimate` (optional) | optional field | Left **absent**. A v2 payload was written before a pre-flight estimator existed, so there is no figure to lift — and filling it in with the actual would make every historical attempt read as perfectly estimated and drag the accuracy figure toward a 1.0 nobody measured. |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

**Why the estimate rides on the accounting record rather than in a table of its own.** The two
numbers only mean anything as a pair: an estimate compared against a different turn's actual
converges on nothing, and one that has lost its actual cannot be reconciled at all. Everything the
comparison needs is therefore in one payload, which is the same property that makes KAR-14.1's
rollup a fold over one kind.

### budget.consumed v2

**KAR-14.1.** The accounting record became self-contained, so the per-node / per-provider / per-run
rollup is a fold over one event kind rather than a join across three that can arrive in any order.

| Change                              | Kind                                | Why it is not lossy                                                                                                                                                       |
| ----------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `costUsd: number` → `number \| null` | widening                            | Every v1 value still fits. `null` is new vocabulary — a provider whose manifest says `tokenAccounting: 'none'` cannot be priced, and `0` would be a claim that it was free. |
| `+ authMode` (required)             | required field, computable default  | Defaulted to `'subscription'`. Not a guess: KAR-08.8 makes `'api_key'` reachable only by an explicit opt-in, so a payload written before the field existed cannot be one.  |
| `+ attempt` (optional)              | optional field                      | Left absent. v1 recorded no attempt, and inventing `0` would file a retry's spend under the attempt it replaced.                                                            |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

**Why `costUsd` had to become nullable rather than stay a number.** The alternative was to append
`costUsd: 0` for a provider that reports nothing, which is the exact failure
`docs/08-context-and-memory.md` §7 names — _a blank cost cell, not a zero_ — and which makes an F4.6
cost ceiling silently unenforceable, because a run whose spend is unmeasurable would read as a run
that has spent nothing.

### plan.patch.proposed v2

**KAR-14.4.** A proposal says *why* it was made, so the plan scrubber can tell a planner's own
provider choice from a vendor refusing to serve — which is the distinction F3.9's wording rests on
and the one `quota-reroute-equivalent` auto-applies against.

| Change             | Kind           | Why it is not lossy                                                                                                                                                                                              |
| ------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `+ cause` (optional) | optional field | Left **absent**. A v1 payload was written before the reactive rate-limit path existed, so a quota cannot have been its reason, and filling one in would make every historical planner patch read as a vendor swap. |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

**Why the cause is on the proposal and not on the `PlanPatch`.** `DeFlow.planpatch.v1` is a shipped
document schema whose bytes are content-pinned by `packages/core/test/schemas-append-only.test.ts`;
a field there is a `.v2` document, which belongs to EPIC-11's patch application rather than to a
rate-limit story. It is also the better home on the merits: the same `replace-provider` op is a
routine planner decision or a vendor outage depending on who asked for it, and that is a fact about
the proposal rather than about the ops.

### plan.patch.proposed v3

**KAR-11.3.** A proposal records the plan version it was derived against, so the run can tell a
patch that is merely *behind* from a patch that is *wrong*.
[06 §4.2](../docs/06-planning-and-replanning.md): `basePlanHash` must equal `run.plan_hash`, a
mismatch is rejected with `PATCH_STALE`, and **no rebase is attempted** — *"the proposer had a
reason based on a graph that no longer exists."*

| Change                       | Kind           | Why it is not lossy                                                                                                                                                                          |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `+ basePlanHash` (optional)  | optional field | Left **absent**. The only value available to lift is the run's *current* plan hash, and stamping that on a historical proposal would make it read as having passed a concurrency check nobody ran. |

The hop is registered beside the v1 → v2 one in `packages/core/src/upcasters.ts`.

**Why the base hash is on the proposal and not on the `PlanPatch`.** The same reason `cause` is, plus
one on the merits: `basePlanHash` is not a property of the ops. The same three ops derived against v3
and against v7 are the same patch and a different proposal, and which of the two it is decides
whether it may apply at all. `DeFlow.planpatch.v1`'s bytes stay content-pinned by
`packages/core/test/schemas-append-only.test.ts`, and every run directory already on disk keeps
reading its documents with the shape it was given.

### run.needs_human v2

**KAR-10.3.** The circuit breaker gained a fourth trip reason, `spec-revalidation`: a mid-run spec
edit whose new `specHash` the current plan no longer satisfies, which
[06 §1.3](../docs/06-planning-and-replanning.md) requires to go to `needs_human` *"rather than
continuing against a spec it no longer satisfies"*.

| Change                                | Kind     | Why it is not lossy                                                                                        |
| ------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `reason` gains `'spec-revalidation'` | widening | Every v1 payload is already a valid v2 one — the hop is the identity — and no v1 payload can have carried it. |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

**Why a widening still gets a version.** The direction that matters is the other one. A v2 payload
carrying the new reason must be *refused* by a daemon that predates it, rather than folded into a
`needsHuman` whose reason that build cannot render — which is exactly what `v` is for
([04 §9.2](../docs/04-domain-model.md) rule 3). A fourth reason rather than a `detail` on one of the
other three because the operator's next action differs in kind: churn and budget are answered by
raising a ceiling or changing the approach, and this one by covering a criterion the plan no longer
reaches.

### node.started v2

**KAR-12.2.** The resolved session id is journaled on the event that opens the attempt, so
independence is a ledger fact rather than an in-memory one. AC1 asks that a test comparing a review
node's session to its producer's *need nothing but the two `node.started` payloads*, and that is
NF10 applied to the one property F7.2 rests on.

| Change                | Kind           | Why it is not lossy                                                                                                                                                                                       |
| --------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `+ session` (optional) | optional field | Left **absent**. A v1 payload predates the field, and the only place a value could be lifted from is the free text of a `node.progress` line — parsing prose into the field an independence check then reads is a certainty nobody measured. |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

**Why `origin` is required inside `session` rather than optional beside it.** The two adapter paths
learn the id at different moments — the CLI shim mints it before spawn, the ACP path receives it
from `session/new` — and that difference is exactly what says *when the independence check could
have run*. A session recorded without saying which path produced it makes AC4 unauditable, so the
field is absent-or-complete rather than partially filled.

### gate.evaluated v4

**KAR-12.2.** v4's verdict is `DeFlow.verdict.v4`, which adds `weakened` — what was given up to
produce this verdict, so a green review that ran on the producer's own provider is distinguishable
from one that did not.

| Change                          | Kind           | Why it is not lossy                                                                                                                                                                     |
| ------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verdict.+ weakened` (optional) | optional field | Left **absent**, and absence is a real answer here rather than a gap: the single-provider fallback did not exist when a v3 payload was written, so a historical verdict was routed the ordinary way. |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

**Why absence is honest here and was not on the `specHash` and `cost` hops.** `specHash` and `cost` were
fields whose historical value existed and was simply not recorded, so absence had to be read as
*unknown* and `isVerdictVoid` treats it as void. `weakened` names a routing decision DeFlow itself
makes, and the decision it names was not available to the code that wrote a v3 payload. The only
error the hop could make would be marking a historical review weak when it was not — an invention on
a marker whose entire purpose is to be believed.

### DeFlow.verdict.v4

**KAR-12.2.** `weakened?: 'same-provider' | 'single-attempt'`. A `.v4` document rather than a field
on `.v3` because a shipped document is never edited in place: `DeFlow.verdict.v3.json` stays
byte-for-byte as it was, and `packages/core/test/schemas-append-only.test.ts` is what says so.

The marker is projected as well as stored. `acceptanceBoard` carries it onto every row a weakened
verdict decided, so the acceptance-criteria board and the diff view render it **without a join** —
`docs/10-verification-gates.md` §3.1's *"do not silently accept a weakened review"* is only true if
the weakening reaches the surface a human reads.

### plan.validation_failed v2

**KAR-11.2.** `diagnostics[].node` widens from `NodeId` to a non-empty string, because two of
[06 §3](../docs/06-planning-and-replanning.md)'s diagnostics cannot name a valid `NodeId` by
construction.

| Change                                     | Kind     | Why it is not lossy                                                                                     |
| ------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------------- |
| `diagnostics[].node` widens to `string` | widening | Every v1 payload already carried a `NodeId`, which is a non-empty string — the hop is the identity. |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

**Why the widening was forced.** `INVALID_NODE_ID` exists to report an id the `NodeId` charset
refuses (§3.3 — a colon, a leading dash, an uppercase letter), and `CRITERION_UNCOVERED` is a fault
of the *document* rather than of any node, so it carries the `PLAN_SCOPE` sentinel `(plan)`. A
payload schema that accepted only valid `NodeId`s would make the append throw on exactly the two
faults the validator exists to catch, which is a worse failure than the one it was preventing. The
sentinel's parentheses keep it outside the charset a real id could ever occupy.

### plan.validation_failed v5

**KAR-23.13.** `diagnostics[].code` widens by two more members, `TOOL_PERMISSION_UNSCHEDULABLE` and
`TOOL_COMMAND_REFUSED`: a `tool` node asking for `permission: 'full'`, and a `tool` node whose `run`
line the F5.6 destructive-command deny list refuses.

| Change                                 | Kind     | Why it is not lossy                                                                                                   |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `diagnostics[].code` gains two members | widening | Every v4 payload is already a valid v5 one — the hop is the identity — and no v4 payload can have carried either code. |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

**Why the check moved.** On 2026-08-24, `run_20260824T174326Z_3b9ba1` validated its plan, fired
`run.started`, and lost all fourteen of its nodes inside one second: one
`safety.permission-unschedulable` — _"tool node branch-setup asks for permission level full"_ — and
thirteen `dependency.failed` behind it. **The refusal was correct and is unchanged.** What was wrong
is where it was discovered: `node.type`, `tool.kind`, `permission` and the `run` line are all plan
content, fixed the moment the planner wrote the document, and every one of them was knowable when
validation ran. The previous run's node for the same work asked for `worktree` and ran fine; this one
asked for `full`, and the planner was never told it had made a refusable choice.

`packages/core/src/tool-node-rules.ts` is now the single implementation of all three refusals;
`validate-plan.ts` files them as repairable diagnostics and `pipeline/tool-node.ts` throws them as
`NodeFailure`s. The performer's copy stays as the **backstop**, because a plan reaches `perform()` by
paths validation does not gate — a resumed run, a document compiled by an older build, a patch.

**Why the deny list is included even though `CommandContext` carries paths.** Three of its rules read
the worktree, and at plan time there is no worktree. They judge the line against a synthetic root
(`PLAN_TIME_COMMAND_CONTEXT_ROOT`), with `cwd` resolved from the node's own `tool.cwd` exactly as
`perform()` resolves it against the real one. Every *relative* argument gets the identical verdict;
the only divergence is an *absolute* path that happens to sit inside the real worktree — a path a
planner cannot know and must never write. So plan time is equal-or-stricter than run time, never
laxer, and a strictly-stricter verdict costs one repairable diagnostic rather than a security hole.

**Named after the run-time reason it prevents.** `TOOL_PERMISSION_UNSCHEDULABLE` mirrors
`safety.permission-unschedulable`, so an operator grepping a ledger for the incident finds both ends
of it — the diagnostic that should have caught it and the failure that did.

### plan.validation_failed v4

**KAR-23.9.** `diagnostics[].code` widens by two members, `NODE_TYPE_UNPERFORMABLE` and
`TOOL_KIND_UNPERFORMABLE`: a node of a type — or a `tool` node of a kind — the daemon about to run
the plan composes no performer for.

| Change                                 | Kind     | Why it is not lossy                                                                                                   |
| -------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `diagnostics[].code` gains two members | widening | Every v3 payload is already a valid v4 one — the hop is the identity — and no v3 payload can have carried either code. |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

**Why the check exists at all.** On 2026-08-24, `run_20260824T110147Z_f21769` compiled and validated
a plan of sixteen nodes, seven of them `tool` nodes. `byNodeType` composed performers for `agent` and
`gate` only, so the first tool node failed `internal`/`permanent` — *"nothing in this daemon knows
how to perform a tool node"* — and the other fifteen followed it down as `dependency.failed`. Every
one of those nodes had passed [06 §3](../docs/06-planning-and-replanning.md)'s *"cheapest correctness
gate in the system"*, because the gate had never been told what the executor can run. KAR-23.9 ships
the performer **and** the check; the check is what makes the next missing performer a repairable
diagnostic on the planner's one retry instead of a run that dies at node 27.

**Two codes rather than one**, because the repair differs: an unperformable node *type* has to be
re-planned as other work, while an unperformable tool *kind* is the same work expressed another way.

### plan.validation_failed v3

**KAR-12.4.** `diagnostics[].code` widens by two members, `CRITERION_UNVERIFIABLE_NO_REASON` and
`COVERED_BY_GATES_MISMATCH` — [10 §5.1](../docs/10-verification-gates.md)'s totality rule: every
acceptance criterion in the pinned spec either reaches an active gate node or is marked
`unverifiable` with a non-empty reason, and `coveredByGates` is computed by validation rather than
authored by hand.

| Change                       | Kind     | Why it is not lossy                                                                                        |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `diagnostics[].code` gains two members | widening | Every v2 payload is already a valid v3 one — the hop is the identity — and no v2 payload can have carried either code. |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

**Why a warning code ships alongside two error codes.** `COVERED_BY_GATES_MISMATCH` is a `warning`,
never an `error`: the computed value is what validation trusts regardless, so a hand-supplied
`coveredByGates` that disagrees with it is made visible rather than blocking the run — the same
severity split §3.1's `ORPHAN_WRITE` already uses for "usually a leftover, occasionally deliberate."

### `specHash` now excludes `acceptanceCriteria[].coveredByGates`

**KAR-12.4 AC3.** No document shape changed — `DeFlow.taskspec.v1` still carries the field, still
defaults it to `[]`, and no event payload moved a version. What changed is what the *digest* is
over: `specHash` omits every criterion's `coveredByGates` the same way it already omits `approvedBy`
and `specHash` itself.

`coveredByGates` is derived, not authored: `withCoveredByGates` recomputes it from the plan's active
gate nodes and overwrites it on **every** plan version (AC3, AC5). If the digest covered it, that
rewrite would change the spec's identity — and AC6 makes a verdict void the moment its `specHash`
differs from the run's current one, so a single `plan.patched` that added or retired a gate would
void every verdict in the ledger and re-run every gate, for a field no human touched. The digest is
the identity of the **authored** document.

**Migration:** none in either direction for a stored payload; the field's recorded value is still
whatever was appended. Digests recomputed by a build carrying this change differ from ones computed
by a build before it, which is only observable for a run whose ledger spans the upgrade — and
`gateSpecFromLedger` already refuses a spec whose recomputed digest does not reconcile with the
approval rather than judging against it, which is the loud failure rather than a silent one.

### plan.patch.rejected v2

**KAR-11.2 AC11.** A patch can now be refused by *revalidation* as well as by the policy engine,
and the rejection carries the diagnostics that refused it.

| Change                        | Kind           | Why it is not lossy                                                                                                    |
| ----------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `by` gains `'validation'`     | widening       | Every v1 payload is already a valid v2 one, and no v1 payload can have carried it — structural revalidation did not exist. |
| `+ diagnostics` (optional)    | optional field | Left **absent**. A policy rejection has none — `rule` is its whole reason — and a v1 payload recorded none to lift.        |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

**Why `'validation'` is a third rejecter and not a reuse of `'policy'`.** EPIC-11-S18's second
scenario is the whole argument: the policy engine asks *should we?* and the validator asks *can we?*,
a `yes` to the first can never substitute for the second, and an operator reading the approval queue
has to be able to tell which of the two refused their patch — because one is answered by changing
the patch and the other by changing the rules.
### human.requested v2

**KAR-12.5 AC7.** An escalation may now carry what an exhausted repair loop produced:
`repair.attempts[]`, one entry per attempt, each pairing the diff it produced with the verdict the
re-run gate returned for it — [10 §7](../docs/10-verification-gates.md)'s _"the third failure emits
`human.requested` carrying all three diffs and all three verdicts"_.

| Change               | Kind           | Why it is not lossy                                                                                                          |
| -------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `+ repair` (optional) | optional field | Left **absent**. A v1 payload recorded no attempts, and no honest value can be reconstructed from the payload alone.            |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

**Why the attempts are paired rather than two arrays.** Three diff handles and three verdict handles
in parallel arrays would let attempt 2's diff sit beside attempt 3's verdict with nothing able to
notice, and the entire value of the escalation is reading _"attempt 2 changed this and the gate still
said that"_. The pairing is the payload's job because the escalation is the only place both facts
exist at once.

**Why it is optional rather than required.** Most escalations are not repairs — a `human` node's own
prompt, a permission decision, a clarifying question — and none of them has attempts to carry. A
required field would make every one of them invent an empty list, which the schema refuses anyway
(`attempts` is `.min(1)`: a repair escalation with no attempts is not an escalation).

### human.requested v3

**KAR-13.1 AC7.** A `human` node's `deadline.onTimeout: 'escalate'` appends a *second*
`human.requested` when the first goes unanswered. `escalated` is what makes that second one
distinguishable from the first without walking the log.

| Change                   | Kind           | Why it is not lossy                                                                                                                                            |
| ------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `+ escalated` (optional) | optional field | Left **absent**. Every v2 payload predates the deadline path, so none of them was an escalation — but absent says _"this ledger predates the distinction"_ and `false` would say _"this was checked"_. |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

**Why a field rather than a convention.** *"Higher-visibility"* has to be something the approval
queue (KAR-13.2) and the notification badge can sort on, and _"it is the second `human.requested`
for this node"_ is a scan of the whole run's ledger per row. It also carries the reason an escalated
request declares no deadline of its own: an escalation that expired again would either fail the
branch on a rule nobody wrote or re-escalate for ever.

### human.requested v4

**KAR-13.2 AC2.** The cross-run approval queue must carry *enough to decide without a second
request*, and a permission escalation is decided on six facts: the command, its args, the cwd, the
**resolved** path, the policy rule that matched and the node's declared scope. Before v4 those lived
only inside the prose `prompt`, where a UI cannot render the resolved path beside the requested one
and a test cannot assert on them without asserting on wording.

| Change                   | Kind           | Why it is not lossy                                                                                                                                                                     |
| ------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `+ permission` (optional) | optional field | Left **absent**. A v3 payload does not carry the context, and it cannot be recovered — parsing six fields back out of an English sentence would put fabricated evidence in front of the decision. |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

**Why it travels beside `reason` rather than inside it.** The two answer different questions:
`reason` is the category the queue groups by and the [§10.5](../docs/09-workspace-and-safety.md)
gate budget counts, and this is the evidence the operator reads. A reason with the evidence folded
into its `detail` string would be a category nothing could group by.

### human.requested v5

**KAR-13.4 AC2, AC8.** Two more fields inside `permission`, and both are about what the operator is
actually deciding under. `enforcement` is the sandbox mode **in effect for this node** — A5-1's
version sniff — because Claude Code's sandbox settings are version-gated at fine granularity and,
without `sandbox.failIfUnavailable: true`, the sandbox silently runs unsandboxed when bubblewrap or
socat are missing; granting network egress while the ladder is decorative is a different decision
from granting it while the sandbox is real. `sessionId` is the ACP session the request arrived on,
which is what lets the failure that closes an unanswerable escalation name what was lost.

| Change                                     | Kind           | Why it is not lossy                                                                                                                                                                            |
| ------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `+ permission.enforcement` (optional)       | optional field | Left **absent**. It is a sniff performed at spawn time; reconstructing it now would report *this* machine's sandbox against a decision made months ago on another one.                             |
| `+ permission.sessionId` (optional)         | optional field | Left **absent**. The session it would name is gone, and a payload naming a live-looking session nothing can answer is the state KAR-13.4 AC8 exists to prevent.                                    |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

### human.responded v2

**KAR-13.1 AC7.** `by` says who chose the option: `operator` for a person,
`policy` for the answer `deadline.onTimeout: 'default'` gave on their behalf. KAR-13.4 reuses it for
a permission escalation that expires to `reject_once`.

| Change            | Kind           | Why it is not lossy                                                                                                                        |
| ----------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `+ by` (optional) | optional field | Left **absent**, and read as `operator`. Before v2 there was no path that could append a response other than a person's, so nothing is lost. |

The hop is registered at the bottom of `packages/core/src/upcasters.ts`.

**Why the hop does not write `by: 'operator'` in.** It would be true of every ledger written before
this change and false the moment one written by a build that *has* the deadline path but an older
payload version is replayed. _"The operator approved this at 14:12"_ is exactly the claim NF10 exists
to keep provable, and a fabricated attribution is worse than an absent one — a reader can see a gap.
