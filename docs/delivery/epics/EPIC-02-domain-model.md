# EPIC-02: Domain model and schemas

> Part of the [DeFlow delivery plan](../README.md) · [Board](../board.md) ·
> [Flows for this epic](../flows/EPIC-02-domain-model-flows.md)

|                      |                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| **Epic ID**          | EPIC-02                                                                                            |
| **Status**           | Not started                                                                                        |
| **Priority**         | P0                                                                                                 |
| **Milestone**        | M1                                                                                                 |
| **Workstream**       | W0 (see [roadmap §2.2](../../17-roadmap.md))                                                       |
| **Size**             | ~13 days across 11 stories                                                                         |
| **Depends on**       | EPIC-01                                                                                            |
| **Blocks**           | EPIC-03, EPIC-04, EPIC-05, EPIC-06, EPIC-09, EPIC-10, EPIC-11, EPIC-12, EPIC-15, EPIC-16           |
| **PRD requirements** | F1.2, F1.3, F1.5, F2.1, F2.3, F2.4, F2.5, F3.2, F4.1, F4.3, F6.2, F6.3, F6.4, F6.9, F7.3, F7.4, NF8, NF9 |
| **Architecture**     | [04-domain-model.md](../../04-domain-model.md)                                                     |

## Goal

At the end of this epic `@DeFlow/core` exports every type the rest of the system speaks — `TaskSpec`,
`PlanGraph`, `PlanPatch`, `Fact`, `ContextPacket`, `Verdict`, `NodeResult`, `NodeFailure` and the
`Event` union — authored once as Zod 4 schemas, with the TypeScript types derived by `z.infer` and
the JSON Schemas derived by `z.toJSONSchema()` and written to `.DeFlow/schemas/`. Alongside the
types come the three invariants everything else leans on: a `NodeId` that is stable for the life of
a run, a canonical JSON encoder that produces content hashes stable across daemon versions, and an
event envelope whose `kind`/`v` pair lets an older `DeFlowd` read a newer ledger without corrupting
it.

## Why this matters

This is the vocabulary. Every other epic is a projection of, a validator over, or a producer of
these types, so a shape decided badly here is re-decided in eight places later. Three specific
failures are being designed out. First, hand-written interfaces drifting from their runtime
validators — Zod-as-source-of-truth with a CI drift check is the answer, because
[04-domain-model §0](../../04-domain-model.md) is blunt that hand-sync "never survives contact with
a real codebase". Second, a moving `NodeId`: the effect journal keys idempotency on
`(runId, nodeId, attempt, ordinal)` and there is _no way to detect after the fact_ that a renamed
node caused a side effect to run twice. Third, a reducer that throws on an event kind it does not
recognise, which turns a version downgrade into an unopenable ledger — the single
forward-compatibility mechanism in the whole system lives in one `default: return state` branch.

## Scope

**In scope:**

- Branded identifier types, their format rules, and the stable/never-reused `NodeId` invariant.
- Zod 4 schemas for `TaskSpec`, `PlanGraph` (all seven node types), `PlanPatch` + `PatchDecision`,
  `Fact` + `Provenance`, `ContextPacket` + `Segment`, `Verdict` + `Finding`, `NodeResult` +
  `NodeFailure`, and the `Event` union with its envelope.
- The canonical JSON encoder and the `planHash` / `specHash` / `contentHash` derivations built on it.
- The upcaster registry and the `upcast(kind, v, payload)` entry point.
- `z.toJSONSchema()` emission to `.DeFlow/schemas/<schemaId>.json`, the `Ajv2020` validator factory,
  and the CI check that proves emitted schemas and Zod schemas cannot drift.
- Pure declaration-level validation helpers (`readsAreSatisfiable`, `patchIsWellFormed`) that the
  planner and policy engine call.

**Out of scope:**

- `reduce()` itself and any state projection — [EPIC-03](./EPIC-03-event-ledger.md), KAR-03.5. This
  epic ships the _events_, not the fold.
- Full `PlanGraph` semantic validation (cycle detection, gate-coverage of every criterion, provider
  resolvability) — [EPIC-11](./EPIC-11-dynamic-planning.md), KAR-11.2. Only the schema-level and
  reachability-level checks land here.
- Evaluating the patch policy rules — [EPIC-11](./EPIC-11-dynamic-planning.md), KAR-11.4. This epic
  ships the mandatory `policy` block those rules read.
- Assembling a `ContextPacket` and `render(segments)` — [EPIC-09](./EPIC-09-context-memory.md).
  This epic ships the shape, not the builder.
- Persisting anything. `@DeFlow/core` has no dependency capable of I/O; the schema _files_ are
  written by a build script in this epic, and by `deflow init` in
  [EPIC-18](./EPIC-18-cli-packaging.md), KAR-18.1.
- The blob spill for oversized payloads — the rule is stated in the envelope's docs here, the
  mechanism is [EPIC-03](./EPIC-03-event-ledger.md), KAR-03.9.

## Definition of Ready (epic level)

- [ ] EPIC-01 Done: `pnpm workspace` builds, `packages/core` exists with `exports: './src/index.ts'`,
      `erasableSyntaxOnly: true` is on, and `pnpm vitest --project unit` runs.
- [ ] `zod@4.4.3`, `ajv@8.20.0` and `ajv-formats@3.0.1` are in the pnpm catalog with exact pins.
- [ ] The normalising snapshot serialiser from
      [testing strategy §9](../../14-testing-strategy.md) is registered in `test/setup.ts` — no
      snapshot in this epic may be written before it exists.
- [ ] [04-domain-model.md](../../04-domain-model.md) read end to end. It is normative; where another
      doc disagrees, that doc is the bug.

## Definition of Done (epic level)

- [ ] All eleven stories Done.
- [ ] Every scenario in [the flow file](../flows/EPIC-02-domain-model-flows.md) exists as an
      automated test at the level its `Automated at:` line names, and the suite is green on
      `ubuntu-26.04` and `macos-26`, Node 24 and Node 26.
- [ ] `packages/core/package.json` has exactly one runtime dependency: `zod`. An import of
      `node:fs`, `node:path` or `better-sqlite3` anywhere under `packages/core/src` fails the lint
      rule added in KAR-02.8.
- [ ] `pnpm schemas:check` is wired into CI and fails on any Zod/JSON-Schema divergence.
- [ ] Every `Unverified` claim this epic touches is either verified or explicitly recorded as a
      tunable: specifically `returns.maxTokens` default 1500 and the 500–2000 token band from F6.4
      (roadmap risk A4-6) ship as a documented default with per-node-type override and an
      oversize-rate counter, not as a settled number.
- [ ] A one-page `packages/core/README.md` lists every `schemaId` shipped at v1 and states the
      append-only rule (`.v2` is published, `.v1` is never edited).

## User stories

### KAR-02.1 — Identifier types and the stable-nodeId invariant

|                 |                                                            |
| --------------- | ---------------------------------------------------------- |
| **Status**      | Ready                                                      |
| **Priority**    | P0                                                         |
| **Size**        | S                                                          |
| **Depends on**  | —                                                          |
| **PRD**         | F4.3, F2.6, NF10                                           |
| **Verified by** | EPIC-02-S1, EPIC-02-S2, EPIC-02-S3, EPIC-02-S4, EPIC-02-S5 |

**As** the engine author, **I want** every identifier to be a branded string with a validated format
and a written stability rule, **so that** the effect journal and the plan-evolution scrubber cannot
be silently broken by an id that moves.

Implements [04-domain-model §1](../../04-domain-model.md#1-identifiers). Ships `Brand<T, B>` and the
twelve branded aliases (`RunId`, `NodeId`, `PlanHash`, `FactId`, `Handle`, `EventSeq`,
`IdempotencyKey`, `SchemaId`, `ProviderId`, `GateId`, `CriterionId`, `SegmentId`), each with a Zod
schema carrying the format regex, plus the `NodeLifecycle` union (`active` / `superseded` /
`abandoned`) and the `derivedFrom` field that together express retirement. The two consumers that
break silently on a moved id are named in §1.1: the effect journal's
`(runId, nodeId, attempt, ordinal)` key, and the scrubber, whose cross-version node identity is
`NodeId` and nothing else. Also ships `mapChildId(mapNodeId, itemId)` producing
`<mapNodeId>--<itemId>` and the `value-hash` derivation, because index-derived ids move when a
collection is re-derived after a replan.

**Acceptance criteria**

1. `NodeIdSchema` accepts `recon-auth-surface` and rejects `Recon_Auth`, `-leading-dash`, the empty
   string, and any string over 63 characters — the rule is `/^[a-z0-9][a-z0-9-]{0,62}$/`.
2. `RunIdSchema` accepts `run_20260802T141133Z_9f2a1c`; two `RunId`s generated a second apart sort
   in creation order under a plain string comparison; every accepted `RunId` is a legal single path
   segment on a case-insensitive filesystem (no `/`, no `:`, no uppercase collision risk).
3. `HandleSchema` accepts both `artifact://<64 hex>` and `file://<repo-relative>#L12-L40` and
   rejects a `file://` handle carrying an absolute path.
4. `IdempotencyKey` is constructed only by `ikey(runId, nodeId, attempt, ordinal)`; the function is
   the sole export and there is no way to build one from a free string.
5. `mapChildId` with `itemIdFrom: 'value-hash'` returns the same `NodeId` for the same item value
   regardless of the item's position in the collection; with `'index'` it does not — and the
   `'index'` path emits a documented warning in its JSDoc, because §1.1 forbids moving ids.
6. A node whose `lifecycle` is `superseded` or `abandoned` remains present in the graph, and its id
   is refused by the id registry if a later patch tries to allocate it again.

**Test plan (TDD)** — write these tests first, in this order, and watch each fail before writing
the implementation.

| #   | Level | Test                                                                              | Red when                                                                  |
| --- | ----- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | unit  | `NodeIdSchema.safeParse` over a table of 12 accept/reject inputs                  | The schema is `z.string()` with no regex                                  |
| 2   | unit  | Two `RunId`s minted 1 s apart compare in order with `<`                           | The format puts the random suffix before the timestamp                    |
| 3   | unit  | `path.basename(path.join(tmp, runId)) === runId` for 100 generated ids            | A separator or reserved character leaks into the format                   |
| 4   | unit  | `mapChildId` over a shuffled collection returns an identical id set               | Ids are derived from index                                                |
| 5   | unit  | `allocate(id)` twice on a registry seeded with a retired id throws `NodeIdReused` | Retirement is not tracked, only lifecycle is set                          |
| 6   | unit  | `ikey()` output round-trips through `parseIkey()` for ordinals 0–100              | The separator is not escaped and a nodeId containing `/` corrupts the key |

**Notes / risks** — The `'index'` variant of `itemIdFrom` exists in the architecture and must be
shipped, but its own docs call `value-hash` "the safe default". Encode that as a schema default, not
as advice in prose.

---

### KAR-02.2 — TaskSpec schema with acceptance criteria and failure modes

|                 |                        |
| --------------- | ---------------------- |
| **Status**      | Not started            |
| **Priority**    | P0                     |
| **Size**        | S                      |
| **Depends on**  | KAR-02.1, KAR-02.9     |
| **PRD**         | F1.2, F1.3, F1.5, F7.4 |
| **Verified by** | EPIC-02-S6, EPIC-02-S7 |

**As** an operator, **I want** the `TaskSpec` to be a validated document with testable acceptance
criteria and named failure modes, **so that** the run has a contract it is judged against rather
than a prose brief that drifts.

Implements [04-domain-model §2](../../04-domain-model.md#2-taskspec-f12-f13-f15). Ships
`AcceptanceCriterion` (with the three `check` variants: `command` / `gate` / `manual`),
`FailureMode`, and `TaskSpec` with `schemaId: 'DeFlow.taskspec.v1'`. The load-bearing detail is
`specHash`: sha256 of the canonicalised spec **excluding `approvedBy`**, so re-approving an
unchanged spec does not change its identity while editing one word does. Also ships the
`pinnedSegmentsOf(spec, node)` selector that names which fields compile into `pinned: true`
segments — `goal`, `nonGoals`, `constraints`, `acceptanceCriteria`, plus the active node's
`pathScopes` and `permission` — because F1.5's anti-drift contract is a property of the spec type,
not of the packet builder that consumes it.

**Acceptance criteria**

1. A `TaskSpec` with zero `acceptanceCriteria` is rejected with a message naming the field; F7.4
   requires every criterion to reach a gate, and zero criteria means the run cannot be judged.
2. `check: { kind: 'command', run: 'pnpm test', expect: 'exit-zero' }` parses; `expect: 'passes'` is
   rejected as an invalid literal.
3. `specHash(spec)` is unchanged by setting `approvedBy` from `null` to
   `{ at, via: 'ui' }`, and changes when a single character of `goal` changes.
4. `specHash` is unchanged by re-ordering the keys of the input object or by round-tripping the spec
   through `JSON.parse(JSON.stringify(...))`.
5. `coveredByGates` defaults to `[]` on parse and is writable only by plan validation — the schema
   accepts it absent from an author-written spec.
6. `pinnedSegmentsOf` returns the six named field groups and nothing else, in a stable order.

**Test plan (TDD)**

| #   | Level | Test                                                                                              | Red when                                                       |
| --- | ----- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1   | unit  | Parse a fixture spec from `test/fixtures/specs/vue3-migration.json`, assert `.success`            | The schema does not exist                                      |
| 2   | unit  | `expect(() => TaskSpecSchema.parse({...spec, acceptanceCriteria: []})).toThrow()`                 | Emptiness is allowed                                           |
| 3   | unit  | `specHash(a) === specHash({...a, approvedBy: {...}})`                                             | The hash is over the whole object                              |
| 4   | unit  | `specHash(a) === specHash(shuffleKeys(a))`                                                        | Hashing uses `JSON.stringify` instead of the canonical encoder |
| 5   | unit  | `toMatchFileSnapshot('__snapshots__/taskspec-pinned.json')` on `pinnedSegmentsOf`                 | The selector returns a different field set than F1.5 names     |
| 6   | unit  | A `check.kind` outside the three literals fails with a path of `acceptanceCriteria[0].check.kind` | The union is loose                                             |

---

### KAR-02.3 — PlanGraph and the seven node types

|                 |                                                  |
| --------------- | ------------------------------------------------ |
| **Status**      | Not started                                      |
| **Priority**    | P0                                               |
| **Size**        | M                                                |
| **Depends on**  | KAR-02.1, KAR-02.9                               |
| **PRD**         | F2.1, F2.3, F5.3, F5.4, F6.2, F6.4               |
| **Verified by** | EPIC-02-S4, EPIC-02-S9, EPIC-02-S10, EPIC-02-S11 |

**As** the planner, **I want** the plan to be a validated, content-addressed JSON document with
seven precisely-typed node kinds, **so that** the graph is data that can be diffed, patched,
snapshotted and rendered rather than code that must be re-executed to be understood.

Implements [04-domain-model §3](../../04-domain-model.md#3-plangraph-f21-f23). Ships `PlanGraph`,
`PlanEdge` (with the `carries?: string[]` label F10.1 renders on data edges), `NodeBase` and the
seven-member `PlanNode` discriminated union — `AgentNode`, `ToolNode`, `GateNode`, `HumanNode`,
`MapNode`, `LoopNode`, `SubgraphNode`. `NodeBase` is where the safety and memory contracts become
schema: `reads` / `writes` declarations (F6.2), `permission: PermissionLevel` (F5.4),
`pathScopes` (F5.3), `returns: { schemaId, maxTokens }` (F6.4, F6.9), `retry` with full-jitter
backoff, and `budget`. Also ships `readsAreSatisfiable(graph)` — the pure reachability walk that
asserts every declared read is satisfied by some ancestor's declared write or by the pinned spec.
[04-domain-model §3.1](../../04-domain-model.md) calls it "roughly 60 lines, and the cheapest
correctness gate in the system"; the full plan validator that also does cycles and gate coverage is
KAR-11.2.

**Acceptance criteria**

1. A graph containing one node of each of the seven types parses, and its file snapshot is stable
   across runs under the normalising serialiser.
2. `type: 'agent'` requires `brief` and `provider.prefer`; `type: 'gate'` requires `criteria` and
   `independence`; a node with `type: 'agent'` carrying a `gate` field is rejected by the
   discriminated union rather than silently accepted.
3. Every node, of every type, must carry `permission`, `pathScopes`, `returns`, `retry`, `budget`,
   `reads`, `writes` and `lifecycle`. Omitting any one is a parse failure whose path names the node
   id and the field.
4. `returns.maxTokens` defaults to `1500` when omitted and is settable per node type; the default is
   exported as a named constant so a tuning change is one edit.
5. `retry` defaults to `{ maxAttempts: 3, backoff: { base: 2000, cap: 300000, jitter: 'full' } }`,
   matching the surgical-repair cap in F7.5 and the backoff constants in
   [05-durable-execution §10.3](../../05-durable-execution.md).
6. `readsAreSatisfiable` returns a list of `{ node, read }` pairs for a graph where a node declares
   `{ kind: 'fact', key: 'finding/auth-uses-jwt' }` that no ancestor writes; it accepts the prefix
   form `finding/*` matching an ancestor's `finding/auth-uses-jwt`.
7. `MapNode.itemIdFrom` defaults to `'value-hash'`.
8. `planHash` is computed over the canonicalised document **excluding `planHash` itself**, and
   recomputing it on a parsed-and-reserialised graph yields the same value.

**Test plan (TDD)**

| #   | Level | Test                                                                                        | Red when                                                               |
| --- | ----- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | unit  | Parse `test/fixtures/plans/seven-types.json`; `toMatchFileSnapshot` the parsed graph        | No schema; or the serialiser is not registered and the snapshot churns |
| 2   | unit  | Scenario-outline over 7 node types × 8 required `NodeBase` fields, each omission rejected   | `NodeBase` fields are optional                                         |
| 3   | unit  | `PlanNodeSchema.safeParse({type:'agent', gate:{…}})` fails on the discriminator             | A plain `z.union` is used instead of `z.discriminatedUnion`            |
| 4   | unit  | `readsAreSatisfiable` on a 12-node fixture with one dangling read returns exactly that pair | The walk checks direct deps only, not all ancestors                    |
| 5   | unit  | `readsAreSatisfiable` accepts `finding/*` against `finding/auth-uses-jwt`                   | Prefix matching is not implemented                                     |
| 6   | unit  | `planHash(parse(serialize(g))) === g.planHash`                                              | The hash includes `planHash`, or key order leaks in                    |
| 7   | unit  | `mapChildId` ids are stable when the `over` collection is shuffled                          | `itemIdFrom` defaults to `'index'`                                     |

**Notes / risks** — `returns.maxTokens`' 500–2000 band is **Unverified** (roadmap A4-6): it traces
to Anthropic's multi-agent research system and practitioner consensus, not a controlled study. Ship
1500 as a named constant, record oversize rate per node type from M1, and tune from DeFlow's own
data. Do not write the number into three files.

---

### KAR-02.4 — PlanPatch and its policy-relevant fields

|                 |                                                  |
| --------------- | ------------------------------------------------ |
| **Status**      | Not started                                      |
| **Priority**    | P0                                               |
| **Size**        | S                                                |
| **Depends on**  | KAR-02.3                                         |
| **PRD**         | F2.4, F2.5, F3.9                                 |
| **Verified by** | EPIC-02-S2, EPIC-02-S3, EPIC-02-S12, EPIC-02-S13 |

**As** the patch policy engine, **I want** every proposed patch to arrive with a complete, mandatory
`policy` block, **so that** the F2.5 rules are predicates over five fields rather than heuristics
over prose.

Implements [04-domain-model §4](../../04-domain-model.md#4-planpatch-f24-f25). Ships the five
`PatchOp` variants — `insert-nodes`, `split-node`, `replace-provider`, `extend-loop`,
`abandon-branch` — plus `PlanPatch` and `PatchDecision` (`auto` / `approved` / `rejected` /
`queued`, with the `rule` that fired). The `policy` block is required, not optional: a patch that
cannot fill in `estimatedCostDeltaUsd`, `estimatedWallClockDeltaMs`, `blastRadius`, `replanDepth`,
`escalatesPermission` and `addsWriteCapability` is rejected at validation, because the default
policy in F2.5 is expressible purely as predicates over exactly those fields. Also ships
`patchIsWellFormed(patch, graph)`: the structural check that ops reference nodes that exist and that
**no op changes a node's id** — the §1.1 invariant, enforced at the one place a graph can change at
runtime.

**Acceptance criteria**

1. A `PlanPatch` missing any single field of `policy` is rejected with a path naming that field;
   `policy` itself is not optional.
2. `patchIsWellFormed` rejects an `insert-nodes` op whose new node reuses an id already present in
   the graph — including one whose `lifecycle` is `abandoned`.
3. `split-node` is accepted only when the target node is set to `lifecycle: 'superseded'` and every
   node in `into` carries `derivedFrom: [<target>]` with fresh ids.
4. `replace-provider` may change `provider` and `model` and nothing else; a patch attempting to
   change `id`, `pathScopes` or `permission` through `replace-provider` is rejected.
5. `proposedBy` accepts `'scheduler'`, so F3.9's quota-driven re-route is an ordinary patch and not
   a special case.
6. `reason` is a required non-empty string — it is rendered verbatim in the scrubber (F10.2).
7. `PatchDecision` with `decision: 'rejected'` requires `by` and `rule`; a rejection with no named
   rule does not parse.

**Test plan (TDD)**

| #   | Level | Test                                                                                         | Red when                                        |
| --- | ----- | -------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | unit  | Table over the 6 `policy` fields, each deleted in turn, each rejected                        | `policy` is `.optional()` or its fields are     |
| 2   | unit  | `patchIsWellFormed` against a graph containing an `abandoned` node whose id the patch reuses | Retired ids are not consulted                   |
| 3   | unit  | `split-node` fixture missing `derivedFrom` is rejected                                       | The relationship is documented but not enforced |
| 4   | unit  | A hand-built `replace-provider` carrying an extra `id` key fails under `strict()`            | The op schemas allow unknown keys               |
| 5   | unit  | `PatchDecisionSchema.parse({decision:'rejected', by:'policy'})` throws                       | `rule` is optional                              |
| 6   | unit  | `toMatchInlineSnapshot` of the three-op fixture used by the scrubber test corpus             | —                                               |

---

### KAR-02.5 — Fact, provenance and the blackboard vocabulary

|                 |                                       |
| --------------- | ------------------------------------- |
| **Status**      | Not started                           |
| **Priority**    | P0                                    |
| **Size**        | S                                     |
| **Depends on**  | KAR-02.1                              |
| **PRD**         | F6.3, F6.7, F10.4                     |
| **Verified by** | EPIC-02-S14, EPIC-02-S15, EPIC-02-S16 |

**As** the blackboard, **I want** facts to be typed, provenanced and schema-validated with a small
fixed core plus one free-form namespace, **so that** the memory graph and the node inspector's
provenance table have something renderable and the vocabulary is not a straitjacket.

Implements [04-domain-model §5](../../04-domain-model.md#5-fact-and-the-blackboard-f63), which is
also the settled answer to PRD open question §15.2. Ships `FactKind` (the six core kinds —
`finding`, `decision`, `artifact`, `scope`, `risk`, `verdict` — plus `ext`), `Provenance` (with
`byNode`, `byProvider`, `byModel` verbatim as the adapter reported it, `fromEvidence: Handle[]`,
`atEvent: EventSeq` as the ordering key, and `confidence: 'asserted' | 'verified' | 'speculative'`),
and `Fact` with `supersedes` and `invalidatedBy`. The key grammar is enforced:
`<kind>/<slug>` for core kinds, `ext:<namespace>/<key>` for the free space. A `Fact`'s `value` is
`unknown` at the type level and validated against its `schemaId` by Ajv at acceptance — which is why
this story pairs with KAR-02.8.

**Acceptance criteria**

1. `key: 'finding/auth-uses-jwt'` parses with `kind: 'finding'`; `key: 'finding/x'` with
   `kind: 'decision'` is rejected — kind and key prefix must agree.
2. `key: 'ext:migration/vue3-incompat-list'` parses only with `kind: 'ext'`.
3. A key using a kind outside the seven (`hunch/maybe`) is rejected.
4. `Provenance.at` is documented and typed as display-only; ordering helpers exported by this module
   sort by `atEvent` and there is no exported comparator that reads `at`.
5. `supersedes` may only reference a different `FactId`; a fact superseding itself is rejected.
6. `invalidatedBy` is an `EventSeq`, so the taint rule in §5.2 ("every consumer whose `fact.read`
   is at a seq **earlier than** the invalidation") is a numeric comparison, not a timestamp one.
7. There is no exported mutator on `Fact`. The module exports constructors and validators only —
   §5.1's rule that the blackboard is a projection, never a store, is enforced by the absence of a
   write API in the domain package.

**Test plan (TDD)**

| #   | Level | Test                                                                                                                                           | Red when                                 |
| --- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| 1   | unit  | Table of 10 `(kind, key)` pairs, 6 accept / 4 reject                                                                                           | Kind and key are validated independently |
| 2   | unit  | `FactSchema.parse` on an `ext:` key with `kind: 'finding'` throws                                                                              | The `ext` prefix is not cross-checked    |
| 3   | unit  | Grep test: no export from `packages/core/src/fact.ts` whose name matches `/^(set\|write\|update)/`                                             | A mutator was added                      |
| 4   | unit  | `supersedes: self.id` rejected                                                                                                                 | Self-reference is unchecked              |
| 5   | unit  | Sorting a shuffled fact array by the exported comparator orders by `atEvent`, and still does when `at` timestamps run backwards (laptop sleep) | The comparator reads `at`                |

---

### KAR-02.6 — ContextPacket and typed segments

|                 |                                |
| --------------- | ------------------------------ |
| **Status**      | Not started                    |
| **Priority**    | P0                             |
| **Size**        | S                              |
| **Depends on**  | KAR-02.1, KAR-02.9             |
| **PRD**         | F6.1, F6.2, F6.6, F10.3, F10.5 |
| **Verified by** | EPIC-02-S17, EPIC-02-S18       |

**As** the node inspector and the context-budget chart, **I want** a packet to be an addressable
array of typed segments with per-segment token counts, **so that** "what did this node actually
receive, and what did compaction delete" is a field lookup rather than an inference over a blob.

Implements [04-domain-model §6](../../04-domain-model.md#6-contextpacket-and-segment-f61-f62-f103-f105).
Ships `SegmentKind` (the nine literals, mirroring the taxonomy Claude Code uses for its own
`/context` breakdown so F10.5's chart lines up with what the user already sees in the vendor CLI —
**Verified 2026-08-02** by decompiling the shipping bundle), `TokenCount` with its mandatory
`method` discriminator, `Segment` with `sourceEvent`, `contentHash`, `pinned` and `compactable`, and
`ContextPacket` with `budget`, `totals.byKind` and `pinnedDigests`. §6.1 explains why this is an
array and not a string: four P0 requirements are literally unsatisfiable against a flat blob.

**Acceptance criteria**

1. `packet.totals.tokens` equals the sum of `segments[].tokens.estimated`, and
   `totals.byKind[k]` equals the sum for that kind — asserted by an exported
   `packetTotalsAreConsistent(packet)` predicate, not left to the builder.
2. A segment with `pinned: true` and `compactable: true` is rejected: pinned implies not compactable.
   A segment with `pinned: false` and `compactable: false` is accepted — the implication is one-way.
3. `budget.fraction` is rejected above `0.6` and defaults to `0.5`.
4. `pinnedDigests` contains one sha256 per `pinned` segment and the digest equals that segment's
   `contentHash` — the input to the F6.6 integrity check is derivable, not separately maintained.
5. `TokenCount.method` is required and is one of `gpt-tokenizer/o200k_base`, `heuristic`,
   `vendor-reported`. There is no default.
6. `renderOrderOf(packet)` returns pinned segments first, and places `history.summary` segments in
   the chronological position of what they replaced rather than in a preamble.
7. Every `Segment` carries `sourceEvent: EventSeq`, so a packet segment is click-through-able to the
   event that produced it (F10.3).

**Test plan (TDD)**

| #   | Level | Test                                                                                            | Red when                                   |
| --- | ----- | ----------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | unit  | `packetTotalsAreConsistent` on a hand-built 6-segment packet, then on one with a doctored total | Totals are trusted, not checked            |
| 2   | unit  | `pinned && compactable` rejected; `!pinned && !compactable` accepted                            | The rule is implemented as an equivalence  |
| 3   | unit  | `budget.fraction: 0.7` rejected with a message naming 0.6                                       | The cap is a comment                       |
| 4   | unit  | `pinnedDigests` mismatch against a segment's `contentHash` rejected                             | The digests are a separate free-form array |
| 5   | unit  | `TokenCountSchema.parse({estimated: 10})` throws on missing `method`                            | `method` has a default                     |
| 6   | unit  | `renderOrderOf` golden file over a packet with two pinned and one `history.summary`             | Order is insertion order                   |

---

### KAR-02.7 — The Event union, envelope versioning and upcasters

|                 |                                                                 |
| --------------- | --------------------------------------------------------------- |
| **Status**      | Not started                                                     |
| **Priority**    | P0                                                              |
| **Size**        | M                                                               |
| **Depends on**  | KAR-02.2, KAR-02.3, KAR-02.4, KAR-02.5, KAR-02.6, KAR-02.10     |
| **PRD**         | F4.1, F4.4, F6.6, F9.1, NF9, NF10                               |
| **Verified by** | EPIC-02-S19, EPIC-02-S20, EPIC-02-S21, EPIC-02-S22, EPIC-02-S23 |

**As** a user who upgrades and then downgrades `DeFlowd`, **I want** every event to carry `kind` and
an integer `v` with a read-time upcaster chain, **so that** an older daemon skips what it does not
understand instead of refusing to open my ledger.

Implements [04-domain-model §9](../../04-domain-model.md#9-the-event-union). Ships
`EventEnvelope<K, P>` — `seq`, `runId`, `ts` (informational; **order is `seq`**), `kind`, `v`,
`epoch`, optional `nodeId` / `attempt` / `ikey`, and `payload` — plus the ~40 payload schemas listed
in the §9 table, from `run.created` through `export.blocked`. Two of them carry design decisions
worth calling out: `context.compacted`'s `fidelity: 'exact' | 'partial'` discriminator with
`after: number | null`, because Claude Code's `compact_boundary` frame emits `pre_tokens` only and a
chart with a fabricated "after" is worse than an honest gap (**Verified 2026-08-02**); and
`run.stalled`, which is surfaced and never auto-kills, because a long build and a wedged agent look
identical from here. Also ships the upcaster registry: `Upcaster = (payload: unknown) => unknown`
registered per `(kind, fromVersion)`, chained until the payload reaches the current version, applied
at read time. Events are **never rewritten on disk**.

**Acceptance criteria**

1. `parseEvent` on an envelope whose `kind` is `future.thing` returns
   `{ status: 'unknown-kind', kind: 'future.thing' }` rather than throwing — the value the reducer
   in KAR-03.5 turns into `return state`.
2. Given upcasters registered for `('node.completed', 1)` and `('node.completed', 2)`, calling
   `upcast('node.completed', 1, payload)` applies both in order and yields a payload that parses
   against the v3 schema.
3. A payload arriving at `v` **greater** than the current version for a known `kind` is reported as
   `{ status: 'future-version' }` and is not upcast, not downcast and not parsed.
4. A payload at a `v` lower than current for which no upcaster is registered fails loudly at
   registry-build time — `assertUpcasterChainsComplete()` throws naming `(kind, v)` — so the gap is
   found by a unit test and never at 3am on a nine-hour run.
5. Every upcaster is a pure function: `upcast` is called twice on the same input in a test and
   returns deeply-equal results, and the registry rejects registration of the same `(kind, v)` twice.
6. `context.compacted` with `fidelity: 'partial'` requires `after: null` and `droppedSegments: []`;
   supplying a number for `after` under `partial` is rejected.
7. `EventEnvelope.epoch` is required on every event.
8. There is a documented, tested rule that a lossy payload change is a **new `kind`**, not a new
   `v` — expressed as a `schemas/CHANGELOG.md` entry plus a test asserting no upcaster in the
   registry drops a required field of its target schema.

**Test plan (TDD)**

| #   | Level | Test                                                                                            | Red when                                                     |
| --- | ----- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | unit  | `parseEvent({kind:'future.thing', v:1, …})` returns `unknown-kind`                              | A `z.discriminatedUnion` throws on the unknown discriminant  |
| 2   | unit  | Two-hop upcast v1→v3 asserted with `toMatchInlineSnapshot`                                      | Chaining stops after one hop                                 |
| 3   | unit  | `upcast` called twice returns deep-equal values; input object is not mutated                    | An upcaster mutates in place                                 |
| 4   | unit  | `assertUpcasterChainsComplete()` throws for a registry with a hole at `('gate.evaluated', 2)`   | Chain completeness is assumed                                |
| 5   | unit  | `context.compacted` `partial` + `after: 4000` rejected                                          | The discriminator is decorative                              |
| 6   | unit  | Property test: for every registered upcaster, `target.safeParse(up(fixture)).success`           | An upcaster produces a payload its own target schema rejects |
| 7   | unit  | Every event kind in §9's table has a schema — a table-driven test over the exported `kind` list | A kind was added to the docs and not the code                |

**Notes / risks** — This is the biggest single story in the epic and the one with the most fixtures.
The ~40 payload schemas are individually trivial; the risk is that they are written without a test
per kind and the §9 table quietly diverges. Test 7 is the defence and should be written first.

---

### KAR-02.8 — JSON Schema emission to `.DeFlow/schemas/`

|                 |                                                                 |
| --------------- | --------------------------------------------------------------- |
| **Status**      | Not started                                                     |
| **Priority**    | P0                                                              |
| **Size**        | M                                                               |
| **Depends on**  | KAR-02.2, KAR-02.3, KAR-02.5, KAR-02.7                          |
| **PRD**         | F6.9, NF8, F3.5                                                 |
| **Verified by** | EPIC-02-S14, EPIC-02-S15, EPIC-02-S24, EPIC-02-S25, EPIC-02-S26 |

**As** an agent and as a human reading a run directory, **I want** every DeFlow schema on disk as
JSON Schema 2020-12, generated from the Zod source of truth and proven in CI to match it, **so that**
vendor CLIs can validate structured output natively and NF8 is satisfied without a second
hand-maintained artefact.

Implements [04-domain-model §0](../../04-domain-model.md#0-how-these-types-are-defined). Ships:
a `pnpm schemas:emit` script that walks the registry of `(schemaId, zodSchema)` pairs and writes
`.DeFlow/schemas/<schemaId>.json` via `z.toJSONSchema()`; a `pnpm schemas:check` that regenerates
into a temp dir and fails on any diff; and `makeValidator(schemaId)` building an `Ajv2020` instance
from `ajv/dist/2020` configured `{ strict: true, allErrors: true }` with `ajv-formats`. 2020-12 is
not arbitrary — it is the dialect MCP tool `inputSchema` defaults to, so the MCP host and the F6.9
handoff contracts speak one dialect and one validator, and Ajv arrives transitively via
`@modelcontextprotocol/sdk` anyway (**Verified 2026-08-02**). The emitted files are also what
`agent` nodes hand to a vendor: Claude Code's `--json-schema` and Codex's `--output-schema` both
take a JSON Schema file (**Verified 2026-08-02**).

**Acceptance criteria**

1. `pnpm schemas:emit` writes one file per registered `schemaId`, each declaring
   `"$schema": "https://json-schema.org/draft/2020-12/schema"`.
2. `pnpm schemas:check` exits non-zero, printing the differing `schemaId` and a unified diff, when a
   Zod schema is edited without re-emitting. This is a CI job, not a hook.
3. Every emitted schema compiles under `Ajv2020` with `strict: true` — no `strictTypes` warnings, no
   unknown keywords. A Zod construct that emits something Ajv-strict rejects fails the check.
4. `makeValidator('DeFlow.finding.v1')` validates a conforming fact value and, for a
   non-conforming one, returns all errors (`allErrors: true`) with JSON Pointer paths.
5. A `Fact` whose `schemaId` is not present in `.DeFlow/schemas/` is rejected at acceptance with
   `unknown-schema-id`, naming the id — this is what makes the `ext:` namespace safe.
6. `schemaId` versioning is append-only: a test asserts that no file already present in the
   repository's committed `schemas/` fixture directory has changed content; a change requires a new
   `.v2` file.
7. An eslint/oxlint rule fails the build on any import of `node:fs`, `node:path` or a driver package
   from `packages/core/src/**` — the emitter lives in `packages/core/scripts/`, outside the
   published surface.

**Test plan (TDD)**

| #   | Level       | Test                                                                                                                                                 | Red when                                                                      |
| --- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | unit        | Snapshot `z.toJSONSchema(TaskSpecSchema)` to `__snapshots__/DeFlow.taskspec.v1.json`                                                                 | Emission produces draft-07 shape, or `$schema` is absent                      |
| 2   | integration | Run `schemas:emit` into a tmpdir, diff against the committed dir, assert empty                                                                       | The check compares mtimes rather than content                                 |
| 3   | integration | Deliberately add a field to `FactSchema`; assert `schemas:check` exits 1 and names `DeFlow.fact.v1`                                                  | The check does not run over every registered id                               |
| 4   | unit        | `new Ajv2020({strict:true}).compile(emitted)` for every emitted file, table-driven                                                                   | A Zod construct emits `unevaluatedProperties` or a keyword Ajv-strict refuses |
| 5   | unit        | `makeValidator` returns ≥2 errors for a value with two violations                                                                                    | `allErrors` is false                                                          |
| 6   | contract    | A recorded Claude Code invocation with `--json-schema .DeFlow/schemas/DeFlow.finding.v1.json` against `@DeFlow/mock-agent --replay` accepts the file | The emitted file is not a standalone document (uses `$ref` to a sibling)      |
| 7   | unit        | Git-tracked `schemas/` fixture content hash table, one row per shipped id                                                                            | A `.v1` was edited in place                                                   |

**Notes / risks** — Test 6 depends on the mock agent (EPIC-04) and on a recording; until EPIC-04
lands, run it as `manual` against the developer's installed CLI and mark it explicitly as such in
the spec name. Do not let it become a story-blocking dependency on EPIC-04 — the drift check
(criteria 2–3) is the value here and needs nothing external.

---

### KAR-02.9 — Canonical JSON encoding and content hashes _(added)_

|                 |                        |
| --------------- | ---------------------- |
| **Status**      | Ready                  |
| **Priority**    | P0                     |
| **Size**        | S                      |
| **Depends on**  | —                      |
| **PRD**         | F2.1, F2.6, NF9, NF10  |
| **Verified by** | EPIC-02-S6, EPIC-02-S8 |

**As** the plan store and the scrubber, **I want** one canonical JSON encoder that I own, **so that**
`planHash` is a primary key that is stable across daemon versions rather than a best-effort
serialisation.

Added because [04-domain-model §3](../../04-domain-model.md#3-plangraph-f21-f23) requires
`planHash`, `specHash` and `Segment.contentHash` before KAR-02.2 and KAR-02.3 can be finished, and
because it carries a specific verified warning that belongs in one place: **`ohash` is confirmed to
order keys stably, but its README promises only "best efforts" at stable serialisation.** That is
fine for "did this object change since last render" in the UI and wrong for a value that is a
primary key of the `plan` table and an identity across daemon versions. This story ships
`canonicalJson(value): string` — recursively sorted keys, no insignificant whitespace, `undefined`
omitted, no `Date`/`Map`/`Set` support (they are rejected, not coerced) — and `sha256Hex(string)`
over it, plus `planHash`, `specHash` and `contentHash` as thin named wrappers.

**Acceptance criteria**

1. `canonicalJson` output is byte-identical for two objects differing only in key insertion order,
   at every nesting depth including inside arrays of objects.
2. `canonicalJson` omits keys whose value is `undefined` and preserves keys whose value is `null` —
   the two are not conflated.
3. `canonicalJson` throws on a `Date`, a `Map`, a `Set`, a `BigInt`, `NaN`, `Infinity` or a circular
   reference, naming the offending path. It never silently coerces.
4. Numbers round-trip: `canonicalJson({a: 1.0})` and `canonicalJson({a: 1})` produce the same string,
   and no float is reformatted in a way that changes its `JSON.parse` value.
5. Non-ASCII strings are emitted identically under both NFC and the input's own normalisation — the
   encoder does not normalise, and this is documented, so a hash is a hash of the bytes given.
6. `ohash` appears nowhere in `packages/core`; a lint rule enforces it. Its use for UI change
   detection in `@DeFlow/web` is unaffected.
7. `planHash` excludes the `planHash` field; `specHash` excludes `approvedBy`. Both exclusions are
   implemented by an explicit omit list, not by deleting from a copy at three call sites.

**Test plan (TDD)**

| #   | Level | Test                                                                                      | Red when                                                                       |
| --- | ----- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | unit  | Property test over 200 generated nested objects: `canonical(shuffle(o)) === canonical(o)` | Sorting is shallow                                                             |
| 2   | unit  | `{a: undefined, b: null}` → `{"b":null}`                                                  | `undefined` becomes `null`                                                     |
| 3   | unit  | Table of 6 unsupported values, each throwing with a path                                  | Values are coerced by `JSON.stringify`                                         |
| 4   | unit  | Circular object throws `CanonicalJsonCycle` rather than `RangeError`                      | No cycle detection                                                             |
| 5   | unit  | `sha256Hex(canonical(planFixture))` matches a committed golden hex string                 | The hash changed and nobody noticed — this is the cross-version stability test |
| 6   | unit  | Grep test: `ohash` not imported under `packages/core/src`                                 | —                                                                              |

**Notes / risks** — Test 5's committed golden is the whole point of the story: if a refactor changes
that hex string, every `plan` row in every existing ledger has just been orphaned. Treat a change to
that golden as a migration, not a test update.

---

### KAR-02.10 — NodeResult, NodeFailure and the closed failure taxonomy _(added)_

|                 |                                       |
| --------------- | ------------------------------------- |
| **Status**      | Not started                           |
| **Priority**    | P0                                    |
| **Size**        | S                                     |
| **Depends on**  | KAR-02.1                              |
| **PRD**         | F4.5, F7.3, F9.1, NF10                |
| **Verified by** | EPIC-02-S18, EPIC-02-S27, EPIC-02-S28 |

**As** the scheduler and the node inspector, **I want** every failure to be a value in a closed
union with an explicitly-assigned class, **so that** a failure survives `JSON.stringify`, survives a
daemon restart, and tells the scheduler what to do without being re-interpreted at render time.

Added because [04-domain-model §7 and §8](../../04-domain-model.md#8-noderesult-and-nodefailure)
specify `Verdict`, `Finding`, `NodeResult`, `NodeFailure`, `NodeFailureReason` (26 literals across
adapter, agent-reported, contract, safety, resource and orchestration groups) and `TokenUsage`, and
no skeleton story owns them — yet KAR-02.7's event payloads (`node.failed`, `gate.evaluated`,
`node.completed`, `budget.consumed`) cannot be written without them. The story also ships the single
boundary function `toNodeFailure(thrown: unknown, ctx): NodeFailure` that maps thrown values onto
the union, with unmapped throws becoming `{ reason: 'internal' }` and the stack captured as a
`Handle` — "and that is a bug to be fixed, not a design".

**Acceptance criteria**

1. `NodeFailureReason` is a string-literal union containing exactly the reasons in §8 — **26**, not
   the 30 this line claimed before KAR-02.10 counted them — verified by a table-driven test against
   a committed list and a second test that reads the union out of §8 itself, so the code and the
   document cannot drift. No `enum` — `erasableSyntaxOnly: true` forbids it and a union round-trips
   through JSON.
2. `class` (`transient` / `permanent` / `gate`) is a required field on `NodeFailure` and is _not_
   derivable from `reason`: the same reason appears in the test corpus with two different classes
   (`provider.unavailable` transient for a rate-limited vendor, permanent for an uninstalled binary).
3. `toNodeFailure(new Error('boom'), ctx)` returns `reason: 'internal'`, `class: 'permanent'`, a
   one-line `message`, and `evidence: [<handle>]` — never a `stack` field in the payload.
4. `NodeFailure` survives `JSON.parse(JSON.stringify(f))` deep-equal for every reason in the corpus.
5. `effect.reconcile-unknown` is constrained by the schema to `class: 'gate'` — there is no correct
   automatic action when the reconcile probe cannot tell, so the type refuses to let it be
   `transient`.
6. `budget.cost-exceeded` and `budget.wallclock-exceeded` are likewise constrained to `class: 'gate'`
   — F4.6 pauses for a human decision rather than failing the run.
7. `TokenUsage.source` (`vendor-reported` / `estimated`) is required, and `sumUsage()` refuses to
   add two `TokenUsage` values with different sources, returning a `{ vendorReported, estimated }`
   pair instead.
8. `Verdict.outcome` includes `needs-human` as a first-class value, and `Finding.evidence` is
   `Handle[]` — evidence is never inlined.

**Test plan (TDD)**

| #   | Level | Test                                                                                      | Red when                                            |
| --- | ----- | ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 1   | unit  | Committed reason table compared to the exported union, and both to §8                     | A reason was added to one and not the other         |
| 2   | unit  | `provider.unavailable` fixtures with both classes both parse                              | `class` is computed from `reason`                   |
| 3   | unit  | `effect.reconcile-unknown` + `class: 'transient'` rejected                                | The refinement is missing                           |
| 4   | unit  | Round-trip deep-equality over the full corpus                                             | A `Handle` or `EventSeq` brand breaks serialisation |
| 5   | unit  | `toNodeFailure` on a thrown string, a thrown object, `undefined`, and an `AggregateError` | Only `Error` is handled                             |
| 6   | unit  | `sumUsage(vendorReported, estimated)` returns a pair, not a number                        | The sources are silently mixed                      |

---

### KAR-02.11 — `provider.session_opened`, and the envelope a counted event cannot omit _(added)_

|                 |                                       |
| --------------- | ------------------------------------- |
| **Status**      | Not started                           |
| **Priority**    | P0                                    |
| **Size**        | S                                     |
| **Depends on**  | KAR-02.1, KAR-02.7                    |
| **PRD**         | F3.2, F4.3, NF9, NF10                 |
| **Verified by** | EPIC-02-S29, EPIC-02-S30              |

**As** the derivation that must never hand a vendor a session id a previous process already spent,
**I want** the session a turn opens to be an event kind in the union whose envelope carries the
`(nodeId, attempt)` the count is taken over, **so that** the attempt is a fact in the ledger that
survives a daemon restart and every past turn's id stays recomputable offline.

Added on 2026-08-23 under [README §9](../README.md#9-changing-the-plan), as the plan amendment that
[KAR-19.13](./EPIC-19-live-run-pipeline.md) should have been written against and was not. That story
needs the attempt of a pre-execution turn to be **counted from the ledger** — a counter on a context
object is correct in one daemon life and resets, on the restart that produced the report, to exactly
the value that collides — and the only durable form of that count is rows of an event kind. EPIC-19's
Out-of-scope is explicit that widening the `Event` union is this epic's work and that doing it from
there is "a schema change made in the wrong file"; the schema, its documentation in
[04 §9](../../04-domain-model.md#9-the-event-union) and its own tests therefore live here, and
EPIC-19 depends on this story rather than containing it.

The kind is `provider.session_opened`, `v: 1`, payload
`{ node: NodeId; attempt: number; provider: ProviderId; session: { id: string; origin: 'minted' | 'session/new' } }`.
Two design points are the story. It is **not** a `node.started`: a pre-execution turn is not a plan
node, and marking one `running` would leave `framing` permanently in flight in every projection that
reads node state. And the payload carries the **pair**, not the id alone, because `attempt` beside
`session.id` is what lets anyone recompute `vendorSessionId(runId, node, attempt)` from the ledger
and check it — which is what stops a `randomUUID()` "fix" that satisfies the vendor and makes every
transcript unfindable.

The second half of the story is the one the reported defect actually turns on. The count is taken
over the ledger's `node_id` **column**, so an envelope that omits `nodeId` — or one whose `nodeId`
disagrees with the `node` its own payload restates — counts zero for ever, and the next turn derives
the identical id the vendor has already refused. The envelope's `nodeId` and `attempt` are optional
for every other kind and must not be here, and that correspondence is declared once as a table
rather than as a check bolted onto one kind, because the next counted kind will otherwise repeat it.

**Acceptance criteria**

1. `provider.session_opened` is a registered kind at `v: 1` whose payload schema is strict: an
   unknown key, a missing or negative `attempt`, an empty `session.id`, or an `origin` outside
   `minted | session/new` are each rejected. `attempt` carries the same non-negative-integer rule
   the envelope's does, so "the attempt is a count" is a schema fact and not a convention.
2. The kind is in [04 §9](../../04-domain-model.md#9-the-event-union)'s table with the same payload,
   so KAR-02.7 test 7 — the table-driven docs/registry check — covers it and the two cannot drift.
3. `parseEvent` rejects a `provider.session_opened` whose envelope has **no** `nodeId`. The event
   exists to be counted under a node, and an event no count can see is the defect of 2026-08-16
   written into the schema.
4. `parseEvent` rejects one whose envelope `nodeId` differs from `payload.node`, or whose envelope
   `attempt` differs from `payload.attempt`. The two are written by different lines of one call and
   nothing checked they agreed; the issue text names the field and both values.
5. The correspondence is a **table**, not a special case. The payload keys that restate an envelope
   field are declared once, per kind, in an exported table that `parseEvent` reads; the table is
   type-constrained to real kinds and real envelope fields, and a table-driven test covers every
   entry from both sides — the matching envelope parses, the mismatched one does not.
6. A rejection is a value, and the forward-compatibility order is unchanged: the mismatch comes back
   as `invalid-payload` (never a throw), and `unknown-kind` and `future-version` are still both
   decided **before** any of this runs, so a downgraded daemon still reports "newer than me" rather
   than "corrupt" (KAR-02.7 AC1, AC3).
7. The kind is additive only. It ships at `v: 1` with no upcaster, `assertUpcasterChainsComplete()`
   stays green, and the arms its addition forces on exhaustive switches elsewhere carry no
   behaviour: EPIC-03's fold returns no state change (a `running` node here would be a `framing`
   node nothing ever completes) and EPIC-16's `EVENT_KIND_OWNERS` claims it for no projection.

**Test plan (TDD)** — unit, all of it: this is `packages/core`, which reads no clock, opens no
database and spawns nothing.

| #   | Level | Test                                                                                                                     | Red when                                                                                                                                        |
| --- | ----- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | unit  | `parseEvent` on a well-formed `provider.session_opened` whose envelope has no `nodeId`; assert `invalid-payload` naming `node` | The envelope's `nodeId` is optional for every kind, so an event the counter can never see parses clean and the wedge comes back                     |
| 2   | unit  | Envelope `nodeId: 'planner'` against `payload.node: 'framing'`, and envelope `attempt: 0` against `payload.attempt: 1`; assert both rejected and both values named | Nothing compares them, so one call writing the pair from two variables records a row that counts under the wrong node |
| 3   | unit  | The payload's own shape: extra key, missing `attempt`, `attempt: -1`, `session.id: ''`, `origin: 'resumed'` — each rejected, the good fixture accepted | The schema is loose enough for a count to arrive as a string                                                                                       |
| 4   | unit  | Table-driven over the echo table: for every entry and every echoed field, the matching envelope parses and a mismatched one does not | The rule is one `if` for one kind, and the next counted kind repeats the defect                                                                    |
| 5   | unit  | `parseEvent` still returns `unknown-kind` for `future.thing` and `future-version` for this kind at `v: 2`                 | The echo check runs before the two forward-compatibility branches, and a downgraded daemon calls a newer ledger corrupt                             |

**Notes / risks** — the tempting shortcut is to leave the envelope's `nodeId` optional and have the
counting query read the payload's `node` out of the JSON instead. It works, and it moves an index
lookup into a scan of every row of a run's history to answer a question about three of them — and it
leaves the two fields free to disagree, which is the thing that makes a row uncountable in the first
place. The rule this story writes is narrow on purpose: only kinds that declare an echo are checked,
and every other kind's envelope stays exactly as optional as it was.

---

## Sequencing

KAR-02.1 and KAR-02.9 have no dependencies and should be done first, in that order or in parallel —
everything else needs a validated `NodeId` and a stable hash. KAR-02.10 can be done any time after
KAR-02.1 and must precede KAR-02.7. KAR-02.7 is last of the schema stories because its payloads
reference every other type. KAR-02.8 can start as soon as two schemas exist; getting the drift check
green early makes every subsequent story cheaper. KAR-02.11 follows KAR-02.7 — it adds one kind to
the union that story ships and one rule to its `parseEvent` — and precedes
[KAR-19.13](./EPIC-19-live-run-pipeline.md), which is the story that needs the kind.

## Risks

| Risk                                                                                                                                                                  | Mitigation                                                                                                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The §9 event table and the code diverge.** Forty payload schemas is enough that one gets added to the docs and not the registry.                                    | KAR-02.7 test 7: a table-driven test over the exported kind list, written first.                                                                                                                   |
| **`returns.maxTokens`' 500–2000 band is Unverified** (roadmap A4-6) — practitioner consensus, no controlled study.                                                    | Ship 1500 as one named constant, per-node-type override, and instrument oversize rate from M1. Do not design a budget mechanism around the number.                                                 |
| **A canonical-encoder refactor silently orphans every `plan` row.**                                                                                                   | The committed golden hex in KAR-02.9 test 5, and a written rule that changing it is a migration.                                                                                                   |
| **Zod 4's `z.toJSONSchema()` may emit constructs `Ajv2020` in strict mode refuses** for some schema shapes (e.g. certain `z.discriminatedUnion` or `z.record` forms). | KAR-02.8 criterion 3 catches it at emit time; the fallback is to restrict the Zod constructs used in schemas that must round-trip, and that restriction is cheap to apply now and expensive later. |
| **Three added stories (02.9, 02.10, 02.11) expand the epic beyond the skeleton.**                                                                                     | The first two are strictly required by [04-domain-model.md](../../04-domain-model.md) §3/§7/§8 and by KAR-02.7's dependencies. The third is a downstream epic's need for one more kind, brought back to the epic that owns the union rather than absorbed where it was found — which is what [README §9](../README.md#9-changing-the-plan) asks for and what did not happen on 2026-08-22. All three are `S`; the epic reads ~13 days, inside the ~15-day guidance. |
| **The union grows from wherever a kind is first needed.** `provider.session_opened` was widened into the union from EPIC-19 on 2026-08-22, with the §9 table edited from that branch — precisely the "schema change made in the wrong file" EPIC-19's own Out-of-scope names. | KAR-02.11 is the amendment: the kind, its documentation and its tests belong to this epic and EPIC-19 depends on them. The general rule already exists and held everywhere else — a kind needed by another epic is a story **here**, and the epic that needs it cites it in `Depends on`. |

---

**Related:** [Flows](../flows/EPIC-02-domain-model-flows.md) · [Board](../board.md) ·
[04-domain-model.md](../../04-domain-model.md) ·
[14-testing-strategy.md](../../14-testing-strategy.md)

[← Back to the delivery plan](../README.md)
