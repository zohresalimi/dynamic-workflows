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

_None yet. Every event kind is at `v1`: the ledger has no history to be compatible with._
