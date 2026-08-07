# Schema changelog

Every change to a payload schema in `packages/core/src/event-payloads.ts`, and why it was safe.

The ledger is append-only and events are **never rewritten on disk**. A `v1` payload written in
March is still a `v1` payload in December, and the daemon reading it in December may be older than
the one that wrote it. Everything below follows from that.

## The `*.json` files next to this one

The `DeFlow.*.v1.json` documents in this directory are **generated**, never hand-edited: they are
`z.toJSONSchema` output for the registry in `packages/core/src/json-schema.ts`, written by
`pnpm schemas:emit` and proven to match the Zod source by `pnpm schemas:check` in CI (KAR-02.8).
`DeFlow init` copies them into a run directory as `.DeFlow/schemas/`, which is what an `agent` node
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
